"""Conflict detection and delay application for dynamic re-planning after vessel delays."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import OptimizationConfig


@dataclass
class Conflict:
    """One detected resource or berth conflict in the updated schedule."""

    # Computed - conflict category: "berth", "pilot", or "tug"
    type: str
    # Computed - vessel IDs involved in this conflict
    vessel_ids: list[str] = field(default_factory=list)
    # Computed - human-readable description of the conflict for logging
    detail: str = ""


def apply_delays_to_assignments(
    assignments: list[dict],
    delays_map: dict[str, float],
    delay_types: dict[str, str] | None = None,
    vessel_eta_map: dict[str, "datetime"] | None = None,
) -> list[dict]:
    """
    Return a new list of assignment dicts with delays incorporated into their phases and schedules.

    Arrival delay shortens the fondeo phase if the buffer is sufficient, or shifts berth times forward.
    Operation delay extends ejecucion and inserts a red delay phase before desatraque.
    Early-arrival is passed through unchanged (the optimizer handles it during full re-run).

    Args:
        assignments (list[dict]): Current schedule as produced by the optimizer. Never modified in place. Required.
        delays_map (dict[str, float]): Mapping of vessel_id to total accumulated delay in hours. Required.
        delay_types (dict[str, str]): Mapping of vessel_id to delay type: "arrival", "operation", or "early_arrival". Optional, defaults to "arrival" for unlisted vessels.
        vessel_eta_map (dict[str, datetime]): Mapping of vessel_id to original ETA from the optimizer request. Optional, used to compute correct delay-phase timestamps after prior early-arrival replans.

    Returns:
        list[dict]: New list of assignment dicts with delays applied and _shift_h sentinel set.
    """
    if delay_types is None:
        delay_types = {}

    result: list[dict] = []
    for a in assignments:
        vid = a.get("vessel_id", "")
        delay_h = delays_map.get(vid, 0.0)

        if delay_h <= 0 or a.get("status") != "assigned":
            result.append({**a, "delay_h": delay_h, "_shift_h": 0.0})
            continue

        d_type = delay_types.get(vid, "arrival")

        if d_type == "operation":
            result.append(_apply_operation_delay(a, delay_h))
        elif d_type == "early_arrival":
            result.append(_apply_early_arrival(a, delay_h))
        else:
            v_eta = vessel_eta_map.get(vid) if vessel_eta_map else None
            result.append(_apply_arrival_delay(a, delay_h, vessel_eta=v_eta))

    return result


def _apply_arrival_delay(a: dict, delay_h: float, vessel_eta: "datetime | None" = None) -> dict:
    """
    Apply an arrival-type delay to one assignment dict, updating fondeo and shifting berth times if needed.

    Args:
        a (dict): Single assignment dict to update. Required.
        delay_h (float): Number of hours of arrival delay to apply. Required.
        vessel_eta (datetime): Original vessel ETA from the optimizer request, used when fondeo.start was shifted by a prior early-arrival replan. Optional, defaults to None.

    Returns:
        dict: Updated assignment dict with delay applied and _shift_h set to the berth-time shift in hours.
    """
    phases = a.get("phases", [])

    fondeo_phase = next((p for p in phases if p["name"] == "fondeo"), None)

    if fondeo_phase:
        fondeo_s = datetime.fromisoformat(fondeo_phase["start"])
        if vessel_eta is not None and vessel_eta > fondeo_s:
            arrival_basis = vessel_eta
        else:
            arrival_basis = fondeo_s
    else:
        arrival_basis = datetime.fromisoformat(a["scheduled_start"])

    current_sched_start = datetime.fromisoformat(a["scheduled_start"])
    target_sched_start  = arrival_basis + timedelta(hours=delay_h)
    extra_h = max(0.0, (target_sched_start - current_sched_start).total_seconds() / 3600)

    updated = dict(a)
    updated["delay_h"]  = delay_h
    updated["_shift_h"] = extra_h

    if extra_h > 0:
        delta = timedelta(hours=extra_h)
        updated["scheduled_start"] = (current_sched_start + delta).isoformat()
        updated["scheduled_end"]   = (
            datetime.fromisoformat(a["scheduled_end"]) + delta
        ).isoformat()

    new_eta         = arrival_basis + timedelta(hours=delay_h)
    new_sched_start = datetime.fromisoformat(updated["scheduled_start"])
    updated["waiting_time_h"] = round(
        max(0.0, (new_sched_start - new_eta).total_seconds() / 3600), 4
    )

    if phases:
        new_phases: list[dict] = []

        new_phases.append({
            "name":       "delay",
            "start":      arrival_basis.isoformat(),
            "end":        new_eta.isoformat(),
            "duration_h": round(delay_h, 4),
        })

        for p in phases:
            if p["name"] == "delay":
                continue
            np_ = dict(p)
            if p["name"] == "fondeo":
                np_["start"]      = new_eta.isoformat()
                np_["end"]        = new_sched_start.isoformat()
                np_["duration_h"] = round(
                    max(0.0, (new_sched_start - new_eta).total_seconds() / 3600), 4
                )
            elif extra_h > 0:
                delta = timedelta(hours=extra_h)
                np_["start"] = (datetime.fromisoformat(p["start"]) + delta).isoformat()
                np_["end"]   = (datetime.fromisoformat(p["end"])   + delta).isoformat()
            new_phases.append(np_)

        updated["phases"] = new_phases

    return updated


def _apply_operation_delay(a: dict, delay_h: float) -> dict:
    """
    Apply an operation-type delay to one assignment dict by extending ejecucion and shifting desatraque.

    Args:
        a (dict): Single assignment dict to update. Required.
        delay_h (float): Number of hours of operation delay to apply. Required.

    Returns:
        dict: Updated assignment dict with delay phase inserted and scheduled_end shifted forward.
    """
    delta = timedelta(hours=delay_h)

    updated = dict(a)
    updated["delay_h"] = delay_h
    updated["_shift_h"] = delay_h
    updated["scheduled_end"] = (
        datetime.fromisoformat(a["scheduled_end"]) + delta
    ).isoformat()

    phases = a.get("phases", [])
    if phases:
        new_phases: list[dict] = []
        for p in phases:
            np_ = dict(p)
            if p["name"] == "ejecucion":
                new_phases.append(np_)
                exec_end = datetime.fromisoformat(p["end"])
                delay_end = exec_end + delta
                new_phases.append({
                    "name": "delay",
                    "start": exec_end.isoformat(),
                    "end": delay_end.isoformat(),
                    "duration_h": round(delay_h, 4),
                })
            elif p["name"] == "desatraque":
                np_["start"] = (datetime.fromisoformat(p["start"]) + delta).isoformat()
                np_["end"]   = (datetime.fromisoformat(p["end"])   + delta).isoformat()
                new_phases.append(np_)
            else:
                new_phases.append(np_)
        updated["phases"] = new_phases

    return updated


def _apply_early_arrival(a: dict, early_h: float) -> dict:
    """
    Pass-through for early-arrival assignments, marking them for full optimizer re-run.

    The optimizer always forces a berth re-run for early-arrival vessels, so phase changes
    made here would be discarded. Sets _shift_h to 0 so detect_conflicts does not treat
    this as a shift-based conflict.

    Args:
        a (dict): Single assignment dict to update. Required.
        early_h (float): Number of hours the vessel arrived early. Required.

    Returns:
        dict: Updated assignment dict with delay_h set and _shift_h set to 0.
    """
    updated = dict(a)
    updated["delay_h"]  = early_h
    updated["_shift_h"] = 0.0
    return updated


def detect_conflicts(
    updated_assignments: list[dict],
    delays_map: dict[str, float],
    config: "OptimizationConfig",
) -> list[Conflict]:
    """
    Detect schedule conflicts in updated_assignments after delays have been applied.

    Returns an empty list when no conflicts exist, meaning all delays were absorbed by
    fondeo time and the berth schedule remains feasible. Checks berth capacity first,
    then pilot availability, then tug availability.

    Args:
        updated_assignments (list[dict]): Delay-applied assignment list produced by apply_delays_to_assignments. Required.
        delays_map (dict[str, float]): Mapping of vessel_id to delay hours, used for context. Required.
        config (OptimizationConfig): Port configuration providing num_pilots, num_tugs, and mooring_zones. Required.

    Returns:
        list[Conflict]: List of detected conflicts; empty when the schedule is feasible.
    """
    shifted: set[str] = set()
    for a in updated_assignments:
        if a.get("_shift_h", 0.0) > 0:
            shifted.add(a.get("vessel_id", ""))

    if not shifted:
        return []

    assigned = [a for a in updated_assignments if a.get("status") == "assigned"]
    conflicts: list[Conflict] = []

    zone_map = {z.berth_id: z for z in config.mooring_zones}

    berth_groups: dict[str, list[dict]] = {}
    for a in assigned:
        berth_groups.setdefault(a.get("berth_id", ""), []).append(a)

    for bid, group in berth_groups.items():
        zone = zone_map.get(bid)
        if zone and zone.bap_type == "continuous":
            for i, a1 in enumerate(group):
                s1 = datetime.fromisoformat(a1["scheduled_start"])
                e1 = datetime.fromisoformat(a1["scheduled_end"])
                ns1: int = a1.get("noray_start") or 0
                ne1: int = a1.get("noray_end") or 0
                for a2 in group[i + 1:]:
                    s2 = datetime.fromisoformat(a2["scheduled_start"])
                    e2 = datetime.fromisoformat(a2["scheduled_end"])
                    ns2: int = a2.get("noray_start") or 0
                    ne2: int = a2.get("noray_end") or 0
                    if s1 < e2 and s2 < e1 and ns1 <= ne2 and ns2 <= ne1:
                        conflicts.append(Conflict(
                            type="berth",
                            vessel_ids=[a1["vessel_id"], a2["vessel_id"]],
                            detail=(
                                f"Berth {bid}: vessels overlap in time "
                                f"[{s1}–{e1}] ∩ [{s2}–{e2}] "
                                f"and noray [{ns1}–{ne1}] ∩ [{ns2}–{ne2}]"
                            ),
                        ))
        else:
            capacity = (zone.capacity or 1) if zone else 1

            events: list[tuple[datetime, str, str]] = []
            for a in group:
                events.append((datetime.fromisoformat(a["scheduled_start"]), "start", a["vessel_id"]))
                events.append((datetime.fromisoformat(a["scheduled_end"]),   "end",   a["vessel_id"]))

            events.sort(key=lambda x: (x[0], 0 if x[1] == "end" else 1))

            active: set[str] = set()
            for _t, etype, vid in events:
                if etype == "end":
                    active.discard(vid)
                else:
                    active.add(vid)
                    if len(active) > capacity:
                        conflicts.append(Conflict(
                            type="berth",
                            vessel_ids=list(active),
                            detail=(
                                f"Berth {bid}: {len(active)} vessels active "
                                f"but capacity is {capacity}"
                            ),
                        ))
                        break

    if conflicts:
        return conflicts

    maneuver_events: list[tuple[datetime, datetime, str, int]] = []
    for a in assigned:
        n_tugs: int = a.get("tugs_required", 0)
        for p in a.get("phases", []):
            if p["name"] in ("atraque", "desatraque"):
                ps = datetime.fromisoformat(p["start"])
                pe = datetime.fromisoformat(p["end"])
                maneuver_events.append((ps, pe, a["vessel_id"], n_tugs))

    if not maneuver_events:
        return conflicts

    t_points = sorted(
        {e[0] for e in maneuver_events} | {e[1] for e in maneuver_events}
    )
    sample_points: list[datetime] = []
    for i in range(len(t_points) - 1):
        mid = t_points[i] + (t_points[i + 1] - t_points[i]) / 2
        sample_points.append(mid)

    for t in sample_points:
        concurrent = [e for e in maneuver_events if e[0] <= t < e[1]]
        if not concurrent:
            continue

        n_concurrent = len(concurrent)
        if n_concurrent > config.num_pilots:
            conflicts.append(Conflict(
                type="pilot",
                vessel_ids=[e[2] for e in concurrent],
                detail=(
                    f"Pilot conflict at {t}: {n_concurrent} manoeuvres "
                    f"need pilots but only {config.num_pilots} available"
                ),
            ))
            return conflicts

        tug_demand = sum(e[3] for e in concurrent)
        if tug_demand > config.num_tugs:
            conflicts.append(Conflict(
                type="tug",
                vessel_ids=[e[2] for e in concurrent],
                detail=(
                    f"Tug conflict at {t}: {tug_demand} tugs needed "
                    f"but only {config.num_tugs} available"
                ),
            ))
            return conflicts

    return conflicts
