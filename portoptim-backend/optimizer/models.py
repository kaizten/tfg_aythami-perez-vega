"""Pydantic API models and internal dataclasses for the berth scheduling optimizer."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Literal, Optional

from pydantic import BaseModel, Field

# Fixed - metres per noray unit (bollard spacing along the quay)
NORAY_SPACING_M: float = 12.0
# Fixed - hours a pilot and tug are occupied during a single docking or undocking manoeuvre
DOCKING_DURATION_H: float = 1.0

# Fixed - cargo groups that require an extra tug for safety reasons
HAZARDOUS_CARGO_GROUPS: frozenset[str] = frozenset({"Energético", "Químicos"})


def norays_needed(eslora: float) -> int:
    """
    Compute the number of contiguous noray positions required for a vessel.

    Args:
        eslora (float): Vessel length in metres. Required.

    Returns:
        int: Number of noray positions needed, always at least 1.
    """
    return max(1, math.ceil(eslora / NORAY_SPACING_M))


def required_tugs(gt: float, cargo_group: str, has_bow_thruster: bool = False) -> int:
    """
    Calculate the number of tugs required for a vessel manoeuvre.

    Args:
        gt (float): Gross tonnage of the vessel. Required.
        cargo_group (str): Cargo group identifier, used to detect hazardous cargo. Required.
        has_bow_thruster (bool): Whether the vessel has a bow thruster fitted. Optional, defaults to False.

    Returns:
        int: Number of tugs required, clamped to [0, 4].
    """
    if gt < 500:
        base = 0
    elif gt < 3_000:
        base = 1
    elif gt < 10_000:
        base = 2
    elif gt < 40_000:
        base = 3
    else:
        base = 4

    total = base
    if cargo_group in HAZARDOUS_CARGO_GROUPS:
        total += 1
    if has_bow_thruster:
        total -= 1

    return max(0, min(total, 4))


class VesselOperation(BaseModel):
    """A single cargo operation to be performed by a vessel during its port call."""

    # User-provided - type of port operation (e.g. loading, unloading)
    tipo_operacion: str
    # User-provided - cargo group identifier for this operation
    grupo_mercancia: str
    # User-provided - quantity of cargo in tonnes; None if unknown
    cantidad: Optional[float] = None


class VesselInput(BaseModel):
    """Input data for a single vessel requesting a berth assignment."""

    # User-provided - unique vessel identifier
    id: str
    # User-provided - estimated time of arrival at the port
    eta: datetime
    # User-provided - vessel length overall in metres
    eslora: float
    # User-provided - gross tonnage of the vessel
    gt: float
    # User-provided - requested berth identifier
    target_berth: str
    # User-provided - list of cargo operations to be performed
    operations: list[VesselOperation] = Field(default_factory=list)
    # User-provided - pre-calculated operation duration in hours; overrides model estimates when provided
    estimated_duration_h: Optional[float] = None
    # User-provided - whether the vessel is fitted with a bow thruster
    has_bow_thruster: bool = False


class BerthZone(BaseModel):
    """Configuration for one mooring zone (berth) in the port."""

    # User-provided - unique berth identifier
    berth_id: str
    # User-provided - berth layout type: "continuous" for linear quay, "discrete" for fixed slots
    bap_type: str
    # User-provided - total noray positions available on a continuous berth
    noray_max: Optional[int] = None
    # User-provided - number of simultaneous vessel slots on a discrete berth
    capacity: Optional[int] = None


class OptimizationConfig(BaseModel):
    """Port-wide resource and policy configuration passed with every optimization request."""

    # User-provided - total number of pilots available in the shift
    num_pilots: int = 3
    # User-provided - total number of tugs available in the shift
    num_tugs: int = 2
    # User-provided - default service duration in hours used when no estimate is available
    default_duration_h: float = 48.0
    # User-provided - fraction applied to summed multi-operation durations to model parallelism
    overlap_factor: float = 0.70
    # User-provided - list of mooring zones (berths) available in the port
    mooring_zones: list[BerthZone]


class OptimizationRequest(BaseModel):
    """Full input payload for the /run optimization endpoint."""

    # User-provided - vessels to be scheduled in this optimization run
    vessels: list[VesselInput]
    # User-provided - port configuration for this optimization run
    config: OptimizationConfig


@dataclass
class OperationPhase:
    """Temporal breakdown of one stage in a vessel's port lifecycle."""

    # Fixed - phase name: "fondeo", "atraque", "ejecucion", or "desatraque"
    name: str
    # Computed - wall-clock start time of this phase
    start: datetime
    # Computed - wall-clock end time of this phase
    end: datetime
    # Computed - duration of this phase in hours
    duration_h: float


