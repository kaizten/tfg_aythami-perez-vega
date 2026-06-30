"""Duration estimator using a three-layer fallback strategy: rate model, statistical model, then default."""

from __future__ import annotations

from typing import Optional

import structlog

from .calibration import Calibration
from .models import VesselOperation

logger = structlog.get_logger()

# Fixed - priority ordering for duration source labels (lower value = more precise)
_SOURCE_PRIORITY = {"provided": 0, "rate_model": 1, "statistical_model": 2, "default": 3}


class DurationEstimator:
    """
    Estimates vessel service duration using a three-layer fallback strategy.

    Layer 1 (most precise): rate model — duration = cantidad / median_rate.
    Layer 2 (fallback): statistical model — median duration by (tipo_op, grupo, eslora_bucket).
    Layer 3 (last resort): configurable default constant.
    Multiple operations are summed and multiplied by overlap_factor.
    """

    def __init__(
        self,
        calibration: Optional[Calibration] = None,
        default_duration_h: float = 48.0,
        overlap_factor: float = 0.70,
    ) -> None:
        """
        Initialize the estimator with optional calibration and fallback parameters.

        Args:
            calibration (Calibration): Fitted calibration object providing rate and duration models. Optional, defaults to None.
            default_duration_h (float): Duration in hours used as last-resort fallback. Optional, defaults to 48.0.
            overlap_factor (float): Fraction applied to summed multi-operation durations. Optional, defaults to 0.70.
        """
        # User-provided - fitted calibration object, or None to use default fallback only
        self.calibration = calibration
        # User-provided - last-resort duration in hours when no model is available
        self.default_duration_h = default_duration_h
        # Computed - overlap factor, preferring the learned value from calibration when available
        if calibration and calibration.overlap_factor_learned is not None:
            self.overlap_factor = calibration.overlap_factor_learned
        else:
            self.overlap_factor = overlap_factor

    def estimate(
        self,
        eslora: float,
        operations: list[VesselOperation],
        estimated_duration_h: Optional[float] = None,
    ) -> tuple[float, str]:
        """
        Estimate the service duration for a vessel given its operations.

        Args:
            eslora (float): Vessel length in metres, used for statistical model lookup. Required.
            operations (list[VesselOperation]): List of cargo operations the vessel will perform. Required.
            estimated_duration_h (float): Pre-calculated duration provided by the caller; bypasses all model layers when set. Optional, defaults to None.

        Returns:
            tuple[float, str]: Pair of (duration_h, source) where source is one of
                "provided", "rate_model", "statistical_model", or "default".
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

        total = 0.0
        worst_source = "rate_model"
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

    def _estimate_single(
        self, op: VesselOperation, eslora: float
    ) -> tuple[float, str]:
        """
        Estimate duration for a single cargo operation using the three-layer fallback.

        Args:
            op (VesselOperation): The cargo operation to estimate. Required.
            eslora (float): Vessel length in metres for statistical model lookup. Required.

        Returns:
            tuple[float, str]: Pair of (duration_h, source).
        """
        if self.calibration is None:
            logger.warning(
                "duration_default_no_calibration",
                tipo=op.tipo_operacion,
                grupo=op.grupo_mercancia,
                default_h=self.default_duration_h,
            )
            return self.default_duration_h, "default"

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

        logger.warning(
            "duration_default_fallback",
            tipo=op.tipo_operacion,
            grupo=op.grupo_mercancia,
            eslora=eslora,
            default_h=self.default_duration_h,
        )
        return self.default_duration_h, "default"
