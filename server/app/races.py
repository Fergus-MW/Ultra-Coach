"""Tavily-backed ultra race discovery, exposed to the agent as a server tool."""

from __future__ import annotations

import logging

import httpx
from pydantic import BaseModel

from .config import get_settings

TAVILY_API = "https://api.tavily.com/search"
DISTANCES = ("50K", "50 mile", "100K", "100 mile")

log = logging.getLogger(__name__)


class Race(BaseModel):
    name: str
    url: str
    summary: str


class RaceSearchError(RuntimeError):
    pass


async def search_races(
    location: str,
    distance: str = "",
    months_ahead: int = 9,
    limit: int = 5,
) -> list[Race]:
    """Find real ultras the runner can still enter."""
    settings = get_settings()
    if not settings.tavily_api_key:
        raise RaceSearchError("Tavily is not configured")

    distances = distance or " or ".join(DISTANCES)
    query = (
        f"ultramarathon races near {location} in the next {months_ahead} months, "
        f"{distances}, with entries still open — include entry page, date, "
        "distance, elevation gain and cutoff times"
    )

    # Everything Tavily can do to us becomes RaceSearchError, so the tool route answers
    # the agent with a 502 it can talk about instead of an unhandled 500.
    try:
        async with httpx.AsyncClient(timeout=25) as client:
            response = await client.post(
                TAVILY_API,
                headers={"Authorization": f"Bearer {settings.tavily_api_key}"},
                json={
                    "query": query,
                    "search_depth": "advanced",
                    "max_results": limit,
                    "include_answer": False,
                },
            )
    except httpx.HTTPError as error:
        raise RaceSearchError(f"Tavily unreachable: {error}") from error

    if response.status_code >= 400:
        raise RaceSearchError(f"Tavily {response.status_code}: {response.text[:200]}")

    try:
        results = response.json().get("results", [])
    except ValueError as error:
        raise RaceSearchError(f"Tavily returned {response.text[:120]!r}") from error
    return [
        Race(
            name=item.get("title", "").strip(),
            url=item.get("url", ""),
            summary=" ".join(item.get("content", "").split())[:400],
        )
        for item in results
        if item.get("url")
    ]


def spoken_summary(races: list[Race]) -> str:
    """Tavily results as something an agent can read aloud without sounding like a webpage."""
    if not races:
        return "Nothing came back. Ask the runner for a wider search area."
    lines = [f"{index}. {race.name}. {race.summary}" for index, race in enumerate(races, start=1)]
    return "\n".join(lines)
