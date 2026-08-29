"""The part that makes the coach proactive: it decides when to ring, not the runner."""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

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


class CallLog:
    """When each runner was last rung, kept on disk so a restart is not a free call."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._times: dict[str, datetime] = {}
        self._load()

    def last_call(self, user_id: str) -> datetime | None:
        return self._times.get(user_id)

    def record(self, user_id: str, moment: datetime) -> None:
        self._times[user_id] = moment
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.touch(mode=0o600, exist_ok=True)
            # Who was coached and when is the runner's business, not every account's
            # on the host, so the file stays owner-only whatever the umask says.
            self._path.chmod(0o600)
            self._path.write_text(
                json.dumps({key: value.isoformat() for key, value in self._times.items()})
            )
        except OSError as error:  # a read-only disk must not stop the call
            log.warning("could not persist call log: %s", error)

    def _load(self) -> None:
        try:
            raw = json.loads(self._path.read_text())
        except (OSError, ValueError):
            return
        for user_id, stamp in raw.items():
            try:
                self._times[user_id] = datetime.fromisoformat(stamp)
            except ValueError:
                continue


class Coach:
    """Ring runners who are online and overdue a reckoning."""

    def __init__(self, memory: Memory, ringer: Ringer, log_path: Path | None = None) -> None:
        self._memory = memory
        self._ringer = ringer
        self._calls = CallLog(log_path or Path(get_settings().state_file))
        self._scheduler = AsyncIOScheduler(timezone="UTC")
        self._admission = asyncio.Lock()
        self._ringing: set[str] = set()

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
        return await self._call_each(await self._memory.list_runners())

    async def sweep_online(self) -> list[CallOutcome]:
        """Chase a check-in the runner was already due, as soon as they open the app."""
        return await self._call_each(
            [
                user_id
                for user_id in await self._memory.list_runners()
                if self._ringer.is_online(user_id) and self._checkin_missed(user_id)
            ]
        )

    async def _call_each(self, runners: list[str]) -> list[CallOutcome]:
        """One runner's failure must not cost everyone behind them their check-in."""
        outcomes = []
        for user_id in runners:
            try:
                outcomes.append(await self.call(user_id))
            except Exception:
                log.exception("call failed for %s", user_id)
                outcomes.append(CallOutcome(user_id, False, "call failed"))
        return outcomes

    async def call(self, user_id: str, *, force: bool = False) -> CallOutcome:
        # The daily and the every-15-minutes sweep overlap whenever the check-in hour
        # lands on a quarter hour, so admission has to be decided one runner at a time.
        async with self._admission:
            if not force and not self._ringer.is_online(user_id):
                return CallOutcome(user_id, False, "runner is not reachable")
            if user_id in self._ringing:
                return CallOutcome(user_id, False, "a call is already being placed")
            if not force and self._called_recently(user_id):
                return CallOutcome(user_id, False, "already called within the cooldown")
            self._ringing.add(user_id)

        try:
            state = await self._memory.get_state(user_id)
            line = await opening_line(state)
            reason = state.commitments[0] if state.commitments else "routine check-in"
            delivered = await self._ringer.ring(user_id, line, reason)
            if delivered:
                self._calls.record(user_id, datetime.now(timezone.utc))
                await self._memory.record_event(
                    user_id, "proactive_call_placed", {"reason": reason, "opening_line": line}
                )
            return CallOutcome(user_id, bool(delivered), reason, line, delivered)
        finally:
            self._ringing.discard(user_id)

    def _called_recently(self, user_id: str) -> bool:
        last = self._calls.last_call(user_id)
        if last is None:
            return False
        return datetime.now(timezone.utc) - last < timedelta(hours=MIN_HOURS_BETWEEN_CALLS)

    def _checkin_missed(self, user_id: str) -> bool:
        """True once today's check-in hour has passed with no call since it came round."""
        now = datetime.now(timezone.utc)
        due = datetime.combine(
            date(now.year, now.month, now.day),
            datetime.min.time(),
            tzinfo=timezone.utc,
        ) + timedelta(hours=get_settings().checkin_hour_utc)
        if now < due:
            return False

        last = self._calls.last_call(user_id)
        return last is None or last < due
