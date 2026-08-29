"""Zep temporal knowledge graph: every call, commitment and missed run lives here."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from zep_cloud import EntityEdge, Message
from zep_cloud.client import AsyncZep
from zep_cloud.errors import BadRequestError, NotFoundError

from .config import get_settings

log = logging.getLogger(__name__)

COMMITMENT_QUERIES = (
    "races the runner entered or promised to enter",
    "training sessions the runner committed to",
    "runs the runner skipped or excuses the runner made",
    "sign-up deadlines and race dates",
)


@dataclass(frozen=True)
class RunnerState:
    """Everything the coach knows about a runner at call time."""

    user_id: str
    context: str
    commitments: list[str]

    def as_prompt_block(self) -> str:
        commitments = "\n".join(f"- {item}" for item in self.commitments)
        parts = [self.context.strip(), commitments.strip()]
        block = "\n\n".join(part for part in parts if part)
        return block or "No history yet. This is the first contact with this runner."


class Memory:
    def __init__(self, client: AsyncZep | None = None) -> None:
        settings = get_settings()
        self._client = client or AsyncZep(api_key=settings.zep_api_key)

    async def ensure_user(self, user_id: str) -> None:
        try:
            await self._client.user.get(user_id)
        except NotFoundError:
            await self._client.user.add(user_id=user_id)

    async def add_transcript(
        self,
        user_id: str,
        conversation_id: str,
        turns: list[tuple[str, str]],
    ) -> None:
        """Ingest a finished call. `turns` is a list of (role, message)."""
        if not turns:
            return

        await self.ensure_user(user_id)
        thread_id = f"call-{conversation_id}"
        try:
            await self._client.thread.create(thread_id=thread_id, user_id=user_id)
        except BadRequestError:
            pass  # thread already exists: a webhook retry

        await self._client.thread.add_messages(
            thread_id,
            messages=[
                Message(role="assistant" if role == "agent" else "user", content=content)
                for role, content in turns
                if content.strip()
            ],
        )

    async def record_event(self, user_id: str, kind: str, payload: dict) -> None:
        """Store a structured fact (race entry, logged run, declined call)."""
        await self.ensure_user(user_id)
        await self._client.graph.add(
            user_id=user_id,
            type="json",
            data=json.dumps(
                {
                    "kind": kind,
                    "recorded_at": datetime.now(timezone.utc).isoformat(),
                    **payload,
                }
            ),
        )

    async def get_state(self, user_id: str) -> RunnerState:
        await self.ensure_user(user_id)
        context = ""
        latest = _latest_thread_id(await self._client.user.get_threads(user_id))
        if latest:
            response = await self._client.thread.get_user_context(latest)
            context = response.context or ""

        commitments: list[str] = []
        for query in COMMITMENT_QUERIES:
            results = await self._client.graph.search(
                user_id=user_id, query=query, scope="edges", limit=5
            )
            for edge in results.edges or []:
                fact = _format_edge(edge)
                if fact and fact not in commitments:
                    commitments.append(fact)

        return RunnerState(user_id=user_id, context=context, commitments=commitments)

    async def list_runners(self) -> list[str]:
        response = await self._client.user.list_ordered(page_size=100)
        return [user.user_id for user in response.users or [] if user.user_id]


def _latest_thread_id(threads: list) -> str | None:
    if not threads:
        return None
    newest = max(threads, key=lambda thread: thread.created_at or "")
    return newest.thread_id


def _format_edge(edge: EntityEdge) -> str:
    fact = getattr(edge, "fact", None)
    if not fact:
        return ""
    expired = getattr(edge, "expired_at", None)
    return f"{fact} (no longer true)" if expired else fact
