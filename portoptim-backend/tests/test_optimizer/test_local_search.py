"""
Local search tests.

Test 7 of the spec:
  7a. Swap never worsens total waiting time.
  7b. Swap never violates GT priority.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from optimizer.local_search import LocalSearch
from optimizer.models import BerthZone, OptimizationRequest
from optimizer.optimizer import Optimizer
from optimizer.scheduler import Scheduler

from .conftest import continuous_berth, discrete_berth, make_vessel, simple_config


# ── Test 7a: swap never worsens waiting time ──────────────────────────────────

def test_local_search_never_worsens_total_wait():
    """
    After local search, total waiting time must be ≤ greedy waiting time.
    We run both greedy + LS via the full Optimizer and check the KPI.
    """
    berth = discrete_berth("B1", capacity=1)
    vessels = [
        make_vessel(f"V{i}", f"2024-01-15T{8 + i:02d}:00:00", eslora=80,
                    gt=float((5 - i) * 1000), target_berth="B1",
                    estimated_duration_h=6)
        for i in range(5)
    ]
    cfg = simple_config([berth])
    request = OptimizationRequest(vessels=vessels, config=cfg)

    opt = Optimizer(calibration=None)
    result = opt.optimize(request)

    # improvement must be ≥ 0 (local search never makes it worse)
    assert result.kpis["improvement_vs_greedy_pct"] >= 0.0

    # Every assigned vessel must have wait ≥ 0
    for a in result.assignments:
        assert a["waiting_time_h"] >= 0.0


def test_local_search_improves_or_equal_on_all_same_eta():
    """
    Five vessels same ETA, single-slot discrete berth → greedy assigns in GT order.
    LS should leave the result the same or improve.  Either way total wait ≥ greedy.
    """
    berth = discrete_berth("B1", capacity=1)
    vessels = [
        make_vessel(f"V{i}", "2024-01-15T08:00:00", eslora=80,
                    gt=float(i * 1000 + 1000), target_berth="B1",
                    estimated_duration_h=8)
        for i in range(5)
    ]
    cfg = simple_config([berth])
    request = OptimizationRequest(vessels=vessels, config=cfg)

    opt = Optimizer(calibration=None)
    result = opt.optimize(request)

    assert result.kpis["improvement_vs_greedy_pct"] >= 0.0


# ── Test 7b: GT priority never violated after swap ────────────────────────────

def test_local_search_respects_gt_priority():
    """
    After LS, for any two vessels in the same berth that were simultaneously
    available, the higher-GT vessel must be scheduled no later than the lower-GT.
    """
    berth = continuous_berth("B1", noray_max=300)
    # 6 vessels all arriving at the same time with different GT
    vessels = [
        make_vessel(f"V{i}", "2024-01-15T08:00:00", eslora=60,
                    gt=float((6 - i) * 10_000), target_berth="B1",
                    estimated_duration_h=12)
        for i in range(6)
    ]
    cfg = simple_config([berth])
    request = OptimizationRequest(vessels=vessels, config=cfg)

    opt = Optimizer(calibration=None)
    result = opt.optimize(request)

    assigned = [a for a in result.assignments if a["status"] == "assigned"]
    # Build GT lookup
    gt_map = {v.id: v.gt for v in vessels}

    for i, a in enumerate(assigned):
        for b in assigned[i + 1 :]:
            t_a = datetime.fromisoformat(a["scheduled_start"])
            t_b = datetime.fromisoformat(b["scheduled_start"])
            eta_a = datetime.fromisoformat("2024-01-15T08:00:00")
            eta_b = datetime.fromisoformat("2024-01-15T08:00:00")
            first_start = min(t_a, t_b)
            # Both available simultaneously (both ETAs ≤ first_start)
            if eta_a <= first_start and eta_b <= first_start:
                if t_a > t_b:
                    # a is scheduled AFTER b — b must have ≥ GT than a
                    assert gt_map[b["vessel_id"]] >= gt_map[a["vessel_id"]], (
                        f"GT violation: {a['vessel_id']} (GT={gt_map[a['vessel_id']]}) "
                        f"scheduled after {b['vessel_id']} (GT={gt_map[b['vessel_id']]})"
                    )
