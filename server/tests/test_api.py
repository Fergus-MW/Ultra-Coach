from __future__ import annotations

import hmac
import json
import time
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from time import monotonic

import pytest
from fastapi.testclient import TestClient

from app import healf, main
from app.auth import sign
from app.healf import Catalogue, _from_page, _from_sitemap
from app.memory import RunnerState, _format_edge
from app.proactive import CallLog, Coach
from app.races import Race, RaceSearchError, spoken_summary

TOOL_SECRET = "shhh"
WEBHOOK_SECRET = "hook"
TOOL_HEADERS = {"x-tool-secret": TOOL_SECRET}


class FakeMemory:
    def __init__(self) -> None:
        self.transcripts: list[tuple[str, str, list[tuple[str, str]]]] = []
        self.events: list[tuple[str, str, dict]] = []

    async def ensure_user(self, user_id: str) -> None:
        return None

    async def add_transcript(self, user_id, conversation_id, turns) -> None:
        self.transcripts.append((user_id, conversation_id, turns))

    async def record_event(self, user_id, kind, payload) -> None:
        self.events.append((user_id, kind, payload))

    async def get_state(self, user_id: str) -> RunnerState:
        return RunnerState(
            user_id=user_id, context="Skipped Sunday long run.", commitments=["Entered nothing"]
        )

    async def list_runners(self) -> list[str]:
        return ["fergus"]


class FakeRinger:
    def __init__(self, online: bool = True) -> None:
        self._online = online
        self.rings: list[str] = []

    def is_online(self, user_id: str) -> bool:
        return self._online

    async def ring(self, user_id: str, opening_line: str, reason: str) -> int:
        self.rings.append(user_id)
        return 1


@pytest.fixture(autouse=True)
def fresh_limits() -> None:
    main._register_bucket = main.Bucket(burst=10, per_second=0.2)


@pytest.fixture(autouse=True)
def settings(monkeypatch, tmp_path):
    configured = main.get_settings()
    monkeypatch.setattr(configured, "tool_secret", TOOL_SECRET)
    monkeypatch.setattr(configured, "session_secret", "signing-key")
    monkeypatch.setattr(configured, "elevenlabs_webhook_secret", WEBHOOK_SECRET)
    monkeypatch.setattr(configured, "state_file", str(tmp_path / "calls.json"))
    monkeypatch.setattr(main.coach, "_calls", CallLog(tmp_path / "calls.json"))
    return configured


@pytest.fixture
def fake_memory(monkeypatch) -> FakeMemory:
    fake = FakeMemory()
    monkeypatch.setattr(main, "memory", fake)
    monkeypatch.setattr(main.coach, "_memory", fake)
    return fake


@pytest.fixture
def client(fake_memory) -> TestClient:
    with TestClient(main.app) as test_client:
        yield test_client


def signed(payload: dict, age_seconds: int = 0) -> tuple[bytes, dict[str, str]]:
    body = json.dumps(payload).encode()
    timestamp = str(int(time.time()) - age_seconds)
    digest = hmac.new(WEBHOOK_SECRET.encode(), f"{timestamp}.".encode() + body, sha256).hexdigest()
    return body, {
        "content-type": "application/json",
        "elevenlabs-signature": f"t={timestamp},v0={digest}",
    }


def test_health(client: TestClient) -> None:
    assert client.get("/health").json() == {"status": "ok"}


def test_transcript_webhook_ingests_signed_turns(
    client: TestClient, fake_memory: FakeMemory
) -> None:
    body, headers = signed(
        {
            "data": {
                "conversation_id": "conv_1",
                "conversation_initiation_client_data": {
                    "dynamic_variables": {
                        "runner_id": "fergus",
                        "runner_sig": sign("fergus"),
                    }
                },
                "transcript": [
                    {"role": "agent", "message": "Where was Sunday's long run?"},
                    {"role": "user", "message": "I skipped it."},
                    {"role": "agent", "message": ""},
                ],
            }
        }
    )
    response = client.post("/webhooks/elevenlabs", content=body, headers=headers)

    assert response.json() == {"status": "ingested", "turns": 2}
    user_id, conversation_id, turns = fake_memory.transcripts[0]
    assert (user_id, conversation_id) == ("fergus", "conv_1")
    assert turns[1] == ("user", "I skipped it.")


