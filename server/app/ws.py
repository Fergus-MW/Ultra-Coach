"""The channel the coach rings the browser on."""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict

from fastapi import WebSocket

log = logging.getLogger(__name__)


class Ringer:
    """Fan-out of proactive events to every open tab for a runner."""

    def __init__(self) -> None:
        self._sockets: dict[str, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, user_id: str, socket: WebSocket) -> None:
        await socket.accept()
        async with self._lock:
            self._sockets[user_id].add(socket)

    async def disconnect(self, user_id: str, socket: WebSocket) -> None:
        async with self._lock:
            self._sockets[user_id].discard(socket)
            if not self._sockets[user_id]:
                del self._sockets[user_id]

    def is_online(self, user_id: str) -> bool:
        return bool(self._sockets.get(user_id))

    async def ring(self, user_id: str, opening_line: str, reason: str) -> int:
        """Push an incoming call to the runner. Returns how many tabs got it."""
        return await self._send(
            user_id,
            {"type": "incoming_call", "opening_line": opening_line, "reason": reason},
        )

    async def show_products(self, user_id: str, need: str, products: list[dict]) -> int:
        """The coach drives the screen: recommended products appear while it talks."""
        return await self._send(
            user_id,
            {"type": "show_products", "need": need, "products": products},
        )

    async def cancel(self, user_id: str, except_socket: WebSocket | None = None) -> int:
        """One tab took the call, so every other tab has to stop ringing."""
        return await self._send(user_id, {"type": "call_cancelled"}, skip=except_socket)

    async def _send(self, user_id: str, message: dict, skip: WebSocket | None = None) -> int:
        async with self._lock:
            sockets = [s for s in self._sockets.get(user_id, ()) if s is not skip]

        delivered = 0
        for socket in sockets:
            try:
                await socket.send_json(message)
                delivered += 1
            except Exception:
                log.warning("dropping dead socket for %s", user_id)
                await self.disconnect(user_id, socket)
        return delivered


ringer = Ringer()
