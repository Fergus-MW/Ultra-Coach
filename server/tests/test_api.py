from __future__ import annotations

import asyncio
import hmac
import json
import os
import time
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from time import monotonic

import pytest
from fastapi.testclient import TestClient

from app import healf, llm, main
from app import memory as memory_module
from app.auth import sign
from app.db import Database
from app.healf import Catalogue, _from_page, _from_sitemap
from app.memory import RunnerState, _format_edge
from app.proactive import CallLog, Coach
from app.races import Race, RaceSearchError, spoken_summary
from app.wearables import Wearable

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


def ran(awaitable):
    """Await one call from a synchronous test."""
    import asyncio

    return asyncio.run(_awaited(awaitable))


async def _awaited(awaitable):
    return await awaitable


TEST_DSN = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:5432/ultracoach_test"
)


def on_postgres(scenario):
    """Run a scenario against a real database, or skip where there is not one.

    The pool belongs to the loop that made it, so each scenario opens and closes its
    own rather than sharing one across the suite.
    """
    import asyncio

    async def run():
        database = Database()
        if not await database.connect(TEST_DSN):
            return None
        async with database.pool.acquire() as connection:
            await connection.execute("TRUNCATE calls, wearable_links, wearable_readings")
        try:
            return await scenario(database)
        finally:
            await database.close()

    outcome = asyncio.run(run())
    if outcome is None:
        pytest.skip(f"no Postgres at {TEST_DSN}")
    return outcome


@pytest.fixture(autouse=True)
def fresh_limits() -> None:
    main._register_bucket = main.Bucket(burst=10, per_second=0.2)


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    configured = main.get_settings()
    monkeypatch.setattr(configured, "tool_secret", TOOL_SECRET)
    monkeypatch.setattr(configured, "session_secret", "signing-key")
    monkeypatch.setattr(configured, "elevenlabs_webhook_secret", WEBHOOK_SECRET)
    monkeypatch.setattr(configured, "wearables_url", "")
    monkeypatch.setattr(configured, "wearables_api_key", "")
    monkeypatch.setattr(configured, "database_url", "")
    monkeypatch.setattr(main.coach, "_calls", CallLog(Database()))
    return configured


@pytest.fixture
def wearable(monkeypatch) -> Wearable:
    """A coach with its own empty device history, connected to nothing."""
    fresh = Wearable(Database())
    monkeypatch.setattr(main, "wearable", fresh)
    monkeypatch.setattr(memory_module, "wearable", fresh)
    return fresh


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
    async def fake_opening_line(state, nudge=""):
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


def test_call_cooldown_survives_a_restart(monkeypatch) -> None:
    async def fake_opening_line(state, nudge=""):
        return "line"

    monkeypatch.setattr("app.proactive.opening_line", fake_opening_line)
    memory, ringer = FakeMemory(), FakeRinger()

    async def scenario(database: Database) -> str:
        await Coach(memory, ringer, CallLog(database)).call("fergus")
        restarted = Coach(memory, ringer, CallLog(database))  # fresh process, same rows
        await restarted.restore()
        return (await restarted.call("fergus")).reason

    assert on_postgres(scenario) == "already called within the cooldown"


def test_online_sweep_waits_for_the_checkin_hour(monkeypatch) -> None:
    coach = Coach(FakeMemory(), FakeRinger())
    monkeypatch.setattr(main.get_settings(), "checkin_hour_utc", 23)
    assert coach._checkin_missed("fergus") is (datetime.now(timezone.utc).hour >= 23)

    monkeypatch.setattr(main.get_settings(), "checkin_hour_utc", 0)
    assert coach._checkin_missed("fergus") is True

    ran(coach._calls.record("fergus", datetime.now(timezone.utc) - timedelta(minutes=1)))
    assert coach._checkin_missed("fergus") is False


def test_a_failing_runner_does_not_cancel_the_rest_of_the_sweep() -> None:
    import asyncio

    class ManyRunners(FakeMemory):
        async def list_runners(self) -> list[str]:
            return ["broken", "fergus"]

        async def get_state(self, user_id: str) -> RunnerState:
            if user_id == "broken":
                raise RuntimeError("zep is down")
            return await super().get_state(user_id)

    ringer = FakeRinger()
    coach = Coach(ManyRunners(), ringer)

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


