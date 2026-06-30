"""Orchestrator: combines calibration, greedy scheduling, and local search into a complete optimization pipeline."""

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


def _rebuild_states_from_assignments(
    assignments: list[AssignmentResult],
    berths: list[BerthZone],
) -> dict[str, ContinuousBerthState | DiscreteBerthState]:
    """
    Reconstruct berth occupancy states from a finalized list of assignments.

    Used to carry berth occupancy forward between day batches after local search
    may have altered scheduled_start or noray positions relative to the greedy output.

    Args:
        assignments (list[AssignmentResult]): All finalized assignments including prior days. Required.
        berths (list[BerthZone]): Port berth configurations used to create empty states. Required.

    Returns:
        dict[str, ContinuousBerthState | DiscreteBerthState]: Berth states keyed by berth_id.
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
            dur_h = (a.scheduled_end - a.scheduled_start).total_seconds() / 3600
            res = state.find_slot(a.scheduled_start, dur_h)
            if res is not None:
                si, _ = res
                state.assign(si, a.scheduled_start, a.scheduled_end, a.vessel_id)
    return states


def _inject_visual_delay_phases(
    assignments: list[dict],
    delays_map: dict[str, float],
    delay_types_map: dict[str, str],
) -> list[dict]:
    """
    Inject a visual delay phase into assignments produced by a full optimizer re-run for Gantt rendering.

    In the full-replan path the delay is already baked into the schedule, so only a colour
    marker phase is added without altering scheduled_start or scheduled_end.

    Args:
        assignments (list[dict]): Assignments from the full re-run to annotate. Required.
        delays_map (dict[str, float]): Mapping of vessel_id to delay hours. Required.
        delay_types_map (dict[str, str]): Mapping of vessel_id to delay type: "arrival", "operation", or "early_arrival". Required.

    Returns:
        list[dict]: Updated assignment list with visual delay phases inserted.
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
            updated["delay_h"] = 0
            updated["early_arrival_h"] = delay_h
            result.append(updated)
            continue

        elif d_type == "arrival":
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

        else:
            new_phases: list[dict] = []
            for p in phases:
                np_ = dict(p)
                if p["name"] == "ejecucion":
                    exec_end     = datetime.fromisoformat(p["end"])
                    new_exec_end = exec_end - delta
                    np_["end"]        = new_exec_end.isoformat()
                    np_["duration_h"] = round(
                        (new_exec_end - datetime.fromisoformat(p["start"])).total_seconds() / 3600,
                        4,
                    )
                    new_phases.append(np_)
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


