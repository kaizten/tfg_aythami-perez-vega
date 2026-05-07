"""Tests for operation phases in AssignmentResult (Mejora 2)."""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from optimizer.models import (
    BerthZone,
    OptimizationRequest,
    OperationPhase,
    VesselOperation,
    build_phases,
)
from optimizer.optimizer import Optimizer

from .conftest import continuous_berth, discrete_berth, make_vessel, simple_config


# ── Helpers ───────────────────────────────────────────────────────────────────

def _phases_for_vessel(eslora: float = 150.0, cargo: str = "Graneles sólidos",
                        duration_h: float = 24.0, wait_h: float = 2.0,
                        maneuver_h: float = 0.5) -> list[OperationPhase]:
    eta = datetime(2024, 1, 15, 8, 0)
    scheduled_start = eta + timedelta(hours=wait_h)
    scheduled_end = scheduled_start + timedelta(hours=duration_h)
    return build_phases(
        eta=eta,
        scheduled_start=scheduled_start,
        scheduled_end=scheduled_end,
        waiting_time_h=wait_h,
        duration_estimated_h=duration_h,
        maneuver_h=maneuver_h,
    )


# ── Test 1: sum of phase durations == (scheduled_end - eta) ──────────────────

def test_phase_durations_sum_to_total_port_time():
    wait_h = 3.0
    duration_h = 20.0
    maneuver_h = 0.6
    eta = datetime(2024, 1, 15, 8, 0)
    scheduled_start = eta + timedelta(hours=wait_h)
    scheduled_end = scheduled_start + timedelta(hours=duration_h)

    phases = build_phases(
        eta=eta,
        scheduled_start=scheduled_start,
        scheduled_end=scheduled_end,
        waiting_time_h=wait_h,
        duration_estimated_h=duration_h,
        maneuver_h=maneuver_h,
    )

    total_from_phases = sum(p.duration_h for p in phases)
    expected = (scheduled_end - eta).total_seconds() / 3600
    assert abs(total_from_phases - expected) < 0.01


# ── Test 2: ejecucion duration is never negative ──────────────────────────────

def test_ejecucion_never_negative_even_with_huge_maneuver():
    # maneuver so large it would overflow without the safety clamp
    phases = _phases_for_vessel(duration_h=1.0, maneuver_h=5.0)
    exec_phase = next(p for p in phases if p.name == "ejecucion")
    assert exec_phase.duration_h >= 0.0


# ── Test 3: zero wait → fondeo has duration 0 and start == end ───────────────

def test_zero_wait_fondeo_has_zero_duration():
    phases = _phases_for_vessel(wait_h=0.0)
    fondeo = next(p for p in phases if p.name == "fondeo")
    assert fondeo.duration_h == 0.0
    assert fondeo.start == fondeo.end


# ── Test 4: phase names are exactly the expected four ─────────────────────────

def test_phase_names_correct_and_ordered():
    phases = _phases_for_vessel()
    assert [p.name for p in phases] == ["fondeo", "atraque", "ejecucion", "desatraque"]


# ── Test 5: end-to-end — 2 vessels, all assigned have 4 consecutive phases ───

def test_end_to_end_phases_consecutive_no_gaps():
    v1 = make_vessel(
        "V1", "2024-01-15T08:00:00", eslora=120.0, gt=10_000,
        target_berth="B1", estimated_duration_h=12.0,
    )
    v2 = make_vessel(
        "V2", "2024-01-15T10:00:00", eslora=80.0, gt=3_000,
        target_berth="B1", estimated_duration_h=8.0,
    )

    berths = [continuous_berth("B1", noray_max=200)]
    cfg = simple_config(berths, num_pilots=10, num_tugs=10)
    req = OptimizationRequest(vessels=[v1, v2], config=cfg)

    resp = Optimizer().optimize(req)
    assigned = [a for a in resp.assignments if a["status"] == "assigned"]

    assert len(assigned) >= 1

    for assignment in assigned:
        phases = assignment["phases"]

        # Exactly 4 phases
        assert len(phases) == 4
        assert [p["name"] for p in phases] == ["fondeo", "atraque", "ejecucion", "desatraque"]

        # Timestamps are consecutive (end of each == start of next)
        for i in range(len(phases) - 1):
            assert phases[i]["end"] == phases[i + 1]["start"], (
                f"Gap between {phases[i]['name']} and {phases[i+1]['name']}: "
                f"{phases[i]['end']} != {phases[i+1]['start']}"
            )


# ── Test 6: unassigned vessels have empty phases list ────────────────────────

def test_unassigned_vessel_has_empty_phases():
    # Vessel too long to fit in any berth
    v = make_vessel(
        "HUGE", "2024-01-15T08:00:00", eslora=5000.0, gt=100_000,
        target_berth="B1", estimated_duration_h=24.0,
    )
    berths = [continuous_berth("B1", noray_max=10)]  # noray_max << vessel norays needed
    cfg = simple_config(berths)
    req = OptimizationRequest(vessels=[v], config=cfg)

    resp = Optimizer().optimize(req)
    assert resp.assignments[0]["phases"] == []