def test_a_demo_call_rings_this_runner_on_the_chosen_subject(
    client: TestClient, monkeypatch
) -> None:
    """The coach still writes the line; the demo only chooses what it opens on."""
    nudges: list[str] = []

    async def fake_opening_line(state, nudge=""):
        nudges.append(nudge)
        return "What have you actually entered?"

    monkeypatch.setattr("app.proactive.opening_line", fake_opening_line)
    identity = client.post("/api/register").json()
    url = f"/ws/{identity['user_id']}?token={identity['token']}"

    with client.websocket_connect(url) as tab:
        response = client.post(
            f"/api/demo/call?user_id={identity['user_id']}",
            json={"scenario": "races"},
            headers={"authorization": f"Bearer {identity['token']}"},
        )
        ring = tab.receive_json()

    assert response.json()["rang"] is True
    assert ring["type"] == "incoming_call"
    assert "race search tool" in nudges[0]


def test_a_demo_call_cannot_be_aimed_at_another_runner(client: TestClient) -> None:
    identity = client.post("/api/register").json()
    response = client.post(
        "/api/demo/call?user_id=someone-else",
        json={"scenario": "checkin"},
        headers={"authorization": f"Bearer {identity['token']}"},
    )
    assert response.status_code == 401


def test_an_unknown_demo_scenario_is_refused(client: TestClient) -> None:
    identity = client.post("/api/register").json()
    response = client.post(
        f"/api/demo/call?user_id={identity['user_id']}",
        json={"scenario": "whatever"},
        headers={"authorization": f"Bearer {identity['token']}"},
    )
    assert response.status_code == 400


def test_a_demo_push_puts_products_on_this_runners_screens(client: TestClient, monkeypatch) -> None:
    async def search(need: str, limit: int = 6) -> list[healf.Product]:
        return [_product("gel", "Energy Gel")]

    monkeypatch.setattr(main.catalogue, "search", search)
    identity = client.post("/api/register").json()
    url = f"/ws/{identity['user_id']}?token={identity['token']}"

    with client.websocket_connect(url) as tab:
        response = client.post(
            f"/api/demo/products?user_id={identity['user_id']}&need=fuelling",
            headers={"authorization": f"Bearer {identity['token']}"},
        )
        pushed = tab.receive_json()

    assert response.json()["shown_on_screens"] == 1
    assert pushed["products"][0]["title"] == "Energy Gel"


def test_private_thinking_never_reaches_the_voice() -> None:
    thinking = json.dumps({"choices": [{"index": 0, "delta": {"reasoning_content": "hmm"}}]})
    speech = json.dumps({"choices": [{"index": 0, "delta": {"content": "Run."}}]})

    assert llm._speakable(f"data: {thinking}") is None
    assert b"Run." in (llm._speakable(f"data: {speech}") or b"")
    assert llm._speakable("data: [DONE]") == b"data: [DONE]\n\n"


def test_the_runners_history_is_read_once_per_call(monkeypatch) -> None:
    import asyncio

    reads: list[str] = []

    class Counting(FakeMemory):
        async def get_state(self, user_id: str) -> RunnerState:
            reads.append(user_id)
            return await super().get_state(user_id)

    monkeypatch.setattr(llm, "_states", {})
    memory = Counting()

    async def two_turns() -> None:
        for _ in range(2):
            await llm._with_coach_context(
                [{"role": "system", "content": f"runner_id=fergus runner_sig={sign('fergus')}"}],
                memory,
            )

    asyncio.run(two_turns())
    assert reads == ["fergus"]


def a_night(hours: float = 6.0) -> dict:
    now = datetime.now(timezone.utc)
    return {
        "date": now.date().isoformat(),
        "source": {"provider": "fitbit"},
        "start_time": (now - timedelta(hours=hours)).isoformat(),
        "end_time": now.isoformat(),
        "duration_minutes": hours * 60,
        "efficiency_percent": 84,
        "avg_heart_rate_bpm": 49,
    }


def a_run(days_ago: float = 0, km: float = 21.1) -> dict:
    now = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return {
        "source": {"provider": "fitbit"},
        "name": "Long run",
        "start_time": (now - timedelta(hours=2)).isoformat(),
        "end_time": now.isoformat(),
        "distance_meters": km * 1000,
        "duration_seconds": 7500,
        "avg_heart_rate_bpm": 149,
    }


def a_day(steps: int, hours_ago: float = 0) -> dict:
    # Anchored at midday so a test running near midnight still means "today".
    noon = datetime.now(timezone.utc).replace(hour=12, minute=0, second=0, microsecond=0)
    now = noon - timedelta(hours=hours_ago)
    return {
        "source": {"provider": "fitbit"},
        "end_time": now.isoformat(),
        "steps": steps,
        "heart_rate": {"resting_bpm": 46},
    }


