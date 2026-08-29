"""Zep temporal knowledge graph: every call, commitment and missed run lives here."""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from zep_cloud import EntityEdge, Message
from zep_cloud.client import AsyncZep
from zep_cloud.errors import BadRequestError, NotFoundError

from .config import get_settings
from .wearables import wearable

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
    wearable: str = ""

    def as_prompt_block(self) -> str:
        commitments = "\n".join(f"- {item}" for item in self.commitments)
        parts = [self.wearable.strip(), self.context.strip(), commitments.strip()]
        block = "\n\n".join(part for part in parts if part)
        return block or "No history yet. This is the first contact with this runner."


class Memory:
    def __init__(self, client: AsyncZep | None = None) -> None:
        settings = get_settings()
        self._client = client or AsyncZep(api_key=settings.zep_api_key)
        self._ingesting: dict[str, tuple[asyncio.Lock, int]] = {}

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
        # Retries of one delivery can arrive while the first is still adding messages,
        # and both would then see an empty thread and write the call in twice.
        lock, waiting = self._ingesting.get(conversation_id, (asyncio.Lock(), 0))
        self._ingesting[conversation_id] = (lock, waiting + 1)
        try:
            async with lock:
                await self._ingest(thread_id, conversation_id, user_id, turns)
        finally:
            # Dropping the lock while another delivery still holds or awaits it would
            # hand the retry a fresh lock and let both write the same call.
            held, count = self._ingesting[conversation_id]
            if count == 1:
                del self._ingesting[conversation_id]
            else:
                self._ingesting[conversation_id] = (held, count - 1)

    async def _ingest(
        self,
        thread_id: str,
        conversation_id: str,
        user_id: str,
        turns: list[tuple[str, str]],
    ) -> None:
        try:
            await self._client.thread.create(thread_id=thread_id, user_id=user_id)
        except BadRequestError:
            # The thread exists, so this is a webhook retry. Re-adding the turns would
            # double the call in the runner's history, unless the first attempt died
            # between creating the thread and filling it.
            if await self._has_messages(thread_id):
                log.info("ignoring duplicate transcript for %s", conversation_id)
                return

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
        """The runner's history, gathered in parallel.

        Mid-call this sits between the runner finishing a sentence and the coach starting
        one, so the graph searches run together: done one after another they added enough
        silence for ElevenLabs to abandon the turn.
        """
        await self.ensure_user(user_id)
        searches = [
            self._client.graph.search(user_id=user_id, query=query, scope="edges", limit=5)
            for query in COMMITMENT_QUERIES
        ]
        context_task = self._context(user_id)
        context, *found = await asyncio.gather(context_task, *searches, return_exceptions=True)

        commitments: list[str] = []
        for results in found:
            if isinstance(results, BaseException):
                log.warning("a commitment search failed for %s: %s", user_id, results)
                continue
            for edge in results.edges or []:
                fact = _format_edge(edge)
                if fact and fact not in commitments:
                    commitments.append(fact)

        if isinstance(context, BaseException):
            log.warning("could not read the thread context for %s: %s", user_id, context)
            context = ""
        # Read, not fetched: the numbers arrive by webhook as the watch syncs, so the
        # coach opens the call already knowing last night's sleep and yesterday's run.
        return RunnerState(
            user_id=user_id,
            context=context,
            commitments=commitments,
            wearable=wearable.block(user_id),
        )

    async def _context(self, user_id: str) -> str:
        latest = _latest_thread_id(await self._client.user.get_threads(user_id))
        if not latest:
            return ""
        response = await self._client.thread.get_user_context(latest)
        return response.context or ""

    async def list_runners(self) -> list[str]:
        """Every runner, not just the first page: the sweep must not silently drop anyone."""
        page_size = 100
        runners: list[str] = []
        for page_number in range(1, 1000):
            response = await self._client.user.list_ordered(
                page_size=page_size, page_number=page_number
            )
            users = response.users or []
            runners.extend(user.user_id for user in users if user.user_id)
            if len(users) < page_size:
                break
        return runners

    async def _has_messages(self, thread_id: str) -> bool:
        try:
            response = await self._client.thread.get(thread_id)
        except NotFoundError:
            return False
        return bool(response.messages)


def _latest_thread_id(threads: list) -> str | None:
    if not threads:
        return None
    newest = max(threads, key=lambda thread: thread.created_at or "")
    return newest.thread_id


def _format_edge(edge: EntityEdge) -> str:
    """Expired facts are dropped: the coach must not chase a settled commitment."""
    if edge.expired_at:
        return ""
    return edge.fact or ""
