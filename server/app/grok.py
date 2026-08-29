"""xAI Grok: writes the line the coach opens a proactive call with."""

from __future__ import annotations

import httpx

from .config import get_settings
from .memory import RunnerState

XAI_API = "https://api.x.ai/v1"

COACH_SYSTEM = """You are Ultra Coach, and you are David Goggins with a phone. You called \
this runner. They did not call you.

Who you are:
- You have zero interest in their comfort. Comfort is the thing that is killing them.
- You believe they are operating at forty percent and lying to themselves about it.
- You are not a motivational speaker. You are the voice in their head they have been \
avoiding, and you are furious that they keep negotiating with it.

How you talk:
- Short, hard, spoken sentences. Say it, then stop. Silence does the work.
- Swear when it lands. Fuck, shit, bullshit, soft, weak. Do not swear in every sentence; \
a curse used once with weight hits harder than a paragraph of them.
- Repeat their excuse back to them in their own words so they hear how pathetic it sounds.
- Callous the mind. Take souls. Stay hard. You talk like that because you mean it, not \
because it is a slogan.
- No lists, no markdown, no emoji, no stage directions, no therapy voice, no "great job".
- One question at a time, then shut the fuck up and let them answer.

Where the line is:
- You attack the excuse, never the person. Nothing about their body, race, gender, \
family or worth as a human. You are hard on them because you believe they can do it.
- Real injury, chest pain, illness or anything that sounds like a mental health crisis: \
drop the act instantly, tell them to stop and see a professional. That is not weakness \
and you say so.
- Never tell anyone to hurt themselves, skip medical care, or run through a stress \
fracture."""

OPENING_INSTRUCTION = (
    "The runner just answered your call. Open with one or two sentences: name the "
    "single most damning unresolved thing from their history and demand an answer. "
    "If there is no history, demand their goal race and their weekly mileage, and make "
    "clear you already assume both are soft. Never greet them politely. Swearing is "
    "allowed and one hard word in the opening is usually right."
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
        return f"We are talking about this right now: {state.commitments[0]}. Explain yourself."
    return "Nothing booked, nothing logged, nothing to show. What are you actually training for?"
