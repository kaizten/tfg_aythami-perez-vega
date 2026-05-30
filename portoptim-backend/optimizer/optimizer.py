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

from datetime import datetime, timedelta
from typing import Optional

import structlog

from .calibration import Calibration
from .conflict import apply_delays_to_assignments, detect_conflicts
from .local_search import LocalSearch
from .models import (
    AssignmentResult,
    BerthZone,
    EarlyCompleteRequest,
    EarlyCompleteResponse,
    OperationPhase,
    OptimizationRequest,
    OptimizationResponse,
    ReplanRequest,
    ReplanResponse,
    VesselInput,
    build_phases,
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


# ── Visual delay phase injection (full-replan path) ───────────────────────────

def _inject_visual_delay_phases(
    assignments: list[dict],
    delays_map: dict[str, float],
    delay_types_map: dict[str, str],
) -> list[dict]:
    """
    Inject a visual ``delay`` phase into assignments produced by a *full*
    optimizer re-run so the Gantt can render the delay period in red.

    In the full-replan path the delay is already baked into the schedule
    (ETA shifted for arrivals, ``estimated_duration_h`` extended for
    operations), so we add only the colour marker without altering
    ``scheduled_start`` / ``scheduled_end``.

    Arrival delay
    -------------
    phases[0] is fondeo; fondeo.start == new ETA == original_ETA + delay_h.
    We prepend:  ``delay = [new_ETA − delay_h, new_ETA]``.

    Operation delay
    ---------------
    ``estimated_duration_h`` was extended by ``delay_h``, so the ejecucion
    phase is exactly ``delay_h`` longer than the original.  We split off the
    last ``delay_h`` of ejecucion into a separate ``delay`` phase placed
    between ejecucion and desatraque.
    """
    result: list[dict] = []
    for a in assignments:
        vid     = a.get("vessel_id", "")
        delay_h = delays_map.get(vid, 0.0)
        d_type  = delay_types_map.get(vid, "arrival")

        if delay_h <= 0 or a.get("status") != "assigned":
            result.append({**a, "delay_h": delay_h})
            continue

        updated = dict(a)
        updated["delay_h"] = delay_h
        phases  = a.get("phases", [])
        delta   = timedelta(hours=delay_h)

        if not phases:
            result.append(updated)
            continue

        if d_type == "early_arrival":
            # The optimizer already rebuilt the phases with the correct (earlier)
            # fondeo start during the full replan in replan().  No extra visual
            # phase is added here — fondeo naturally represents the waiting time.
            # delay_h is reset to 0 so the frontend does not show an amber delay badge.
            # early_arrival_h is retained so the Statistics page can count events.
            updated["delay_h"] = 0
            updated["early_arrival_h"] = delay_h
            result.append(updated)
            continue

        elif d_type == "arrival":
            # fondeo.start is the NEW ETA; prepend delay covering [original_ETA, new_ETA]
            fondeo_start = datetime.fromisoformat(phases[0]["start"])
            original_eta = fondeo_start - delta
            new_phases = [
                {
                    "name":       "delay",
                    "start":      original_eta.isoformat(),
                    "end":        fondeo_start.isoformat(),
                    "duration_h": round(delay_h, 4),
                }
            ] + [dict(p) for p in phases]
            updated["phases"] = new_phases

        else:  # operation
            # ejecucion is delay_h longer; split its tail into a red delay phase
            new_phases: list[dict] = []
            for p in phases:
                np_ = dict(p)
                if p["name"] == "ejecucion":
                    exec_end     = datetime.fromisoformat(p["end"])
                    new_exec_end = exec_end - delta          # shorten ejecucion
                    np_["end"]        = new_exec_end.isoformat()
                    np_["duration_h"] = round(
                        (new_exec_end - datetime.fromisoformat(p["start"])).total_seconds() / 3600,
                        4,
                    )
                    new_phases.append(np_)
                    # Insert the delay phase between ejecucion and desatraque
                    new_phases.append({
                        "name":       "delay",
                        "start":      new_exec_end.isoformat(),
                        "end":        exec_end.isoformat(),
                        "duration_h": round(delay_h, 4),
                    })
                else:
                    new_phases.append(np_)
            updated["phases"] = new_phases

        result.append(updated)
    return result


# ── Early-completion helpers ──────────────────────────────────────────────────

def _parse_iso(s: str) -> datetime:
    """Parse an ISO 8601 string to a **timezone-naive** datetime.

    All datetimes stored in the scheduler (ETAs, phase times, scheduled_start /
    scheduled_end) are **naive local-time** values — they carry no timezone
    information and are implicitly in the port's local timezone.

    Callers (e.g. the frontend ``confirmOperation`` handler) should therefore
    send the current *wall-clock* time as a naive ISO string (``HH:MM:SS``
    with **no** trailing ``Z`` and no UTC offset) so comparisons are
    consistent.

    This function also handles the edge cases produced by older
    ``toISOString()`` calls or legacy payloads:
    - Trailing ``Z`` (UTC marker) → stripped; the datetime is treated as local
      time (the conversion is intentionally lossy — see above).
    - 3-digit milliseconds (e.g. ``.000``) → padded to 6 digits so
      ``fromisoformat`` works on Python 3.10 and earlier.
    - Timezone offsets (``+HH:MM``) → stripped and ignored (same rationale).
    """
    s = s.strip()

    # ── 1. Remove trailing 'Z' ────────────────────────────────────────────────
    if s.endswith("Z"):
        s = s[:-1]

    # ── 2. Normalise fractional seconds to 6 digits (Python ≤ 3.10 compat) ──
    #   JavaScript's toISOString gives ".NNN" (3 digits); Python fromisoformat
    #   only accepts 6 digits on Python 3.10 and earlier.
    dot = s.rfind(".")
    if dot != -1:
        # Find end of fractional part (stop at +/- offset if present)
        end = dot + 1
        while end < len(s) and s[end].isdigit():
            end += 1
        frac = s[dot + 1:end]
        if len(frac) < 6:
            s = s[:dot + 1] + frac.ljust(6, "0") + s[end:]

    # ── 3. Strip timezone offset if any (treat as local time) ────────────────
    for sep in ("+", "-"):
        # Find the last occurrence after the date portion
        idx = s.rfind(sep, 10)  # skip the date '-' separators
        if idx != -1:
            s = s[:idx]
            break

    return datetime.fromisoformat(s)


def _find_resource_slot(
    earliest: datetime,
    tugs_required: int,
    other_assignments: list[dict],
    num_pilots: int,
    num_tugs: int,
    step_h: float = 0.25,       # 15-minute search steps
    max_search_h: float = 24.0,
) -> datetime:
    """
    Return the earliest time ≥ *earliest* at which 1 pilot and *tugs_required*
    tugs are simultaneously free, given the manoeuvre windows in
    *other_assignments*.

    Uses midpoint sampling of 15-minute slots.  Returns *earliest* immediately
    when the resources are already free.  Falls back to *earliest* +
    *max_search_h* if nothing is found within the search window.
    """
    intervals: list[tuple[datetime, datetime, int]] = [
        (_parse_iso(p["start"]), _parse_iso(p["end"]), a.get("tugs_required", 0))
        for a in other_assignments
        for p in a.get("phases", [])
        if p["name"] in ("atraque", "desatraque")
    ]

    step     = timedelta(hours=step_h)
    deadline = earliest + timedelta(hours=max_search_h)
    t        = earliest

    while t < deadline:
        mid         = t + step / 2
        pilots_used = sum(1 for s, e, _ in intervals if s <= mid < e)
        tugs_used   = sum(n for s, e, n in intervals if s <= mid < e)
        if pilots_used < num_pilots and tugs_used + tugs_required <= num_tugs:
            return t
        t += step

    return deadline  # worst-case: wait up to 24 h


def _build_early_complete_assignment(
    a: dict,
    complete_dt: datetime,
    undock_start: datetime,
    desatraque_end: datetime,
    waiting_undock_h: float,
) -> dict:
    """
    Rebuild an assignment dict for a vessel that finished cargo early.

    * ``ejecucion`` is truncated to *complete_dt*.
    * A ``waiting_undock`` phase (light-purple in the Gantt) is inserted
      between ejecucion and desatraque when the undocking crew is not
      immediately available (*waiting_undock_h* > 0).
    * ``desatraque`` is updated to start at *undock_start*.
    * ``scheduled_end`` is updated to *desatraque_end*.
    """
    updated = dict(a)
    updated["scheduled_end"]  = desatraque_end.isoformat()
    updated["early_complete"] = True

    new_phases: list[dict] = []
    for p in a.get("phases", []):
        np_ = dict(p)
        if p["name"] == "ejecucion":
            exec_start  = _parse_iso(p["start"])
            new_dur     = max(0.0, (complete_dt - exec_start).total_seconds() / 3600)
            np_["end"]        = complete_dt.isoformat()
            np_["duration_h"] = round(new_dur, 4)
            new_phases.append(np_)
            # Waiting-for-resources gap (if any)
            if waiting_undock_h > 0.01:
                new_phases.append({
                    "name":       "waiting_undock",
                    "start":      complete_dt.isoformat(),
                    "end":        undock_start.isoformat(),
                    "duration_h": round(waiting_undock_h, 4),
                })
        elif p["name"] == "desatraque":
            np_["start"]      = undock_start.isoformat()
            np_["end"]        = desatraque_end.isoformat()
            np_["duration_h"] = round(
                (desatraque_end - undock_start).total_seconds() / 3600, 4
            )
            new_phases.append(np_)
        else:
            new_phases.append(np_)

    updated["phases"] = new_phases
    return updated


def _shift_assignment_start(a: dict, new_start: datetime) -> dict:
    """
    Shift an assignment's berthing start earlier to *new_start*.

    The vessel's ETA (fondeo start) is used as a hard floor — the effective
    start is ``max(new_start, ETA)``.  If the effective start is not earlier
    than the current ``scheduled_start`` no change is made and *a* is returned
    unchanged.

    * ``fondeo`` is shortened (its start/ETA is kept; its end is moved).
    * ``atraque``, ``ejecucion``, ``desatraque`` all shift earlier by the
      same delta.
    * ``waiting_undock`` / ``delay`` phases are left untouched (they belong
      to a different vessel lifecycle and should not exist on unstarted vessels
      anyway).
    """
    phases = a.get("phases", [])

    # Vessel ETA = start of fondeo phase
    fondeo_p = next((p for p in phases if p["name"] == "fondeo"), None)
    eta = _parse_iso(fondeo_p["start"]) if fondeo_p else _parse_iso(a["scheduled_start"])

    effective_start = max(new_start, eta)
    old_start       = _parse_iso(a["scheduled_start"])

    if effective_start >= old_start:
        return a  # no improvement possible

    delta   = old_start - effective_start   # positive timedelta
    delta_h = delta.total_seconds() / 3600

    updated = dict(a)
    updated["scheduled_start"] = effective_start.isoformat()
    updated["scheduled_end"]   = (_parse_iso(a["scheduled_end"]) - delta).isoformat()
    updated["waiting_time_h"]  = round(
        max(0.0, (effective_start - eta).total_seconds() / 3600), 4
    )

    new_phases: list[dict] = []
    for p in phases:
        np_ = dict(p)
        if p["name"] == "fondeo":
            np_["end"]        = effective_start.isoformat()
            np_["duration_h"] = round(
                max(0.0, (effective_start - eta).total_seconds() / 3600), 4
            )
        elif p["name"] in ("atraque", "ejecucion", "desatraque"):
            np_["start"] = (_parse_iso(p["start"]) - delta).isoformat()
            np_["end"]   = (_parse_iso(p["end"])   - delta).isoformat()
        # delay / waiting_undock: copied unchanged (shouldn't be present on
        # unstarted fondeo vessels, but safe to copy as-is if they are)
        new_phases.append(np_)

    updated["phases"] = new_phases
    return updated


# ── Post-LS resource enforcement ─────────────────────────────────────────────

def _enforce_resources_post_ls(
    assignments: list[AssignmentResult],
    num_pilots: int,
    num_tugs: int,
    vessel_map: dict[str, VesselInput],
) -> list[AssignmentResult]:
    """
    Re-enforce pilot/tug constraints after local search.

    Local search reorders vessels within each berth without checking cross-berth
    resource usage, which can create overlapping manoeuvre windows that exceed
    the pool limits.  This pass:

    1. Processes all assigned vessels in scheduled_start order globally.
    2. If docking resources are not free at t_start, delays t_start (extends
       fondeo). Subsequent vessels at the same berth are also pushed forward.
    3. If undocking resources are not free when desatraque should begin, inserts
       a ``waiting_undock`` phase (vessel waits at the berth) and extends
       scheduled_end accordingly.  Subsequent vessels at the same berth shift too.
    """
    from .scheduler import ResourcePool

    pilots = ResourcePool(num_pilots)
    tugs   = ResourcePool(num_tugs)

    assigned = sorted(
        [a for a in assignments if a.status == "assigned"],
        key=lambda a: a.scheduled_start,
    )
    rest = [a for a in assignments if a.status != "assigned"]

    # Track the latest actual end per berth to chain vessel schedules correctly.
    berth_end: dict[str, datetime] = {}
    # Keep insertion-order so we can restore the original sequence later.
    original_order = {a.vessel_id: i for i, a in enumerate(assignments)}

    updated: list[AssignmentResult] = []

    for a in assigned:
        v         = vessel_map.get(a.vessel_id)
        n_tugs    = a.tugs_required
        dur_h     = a.duration_estimated_h
        mh        = a.maneuver_h

        # Earliest start: LS result, but no earlier than the previous vessel at
        # this berth leaves (actual_t_end of its predecessor).
        be = berth_end.get(a.berth_id)
        t_start = max(a.scheduled_start, be) if be else a.scheduled_start
        # Capture the berth-only start (before any resource delay) so we can
        # later measure how much of the fondeo wait is due to resources.
        t_start_berth = t_start

        # Check docking resources; delay t_start if necessary.
        # duration_h=mh ensures resources are free for the full manoeuvre window.
        pilot_dock = pilots.earliest_n_available(1,     t_start, duration_h=mh)
        tug_dock   = tugs.earliest_n_available(n_tugs, t_start, duration_h=mh)
        r_start    = max(pilot_dock, tug_dock)
        if r_start > t_start:
            t_start = r_start

        t_end            = t_start + timedelta(hours=dur_h)
        desatraque_start = t_end - timedelta(hours=mh)

        # Check undocking resources; add waiting_undock if delayed.
        pilot_undock = pilots.earliest_n_available(1,     desatraque_start, duration_h=mh)
        tug_undock   = tugs.earliest_n_available(n_tugs, desatraque_start, duration_h=mh)
        undock_start     = max(pilot_undock, tug_undock)
        waiting_undock_h = max(0.0, (undock_start - desatraque_start).total_seconds() / 3600)
        actual_t_end     = undock_start + timedelta(hours=mh)

        # Commit resources at correct windows.
        pilots.allocate_n(1,     t_start,      mh)
        pilots.allocate_n(1,     undock_start, mh)
        tugs.allocate_n(n_tugs, t_start,      mh)
        tugs.allocate_n(n_tugs, undock_start, mh)

        berth_end[a.berth_id] = actual_t_end

        changed = (t_start != a.scheduled_start) or (waiting_undock_h > 0.01)

        if changed and v is not None:
            wait_h = max(0.0, (t_start - v.eta).total_seconds() / 3600)
            vessel_phases = build_phases(
                eta=v.eta, scheduled_start=t_start, scheduled_end=t_end,
                waiting_time_h=wait_h, duration_estimated_h=dur_h, maneuver_h=mh,
            )
            if waiting_undock_h > 0.01:
                new_ph: list[OperationPhase] = []
                for _p in vessel_phases:
                    if _p.name == "desatraque":
                        new_ph.append(OperationPhase(
                            name="waiting_undock",
                            start=desatraque_start, end=undock_start,
                            duration_h=round(waiting_undock_h, 4),
                        ))
                        new_ph.append(OperationPhase(
                            name="desatraque",
                            start=undock_start, end=actual_t_end,
                            duration_h=round(mh, 4),
                        ))
                    else:
                        new_ph.append(_p)
                vessel_phases = new_ph
            # Measure how much of the fondeo wait is attributable to resource
            # unavailability (vs. pure berth contention captured by t_start_berth).
            pilot_caused = pilot_dock > t_start_berth
            tug_caused   = tug_dock   > t_start_berth
            pilot_wait_h_val = round(max(0.0, (pilot_dock - t_start_berth).total_seconds() / 3600), 4) if pilot_caused else 0.0
            tug_wait_h_val   = round(max(0.0, (tug_dock   - t_start_berth).total_seconds() / 3600), 4) if tug_caused   else 0.0
            updated.append(AssignmentResult(
                vessel_id=a.vessel_id, berth_id=a.berth_id,
                noray_start=a.noray_start, noray_end=a.noray_end,
                scheduled_start=t_start, scheduled_end=actual_t_end,
                waiting_time_h=wait_h, duration_estimated_h=dur_h,
                duration_source=a.duration_source,
                pilot_assigned=True, tugs_required=n_tugs, tugs_assigned=True,
                status="assigned",
                pilot_caused_delay=a.pilot_caused_delay or pilot_caused,
                tug_caused_delay=a.tug_caused_delay   or tug_caused,
                caused_delay_to=a.caused_delay_to,
                maneuver_h=mh, phases=vessel_phases,
                pilot_wait_h=pilot_wait_h_val,
                tug_wait_h=tug_wait_h_val,
            ))
        else:
            updated.append(a)

    # Restore original assignment order before returning.
    updated.sort(key=lambda a: original_order.get(a.vessel_id, 9999))
    return updated + rest


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
            ls = LocalSearch(
                berths=berths,
                vessels=day_vessels,
                num_pilots=cfg.num_pilots,
                num_tugs=cfg.num_tugs,
            )
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

    # ── Re-planning ───────────────────────────────────────────────────────────

    def replan(self, request: ReplanRequest) -> ReplanResponse:
        """
        Re-plan after one or more vessel delays.

        Steps
        -----
        1. Apply delays to the base assignments (update fondeo phase, shift
           berth times only when the fondeo buffer is insufficient).
        2. Run conflict detection on the updated schedule.
        3. No conflicts → return the updated assignments as-is.  The fondeo
           phase of delayed vessels will be shorter (or zero), but no other
           vessel is affected.
        4. Conflicts → re-run the optimizer **only for the berths involved**
           in the conflicts, keeping all other berths' assignments frozen
           exactly as they are in base_assignments.  This preserves previous
           early-complete changes and replans on non-affected berths.

        The ``delay_h`` field attached to each assignment in the response
        tells the frontend how much delay was applied to that vessel — used
        to render the red delay segment in the Gantt.
        """
        delays_map: dict[str, float] = {d.vessel_id: d.delay_h for d in request.delays}
        delay_types_map: dict[str, str] = {d.vessel_id: d.delay_type for d in request.delays}

        # Early-arrival vessels always require a full berth replan: the optimizer
        # must attempt to dock them at the earliest available slot, which may be
        # sooner than their original scheduled_start.  They cannot be absorbed by
        # the fondeo-extension shortcut that normal delays use.
        early_arrival_ids: set[str] = {
            vid for vid, dtype in delay_types_map.items()
            if dtype == "early_arrival"
        }

        logger.info(
            "replan_start",
            n_delays=len(delays_map),
            vessels=list(delays_map.keys()),
            delay_types=delay_types_map,
        )

        # Step 1 — apply delays
        vessel_eta_map = {v.id: v.eta for v in request.vessels}
        updated = apply_delays_to_assignments(
            request.base_assignments, delays_map,
            delay_types=delay_types_map,
            vessel_eta_map=vessel_eta_map,
        )

        # Step 2 — conflict detection
        conflicts = detect_conflicts(updated, delays_map, request.config)

        # Step 3 — no conflicts AND no early arrivals: fondeo absorbed the delays
        # (or operation delay fits without displacing anyone).  Early arrivals
        # always proceed to step 4 so the optimizer can dock them sooner.
        if not conflicts and not early_arrival_ids:
            logger.info("replan_no_conflict", detail="fondeo absorbed all delays")
            # Deduplicate by vessel_id (assigned wins over non-assigned),
            # then strip the internal _shift_h sentinel.
            _rd_order: list[str] = []
            _rd_map:   dict[str, dict] = {}
            for _a in updated:
                _vid = _a.get("vessel_id", "")
                if _vid not in _rd_map:
                    _rd_order.append(_vid)
                    _rd_map[_vid] = _a
                elif (
                    _a.get("status") == "assigned"
                    and _rd_map[_vid].get("status") != "assigned"
                ):
                    _rd_map[_vid] = _a
            clean = [
                {k: v for k, v in _rd_map[_vid].items() if k != "_shift_h"}
                for _vid in _rd_order
            ]
            kpis = _compute_simple_kpis(clean, request.config.mooring_zones)
            return ReplanResponse(
                assignments=clean,
                kpis=kpis,
                replan_triggered=False,
                vessels_affected=[],
                conflicts_found=0,
                delay_map=delays_map,
            )

        # Step 4 — conflicts detected: partial re-schedule on affected berths only.
        #
        # A full optimizer re-run from scratch would discard every manual change
        # already baked into base_assignments (early-completes, prior replans on
        # other berths).  Instead we:
        #   a) identify which berths are involved in the conflicts,
        #   b) freeze all assignments on non-conflicted berths exactly as they are,
        #   c) re-run the optimizer only for the affected berths / vessels,
        #   d) stitch the frozen and re-scheduled parts back together.
        logger.info(
            "replan_triggered",
            n_conflicts=len(conflicts),
            types=[c.type for c in conflicts],
            details=[c.detail for c in conflicts],
        )

        # Build current-state maps from base_assignments so that vessels at a
        # conflict berth inherit ALL changes from prior replans, not just the
        # delay that triggered the current call.  The runner clears accumulated
        # delays after every successful replan and re-bases on the new snapshot,
        # so delays_map only ever contains the NEW delta — but the old deltas are
        # already baked into base_assignments.
        #
        # current-ETA: fondeo.start from the most recent schedule (accurate after
        # arrival-delay or early-arrival replans shifted the berth start).
        # current-duration: duration_estimated_h from base_assignments (extended
        # by any prior operation-delay replan).
        base_durations: dict[str, float] = {
            a["vessel_id"]: a.get("duration_estimated_h", 0.0)
            for a in request.base_assignments
            if isinstance(a, dict) and "vessel_id" in a
        }
        base_eta_map: dict[str, datetime] = {}
        for _a in request.base_assignments:
            _vid = _a.get("vessel_id", "")
            if _a.get("status") == "assigned":
                _fondeo = next(
                    (p for p in _a.get("phases", []) if p["name"] == "fondeo"),
                    None,
                )
                if _fondeo:
                    try:
                        base_eta_map[_vid] = datetime.fromisoformat(_fondeo["start"])
                    except (ValueError, KeyError):
                        pass

        updated_vessels = []
        for v in request.vessels:
            delay_h     = delays_map.get(v.id, 0.0)
            d_type      = delay_types_map.get(v.id, "arrival")
            current_eta = base_eta_map.get(v.id, v.eta)
            current_dur = base_durations.get(v.id) or v.estimated_duration_h or 0.0

            if delay_h > 0:
                if d_type == "operation":
                    updated_vessels.append(
                        v.model_copy(update={"estimated_duration_h": current_dur + delay_h})
                    )
                elif d_type == "early_arrival":
                    # Vessel arrived early — move ETA backwards so the optimizer
                    # can slot the vessel in sooner if the berth is free.
                    updated_vessels.append(
                        v.model_copy(update={"eta": current_eta - timedelta(hours=delay_h)})
                    )
                else:  # "arrival"
                    # Use max(fondeo.start, original ETA) as the arrival reference.
                    # If current_eta < v.eta (early-arrival shifted fondeo backwards),
                    # the delay should still be measured from the original ETA, not the
                    # shifted fondeo start — otherwise the visual delay window is wrong.
                    arrival_basis = current_eta if current_eta >= v.eta else v.eta
                    updated_vessels.append(
                        v.model_copy(update={"eta": arrival_basis + timedelta(hours=delay_h)})
                    )
            else:
                # No new delay for this vessel — carry forward any state
                # changes that prior replans already baked into base_assignments.
                updates: dict = {}
                if current_eta != v.eta:
                    updates["eta"] = current_eta
                if current_dur and current_dur != (v.estimated_duration_h or 0.0):
                    updates["estimated_duration_h"] = current_dur
                updated_vessels.append(v.model_copy(update=updates) if updates else v)

        # ── a) Which berths are involved? ─────────────────────────────────────
        conflict_vessel_ids: set[str] = {vid for c in conflicts for vid in c.vessel_ids}
        # Early arrival vessels must also be rescheduled regardless of whether
        # they caused a conventional berth/resource conflict.
        conflict_vessel_ids |= early_arrival_ids

        conflict_berth_ids: set[str] = set()
        for a in request.base_assignments:
            if a.get("vessel_id") in conflict_vessel_ids and a.get("status") == "assigned":
                bid = a.get("berth_id", "")
                if bid:
                    conflict_berth_ids.add(bid)

        # Also force-reschedule berths of vessels whose delay shifts their berth
        # times (_shift_h > 0) even when their berth has no capacity/pilot/tug
        # conflict.  Without this, such a vessel ends up in preserved_assignments
        # with its original (unshifted) schedule, and _inject_visual_delay_phases
        # then computes a retroactive delay window (e.g. 5:00→8:00 instead of
        # 8:00→11:00) because fondeo.start still equals the pre-delay ETA.
        for _shifted in updated:
            if _shifted.get("_shift_h", 0.0) > 0:
                _svid = _shifted.get("vessel_id", "")
                for _ba in request.base_assignments:
                    if _ba.get("vessel_id") == _svid and _ba.get("status") == "assigned":
                        _sbid = _ba.get("berth_id", "")
                        if _sbid:
                            conflict_berth_ids.add(_sbid)
                        break

        # ── b) Freeze all assignments on non-conflicted berths ────────────────
        reschedule_vessel_ids: set[str] = {
            a.get("vessel_id", "")
            for a in request.base_assignments
            if a.get("berth_id") in conflict_berth_ids
        }

        preserved_assignments = [
            dict(a) for a in request.base_assignments
            if a.get("vessel_id") not in reschedule_vessel_ids
        ]

        # ── c) Re-run optimizer only for the affected berths ──────────────────
        # Important: use the vessel's CURRENT berth (from base_assignments) as
        # target_berth, not the original requested berth.  The initial optimiser
        # may have placed a vessel at a different berth than its declared
        # target_berth (e.g. because the original berth was unavailable), and
        # the partial re-run only includes the conflict berths — so using the
        # wrong target_berth would produce spurious "invalid_berth" / unresolved
        # entries in the response.
        current_berth_of = {
            a.get("vessel_id", ""): a.get("berth_id", "")
            for a in request.base_assignments
            if a.get("vessel_id") in reschedule_vessel_ids
        }
        reschedule_vessels = [
            v.model_copy(update={"target_berth": current_berth_of.get(v.id, v.target_berth)})
            for v in updated_vessels
            if v.id in reschedule_vessel_ids
        ]
        conflict_berth_zones = [
            b for b in request.config.mooring_zones
            if b.berth_id in conflict_berth_ids
        ]

        if not conflict_berth_zones or not reschedule_vessels:
            # Fallback: pure pilot/tug conflict with no clear berth owner,
            # or vessels list is empty — re-run everything to stay feasible.
            logger.warning(
                "replan_fallback_full_rerun",
                reason="no conflict berths resolved; falling back to full replan",
                conflict_berth_ids=list(conflict_berth_ids),
            )
            partial_result = self.optimize(
                OptimizationRequest(vessels=updated_vessels, config=request.config)
            )
            partial_assignments = partial_result.assignments
        else:
            partial_config = request.config.model_copy(
                update={"mooring_zones": conflict_berth_zones}
            )
            partial_result = self.optimize(
                OptimizationRequest(vessels=reschedule_vessels, config=partial_config)
            )
            partial_assignments = partial_result.assignments

            logger.info(
                "replan_partial",
                conflict_berths=list(conflict_berth_ids),
                rescheduled_vessels=list(reschedule_vessel_ids),
                preserved_vessels=len(preserved_assignments),
            )

        # ── d) Stitch together and inject visual delay phases ─────────────────
        stitched = preserved_assignments + partial_assignments

        # Restore the original vessel order from base_assignments so that the
        # frontend Gantt renders berths in the same top-to-bottom position as
        # before the replan (stitching always appends partial assignments at the
        # end, which would otherwise move replanned berths to the bottom).
        _orig_order = {
            a.get("vessel_id"): i
            for i, a in enumerate(request.base_assignments)
        }
        stitched.sort(key=lambda a: _orig_order.get(a.get("vessel_id", ""), len(_orig_order)))

        # Extend delays_map with prior visual delays from base_assignments for vessels
        # that were rescheduled in this call but had no new delay entry (e.g. vessel A at
        # berth X had a prior +4h delay, then vessel B at the same berth triggers an
        # early-arrival replan — A ends up in partial_assignments with fresh phases but
        # delays_map only contains B's early_arrival entry, so A's red segment would be lost).
        total_delays_map = dict(delays_map)
        total_delay_types_map = dict(delay_types_map)
        for _a in request.base_assignments:
            _vid = _a.get("vessel_id", "")
            if _vid in reschedule_vessel_ids and _vid not in total_delays_map:
                prior_dh = _a.get("delay_h", 0.0) or 0.0
                if prior_dh > 0:
                    total_delays_map[_vid] = prior_dh
                    _phases = _a.get("phases", [])
                    if _phases and _phases[0].get("name") == "delay":
                        total_delay_types_map[_vid] = "arrival"
                    elif any(_p.get("name") == "delay" for _p in _phases):
                        total_delay_types_map[_vid] = "operation"

        final_assignments = _inject_visual_delay_phases(stitched, total_delays_map, total_delay_types_map)

        # Recompute lightweight KPIs over the full stitched schedule.
        final_kpis = _compute_simple_kpis(final_assignments, request.config.mooring_zones)

        vessels_affected: list[str] = list(conflict_vessel_ids)

        return ReplanResponse(
            assignments=final_assignments,
            kpis=final_kpis,
            replan_triggered=True,
            vessels_affected=vessels_affected,
            conflicts_found=len(conflicts),
            delay_map=delays_map,
        )

    # ── Early completion ──────────────────────────────────────────────────────

    def early_complete(self, request: EarlyCompleteRequest) -> EarlyCompleteResponse:
        """
        Handle early cargo-operation completion for one vessel.

        Steps
        -----
        1. Truncate ``ejecucion`` to *complete_time*.
        2. Check pilot / tug availability from *complete_time* onwards.
           If resources are occupied, insert a ``waiting_undock`` phase
           (light purple in the Gantt) until they are free.
        3. Update ``desatraque`` to start when resources are available.
        4. If the berth is freed significantly earlier than originally planned
           *and* there are vessels in fondeo waiting for it, pull each one
           forward in the schedule (cascade-safe: processes in arrival order,
           using the updated schedule of each predecessor for the next check).

        Returns the updated assignment list and simplified KPIs.
        """
        complete_dt = _parse_iso(request.complete_time)
        vessel_id   = request.vessel_id

        # Detect and warn about duplicate vessel_ids in base_assignments upfront.
        # Duplicates are the root cause of Gantt "ghost bars"; they are collapsed
        # in Step 3 so the response is always clean, but logging here helps trace
        # where they first appear.
        _dup_check: dict[str, int] = {}
        for _a in request.base_assignments:
            _vid = _a.get("vessel_id", "")
            _dup_check[_vid] = _dup_check.get(_vid, 0) + 1
        _dups = {k: v for k, v in _dup_check.items() if v > 1}
        if _dups:
            logger.warning("early_complete_duplicate_vessel_ids", duplicates=_dups)

        vessel_a = next(
            (a for a in request.base_assignments if a.get("vessel_id") == vessel_id),
            None,
        )
        if vessel_a is None:
            raise ValueError(f"Vessel '{vessel_id}' not found in base assignments")

        original_end     = _parse_iso(vessel_a["scheduled_end"])
        tugs_req         = vessel_a.get("tugs_required", 0)
        desatraque_dur_h = next(
            (p["duration_h"] for p in vessel_a.get("phases", []) if p["name"] == "desatraque"),
            1.0,
        )

        # Other currently active assignments — needed for resource availability checks
        other_active = [
            a for a in request.base_assignments
            if a.get("vessel_id") != vessel_id
            and a.get("status") == "assigned"
            and _parse_iso(a["scheduled_end"]) > complete_dt
        ]

        # Step 1 — find earliest undocking slot for the completing vessel
        undock_start     = _find_resource_slot(
            complete_dt, tugs_req, other_active,
            request.config.num_pilots, request.config.num_tugs,
        )
        waiting_undock_h = (undock_start - complete_dt).total_seconds() / 3600
        desatraque_end   = undock_start + timedelta(hours=desatraque_dur_h)

        logger.info(
            "early_complete_undock",
            vessel_id=vessel_id,
            complete_time=complete_dt.isoformat(),
            undock_start=undock_start.isoformat(),
            waiting_undock_h=round(waiting_undock_h, 2),
            berth_freed_at=desatraque_end.isoformat(),
        )

        # Step 2 — rebuild the completing vessel's assignment
        updated_a = _build_early_complete_assignment(
            vessel_a, complete_dt, undock_start, desatraque_end, waiting_undock_h,
        )

        # Step 3 — assemble new assignments list.
        #
        # Guard against duplicate vessel_id entries that can arrive when the
        # input CSV has repeated call-ids: the optimizer schedules such vessels
        # twice and produces one "assigned" result and one "invalid_berth" result
        # for the same id.  We keep the ASSIGNED copy when a conflict exists
        # (falling back to the first occurrence for non-assigned duplicates).
        # Using a stable ordered-dict ensures the final list never has more than
        # one entry per vessel_id.
        _dedup_order: list[str] = []          # insertion-ordered unique ids
        _dedup_map:   dict[str, dict] = {}    # vessel_id → winning raw dict

        for _a in request.base_assignments:
            _vid = _a.get("vessel_id", "")
            if _vid not in _dedup_map:
                _dedup_order.append(_vid)
                _dedup_map[_vid] = _a
            elif (
                _a.get("status") == "assigned"
                and _dedup_map[_vid].get("status") != "assigned"
            ):
                # Upgrade a non-assigned entry to the assigned version
                _dedup_map[_vid] = _a

        deduped_base = [_dedup_map[_vid] for _vid in _dedup_order]

        new_assignments: list[dict] = [
            updated_a if a.get("vessel_id") == vessel_id else dict(a)
            for a in deduped_base
        ]

        # Step 4 — cascade pull-forward for vessels waiting at this berth
        berth_freed_delta_h = max(
            0.0, (original_end - desatraque_end).total_seconds() / 3600
        )
        replan_triggered = False

        if berth_freed_delta_h > 0.05:
            berth_id = vessel_a.get("berth_id", "")

            # Vessels that haven't started berthing yet (scheduled_start in the
            # future) at the same berth, sorted by their current scheduled_start
            # so we process the queue in order.
            candidates = sorted(
                [
                    a for a in new_assignments
                    if a.get("vessel_id") != vessel_id
                    and a.get("berth_id") == berth_id
                    and a.get("status") == "assigned"
                    and _parse_iso(a["scheduled_start"]) > complete_dt
                ],
                key=lambda x: _parse_iso(x["scheduled_start"]),
            )

            if candidates:
                replan_triggered = True
                berth_avail = desatraque_end  # earliest the berth is now free

                for wa in candidates:
                    wa_id = wa.get("vessel_id")

                    # Resource check: exclude the completing vessel and wa itself
                    others_for_check = [
                        a for a in new_assignments
                        if a.get("vessel_id") not in (vessel_id, wa_id)
                        and a.get("status") == "assigned"
                        and _parse_iso(a["scheduled_end"]) > berth_avail
                    ]

                    # Earliest atraque slot: berth free AND pilot/tugs available
                    atraque_slot = _find_resource_slot(
                        berth_avail,
                        wa.get("tugs_required", 0),
                        others_for_check,
                        request.config.num_pilots,
                        request.config.num_tugs,
                    )

                    shifted = _shift_assignment_start(wa, atraque_slot)

                    # Use identity comparison (not vessel_id string matching) so
                    # that only the exact candidate entry is replaced — any other
                    # entry that happens to share the same vessel_id (e.g. a
                    # stale "invalid_berth" copy that survived dedup) is left
                    # untouched and therefore cannot be accidentally duplicated.
                    new_assignments = [shifted if a is wa else a for a in new_assignments]

                    # Advance berth availability for the next vessel in queue
                    berth_avail = _parse_iso(shifted["scheduled_end"])

                    logger.info(
                        "early_complete_replan",
                        waiting_vessel=wa_id,
                        old_start=_parse_iso(wa["scheduled_start"]).isoformat(),
                        new_start=_parse_iso(shifted["scheduled_start"]).isoformat(),
                    )

        kpis = _compute_simple_kpis(new_assignments, request.config.mooring_zones)

        return EarlyCompleteResponse(
            assignments=new_assignments,
            kpis=kpis,
            replan_triggered=replan_triggered,
            waiting_undock_h=round(waiting_undock_h, 2),
            berth_freed_delta_h=round(berth_freed_delta_h, 2),
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

def _compute_simple_kpis(assignments: list[dict], berths: list[BerthZone]) -> dict:
    """
    Lightweight KPI recomputation for the no-conflict replan path.

    Berth utilisation is omitted (expensive to recalculate without full state)
    and left at 0 — the frontend already has it from the original run.
    """
    assigned = [a for a in assignments if a.get("status") == "assigned"]
    total_wait = sum(a.get("waiting_time_h", 0.0) for a in assigned)
    avg_wait   = total_wait / len(assigned) if assigned else 0.0
    unresolved = sum(1 for a in assignments if a.get("status") != "assigned")

    source_breakdown: dict[str, int] = {}
    for a in assigned:
        src = a.get("duration_source", "default")
        source_breakdown[src] = source_breakdown.get(src, 0) + 1

    return {
        "total_waiting_time_h": round(total_wait, 2),
        "avg_waiting_time_h":   round(avg_wait, 2),
        "berth_utilization":    {b.berth_id: 0.0 for b in berths},
        "unresolved_vessels":   unresolved,
        "improvement_vs_greedy_pct": 0.0,
        "conflicts_resolved":   0,
        "duration_source_breakdown": source_breakdown,
        "resource_delays": {"pilot_caused": 0, "tug_caused": 0},
    }


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
        "pilot_caused_delay": a.pilot_caused_delay,
        "tug_caused_delay":   a.tug_caused_delay,
        "pilot_wait_h": round(a.pilot_wait_h, 4),
        "tug_wait_h":   round(a.tug_wait_h,   4),
        "phases": [
            {
                "name": p.name,
                "start": p.start.isoformat(),
                "end": p.end.isoformat(),
                "duration_h": round(p.duration_h, 2),
            }
            for p in a.phases
        ],
    }
