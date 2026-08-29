"""ElevenLabs Conversational AI: browser session tokens and declarative agent config."""

from __future__ import annotations

import httpx

from .config import get_settings

ELEVENLABS_API = "https://api.elevenlabs.io/v1"
DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"

AGENT_PROMPT = """You are Ultra Coach, a ruthless ultra-marathon coach who calls runners \
rather than waiting to be asked.

How you speak:
- Short spoken sentences. No lists, no markdown, no emoji, no stage directions.
- Blunt and specific. Never flatter, never apologise for calling.
- One question at a time, then shut up and let them answer.

What you do on a call:
- Open on the unresolved thing in their history: a missed run, an excuse, a race they \
said they would enter and did not.
- Make them commit out loud to a date, a distance or an entry. Repeat the commitment \
back so it is on record.
- When they have no race booked, call search_ultra_events and push a specific one at \
them with its date and entry deadline. Do not offer a menu of five.
- Never let a vague answer stand. "Soon" is not a date.
- When what they describe is a fuelling, recovery or sleep problem — cramp, bonking, \
sore legs, poor sleep, low iron — call recommend_products with the need in plain words \
and the runner_id and runner_sig from the block below. Say what you are putting on their \
screen and why it fits them. One or two products, never a catalogue.
- Do not push a product for its own sake. No sales patter, no discount talk.

Runner history and open commitments:
{{runner_state}}
"""


async def conversation_token(agent_id: str) -> str:
    """Mint a short-lived WebRTC token so the browser never sees the API key."""
    settings = get_settings()
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(
            f"{ELEVENLABS_API}/convai/conversation/token",
            params={"agent_id": agent_id},
            headers={"xi-api-key": settings.elevenlabs_api_key},
        )
        response.raise_for_status()
        return response.json()["token"]


def agent_config(public_base_url: str, tool_secret: str) -> dict:
    """Declarative agent: Grok behind our own OpenAI-compatible proxy, Tavily as a tool."""
    return {
        "name": "Ultra Coach",
        "conversation_config": {
            "agent": {
                "first_message": "",
                "language": "en",
                "prompt": {
                    "prompt": AGENT_PROMPT,
                    "llm": "custom-llm",
                    "custom_llm": {
                        "url": f"{public_base_url}/llm",
                        "model_id": "grok",
                        "request_headers": {"x-tool-secret": tool_secret},
                    },
                    "temperature": 0.7,
                    "tools": [
                        {
                            "type": "webhook",
                            "name": "search_ultra_events",
                            "description": (
                                "Find real ultramarathon races (50K, 50 mile, 100K, 100 mile) "
                                "near a location that the runner can still enter."
                            ),
                            "api_schema": {
                                "url": f"{public_base_url}/tools/search-races",
                                "method": "POST",
                                "request_headers": {"x-tool-secret": tool_secret},
                                "request_body_schema": {
                                    "type": "object",
                                    "required": ["location"],
                                    "properties": {
                                        "location": {
                                            "type": "string",
                                            "description": "Town, city or region to search near.",
                                        },
                                        "distance": {
                                            "type": "string",
                                            "description": "50K, 50 mile, 100K or 100 mile.",
                                        },
                                        "months_ahead": {
                                            "type": "integer",
                                            "description": "How far ahead to look.",
                                        },
                                    },
                                },
                            },
                        },
                        {
                            "type": "webhook",
                            "name": "recommend_products",
                            "description": (
                                "Recommend Healf products for a fuelling, recovery or "
                                "sleep need and show them on the runner's screen."
                            ),
                            "api_schema": {
                                "url": f"{public_base_url}/tools/recommend-products",
                                "method": "POST",
                                "request_headers": {"x-tool-secret": tool_secret},
                                "request_body_schema": {
                                    "type": "object",
                                    "required": ["need"],
                                    "properties": {
                                        "need": {
                                            "type": "string",
                                            "description": (
                                                "The runner's need in plain words, e.g. "
                                                "'electrolytes for cramp on long runs'."
                                            ),
                                        },
                                        "runner_id": {
                                            "type": "string",
                                            "description": "runner_id from the runner block.",
                                        },
                                        "runner_sig": {
                                            "type": "string",
                                            "description": "runner_sig from the runner block.",
                                        },
                                    },
                                },
                            },
                        },
                    ],
                },
            },
            "tts": {"voice_id": DEFAULT_VOICE_ID, "model_id": "eleven_flash_v2"},
            "turn": {"turn_timeout": 10},
        },
        "platform_settings": {
            "overrides": {
                "conversation_config_override": {
                    "agent": {"first_message": True, "prompt": {"prompt": False}}
                }
            }
        },
    }