def build_phases(
    eta: datetime,
    scheduled_start: datetime,
    scheduled_end: datetime,
    waiting_time_h: float,
    duration_estimated_h: float,
    maneuver_h: float,
) -> list[OperationPhase]:
    """
    Build the four operational phases for an assigned vessel.

    If the combined manoeuvre time (atraque + desatraque) would leave less
    than 0.1 h for ejecucion, both manoeuvre durations are scaled down
    proportionally so that ejecucion always has at least 0.1 h.

    Args:
        eta (datetime): Vessel estimated time of arrival. Required.
        scheduled_start (datetime): Assigned berthing start time. Required.
        scheduled_end (datetime): Assigned berthing end time. Required.
        waiting_time_h (float): Hours spent waiting at anchor before berthing. Required.
        duration_estimated_h (float): Total estimated service duration in hours. Required.
        maneuver_h (float): Duration of a single manoeuvre (docking or undocking) in hours. Required.

    Returns:
        list[OperationPhase]: Ordered list of four phases: fondeo, atraque, ejecucion, desatraque.
    """
    min_exec_h = 0.1
    total_maneuver = maneuver_h * 2
    if total_maneuver >= duration_estimated_h - min_exec_h:
        scale = max(0.0, (duration_estimated_h - min_exec_h) / total_maneuver)
        maneuver_h = maneuver_h * scale

    fondeo_start = eta
    fondeo_end = scheduled_start
    fondeo_h = max(0.0, waiting_time_h)

    atraque_start = scheduled_start
    atraque_end = atraque_start + timedelta(hours=maneuver_h)
    atraque_h = maneuver_h

    desatraque_h = maneuver_h
    desatraque_end = scheduled_end
    desatraque_start = desatraque_end - timedelta(hours=desatraque_h)

    exec_start = atraque_end
    exec_end = desatraque_start
    exec_h = max(0.0, (exec_end - exec_start).total_seconds() / 3600)

    return [
        OperationPhase(name="fondeo",     start=fondeo_start,    end=fondeo_end,    duration_h=fondeo_h),
        OperationPhase(name="atraque",    start=atraque_start,   end=atraque_end,   duration_h=atraque_h),
        OperationPhase(name="ejecucion",  start=exec_start,      end=exec_end,      duration_h=exec_h),
        OperationPhase(name="desatraque", start=desatraque_start, end=desatraque_end, duration_h=desatraque_h),
    ]


