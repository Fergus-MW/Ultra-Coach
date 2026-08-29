"""What time it is where the runner is.

A coach that orders a 5 a.m. session has to know whether 5 a.m. is in seven hours or
has already been missed, and a fact from the graph means nothing without its age. The
model has no clock of its own, so every prompt carries one, in the runner's own zone
rather than the server's.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .db import database

log = logging.getLogger(__name__)

UTC = ZoneInfo("UTC")


class Clocks:
    """The zone each runner's device reported, kept so a call can be timed without it."""

    def __init__(self) -> None:
        self._zones: dict[str, str] = {}

    async def remember(self, runner_id: str, name: str) -> None:
        """Take the device's IANA zone. A name we cannot resolve is not stored."""
        name = name.strip()
        if not name or self._zones.get(runner_id) == name or _zone(name) is None:
            return
        self._zones[runner_id] = name
        if not database.ready:
            return
        async with database.pool.acquire() as connection:
            await connection.execute(
                """INSERT INTO runner_zones (runner_id, zone) VALUES ($1, $2)
                   ON CONFLICT (runner_id) DO UPDATE SET zone = EXCLUDED.zone""",
                runner_id,
                name,
            )

    def zone_of(self, runner_id: str) -> ZoneInfo:
        return _zone(self._zones.get(runner_id, "")) or UTC

    def now_line(self, runner_id: str) -> str:
        """One line of ground truth for the top of the prompt."""
        here = datetime.now(self.zone_of(runner_id))
        stamp = here.strftime("%A %d %B %Y, %H:%M")
        return f"Right now it is {stamp} ({here.tzname()}), the runner's local time."

    async def load(self) -> None:
        if not database.ready:
            return
        async with database.pool.acquire() as connection:
            rows = await connection.fetch("SELECT runner_id, zone FROM runner_zones")
        self._zones = {row["runner_id"]: row["zone"] for row in rows}


def _zone(name: str) -> ZoneInfo | None:
    if not name:
        return None
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        log.warning("unknown timezone %r", name[:64])
        return None


def ago(moment: datetime | None) -> str:
    """How long ago, in the words a coach would use. "" when there is no timestamp."""
    if moment is None:
        return ""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    seconds = (datetime.now(timezone.utc) - moment).total_seconds()
    if seconds < 0:
        return ""
    hours = seconds / 3600
    if hours < 1:
        return "in the last hour"
    if hours < 24:
        return f"{int(hours)}h ago"
    days = int(hours // 24)
    if days == 1:
        return "yesterday"
    if days < 14:
        return f"{days} days ago"
    return f"{days // 7} weeks ago"


clocks = Clocks()
