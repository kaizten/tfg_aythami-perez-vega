"""
Orchestrator — combines calibration, greedy scheduling, and local search.

Vessels are partitioned by ETA date and optimised one day at a time.  Berth
states carry over between days (a vessel docked on day N still occupies space
on day N+1).  Resource pools (pilots, tugs) reset each day, matching the
assumption of per-shift crewing.

Usage (no CSV):
    opt = Optimizer()
    result = opt.optimize(request)

Usage (with CSV calibration):
    cal = Calibration(csv_path="historico.csv")
    opt = Optimizer(calibration=cal)
    result = opt.optimize(request)
"""

from __future__ import annotations

from typing import Optional

import structlog

from .calibration import Calibration
from .local_search import LocalSearch
from .models import (
    AssignmentResult,
    BerthZone,
    OptimizationRequest,
    OptimizationResponse,
)
from .scheduler import (
    ContinuousBerthState,
    DiscreteBerthState,
    Scheduler,
    _fill_caused_delay,
    make_berth_state,
)

logger = structlog.get_logger()


# ── State-rebuild helper ──────────────────────────────────────────────────────

def _rebuild_states_from_assignments(
    assignments: list[AssignmentResult],
    berths: list[BerthZone],
) -> dict[str, ContinuousBerthState | DiscreteBerthState]:
    """
    Reconstruct berth states from a list of final assignments.

    Used to carry occupancy forward between day batches after local search
    may have altered scheduled_start / noray positions vs. the greedy output.
    """
    states: dict[str, ContinuousBerthState | DiscreteBerthState] = {
        b.berth_id: make_berth_state(b) for b in berths
    }
    for a in sorted(assignments, key=lambda x: x.scheduled_start):
        if a.status != "assigned":
            continue
        state = states.get(a.berth_id)
        if state is None:
            continue
        if isinstance(state, ContinuousBerthState):
            if a.noray_start is not None and a.noray_end is not None:
                state.assign(
                    a.noray_start, a.noray_end,
                    a.scheduled_start, a.scheduled_end,
                    a.vessel_id,
                )
        else:
            # Discrete: re-apply to whichever slot becomes available first
            dur_h = (a.scheduled_end - a.scheduled_start).total_seconds() / 3600
            res = state.find_slot(a.scheduled_start, dur_h)
            if res is not None:
                si, _ = res
                state.assign(si, a.scheduled_start, a.scheduled_end, a.vessel_id)
    return states


# ── Optimizer ─────────────────────────────────────────────────────────────────