def test_transcript_webhook_rejects_a_forged_payload(
    client: TestClient, fake_memory: FakeMemory
) -> None:
    response = client.post(
        "/webhooks/elevenlabs",
        json={"data": {"conversation_id": "conv_1", "transcript": []}},
        headers={"elevenlabs-signature": "t=1700000000,v0=deadbeef"},
    )
    assert response.status_code == 401
    assert fake_memory.transcripts == []


def test_transcript_webhook_rejects_a_replayed_delivery(
    client: TestClient, fake_memory: FakeMemory
) -> None:
    body, headers = signed(
        {
            "data": {
                "conversation_id": "conv_old",
                "transcript": [{"role": "user", "message": "hi"}],
            }
        },
        age_seconds=3 * 60 * 60,
    )
    response = client.post("/webhooks/elevenlabs", content=body, headers=headers)

    assert response.status_code == 401
    assert fake_memory.transcripts == []


def test_transcript_webhook_reports_an_ingestion_failure(client: TestClient, monkeypatch) -> None:
    async def boom(*args, **kwargs):
        raise RuntimeError("zep is down")

    monkeypatch.setattr(main.memory, "add_transcript", boom)
    body, headers = signed(
        {
            "data": {
                "conversation_id": "conv_2",
                "conversation_initiation_client_data": {
                    "dynamic_variables": {
                        "runner_id": "fergus",
                        "runner_sig": sign("fergus"),
                    }
                },
                "transcript": [{"role": "user", "message": "I skipped it."}],
            }
        }
    )
    response = client.post("/webhooks/elevenlabs", content=body, headers=headers)
    assert response.status_code == 500


def test_ring_is_skipped_when_runner_is_offline(client: TestClient) -> None:
    body = client.post("/api/proactive-ring/fergus", headers=TOOL_HEADERS).json()
    assert body["rang"] is False
    assert body["reason"] == "runner is not reachable"


def test_ring_requires_the_tool_secret(client: TestClient) -> None:
    assert client.post("/api/proactive-ring/fergus").status_code == 401


def test_ring_reaches_a_connected_runner(client: TestClient, monkeypatch) -> None:
    async def fake_opening_line(state):
        return "You skipped Sunday. Why?"

    monkeypatch.setattr(main.coach, "_memory", FakeMemory())
    monkeypatch.setattr("app.proactive.opening_line", fake_opening_line)

    token = sign("fergus")
    with client.websocket_connect(f"/ws/fergus?token={token}") as socket:
        body = client.post("/api/proactive-ring/fergus", headers=TOOL_HEADERS).json()
        assert body == {
            "rang": True,
            "reason": "Entered nothing",
            "opening_line": "You skipped Sunday. Why?",
            "delivered_to": 1,
        }
        assert socket.receive_json() == {
            "type": "incoming_call",
            "opening_line": "You skipped Sunday. Why?",
            "reason": "Entered nothing",
        }


def test_websocket_refuses_another_runners_id(client: TestClient) -> None:
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/someone-else?token=guessed") as socket:
            socket.receive_json()


def test_registered_device_can_open_a_session(client: TestClient, monkeypatch) -> None:
    async def fake_token(agent_id: str) -> str:
        return "conv-token"

    monkeypatch.setattr(main.get_settings(), "elevenlabs_agent_id", "agent_1")
    monkeypatch.setattr(main, "conversation_token", fake_token)

    identity = client.post("/api/register").json()
    response = client.post(
        "/api/session",
        json={"user_id": identity["user_id"]},
        headers={"authorization": f"Bearer {identity['token']}"},
    )

    assert response.status_code == 200
    assert response.json()["conversation_token"] == "conv-token"


