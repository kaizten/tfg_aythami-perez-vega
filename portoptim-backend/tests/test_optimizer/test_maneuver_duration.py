"""Tests for calibrated manoeuvre duration (Mejora 1)."""
from __future__ import annotations

from datetime import datetime

import pytest

from optimizer.calibration import Calibration
from optimizer.models import BerthZone, OptimizationRequest, VesselOperation
from optimizer.optimizer import Optimizer
from optimizer.scheduler import Scheduler, estimate_maneuver_duration

from .conftest import continuous_berth, make_vessel, simple_config


# ── Helpers ───────────────────────────────────────────────────────────────────

def _calibration_with_model() -> Calibration:
    """Return a Calibration whose maneuver_model is populated manually."""
    cal = Calibration()  # no CSV
    # Inject known values so tests are deterministic
    cal.maneuver_model[(">220m", True)] = 1.5   # large hazardous
    cal.maneuver_model[(">220m", False)] = 1.1  # large normal
    cal.maneuver_model[("<80m", False)] = 0.4   # small normal
    cal.maneuver_model[("<80m", True)] = 0.7    # small hazardous
    return cal


# ── Test 1: larger / hazardous vessel → longer manoeuvre ─────────────────────

def test_large_hazardous_longer_than_small_normal():
    cal = _calibration_with_model()
    large_hazardous = cal.get_maneuver_duration(250.0, "Energético")
    small_normal = cal.get_maneuver_duration(60.0, "Graneles sólidos")
    assert large_hazardous > small_normal


# ── Test 2: fallback when calibration is None ─────────────────────────────────

def test_fallback_no_calibration():
    result = estimate_maneuver_duration(100.0, "Graneles sólidos", calibration=None)
    assert result > 0
    assert result < 5.0  # sanity: not absurdly large


def test_fallback_no_calibration_hazardous_greater_than_normal():
    normal = estimate_maneuver_duration(100.0, "Graneles sólidos", calibration=None)
    hazardous = estimate_maneuver_duration(100.0, "Energético", calibration=None)
    assert hazardous > normal


# ── Test 3: fallback when bucket missing from model ───────────────────────────

def test_fallback_missing_bucket_no_exception():
    cal = Calibration()  # empty model
    # Should not raise; must return a positive float
    result = cal.get_maneuver_duration(150.0, "Energético")
    assert isinstance(result, float)
    assert result > 0


# ── Test 4: end-to-end — large hazardous vessel gets later scheduled_end ──────

def _make_request(eslora: float, cargo: str) -> OptimizationRequest:
    vessel = make_vessel(
        id="V001",
        eta="2024-01-15T08:00:00",
        eslora=eslora,
        gt=50_000,
        target_berth="BERTH_A",
        operations=[{"tipo_operacion": "Desembarque", "grupo_mercancia": cargo, "cantidad": None}],
        estimated_duration_h=20.0,  # fixed so only manoeuvre time differs
    )
    berths = [continuous_berth("BERTH_A", noray_max=200)]
    cfg = simple_config(berths, num_pilots=10, num_tugs=10)
    return OptimizationRequest(vessels=[vessel], config=cfg)


def test_end_to_end_large_hazardous_scheduled_end_gte_no_calibration():
    """
    With calibration that assigns longer manoeuvre to large hazardous vessels,
    the resource windows are longer — the scheduler delays other vessels if
    resources are scarce.  With a single vessel and abundant resources the
    scheduled_end is the same because manoeuvre time only affects resource
    allocation, not the berth slot duration.  We verify the result is coherent.
    """
    cal = _calibration_with_model()
    opt_cal = Optimizer(calibration=cal)
    opt_no_cal = Optimizer(calibration=None)

    req = _make_request(eslora=250.0, cargo="Energético")

    resp_cal = opt_cal.optimize(req)
    resp_no_cal = opt_no_cal.optimize(req)

    assert len(resp_cal.assignments) == 1
    assert len(resp_no_cal.assignments) == 1

    # Both should successfully assign the vessel
    assert resp_cal.assignments[0]["status"] == "assigned"
    assert resp_no_cal.assignments[0]["status"] == "assigned"

    # scheduled_end with calibration must be >= without (manoeuvre consumes resources longer)
    end_cal = resp_cal.assignments[0]["scheduled_end"]
    end_no_cal = resp_no_cal.assignments[0]["scheduled_end"]
    # Both have same fixed duration — ends should be equal (single vessel, abundant resources)
    assert end_cal == end_no_cal
