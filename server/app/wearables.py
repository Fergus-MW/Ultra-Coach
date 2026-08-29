"""The runner's Fitbit, normalised.

Our own Open Wearables deployment holds the device data, already unified across
providers. We pull the last week of it, reduce each kind to a handful of spoken facts
and read those straight into the prompt at call time — a coach that has to call a tool
before it knows the runner ran yesterday will simply not bother.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx

from .config import get_settings
from .db import Database, database

log = logging.getLogger(__name__)

# A day is rewritten as more of it syncs, and a week-old resting heart rate is not what
# the coach should be shouting about.
FRESH_FOR = timedelta(days=8)
PROVIDER = "fitbit"


class WearableError(RuntimeError):
    pass


@dataclass
class Reading:
    """One kind of record — a day, a night, a run — as the coach would say it."""

    at: datetime
    provider: str
    text: str


@dataclass
class Snapshot:
    provider: str = ""
    readings: dict[str, Reading] = field(default_factory=dict)

    def as_block(self) -> str:
        fresh = _fresh(self.readings)
        if not fresh:
            return ""
        lines = "\n".join(f"- {reading.text}" for reading in fresh)
        source = f" ({self.provider})" if self.provider else ""
        return f"Wearable data{source}, straight off their device:\n{lines}"


class Wearable:
    """Device connections and the latest metrics behind them.

    Postgres owns both, but reads are served from memory: the snapshot is read on the
    path between a runner answering and the coach speaking, and a round trip to the
    database there is silence on the call.
    """

    def __init__(self, store: Database | None = None) -> None:
        self._db = store or database
        # Open Wearables user id -> our runner id. It mints its own user ids, so the
        # mapping is ours to keep and has to survive a redeploy.
        self._links: dict[str, str] = {}
        self._snapshots: dict[str, Snapshot] = {}

    @property
    def configured(self) -> bool:
        settings = get_settings()
        return bool(settings.wearables_url and settings.wearables_api_key)

    async def connect_url(self, runner_id: str, redirect_to: str) -> str:
        """Fitbit's own consent screen, opened in a new tab: no credentials of ours."""
        if not self.configured:
            raise WearableError("no wearables platform is configured")

        user_id = await self.ensure_user(runner_id)
        payload = await self._call(
            "GET",
            f"/api/v1/oauth/{PROVIDER}/authorize",
            params={"user_id": user_id, "redirect_uri": redirect_to},
        )
        url = str(payload.get("authorization_url") or "")
        if not url:
            raise WearableError("the wearables platform returned no authorization url")
        return url

    async def ensure_user(self, runner_id: str) -> str:
        """The runner as Open Wearables knows them, created once and remembered."""
        for user_id, runner in self._links.items():
            if runner == runner_id:
                return user_id
        created = await self._call("POST", "/api/v1/users", json={"first_name": "Runner"})
        user_id = str(created.get("id") or "")
        if not user_id:
            raise WearableError("the wearables platform created no user")
        await self.link(user_id, runner_id, PROVIDER)
        return user_id

    async def link(self, external_user_id: str, runner_id: str, provider: str = "") -> None:
        if not external_user_id or not runner_id:
            return
        known = self._links.get(external_user_id) == runner_id
        self._links[external_user_id] = runner_id
        if provider:
            self._snapshot(runner_id).provider = provider
        if known and not provider:
            return
        await self._write(
            """INSERT INTO wearable_links (external_user_id, runner_id, provider)
               VALUES ($1, $2, $3)
               ON CONFLICT (external_user_id)
               DO UPDATE SET runner_id = EXCLUDED.runner_id, provider = EXCLUDED.provider""",
            external_user_id,
            runner_id,
            provider,
        )

    async def unlink(self, external_user_id: str) -> str:
        runner_id = self._links.pop(external_user_id, "")
        self._snapshots.pop(runner_id, None)
        await self._write(
            "DELETE FROM wearable_links WHERE external_user_id = $1", external_user_id
        )
        if runner_id:
            await self._write("DELETE FROM wearable_readings WHERE runner_id = $1", runner_id)
        return runner_id

    def user_for(self, runner_id: str) -> str:
        return next((user for user, runner in self._links.items() if runner == runner_id), "")

    def connected(self, runner_id: str) -> bool:
        return runner_id in self._snapshots or runner_id in self._links.values()

    async def record(self, runner_id: str, kind: str, payload: dict) -> str:
        """Reduce one record to a line. Returns it, or "" if there was nothing."""
        text = _summarise(kind, payload)
        if not text:
            return ""

        snapshot = self._snapshot(runner_id)
        moment = _payload_time(payload)
        existing = snapshot.readings.get(kind)
        # The same day is rewritten all day long, and providers backfill out of order:
        # only a newer reading of the same kind should replace what the coach has.
        if existing and existing.at > moment:
            return ""
        provider = _provider(payload) or snapshot.provider
        snapshot.provider = provider
        snapshot.readings[kind] = Reading(at=moment, provider=provider, text=text)
        await self._write(
            """INSERT INTO wearable_readings (runner_id, kind, measured_at, provider, summary)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (runner_id, kind) DO UPDATE
               SET measured_at = EXCLUDED.measured_at,
                   provider = EXCLUDED.provider,
                   summary = EXCLUDED.summary
               WHERE wearable_readings.measured_at <= EXCLUDED.measured_at""",
            runner_id,
            kind,
            moment,
            provider,
            text,
        )
        return text

    def block(self, runner_id: str) -> str:
        snapshot = self._snapshots.get(runner_id)
        return snapshot.as_block() if snapshot else ""

    def spoken(self, runner_id: str) -> str:
        block = self.block(runner_id)
        if not block:
            return "No wearable connected, so there are no numbers to hide behind or to use."
        return block

    async def refresh(self, runner_id: str, days: int = 7) -> list[tuple[str, str]]:
        """Pull the last week: nothing is pushed to us, so this is where data arrives.

        Returns the (kind, fact) pairs that were new, for the graph to keep.
        """
        if not self.configured:
            return []
        user_id = self.user_for(runner_id)
        if not user_id:
            return []

        window = {
            "start_date": (date.today() - timedelta(days=days)).isoformat(),
            "end_date": date.today().isoformat(),
        }
        found: list[tuple[str, str]] = []
        for kind, path in (
            ("daily", f"/api/v1/users/{user_id}/summaries/activity"),
            ("sleep", f"/api/v1/users/{user_id}/summaries/sleep"),
            ("activity", f"/api/v1/users/{user_id}/events/workouts"),
        ):
            try:
                payload = await self._call("GET", path, params=window)
            except Exception as error:  # one dead endpoint must not lose the others
                log.warning("%s refresh failed for %s: %s", kind, runner_id, error)
                continue
            for record in payload.get("data") or []:
                if isinstance(record, dict) and (
                    fact := await self.record(runner_id, kind, record)
                ):
                    found.append((kind, fact))
        return found

    async def load(self) -> None:
        """Read the connections and the last readings back at startup."""
        if not self._db.ready:
            return
        async with self._db.pool.acquire() as connection:
            links = await connection.fetch(
                "SELECT external_user_id, runner_id, provider FROM wearable_links"
            )
            readings = await connection.fetch(
                """SELECT runner_id, kind, measured_at, provider, summary
                   FROM wearable_readings WHERE measured_at >= $1""",
                datetime.now(timezone.utc) - FRESH_FOR,
            )
        self._links = {row["external_user_id"]: row["runner_id"] for row in links}
        for row in links:
            if row["provider"]:
                self._snapshot(row["runner_id"]).provider = row["provider"]
        for row in readings:
            snapshot = self._snapshot(row["runner_id"])
            snapshot.readings[row["kind"]] = Reading(
                at=row["measured_at"], provider=row["provider"], text=row["summary"]
            )

    async def _call(self, method: str, path: str, **kwargs: Any) -> dict:
        base = get_settings().wearables_url.rstrip("/")
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.request(method, f"{base}{path}", headers=_headers(), **kwargs)
        if response.status_code >= 400:
            raise WearableError(f"the wearables platform refused: {response.text[:200]}")
        body = response.json()
        return body if isinstance(body, dict) else {"data": body}

    def _snapshot(self, runner_id: str) -> Snapshot:
        return self._snapshots.setdefault(runner_id, Snapshot())

    async def _write(self, statement: str, *args: Any) -> None:
        if not self._db.ready:
            return
        try:
            async with self._db.pool.acquire() as connection:
                await connection.execute(statement, *args)
        except Exception:  # a dropped connection must not lose the call
            log.exception("could not persist wearable data")


