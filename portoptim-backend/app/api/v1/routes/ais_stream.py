"""WebSocket relay — connects to AISStream.io and fans out PositionReport messages to Angular clients."""

import asyncio
import json
import logging

import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

# Fixed - FastAPI router for AIS-related WebSocket endpoints
router = APIRouter(tags=["ais"])

# Fixed - AISStream.io upstream WebSocket URL
_AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream"

# Fixed - API key for authenticating with the AISStream.io service
_API_KEY = "d3badf9c95fe7c87f9223e7c59a1a1bc73870721"

# Computed - active geographic bounding box sent to AISStream; updated by frontend messages
_current_bbox: list = [[[28.06, -15.52], [28.18, -15.36]]]

# Computed - set of currently connected Angular frontend WebSocket clients
_clients: set[WebSocket] = set()

# Computed - background asyncio task running the upstream relay loop
_relay_task: asyncio.Task | None = None

# Computed - current open connection to the AISStream upstream WebSocket
_active_ws = None

# Computed - pending debounce task that applies a queued bbox update
_reconnect_debounce: asyncio.Task | None = None


async def _relay_loop() -> None:
    """
    Long-lived background coroutine that maintains the upstream AISStream connection.

    Reconnects automatically with exponential back-off whenever the connection
    drops or the bounding box changes. Forwards every received PositionReport
    message to all connected frontend clients.
    """
    global _active_ws
    backoff = 2
    while True:
        try:
            async with websockets.connect(_AISSTREAM_URL) as ws:
                _active_ws = ws
                logger.info("AISStream relay: connected (bbox=%s)", _current_bbox)
                backoff = 2
                await ws.send(json.dumps({
                    "APIKey": _API_KEY,
                    "BoundingBoxes": _current_bbox,
                    "FilterMessageTypes": ["PositionReport"],
                }))
                async for raw in ws:
                    text = raw if isinstance(raw, str) else raw.decode("utf-8")
                    if not _clients:
                        continue
                    dead: set[WebSocket] = set()
                    for client in list(_clients):
                        try:
                            await client.send_text(text)
                        except Exception:
                            dead.add(client)
                    _clients.difference_update(dead)
                logger.info("AISStream relay: upstream closed, reconnecting…")
        except asyncio.CancelledError:
            logger.info("AISStream relay: task stopped")
            return
        except Exception as exc:
            logger.warning("AISStream relay error: %s — retry in %ds", exc, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)
        finally:
            _active_ws = None


async def _debounced_reconnect() -> None:
    """
    Wait 1 second after the last bbox update, then close the upstream connection.

    The relay loop detects the closure and immediately reconnects using the
    updated bounding box stored in _current_bbox.
    """
    try:
        await asyncio.sleep(1.0)
        logger.info("AISStream: applying new bbox %s", _current_bbox)
        if _active_ws is not None:
            await _active_ws.close()
    except asyncio.CancelledError:
        pass


def _schedule_reconnect() -> None:
    """
    Cancel any pending debounce task and start a new one for the latest bbox update.

    Ensures rapid successive bbox changes are coalesced into a single reconnect.
    """
    global _reconnect_debounce
    if _reconnect_debounce and not _reconnect_debounce.done():
        _reconnect_debounce.cancel()
    _reconnect_debounce = asyncio.create_task(_debounced_reconnect())


@router.websocket("/ws/ais-stream")
async def ais_websocket(websocket: WebSocket) -> None:
    """
    WebSocket /ws/ais-stream — accept a frontend client and relay AIS position data.

    Registers the client in the shared set, starts the upstream relay task if not
    already running, and listens for bbox update messages from the client.

    Args:
        websocket (WebSocket): The incoming WebSocket connection from the frontend. Required.
    """
    global _relay_task
    await websocket.accept()
    _clients.add(websocket)

    if _relay_task is None or _relay_task.done():
        _relay_task = asyncio.create_task(_relay_loop())
        logger.info("AISStream relay task started")

    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                if msg.get("type") == "bbox":
                    _current_bbox[:] = msg["bbox"]
                    logger.info("AISStream: bbox queued → %s", _current_bbox)
                    _schedule_reconnect()
            except Exception:
                pass
    except WebSocketDisconnect:
        pass
    finally:
        _clients.discard(websocket)
