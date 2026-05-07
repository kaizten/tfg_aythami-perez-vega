"""
End-to-end optimizer tests covering spec scenarios 4–8 via the full pipeline,
plus structural output validation.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from optimizer.calibration import Calibration
from optimizer.models import BerthZone, OptimizationRequest
from optimizer.optimizer import Optimizer

from .conftest import continuous_berth, discrete_berth, make_vessel, simple_config


# ── Helper ────────────────────────────────────────────────────────────────────

def run(vessels, berths, **cfg_kwargs):
    cfg = simple_config(berths, **cfg_kwargs)
    req = OptimizationRequest(vessels=vessels, config=cfg)
    return Optimizer(calibration=None).optimize(req)


# ── Output structure ──────────────────────────────────────────────────────────

def test_output_structure():
    berth = continuous_berth("B1", noray_max=100)
    v = make_vessel("V1", "2024-01-15T08:00:00", eslora=50, gt=5000,
                    target_berth="B1", estimated_duration_h=10)
    result = run([v], [berth])

    assert "assignments" in result.model_dump()
    assert "kpis" in result.model_dump()

    kpis = result.kpis
    assert "total_waiting_time_h" in kpis
    assert "avg_waiting_time_h" in kpis
    assert "berth_utilization" in kpis
    assert "unresolved_vessels" in kpis
    assert "improvement_vs_greedy_pct" in kpis
    assert "conflicts_resolved" in kpis
    assert "duration_source_breakdown" in kpis

    # Berth utilization is dynamic — contains exactly the berths in the config
    assert "B1" in kpis["berth_utilization"]


def test_berth_utilization_dynamic():
    """berth_utilization keys match mooring_zones in config, not hardcoded."""
    berths = [
        continuous_berth("ALFA", noray_max=100),
        discrete_berth("BETA", capacity=2),
        continuous_berth("GAMMA", noray_max=50),
    ]
    vessels = [
        make_vessel(f"V{i}", "2024-01-15T08:00:00", eslora=40,
                    gt=float(i * 1000 + 1000), target_berth=b.berth_id,
                    estimated_duration_h=8)
        for i, b in enumerate(berths)
    ]
    result = run(vessels, berths)
    util_keys = set(result.kpis["berth_utilization"].keys())
    assert util_keys == {"ALFA", "BETA", "GAMMA"}


# ── Test 5 via full optimizer: invalid berth ──────────────────────────────────

def test_invalid_berth_end_to_end():
    """Vessel targeting a berth not in config → status invalid_berth, counted in unresolved."""
    berth = continuous_berth("REAL", noray_max=100)
    v = make_vessel("GHOST", "2024-01-15T08:00:00", eslora=50, gt=5000,
                    target_berth="GHOST_BERTH", estimated_duration_h=10)
    result = run([v], [berth])

    assert result.kpis["unresolved_vessels"] == 1
    a = result.assignments[0]
    assert a["status"] == "invalid_berth"


# ── 5 vessels × 2 berths — no CSV ────────────────────────────────────────────

def test_five_vessels_two_berths_no_csv():
    """Spec test: 5 vessels, 2 made-up berths, no CSV — must assign all."""
    berths = [
        continuous_berth("DOCK_A", noray_max=200),
        discrete_berth("DOCK_B", capacity=3),
    ]
    vessels = [
        make_vessel("V1", "2024-01-15T08:00:00", eslora=80, gt=30000, target_berth="DOCK_A",
                    estimated_duration_h=12),
        make_vessel("V2", "2024-01-15T09:00:00", eslora=60, gt=20000, target_berth="DOCK_A",
                    estimated_duration_h=8),
        make_vessel("V3", "2024-01-15T10:00:00", eslora=40, gt=10000, target_berth="DOCK_A",
                    estimated_duration_h=6),
        make_vessel("V4", "2024-01-15T08:00:00", eslora=100, gt=50000, target_berth="DOCK_B",
                    estimated_duration_h=16),
        make_vessel("V5", "2024-01-15T11:00:00", eslora=90, gt=45000, target_berth="DOCK_B",
                    estimated_duration_h=10),
    ]
    result = run(vessels, berths)

    assigned = [a for a in result.assignments if a["status"] == "assigned"]
    assert len(assigned) == 5
    assert result.kpis["unresolved_vessels"] == 0


# ── 5 vessels × 20 berths — scalability ──────────────────────────────────────

def test_five_vessels_twenty_berths_no_csv():
    """Spec test: algorithm must work equally with 20 berths as with 2."""
    berths = [continuous_berth(f"DOCK_{i:02d}", noray_max=200) for i in range(20)]
    # Each vessel goes to a different berth
    vessels = [
        make_vessel(f"V{i}", "2024-01-15T08:00:00", eslora=60, gt=float(i * 1000 + 1000),
                    target_berth=f"DOCK_{i:02d}", estimated_duration_h=12)
        for i in range(5)
    ]
    result = run(vessels, berths)
    assigned = [a for a in result.assignments if a["status"] == "assigned"]
    assert len(assigned) == 5


# ── duration_source_breakdown ─────────────────────────────────────────────────

def test_duration_source_provided_counted():
    """Vessels with estimated_duration_h show up as 'provided' in breakdown."""
    berth = continuous_berth("B1", noray_max=100)
    v = make_vessel("V1", "2024-01-15T08:00:00", eslora=50, gt=5000,
                    target_berth="B1", estimated_duration_h=10)
    result = run([v], [berth])
    assert result.kpis["duration_source_breakdown"].get("provided", 0) == 1


def test_duration_source_default_counted():
    """Vessels without amount and no calibration → 'default' in breakdown."""
    berth = continuous_berth("B1", noray_max=100)
    v = make_vessel("V1", "2024-01-15T08:00:00", eslora=50, gt=5000,
                    target_berth="B1",
                    operations=[{"tipo_operacion": "X", "grupo_mercancia": "Y"}])
    result = run([v], [berth])
    assert result.kpis["duration_source_breakdown"].get("default", 0) == 1


# ── Calibration injected ──────────────────────────────────────────────────────

def test_optimizer_with_calibration_injected():
    """Optimizer with seeded calibration uses rate_model for duration."""
    cal = Calibration()
    cal.rate_model[("Desembarque", "Energético")] = 546.0

    berth = continuous_berth("B1", noray_max=100)
    v = make_vessel("V1", "2024-01-15T08:00:00", eslora=144.56, gt=7680,
                    target_berth="B1",
                    operations=[{"tipo_operacion": "Desembarque",
                                 "grupo_mercancia": "Energético",
                                 "cantidad": 25_000}])
    cfg = simple_config([berth])
    req = OptimizationRequest(vessels=[v], config=cfg)
    result = Optimizer(calibration=cal).optimize(req)

    a = result.assignments[0]
    assert a["duration_source"] == "rate_model"
    assert abs(a["duration_estimated_h"] - 25_000 / 546.0) < 1.0
