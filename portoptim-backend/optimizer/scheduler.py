"""
Phase 2 — Greedy scheduler.

Groups vessels by target_berth.  Within each group, vessels are processed in
GT-descending order (higher GT docks first).  Each vessel is assigned the
earliest feasible berth slot that also has a free pilot and enough free tugs.

Resource rules
--------------
Pilots:  exactly 1 per vessel per manoeuvre (docking + undocking = 2 events).
         Occupied for DOCKING_DURATION_H (~1 h) then returned to pool.

Tugs:    required_tugs(gt, cargo_group, has_bow_thruster) units per manoeuvre.
         Same two-event consumption model as pilots.
         If fewer tugs are available than required, the vessel's start is delayed
         until enough are free.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

import structlog

from .calibration import Calibration
from .duration import DurationEstimator
from .models import (
    AssignmentResult,
    BerthZone,
    VesselInput,
    DOCKING_DURATION_H,
    norays_needed,
    required_tugs,
)


def estimate_maneuver_duration(
    eslora: float,
    grupo_mercancia: str,
    calibration: Optional[Calibration],
) -> float:
    """
    Estimated duration (h) of a single docking or undocking manoeuvre.

    If a fitted Calibration is available its maneuver_model is queried first.
    Fallback (when calibration is None or the bucket has too few observations):
        0.5 + 0.3 * hazardous
    which equals 0.5 h for normal cargo and 0.8 h for hazardous cargo —
    always > 0 and safely conservative.
    """
    if calibration is not None:
        return calibration.get_maneuver_duration(eslora, grupo_mercancia)
    from .calibration import HAZARDOUS_CARGO_GROUPS
    hazardous = grupo_mercancia in HAZARDOUS_CARGO_GROUPS
    return 0.5 + (0.3 if hazardous else 0.0)

logger = structlog.get_logger()


# ── Resource pool ─────────────────────────────────────────────────────────────

class ResourcePool:
    """
    Pool of N identical resources (pilots or tugs).

    Availability is tracked via disjoint busy-interval lists per unit so that
    the two-phase consumption model (docking manoeuvre + undocking manoeuvre)
    is represented correctly — the resource is free between the two events even
    though both are pre-booked.
    """

    def __init__(self, count: int) -> None:
        self._count = max(count, 1)
        # Per-unit sorted list of (start, end) busy intervals.
        self._intervals: list[list[tuple[datetime, datetime]]] = [
            [] for _ in range(self._count)
        ]

    def _free_from(self, idx: int, from_time: datetime) -> datetime:
        """Earliest time ≥ from_time when unit *idx* is free."""
        t = from_time
        changed = True
        while changed:
            changed = False
            for iv_start, iv_end in self._intervals[idx]:
                if iv_start <= t < iv_end:
                    t = iv_end
                    changed = True
        return t

    def earliest_n_available(self, n: int, from_time: datetime) -> datetime:
        """
        Earliest time ≥ from_time when at least *n* units are simultaneously free.

        Returns *from_time* immediately if n ≤ 0.
        Clamps n to the pool size.
        """
        if n <= 0:
            return from_time
        n = min(n, self._count)
        free_times = sorted(self._free_from(i, from_time) for i in range(self._count))
        # free_times[n-1] is when the n-th soonest-free unit becomes available.
        return free_times[n - 1]

    def allocate_n(self, n: int, start: datetime, duration_h: float) -> None:
        """
        Mark *n* units as busy for [start, start + duration_h).

        Selects the n units with the earliest free_from(start) to minimise
        resource fragmentation.
        """
        if n <= 0:
            return
        n = min(n, self._count)
        end = start + timedelta(hours=duration_h)
        by_free = sorted(range(self._count), key=lambda i: self._free_from(i, start))
        for idx in by_free[:n]:
            self._intervals[idx].append((start, end))
            self._intervals[idx].sort()


# ── Berth-state objects ───────────────────────────────────────────────────────

class ContinuousBerthState:
    """
    Tracks space-time occupancy of a linear quay.

    Each assignment occupies noray positions [noray_start, noray_end] during
    the time interval [t_start, t_end).
    """

    def __init__(self, berth: BerthZone) -> None:
        self.noray_max: int = berth.noray_max or 100
        # (noray_start, noray_end, t_start, t_end, vessel_id)
        self._occupied: list[tuple[int, int, datetime, datetime, str]] = []

    def find_slot(
        self, eslora: float, earliest: datetime, dur_h: float
    ) -> Optional[tuple[int, datetime]]:
        """
        Find the earliest (noray_start, actual_start) where the vessel fits.
        Returns None if it can never fit (eslora > capacity).
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

        return None  # pragma: no cover

    def assign(
        self,
        noray_start: int,
        noray_end: int,
        t_start: datetime,
        t_end: datetime,
        vessel_id: str,
    ) -> None:
        self._occupied.append((noray_start, noray_end, t_start, t_end, vessel_id))

    def copy(self) -> "ContinuousBerthState":
        dummy = object.__new__(ContinuousBerthState)
        dummy.noray_max = self.noray_max
        dummy._occupied = list(self._occupied)
        return dummy  # type: ignore[return-value]


