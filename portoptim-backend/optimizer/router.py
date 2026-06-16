"""
FastAPI router for the berth scheduling optimizer.

Endpoints
---------
POST /api/v1/optimize/run        — run the optimizer
GET  /api/v1/optimize/calibration-stats  — inspect loaded calibration models
POST /api/v1/optimize/calibrate  — load (or reload) a CSV calibration file
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
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

# Results are saved one level above the backend root (project data/ folder)
_DATA_DIR = Path(__file__).parent.parent.parent / "data"

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
        result = _optimizer.optimize(request)
        _save_optimization_result(result)
        return result
    except Exception as exc:
        logger.error("optimization_error", error=str(exc), exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Optimisation failed: {exc}",
        ) from exc


def _save_optimization_result(result: OptimizationResponse) -> None:
    """Persist the latest optimization result to data/optimization-results.json."""
    try:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        # assignments and kpis are already plain dicts (list[dict] / dict)
        output = {
            "saved_at": datetime.now().isoformat(),
            "kpis": result.kpis,
            "assignments": result.assignments,
        }
        dest = _DATA_DIR / "optimization-results.json"
        dest.write_text(json.dumps(output, indent=2, default=str), encoding="utf-8")
        logger.info("optimization_result_saved", path=str(dest))
    except Exception as exc:
        logger.warning("optimization_result_save_failed", error=str(exc))


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
