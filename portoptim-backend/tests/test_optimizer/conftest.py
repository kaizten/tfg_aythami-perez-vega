"""Shared fixtures for optimizer tests."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from optimizer.models import BerthZone, OptimizationConfig, VesselInput, VesselOperation


def make_vessel(
    id: str,
    eta: str,
    eslora: float,
    gt: float,
    target_berth: str,
    operations: list[dict] | None = None,
    estimated_duration_h: float | None = None,
) -> VesselInput:
    ops = [VesselOperation(**o) for o in (operations or [])]
    return VesselInput(
        id=id,
        eta=datetime.fromisoformat(eta),
        eslora=eslora,
        gt=gt,
        target_berth=target_berth,
        operations=ops,
        estimated_duration_h=estimated_duration_h,
    )


def continuous_berth(berth_id: str, noray_max: int = 200) -> BerthZone:
    return BerthZone(berth_id=berth_id, bap_type="continuous", noray_max=noray_max)


def discrete_berth(berth_id: str, capacity: int = 2) -> BerthZone:
    return BerthZone(berth_id=berth_id, bap_type="discrete", capacity=capacity)


def simple_config(berths: list[BerthZone], **kwargs) -> OptimizationConfig:
    defaults = dict(num_pilots=10, num_tugs=10, default_duration_h=48.0, overlap_factor=0.70)
    defaults.update(kwargs)
    return OptimizationConfig(mooring_zones=berths, **defaults)
