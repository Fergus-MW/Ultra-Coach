"""The part that makes the coach proactive: it decides when to ring, not the runner."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from .config import get_settings
from .grok import opening_line
from .memory import Memory
from .ws import Ringer

log = logging.getLogger(__name__)

MIN_HOURS_BETWEEN_CALLS = 20


@dataclass
class CallOutcome:
    user_id: str
    rang: bool
    reason: str
    opening_line: str = ""
    delivered: int = 0


class Coach:
    """Ring runners who are online and overdue a reckoning."""

    def __init__(self, memory: Memory, ringer: Ringer) -> None:
        self._memory = memory
        self._ringer = ringer
        self._last_call: dict[str, datetime] = {}
        self._scheduler = AsyncIOScheduler(timezone="UTC")

    def start(self) -> None:
        settings = get_settings()
        if not settings.scheduler_enabled:
            return
        self._scheduler.add_job(
            self.sweep,
            CronTrigger(hour=settings.checkin_hour_utc, minute=0),
            id="daily-checkin",
            replace_existing=True,
        )
        self._scheduler.add_job(
            self.sweep_online,
            CronTrigger(minute="*/15"),
            id="catch-them-online",
            replace_existing=True,
        )
        self._scheduler.start()

    def shutdown(self) -> None:
        if self._scheduler.running:
            self._scheduler.shutdown(wait=False)

    async def sweep(self) -> list[CallOutcome]:
        return [await self.call(user_id) for user_id in await self._memory.list_runners()]

    async def sweep_online(self) -> list[CallOutcome]:
        """A missed daily check-in is chased as soon as the runner opens the app."""
        runners = [
            user_id
            for user_id in await self._memory.list_runners()
            if self._ringer.is_online(user_id)
        ]
        return [await self.call(user_id) for user_id in runners]

    async def call(self, user_id: str, *, force: bool = False) -> CallOutcome:
        if not force and not self._ringer.is_online(user_id):
            return CallOutcome(user_id, False, "runner is not reachable")

        if not force and self._called_recently(user_id):
            return CallOutcome(user_id, False, "already called within the cooldown")

        state = await self._memory.get_state(user_id)
        line = await opening_line(state)
        reason = state.commitments[0] if state.commitments else "routine check-in"
        delivered = await self._ringer.ring(user_id, line, reason)
        if delivered:
            self._last_call[user_id] = datetime.now(timezone.utc)
            await self._memory.record_event(
                user_id, "proactive_call_placed", {"reason": reason, "opening_line": line}
            )
        return CallOutcome(user_id, bool(delivered), reason, line, delivered)

    def _called_recently(self, user_id: str) -> bool:
        last = self._last_call.get(user_id)
        if last is None:
            return False
        return datetime.now(timezone.utc) - last < timedelta(hours=MIN_HOURS_BETWEEN_CALLS)