@dataclass
class AssignmentResult:
    """Internal result dataclass holding the full scheduling outcome for one vessel."""

    # Computed - vessel identifier from the input request
    vessel_id: str
    # Computed - berth identifier where the vessel was assigned
    berth_id: str
    # Computed - first noray position occupied (None for discrete berths)
    noray_start: Optional[int]
    # Computed - last noray position occupied (None for discrete berths)
    noray_end: Optional[int]
    # Computed - time when the vessel starts occupying the berth
    scheduled_start: datetime
    # Computed - time when the vessel vacates the berth (includes any waiting_undock extension)
    scheduled_end: datetime
    # Computed - hours spent waiting at anchor before the berth became available
    waiting_time_h: float
    # Computed - total estimated service duration in hours
    duration_estimated_h: float
    # Computed - source of the duration estimate: "provided", "rate_model", "statistical_model", or "default"
    duration_source: str
    # Computed - True when a pilot was successfully allocated for this vessel
    pilot_assigned: bool
    # Computed - number of tugs required based on GT, cargo group, and bow thruster
    tugs_required: int
    # Computed - True when all required tugs were successfully allocated
    tugs_assigned: bool
    # Computed - scheduling outcome: "assigned", "unassigned", or "invalid_berth"
    status: str
    # Computed - True when the docking was delayed due to pilot unavailability
    pilot_caused_delay: bool = False
    # Computed - True when the docking was delayed due to tug unavailability
    tug_caused_delay: bool = False
    # Computed - vessel IDs whose waiting time was caused by this vessel occupying the berth first
    caused_delay_to: list[str] = field(default_factory=list)
    # Computed - duration of a single docking or undocking manoeuvre in hours
    maneuver_h: float = 0.5
    # Computed - ordered list of operational phases (fondeo, atraque, ejecucion, desatraque)
    phases: list[OperationPhase] = field(default_factory=list)
    # Computed - fondeo hours attributable to pilot unavailability
    pilot_wait_h: float = 0.0
    # Computed - fondeo hours attributable to tug unavailability
    tug_wait_h: float = 0.0


class OptimizationResponse(BaseModel):
    """Response payload returned by the /run optimization endpoint."""

    # Computed - list of serialized assignment dicts, one per vessel
    assignments: list[dict]
    # Computed - aggregate KPI metrics for the full schedule
    kpis: dict


class VesselDelay(BaseModel):
    """A single delay directive: add delay_h hours to a vessel's ETA or operation."""

    # User-provided - identifier of the vessel being delayed
    vessel_id: str
    # User-provided - number of hours of delay to apply (must be positive)
    delay_h: float = Field(gt=0)
    # User-provided - type of delay: "arrival", "operation", or "early_arrival"
    delay_type: Literal["arrival", "operation", "early_arrival"] = "arrival"


class ReplanRequest(BaseModel):
    """Input for the re-planning endpoint."""

    # User-provided - current schedule as returned by /run or a previous /replan
    base_assignments: list[dict]
    # User-provided - delays to apply (total accumulated, not incremental)
    delays: list[VesselDelay]
    # User-provided - port configuration, same as the original /run request
    config: OptimizationConfig
    # User-provided - original vessel inputs used when a full re-run is needed
    vessels: list[VesselInput]


class ReplanResponse(BaseModel):
    """Response payload returned by the /replan endpoint."""

    # Computed - updated assignment list after applying delays and re-scheduling if needed
    assignments: list[dict]
    # Computed - aggregate KPI metrics for the updated schedule
    kpis: dict
    # Computed - True when actual conflicts were found and the optimizer re-ran
    replan_triggered: bool
    # Computed - vessel IDs whose schedules were changed by the replan
    vessels_affected: list[str]
    # Computed - number of schedule conflicts detected that triggered re-scheduling
    conflicts_found: int
    # Computed - mapping of vessel_id to total delay applied in hours, for Gantt visualisation
    delay_map: dict[str, float]


class EarlyCompleteRequest(BaseModel):
    """Input for the early-completion endpoint."""

    # User-provided - vessel that finished its cargo operation before schedule
    vessel_id: str
    # User-provided - ISO 8601 timestamp when the cargo operation actually ended
    complete_time: str
    # User-provided - current schedule as returned by /run or /replan
    base_assignments: list[dict]
    # User-provided - port configuration
    config: OptimizationConfig
    # User-provided - original vessel inputs
    vessels: list[VesselInput]


class EarlyCompleteResponse(BaseModel):
    """Response payload returned by the /early_complete endpoint."""

    # Computed - updated assignment list after processing the early completion
    assignments: list[dict]
    # Computed - aggregate KPI metrics for the updated schedule
    kpis: dict
    # Computed - True when waiting vessels for this berth were pulled forward
    replan_triggered: bool
    # Computed - hours the vessel had to wait at berth for undocking resources (0 means immediate)
    waiting_undock_h: float
    # Computed - how many hours earlier the berth is freed compared to the original schedule
    berth_freed_delta_h: float
