"""
Scheduler (greedy) tests.

Tests 4, 5, 6 of the spec:
  4. GT conflict: higher-GT vessel docks first
  5. target_berth not in config → status "invalid_berth"
  6. Continuous berth: three simultaneous vessels without noray overlap
  8. Works without CSV
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from optimizer.models import BerthZone, VesselInput, VesselOperation
from optimizer.scheduler import Scheduler

from .conftest import continuous_berth, discrete_berth, make_vessel


# ── Test: tug contention (resource delay tracking) ───────────────────────────

def test_tug_contention_second_vessel_waits():
    """
    1 tug available, 2 vessels arriving at the same ETA both needing 1 tug.

    The second (lower-GT) vessel must wait ~1 h for the tug to be freed after
    the first vessel's docking manoeuvre.  tug_caused_delay must be True on the
    delayed vessel.
    """
    berth = discrete_berth("B1", capacity=2)  # enough berth space for both
    v_high = make_vessel("HIGH", "2024-01-15T08:00:00", eslora=60, gt=5_000,
                         target_berth="B1", estimated_duration_h=24)
    v_low = make_vessel("LOW", "2024-01-15T08:00:00", eslora=60, gt=1_000,
                        target_berth="B1", estimated_duration_h=24)

    sched = Scheduler(num_pilots=10, num_tugs=1)
    assignments, conflicts = sched.schedule([v_high, v_low], [berth])

    a_high = next(a for a in assignments if a.vessel_id == "HIGH")
    a_low = next(a for a in assignments if a.vessel_id == "LOW")

    # Both get scheduled
    assert a_high.status == "assigned"
    assert a_low.status == "assigned"

    # Higher-GT vessel docks without delay
    assert a_high.waiting_time_h == 0.0
    assert not a_high.tug_caused_delay

    # Lower-GT vessel must wait for the tug to be freed after the first docking manoeuvre
    assert a_low.waiting_time_h > 0.0
    assert a_low.tug_caused_delay

    # Exactly 1 conflict was logged
    assert conflicts == 1


def test_tugs_required_reflects_vessel_gt():
    """tugs_required in the assignment output matches the GT-based rule."""
    berth = continuous_berth("B1", noray_max=200)
    # GT 5 000 (3 000 ≤ GT < 10 000) → 2 tugs base, no hazardous cargo
    v = make_vessel("V1", "2024-01-15T08:00:00", eslora=80, gt=5_000,
                    target_berth="B1", estimated_duration_h=12)

    sched = Scheduler(num_pilots=10, num_tugs=10)
    assignments, _ = sched.schedule([v], [berth])

    assert assignments[0].tugs_required == 2
    assert assignments[0].tugs_assigned is True


# ── Test 4: GT priority ───────────────────────────────────────────────────────

def test_gt_priority_higher_docks_first():
    """
    Two vessels assigned to the same discrete berth, both arrive at the same ETA.
    Higher GT vessel must be scheduled first (smaller or equal scheduled_start).
    """
    berth = discrete_berth("B1", capacity=1)
    v_high = make_vessel("HIGH", "2024-01-15T08:00:00", eslora=120, gt=50_000, target_berth="B1",
                          estimated_duration_h=24)
    v_low = make_vessel("LOW", "2024-01-15T08:00:00", eslora=100, gt=10_000, target_berth="B1",
                         estimated_duration_h=24)

    sched = Scheduler(num_pilots=10, num_tugs=10)
    assignments, _ = sched.schedule([v_high, v_low], [berth])

    a_high = next(a for a in assignments if a.vessel_id == "HIGH")
    a_low = next(a for a in assignments if a.vessel_id == "LOW")

    assert a_high.status == "assigned"
    assert a_low.status == "assigned"
    assert a_high.scheduled_start <= a_low.scheduled_start
    # High-GT vessel should have zero wait (it goes first)
    assert a_high.waiting_time_h == 0.0


def test_gt_priority_later_eta_higher_gt():
    """
    Higher-GT vessel arrives 2 h later but still goes first into a 1-slot berth
    because the lower-GT vessel is placed after it (lower priority).

    With GT sorting the higher-GT vessel is processed first regardless of ETA,
    so it gets the 0-wait slot.
    """
    berth = discrete_berth("B1", capacity=1)
    v_high = make_vessel("HIGH", "2024-01-15T10:00:00", eslora=120, gt=50_000, target_berth="B1",
                          estimated_duration_h=10)
    v_low = make_vessel("LOW", "2024-01-15T08:00:00", eslora=100, gt=10_000, target_berth="B1",
                         estimated_duration_h=10)

    sched = Scheduler(num_pilots=10, num_tugs=10)
    assignments, _ = sched.schedule([v_high, v_low], [berth])

    a_high = next(a for a in assignments if a.vessel_id == "HIGH")
    a_low = next(a for a in assignments if a.vessel_id == "LOW")

    assert a_high.status == "assigned"
    assert a_low.status == "assigned"
    # HIGH arrives at 10:00 and is scheduled first in GT order
    assert a_high.scheduled_start == datetime.fromisoformat("2024-01-15T10:00:00")
    # LOW must wait until HIGH finishes (10:00 + 10h = 20:00)
    assert a_low.scheduled_start >= datetime.fromisoformat("2024-01-15T20:00:00")


# ── Test 5: invalid berth ─────────────────────────────────────────────────────

def test_invalid_berth_not_in_config():
    """A vessel whose target_berth is absent from the config gets 'invalid_berth'."""
    berth = continuous_berth("REAL_BERTH", noray_max=100)
    v = make_vessel("V1", "2024-01-15T08:00:00", eslora=50, gt=5_000,
                    target_berth="NONEXISTENT", estimated_duration_h=12)

    sched = Scheduler(num_pilots=10, num_tugs=10)
    assignments, _ = sched.schedule([v], [berth])

    assert len(assignments) == 1
    assert assignments[0].status == "invalid_berth"


# ── Test 6: continuous berth — three simultaneous vessels no noray overlap ────

def test_continuous_three_vessels_no_noray_overlap():
    """
    Three vessels all arriving at the same ETA assigned to a wide continuous berth.
    They must all be scheduled simultaneously (same start time) and occupy
    non-overlapping noray ranges.
    """
    berth = continuous_berth("DOCK", noray_max=200)

    # 3 vessels, each ~60 m → 5 norays each, all fit at t=0
    vessels = [
        make_vessel(f"V{i}", "2024-01-15T08:00:00", eslora=60, gt=float(3 - i) * 1000,
                    target_berth="DOCK", estimated_duration_h=24)
        for i in range(3)
    ]

    sched = Scheduler(num_pilots=10, num_tugs=10)
    assignments, _ = sched.schedule(vessels, [berth])

    assigned = [a for a in assignments if a.status == "assigned"]
    assert len(assigned) == 3

    # All should start at the same time (no waiting)
    for a in assigned:
        assert a.waiting_time_h == 0.0

    # Noray ranges must not overlap
    ranges = [(a.noray_start, a.noray_end) for a in assigned]
    for i in range(len(ranges)):
        for j in range(i + 1, len(ranges)):
            s1, e1 = ranges[i]
            s2, e2 = ranges[j]
            # Non-overlapping: one ends before the other starts
            assert e1 < s2 or e2 < s1, f"Noray overlap: {ranges[i]} ∩ {ranges[j]}"


# ── Test 8: full pipeline without CSV ────────────────────────────────────────

def test_scheduler_without_csv():
    """Scheduler must work with calibration=None, using default duration."""
    berth = continuous_berth("B1", noray_max=100)
    vessels = [
        make_vessel("A", "2024-01-15T06:00:00", eslora=80, gt=20_000, target_berth="B1",
                    operations=[{"tipo_operacion": "Embarque", "grupo_mercancia": "Granel"}]),
        make_vessel("B", "2024-01-15T07:00:00", eslora=80, gt=10_000, target_berth="B1",
                    operations=[{"tipo_operacion": "Embarque", "grupo_mercancia": "Granel"}]),
    ]

    sched = Scheduler(calibration=None, default_duration_h=48.0, num_pilots=10, num_tugs=10)
    assignments, _ = sched.schedule(vessels, [berth])

    assigned = [a for a in assignments if a.status == "assigned"]
    assert len(assigned) == 2
    for a in assigned:
        assert a.duration_source == "default"
        assert a.duration_estimated_h == 48.0
