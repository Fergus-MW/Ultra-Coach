"""xAI Grok: writes the line the coach opens a proactive call with."""

from __future__ import annotations

import httpx

from .config import get_settings
from .memory import RunnerState

XAI_API = "https://api.x.ai/v1"

COACH_SYSTEM = (
    "You are Ultra Coach, a ruthless ultra-marathon coach. You are blunt, you never "
    "flatter, and you hold the runner to what they said they would do. You speak in "
    "short spoken sentences, never lists, never markdown, never emoji."
)

OPENING_INSTRUCTION = (
    "The runner just answered your call. Open with one or two sentences: name the "
    "single most damning unresolved thing from their history and demand an answer. "
    "If there is no history, demand their goal race and current weekly mileage. "
    "Never greet them politely."
)


async def opening_line(state: RunnerState, nudge: str = "") -> str:
    """`nudge` steers what the coach opens on, so a demo can go straight to a subject."""
    settings = get_settings()
    if not settings.xai_api_key:
        return _fallback(state)

    instruction = f"{OPENING_INSTRUCTION}\n\n{nudge}" if nudge else OPENING_INSTRUCTION

    payload = {
        "model": settings.xai_model,
        "messages": [
            {"role": "system", "content": COACH_SYSTEM},
            {
                "role": "user",
                "content": f"Runner history:\n{state.as_prompt_block()}\n\n{instruction}",
            },
        ],
        "temperature": 0.8,
        "max_tokens": 120,
    }

    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(
            f"{XAI_API}/chat/completions",
            headers={"Authorization": f"Bearer {settings.xai_api_key}"},
            json=payload,
        )
        response.raise_for_status()
        body = response.json()

    line = body["choices"][0]["message"]["content"].strip()
    return line or _fallback(state)


def _fallback(state: RunnerState) -> str:
    if state.commitments:
        return f"We need to talk about this: {state.commitments[0]}. Explain yourself."
    return "You have no races booked and nothing logged. What are you actually training for?"
