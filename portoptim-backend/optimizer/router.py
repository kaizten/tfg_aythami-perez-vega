"""FastAPI router exposing the berth scheduling optimizer via HTTP endpoints."""

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

# Fixed - filesystem path where optimization results are persisted (project data/ folder)
_DATA_DIR = Path(__file__).parent.parent.parent / "data"

logger = structlog.get_logger()

# Fixed - FastAPI router with /optimize prefix and "optimization" tag
router = APIRouter(prefix="/optimize", tags=["optimization"])

# Computed - module-level calibration singleton, replaced atomically on /calibrate calls
_calibration: Optional[Calibration] = None
# Computed - module-level optimizer singleton, replaced atomically on /calibrate calls
_optimizer: Optimizer = Optimizer(calibration=None)


@router.post(
    "/run",
    response_model=OptimizationResponse,
    summary="Run berth scheduling optimisation",
)
async def run_optimization(request: OptimizationRequest) -> OptimizationResponse:
    """
    Accept a list of vessels and a port configuration, run the optimizer, and return an optimised schedule.

    Args:
        request (OptimizationRequest): Vessels and port configuration to optimize. Required.

    Returns:
        OptimizationResponse: Per-vessel assignments and aggregate KPI metrics.
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
    """
    Persist the latest optimization result to data/optimization-results.json on the server.

    Args:
        result (OptimizationResponse): The optimization result to save. Required.
    """
    try:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
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
    Accept the current schedule and a list of vessel delays, and return an updated schedule.

    Re-scheduling is only triggered when at least one delay exceeds the vessel's fondeo buffer
    and the resulting shift causes a berth-capacity, pilot, or tug conflict.

    Args:
        request (ReplanRequest): Current schedule, delays, port config, and original vessel inputs. Required.

    Returns:
        ReplanResponse: Updated assignments, KPIs, conflict count, and affected vessel list.
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
    Called when a vessel finishes its cargo operation before its scheduled end time.

    Truncates ejecucion, checks pilot and tug availability for undocking, adds a
    waiting_undock phase when resources are busy, and optionally pulls forward any
    vessel waiting in fondeo for the freed berth.

    Args:
        request (EarlyCompleteRequest): Vessel ID, actual completion time, current schedule, and port config. Required.

    Returns:
        EarlyCompleteResponse: Updated assignments, KPIs, and early-completion metrics.
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
    """
    Return rate_model and duration_model entry counts plus the learned overlap factor.

    Returns:
        dict: Calibration statistics, or a status message when no calibration has been loaded.
    """
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
    Fit statistical models from a historical CSV file at the given server-side path.

    Replaces any previously loaded calibration and rebuilds the optimizer singleton.

    Args:
        csv_path (str): Absolute server-side path to the historical CSV file. Required.

    Returns:
        dict: Calibration statistics for the newly fitted models.
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