def _parse_iso(s: str) -> datetime:
    """
    Parse an ISO 8601 string to a timezone-naive datetime for consistent internal comparisons.

    Handles trailing Z (stripped and treated as local time), 3-digit milliseconds
    (padded to 6 digits for Python 3.10 compatibility), and timezone offsets (stripped).

    Args:
        s (str): ISO 8601 datetime string, possibly with Z suffix or timezone offset. Required.

    Returns:
        datetime: Timezone-naive datetime object.
    """
    s = s.strip()

    if s.endswith("Z"):
        s = s[:-1]

    dot = s.rfind(".")
    if dot != -1:
        end = dot + 1
        while end < len(s) and s[end].isdigit():
            end += 1
        frac = s[dot + 1:end]
        if len(frac) < 6:
            s = s[:dot + 1] + frac.ljust(6, "0") + s[end:]

    for sep in ("+", "-"):
        idx = s.rfind(sep, 10)
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
    step_h: float = 0.25,
    max_search_h: float = 24.0,
) -> datetime:
    """
    Find the earliest time at or after earliest when one pilot and tugs_required tugs are simultaneously free.

    Uses 15-minute midpoint sampling of the search window. Returns earliest immediately
    when resources are already free. Falls back to earliest + max_search_h if nothing is found.

    Args:
        earliest (datetime): Earliest time to start searching from. Required.
        tugs_required (int): Number of tugs that must be available simultaneously. Required.
        other_assignments (list[dict]): Active assignments whose atraque/desatraque phases occupy resources. Required.
        num_pilots (int): Total pilot pool size. Required.
        num_tugs (int): Total tug pool size. Required.
        step_h (float): Search step size in hours. Optional, defaults to 0.25 (15 minutes).
        max_search_h (float): Maximum look-ahead window in hours before giving up. Optional, defaults to 24.0.

    Returns:
        datetime: Earliest time when the required resources are free.
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

    return deadline


def _build_early_complete_assignment(
    a: dict,
    complete_dt: datetime,
    undock_start: datetime,
    desatraque_end: datetime,
    waiting_undock_h: float,
) -> dict:
    """
    Rebuild an assignment dict for a vessel that completed its cargo operation early.

    Truncates ejecucion to complete_dt, optionally inserts a waiting_undock phase,
    and updates desatraque and scheduled_end to reflect the new undocking window.

    Args:
        a (dict): Original assignment dict for the early-completing vessel. Required.
        complete_dt (datetime): Time when the cargo operation actually finished. Required.
        undock_start (datetime): Time when undocking resources become available. Required.
        desatraque_end (datetime): New end time after the shifted desatraque. Required.
        waiting_undock_h (float): Hours the vessel must wait at berth for undocking resources. Required.

    Returns:
        dict: Updated assignment dict with phases adjusted for early completion.
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
    Shift a vessel's berthing start earlier to new_start, respecting the vessel's ETA as a hard floor.

    Shortens the fondeo phase and shifts atraque, ejecucion, and desatraque earlier by the same delta.
    Returns the assignment unchanged if new_start is not earlier than the current scheduled_start.

    Args:
        a (dict): Assignment dict for the vessel to shift. Required.
        new_start (datetime): Proposed earlier berthing start time. Required.

    Returns:
        dict: Updated assignment dict with phases shifted, or the original dict if no shift is possible.
    """
    phases = a.get("phases", [])

    fondeo_p = next((p for p in phases if p["name"] == "fondeo"), None)
    eta = _parse_iso(fondeo_p["start"]) if fondeo_p else _parse_iso(a["scheduled_start"])

    effective_start = max(new_start, eta)
    old_start       = _parse_iso(a["scheduled_start"])

    if effective_start >= old_start:
        return a

    delta   = old_start - effective_start
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
        new_phases.append(np_)

    updated["phases"] = new_phases
    return updated


def _enforce_resources_post_ls(
    assignments: list[AssignmentResult],
    num_pilots: int,
    num_tugs: int,
    vessel_map: dict[str, VesselInput],
) -> list[AssignmentResult]:
    """
    Re-enforce pilot and tug constraints across all berths after local search reordering.

    Local search reorders vessels within berths without checking cross-berth resource usage,
    which can create overlapping manoeuvre windows that exceed pool limits. This pass processes
    all assigned vessels in global scheduled_start order and delays docking or adds
    waiting_undock phases as needed to restore feasibility.

    Args:
        assignments (list[AssignmentResult]): All assignments after local search, including non-assigned. Required.
        num_pilots (int): Total pilot pool size. Required.
        num_tugs (int): Total tug pool size. Required.
        vessel_map (dict[str, VesselInput]): Mapping of vessel_id to VesselInput for phase rebuilding. Required.

    Returns:
        list[AssignmentResult]: Assignments with resource conflicts resolved, in original order.
    """
    from .scheduler import ResourcePool

    pilots = ResourcePool(num_pilots)
    tugs   = ResourcePool(num_tugs)

    assigned = sorted(
        [a for a in assignments if a.status == "assigned"],
        key=lambda a: a.scheduled_start,
    )
    rest = [a for a in assignments if a.status != "assigned"]

    # Computed - latest confirmed end time per berth for chaining successive vessel schedules
    berth_end: dict[str, datetime] = {}
    # Computed - original position of each vessel_id used to restore order after processing
    original_order = {a.vessel_id: i for i, a in enumerate(assignments)}

    updated: list[AssignmentResult] = []

    for a in assigned:
        v         = vessel_map.get(a.vessel_id)
        n_tugs    = a.tugs_required
        dur_h     = a.duration_estimated_h
        mh        = a.maneuver_h

        be = berth_end.get(a.berth_id)
        t_start = max(a.scheduled_start, be) if be else a.scheduled_start
        t_start_berth = t_start

        pilot_dock = pilots.earliest_n_available(1,     t_start, duration_h=mh)
        tug_dock   = tugs.earliest_n_available(n_tugs, t_start, duration_h=mh)
        r_start    = max(pilot_dock, tug_dock)
        if r_start > t_start:
            t_start = r_start

        t_end            = t_start + timedelta(hours=dur_h)
        desatraque_start = t_end - timedelta(hours=mh)

        pilot_undock = pilots.earliest_n_available(1,     desatraque_start, duration_h=mh)
        tug_undock   = tugs.earliest_n_available(n_tugs, desatraque_start, duration_h=mh)
        undock_start     = max(pilot_undock, tug_undock)
        waiting_undock_h = max(0.0, (undock_start - desatraque_start).total_seconds() / 3600)
        actual_t_end     = undock_start + timedelta(hours=mh)

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

    updated.sort(key=lambda a: original_order.get(a.vessel_id, 9999))
    return updated + rest


class Optimizer:
    """
    Main optimization orchestrator that runs the full three-phase pipeline: calibration, greedy scheduling, and local search.

    Vessels are partitioned by ETA date and optimized one day at a time. Berth states carry
    over between days while resource pools reset each day to model per-shift crewing.
    """

    def __init__(self, calibration: Optional[Calibration] = None) -> None:
        """
        Initialize the optimizer with an optional pre-fitted calibration.

        Args:
            calibration (Calibration): Fitted calibration object providing duration and manoeuvre models. Optional, defaults to None.
        """
        # User-provided - calibration object shared with Scheduler and DurationEstimator
        self.calibration = calibration

    def optimize(self, request: OptimizationRequest) -> OptimizationResponse:
        """
        Run the full optimization pipeline and return the final schedule with KPIs.

        Args:
            request (OptimizationRequest): Vessels and port configuration to optimize. Required.

        Returns:
            OptimizationResponse: Serialized assignments and aggregate KPI metrics.
        """
        cfg = request.config
        berths = cfg.mooring_zones

        logger.info(
            "optimization_start",
            n_vessels=len(request.vessels),
            n_berths=len(berths),
            num_pilots=cfg.num_pilots,
            num_tugs=cfg.num_tugs,
        )

        day_groups: dict = {}
        for v in sorted(request.vessels, key=lambda v: v.eta.date()):
            day_groups.setdefault(v.eta.date(), []).append(v)

        all_assignments: list[AssignmentResult] = []
        total_greedy_wait = 0.0
        total_conflicts = 0
        # Computed - berth states carried forward from the previous day; None on the first day
        carry_states: Optional[dict[str, ContinuousBerthState | DiscreteBerthState]] = None

        for day_date in sorted(day_groups):
            day_vessels = day_groups[day_date]

            states_before_day = (
                {bid: s.copy() for bid, s in carry_states.items()}
                if carry_states is not None
                else None
            )

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

            ls = LocalSearch(
                berths=berths,
                vessels=day_vessels,
                num_pilots=cfg.num_pilots,
                num_tugs=cfg.num_tugs,
            )
            day_final, _ = ls.improve(day_assignments, initial_states=states_before_day)

            all_assignments.extend(day_final)

            carry_states = _rebuild_states_from_assignments(all_assignments, berths)

            logger.info(
                "day_batch_done",
                date=str(day_date),
                n_vessels=len(day_vessels),
                greedy_wait=round(
                    sum(a.waiting_time_h for a in day_assignments if a.status == "assigned"), 2
                ),
            )

        groups: dict[str, list] = {}
        for v in request.vessels:
            groups.setdefault(v.target_berth, []).append(v)
        for bid in groups:
            groups[bid].sort(key=lambda v: v.gt, reverse=True)
        _fill_caused_delay(all_assignments, groups)

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

    def replan(self, request: ReplanRequest) -> ReplanResponse:
        """
        Re-plan the berth schedule after one or more vessel delays.

        If delays are absorbed by fondeo time and cause no conflicts, returns the updated
        schedule immediately. Otherwise, re-runs the optimizer only for the affected berths
        while freezing all other assignments unchanged.

        Args:
            request (ReplanRequest): Current schedule, delays to apply, port config, and original vessel inputs. Required.

        Returns:
            ReplanResponse: Updated assignments, KPIs, conflict count, and delay metadata.
        """
        delays_map: dict[str, float] = {d.vessel_id: d.delay_h for d in request.delays}
        delay_types_map: dict[str, str] = {d.vessel_id: d.delay_type for d in request.delays}

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

        vessel_eta_map = {v.id: v.eta for v in request.vessels}
        updated = apply_delays_to_assignments(
            request.base_assignments, delays_map,
            delay_types=delay_types_map,
            vessel_eta_map=vessel_eta_map,
        )

        conflicts = detect_conflicts(updated, delays_map, request.config)

        if not conflicts and not early_arrival_ids:
            logger.info("replan_no_conflict", detail="fondeo absorbed all delays")
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

        logger.info(
            "replan_triggered",
            n_conflicts=len(conflicts),
            types=[c.type for c in conflicts],
            details=[c.detail for c in conflicts],
        )

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
                    updated_vessels.append(
                        v.model_copy(update={"eta": current_eta - timedelta(hours=delay_h)})
                    )
                else:
                    arrival_basis = current_eta if current_eta >= v.eta else v.eta
                    updated_vessels.append(
                        v.model_copy(update={"eta": arrival_basis + timedelta(hours=delay_h)})
                    )
            else:
                updates: dict = {}
                if current_eta != v.eta:
                    updates["eta"] = current_eta
                if current_dur and current_dur != (v.estimated_duration_h or 0.0):
                    updates["estimated_duration_h"] = current_dur
                updated_vessels.append(v.model_copy(update=updates) if updates else v)

        conflict_vessel_ids: set[str] = {vid for c in conflicts for vid in c.vessel_ids}
        conflict_vessel_ids |= early_arrival_ids

        conflict_berth_ids: set[str] = set()
        for a in request.base_assignments:
            if a.get("vessel_id") in conflict_vessel_ids and a.get("status") == "assigned":
                bid = a.get("berth_id", "")
                if bid:
                    conflict_berth_ids.add(bid)

        for _shifted in updated:
            if _shifted.get("_shift_h", 0.0) > 0:
                _svid = _shifted.get("vessel_id", "")
                for _ba in request.base_assignments:
                    if _ba.get("vessel_id") == _svid and _ba.get("status") == "assigned":
                        _sbid = _ba.get("berth_id", "")
                        if _sbid:
                            conflict_berth_ids.add(_sbid)
                        break

        reschedule_vessel_ids: set[str] = {
            a.get("vessel_id", "")
            for a in request.base_assignments
            if a.get("berth_id") in conflict_berth_ids
        }

        preserved_assignments = [
            dict(a) for a in request.base_assignments
            if a.get("vessel_id") not in reschedule_vessel_ids
        ]

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

        stitched = preserved_assignments + partial_assignments

        _orig_order = {
            a.get("vessel_id"): i
            for i, a in enumerate(request.base_assignments)
        }
        stitched.sort(key=lambda a: _orig_order.get(a.get("vessel_id", ""), len(_orig_order)))

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

    def early_complete(self, request: EarlyCompleteRequest) -> EarlyCompleteResponse:
        """
        Handle early cargo-operation completion for one vessel and cascade pull-forward to waiting vessels.

        Truncates ejecucion, checks pilot and tug availability for undocking, optionally inserts a
        waiting_undock phase, and pulls forward any vessels waiting at the freed berth.

        Args:
            request (EarlyCompleteRequest): Vessel ID, actual completion time, current schedule, and port config. Required.

        Returns:
            EarlyCompleteResponse: Updated assignments, KPIs, and early-completion metrics.
        """
        complete_dt = _parse_iso(request.complete_time)
        vessel_id   = request.vessel_id

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

        other_active = [
            a for a in request.base_assignments
            if a.get("vessel_id") != vessel_id
            and a.get("status") == "assigned"
            and _parse_iso(a["scheduled_end"]) > complete_dt
        ]

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

        updated_a = _build_early_complete_assignment(
            vessel_a, complete_dt, undock_start, desatraque_end, waiting_undock_h,
        )

        _dedup_order: list[str] = []
        _dedup_map:   dict[str, dict] = {}

        for _a in request.base_assignments:
            _vid = _a.get("vessel_id", "")
            if _vid not in _dedup_map:
                _dedup_order.append(_vid)
                _dedup_map[_vid] = _a
            elif (
                _a.get("status") == "assigned"
                and _dedup_map[_vid].get("status") != "assigned"
            ):
                _dedup_map[_vid] = _a

        deduped_base = [_dedup_map[_vid] for _vid in _dedup_order]

        new_assignments: list[dict] = [
            updated_a if a.get("vessel_id") == vessel_id else dict(a)
            for a in deduped_base
        ]

        berth_freed_delta_h = max(
            0.0, (original_end - desatraque_end).total_seconds() / 3600
        )
        replan_triggered = False

        if berth_freed_delta_h > 0.05:
            berth_id = vessel_a.get("berth_id", "")

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
                berth_avail = desatraque_end

                for wa in candidates:
                    wa_id = wa.get("vessel_id")

                    others_for_check = [
                        a for a in new_assignments
                        if a.get("vessel_id") not in (vessel_id, wa_id)
                        and a.get("status") == "assigned"
                        and _parse_iso(a["scheduled_end"]) > berth_avail
                    ]

                    atraque_slot = _find_resource_slot(
                        berth_avail,
                        wa.get("tugs_required", 0),
                        others_for_check,
                        request.config.num_pilots,
                        request.config.num_tugs,
                    )

                    shifted = _shift_assignment_start(wa, atraque_slot)

                    new_assignments = [shifted if a is wa else a for a in new_assignments]

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

    def _compute_kpis(
        self,
        assignments: list[AssignmentResult],
        berths: list[BerthZone],
        greedy_wait: float,
        conflicts: int,
        improvement_pct: float,
    ) -> dict:
        """
        Compute aggregate KPI metrics for the full optimization result.

        Args:
            assignments (list[AssignmentResult]): All assignments including unassigned and invalid. Required.
            berths (list[BerthZone]): Port berth configurations for utilization calculation. Required.
            greedy_wait (float): Total waiting time from the greedy phase, used to measure improvement. Required.
            conflicts (int): Number of resource conflicts resolved during greedy scheduling. Required.
            improvement_pct (float): Waiting time reduction achieved by local search, as a percentage. Required.

        Returns:
            dict: KPI dictionary with waiting times, berth utilization, and resource delay counts.
        """
        assigned = [a for a in assignments if a.status == "assigned"]
        total_wait = sum(a.waiting_time_h for a in assigned)
        avg_wait = total_wait / len(assigned) if assigned else 0.0

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


def _compute_simple_kpis(assignments: list[dict], berths: list[BerthZone]) -> dict:
    """
    Compute lightweight KPI metrics without full berth utilization, used in the no-conflict replan path.

    Args:
        assignments (list[dict]): Serialized assignment dicts from the updated schedule. Required.
        berths (list[BerthZone]): Port berth configurations used to populate berth_utilization keys with zeros. Required.

    Returns:
        dict: Simplified KPI dictionary with waiting times and source breakdown; berth_utilization is always zero.
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
    """
    Serialize an AssignmentResult dataclass to a plain dict for the API response.

    Args:
        a (AssignmentResult): Assignment result to serialize. Required.

    Returns:
        dict: JSON-serializable dict with all assignment fields and serialized phases.
    """
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
