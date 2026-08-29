"""The runner's Fitbit, normalised.

Our own Open Wearables deployment holds the device data, already unified across
providers. We pull the last week of it, reduce each kind to a handful of spoken facts
and read those straight into the prompt at call time — a coach that has to call a tool
before it knows the runner ran yesterday will simply not bother.
"""

from __future__ import annotations

import asyncio
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


class WearableError(RuntimeError):
    pass


@dataclass
class Reading:
    """One kind of record — a day, a night, a run — as the coach would say it."""

    at: datetime
    provider: str
    text: str


@dataclass
class Measured:
    """The same record as numbers, for the screen rather than the prompt."""

    at: datetime
    values: dict[str, Any]


@dataclass
class Snapshot:
    provider: str = ""
    connected: bool = False
    readings: dict[str, Reading] = field(default_factory=dict)
    # Latest of each kind only: the panel shows today, last night and the last session,
    # not a week of history the runner has to scroll.
    measured: dict[str, Measured] = field(default_factory=dict)

    def as_panel(self) -> dict[str, Any]:
        cutoff = datetime.now(timezone.utc) - FRESH_FOR
        panel: dict[str, Any] = {"provider": self.provider}
        for kind, measured in self.measured.items():
            if measured.at >= cutoff and measured.values:
                panel[kind] = {"at": measured.at.isoformat(), **measured.values}
        return panel

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
        self._minting: dict[str, asyncio.Lock] = {}
        # Runners whose backfill has already been asked for, so a poll every few seconds
        # does not queue ninety days of history over and over.
        self._backfilled: set[str] = set()

    @property
    def configured(self) -> bool:
        settings = get_settings()
        return bool(settings.wearables_url and settings.wearables_api_key)

    async def connect_url(self, runner_id: str, redirect_to: str) -> str:
        """Fitbit's own consent screen, opened in a new tab: no credentials of ours."""
        if not self.configured:
            raise WearableError("no wearables platform is configured")

        settings = get_settings()
        user_id = await self.ensure_user(runner_id)
        payload = await self._call(
            "GET",
            f"/api/v1/oauth/{settings.wearables_provider}/authorize",
            params={"user_id": user_id, "redirect_uri": redirect_to},
        )
        url = str(payload.get("authorization_url") or "")
        if not url:
            raise WearableError("the wearables platform returned no authorization url")
        return url

    async def ensure_user(self, runner_id: str) -> str:
        """The runner as Open Wearables knows them, created once and remembered.

        Two tabs tapping connect together would otherwise mint two platform accounts and
        leave the runner's data behind whichever one lost.
        """
        known = self.user_for(runner_id)
        if known:
            return known
        async with self._minting.setdefault(runner_id, asyncio.Lock()):
            known = self.user_for(runner_id)
            if known:
                return known
            created = await self._call("POST", "/api/v1/users", json={"first_name": "Runner"})
            user_id = str(created.get("id") or "")
            if not user_id:
                raise WearableError("the wearables platform created no user")
            return await self.link(user_id, runner_id, get_settings().wearables_provider)

    async def link(
        self,
        external_user_id: str,
        runner_id: str,
        provider: str = "",
        confirmed: bool = False,
    ) -> str:
        """Claim this platform account for the runner, and say which one won the claim.

        The database decides, not this process: another instance may already hold an
        account for the runner, and its one is the one with the device attached.
        """
        if not external_user_id or not runner_id:
            return ""
        held = await self._claim(external_user_id, runner_id, provider, confirmed)
        self._links[held] = runner_id
        snapshot = self._snapshot(runner_id)
        if provider:
            snapshot.provider = provider
        snapshot.connected = snapshot.connected or confirmed
        return held

    async def _claim(
        self, external_user_id: str, runner_id: str, provider: str, confirmed: bool
    ) -> str:
        if not self._db.ready:
            return self.user_for(runner_id) or external_user_id
        try:
            async with self._db.pool.acquire() as connection:
                held = await connection.fetchval(
                    """INSERT INTO wearable_links (external_user_id, runner_id, provider, confirmed)
                       VALUES ($1, $2, $3, $4)
                       ON CONFLICT (runner_id) DO UPDATE
                       SET provider = CASE WHEN $3 = '' THEN wearable_links.provider ELSE $3 END,
                           confirmed = wearable_links.confirmed OR $4
                       RETURNING external_user_id""",
                    external_user_id,
                    runner_id,
                    provider,
                    confirmed,
                )
        except Exception:
            log.exception("could not claim a wearable account for %s", runner_id)
            return self.user_for(runner_id) or external_user_id
        return str(held or external_user_id)

    async def disconnect(self, runner_id: str) -> None:
        """Hand the consent back so the runner can grant it again.

        The platform account stays, so a reconnection lands on the same history, but the
        authorisation and every reading go: a coach quoting last month's sleep at a
        runner who has just unplugged their watch is worse than one with no numbers.
        """
        user_id = self.user_for(runner_id)
        if not user_id:
            return
        provider = get_settings().wearables_provider
        # Consent already withdrawn from Google's own settings is a disconnection that
        # has happened; a platform that is down or refusing is not, and saying otherwise
        # would leave the runner's data flowing behind a screen that says it stopped.
        await self._call(
            "DELETE", f"/api/v1/users/{user_id}/connections/{provider}", absent_ok=True
        )
        snapshot = self._snapshot(runner_id)
        snapshot.connected = False
        snapshot.readings.clear()
        snapshot.measured.clear()
        # Reconnecting is a fresh watch as far as we are concerned: ask for the history
        # again rather than trusting the backfill this consent never had.
        self._backfilled.discard(runner_id)
        await self._write(
            "UPDATE wearable_links SET confirmed = FALSE WHERE runner_id = $1", runner_id
        )
        await self._write("DELETE FROM wearable_readings WHERE runner_id = $1", runner_id)

    async def unlink(self, external_user_id: str) -> str:
        runner_id = self._links.pop(external_user_id, "")
        self._snapshots.pop(runner_id, None)
        self._minting.pop(runner_id, None)
        await self._write(
            "DELETE FROM wearable_links WHERE external_user_id = $1", external_user_id
        )
        if runner_id:
            await self._write("DELETE FROM wearable_readings WHERE runner_id = $1", runner_id)
        return runner_id

    def user_for(self, runner_id: str) -> str:
        return next((user for user, runner in self._links.items() if runner == runner_id), "")

    def connected(self, runner_id: str) -> bool:
        """Only a live authorisation counts. Cancelled consent, or consent revoked from
        the watch's own settings, is not a connection however much history we hold."""
        snapshot = self._snapshots.get(runner_id)
        return bool(snapshot and snapshot.connected)

    async def check_connection(self, runner_id: str) -> bool:
        """Ask the platform whether consent is actually in force, either way."""
        user_id = self.user_for(runner_id)
        if not user_id:
            return False
        payload = await self._call("GET", f"/api/v1/users/{user_id}/connections")
        wanted = get_settings().wearables_provider
        live = next(
            (
                connection
                for connection in payload.get("data") or []
                if isinstance(connection, dict)
                and connection.get("status") == "active"
                and str(connection.get("provider") or "") == wanted
            ),
            None,
        )
        if live is None:
            await self._revoke(runner_id)
            return False
        await self.link(user_id, runner_id, wanted, confirmed=True)
        return True

    async def _revoke(self, runner_id: str) -> None:
        """Consent is gone: the readings stay for context, the connection does not."""
        snapshot = self._snapshots.get(runner_id)
        if snapshot is None or not snapshot.connected:
            return
        snapshot.connected = False
        await self._write(
            "UPDATE wearable_links SET confirmed = FALSE WHERE runner_id = $1", runner_id
        )

    async def record(self, runner_id: str, kind: str, payload: dict) -> str:
        """Reduce one record to a line. Returns it, or "" if there was nothing."""
        text = _summarise(kind, payload)
        if not text:
            return ""

        snapshot = self._snapshot(runner_id)
        moment = _payload_time(payload)
        provider = _provider(payload) or snapshot.provider
        snapshot.provider = provider
        # Numbers are kept whether or not the line is news: a redeploy loses them (only
        # the spoken summaries are persisted) and they are refilled by the next pull,
        # which finds every record unchanged.
        self._measure(snapshot, kind, moment, payload)
        # Each day, night and workout is its own reading: keyed by kind alone, a week's
        # training would collapse into whichever run was pulled last.
        key = _key(kind, moment)
        existing = snapshot.readings.get(key)
        # The same day is rewritten all day long and providers backfill out of order, so
        # only a newer reading replaces what the coach has — and a poll that brings back
        # a record it already holds is not news to repeat into the graph.
        if existing and (existing.at > moment or existing.text == text):
            return ""
        snapshot.readings[key] = Reading(at=moment, provider=provider, text=text)
        await self._write(
            """INSERT INTO wearable_readings (runner_id, kind, measured_at, provider, summary)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (runner_id, kind) DO UPDATE
               SET measured_at = EXCLUDED.measured_at,
                   provider = EXCLUDED.provider,
                   summary = EXCLUDED.summary
               WHERE wearable_readings.measured_at <= EXCLUDED.measured_at""",
            runner_id,
            key,
            moment,
            provider,
            text,
        )
        return text

    def _measure(self, snapshot: Snapshot, kind: str, moment: datetime, payload: dict) -> None:
        values = _measure(kind, payload)
        if not values:
            return
        held = snapshot.measured.get(kind)
        if held and held.at > moment:
            return
        snapshot.measured[kind] = Measured(at=moment, values=values)

    def block(self, runner_id: str) -> str:
        snapshot = self._snapshots.get(runner_id)
        return snapshot.as_block() if snapshot else ""

    def panel(self, runner_id: str) -> dict[str, Any]:
        """The same readings as numbers, for the runner's own screen."""
        snapshot = self._snapshots.get(runner_id)
        return snapshot.as_panel() if snapshot else {}

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
        if not user_id or not await self.check_connection(runner_id):
            return []

        # Nothing arrives on its own: the platform pulls from Google on its own
        # schedule, and a runner who has just given consent would otherwise stare at an
        # empty watch until the next sweep came round. The first ask is for the whole
        # history, because a fresh connection holds nothing at all.
        wanted = runner_id not in self._backfilled
        if await self._sync(user_id, historical=wanted) and wanted:
            self._backfilled.add(runner_id)

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

    async def _sync(self, user_id: str, historical: bool) -> bool:
        """Ask the platform to pull from the provider now. It answers before it has.

        The work is queued on their side, so this call brings back nothing itself; it is
        the poll after it that sees the data. False means the ask never landed, so a
        backfill refused once is asked for again rather than written off as done.
        """
        provider = get_settings().wearables_provider
        path = f"/api/v1/providers/{provider}/users/{user_id}/sync"
        try:
            await self._call("POST", f"{path}/historical" if historical else path)
        except Exception as error:  # a platform that will not sync still has a week held
            log.warning("could not ask %s to sync %s: %s", provider, user_id, error)
            return False
        return True

    async def load(self) -> None:
        """Read the connections and the last readings back at startup."""
        if not self._db.ready:
            return
        async with self._db.pool.acquire() as connection:
            links = await connection.fetch(
                "SELECT external_user_id, runner_id, provider, confirmed FROM wearable_links"
            )
            readings = await connection.fetch(
                """SELECT runner_id, kind, measured_at, provider, summary
                   FROM wearable_readings WHERE measured_at >= $1""",
                datetime.now(timezone.utc) - FRESH_FOR,
            )
        self._links = {row["external_user_id"]: row["runner_id"] for row in links}
        for row in links:
            snapshot = self._snapshot(row["runner_id"])
            snapshot.connected = bool(row["confirmed"])
            if row["provider"]:
                snapshot.provider = row["provider"]
        for row in readings:
            snapshot = self._snapshot(row["runner_id"])
            snapshot.readings[row["kind"]] = Reading(
                at=row["measured_at"], provider=row["provider"], text=row["summary"]
            )

    async def _call(self, method: str, path: str, absent_ok: bool = False, **kwargs: Any) -> dict:
        base = get_settings().wearables_url.rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.request(
                    method, f"{base}{path}", headers=_headers(), **kwargs
                )
        except httpx.HTTPError as error:
            raise WearableError(f"the wearables platform is unreachable: {error}") from error
        if response.status_code == 404 and absent_ok:
            return {}
        if response.status_code >= 400:
            raise WearableError(f"the wearables platform refused: {response.text[:200]}")
        if not response.content:
            return {}
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