def test_session_refuses_an_unowned_runner_id(client: TestClient) -> None:
    identity = client.post("/api/register").json()
    response = client.post(
        "/api/session",
        json={"user_id": "runner_someone_else"},
        headers={"authorization": f"Bearer {identity['token']}"},
    )
    assert response.status_code == 401


def test_race_tool_rejects_an_unsigned_call(client: TestClient) -> None:
    response = client.post("/tools/search-races", json={"location": "Peak District"})
    assert response.status_code == 401


def test_race_tool_is_closed_when_no_secret_is_configured(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(main.get_settings(), "tool_secret", "")
    response = client.post(
        "/tools/search-races", json={"location": "Peak District"}, headers=TOOL_HEADERS
    )
    assert response.status_code == 503


def test_race_tool_surfaces_tavily_failures(client: TestClient, monkeypatch) -> None:
    async def boom(*args, **kwargs):
        raise RaceSearchError("Tavily 432: over plan limit")

    monkeypatch.setattr(main, "search_races", boom)
    response = client.post(
        "/tools/search-races", json={"location": "Peak District"}, headers=TOOL_HEADERS
    )
    assert response.status_code == 502
    assert "over plan limit" in response.json()["detail"]


def test_spoken_summary_is_readable_aloud() -> None:
    races = [Race(name="Hardmoors 60", url="https://example.com", summary="62 miles, 3000m gain.")]
    assert spoken_summary(races) == "1. Hardmoors 60. 62 miles, 3000m gain."
    assert "wider search area" in spoken_summary([])


def test_call_cooldown_survives_a_restart(tmp_path, monkeypatch) -> None:
    async def fake_opening_line(state):
        return "line"

    monkeypatch.setattr("app.proactive.opening_line", fake_opening_line)
    path = tmp_path / "calls.json"
    memory, ringer = FakeMemory(), FakeRinger()

    async def scenario() -> str:
        await Coach(memory, ringer, path).call("fergus")
        restarted = Coach(memory, ringer, path)  # fresh process, same disk
        return (await restarted.call("fergus")).reason

    import asyncio

    assert asyncio.run(scenario()) == "already called within the cooldown"


def test_online_sweep_waits_for_the_checkin_hour(monkeypatch, tmp_path) -> None:
    coach = Coach(FakeMemory(), FakeRinger(), tmp_path / "calls.json")
    monkeypatch.setattr(main.get_settings(), "checkin_hour_utc", 23)
    assert coach._checkin_missed("fergus") is (datetime.now(timezone.utc).hour >= 23)

    monkeypatch.setattr(main.get_settings(), "checkin_hour_utc", 0)
    assert coach._checkin_missed("fergus") is True

    coach._calls.record("fergus", datetime.now(timezone.utc) - timedelta(minutes=1))
    assert coach._checkin_missed("fergus") is False


def test_a_failing_runner_does_not_cancel_the_rest_of_the_sweep(tmp_path) -> None:
    import asyncio

    class ManyRunners(FakeMemory):
        async def list_runners(self) -> list[str]:
            return ["broken", "fergus"]

        async def get_state(self, user_id: str) -> RunnerState:
            if user_id == "broken":
                raise RuntimeError("zep is down")
            return await super().get_state(user_id)

    ringer = FakeRinger()
    coach = Coach(ManyRunners(), ringer, tmp_path / "calls.json")

    outcomes = asyncio.run(coach.sweep())

    assert [outcome.rang for outcome in outcomes] == [False, True]
    assert ringer.rings == ["fergus"]


def test_session_minting_is_throttled_per_device(client: TestClient, monkeypatch) -> None:
    async def token(agent_id: str) -> str:
        return "conv-token"

    monkeypatch.setattr(main, "conversation_token", token)
    monkeypatch.setattr(main.get_settings(), "elevenlabs_agent_id", "agent_1")

    identity = client.post("/api/register").json()
    headers = {"authorization": f"Bearer {identity['token']}"}
    body = {"user_id": identity["user_id"]}

    assert client.post("/api/session", json=body, headers=headers).status_code == 200
    assert client.post("/api/session", json=body, headers=headers).status_code == 429


def test_resolved_commitments_are_dropped() -> None:
    class Edge:
        fact = "Signed up for the Lakeland 50"
        expired_at = "2026-01-01T00:00:00Z"

    assert _format_edge(Edge()) == ""


def test_a_failed_mint_does_not_burn_the_throttle(client: TestClient, monkeypatch) -> None:
    calls = {"n": 0}

    async def token(agent_id: str) -> str:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("elevenlabs is down")
        return "conv-token"

    monkeypatch.setattr(main, "conversation_token", token)
    monkeypatch.setattr(main.get_settings(), "elevenlabs_agent_id", "agent_1")

    identity = client.post("/api/register").json()
    headers = {"authorization": f"Bearer {identity['token']}"}
    body = {"user_id": identity["user_id"]}

    with pytest.raises(RuntimeError):
        client.post("/api/session", json=body, headers=headers)
    assert client.post("/api/session", json=body, headers=headers).status_code == 200


def test_session_state_carries_a_signature_the_llm_can_check(
    client: TestClient, monkeypatch
) -> None:
    async def token(agent_id: str) -> str:
        return "conv-token"

    monkeypatch.setattr(main, "conversation_token", token)
    monkeypatch.setattr(main.get_settings(), "elevenlabs_agent_id", "agent_1")

    identity = client.post("/api/register").json()
    grant = client.post(
        "/api/session",
        json={"user_id": identity["user_id"]},
        headers={"authorization": f"Bearer {identity['token']}"},
    ).json()

    assert f"runner_sig={sign(identity['user_id'])}" in grant["runner_state"]


def test_the_llm_proxy_ignores_an_unsigned_runner_id() -> None:
    from app.llm import _runner_from

    assert _runner_from([{"role": "system", "content": "runner_id=victim"}]) == ""
    assert (
        _runner_from([{"role": "system", "content": f"runner_id=mine runner_sig={sign('mine')}"}])
        == "mine"
    )


def test_answering_in_one_tab_stops_the_others_ringing(client: TestClient) -> None:
    identity = client.post("/api/register").json()
    url = f"/ws/{identity['user_id']}?token={identity['token']}"

    with client.websocket_connect(url) as answering, client.websocket_connect(url) as other:
        answering.send_json({"type": "call_answered"})
        assert other.receive_json() == {"type": "call_cancelled"}


def test_concurrent_deliveries_write_one_transcript() -> None:
    import asyncio

    from app.memory import Memory

    class SlowZep:
        def __init__(self) -> None:
            self.threads: list[str] = []
            self.batches: list[list] = []

        class _User:
            async def get(self, user_id):
                return None

        @property
        def user(self):
            return self._User()

        @property
        def thread(self):
            outer = self

            class _Thread:
                async def create(self, thread_id, user_id):
                    if thread_id in outer.threads:
                        raise BadRequestError(body="exists")
                    outer.threads.append(thread_id)

                async def add_messages(self, thread_id, messages):
                    await asyncio.sleep(0.01)
                    outer.batches.append(messages)

                async def get(self, thread_id, **kwargs):
                    class Result:
                        messages = [m for batch in outer.batches for m in batch]

                    return Result()

            return _Thread()

    from zep_cloud.errors import BadRequestError

    zep = SlowZep()
    memory = Memory(client=zep)
    turns = [("agent", "You skipped Sunday."), ("user", "I know.")]

    async def both():
        await asyncio.gather(
            memory.add_transcript("fergus", "conv-1", turns),
            memory.add_transcript("fergus", "conv-1", turns),
        )

    asyncio.run(both())
    assert len(zep.batches) == 1


def test_transcript_for_an_unsigned_runner_is_discarded(
    client: TestClient, fake_memory: FakeMemory
) -> None:
    body, headers = signed(
        {
            "data": {
                "conversation_id": "conv_3",
                "conversation_initiation_client_data": {
                    "dynamic_variables": {"runner_id": "victim", "runner_sig": "guessed"}
                },
                "transcript": [{"role": "user", "message": "planted history"}],
            }
        }
    )
    response = client.post("/webhooks/elevenlabs", content=body, headers=headers)

    assert response.json() == {"status": "unsigned", "turns": 0}
    assert fake_memory.transcripts == []


def test_registration_is_rate_limited_per_caller(client: TestClient) -> None:
    codes = [client.post("/api/register").status_code for _ in range(12)]
    assert codes.count(200) == 10
    assert codes[-1] == 429


def test_a_late_failure_keeps_a_newer_cooldown() -> None:
    throttle = main.Throttle(every=20.0)
    admitted, first = throttle.allow("fergus")
    assert admitted

    throttle._last["fergus"] = 1_000.0  # a newer attempt reserved the cooldown
    throttle.refund("fergus", first)

    assert throttle._last["fergus"] == 1_000.0


def _product(handle: str, title: str) -> healf.Product:
    return healf.Product(handle=handle, title=title, url=f"https://healf.com/products/{handle}")


def test_the_products_tab_needs_a_device_token(client: TestClient) -> None:
    assert client.get("/api/products", params={"user_id": "fergus"}).status_code == 401


def test_the_products_tab_lists_the_range(client: TestClient, monkeypatch) -> None:
    identity = client.post("/api/register").json()

    async def featured() -> list[healf.Product]:
        return [_product("magnesium", "Magnesium Glycinate")]

    monkeypatch.setattr(main.catalogue, "featured", featured)
    response = client.get(
        "/api/products",
        params={"user_id": identity["user_id"]},
        headers={"authorization": f"Bearer {identity['token']}"},
    )

    assert [item["title"] for item in response.json()["products"]] == ["Magnesium Glycinate"]


def test_recommending_products_pushes_them_to_the_runners_tabs(
    client: TestClient, monkeypatch
) -> None:
    identity = client.post("/api/register").json()

    async def search(need: str, limit: int = 6) -> list[healf.Product]:
        return [_product("electrolytes", "Electrolyte Powder")]

    monkeypatch.setattr(main.catalogue, "search", search)
    url = f"/ws/{identity['user_id']}?token={identity['token']}"

    with client.websocket_connect(url) as tab:
        response = client.post(
            "/tools/recommend-products",
            json={
                "need": "cramp on long runs",
                "runner_id": identity["user_id"],
                "runner_sig": sign(identity["user_id"]),
            },
            headers=TOOL_HEADERS,
        )
        pushed = tab.receive_json()

    assert response.json()["shown_on_screens"] == 1
    assert pushed["type"] == "show_products"
    assert pushed["products"][0]["title"] == "Electrolyte Powder"
    assert "Electrolyte Powder" in response.json()["spoken_summary"]


def test_products_are_not_pushed_at_an_unsigned_runner(client: TestClient, monkeypatch) -> None:
    identity = client.post("/api/register").json()

    async def search(need: str, limit: int = 6) -> list[healf.Product]:
        return [_product("sleep", "Sleep Drops")]

    monkeypatch.setattr(main.catalogue, "search", search)
    url = f"/ws/{identity['user_id']}?token={identity['token']}"

    with client.websocket_connect(url) as tab:
        response = client.post(
            "/tools/recommend-products",
            json={"need": "sleep", "runner_id": identity["user_id"], "runner_sig": "forged"},
            headers=TOOL_HEADERS,
        )
        assert response.json()["shown_on_screens"] == 0
        # The coach still gets its answer; nothing reaches the impersonated runner.
        tab.send_json({"type": "call_declined"})


def test_the_catalogue_ranks_the_closest_title() -> None:
    import asyncio

    index = Catalogue()
    index._items = [
        _product("multi", "Complete Multivitamin with Magnesium and Zinc"),
        _product("mag", "Magnesium Glycinate"),
    ]
    index._loaded_at = monotonic()
    index._details = {item.handle: (monotonic(), item) for item in index._items}

    found = asyncio.run(index.search("magnesium for cramp"))

    assert [item.handle for item in found] == ["mag", "multi"]


def test_a_product_page_fills_in_price_and_brand() -> None:
    page = (
        '<script type="application/ld+json">'
        '{"@type": "Product", "name": "D3 & K2 Complex", "brand": {"@name": "x", "name": "Vivo"},'
        ' "description": "Bones  and immunity.",'
        ' "offers": {"price": "14.49", "priceCurrency": "GBP"}}'
        "</script>"
    )
    full = _from_page(_product("d3", "D3"), page)

    assert (full.title, full.brand, full.price) == ("D3 & K2 Complex", "Vivo", "14.49")
    assert full.description == "Bones and immunity."


def test_the_sitemap_gives_a_title_and_an_image() -> None:
    entry = (
        "<url><loc>https://healf.com/products/b12</loc>"
        "<image:loc>https://cdn.shopify.com/b12.png</image:loc>"
        "<image:title>B12 &#45; Orange</image:title></url>"
    )
    item = _from_sitemap(entry)

    assert item is not None
    assert (item.handle, item.title, item.image) == (
        "b12",
        "B12 - Orange",
        "https://cdn.shopify.com/b12.png",
    )


def test_registration_is_limited_per_device_not_per_proxy(client: TestClient) -> None:
    """Different devices behind the proxy each get their own allowance."""
    for index in range(12):
        response = client.post("/api/register", headers={"x-forwarded-for": f"10.0.0.{index}"})
        assert response.status_code == 200


def test_a_forged_forwarded_for_buys_no_extra_registrations(client: TestClient) -> None:
    """Only the address the proxy appended counts, so a caller cannot invent a new one."""
    codes = [
        client.post(
            "/api/register", headers={"x-forwarded-for": f"1.2.3.{index}, 10.0.0.99"}
        ).status_code
        for index in range(12)
    ]
    assert codes.count(200) == 10
    assert codes[-1] == 429


def test_registration_does_not_create_a_user_until_the_device_connects(
    client: TestClient, fake_memory: FakeMemory
) -> None:
    calls: list[str] = []
    fake_memory.ensure_user = lambda user_id: calls.append(user_id) or _noop()  # type: ignore[assignment]

    identity = client.post("/api/register").json()
    assert calls == []

    with client.websocket_connect(f"/ws/{identity['user_id']}?token={identity['token']}"):
        pass
    assert calls == [identity["user_id"]]


async def _noop() -> None:
    return None


def test_the_other_tabs_stop_ringing_even_if_the_write_fails(
    client: TestClient, fake_memory: FakeMemory
) -> None:
    async def broken(user_id: str, kind: str, payload: dict) -> None:
        raise RuntimeError("zep is down")

    fake_memory.record_event = broken  # type: ignore[assignment]
    identity = client.post("/api/register").json()
    url = f"/ws/{identity['user_id']}?token={identity['token']}"

    with client.websocket_connect(url) as answering, client.websocket_connect(url) as other:
        answering.send_json({"type": "call_answered"})
        assert other.receive_json() == {"type": "call_cancelled"}


def test_a_tavily_timeout_is_a_race_search_error(monkeypatch) -> None:
    import asyncio

    import httpx

    from app import races

    monkeypatch.setattr(races.get_settings(), "tavily_api_key", "key")

    async def timeout(*args, **kwargs):
        raise httpx.ConnectTimeout("too slow")

    monkeypatch.setattr(httpx.AsyncClient, "post", timeout)

    with pytest.raises(RaceSearchError):
        asyncio.run(races.search_races("London"))
