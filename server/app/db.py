"""Postgres, and the schema the coach needs to remember anything between restarts.

Zep holds the conversation; this holds the facts that have to be exact — when each
runner was last rung, whose device account is whose, and the last numbers off their
watch. Render's disk is ephemeral, so anything kept in a file is a call the coach
makes twice and a Fitbit connection the runner has to make again.
"""

from __future__ import annotations

import logging

import asyncpg

from .config import get_settings

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS calls (
    user_id     TEXT PRIMARY KEY,
    last_call   TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS wearable_links (
    external_user_id TEXT PRIMARY KEY,
    runner_id     TEXT NOT NULL,
    provider      TEXT NOT NULL DEFAULT '',
    confirmed     BOOLEAN NOT NULL DEFAULT FALSE
);

ALTER TABLE wearable_links ADD COLUMN IF NOT EXISTS confirmed BOOLEAN NOT NULL DEFAULT FALSE;

-- One platform account per runner, enforced here rather than in the process: two tabs
-- tapping connect at once would otherwise leave a second, unauthorised account holding
-- the runner's data.
DROP INDEX IF EXISTS wearable_links_runner;
CREATE UNIQUE INDEX IF NOT EXISTS wearable_links_one_per_runner ON wearable_links (runner_id);

-- Registration burns a paid Zep user, and the limit has to hold across every worker
-- and every restart, so the allowance lives here rather than in one process's memory.
CREATE TABLE IF NOT EXISTS register_hits (
    caller TEXT PRIMARY KEY,
    tokens DOUBLE PRECISION NOT NULL,
    seen   TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS wearable_readings (
    runner_id   TEXT NOT NULL,
    kind        TEXT NOT NULL,
    measured_at TIMESTAMPTZ NOT NULL,
    provider    TEXT NOT NULL DEFAULT '',
    summary     TEXT NOT NULL,
    PRIMARY KEY (runner_id, kind)
);
"""


class Database:
    """One pool for the process, opened at startup and shared.

    Without DATABASE_URL it stays closed and every caller falls back to memory: a
    local run should not need a server, and a missing database must not silence the
    coach mid-call.
    """

    def __init__(self) -> None:
        self._pool: asyncpg.Pool | None = None

    @property
    def ready(self) -> bool:
        return self._pool is not None

    @property
    def pool(self) -> asyncpg.Pool:
        if self._pool is None:
            raise RuntimeError("database is not connected")
        return self._pool

    async def connect(self, dsn: str = "") -> bool:
        dsn = dsn or get_settings().database_url
        if not dsn or self._pool is not None:
            return self._pool is not None
        pool = None
        try:
            pool = await asyncpg.create_pool(dsn, min_size=1, max_size=5, timeout=10)
            async with pool.acquire() as connection:
                await connection.execute(SCHEMA)
        except Exception:
            # A database that will not open is worth a loud log and a degraded coach,
            # not a backend that refuses to boot and takes the calls down with it.
            log.exception("could not open the database; falling back to memory")
            if pool is not None:
                await pool.close()
            return False
        self._pool = pool
        return True

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None


database = Database()
