"""
FastAPI router for the berth scheduling optimizer.

Endpoints
---------
POST /api/v1/optimize/run        — run the optimizer
GET  /api/v1/optimize/calibration-stats  — inspect loaded calibration models
POST /api/v1/optimize/calibrate  — load (or reload) a CSV calibration file
"""

from __future__ import annotations

from typing import Optional

import structlog
from fastapi import APIRouter, HTTPException, status

from .calibration import Calibration
from .models import (
    EarlyCompleteRequest,
    EarlyCompleteResponse,
    OptimizationRequest,
    OptimizationResponse,
    ReplanRequest,
    ReplanResponse,
)
from .optimizer import Optimizer

logger = structlog.get_logger()

router = APIRouter(prefix="/optimize", tags=["optimization"])

# Module-level singletons — replaced atomically on /calibrate calls
_calibration: Optional[Calibration] = None
_optimizer: Optimizer = Optimizer(calibration=None)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post(
    "/run",
    response_model=OptimizationResponse,
    summary="Run berth scheduling optimisation",
)
async def run_optimization(request: OptimizationRequest) -> OptimizationResponse:
    """
    Accept a list of vessels and a port configuration, return an optimised
    schedule with per-vessel assignments and aggregate KPIs.
    """
    try:
        return _optimizer.optimize(request)
    except Exception as exc:
        logger.error("optimization_error", error=str(exc), exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Optimisation failed: {exc}",
        ) from exc


@router.post(
    "/replan",
    response_model=ReplanResponse,
    summary="Re-plan berth schedule after vessel delays",
)
async def replan(request: ReplanRequest) -> ReplanResponse:
    """
    Accept the current schedule, a list of vessel delays, and the original
    vessel inputs.  Returns an updated schedule.

    Re-scheduling is only triggered when at least one delay exceeds the vessel's
    fondeo (anchorage) buffer *and* the resulting shift causes a berth-capacity,
    pilot, or tug conflict.  Otherwise the delay is absorbed by the fondeo phase
    and returned immediately without re-running the optimizer.
    """
    try:
        return _optimizer.replan(request)
    except Exception as exc:
        logger.error("replan_error", error=str(exc), exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Re-planning failed: {exc}",
        ) from exc


@router.post(
    "/early_complete",
    response_model=EarlyCompleteResponse,
    summary="Handle early cargo-operation completion",
)
async def early_complete(request: EarlyCompleteRequest) -> EarlyCompleteResponse:
    """
    Called when a vessel finishes its cargo operation before its scheduled end.

    Truncates ``ejecucion``, checks pilot / tug availability for undocking,
    adds a ``waiting_undock`` phase (light purple) when resources are busy,
    and optionally pulls forward any vessel waiting in fondeo for the freed berth.
    """
    try:
        return _optimizer.early_complete(request)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        logger.error("early_complete_error", error=str(exc), exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Early completion failed: {exc}",
        ) from exc


@router.get(
    "/calibration-stats",
    summary="Show calibration model statistics",
)
async def calibration_stats() -> dict:
    """Return rate_model and duration_model entry counts plus learned overlap factor."""
    if _calibration is None:
        return {
            "status": "no_calibration",
            "message": "No CSV has been loaded. POST /optimize/calibrate to fit a model.",
        }
    return _calibration.stats()


@router.post(
    "/calibrate",
    summary="Load a CSV file and fit calibration models",
)
async def calibrate(csv_path: str) -> dict:
    """
    Fit the statistical models from a historical CSV file at *csv_path*
    (server-side path).  Replaces any previously loaded calibration.
    """
    global _calibration, _optimizer
    try:
        cal = Calibration(csv_path=csv_path)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Could not load CSV: {exc}",
        ) from exc
    _calibration = cal
    _optimizer = Optimizer(calibration=_calibration)
    return _calibration.stats()
