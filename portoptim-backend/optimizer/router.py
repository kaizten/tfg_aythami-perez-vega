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
from .models import OptimizationRequest, OptimizationResponse
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
