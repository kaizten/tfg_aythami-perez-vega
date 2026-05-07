"""Pydantic API models and internal dataclasses for the berth scheduling optimizer."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

from pydantic import BaseModel, Field

# Physical constant: metres per noray unit (bollard spacing)
NORAY_SPACING_M: float = 12.0
# Hours a pilot / tug is occupied during a single docking or undocking manoeuvre
DOCKING_DURATION_H: float = 1.0

# Cargo groups that require an extra tug for safety reasons
HAZARDOUS_CARGO_GROUPS: frozenset[str] = frozenset({"Energético", "Químicos"})


def norays_needed(eslora: float) -> int:
    """Number of contiguous noray positions required for a vessel of given length."""
    return max(1, math.ceil(eslora / NORAY_SPACING_M))


def required_tugs(gt: float, cargo_group: str, has_bow_thruster: bool = False) -> int:
    """
    Calculate the number of tugs required for a vessel manoeuvre.

    Base tug count by GT:
        GT < 500              → 0
        500  ≤ GT < 3 000     → 1
        3 000 ≤ GT < 10 000   → 2
        10 000 ≤ GT < 40 000  → 3
        GT ≥ 40 000           → 4

    Modifiers applied to the base count:
        - Hazardous cargo (Energético / Químicos): +1
        - Bow thruster fitted: -1 (minimum 0)

    The result is always in [0, 4].
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


# ── Input models ──────────────────────────────────────────────────────────────

class VesselOperation(BaseModel):
    tipo_operacion: str
    grupo_mercancia: str
    cantidad: Optional[float] = None


class VesselInput(BaseModel):
    id: str
    eta: datetime
    eslora: float
    gt: float
    target_berth: str
    operations: list[VesselOperation] = Field(default_factory=list)
    estimated_duration_h: Optional[float] = None
    has_bow_thruster: bool = False


class BerthZone(BaseModel):
    berth_id: str
    bap_type: str  # "continuous" | "discrete"
    noray_max: Optional[int] = None   # total noray positions (continuous berths)
    capacity: Optional[int] = None    # simultaneous vessel slots (discrete berths)


class OptimizationConfig(BaseModel):
    num_pilots: int = 3
    num_tugs: int = 2
    default_duration_h: float = 48.0
    overlap_factor: float = 0.70
    mooring_zones: list[BerthZone]


class OptimizationRequest(BaseModel):
    vessels: list[VesselInput]
    config: OptimizationConfig


# ── Operation phases ──────────────────────────────────────────────────────────

@dataclass
class OperationPhase:
    """Temporal breakdown of one stage in a vessel's port lifecycle."""
    name: str        # "fondeo" | "atraque" | "ejecucion" | "desatraque"
    start: datetime
    end: datetime
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


# ── Internal result dataclass ─────────────────────────────────────────────────

@dataclass
class AssignmentResult:
    vessel_id: str
    berth_id: str
    noray_start: Optional[int]
    noray_end: Optional[int]
    scheduled_start: datetime
    scheduled_end: datetime
    waiting_time_h: float
    duration_estimated_h: float
    duration_source: str          # "provided" | "rate_model" | "statistical_model" | "default"
    pilot_assigned: bool
    tugs_required: int            # tugs needed (GT + cargo + bow-thruster rule)
    tugs_assigned: bool           # True when all required tugs were successfully allocated
    status: str                   # "assigned" | "unassigned" | "invalid_berth"
    pilot_caused_delay: bool = False   # docking was delayed by pilot unavailability
    tug_caused_delay: bool = False     # docking was delayed by tug unavailability
    caused_delay_to: list[str] = field(default_factory=list)
    maneuver_h: float = 0.5           # single-manoeuvre duration used to build phases
    phases: list[OperationPhase] = field(default_factory=list)


# ── Output model ──────────────────────────────────────────────────────────────

class OptimizationResponse(BaseModel):
    assignments: list[dict]
    kpis: dict