def _headers() -> dict[str, str]:
    return {
        "X-Open-Wearables-API-Key": get_settings().wearables_api_key,
        "Content-Type": "application/json",
    }


def _fresh(readings: dict[str, Reading]) -> list[Reading]:
    cutoff = datetime.now(timezone.utc) - FRESH_FOR
    return [reading for reading in readings.values() if reading.at >= cutoff]


def _provider(payload: dict) -> str:
    source = payload.get("source") or {}
    return str(source.get("provider") or "").title()


def _payload_time(payload: dict) -> datetime:
    for key in ("end_time", "start_time"):
        moment = _time(payload.get(key))
        if moment:
            return moment
    day = _time(payload.get("date"))
    # A daily summary is dated, not timed, and the coach only cares which day it was.
    return day or datetime.now(timezone.utc)


def _time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _summarise(kind: str, payload: dict) -> str:
    if kind == "daily":
        return _daily(payload)
    if kind == "sleep":
        return _sleep(payload)
    if kind == "activity":
        return _activity(payload)
    return ""


def _daily(payload: dict) -> str:
    heart = payload.get("heart_rate") or {}
    parts = []
    steps = _number(payload.get("steps"))
    if steps:
        parts.append(f"{steps:,.0f} steps")
    resting = _number(heart.get("resting_bpm"))
    if resting:
        parts.append(f"resting heart rate {resting:.0f} bpm")
    active = _number(payload.get("active_calories_kcal"))
    if active:
        parts.append(f"{active:,.0f} active calories")
    minutes = _number(payload.get("active_minutes"))
    if minutes:
        parts.append(f"{minutes:.0f} active minutes")
    if not parts:
        return ""
    return f"{_day(payload)}: " + ", ".join(parts) + "."