def platform(
    monkeypatch, wearable: Wearable, pages: dict[str, dict], connected: bool = True
) -> list[tuple[str, str]]:
    """Stand in for our Open Wearables deployment, and record what was asked of it."""
    seen: list[tuple[str, str]] = []
    active = {"data": [{"provider": "fitbit", "status": "active"}]} if connected else {"data": []}

    async def call(method: str, path: str, **kwargs) -> dict:
        seen.append((method, path))
        if path.endswith("/connections"):
            return active
        return pages.get(path, {"data": []})

    monkeypatch.setattr(wearable, "_call", call)
    return seen


def test_wearable_records_reach_the_runners_prompt(wearable: Wearable) -> None:
    ran(wearable.link("user-1", "fergus", "fitbit"))
    ran(wearable.record("fergus", "sleep", a_night(5.5)))
    ran(wearable.record("fergus", "activity", a_run()))

    block = wearable.block("fergus")

    assert "Fitbit" in block
    assert "5h 30m asleep" in block and "84% efficiency" in block
    assert "21.1 km" in block and "5:55 per km" in block
    assert (
        block
        in RunnerState(
            user_id="fergus", context="", commitments=[], wearable=block
        ).as_prompt_block()
    )


def test_a_stale_night_is_not_read_out_as_news(wearable: Wearable) -> None:
    old = a_night()
    old["end_time"] = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    ran(wearable.record("fergus", "sleep", old))

    assert wearable.block("fergus") == ""


def test_a_resent_day_updates_rather_than_duplicates(wearable: Wearable) -> None:
    ran(wearable.record("fergus", "daily", a_day(14000)))
    # Providers backfill out of order, and yesterday's half-day must not overwrite today.
    ran(wearable.record("fergus", "daily", a_day(3000, hours_ago=6)))

    block = wearable.block("fergus")
    assert "14,000 steps" in block
    assert "3,000 steps" not in block


def test_connecting_creates_the_runner_once_and_asks_for_fitbit(
    client: TestClient, wearable: Wearable, monkeypatch
) -> None:
    configured = main.get_settings()
    monkeypatch.setattr(configured, "wearables_url", "https://wearables.test")
    monkeypatch.setattr(configured, "wearables_api_key", "sk-test")
    monkeypatch.setattr(configured, "pwa_url", "https://pwa.test")
    seen = platform(
        monkeypatch,
        wearable,
        {
            "/api/v1/users": {"id": "0d2f-user"},
            "/api/v1/oauth/fitbit/authorize": {"authorization_url": "https://fitbit.test/consent"},
        },
    )
    identity = client.post("/api/register").json()
    headers = {"authorization": f"Bearer {identity['token']}"}
    runner = identity["user_id"]

    first = client.post(f"/api/wearable/connect?user_id={runner}", headers=headers)
    second = client.post(f"/api/wearable/connect?user_id={runner}", headers=headers)

    assert first.json() == {"url": "https://fitbit.test/consent"}
    assert second.json() == first.json()
    # The runner is minted once: a second tap must reuse them, not fork their history.
    assert [path for method, path in seen if method == "POST"] == ["/api/v1/users"]
    assert wearable.user_for(runner) == "0d2f-user"


def test_returning_from_fitbit_pulls_the_week_into_the_graph(
    client: TestClient, wearable: Wearable, fake_memory: FakeMemory, monkeypatch
) -> None:
    configured = main.get_settings()
    monkeypatch.setattr(configured, "wearables_url", "https://wearables.test")
    monkeypatch.setattr(configured, "wearables_api_key", "sk-test")
    identity = client.post("/api/register").json()
    headers = {"authorization": f"Bearer {identity['token']}"}
    runner = identity["user_id"]
    ran(wearable.link("user-1", runner, "fitbit"))
    platform(
        monkeypatch,
        wearable,
        {
            "/api/v1/users/user-1/summaries/sleep": {"data": [a_night(7.0)]},
            "/api/v1/users/user-1/events/workouts": {"data": [a_run()]},
        },
    )

    status = client.get(f"/api/wearable?user_id={runner}", headers=headers).json()

    assert status["connected"] is True
    assert "7h 00m asleep" in status["summary"] and "21.1 km" in status["summary"]
    assert [event[0] for event in fake_memory.events] == [runner, runner]


