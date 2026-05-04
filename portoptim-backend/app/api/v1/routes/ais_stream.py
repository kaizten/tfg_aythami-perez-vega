"""WebSocket relay — connects to AISStream.io and fans out PositionReport messages to Angular clients."""
import asyncio
import json
import logging

import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ais"])

_AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream"
_API_KEY       = "d3badf9c95fe7c87f9223e7c59a1a1bc73870721"

# Bbox updated dynamically by the frontend; relay reconnects when it changes
_current_bbox: list = [[[28.06, -15.52], [28.18, -15.36]]]

_clients:            set[WebSocket] = set()
_relay_task:         asyncio.Task | None = None
_active_ws                          = None   # current AISStream WebSocket
_reconnect_debounce: asyncio.Task | None = None


async def _relay_loop() -> None:
    """Long-lived relay: reconnects to AISStream whenever the connection drops or bbox changes."""
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
    """Wait 1 s after last bbox update, then close the active AISStream connection.
    The relay loop will immediately reconnect with the new bbox."""
    try:
        await asyncio.sleep(1.0)
        logger.info("AISStream: applying new bbox %s", _current_bbox)
        if _active_ws is not None:
            await _active_ws.close()
    except asyncio.CancelledError:
        pass  # superseded by a newer bbox update


def _schedule_reconnect() -> None:
    global _reconnect_debounce
    if _reconnect_debounce and not _reconnect_debounce.done():
        _reconnect_debounce.cancel()
    _reconnect_debounce = asyncio.create_task(_debounced_reconnect())


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
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                if msg.get("type") == "bbox":
                    _current_bbox[:] = msg["bbox"]   # mutate in-place so _relay_loop sees the update
                    logger.info("AISStream: bbox queued → %s", _current_bbox)
                    _schedule_reconnect()
            except Exception:
                pass
    except WebSocketDisconnect:
        pass
    finally:
        _clients.discard(websocket)
