"""WebSocket relay — connects to AISStream.io and fans out PositionReport messages to Angular clients."""
import asyncio
import json
import logging

import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ais"])

_AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream"
_API_KEY       = "51d203228a16d966b27d311645b15cf98beacd40"
_BBOX          = [[[28.06, -15.52], [28.18, -15.36]]]  # Las Palmas de Gran Canaria

_clients: set[WebSocket] = set()
_relay_task: asyncio.Task | None = None


async def _relay_loop() -> None:
    """Maintains a persistent connection to AISStream.io and fans messages out to clients."""
    backoff = 2
    while True:
        try:
            async with websockets.connect(_AISSTREAM_URL) as ws:
                logger.info("AISStream relay: connected")
                backoff = 2
                await ws.send(json.dumps({
                    "APIKey": _API_KEY,
                    "BoundingBoxes": _BBOX,
                    "FilterMessageTypes": ["PositionReport"],
                }))
                async for raw in ws:
                    if not _clients:
                        continue
                    dead: set[WebSocket] = set()
                    for client in list(_clients):
                        try:
                            await client.send_text(raw)
                        except Exception:
                            dead.add(client)
                    _clients.difference_update(dead)
        except Exception as exc:
            logger.warning("AISStream relay error: %s — retry in %ds", exc, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)


@router.websocket("/ws/ais-stream")
async def ais_websocket(websocket: WebSocket) -> None:
    global _relay_task
    await websocket.accept()
    _clients.add(websocket)

    if _relay_task is None or _relay_task.done():
        _relay_task = asyncio.create_task(_relay_loop())
        logger.info("AISStream relay task started")

    try:
        while True:
            await websocket.receive_text()  # blocks until client sends or disconnects
    except WebSocketDisconnect:
        pass
    finally:
        _clients.discard(websocket)
