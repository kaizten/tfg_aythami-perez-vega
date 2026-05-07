"""Pydantic API models and internal dataclasses for the berth scheduling optimizer."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
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


# ── Output model ──────────────────────────────────────────────────────────────

class OptimizationResponse(BaseModel):
    assignments: list[dict]
    kpis: dict
