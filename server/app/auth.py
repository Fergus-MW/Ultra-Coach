"""Device identity without a login screen.

The PWA has no text inputs, so a runner cannot type credentials. Instead a device
registers once and keeps an HMAC of its runner id; every later call proves possession
of that token. Tokens are stateless — no session store, no database.
"""

from __future__ import annotations

import hmac
import logging
import secrets
import uuid
from hashlib import sha256

from .config import get_settings

log = logging.getLogger(__name__)

_EPHEMERAL_SECRET = secrets.token_hex(32)


def _signing_key() -> bytes:
    configured = get_settings().session_secret
    if configured:
        return configured.encode()

    log.warning("SESSION_SECRET unset: signing with a per-process key, tokens die on restart")
    return _EPHEMERAL_SECRET.encode()


def issue_identity() -> tuple[str, str]:
    """Mint a fresh runner id and its token."""
    user_id = f"runner_{uuid.uuid4().hex}"
    return user_id, sign(user_id)


def sign(user_id: str) -> str:
    return hmac.new(_signing_key(), user_id.encode(), sha256).hexdigest()


def verify(user_id: str, token: str) -> bool:
    return bool(user_id) and bool(token) and hmac.compare_digest(sign(user_id), token)


def bearer(header: str) -> str:
    scheme, _, value = header.partition(" ")
    return value.strip() if scheme.lower() == "bearer" else ""


def verify_webhook(secret: str, signature_header: str, body: bytes) -> bool:
    """ElevenLabs sends `t=<unix>,v0=<hmac of "t.body">`."""
    parts = dict(piece.split("=", 1) for piece in signature_header.split(",") if "=" in piece)
    timestamp, digest = parts.get("t", ""), parts.get("v0", "")
    if not timestamp or not digest:
        return False

    expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, sha256).hexdigest()
    return hmac.compare_digest(expected, digest)