class Optimizer:
    def __init__(self, calibration: Optional[Calibration] = None) -> None:
        self.calibration = calibration

    def optimize(self, request: OptimizationRequest) -> OptimizationResponse:
        cfg = request.config
        berths = cfg.mooring_zones

        logger.info(
            "optimization_start",
            n_vessels=len(request.vessels),
            n_berths=len(berths),
            num_pilots=cfg.num_pilots,
            num_tugs=cfg.num_tugs,
        )

        # ── Partition vessels by ETA date ─────────────────────────────────────
        day_groups: dict = {}
        for v in sorted(request.vessels, key=lambda v: v.eta.date()):
            day_groups.setdefault(v.eta.date(), []).append(v)

        all_assignments: list[AssignmentResult] = []
        total_greedy_wait = 0.0
        total_conflicts = 0
        # carry_states is None on the first day → Scheduler creates empty states
        carry_states: Optional[dict[str, ContinuousBerthState | DiscreteBerthState]] = None

        for day_date in sorted(day_groups):
            day_vessels = day_groups[day_date]

            # Snapshot of states *before* this day's vessels are added
            states_before_day = (
                {bid: s.copy() for bid, s in carry_states.items()}
                if carry_states is not None
                else None
            )

            # Phase 2 — greedy (fresh resource pools each day)
            scheduler = Scheduler(
                calibration=self.calibration,
                default_duration_h=cfg.default_duration_h,
                overlap_factor=cfg.overlap_factor,
                num_pilots=cfg.num_pilots,
                num_tugs=cfg.num_tugs,
            )
            day_assignments, conflicts = scheduler.schedule(
                day_vessels, berths, initial_states=states_before_day
            )
            total_conflicts += conflicts
            total_greedy_wait += sum(
                a.waiting_time_h for a in day_assignments if a.status == "assigned"
            )

            # Phase 3 — local search on today's vessels only
            ls = LocalSearch(berths=berths, vessels=day_vessels)
            day_final, _ = ls.improve(day_assignments, initial_states=states_before_day)

            all_assignments.extend(day_final)

            # Rebuild carry states from *all* assignments so far for next day
            carry_states = _rebuild_states_from_assignments(all_assignments, berths)

            logger.info(
                "day_batch_done",
                date=str(day_date),
                n_vessels=len(day_vessels),
                greedy_wait=round(
                    sum(a.waiting_time_h for a in day_assignments if a.status == "assigned"), 2
                ),
            )

        # ── Recompute caused_delay_to after all LS reorderings ────────────────
        groups: dict[str, list] = {}
        for v in request.vessels:
            groups.setdefault(v.target_berth, []).append(v)
        for bid in groups:
            groups[bid].sort(key=lambda v: v.gt, reverse=True)
        _fill_caused_delay(all_assignments, groups)

        # ── KPIs ──────────────────────────────────────────────────────────────
        final_wait = sum(
            a.waiting_time_h for a in all_assignments if a.status == "assigned"
        )
        improvement_pct = (
            (total_greedy_wait - final_wait) / total_greedy_wait * 100
            if total_greedy_wait > 0
            else 0.0
        )
        kpis = self._compute_kpis(
            all_assignments, berths, total_greedy_wait, total_conflicts, improvement_pct
        )

        logger.info(
            "optimization_complete",
            total_waiting_h=kpis["total_waiting_time_h"],
            improvement_pct=kpis["improvement_vs_greedy_pct"],
            conflicts_resolved=total_conflicts,
            unresolved=kpis["unresolved_vessels"],
        )

        return OptimizationResponse(
            assignments=[_to_dict(a) for a in all_assignments],
            kpis=kpis,
        )

    # ── KPI computation ───────────────────────────────────────────────────────

    def _compute_kpis(
        self,
        assignments: list[AssignmentResult],
        berths: list[BerthZone],
        greedy_wait: float,
        conflicts: int,
        improvement_pct: float,
    ) -> dict:
        assigned = [a for a in assignments if a.status == "assigned"]
        total_wait = sum(a.waiting_time_h for a in assigned)
        avg_wait = total_wait / len(assigned) if assigned else 0.0

        # Berth utilization: fraction of the global time window that each berth is occupied
        berth_util: dict[str, float] = {}
        if assigned:
            global_start = min(a.scheduled_start for a in assigned)
            global_end = max(a.scheduled_end for a in assigned)
            window_h = (global_end - global_start).total_seconds() / 3600
            for b in berths:
                berth_assigned = [a for a in assigned if a.berth_id == b.berth_id]
                if not berth_assigned or window_h <= 0:
                    berth_util[b.berth_id] = 0.0
                    continue
                occupied_h = sum(a.duration_estimated_h for a in berth_assigned)
                capacity = b.noray_max if b.bap_type == "continuous" else (b.capacity or 1)
                berth_util[b.berth_id] = round(
                    min(100.0, occupied_h / ((capacity or 1) * window_h) * 100), 1
                )
        else:
            berth_util = {b.berth_id: 0.0 for b in berths}

        # Duration source breakdown (only for vessels that got a schedule attempt)
        source_breakdown: dict[str, int] = {}
        for a in assignments:
            if a.status == "invalid_berth":
                continue
            source_breakdown[a.duration_source] = (
                source_breakdown.get(a.duration_source, 0) + 1
            )

        unresolved = sum(1 for a in assignments if a.status != "assigned")

        actual_improvement = (
            (greedy_wait - total_wait) / greedy_wait * 100 if greedy_wait > 0 else 0.0
        )

        return {
            "total_waiting_time_h": round(total_wait, 2),
            "avg_waiting_time_h": round(avg_wait, 2),
            "berth_utilization": berth_util,
            "unresolved_vessels": unresolved,
            "improvement_vs_greedy_pct": round(actual_improvement, 2),
            "conflicts_resolved": conflicts,
            "duration_source_breakdown": source_breakdown,
            "resource_delays": {
                "pilot_caused": sum(1 for a in assigned if a.pilot_caused_delay),
                "tug_caused": sum(1 for a in assigned if a.tug_caused_delay),
            },
        }


# ── Serialisation helper ──────────────────────────────────────────────────────

def _to_dict(a: AssignmentResult) -> dict:
    return {
        "vessel_id": a.vessel_id,
        "berth_id": a.berth_id,
        "noray_start": a.noray_start,
        "noray_end": a.noray_end,
        "scheduled_start": a.scheduled_start.isoformat(),
        "scheduled_end": a.scheduled_end.isoformat(),
        "waiting_time_h": round(a.waiting_time_h, 2),
        "duration_estimated_h": round(a.duration_estimated_h, 2),
        "duration_source": a.duration_source,
        "pilot_assigned": a.pilot_assigned,
        "tugs_required": a.tugs_required,
        "tugs_assigned": a.tugs_assigned,
        "status": a.status,
        "caused_delay_to": a.caused_delay_to,
    }
