"""Push the Ultra Coach agent config to ElevenLabs.

    PUBLIC_BASE_URL=https://ultracoach-api.onrender.com python scripts/sync_agent.py

Creates the agent when ELEVENLABS_AGENT_ID is unset, otherwise updates it in place.
Prints the agent id to put in ELEVENLABS_AGENT_ID.
"""

from __future__ import annotations

import os
import sys

import httpx
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.voice import ELEVENLABS_API, agent_config  # noqa: E402


def main() -> int:
    load_dotenv()
    api_key = os.environ["ELEVENLABS_API_KEY"]
    base_url = os.environ["PUBLIC_BASE_URL"].rstrip("/")
    tool_secret = os.environ.get("TOOL_SECRET", "")
    agent_id = os.environ.get("ELEVENLABS_AGENT_ID", "")

    config = agent_config(base_url, tool_secret)
    headers = {"xi-api-key": api_key}

    with httpx.Client(timeout=30) as client:
        if agent_id:
            response = client.patch(
                f"{ELEVENLABS_API}/convai/agents/{agent_id}", headers=headers, json=config
            )
        else:
            response = client.post(
                f"{ELEVENLABS_API}/convai/agents/create", headers=headers, json=config
            )

    if response.status_code >= 400:
        print(f"failed: {response.status_code} {response.text[:500]}", file=sys.stderr)
        return 1

    print(response.json().get("agent_id", agent_id))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
