"""OpenAI-compatible proxy that puts Grok behind the ElevenLabs agent.

ElevenLabs calls this as a custom LLM, so the xAI key stays server side and every
turn is answered with the runner's live Zep state stitched into the system prompt.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator

import httpx

from .auth import verify
from .config import get_settings
from .grok import COACH_SYSTEM, XAI_API
from .memory import Memory

log = logging.getLogger(__name__)


async def chat_completion(body: dict, memory: Memory) -> httpx.Response | AsyncIterator[bytes]:
    settings = get_settings()
    payload = dict(body)
    payload["model"] = settings.xai_model
    payload["messages"] = await _with_coach_context(payload.get("messages", []), memory)
    if not payload.get("tools"):
        payload.pop("tool_choice", None)

    headers = {"Authorization": f"Bearer {settings.xai_api_key}"}
    client = httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0))

    if not payload.get("stream"):
        try:
            response = await client.post(
                f"{XAI_API}/chat/completions", headers=headers, json=payload
            )
            return response
        finally:
            await client.aclose()

    return _stream(client, headers, payload)


async def _stream(client: httpx.AsyncClient, headers: dict, payload: dict) -> AsyncIterator[bytes]:
    try:
        async with client.stream(
            "POST", f"{XAI_API}/chat/completions", headers=headers, json=payload
        ) as response:
            if response.status_code >= 400:
                detail = (await response.aread()).decode()[:300]
                log.error("xai stream failed: %s %s", response.status_code, detail)
                yield _error_chunk(detail)
                return
            async for chunk in response.aiter_bytes():
                yield chunk
    finally:
        await client.aclose()


async def _with_coach_context(messages: list[dict], memory: Memory) -> list[dict]:
    """Force the persona and refresh the runner state on every turn."""
    user_id = _runner_from(messages)
    state_block = ""
    if user_id:
        try:
            state = await memory.get_state(user_id)
            state_block = state.as_prompt_block()
        except Exception:
            log.exception("could not load Zep state for %s", user_id)

    system = COACH_SYSTEM
    if state_block:
        system = f"{system}\n\nWhat you know about this runner:\n{state_block}"

    rest = [message for message in messages if message.get("role") != "system"]
    inherited = [message for message in messages if message.get("role") == "system"]
    if inherited:
        system = f"{system}\n\n{inherited[0].get('content', '')}"
    return [{"role": "system", "content": system}, *rest]


def _runner_from(messages: list[dict]) -> str:
    """ElevenLabs forwards dynamic variables inside the agent's system prompt.

    The id alone is not evidence: anything that can reach this proxy could name another
    runner and be handed their history, so the id is only honoured with the signature
    `/api/session` issued to the device that owns it.
    """
    for message in messages:
        content = message.get("content") or ""
        if "runner_id=" not in content:
            continue
        user_id = _field(content, "runner_id=")
        if verify(user_id, _field(content, "runner_sig=")):
            return user_id
        log.warning("ignoring unsigned runner id in conversation prompt")
        return ""
    return ""


def _field(content: str, marker: str) -> str:
    if marker not in content:
        return ""
    return content.split(marker, 1)[1].split()[0].strip().strip(".,")


def _error_chunk(detail: str) -> bytes:
    body = {
        "choices": [
            {
                "index": 0,
                "delta": {"content": "My connection just dropped. Say that again."},
                "finish_reason": "stop",
            }
        ]
    }
    log.error("returning fallback chunk: %s", detail)
    return f"data: {json.dumps(body)}\n\ndata: [DONE]\n\n".encode()
