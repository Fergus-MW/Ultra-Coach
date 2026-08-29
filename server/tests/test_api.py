from __future__ import annotations

import hmac
import json
import time
from datetime import datetime, timedelta, timezone
from hashlib import sha256

import pytest
from fastapi.testclient import TestClient

from app import main
from app.auth import sign
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
                    "dynamic_variables": {"runner_id": "fergus"}
                },
                "transcript": [
                    {"role": "agent", "message": "Where was Sunday's long run?"},
                    {"role": "user", "message": "I skipped it."},
                    {"role": "agent", "message": ""},
                ],
            }
        }
    )
    response = client.post("/webhooks/elevenlabs-transcript", content=body, headers=headers)

    assert response.json() == {"status": "ingested", "turns": 2}
    user_id, conversation_id, turns = fake_memory.transcripts[0]
    assert (user_id, conversation_id) == ("fergus", "conv_1")
    assert turns[1] == ("user", "I skipped it.")


def test_transcript_webhook_rejects_a_forged_payload(
    client: TestClient, fake_memory: FakeMemory
) -> None:
    response = client.post(
        "/webhooks/elevenlabs-transcript",
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
    response = client.post("/webhooks/elevenlabs-transcript", content=body, headers=headers)

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
                "transcript": [{"role": "user", "message": "I skipped it."}],
            }
        }
    )
    response = client.post("/webhooks/elevenlabs-transcript", content=body, headers=headers)
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
