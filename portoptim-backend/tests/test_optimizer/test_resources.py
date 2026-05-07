"""
Unit tests for the required_tugs() business-rule function and ResourcePool.

Tests mirror the spec examples exactly.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from optimizer.models import required_tugs
from optimizer.scheduler import ResourcePool


# ── required_tugs unit tests ──────────────────────────────────────────────────

def test_required_tugs_very_small_vessel():
    """GT < 500 → 0 tugs regardless of cargo."""
    assert required_tugs(300, "Otras mercancías") == 0


def test_required_tugs_small_vessel():
    """500 ≤ GT < 3 000 → 1 tug base."""
    assert required_tugs(1500, "Otras mercancías") == 1


def test_required_tugs_hazardous_cargo_adds_one():
    """3 000 ≤ GT < 10 000, Energético cargo → 2 base + 1 hazard = 3."""
    assert required_tugs(5000, "Energético") == 3


def test_required_tugs_bow_thruster_reduces_one():
    """Same vessel with bow thruster → 2 base + 1 hazard − 1 bow = 2."""
    assert required_tugs(5000, "Energético", has_bow_thruster=True) == 2


def test_required_tugs_cap_at_four():
    """GT ≥ 40 000, Químicos → 4 base + 1 hazard = 5, capped at 4."""
    assert required_tugs(50_000, "Químicos") == 4


def test_required_tugs_medium_no_modifier():
    """10 000 ≤ GT < 40 000 → 3 tugs, normal cargo."""
    assert required_tugs(25_000, "Granel") == 3


def test_required_tugs_bow_thruster_never_negative():
    """GT < 500 → base 0, bow thruster cannot make it negative."""
    assert required_tugs(200, "Otras mercancías", has_bow_thruster=True) == 0


def test_required_tugs_bow_thruster_on_small_vessel():
    """1 base tug with bow thruster → 0 (minimum is 0)."""
    assert required_tugs(1000, "Otras mercancías", has_bow_thruster=True) == 0


def test_required_tugs_quimicos_medium_vessel():
    """3 000 ≤ GT < 10 000, Químicos → 2 base + 1 hazard = 3."""
    assert required_tugs(7_000, "Químicos") == 3


# ── ResourcePool unit tests ───────────────────────────────────────────────────

T0 = datetime(2024, 1, 15, 8, 0)   # 08:00


def test_pool_single_unit_immediately_free():
    pool = ResourcePool(1)
    assert pool.earliest_n_available(1, T0) == T0


def test_pool_allocate_then_busy():
    pool = ResourcePool(1)
    pool.allocate_n(1, T0, 1.0)          # busy 08:00–09:00
    t09 = T0 + timedelta(hours=1)
    assert pool.earliest_n_available(1, T0) == t09


def test_pool_two_units_one_busy():
    """With 2 units and 1 busy, still 1 free immediately."""
    pool = ResourcePool(2)
    pool.allocate_n(1, T0, 1.0)
    assert pool.earliest_n_available(1, T0) == T0


def test_pool_two_units_both_busy():
    """Both units busy → earliest_n_available(1) returns soonest free."""
    pool = ResourcePool(2)
    t1 = T0 + timedelta(hours=1)
    t2 = T0 + timedelta(hours=2)
    pool.allocate_n(1, T0, 1.0)          # unit A busy until T0+1h
    pool.allocate_n(1, T0, 2.0)          # unit B busy until T0+2h
    assert pool.earliest_n_available(1, T0) == t1
    assert pool.earliest_n_available(2, T0) == t2


def test_pool_gap_between_events():
    """
    Pre-book a unit for two non-overlapping windows (docking + undocking).
    The unit should be reported as free in the gap.
    """
    pool = ResourcePool(1)
    t_dock_end = T0 + timedelta(hours=1)   # 09:00
    t_undock = T0 + timedelta(hours=24)    # next day
    pool.allocate_n(1, T0, 1.0)            # docking: 08:00–09:00
    pool.allocate_n(1, t_undock, 1.0)      # undocking: 08:00+24h

    # Free at 09:00 (between the two bookings)
    assert pool.earliest_n_available(1, t_dock_end) == t_dock_end


def test_pool_n_zero_always_free():
    """Requesting 0 resources is always immediately available."""
    pool = ResourcePool(3)
    pool.allocate_n(3, T0, 10.0)
    assert pool.earliest_n_available(0, T0) == T0
