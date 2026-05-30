"""
Conflict detection for dynamic re-planning after vessel delays.

The main entry points are:
  apply_delays_to_assignments  — update assignment dicts with shifted schedules
  detect_conflicts             — check for berth / pilot / tug violations
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import OptimizationConfig


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class Conflict:
    """One detected resource conflict."""
    type: str                          # "berth" | "pilot" | "tug"
    vessel_ids: list[str] = field(default_factory=list)
    detail: str = ""


# ── Delay application ─────────────────────────────────────────────────────────

def apply_delays_to_assignments(
    assignments: list[dict],
    delays_map: dict[str, float],
    delay_types: dict[str, str] | None = None,
    vessel_eta_map: dict[str, "datetime"] | None = None,
) -> list[dict]:
    """
    Return a new list of assignment dicts with delays incorporated.

    Parameters
    ----------
    assignments : list[dict]
        Current schedule (typically the original optimizer output – *base
        assignments*).  Never modified in place.
    delays_map : dict[str, float]
        vessel_id → total accumulated delay in hours.
    delay_types : dict[str, str] | None
        vessel_id → ``"arrival"`` | ``"operation"``.  Defaults to
        ``"arrival"`` for any vessel not explicitly listed.
    vessel_eta_map : dict[str, datetime] | None
        vessel_id → original vessel ETA (from the optimizer request).
        Used by the arrival-delay path to avoid measuring delays from a
        fondeo.start that was shifted backwards by a prior early-arrival
        replan (which would produce wrong delay-phase timestamps).

    Delay semantics
    ---------------
    **Arrival delay** (vessel hasn't docked yet):

    * A ``delay`` phase is *prepended* to the phases list covering
      [arrival_basis, arrival_basis + delay_h], where ``arrival_basis``
      is ``max(fondeo.start, vessel_eta)`` — the original ETA is used
      when a prior early-arrival replan moved fondeo.start backwards.
    * The fondeo phase is shortened (new start = arrival_basis + delay_h).
    * If the new berthing time > current scheduled_start, the excess
      (``extra_h``) shifts scheduled_start, scheduled_end, and all
      non-fondeo phases forward.
    * ``_shift_h`` is set to ``extra_h`` (> 0 only when berth times move).

    **Operation delay** (vessel already docked):

    * A ``delay`` phase is *inserted* between ``ejecucion`` and
      ``desatraque``, covering [original_exec_end,
      original_exec_end + delay_h].
    * ``desatraque`` shifts forward by delay_h.
    * ``scheduled_end`` shifts forward by delay_h;
      ``scheduled_start`` is unchanged.
    * ``_shift_h`` is set to ``delay_h`` (always > 0 → always triggers
      conflict detection).

    The ``_shift_h`` sentinel in each updated dict is used internally by
    :func:`detect_conflicts` and is **not** part of the public API.
    """
    if delay_types is None:
        delay_types = {}

    result: list[dict] = []
    for a in assignments:
        vid = a.get("vessel_id", "")
        delay_h = delays_map.get(vid, 0.0)

        # Pass-through for non-assigned or un-delayed assignments.
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
    """Apply an arrival-type delay to one assignment dict.

    ``vessel_eta`` is the original vessel ETA from the optimizer request.
    When provided and greater than the current fondeo.start (e.g. after a
    prior early-arrival replan shifted fondeo backwards), the delay is
    measured from ``vessel_eta`` instead of the shifted fondeo.start.

    Important: phases[0] may be an old ``delay`` phase from a prior
    replan — we find fondeo by name rather than assuming index 0.
    Any existing ``delay`` phases are stripped and replaced by a fresh one.
    """
    phases = a.get("phases", [])

    # Find fondeo by name — phases[0] may be an old "delay" phase.
    fondeo_phase = next((p for p in phases if p["name"] == "fondeo"), None)

    if fondeo_phase:
        fondeo_s = datetime.fromisoformat(fondeo_phase["start"])
        if vessel_eta is not None and vessel_eta > fondeo_s:
            # Prior early-arrival replan moved fondeo backward; measure delay
            # from the original vessel ETA, not the shifted fondeo start.
            arrival_basis = vessel_eta
        else:
            arrival_basis = fondeo_s
    else:
        arrival_basis = datetime.fromisoformat(a["scheduled_start"])

    # How much do berth times need to shift?
    # Target: new_ETA = arrival_basis + delay_h must be <= scheduled_start.
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

    # Rebuild phases ──────────────────────────────────────────────────────────
    new_eta         = arrival_basis + timedelta(hours=delay_h)
    new_sched_start = datetime.fromisoformat(updated["scheduled_start"])
    updated["waiting_time_h"] = round(
        max(0.0, (new_sched_start - new_eta).total_seconds() / 3600), 4
    )

    if phases:
        new_phases: list[dict] = []

        # Fresh delay phase — replaces any old delay phase already in the list.
        new_phases.append({
            "name":       "delay",
            "start":      arrival_basis.isoformat(),
            "end":        new_eta.isoformat(),
            "duration_h": round(delay_h, 4),
        })

        for p in phases:
            if p["name"] == "delay":
                continue  # drop prior delay phases — replaced by the fresh one above
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
    """Apply an operation-type delay to one assignment dict.

    The red segment is inserted between *ejecucion* and *desatraque*.
    Scheduled_start is unchanged; scheduled_end shifts by delay_h.
    """
    delta = timedelta(hours=delay_h)

    updated = dict(a)
    updated["delay_h"] = delay_h
    # Operation delays always shift scheduled_end → always a potential conflict
    updated["_shift_h"] = delay_h
    updated["scheduled_end"] = (
        datetime.fromisoformat(a["scheduled_end"]) + delta
    ).isoformat()
    # waiting_time_h is unchanged (vessel was already at berth)

    phases = a.get("phases", [])
    if phases:
        new_phases: list[dict] = []
        for p in phases:
            np_ = dict(p)
            if p["name"] == "ejecucion":
                # Ejecucion keeps its original end time; delay follows after it
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
                # Desatraque shifts forward
                np_["start"] = (datetime.fromisoformat(p["start"]) + delta).isoformat()
                np_["end"]   = (datetime.fromisoformat(p["end"])   + delta).isoformat()
                new_phases.append(np_)
            else:
                new_phases.append(np_)
        updated["phases"] = new_phases

    return updated


def _apply_early_arrival(a: dict, early_h: float) -> dict:
    """Pass-through for early-arrival assignments before the full replan.

    ``replan()`` in the optimizer always forces a full berth re-run for
    early-arrival vessels (``early_arrival_ids`` set), so any phase changes
    made here would be discarded.  We simply mark ``_shift_h = 0`` so that
    :func:`detect_conflicts` does not treat this as a shift-based conflict,
    and let the optimizer rebuild the phases from scratch.
    """
    updated = dict(a)
    updated["delay_h"]  = early_h
    updated["_shift_h"] = 0.0
    return updated


# ── Conflict detection ────────────────────────────────────────────────────────

def detect_conflicts(
    updated_assignments: list[dict],
    delays_map: dict[str, float],
    config: "OptimizationConfig",
) -> list[Conflict]:
    """
    Detect schedule conflicts in *updated_assignments* (already delay-applied).

    Returns an empty list when no conflicts exist — meaning all delays were
    absorbed by fondeo time and the berth schedule is still feasible.

    Checks (in order, short-circuits on first conflict type found):
      1. Berth capacity: > capacity vessels overlap at the same berth
      2. Pilot availability: concurrent docking/undocking events > num_pilots
      3. Tug availability: concurrent tug demand > num_tugs

    ``_shift_h`` on each assignment (set by :func:`apply_delays_to_assignments`)
    is used to determine which vessels actually moved in the schedule.  Only
    those can introduce *new* conflicts.
    """
    # Only vessels whose schedule was actually shifted can introduce new
    # conflicts.  (Arrival delay ≤ fondeo buffer → _shift_h = 0; those are safe.)
    shifted: set[str] = set()
    for a in updated_assignments:
        if a.get("_shift_h", 0.0) > 0:
            shifted.add(a.get("vessel_id", ""))

    if not shifted:
        # No vessel was shifted → no new berth/resource conflicts possible
        return []

    assigned = [a for a in updated_assignments if a.get("status") == "assigned"]
    conflicts: list[Conflict] = []

    # ── 1. Berth capacity conflicts ───────────────────────────────────────────
    zone_map = {z.berth_id: z for z in config.mooring_zones}

    berth_groups: dict[str, list[dict]] = {}
    for a in assigned:
        berth_groups.setdefault(a.get("berth_id", ""), []).append(a)

    for bid, group in berth_groups.items():
        zone = zone_map.get(bid)
        if zone and zone.bap_type == "continuous":
            # Continuous berths: check noray-position overlap
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
                    # Temporal AND spatial overlap
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
            # Discrete berth: count concurrently active vessels vs capacity
            capacity = (zone.capacity or 1) if zone else 1

            # Sweep-line: collect all start/end events
            events: list[tuple[datetime, str, str]] = []
            for a in group:
                events.append((datetime.fromisoformat(a["scheduled_start"]), "start", a["vessel_id"]))
                events.append((datetime.fromisoformat(a["scheduled_end"]),   "end",   a["vessel_id"]))

            # Sort: ends before starts at the same timestamp (vessel leaves before next arrives)
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
                        break  # one conflict per berth is enough

    if conflicts:
        return conflicts  # Berth conflicts take priority — report immediately

    # ── 2. Pilot / tug resource conflicts ────────────────────────────────────
    # Each docking (atraque) and undocking (desatraque) occupies 1 pilot
    # and n_tugs tugs for its duration.
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

    # Collect all event-boundary timestamps and sample each open interval
    t_points = sorted(
        {e[0] for e in maneuver_events} | {e[1] for e in maneuver_events}
    )
    # Use midpoints of consecutive timestamps for accurate interval sampling
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
            return conflicts  # one conflict type at a time is enough

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
