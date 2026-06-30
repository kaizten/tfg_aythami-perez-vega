"""Phase 2 — Greedy scheduler: assigns vessels to berths in GT-descending order within each berth group."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

import structlog

from .calibration import Calibration
from .duration import DurationEstimator
from .models import (
    AssignmentResult,
    BerthZone,
    OperationPhase,
    VesselInput,
    DOCKING_DURATION_H,
    build_phases,
    norays_needed,
    required_tugs,
)


def estimate_maneuver_duration(
    eslora: float,
    grupo_mercancia: str,
    calibration: Optional[Calibration],
) -> float:
    """
    Return the estimated duration of a single docking or undocking manoeuvre in hours.

    Queries the calibration maneuver_model when available; falls back to
    0.5 h for normal cargo and 0.8 h for hazardous cargo when calibration is absent.

    Args:
        eslora (float): Vessel length in metres. Required.
        grupo_mercancia (str): Cargo group identifier used to detect hazardous cargo. Required.
        calibration (Calibration): Fitted calibration object, or None to use the formula fallback. Required.

    Returns:
        float: Estimated single manoeuvre duration in hours, always greater than 0.
    """
    if calibration is not None:
        return calibration.get_maneuver_duration(eslora, grupo_mercancia)
    from .calibration import HAZARDOUS_CARGO_GROUPS
    hazardous = grupo_mercancia in HAZARDOUS_CARGO_GROUPS
    return 0.5 + (0.3 if hazardous else 0.0)

logger = structlog.get_logger()


class ResourcePool:
    """
    Pool of N identical resources (pilots or tugs) with per-unit busy-interval tracking.

    Tracks availability via disjoint busy-interval lists per unit so that the two-phase
    consumption model (docking manoeuvre and undocking manoeuvre) is represented correctly.
    """

    def __init__(self, count: int) -> None:
        """
        Initialize the resource pool with the given number of identical units.

        Args:
            count (int): Number of resource units in the pool; clamped to at least 1. Required.
        """
        self._count = max(count, 1)
        # Computed - per-unit sorted list of (start, end) busy intervals
        self._intervals: list[list[tuple[datetime, datetime]]] = [
            [] for _ in range(self._count)
        ]

    def _free_from(self, idx: int, from_time: datetime) -> datetime:
        """
        Return the earliest time at or after from_time when unit idx is free.

        Args:
            idx (int): Index of the resource unit to check. Required.
            from_time (datetime): Earliest time to consider. Required.

        Returns:
            datetime: Earliest free instant for this unit.
        """
        t = from_time
        changed = True
        while changed:
            changed = False
            for iv_start, iv_end in self._intervals[idx]:
                if iv_start <= t < iv_end:
                    t = iv_end
                    changed = True
        return t

    def _free_from_for_duration(self, idx: int, from_time: datetime, duration_h: float) -> datetime:
        """
        Return the earliest time T at or after from_time when unit idx is free for the full window [T, T + duration_h).

        Unlike _free_from, this method advances T past any interval that overlaps the target window,
        preventing resource over-booking in adjacent time slots.

        Args:
            idx (int): Index of the resource unit to check. Required.
            from_time (datetime): Earliest start of the required free window. Required.
            duration_h (float): Length of the required free window in hours. Required.

        Returns:
            datetime: Earliest start time for a conflict-free window of the requested duration.
        """
        window = timedelta(hours=duration_h)
        t = from_time
        changed = True
        while changed:
            changed = False
            t_end = t + window
            for iv_start, iv_end in self._intervals[idx]:
                if iv_start < t_end and iv_end > t:
                    t = iv_end
                    changed = True
                    break
        return t

    def earliest_n_available(self, n: int, from_time: datetime, duration_h: float = 0.0) -> datetime:
        """
        Return the earliest time at or after from_time when at least n units are simultaneously free.

        Uses an iterative approach that strictly advances the candidate time on each round,
        guaranteeing termination. Returns from_time immediately when n <= 0.

        Args:
            n (int): Number of units that must be simultaneously free. Required.
            from_time (datetime): Earliest time to start searching from. Required.
            duration_h (float): Duration in hours for which all n units must remain free. Optional, defaults to 0.0.

        Returns:
            datetime: Earliest time when n units are simultaneously free for duration_h hours.
        """
        if n <= 0:
            return from_time
        n = min(n, self._count)
        t = from_time
        while True:
            if duration_h > 0.0:
                free_times = sorted(
                    self._free_from_for_duration(i, t, duration_h)
                    for i in range(self._count)
                )
            else:
                free_times = sorted(self._free_from(i, t) for i in range(self._count))
            candidate = free_times[n - 1]
            if candidate <= t:
                return t
            t = candidate

    def copy(self) -> "ResourcePool":
        """
        Return a deep copy of this pool for use in LocalSearch branch simulations.

        Returns:
            ResourcePool: New pool with identical count and interval state.
        """
        new_pool = object.__new__(ResourcePool)
        new_pool._count     = self._count
        new_pool._intervals = [list(ivs) for ivs in self._intervals]
        return new_pool

    def allocate_n(self, n: int, start: datetime, duration_h: float) -> None:
        """
        Mark n units as busy for the interval [start, start + duration_h).

        Selects units by sorting on free_from_for_duration so only units fully free
        for the entire window are chosen, preventing double-booking within a window.

        Args:
            n (int): Number of units to allocate. Required.
            start (datetime): Start of the busy interval. Required.
            duration_h (float): Duration of the busy interval in hours. Required.
        """
        if n <= 0:
            return
        n = min(n, self._count)
        end = start + timedelta(hours=duration_h)
        if duration_h > 0.0:
            by_free = sorted(
                range(self._count),
                key=lambda i: self._free_from_for_duration(i, start, duration_h),
            )
        else:
            by_free = sorted(range(self._count), key=lambda i: self._free_from(i, start))
        for idx in by_free[:n]:
            self._intervals[idx].append((start, end))
            self._intervals[idx].sort()


class ContinuousBerthState:
    """
    Tracks space-time occupancy of a linear quay with noray-position addressing.

    Each assignment occupies noray positions [noray_start, noray_end] during [t_start, t_end).
    """

    def __init__(self, berth: BerthZone) -> None:
        """
        Initialize state for a continuous berth from its zone configuration.

        Args:
            berth (BerthZone): Berth configuration providing noray_max. Required.
        """
        # User-provided - total number of noray positions on this quay
        self.noray_max: int = berth.noray_max or 100
        # Computed - list of (noray_start, noray_end, t_start, t_end, vessel_id) occupancy records
        self._occupied: list[tuple[int, int, datetime, datetime, str]] = []

    def find_slot(
        self, eslora: float, earliest: datetime, dur_h: float
    ) -> Optional[tuple[int, datetime]]:
        """
        Find the earliest (noray_start, actual_start) where a vessel of given length fits.

        Args:
            eslora (float): Vessel length in metres used to compute required noray positions. Required.
            earliest (datetime): Earliest acceptable berthing start time. Required.
            dur_h (float): Required service duration in hours. Required.

        Returns:
            Optional[tuple[int, datetime]]: Pair of (noray_start, actual_start), or None if the vessel can never fit.
        """
        n = norays_needed(eslora)
        if n > self.noray_max:
            return None

        candidates = sorted(
            {earliest} | {o[3] for o in self._occupied if o[3] > earliest}
        )

        for t_start in candidates:
            t_end = t_start + timedelta(hours=dur_h)
            blocked: list[tuple[int, int]] = [
                (o[0], o[1])
                for o in self._occupied
                if o[2] < t_end and o[3] > t_start
            ]
            pos = 1
            while pos + n - 1 <= self.noray_max:
                end = pos + n - 1
                clashing = [b for b in blocked if b[0] <= end and b[1] >= pos]
                if not clashing:
                    return pos, t_start
                pos = max(b[1] for b in clashing) + 1

        return None

    def assign(
        self,
        noray_start: int,
        noray_end: int,
        t_start: datetime,
        t_end: datetime,
        vessel_id: str,
    ) -> None:
        """
        Record a vessel occupancy at the given noray positions and time interval.

        Args:
            noray_start (int): First noray position occupied by the vessel. Required.
            noray_end (int): Last noray position occupied by the vessel. Required.
            t_start (datetime): Start of the occupancy interval. Required.
            t_end (datetime): End of the occupancy interval. Required.
            vessel_id (str): Identifier of the vessel being assigned. Required.
        """
        self._occupied.append((noray_start, noray_end, t_start, t_end, vessel_id))

    def copy(self) -> "ContinuousBerthState":
        """
        Return a shallow copy of this state for use in LocalSearch simulations.

        Returns:
            ContinuousBerthState: New state with identical noray_max and occupancy list.
        """
        dummy = object.__new__(ContinuousBerthState)
        dummy.noray_max = self.noray_max
        dummy._occupied = list(self._occupied)
        return dummy


class DiscreteBerthState:
    """
    Tracks occupancy of a fixed-capacity berth where each slot accepts one vessel at a time.
    """

    def __init__(self, berth: BerthZone) -> None:
        """
        Initialize state for a discrete berth from its zone configuration.

        Args:
            berth (BerthZone): Berth configuration providing capacity. Required.
        """
        # User-provided - number of simultaneous vessel slots at this berth
        self.capacity: int = berth.capacity or 1
        # Computed - per-slot list of (t_start, t_end, vessel_id) occupancy records
        self._slots: list[list[tuple[datetime, datetime, str]]] = [
            [] for _ in range(self.capacity)
        ]

    def find_slot(
        self, earliest: datetime, dur_h: float
    ) -> Optional[tuple[int, datetime]]:
        """
        Return the slot index and actual start time for the soonest-available slot.

        Args:
            earliest (datetime): Earliest acceptable berthing start time. Required.
            dur_h (float): Required service duration in hours. Required.

        Returns:
            Optional[tuple[int, datetime]]: Pair of (slot_index, actual_start), or None if no slot is available.
        """
        best_idx = -1
        best_t: Optional[datetime] = None
        for i, slot in enumerate(self._slots):
            if not slot:
                return i, earliest
            free_at = max(s[1] for s in slot)
            t = max(earliest, free_at)
            if best_t is None or t < best_t:
                best_t = t
                best_idx = i
        if best_idx < 0:
            return None
        return best_idx, best_t

    def assign(
        self, slot_idx: int, t_start: datetime, t_end: datetime, vessel_id: str
    ) -> None:
        """
        Record a vessel occupancy in the given slot.

        Args:
            slot_idx (int): Index of the slot to assign. Required.
            t_start (datetime): Start of the occupancy interval. Required.
            t_end (datetime): End of the occupancy interval. Required.
            vessel_id (str): Identifier of the vessel being assigned. Required.
        """
        self._slots[slot_idx].append((t_start, t_end, vessel_id))

    def copy(self) -> "DiscreteBerthState":
        """
        Return a shallow copy of this state for use in LocalSearch simulations.

        Returns:
            DiscreteBerthState: New state with identical capacity and slot lists.
        """
        dummy = object.__new__(DiscreteBerthState)
        dummy.capacity = self.capacity
        dummy._slots = [list(s) for s in self._slots]
        return dummy


def make_berth_state(berth: BerthZone) -> ContinuousBerthState | DiscreteBerthState:
    """
    Instantiate the correct berth state object for the given berth configuration.

    Args:
        berth (BerthZone): Berth configuration specifying bap_type, noray_max, and capacity. Required.

    Returns:
        ContinuousBerthState | DiscreteBerthState: Freshly initialized state object for the berth.
    """
    if berth.bap_type == "continuous":
        return ContinuousBerthState(berth)
    return DiscreteBerthState(berth)


class Scheduler:
    """
    Greedy berth scheduler that assigns vessels to berths in GT-descending order within each berth group.

    For each vessel, finds the earliest feasible berth slot that also satisfies pilot and tug constraints.
    """

    def __init__(
        self,
        calibration: Optional[Calibration] = None,
        default_duration_h: float = 48.0,
        overlap_factor: float = 0.70,
        num_pilots: int = 3,
        num_tugs: int = 2,
    ) -> None:
        """
        Initialize the scheduler with calibration and resource pool configuration.

        Args:
            calibration (Calibration): Fitted calibration object for duration and manoeuvre estimates. Optional, defaults to None.
            default_duration_h (float): Fallback service duration in hours. Optional, defaults to 48.0.
            overlap_factor (float): Fraction applied to summed multi-operation durations. Optional, defaults to 0.70.
            num_pilots (int): Total number of pilots available in the shift. Optional, defaults to 3.
            num_tugs (int): Total number of tugs available in the shift. Optional, defaults to 2.
        """
        # User-provided - calibration object used for duration and manoeuvre estimation
        self.calibration = calibration
        # Computed - duration estimator wrapping the three-layer fallback strategy
        self.estimator = DurationEstimator(
            calibration=calibration,
            default_duration_h=default_duration_h,
            overlap_factor=overlap_factor,
        )
        # Computed - pilot resource pool for this scheduling run
        self.pilots = ResourcePool(num_pilots)
        # Computed - tug resource pool for this scheduling run
        self.tugs = ResourcePool(num_tugs)
        # Computed - final berth states after scheduling, keyed by berth_id
        self.final_states: dict[str, ContinuousBerthState | DiscreteBerthState] = {}

    def schedule(
        self,
        vessels: list[VesselInput],
        berths: list[BerthZone],
        initial_states: Optional[dict[str, ContinuousBerthState | DiscreteBerthState]] = None,
    ) -> tuple[list[AssignmentResult], int]:
        """
        Run the greedy scheduling pass and return assignments with a conflict count.

        Args:
            vessels (list[VesselInput]): Vessels to schedule in this batch. Required.
            berths (list[BerthZone]): Available berths for this scheduling run. Required.
            initial_states (dict): Berth states carried over from a previous day batch; deep-copied before use. Optional, defaults to None (fresh empty states).

        Returns:
            tuple[list[AssignmentResult], int]: Pair of (assignments, conflicts_resolved) where
                conflicts_resolved counts vessels whose start was pushed back by resource contention.
        """
        berth_map: dict[str, BerthZone] = {b.berth_id: b for b in berths}
        if initial_states:
            states: dict[str, ContinuousBerthState | DiscreteBerthState] = {
                bid: s.copy() for bid, s in initial_states.items()
            }
            for b in berths:
                if b.berth_id not in states:
                    states[b.berth_id] = make_berth_state(b)
        else:
            states = {b.berth_id: make_berth_state(b) for b in berths}

        groups: dict[str, list[VesselInput]] = {}
        for v in vessels:
            groups.setdefault(v.target_berth, []).append(v)
        for bid in groups:
            groups[bid].sort(key=lambda v: v.gt, reverse=True)

        results: list[AssignmentResult] = []
        conflicts_resolved = 0

        for bid, group in groups.items():
            if bid not in berth_map:
                for v in group:
                    results.append(_make_invalid(v, bid))
                continue

            state = states[bid]

            for v in group:
                dur_h, src = self.estimator.estimate(
                    eslora=v.eslora,
                    operations=v.operations,
                    estimated_duration_h=v.estimated_duration_h,
                )

                n_tugs = required_tugs(v.gt, _cargo_group(v), v.has_bow_thruster)

                slot = _find_slot(state, v.eslora, v.eta, dur_h)
                if slot is None:
                    results.append(_make_unassigned(v, bid, dur_h, src, n_tugs))
                    continue
                ns, ne, t_start = slot

                maneuver_h = estimate_maneuver_duration(
                    v.eslora, _cargo_group(v), self.calibration
                )

                pilot_caused = False
                tug_caused   = False
                unassignable = False

                for _iter in range(8):
                    pilot_dock = self.pilots.earliest_n_available(1,     t_start, duration_h=maneuver_h)
                    tug_dock   = self.tugs.earliest_n_available(n_tugs, t_start, duration_h=maneuver_h)
                    resource_start = max(pilot_dock, tug_dock)

                    if resource_start <= t_start:
                        break

                    if _iter == 0:
                        conflicts_resolved += 1
                    pilot_caused = pilot_caused or (pilot_dock > t_start)
                    tug_caused   = tug_caused   or (tug_dock   > t_start)

                    new_slot = _find_slot(state, v.eslora, resource_start, dur_h)
                    if new_slot is None:
                        unassignable = True
                        break
                    ns, ne, t_start = new_slot

                if unassignable:
                    results.append(_make_unassigned(v, bid, dur_h, src, n_tugs))
                    continue

                berth_only_start = slot[2] if slot else t_start
                pilot_wait_h_val = max(0.0, (pilot_dock - berth_only_start).total_seconds() / 3600) if pilot_caused else 0.0
                tug_wait_h_val   = max(0.0, (tug_dock   - berth_only_start).total_seconds() / 3600) if tug_caused   else 0.0

                t_end  = t_start + timedelta(hours=dur_h)
                wait_h = max(0.0, (t_start - v.eta).total_seconds() / 3600)

                desatraque_start = t_end - timedelta(hours=maneuver_h)
                pilot_undock = self.pilots.earliest_n_available(1,     desatraque_start, duration_h=maneuver_h)
                tug_undock   = self.tugs.earliest_n_available(n_tugs, desatraque_start, duration_h=maneuver_h)
                undock_start = max(pilot_undock, tug_undock)

                waiting_undock_h = max(0.0, (undock_start - desatraque_start).total_seconds() / 3600)
                actual_t_end     = undock_start + timedelta(hours=maneuver_h)

                _commit_slot(state, ns, ne, t_start, actual_t_end, v.id, v.eslora)

                self.pilots.allocate_n(1,     t_start,      maneuver_h)
                self.pilots.allocate_n(1,     undock_start, maneuver_h)
                self.tugs.allocate_n(n_tugs, t_start,      maneuver_h)
                self.tugs.allocate_n(n_tugs, undock_start, maneuver_h)

                logger.info(
                    "vessel_scheduled",
                    vessel_id=v.id,
                    berth_id=bid,
                    scheduled_start=t_start.isoformat(),
                    waiting_h=round(wait_h, 2),
                    duration_h=round(dur_h, 2),
                    waiting_undock_h=round(waiting_undock_h, 2),
                    source=src,
                    tugs_required=n_tugs,
                )

                vessel_phases = build_phases(
                    eta=v.eta,
                    scheduled_start=t_start,
                    scheduled_end=t_end,
                    waiting_time_h=wait_h,
                    duration_estimated_h=dur_h,
                    maneuver_h=maneuver_h,
                )
                if waiting_undock_h > 0.01:
                    new_phases: list[OperationPhase] = []
                    for _p in vessel_phases:
                        if _p.name == "desatraque":
                            new_phases.append(OperationPhase(
                                name="waiting_undock",
                                start=desatraque_start,
                                end=undock_start,
                                duration_h=round(waiting_undock_h, 4),
                            ))
                            new_phases.append(OperationPhase(
                                name="desatraque",
                                start=undock_start,
                                end=actual_t_end,
                                duration_h=round(maneuver_h, 4),
                            ))
                        else:
                            new_phases.append(_p)
                    vessel_phases = new_phases

                results.append(
                    AssignmentResult(
                        vessel_id=v.id,
                        berth_id=bid,
                        noray_start=ns if isinstance(state, ContinuousBerthState) else None,
                        noray_end=ne if isinstance(state, ContinuousBerthState) else None,
                        scheduled_start=t_start,
                        scheduled_end=actual_t_end,
                        waiting_time_h=wait_h,
                        duration_estimated_h=dur_h,
                        duration_source=src,
                        pilot_assigned=True,
                        tugs_required=n_tugs,
                        tugs_assigned=True,
                        status="assigned",
                        pilot_caused_delay=pilot_caused,
                        tug_caused_delay=tug_caused,
                        caused_delay_to=[],
                        maneuver_h=maneuver_h,
                        phases=vessel_phases,
                        pilot_wait_h=round(pilot_wait_h_val, 4),
                        tug_wait_h=round(tug_wait_h_val,   4),
                    )
                )

        _fill_caused_delay(results, groups)
        self.final_states = states
        return results, conflicts_resolved


def _cargo_group(v: VesselInput) -> str:
    """
    Return the primary cargo group from the vessel's first operation, or an empty string if none.

    Args:
        v (VesselInput): Vessel input data. Required.

    Returns:
        str: Cargo group identifier, or empty string when no operations are defined.
    """
    return v.operations[0].grupo_mercancia if v.operations else ""


def _find_slot(
    state: ContinuousBerthState | DiscreteBerthState,
    eslora: float,
    earliest: datetime,
    dur_h: float,
) -> Optional[tuple[int, int, datetime]]:
    """
    Find the earliest berth slot for a vessel, dispatching to the appropriate state type.

    Args:
        state (ContinuousBerthState | DiscreteBerthState): Current berth occupancy state. Required.
        eslora (float): Vessel length in metres (used only for continuous berths). Required.
        earliest (datetime): Earliest acceptable berthing start time. Required.
        dur_h (float): Required service duration in hours. Required.

    Returns:
        Optional[tuple[int, int, datetime]]: Triple of (noray_start_or_slot_idx, noray_end_or_slot_idx, actual_start), or None if no slot is available.
    """
    if isinstance(state, ContinuousBerthState):
        res = state.find_slot(eslora, earliest, dur_h)
        if res is None:
            return None
        ns, t = res
        ne = ns + norays_needed(eslora) - 1
        return ns, ne, t
    else:
        res = state.find_slot(earliest, dur_h)
        if res is None:
            return None
        idx, t = res
        return idx, idx, t


def _commit_slot(
    state: ContinuousBerthState | DiscreteBerthState,
    ns: int,
    ne: int,
    t_start: datetime,
    t_end: datetime,
    vessel_id: str,
    eslora: float,
) -> None:
    """
    Commit a berth slot assignment to the state, dispatching to the appropriate state type.

    Args:
        state (ContinuousBerthState | DiscreteBerthState): Current berth occupancy state to update. Required.
        ns (int): Noray start or slot index. Required.
        ne (int): Noray end or slot index (same as ns for discrete berths). Required.
        t_start (datetime): Start of the occupancy interval. Required.
        t_end (datetime): End of the occupancy interval. Required.
        vessel_id (str): Identifier of the assigned vessel. Required.
        eslora (float): Vessel length in metres (unused for discrete berths). Required.
    """
    if isinstance(state, ContinuousBerthState):
        state.assign(ns, ne, t_start, t_end, vessel_id)
    else:
        state.assign(ns, t_start, t_end, vessel_id)


def _make_unassigned(
    v: VesselInput, bid: str, dur_h: float, src: str, n_tugs: int
) -> AssignmentResult:
    """
    Create an AssignmentResult with status "unassigned" for a vessel that could not be scheduled.

    Args:
        v (VesselInput): Vessel that could not be assigned. Required.
        bid (str): Target berth identifier. Required.
        dur_h (float): Estimated service duration in hours. Required.
        src (str): Duration source label. Required.
        n_tugs (int): Number of tugs required by this vessel. Required.

    Returns:
        AssignmentResult: Assignment record with status "unassigned".
    """
    return AssignmentResult(
        vessel_id=v.id, berth_id=bid,
        noray_start=None, noray_end=None,
        scheduled_start=v.eta, scheduled_end=v.eta,
        waiting_time_h=0.0, duration_estimated_h=dur_h,
        duration_source=src,
        pilot_assigned=False,
        tugs_required=n_tugs,
        tugs_assigned=False,
        status="unassigned",
        caused_delay_to=[],
    )


def _make_invalid(v: VesselInput, bid: str) -> AssignmentResult:
    """
    Create an AssignmentResult with status "invalid_berth" for a vessel requesting an unknown berth.

    Args:
        v (VesselInput): Vessel requesting the unknown berth. Required.
        bid (str): Requested berth identifier that does not exist in the port configuration. Required.

    Returns:
        AssignmentResult: Assignment record with status "invalid_berth".
    """
    n_tugs = required_tugs(v.gt, _cargo_group(v), v.has_bow_thruster)
    return AssignmentResult(
        vessel_id=v.id, berth_id=bid,
        noray_start=None, noray_end=None,
        scheduled_start=v.eta, scheduled_end=v.eta,
        waiting_time_h=0.0, duration_estimated_h=0.0,
        duration_source="default",
        pilot_assigned=False,
        tugs_required=n_tugs,
        tugs_assigned=False,
        status="invalid_berth",
        caused_delay_to=[],
    )


def _fill_caused_delay(
    results: list[AssignmentResult],
    groups: dict[str, list[VesselInput]],
) -> None:
    """
    Populate caused_delay_to on each assignment with the IDs of vessels delayed by it.

    Within each berth group, for each assigned vessel that is scheduled before another,
    the first vessel is credited with causing a delay to the next waiting vessel.

    Args:
        results (list[AssignmentResult]): Assignment results to update in place. Required.
        groups (dict[str, list[VesselInput]]): Vessels grouped by target berth in GT-descending order. Required.
    """
    vid_map = {r.vessel_id: r for r in results}
    for bid, vessels in groups.items():
        assigned = [
            vid_map[v.id]
            for v in vessels
            if v.id in vid_map and vid_map[v.id].status == "assigned"
        ]
        for i, a in enumerate(assigned):
            for b in assigned[i + 1:]:
                if b.waiting_time_h > 0 and b.vessel_id not in a.caused_delay_to:
                    a.caused_delay_to.append(b.vessel_id)
                    break