def test_cancelled_consent_is_not_a_connected_watch(
    client: TestClient, wearable: Wearable, monkeypatch
) -> None:
    configured = main.get_settings()
    monkeypatch.setattr(configured, "wearables_url", "https://wearables.test")
    monkeypatch.setattr(configured, "wearables_api_key", "sk-test")
    monkeypatch.setattr(configured, "pwa_url", "https://pwa.test")
    platform(
        monkeypatch,
        wearable,
        {
            "/api/v1/users": {"id": "user-1"},
            "/api/v1/oauth/fitbit/authorize": {"authorization_url": "https://fitbit.test/consent"},
        },
        connected=False,
    )
    identity = client.post("/api/register").json()
    headers = {"authorization": f"Bearer {identity['token']}"}
    runner = identity["user_id"]

    client.post(f"/api/wearable/connect?user_id={runner}", headers=headers)
    # The runner closed Fitbit's consent screen: the platform account exists, the watch
    # does not, and the connect button has to stay.
    status = client.get(f"/api/wearable?user_id={runner}", headers=headers).json()

    assert status["connected"] is False


def test_a_week_of_running_is_not_collapsed_into_one_run(wearable: Wearable, monkeypatch) -> None:
    configured = main.get_settings()
    monkeypatch.setattr(configured, "wearables_url", "https://wearables.test")
    monkeypatch.setattr(configured, "wearables_api_key", "sk-test")
    ran(wearable.link("user-1", "fergus", "fitbit"))
    platform(
        monkeypatch,
        wearable,
        {
            "/api/v1/users/user-1/events/workouts": {
                "data": [a_run(days_ago=1, km=10.0), a_run(days_ago=3, km=32.0)]
            }
        },
    )

    first = ran(wearable.refresh("fergus"))
    # A second poll brings back the same two runs: the coach has already been told.
    again = ran(wearable.refresh("fergus"))

    assert len(first) == 2
    assert again == []
    block = wearable.block("fergus")
    assert "10.0 km" in block and "32.0 km" in block


def test_wearable_data_stays_dead_without_a_platform(client: TestClient) -> None:
    identity = client.post("/api/register").json()
    headers = {"authorization": f"Bearer {identity['token']}"}

    status = client.get(f"/api/wearable?user_id={identity['user_id']}", headers=headers).json()
    connect = client.post(f"/api/wearable/connect?user_id={identity['user_id']}", headers=headers)

    assert status == {"available": False, "connected": False, "summary": ""}
    assert connect.status_code == 503


def test_one_runner_cannot_read_anothers_body(client: TestClient, wearable: Wearable) -> None:
    ran(wearable.link("user-1", "fergus", "fitbit", confirmed=True))
    ran(wearable.record("fergus", "sleep", a_night()))

    mine = client.post(
        "/tools/body-metrics",
        json={"runner_id": "fergus", "runner_sig": sign("fergus")},
        headers=TOOL_HEADERS,
    )
    theirs = client.post(
        "/tools/body-metrics",
        json={"runner_id": "fergus", "runner_sig": sign("someone-else")},
        headers=TOOL_HEADERS,
    )

    assert "asleep" in mine.json()["spoken_summary"]
    assert theirs.status_code == 401


def test_wearable_data_survives_a_redeploy() -> None:
    async def scenario(database: Database) -> str:
        writing = Wearable(database)
        await writing.link("user-1", "fergus", "fitbit", confirmed=True)
        await writing.record("fergus", "sleep", a_night(7.25))

        restarted = Wearable(database)  # Render replaced the container
        await restarted.load()
        return restarted.block("fergus")

    assert "7h 15m asleep" in on_postgres(scenario)


def test_two_tabs_cannot_fork_the_runners_watch() -> None:
    async def scenario(database: Database) -> tuple[str, str]:
        minted = iter(["user-a", "user-b"])

        async def call(method: str, path: str, **kwargs) -> dict:
            return {"id": next(minted)}

        # Two instances, each with its own memory, connecting the same runner at once.
        one, two = Wearable(database), Wearable(database)
        for store in (one, two):
            store._call = call  # type: ignore[method-assign]
        held = await asyncio.gather(one.ensure_user("fergus"), two.ensure_user("fergus"))
        return held[0], held[1]

    first, second = on_postgres(scenario)
    assert first == second


def test_a_late_backfill_never_overwrites_the_newer_night() -> None:
    async def scenario(database: Database) -> str:
        store = Wearable(database)
        await store.record("fergus", "daily", a_day(14000))
        # A second process, holding the older payload, must not undo the newer row.
        other = Wearable(database)
        await other.record("fergus", "daily", a_day(3000, hours_ago=6))

        reread = Wearable(database)
        await reread.load()
        return reread.block("fergus")

    block = on_postgres(scenario)
    assert "14,000 steps" in block and "3,000 steps" not in block
