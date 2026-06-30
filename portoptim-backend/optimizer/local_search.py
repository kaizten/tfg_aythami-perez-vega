"""Phase 3 — Local search: improves greedy assignments via intra-berth pairwise swap heuristic."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

import structlog

from .models import AssignmentResult, BerthZone, VesselInput, build_phases, norays_needed
from .scheduler import ContinuousBerthState, DiscreteBerthState, ResourcePool, make_berth_state

logger = structlog.get_logger()

# Fixed - maximum number of swap iterations before stopping
MAX_ITER = 500
# Fixed - number of recent iterations examined for stagnation detection
STAGNATION_WINDOW = 50
# Fixed - minimum fractional improvement required within the stagnation window to continue
MIN_IMPROVEMENT_RATIO = 0.005


class LocalSearch:
    """
    Local search optimizer that improves berth schedules by trying pairwise vessel swaps.

    For each berth, all pairwise permutations of the greedy sequence are tested. A swap is
    accepted only when it does not violate GT priority and strictly reduces total waiting time.
    """

    def __init__(
        self,
        berths: list[BerthZone],
        vessels: list[VesselInput],
        num_pilots: int = 3,
        num_tugs: int = 2,
    ) -> None:
        """
        Initialize the local search with berth and vessel data and resource counts.

        Args:
            berths (list[BerthZone]): All berths available in the port. Required.
            vessels (list[VesselInput]): All vessels in the current optimization batch. Required.
            num_pilots (int): Total number of pilots available in the shift. Optional, defaults to 3.
            num_tugs (int): Total number of tugs available in the shift. Optional, defaults to 2.
        """
        # Computed - berth configuration lookup by berth_id
        self.berth_map: dict[str, BerthZone] = {b.berth_id: b for b in berths}
        # Computed - vessel input lookup by vessel id
        self.vessel_map: dict[str, VesselInput] = {v.id: v for v in vessels}
        # User-provided - total pilots available for resource simulation
        self.num_pilots = num_pilots
        # User-provided - total tugs available for resource simulation
        self.num_tugs = num_tugs

    def improve(
        self,
        assignments: list[AssignmentResult],
        initial_states: Optional[dict[str, ContinuousBerthState | DiscreteBerthState]] = None,
    ) -> tuple[list[AssignmentResult], float]:
        """
        Improve the greedy assignment schedule using intra-berth pairwise swaps.

        Berths are processed sequentially. Before each berth, background ResourcePools are
        built from all other berths' current-best schedules so that cross-berth resource
        pressure is visible during candidate evaluation.

        Args:
            assignments (list[AssignmentResult]): Greedy assignments to improve. Required.
            initial_states (dict): Berth states before the current batch, used to respect prior-day occupancy in simulations. Optional, defaults to None.

        Returns:
            tuple[list[AssignmentResult], float]: Pair of (improved_assignments, improvement_pct)
                where improvement_pct is relative to the greedy solution total waiting time.
        """
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

        current_best_by_berth: dict[str, list[AssignmentResult]] = {
            bid: list(group) for bid, group in berth_groups.items()
        }

        improved: list[AssignmentResult] = list(others)
        for bid, group in berth_groups.items():
            init = initial_states.get(bid) if initial_states else None

            bg_pilots, bg_tugs = self._build_background_pools(
                current_best_by_berth, exclude_berth=bid
            )

            best_group = self._improve_berth(bid, group, init, bg_pilots, bg_tugs)
            current_best_by_berth[bid] = best_group
            improved.extend(best_group)

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

    def _build_background_pools(
        self,
        berth_assignments: dict[str, list[AssignmentResult]],
        exclude_berth: str,
    ) -> tuple[ResourcePool, ResourcePool]:
        """
        Build pilot and tug ResourcePools pre-loaded with manoeuvre commitments from all berths except exclude_berth.

        Args:
            berth_assignments (dict[str, list[AssignmentResult]]): Current-best assignments keyed by berth_id. Required.
            exclude_berth (str): Berth to exclude so its resource usage is not double-counted during simulation. Required.

        Returns:
            tuple[ResourcePool, ResourcePool]: Pair of (background_pilots, background_tugs) pools.
        """
        pilots = ResourcePool(self.num_pilots)
        tugs   = ResourcePool(self.num_tugs)
        for bid, group in berth_assignments.items():
            if bid == exclude_berth:
                continue
            for a in group:
                if a.status != "assigned":
                    continue
                mh = a.maneuver_h
                n  = a.tugs_required
                pilots.allocate_n(1, a.scheduled_start, mh)
                tugs.allocate_n(n,  a.scheduled_start, mh)
                undock_start = a.scheduled_end - timedelta(hours=mh)
                pilots.allocate_n(1, undock_start, mh)
                tugs.allocate_n(n,  undock_start, mh)
        return pilots, tugs

    def _improve_berth(
        self,
        bid: str,
        group: list[AssignmentResult],
        initial_state: Optional[ContinuousBerthState | DiscreteBerthState] = None,
        background_pilots: Optional[ResourcePool] = None,
        background_tugs: Optional[ResourcePool] = None,
    ) -> list[AssignmentResult]:
        """
        Run the pairwise swap heuristic for one berth and return the best vessel ordering found.

        Args:
            bid (str): Berth identifier being optimized. Required.
            group (list[AssignmentResult]): Greedy assignments for this berth. Required.
            initial_state (ContinuousBerthState | DiscreteBerthState): Prior-day berth occupancy state for simulation. Optional, defaults to None.
            background_pilots (ResourcePool): Pilot commitments from other berths. Optional, defaults to None.
            background_tugs (ResourcePool): Tug commitments from other berths. Optional, defaults to None.

        Returns:
            list[AssignmentResult]: Improved assignments for this berth.
        """
        if len(group) < 2:
            return group

        berth = self.berth_map.get(bid)
        if berth is None:
            return group

        vessels_in_order = self._ordered_vessels(group)
        if vessels_in_order is None:
            return group

        dur_map = {
            a.vessel_id: (
                a.duration_estimated_h,
                a.duration_source,
                a.tugs_required,
                a.maneuver_h,
            )
            for a in group
        }

        best_order = vessels_in_order[:]
        best_waits = self._simulate(
            berth, best_order, dur_map, initial_state,
            background_pilots, background_tugs,
        )
        best_total = sum(w for w, *_ in best_waits)

        recent_improvements: list[bool] = []

        for iteration in range(MAX_ITER):
            made_progress = False

            for i in range(len(best_order)):
                for j in range(i + 1, len(best_order)):
                    candidate = best_order[:]
                    candidate[i], candidate[j] = candidate[j], candidate[i]

                    if not self._gt_constraint_ok(
                        berth, candidate, dur_map, initial_state,
                        background_pilots, background_tugs,
                    ):
                        continue

                    waits = self._simulate(
                        berth, candidate, dur_map, initial_state,
                        background_pilots, background_tugs,
                    )
                    total = sum(w for w, *_ in waits)

                    if total < best_total - 1e-9:
                        best_order = candidate
                        best_waits = waits
                        best_total = total
                        made_progress = True

            recent_improvements.append(made_progress)

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

    def _simulate(
        self,
        berth: BerthZone,
        vessel_order: list[VesselInput],
        dur_map: dict[str, tuple],
        initial_state: Optional[ContinuousBerthState | DiscreteBerthState] = None,
        background_pilots: Optional[ResourcePool] = None,
        background_tugs: Optional[ResourcePool] = None,
    ) -> list[tuple[float, Optional[int], Optional[int], datetime]]:
        """
        Simulate berth and resource scheduling for a given vessel ordering.

        Background pools are deep-copied so allocations for this candidate do not mutate the caller's pools.

        Args:
            berth (BerthZone): Berth configuration for the simulation. Required.
            vessel_order (list[VesselInput]): Vessels in the order to simulate. Required.
            dur_map (dict[str, tuple]): Mapping of vessel_id to (dur_h, src, n_tugs, maneuver_h). Required.
            initial_state (ContinuousBerthState | DiscreteBerthState): Prior-day state to start from. Optional, defaults to None.
            background_pilots (ResourcePool): Pilot commitments from other berths. Optional, defaults to None.
            background_tugs (ResourcePool): Tug commitments from other berths. Optional, defaults to None.

        Returns:
            list[tuple[float, Optional[int], Optional[int], datetime]]: Per-vessel list of (wait_h, noray_start, noray_end, t_start).
        """
        state = initial_state.copy() if initial_state is not None else make_berth_state(berth)
        pilots = background_pilots.copy() if background_pilots is not None else ResourcePool(self.num_pilots)
        tugs   = background_tugs.copy()   if background_tugs   is not None else ResourcePool(self.num_tugs)

        results: list[tuple[float, Optional[int], Optional[int], datetime]] = []

        for v in vessel_order:
            dur_h, _, n_tugs, mh = dur_map[v.id]

            if isinstance(state, ContinuousBerthState):
                res = state.find_slot(v.eslora, v.eta, dur_h)
                if res is None:
                    results.append((0.0, None, None, v.eta))
                    continue
                ns, t_start = res
                ne = ns + norays_needed(v.eslora) - 1
            else:
                res = state.find_slot(v.eta, dur_h)
                if res is None:
                    results.append((0.0, None, None, v.eta))
                    continue
                ns, t_start = res
                ne = ns

            for _ in range(8):
                pilot_ok = pilots.earliest_n_available(1,      t_start, duration_h=mh)
                tug_ok   = tugs.earliest_n_available(n_tugs,   t_start, duration_h=mh)
                resource_start = max(pilot_ok, tug_ok)
                if resource_start <= t_start:
                    break
                if isinstance(state, ContinuousBerthState):
                    res = state.find_slot(v.eslora, resource_start, dur_h)
                    if res is None:
                        break
                    ns, t_start = res
                    ne = ns + norays_needed(v.eslora) - 1
                else:
                    res = state.find_slot(resource_start, dur_h)
                    if res is None:
                        break
                    ns, t_start = res
                    ne = ns

            t_end = t_start + timedelta(hours=dur_h)
            if isinstance(state, ContinuousBerthState):
                state.assign(ns, ne, t_start, t_end, v.id)
            else:
                state.assign(ns, t_start, t_end, v.id)

            pilots.allocate_n(1,      t_start, mh)
            tugs.allocate_n(n_tugs,   t_start, mh)
            undock_start = t_end - timedelta(hours=mh)
            pilots.allocate_n(1,      undock_start, mh)
            tugs.allocate_n(n_tugs,   undock_start, mh)

            wait = max(0.0, (t_start - v.eta).total_seconds() / 3600)
            results.append((wait, ns, ne, t_start))

        return results

    def _gt_constraint_ok(
        self,
        berth: BerthZone,
        vessel_order: list[VesselInput],
        dur_map: dict[str, tuple],
        initial_state: Optional[ContinuousBerthState | DiscreteBerthState] = None,
        background_pilots: Optional[ResourcePool] = None,
        background_tugs: Optional[ResourcePool] = None,
    ) -> bool:
        """
        Check whether a candidate vessel ordering respects the GT priority hard constraint.

        A higher-GT vessel must not follow a lower-GT vessel in the sequence if the higher-GT
        vessel was already available (ETA at or before the lower-GT vessel's scheduled start).

        Args:
            berth (BerthZone): Berth configuration for the simulation. Required.
            vessel_order (list[VesselInput]): Candidate vessel ordering to validate. Required.
            dur_map (dict[str, tuple]): Mapping of vessel_id to (dur_h, src, n_tugs, maneuver_h). Required.
            initial_state (ContinuousBerthState | DiscreteBerthState): Prior-day state for simulation. Optional, defaults to None.
            background_pilots (ResourcePool): Pilot commitments from other berths. Optional, defaults to None.
            background_tugs (ResourcePool): Tug commitments from other berths. Optional, defaults to None.

        Returns:
            bool: True when the ordering satisfies the GT priority constraint, False otherwise.
        """
        waits = self._simulate(
            berth, vessel_order, dur_map, initial_state,
            background_pilots, background_tugs,
        )
        t_starts = [row[3] for row in waits]

        for i in range(len(vessel_order)):
            for j in range(i + 1, len(vessel_order)):
                vi = vessel_order[i]
                vj = vessel_order[j]
                if vj.gt > vi.gt:
                    t_first = t_starts[i]
                    if vj.eta <= t_first:
                        return False
        return True

    def _ordered_vessels(
        self, group: list[AssignmentResult]
    ) -> Optional[list[VesselInput]]:
        """
        Return vessels from an assignment group sorted by scheduled_start, or None if any vessel is missing.

        Args:
            group (list[AssignmentResult]): Assignment results for one berth. Required.

        Returns:
            Optional[list[VesselInput]]: Ordered list of VesselInput objects, or None if a vessel_id is not found in vessel_map.
        """
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
        """
        Build the final AssignmentResult list from the best vessel ordering and simulation output.

        Args:
            berth (BerthZone): Berth configuration for this group. Required.
            vessel_order (list[VesselInput]): Best vessel ordering found by the swap heuristic. Required.
            waits (list[tuple]): Simulation results corresponding to vessel_order; each tuple is (wait_h, noray_start, noray_end, t_start). Required.
            original_group (list[AssignmentResult]): Original greedy assignments, used to carry over metadata. Required.

        Returns:
            list[AssignmentResult]: Updated assignment results reflecting the improved ordering.
        """
        orig_map = {a.vessel_id: a for a in original_group}
        new_results: list[AssignmentResult] = []
        for v, (wait_h, ns, ne, t_start) in zip(vessel_order, waits):
            orig = orig_map[v.id]
            dur_h = orig.duration_estimated_h
            t_end = t_start + timedelta(hours=dur_h)
            vessel_phases = build_phases(
                eta=v.eta,
                scheduled_start=t_start,
                scheduled_end=t_end,
                waiting_time_h=wait_h,
                duration_estimated_h=dur_h,
                maneuver_h=orig.maneuver_h,
            )
            new_results.append(
                AssignmentResult(
                    vessel_id=v.id,
                    berth_id=berth.berth_id,
                    noray_start=ns,
                    noray_end=ne,
                    scheduled_start=t_start,
                    scheduled_end=t_end,
                    waiting_time_h=wait_h,
                    duration_estimated_h=dur_h,
                    duration_source=orig.duration_source,
                    pilot_assigned=orig.pilot_assigned,
                    tugs_required=orig.tugs_required,
                    tugs_assigned=orig.tugs_assigned,
                    status=orig.status,
                    pilot_caused_delay=orig.pilot_caused_delay,
                    tug_caused_delay=orig.tug_caused_delay,
                    caused_delay_to=[],
                    maneuver_h=orig.maneuver_h,
                    phases=vessel_phases,
                )
            )
        return new_results