class DiscreteBerthState:
    """
    Tracks occupancy of a fixed-capacity berth (discrete slots).
    Each slot accepts one vessel at a time.
    """

    def __init__(self, berth: BerthZone) -> None:
        self.capacity: int = berth.capacity or 1
        self._slots: list[list[tuple[datetime, datetime, str]]] = [
            [] for _ in range(self.capacity)
        ]

    def find_slot(
        self, earliest: datetime, dur_h: float
    ) -> Optional[tuple[int, datetime]]:
        """Return (slot_index, actual_start) for the soonest-available slot."""
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
        return best_idx, best_t  # type: ignore[return-value]

    def assign(
        self, slot_idx: int, t_start: datetime, t_end: datetime, vessel_id: str
    ) -> None:
        self._slots[slot_idx].append((t_start, t_end, vessel_id))

    def copy(self) -> "DiscreteBerthState":
        dummy = object.__new__(DiscreteBerthState)
        dummy.capacity = self.capacity
        dummy._slots = [list(s) for s in self._slots]
        return dummy  # type: ignore[return-value]


def make_berth_state(berth: BerthZone) -> ContinuousBerthState | DiscreteBerthState:
    if berth.bap_type == "continuous":
        return ContinuousBerthState(berth)
    return DiscreteBerthState(berth)


# ── Scheduler ─────────────────────────────────────────────────────────────────

class Scheduler:
    def __init__(
        self,
        calibration: Optional[Calibration] = None,
        default_duration_h: float = 48.0,
        overlap_factor: float = 0.70,
        num_pilots: int = 3,
        num_tugs: int = 2,
    ) -> None:
        self.calibration = calibration
        self.estimator = DurationEstimator(
            calibration=calibration,
            default_duration_h=default_duration_h,
            overlap_factor=overlap_factor,
        )
        self.pilots = ResourcePool(num_pilots)
        self.tugs = ResourcePool(num_tugs)
        self.final_states: dict[str, ContinuousBerthState | DiscreteBerthState] = {}

    def schedule(
        self,
        vessels: list[VesselInput],
        berths: list[BerthZone],
        initial_states: Optional[dict[str, ContinuousBerthState | DiscreteBerthState]] = None,
    ) -> tuple[list[AssignmentResult], int]:
        """
        Returns (assignments, conflicts_resolved).

        conflicts_resolved counts vessels whose start was pushed back due to
        resource contention (pilot or tugs not free at the natural berth slot).

        If initial_states is provided those berth states are used as the starting
        point (deep-copied) — used for day-by-day batching.
        Final states are stored in self.final_states.
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

                # Step 1: earliest feasible berth slot from vessel ETA
                slot = _find_slot(state, v.eslora, v.eta, dur_h)
                if slot is None:
                    results.append(_make_unassigned(v, bid, dur_h, src, n_tugs))
                    continue
                ns, ne, t_start = slot

                # Step 2: apply resource constraints — 1 pilot + n_tugs at docking
                pilot_free = self.pilots.earliest_n_available(1, t_start)
                tug_free = self.tugs.earliest_n_available(n_tugs, t_start)
                resource_start = max(pilot_free, tug_free)

                pilot_caused = False
                tug_caused = False

                if resource_start > t_start:
                    conflicts_resolved += 1
                    pilot_caused = pilot_free > t_start
                    tug_caused = tug_free > t_start
                    slot2 = _find_slot(state, v.eslora, resource_start, dur_h)
                    if slot2 is None:
                        results.append(_make_unassigned(v, bid, dur_h, src, n_tugs))
                        continue
                    ns, ne, t_start = slot2

                t_end = t_start + timedelta(hours=dur_h)
                wait_h = max(0.0, (t_start - v.eta).total_seconds() / 3600)

                maneuver_h = estimate_maneuver_duration(
                    v.eslora, _cargo_group(v), self.calibration
                )

                # Commit: docking manoeuvre resources (t_start) + undocking (t_end)
                self.pilots.allocate_n(1, t_start, maneuver_h)
                self.pilots.allocate_n(1, t_end, maneuver_h)
                self.tugs.allocate_n(n_tugs, t_start, maneuver_h)
                self.tugs.allocate_n(n_tugs, t_end, maneuver_h)
                _commit_slot(state, ns, ne, t_start, t_end, v.id, v.eslora)

                logger.info(
                    "vessel_scheduled",
                    vessel_id=v.id,
                    berth_id=bid,
                    scheduled_start=t_start.isoformat(),
                    waiting_h=round(wait_h, 2),
                    duration_h=round(dur_h, 2),
                    source=src,
                    tugs_required=n_tugs,
                )

                results.append(
                    AssignmentResult(
                        vessel_id=v.id,
                        berth_id=bid,
                        noray_start=ns if isinstance(state, ContinuousBerthState) else None,
                        noray_end=ne if isinstance(state, ContinuousBerthState) else None,
                        scheduled_start=t_start,
                        scheduled_end=t_end,
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
                    )
                )

        _fill_caused_delay(results, groups)
        self.final_states = states
        return results, conflicts_resolved


# ── Helpers ───────────────────────────────────────────────────────────────────

def _cargo_group(v: VesselInput) -> str:
    """Primary cargo group from the vessel's first operation, or empty string."""
    return v.operations[0].grupo_mercancia if v.operations else ""


def _find_slot(
    state: ContinuousBerthState | DiscreteBerthState,
    eslora: float,
    earliest: datetime,
    dur_h: float,
) -> Optional[tuple[int, int, datetime]]:
    """Returns (noray_start_or_slot_idx, noray_end_or_slot_idx, actual_start)."""
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
    if isinstance(state, ContinuousBerthState):
        state.assign(ns, ne, t_start, t_end, vessel_id)
    else:
        state.assign(ns, t_start, t_end, vessel_id)


def _make_unassigned(
    v: VesselInput, bid: str, dur_h: float, src: str, n_tugs: int
) -> AssignmentResult:
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
