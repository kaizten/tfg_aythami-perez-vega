"""
Duration estimator — three-layer fallback strategy.

Layer 1 (most precise): rate model  →  duration = cantidad / median_rate
Layer 2 (fallback):     statistical  →  median duration by (tipo_op, grupo, eslora_bucket)
Layer 3 (last resort):  default      →  configurable constant (default 48 h)

Multiple operations are summed and then multiplied by overlap_factor (≤1).
"""

from __future__ import annotations

from typing import Optional

import structlog

from .calibration import Calibration
from .models import VesselOperation

logger = structlog.get_logger()

_SOURCE_PRIORITY = {"provided": 0, "rate_model": 1, "statistical_model": 2, "default": 3}


class DurationEstimator:
    def __init__(
        self,
        calibration: Optional[Calibration] = None,
        default_duration_h: float = 48.0,
        overlap_factor: float = 0.70,
    ) -> None:
        self.calibration = calibration
        self.default_duration_h = default_duration_h
        # Prefer the learned overlap factor when calibration is available
        if calibration and calibration.overlap_factor_learned is not None:
            self.overlap_factor = calibration.overlap_factor_learned
        else:
            self.overlap_factor = overlap_factor

    # ── Public API ─────────────────────────────────────────────────────────────

    def estimate(
        self,
        eslora: float,
        operations: list[VesselOperation],
        estimated_duration_h: Optional[float] = None,
    ) -> tuple[float, str]:
        """
        Returns (duration_h, source) where source is one of:
            "provided" | "rate_model" | "statistical_model" | "default"
        """
        if estimated_duration_h is not None:
            logger.info("duration_provided", eslora=eslora, duration_h=estimated_duration_h)
            return estimated_duration_h, "provided"

        if not operations:
            logger.warning(
                "duration_default_no_operations",
                eslora=eslora,
                default_h=self.default_duration_h,
            )
            return self.default_duration_h, "default"

        if len(operations) == 1:
            return self._estimate_single(operations[0], eslora)

        # Multiple operations: sum individual estimates then apply overlap factor
        total = 0.0
        worst_source = "rate_model"  # will be updated to least-precise source seen
        for op in operations:
            d, s = self._estimate_single(op, eslora)
            total += d
            if _SOURCE_PRIORITY.get(s, 3) > _SOURCE_PRIORITY.get(worst_source, 3):
                worst_source = s

        combined = total * self.overlap_factor
        logger.info(
            "duration_multi_op",
            eslora=eslora,
            n_ops=len(operations),
            sum_individual_h=round(total, 2),
            combined_h=round(combined, 2),
            overlap_factor=self.overlap_factor,
            source=worst_source,
        )
        return combined, worst_source

    # ── Internals ──────────────────────────────────────────────────────────────

    def _estimate_single(
        self, op: VesselOperation, eslora: float
    ) -> tuple[float, str]:
        if self.calibration is None:
            logger.warning(
                "duration_default_no_calibration",
                tipo=op.tipo_operacion,
                grupo=op.grupo_mercancia,
                default_h=self.default_duration_h,
            )
            return self.default_duration_h, "default"

        # Layer 1 — rate model
        if op.cantidad is not None and op.cantidad > 0:
            rate = self.calibration.get_rate(op.tipo_operacion, op.grupo_mercancia)
            if rate and rate > 0:
                dur = op.cantidad / rate
                logger.info(
                    "duration_rate_model",
                    tipo=op.tipo_operacion,
                    grupo=op.grupo_mercancia,
                    cantidad=op.cantidad,
                    rate=round(rate, 2),
                    duration_h=round(dur, 2),
                )
                return dur, "rate_model"

        # Layer 2 — statistical model
        dur = self.calibration.get_duration(op.tipo_operacion, op.grupo_mercancia, eslora)
        if dur is not None:
            logger.info(
                "duration_statistical_model",
                tipo=op.tipo_operacion,
                grupo=op.grupo_mercancia,
                eslora=eslora,
                duration_h=round(dur, 2),
            )
            return dur, "statistical_model"

        # Layer 3 — default
        logger.warning(
            "duration_default_fallback",
            tipo=op.tipo_operacion,
            grupo=op.grupo_mercancia,
            eslora=eslora,
            default_h=self.default_duration_h,
        )
        return self.default_duration_h, "default"