def _sleep(payload: dict) -> str:
    parts = []
    asleep = _number(payload.get("duration_minutes"))
    if asleep:
        parts.append(f"{_hours(asleep * 60)} asleep")
    efficiency = _number(payload.get("efficiency_percent"))
    if efficiency:
        parts.append(f"{_percent(efficiency):.0f}% efficiency")
    hrv = _number(payload.get("avg_hrv_rmssd_ms")) or _number(payload.get("avg_hrv_sdnn_ms"))
    if hrv:
        parts.append(f"HRV {hrv:.0f} ms")
    average = _number(payload.get("avg_heart_rate_bpm"))
    if average:
        parts.append(f"lowest heart rate {average:.0f} bpm")
    if not parts:
        return ""
    return f"Night of {_day(payload)}: " + ", ".join(parts) + "."


def _activity(payload: dict) -> str:
    metres = _number(payload.get("distance_meters"))
    seconds = _number(payload.get("duration_seconds"))
    kind = (
        str(payload.get("name") or payload.get("type") or "").strip().replace("_", " ").capitalize()
    )

    parts = []
    if metres:
        parts.append(f"{metres / 1000:.1f} km")
    if seconds:
        parts.append(_hours(seconds))
    if metres and seconds:
        parts.append(f"{_pace(metres, seconds)} per km")
    average = _number(payload.get("avg_heart_rate_bpm"))
    if average:
        parts.append(f"average heart rate {average:.0f} bpm")
    if not parts:
        return ""
    return f"{kind or 'Session'} on {_day(payload)}: " + ", ".join(parts) + "."


def _day(payload: dict) -> str:
    moment = _payload_time(payload)
    today = datetime.now(timezone.utc).date()
    days = (today - moment.date()).days
    if days <= 0:
        return "today"
    if days == 1:
        return "yesterday"
    if days < 7:
        return f"{days} days ago"
    return moment.date().isoformat()


def _number(value: Any) -> float:
    return float(value) if isinstance(value, (int, float)) and value else 0.0


def _percent(value: float) -> float:
    """Providers disagree on whether efficiency is 0.92 or 92."""
    return value * 100 if value <= 1 else value


def _hours(seconds: float) -> str:
    minutes = round(seconds / 60)
    if minutes < 60:
        return f"{minutes} minutes"
    return f"{minutes // 60}h {minutes % 60:02d}m"


def _pace(metres: float, seconds: float) -> str:
    per_km = seconds / (metres / 1000)
    return f"{int(per_km // 60)}:{int(per_km % 60):02d}"


wearable = Wearable()
