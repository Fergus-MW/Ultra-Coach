from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import main
from app.memory import RunnerState
from app.races import Race, RaceSearchError, spoken_summary


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


def test_health(client: TestClient) -> None:
    assert client.get("/health").json() == {"status": "ok"}


def test_transcript_webhook_ingests_turns(client: TestClient, fake_memory: FakeMemory) -> None:
    payload = {
        "data": {
            "conversation_id": "conv_1",
            "conversation_initiation_client_data": {"dynamic_variables": {"runner_id": "fergus"}},
            "transcript": [
                {"role": "agent", "message": "Where was Sunday's long run?"},
                {"role": "user", "message": "I skipped it."},
                {"role": "agent", "message": ""},
            ],
        }
    }
    response = client.post("/webhooks/elevenlabs-transcript", json=payload)

    assert response.json() == {"status": "ingested", "turns": 2}
    user_id, conversation_id, turns = fake_memory.transcripts[0]
    assert (user_id, conversation_id) == ("fergus", "conv_1")
    assert turns[1] == ("user", "I skipped it.")


def test_ring_is_skipped_when_runner_is_offline(client: TestClient) -> None:
    body = client.post("/api/proactive-ring/fergus").json()
    assert body["rang"] is False
    assert body["reason"] == "runner is not reachable"


def test_ring_reaches_a_connected_runner(client: TestClient, monkeypatch) -> None:
    async def fake_opening_line(state):
        return "You skipped Sunday. Why?"

    monkeypatch.setattr(main.coach, "_memory", FakeMemory())
    monkeypatch.setattr("app.proactive.opening_line", fake_opening_line)

    with client.websocket_connect("/ws/fergus") as socket:
        body = client.post("/api/proactive-ring/fergus").json()
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


def test_race_tool_rejects_an_unsigned_call(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(main.get_settings(), "tool_secret", "shhh")
    response = client.post("/tools/search-races", json={"location": "Peak District"})
    assert response.status_code == 401


def test_race_tool_surfaces_tavily_failures(client: TestClient, monkeypatch) -> None:
    async def boom(*args, **kwargs):
        raise RaceSearchError("Tavily 432: over plan limit")

    monkeypatch.setattr(main, "search_races", boom)
    response = client.post("/tools/search-races", json={"location": "Peak District"})
    assert response.status_code == 502
    assert "over plan limit" in response.json()["detail"]


def test_spoken_summary_is_readable_aloud() -> None:
    races = [Race(name="Hardmoors 60", url="https://example.com", summary="62 miles, 3000m gain.")]
    assert spoken_summary(races) == "1. Hardmoors 60. 62 miles, 3000m gain."
    assert "wider search area" in spoken_summary([])
