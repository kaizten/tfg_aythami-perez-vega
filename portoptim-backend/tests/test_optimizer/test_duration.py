"""
Duration estimator tests.

Tests 1-3 of the spec:
  1. Rate model: Desembarque + Energético + 25000 t → ~45.8 h
  2. Fallback: no cantidad → duration_model; no model → default
  3. Multiple operations: sum × overlap_factor
  8. Works without CSV (Calibration=None)
"""

import pytest
from optimizer.calibration import Calibration
from optimizer.duration import DurationEstimator
from optimizer.models import VesselOperation


# ── Fixtures ──────────────────────────────────────────────────────────────────

RATE_ENERGETICO = 546.0   # t/h  (spec reference value)
RATE_AGRO = 155.0         # t/h

DURATION_AGRO_150_220 = 161.0  # hours (spec reference value, layer 2)


def calibration_with_rates() -> Calibration:
    """Calibration manually seeded — no real CSV needed."""
    cal = Calibration()
    cal.rate_model[("Desembarque", "Energético")] = RATE_ENERGETICO
    cal.rate_model[("Desembarque", "Agro-Ganadero")] = RATE_AGRO
    cal.duration_model[("Desembarque", "Agro-Ganadero", "150-220m")] = DURATION_AGRO_150_220
    return cal


# ── Test 1: rate model ────────────────────────────────────────────────────────

def test_rate_model_desembarque_energetico():
    """25 000 t at 546 t/h → ~45.8 h, source = rate_model."""
    cal = calibration_with_rates()
    est = DurationEstimator(calibration=cal)

    op = VesselOperation(tipo_operacion="Desembarque", grupo_mercancia="Energético", cantidad=25_000)
    dur, src = est.estimate(eslora=144.56, operations=[op])

    assert src == "rate_model"
    assert abs(dur - 25_000 / RATE_ENERGETICO) < 0.5  # within half an hour


# ── Test 2a: fallback to statistical model when no cantidad ───────────────────

def test_fallback_to_statistical_model_no_cantidad():
    """No cantidad → skip rate model, use duration_model."""
    cal = calibration_with_rates()
    est = DurationEstimator(calibration=cal)

    op = VesselOperation(tipo_operacion="Desembarque", grupo_mercancia="Agro-Ganadero", cantidad=None)
    dur, src = est.estimate(eslora=180.0, operations=[op])  # 180 m → bucket 150-220m

    assert src == "statistical_model"
    assert dur == DURATION_AGRO_150_220


# ── Test 2b: fallback to default when no model entry ─────────────────────────

def test_fallback_to_default_no_model():
    """No calibration entry for this combination → default."""
    cal = Calibration()  # empty, no CSV
    est = DurationEstimator(calibration=cal, default_duration_h=48.0)

    op = VesselOperation(tipo_operacion="Embarque", grupo_mercancia="Unknown", cantidad=None)
    dur, src = est.estimate(eslora=100.0, operations=[op])

    assert src == "default"
    assert dur == 48.0


# ── Test 3: multiple operations with overlap_factor ──────────────────────────

def test_multiple_operations_overlap():
    """Two ops: sum × overlap_factor should equal combined duration."""
    cal = calibration_with_rates()
    overlap = 0.70
    est = DurationEstimator(calibration=cal, overlap_factor=overlap)

    ops = [
        VesselOperation(tipo_operacion="Desembarque", grupo_mercancia="Energético", cantidad=25_000),
        VesselOperation(tipo_operacion="Desembarque", grupo_mercancia="Agro-Ganadero", cantidad=None),
    ]
    dur, src = est.estimate(eslora=180.0, operations=ops)

    d1 = 25_000 / RATE_ENERGETICO   # rate model
    d2 = DURATION_AGRO_150_220       # statistical model (eslora 180 m → 150-220m)
    expected = (d1 + d2) * overlap

    assert src == "statistical_model"  # worst (least precise) source wins
    assert abs(dur - expected) < 0.5


# ── Test 8: works without CSV (no calibration) ───────────────────────────────

def test_no_calibration_returns_default():
    """Optimizer must work with Calibration=None — uses default for all vessels."""
    est = DurationEstimator(calibration=None, default_duration_h=72.0)
    op = VesselOperation(tipo_operacion="Embarque", grupo_mercancia="Granel", cantidad=1000)
    dur, src = est.estimate(eslora=100.0, operations=[op])

    assert src == "default"
    assert dur == 72.0


def test_provided_duration_takes_priority():
    """estimated_duration_h in vessel overrides everything, including rate model."""
    cal = calibration_with_rates()
    est = DurationEstimator(calibration=cal)

    op = VesselOperation(tipo_operacion="Desembarque", grupo_mercancia="Energético", cantidad=25_000)
    dur, src = est.estimate(eslora=144.56, operations=[op], estimated_duration_h=99.9)

    assert src == "provided"
    assert dur == 99.9
