from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from hmac import compare_digest
from time import monotonic

import httpx
from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .auth import bearer, issue_identity, sign, verify, verify_webhook
from .clock import clocks
from .config import Settings, get_settings
from .db import database
from .healf import HealfError, catalogue
from .healf import spoken_summary as product_summary
from .llm import chat_completion
from .memory import Memory
from .proactive import Coach
from .races import RaceSearchError, search_races, spoken_summary
from .voice import conversation_token
from .wearables import WearableError, wearable
from .ws import ringer

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ultracoach")

memory = Memory()
coach = Coach(memory, ringer)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Read back what the last process knew before the scheduler can ring anyone: a
    # coach that boots blind calls everyone again the moment Render restarts it.
    if await database.connect():
        await coach.restore()
        await wearable.load()
        await clocks.load()
    coach.start()
    yield
    coach.shutdown()
    await database.close()


app = FastAPI(title="UltraCoach Backend", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_tool_secret(x_tool_secret: str = Header(default="")) -> None:
    """Fail closed: an unset TOOL_SECRET locks the tools rather than opening them."""
    settings = get_settings()
    if not settings.tool_secret:
        raise HTTPException(status_code=503, detail="TOOL_SECRET is not configured")
    if not compare_digest(x_tool_secret, settings.tool_secret):
        raise HTTPException(status_code=401, detail="bad tool secret")


class Throttle:
    """A minted conversation token costs ElevenLabs credit, so one device cannot spin."""

    def __init__(self, every: float = 20.0) -> None:
        self._every = every
        self._last: dict[str, float] = {}

    def allow(self, key: str) -> tuple[bool, float]:
        """Reserve the cooldown, returning the stamp that identifies this attempt."""
        now = monotonic()
        previous = self._last.get(key, 0.0)
        if now - previous < self._every:
            return False, now
        self._last[key] = now
        return True, now

    def refund(self, key: str, stamp: float) -> None:
        """An attempt that never minted a token must not cost the runner the cooldown.

        A slow failure must not clear a newer attempt's reservation, so the refund only
        applies while this attempt is still the one holding the cooldown.
        """
        if self._last.get(key) == stamp:
            self._last.pop(key, None)


class Bucket:
    """A burst allowance per caller, refilling steadily.

    Registration has to stay unauthenticated — there is nothing for a runner to type —
    but each one creates a Zep user, so an automated caller cannot be allowed to loop.
    A bucket rather than a flat cooldown, because several genuine devices can share one
    address behind a router.
    """

    def __init__(self, burst: int, per_second: float) -> None:
        self._burst = burst
        self._rate = per_second
        self._state: dict[str, tuple[float, float]] = {}

    async def take(self, key: str) -> bool:
        """Spend one token, from Postgres where there is one.

        Held in this process alone, the allowance would reset on every restart and be
        multiplied by every worker: an attacker just spreads the requests around.
        """
        if database.ready:
            spent = await self._take_shared(key)
            if spent is not None:
                return spent
        return self._take_locally(key)

    async def _take_shared(self, key: str) -> bool | None:
        # One statement, and the refill is read under a row lock, so two workers cannot
        # both see the same allowance and both spend it. A refused caller is not charged:
        # otherwise steady retries would cancel the refill and starve them for good.
        statement = """
            WITH prior AS (
                SELECT LEAST(
                    $2::double precision,
                    tokens + EXTRACT(EPOCH FROM (now() - seen)) * $3
                ) AS tokens
                FROM register_hits WHERE caller = $1 FOR UPDATE
            ), spend AS (
                INSERT INTO register_hits (caller, tokens, seen)
                VALUES ($1, $2::double precision - 1, now())
                ON CONFLICT (caller) DO UPDATE
                SET tokens = GREATEST(
                        (SELECT tokens FROM prior)
                        - CASE WHEN (SELECT tokens FROM prior) >= 1 THEN 1 ELSE 0 END,
                        0
                    ),
                    seen = now()
                RETURNING 1
            )
            SELECT COALESCE((SELECT tokens FROM prior), $2::double precision) >= 1
        """
        try:
            async with database.pool.acquire() as connection:
                return await connection.fetchval(statement, key, float(self._burst), self._rate)
        except Exception:  # a limiter that cannot read must not close registration
            log.exception("could not read the registration allowance")
            return None

    def _take_locally(self, key: str) -> bool:
        now = monotonic()
        tokens, seen = self._state.get(key, (float(self._burst), now))
        tokens = min(self._burst, tokens + (now - seen) * self._rate)
        if tokens < 1.0:
            self._state[key] = (tokens, now)
            return False
        self._state[key] = (tokens - 1.0, now)
        return True


_session_throttle = Throttle()
# A demo call spends Grok and ElevenLabs credit, but it is meant for rapid iteration, so
# the gap is short enough to try one scenario after another.
_demo_throttle = Throttle(every=8.0)
_register_bucket = Bucket(burst=10, per_second=0.2)


def require_runner(user_id: str, authorization: str = Header(default="")) -> str:
    """The device proves it owns this runner id with the token it was issued."""
    if not verify(user_id, bearer(authorization)):
        raise HTTPException(status_code=401, detail="unknown runner token")
    return user_id


class IdentityResponse(BaseModel):
    user_id: str
    token: str


class SessionRequest(BaseModel):
    user_id: str
    # The device's IANA zone, so the coach can say "tomorrow at five" and mean it.
    timezone: str = ""


class SessionResponse(BaseModel):
    conversation_token: str
    agent_id: str
    runner_state: str
    runner_sig: str


class RaceQuery(BaseModel):
    """Bounded because every search is a paid Tavily call the agent can ask for freely."""

    location: str = Field(max_length=120)
    distance: str = Field(default="", max_length=60)
    months_ahead: int = Field(default=9, ge=1, le=24)


class CallRequest(BaseModel):
    force: bool = False


class DemoRequest(BaseModel):
    """Which rehearsed conversation the runner wants the coach to open with."""

    scenario: str = Field(default="checkin", max_length=40)


class RunnerRef(BaseModel):
    """A runner named by the agent mid-call, and the signature that proves it is theirs."""

    runner_id: str = Field(default="", max_length=120)
    runner_sig: str = Field(default="", max_length=200)


class ProductQuery(BaseModel):
    """What the coach thinks the runner needs, in its own words."""

    need: str = Field(max_length=200)
    runner_id: str = Field(default="", max_length=120)
    runner_sig: str = Field(default="", max_length=200)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


def _caller(request: Request) -> str:
    """The device's address, not the proxy's.

    Behind Render every request arrives from the same load balancer, so keying a limit
    on the socket address puts every runner in the world in one bucket: useless as a
    limit and a way to lock everyone else out.
    """
    # The last entry is the one Render's proxy appended, so it is the address the proxy
    # actually saw. Anything further left was written by the caller and is theirs to
    # forge, which would hand them a fresh allowance per request.
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


@app.post("/api/register", response_model=IdentityResponse)
async def register(request: Request) -> IdentityResponse:
    """A device claims an identity once. No login, because there is nothing to type.

    Nothing is stored here: the id is an HMAC, and the Zep user is created when the
    device first connects, so an abandoned or automated registration costs nothing.
    """
    if not await _register_bucket.take(_caller(request)):
        raise HTTPException(status_code=429, detail="too many registrations")

    user_id, token = issue_identity()
    return IdentityResponse(user_id=user_id, token=token)


@app.post("/api/session", response_model=SessionResponse)
async def create_session(
    body: SessionRequest,
    authorization: str = Header(default=""),
    settings: Settings = Depends(get_settings),
) -> SessionResponse:
    """Everything the browser needs to open a call, minus any credential."""
    require_runner(body.user_id, authorization)
    if not settings.elevenlabs_agent_id:
        raise HTTPException(status_code=503, detail="no agent configured")

    await clocks.remember(body.user_id, body.timezone)
    admitted, stamp = _session_throttle.allow(body.user_id)
    if not admitted:
        raise HTTPException(status_code=429, detail="too many sessions")

    try:
        state = await memory.get_state(body.user_id)
        token = await conversation_token(settings.elevenlabs_agent_id)
    except Exception:
        _session_throttle.refund(body.user_id, stamp)
        raise

    return SessionResponse(
        conversation_token=token,
        agent_id=settings.elevenlabs_agent_id,
        runner_sig=sign(body.user_id),
        # The signature travels with the id so the LLM proxy can tell a real runner's
        # history apart from any id a caller decides to put in the conversation.
        runner_state=(
            f"runner_id={body.user_id} runner_sig={sign(body.user_id)}\n{state.as_prompt_block()}"
        ),
    )


@app.post("/api/proactive-ring/{user_id}", dependencies=[Depends(require_tool_secret)])
async def proactive_ring(user_id: str, body: CallRequest | None = None) -> dict:
    """Operator-only: the scheduler is the normal way a call happens."""
    outcome = await coach.call(user_id, force=bool(body and body.force))
    return {
        "rang": outcome.rang,
        "reason": outcome.reason,
        "opening_line": outcome.opening_line,
        "delivered_to": outcome.delivered,
    }


# The coach normally decides when to ring, which makes the product hard to try: you can
# either wait for the sweep or nothing happens at all. These let the runner ask for a
# specific conversation now, on their own id only, and each one still goes through the
# real ring, the real agent and the real tools.
DEMO_SCENARIOS = {
    "checkin": "",
    "races": (
        "Use your race search tool this call and tell them which specific event they are "
        "entering, with the date and the entry deadline. Do not ask them to pick one."
    ),
    "products": (
        "Open on how they are fuelling and recovering, then use your product tool and "
        "tell them what you have put on their screen and that they are taking it."
    ),
    "excuse": (
        "Open by accusing them of skipping the session they promised, and refuse the "
        "first excuse they give you."
    ),
    "body": (
        "Open on their wearable numbers: sleep, resting heart rate, what they have "
        "actually run this week. Quote a number at them in the first sentence."
    ),
}


@app.post("/api/demo/call")
async def demo_call(
    body: DemoRequest,
    user_id: str,
    authorization: str = Header(default=""),
) -> dict:
    """Ring this runner now, on a chosen subject, so the flow can be tried on demand."""
    require_runner(user_id, authorization)
    if body.scenario not in DEMO_SCENARIOS:
        raise HTTPException(status_code=400, detail="unknown scenario")

    admitted, stamp = _demo_throttle.allow(user_id)
    if not admitted:
        raise HTTPException(status_code=429, detail="give the last call a moment")

    try:
        outcome = await coach.call(user_id, force=True, nudge=DEMO_SCENARIOS[body.scenario])
    except Exception:
        _demo_throttle.refund(user_id, stamp)
        raise
    return {"rang": outcome.rang, "opening_line": outcome.opening_line}


async def pull_wearable(runner_id: str) -> None:
    """Pull the week off the platform and put anything new into the graph.

    Nothing is pushed to us — Open Wearables delivers through Svix, which we do not
    run — so every fact the coach has arrives through a pull like this one.
    """
    if not wearable.user_for(runner_id):
        return
    try:
        facts = await wearable.refresh(runner_id)
    except Exception:
        log.exception("could not refresh wearable data for %s", runner_id)
        return
    # The graph is what the coach reasons over between calls, so the week's training
    # load belongs in it and not only in the prompt block.
    for kind, fact in facts:
        try:
            await memory.record_event(runner_id, f"wearable_{kind}", {"summary": fact})
        except Exception:
            log.exception("could not record %s data for %s", kind, runner_id)


@app.get("/api/wearable")
async def wearable_status(user_id: str, authorization: str = Header(default="")) -> dict:
    """What the coach can see off the runner's watch, and whether there is one.

    The PWA polls this when the tab comes back, which is the moment the runner returns
    from Fitbit's consent screen: pull first, so the answer is not an empty watch.
    """
    require_runner(user_id, authorization)
    await pull_wearable(user_id)
    return {
        "available": wearable.configured,
        "connected": wearable.connected(user_id),
        "summary": wearable.block(user_id),
        "panel": wearable.panel(user_id),
    }


@app.post("/api/wearable/connect")
async def wearable_connect(
    user_id: str,
    authorization: str = Header(default=""),
    settings: Settings = Depends(get_settings),
) -> dict:
    """A connection session for this runner: they tap once and pick Fitbit."""
    require_runner(user_id, authorization)
    try:
        url = await wearable.connect_url(user_id, settings.pwa_url)
    except WearableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {"url": url}


@app.post("/api/wearable/disconnect")
async def wearable_disconnect(user_id: str, authorization: str = Header(default="")) -> dict:
    """Give the watch back: the consent is revoked and the readings dropped, so the
    runner is offered the connection screen again."""
    require_runner(user_id, authorization)
    try:
        await wearable.disconnect(user_id)
    except WearableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {
        "available": wearable.configured,
        "connected": wearable.connected(user_id),
        "summary": wearable.block(user_id),
        "panel": wearable.panel(user_id),
    }


@app.post("/tools/body-metrics", dependencies=[Depends(require_tool_secret)])
async def tool_body_metrics(body: RunnerRef) -> dict:
    """Mid-call read of the runner's wearable, for when the coach wants more than the
    block it opened with."""
    if not verify(body.runner_id, body.runner_sig):
        raise HTTPException(status_code=401, detail="unsigned runner id")
    await pull_wearable(body.runner_id)
    return {"spoken_summary": wearable.spoken(body.runner_id)}


@app.post("/webhooks/elevenlabs")
async def elevenlabs_transcript(
    request: Request,
    elevenlabs_signature: str = Header(default=""),
    settings: Settings = Depends(get_settings),
) -> dict:
    """Post-call webhook: the whole conversation goes into the knowledge graph.

    Unsigned payloads are refused — anyone who could post here could write a runner's
    history, and that history drives every later call.
    """
    raw = await request.body()
    if not settings.elevenlabs_webhook_secret:
        raise HTTPException(status_code=503, detail="ELEVENLABS_WEBHOOK_SECRET is not configured")
    if not verify_webhook(settings.elevenlabs_webhook_secret, elevenlabs_signature, raw):
        raise HTTPException(status_code=401, detail="bad webhook signature")

    payload = await request.json()
    data = payload.get("data", payload)
    conversation_id = data.get("conversation_id", "unknown")
    # The runner id reaches ElevenLabs from the browser, so a device could name someone
    # else and write its call into that runner's history. Only a signed id is believed.
    variables = (data.get("conversation_initiation_client_data") or {}).get("dynamic_variables", {})
    user_id = data.get("user_id") or variables.get("runner_id") or ""
    if not verify(user_id, variables.get("runner_sig", "")):
        log.warning("discarding transcript %s with an unsigned runner id", conversation_id)
        return {"status": "unsigned", "turns": 0}

    turns = [
        (item.get("role", "user"), item.get("message") or "")
        for item in data.get("transcript", [])
        if item.get("message")
    ]
    # Ingest before acknowledging: a 200 tells ElevenLabs to stop retrying, so a Zep
    # failure after that point would lose the call. Ingestion is idempotent by
    # conversation id, so a retry is safe.
    try:
        await memory.add_transcript(user_id, conversation_id, turns)
    except Exception:
        log.exception("failed to ingest transcript %s", conversation_id)
        raise HTTPException(status_code=500, detail="transcript ingestion failed") from None

    return {"status": "ingested", "turns": len(turns)}


@app.post("/tools/search-races", dependencies=[Depends(require_tool_secret)])
async def tool_search_races(body: RaceQuery) -> dict:
    try:
        races = await search_races(body.location, body.distance, body.months_ahead)
    except RaceSearchError as error:
        log.warning("race search failed: %s", error)
        raise HTTPException(status_code=502, detail=str(error)) from error
    return {"spoken_summary": spoken_summary(races), "races": [race.model_dump() for race in races]}


@app.get("/api/products")
async def list_products(
    user_id: str,
    need: str = "",
    authorization: str = Header(default=""),
) -> dict:
    """The products tab. Healf's range, filtered by whatever the coach asked for."""
    require_runner(user_id, authorization)
    try:
        products = await catalogue.search(need[:200]) if need else await catalogue.featured()
    except HealfError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return {"need": need, "products": [product.model_dump() for product in products]}


@app.post("/tools/recommend-products", dependencies=[Depends(require_tool_secret)])
async def tool_recommend_products(body: ProductQuery) -> dict:
    """The coach's hands on the runner's screen: recommend out loud and show the products.

    The runner id is signed, so a conversation cannot push products onto someone else's
    tabs by naming them.
    """
    try:
        products = await catalogue.search(body.need)
    except HealfError as error:
        log.warning("product search failed: %s", error)
        raise HTTPException(status_code=502, detail=str(error)) from error

    shown = 0
    if products and verify(body.runner_id, body.runner_sig):
        shown = await ringer.show_products(
            body.runner_id,
            body.need,
            [product.model_dump() for product in products],
        )

    return {
        "spoken_summary": product_summary(products),
        "shown_on_screens": shown,
        "products": [product.model_dump() for product in products],
    }


@app.post("/api/demo/products")
async def demo_products(
    user_id: str,
    need: str = "",
    authorization: str = Header(default=""),
) -> dict:
    """The same screen push the coach makes, without waiting for it to decide to."""
    require_runner(user_id, authorization)
    try:
        products = await catalogue.search(need[:200]) if need else []
        # A demo that lands on an empty tab looks broken, so a need nothing matches
        # still shows the range the coach would pick from.
        products = products or await catalogue.featured()
    except HealfError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error

    shown = await ringer.show_products(
        user_id, need, [product.model_dump() for product in products]
    )
    return {"shown_on_screens": shown, "products": len(products)}


@app.post("/llm/chat/completions", dependencies=[Depends(require_tool_secret)])
async def llm_proxy(request: Request):
    body = await request.json()
    result = await chat_completion(body, memory)
    if isinstance(result, httpx.Response):
        return Response(
            content=result.content,
            status_code=result.status_code,
            media_type=result.headers.get("content-type", "application/json"),
        )
    return StreamingResponse(result, media_type="text/event-stream")


@app.websocket("/ws/{user_id}")
async def runner_socket(websocket: WebSocket, user_id: str, token: str = "") -> None:
    if not verify(user_id, token):
        await websocket.close(code=1008)
        return

    await ringer.connect(user_id, websocket)
    await memory.ensure_user(user_id)
    coach.on_connect(user_id)
    try:
        while True:
            message = await websocket.receive_json()
            kind = message.get("type")
            if kind not in ("call_answered", "call_declined"):
                continue
            # Stop the other tabs first, and never let a memory write take the socket
            # down: a lost event is a gap in the history, a dropped socket is a runner
            # the coach can no longer reach.
            await ringer.cancel(user_id, except_socket=websocket)
            try:
                await memory.record_event(user_id, kind, {})
            except Exception:
                log.exception("could not record %s for %s", kind, user_id)
    except WebSocketDisconnect:
        pass
    finally:
        await ringer.disconnect(user_id, websocket)