def _key(kind: str, moment: datetime) -> str:
    """A day and a night are one a day; workouts are one each."""
    when = moment.isoformat() if kind == "activity" else moment.date().isoformat()
    return f"{kind}:{when}"


def _fresh(readings: dict[str, Reading]) -> list[Reading]:
    cutoff = datetime.now(timezone.utc) - FRESH_FOR
    recent = sorted(
        (reading for reading in readings.values() if reading.at >= cutoff),
        key=lambda reading: reading.at,
        reverse=True,
    )
    # A fortnight of lines read into every call would bury the numbers that matter.
    return recent[:12]


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


def _measure(kind: str, payload: dict) -> dict[str, Any]:
    """The numbers behind one record, absent keys left out rather than sent as zero."""
    if kind == "daily":
        heart = payload.get("heart_rate") or {}
        found = {
            "steps": _number(payload.get("steps")),
            "resting_bpm": _number(heart.get("resting_bpm")),
            "active_calories": _number(payload.get("active_calories_kcal")),
            "active_minutes": _number(payload.get("active_minutes")),
        }
    elif kind == "sleep":
        hrv = _number(payload.get("avg_hrv_rmssd_ms")) or _number(payload.get("avg_hrv_sdnn_ms"))
        found = {
            "asleep_minutes": _number(payload.get("duration_minutes")),
            "efficiency_percent": _percent(_number(payload.get("efficiency_percent"))),
            "hrv_ms": hrv,
            "avg_bpm": _number(payload.get("avg_heart_rate_bpm")),
        }
    elif kind == "activity":
        metres = _number(payload.get("distance_meters"))
        seconds = _number(payload.get("duration_seconds"))
        found = {
            "km": round(metres / 1000, 2) if metres else 0.0,
            "minutes": round(seconds / 60) if seconds else 0.0,
            "avg_bpm": _number(payload.get("avg_heart_rate_bpm")),
        }
        if metres and seconds:
            found["pace_per_km"] = _pace(metres, seconds)
        name = str(payload.get("name") or payload.get("type") or "").strip().replace("_", " ")
        if name:
            found["name"] = name.capitalize()
    else:
        return {}
    return {key: value for key, value in found.items() if value}


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
        parts.append(f"average heart rate {average:.0f} bpm")
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
