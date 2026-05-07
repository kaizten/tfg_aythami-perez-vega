"""
Phase 3 — Local search (intra-berth swap heuristic).

For each berth, tries all pairwise permutations (i, j) of the greedy sequence.
A swap is accepted only when:
  1. It does not violate the GT priority constraint (higher GT cannot follow
     lower GT if both vessels were available at the same moment).
  2. It strictly reduces the total waiting time of the group.

The berth schedule is re-simulated from scratch for each candidate ordering so
that noray positions are recomputed correctly.  Pilot / tug state from the
greedy phase is not re-checked here (resources are already committed).

Stopping criteria: 500 iterations or improvement < 0.5 % in the last 50.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

import structlog

from .models import AssignmentResult, BerthZone, VesselInput, norays_needed
from .scheduler import ContinuousBerthState, DiscreteBerthState, make_berth_state

logger = structlog.get_logger()

MAX_ITER = 500
STAGNATION_WINDOW = 50
MIN_IMPROVEMENT_RATIO = 0.005   # 0.5 %


class LocalSearch:
    def __init__(
        self,
        berths: list[BerthZone],
        vessels: list[VesselInput],
    ) -> None:
        self.berth_map: dict[str, BerthZone] = {b.berth_id: b for b in berths}
        self.vessel_map: dict[str, VesselInput] = {v.id: v for v in vessels}

    # ── Public API ─────────────────────────────────────────────────────────────

    def improve(
        self,
        assignments: list[AssignmentResult],
        initial_states: Optional[dict[str, ContinuousBerthState | DiscreteBerthState]] = None,
    ) -> tuple[list[AssignmentResult], float]:
        """
        Returns (improved_assignments, improvement_pct).

        improvement_pct is relative to the greedy solution total waiting time.

        initial_states: berth states *before* the current batch was scheduled
        (e.g. end-of-previous-day states).  Each simulation for this batch
        starts from a copy of that state so previous-day occupancy is respected.
        """
        # Split by berth
        berth_groups: dict[str, list[AssignmentResult]] = {}
        others: list[AssignmentResult] = []
        for a in assignments:
            if a.status == "assigned":
                berth_groups.setdefault(a.berth_id, []).append(a)
            else:
                others.append(a)

        greedy_total = sum(
            a.waiting_time_h for group in berth_groups.values() for a in group
        )

        improved: list[AssignmentResult] = list(others)
        for bid, group in berth_groups.items():
            init = initial_states.get(bid) if initial_states else None
            improved.extend(self._improve_berth(bid, group, init))

        final_total = sum(a.waiting_time_h for a in improved if a.status == "assigned")
        pct = (
            (greedy_total - final_total) / greedy_total * 100
            if greedy_total > 0
            else 0.0
        )
        logger.info(
            "local_search_complete",
            greedy_waiting_h=round(greedy_total, 2),
            final_waiting_h=round(final_total, 2),
            improvement_pct=round(pct, 2),
        )
        return improved, pct

    # ── Per-berth improvement ─────────────────────────────────────────────────

    def _improve_berth(
        self,
        bid: str,
        group: list[AssignmentResult],
        initial_state: Optional[ContinuousBerthState | DiscreteBerthState] = None,
    ) -> list[AssignmentResult]:
        if len(group) < 2:
            return group

        berth = self.berth_map.get(bid)
        if berth is None:
            return group

        vessels_in_order = self._ordered_vessels(group)
        if vessels_in_order is None:
            return group

        dur_map = {a.vessel_id: (a.duration_estimated_h, a.duration_source) for a in group}

        best_order = vessels_in_order[:]
        best_waits = self._simulate(berth, best_order, dur_map, initial_state)
        best_total = sum(w for w, *_ in best_waits)

        recent_improvements: list[bool] = []

        for iteration in range(MAX_ITER):
            made_progress = False

            for i in range(len(best_order)):
                for j in range(i + 1, len(best_order)):
                    candidate = best_order[:]
                    candidate[i], candidate[j] = candidate[j], candidate[i]

                    # Check GT hard constraint before simulating
                    if not self._gt_constraint_ok(berth, candidate, dur_map, initial_state):
                        continue

                    waits = self._simulate(berth, candidate, dur_map, initial_state)
                    total = sum(w for w, *_ in waits)

                    if total < best_total - 1e-9:
                        best_order = candidate
                        best_waits = waits
                        best_total = total
                        made_progress = True

            recent_improvements.append(made_progress)

            # Check stagnation
            if len(recent_improvements) >= STAGNATION_WINDOW:
                window = recent_improvements[-STAGNATION_WINDOW:]
                if not any(window):
                    break

        logger.info(
            "berth_local_search_done",
            berth_id=bid,
            iterations=iteration + 1,
            final_waiting_h=round(best_total, 2),
        )
        return self._build_results(berth, best_order, best_waits, group)

    # ── Simulation ────────────────────────────────────────────────────────────

    def _simulate(
        self,
        berth: BerthZone,
        vessel_order: list[VesselInput],
        dur_map: dict[str, tuple[float, str]],
        initial_state: Optional[ContinuousBerthState | DiscreteBerthState] = None,
    ) -> list[tuple[float, Optional[int], Optional[int], datetime]]:
        """
        Simulate berth scheduling for a given vessel order (no pilot/tug constraints).
        Returns list of (wait_h, noray_start, noray_end, t_start) per vessel.

        initial_state: if provided, simulation starts from a copy of this state
        (representing berth occupancy from previous day batches).
        """
        state = initial_state.copy() if initial_state is not None else make_berth_state(berth)
        results: list[tuple[float, Optional[int], Optional[int], datetime]] = []

        for v in vessel_order:
            dur_h, _ = dur_map[v.id]
            if isinstance(state, ContinuousBerthState):
                res = state.find_slot(v.eslora, v.eta, dur_h)
                if res is None:
                    results.append((0.0, None, None, v.eta))
                    continue
                ns, t = res
                ne = ns + norays_needed(v.eslora) - 1
                state.assign(ns, ne, t, t + timedelta(hours=dur_h), v.id)
                wait = max(0.0, (t - v.eta).total_seconds() / 3600)
                results.append((wait, ns, ne, t))
            else:
                res = state.find_slot(v.eta, dur_h)
                if res is None:
                    results.append((0.0, None, None, v.eta))
                    continue
                si, t = res
                state.assign(si, t, t + timedelta(hours=dur_h), v.id)
                wait = max(0.0, (t - v.eta).total_seconds() / 3600)
                results.append((wait, None, None, t))

        return results

    # ── GT constraint check ───────────────────────────────────────────────────

    def _gt_constraint_ok(
        self,
        berth: BerthZone,
        vessel_order: list[VesselInput],
        dur_map: dict[str, tuple[float, str]],
        initial_state: Optional[ContinuousBerthState | DiscreteBerthState] = None,
    ) -> bool:
        """
        Hard rule: a higher-GT vessel must not follow a lower-GT vessel in the
        sequence if both are already available (ETA ≤ first_scheduled_start).

        We check this by simulating start times and then verifying pairwise order.
        """
        waits = self._simulate(berth, vessel_order, dur_map, initial_state)
        t_starts = [row[3] for row in waits]

        for i in range(len(vessel_order)):
            for j in range(i + 1, len(vessel_order)):
                vi = vessel_order[i]
                vj = vessel_order[j]
                # vj comes after vi in the sequence
                if vj.gt > vi.gt:
                    # Higher-GT vessel is later — only allowed if it was not yet available
                    # when the lower-GT vessel started
                    t_first = t_starts[i]
                    if vj.eta <= t_first:
                        return False  # vj was available but gets deferred — violation
        return True

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _ordered_vessels(
        self, group: list[AssignmentResult]
    ) -> Optional[list[VesselInput]]:
        ordered: list[VesselInput] = []
        for a in sorted(group, key=lambda x: x.scheduled_start):
            v = self.vessel_map.get(a.vessel_id)
            if v is None:
                return None
            ordered.append(v)
        return ordered

    def _build_results(
        self,
        berth: BerthZone,
        vessel_order: list[VesselInput],
        waits: list[tuple[float, Optional[int], Optional[int], datetime]],
        original_group: list[AssignmentResult],
    ) -> list[AssignmentResult]:
        orig_map = {a.vessel_id: a for a in original_group}
        new_results: list[AssignmentResult] = []
        for v, (wait_h, ns, ne, t_start) in zip(vessel_order, waits):
            orig = orig_map[v.id]
            dur_h = orig.duration_estimated_h
            new_results.append(
                AssignmentResult(
                    vessel_id=v.id,
                    berth_id=berth.berth_id,
                    noray_start=ns,
                    noray_end=ne,
                    scheduled_start=t_start,
                    scheduled_end=t_start + timedelta(hours=dur_h),
                    waiting_time_h=wait_h,
                    duration_estimated_h=dur_h,
                    duration_source=orig.duration_source,
                    pilot_assigned=orig.pilot_assigned,
                    tugs_required=orig.tugs_required,
                    tugs_assigned=orig.tugs_assigned,
                    status=orig.status,
                    pilot_caused_delay=orig.pilot_caused_delay,
                    tug_caused_delay=orig.tug_caused_delay,
                    caused_delay_to=[],  # recomputed by optimizer after all LS rounds
                )
            )
        return new_results
