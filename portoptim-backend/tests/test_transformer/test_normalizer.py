"""Tests for app.services.transformer.normalizer."""

from datetime import datetime

import pandas as pd
import pytest

from app.services.transformer.normalizer import (
    DATE_FORMATS,
    OPERATION_TYPE_MAP,
    _normalize_operation_type,
    _parse_date,
    normalize,
)


def _make_df(overrides: dict | None = None) -> pd.DataFrame:
    """Return a single-row DataFrame with valid default values."""
    row = {
        "call_id": "ESC-001",
        "berth_id": "M-04",
        "noray_start": "12",
        "noray_end": "18",
        "arrival_time": "2024-06-01 08:00:00",
        "departure_time": "2024-06-02 14:00:00",
        "vessel_length": "294",
        "vessel_gt": "85000",
        "operation_type": "Embarque",
        "cargo_group": "CONTENEDORES",
        "cargo_nature": "MERCANCIA GENERAL",
        "quantity": "2400",
    }
    if overrides:
        row.update(overrides)
    return pd.DataFrame([row])


class TestParseDateFunction:
    def test_parses_iso_format(self) -> None:
        result = _parse_date("2024-06-01 08:00:00")
        assert result == datetime(2024, 6, 1, 8, 0, 0)

    def test_parses_spanish_slash_format_with_time(self) -> None:
        result = _parse_date("01/06/2024 08:00")
        assert result == datetime(2024, 6, 1, 8, 0)

    def test_parses_spanish_slash_format_date_only(self) -> None:
        result = _parse_date("01/06/2024")
        assert result == datetime(2024, 6, 1, 0, 0)

    def test_returns_none_for_empty_string(self) -> None:
        assert _parse_date("") is None

    def test_returns_none_for_nan(self) -> None:
        assert _parse_date(float("nan")) is None

    def test_returns_none_for_unparseable_string(self) -> None:
        assert _parse_date("not-a-date") is None


class TestNormalizeOperationType:
    def test_maps_carga_to_embarque(self) -> None:
        assert _normalize_operation_type("carga") == "Embarque"

    def test_maps_descarga_to_desembarque(self) -> None:
        assert _normalize_operation_type("Descarga") == "Desembarque"

    def test_maps_trasbordo_case_insensitive(self) -> None:
        assert _normalize_operation_type("TRASBORDO") == "Trasbordo"

    def test_already_canonical_value_unchanged(self) -> None:
        assert _normalize_operation_type("Embarque") == "Embarque"

    def test_unknown_value_returned_as_is(self) -> None:
        assert _normalize_operation_type("Reparacion") == "Reparacion"

    def test_nan_returns_empty_string(self) -> None:
        assert _normalize_operation_type(float("nan")) == ""


class TestNormalize:
    def test_converts_vessel_length_to_float(self) -> None:
        df_out = normalize(_make_df())
        assert df_out["vessel_length"].dtype == float

    def test_converts_vessel_gt_to_nullable_int(self) -> None:
        df_out = normalize(_make_df())
        assert str(df_out["vessel_gt"].dtype) == "Int64"

    def test_converts_arrival_time_to_datetime(self) -> None:
        df_out = normalize(_make_df())
        assert isinstance(df_out["arrival_time"].iloc[0], datetime)

    def test_handles_alternate_date_format(self) -> None:
        df_out = normalize(_make_df({"arrival_time": "01/06/2024 08:00"}))
        assert df_out["arrival_time"].iloc[0] == datetime(2024, 6, 1, 8, 0)

    def test_bad_date_becomes_none(self) -> None:
        df_out = normalize(_make_df({"arrival_time": "not-a-date"}))
        assert df_out["arrival_time"].iloc[0] is None

    def test_normalizes_operation_type_carga(self) -> None:
        df_out = normalize(_make_df({"operation_type": "Carga"}))
        assert df_out["operation_type"].iloc[0] == "Embarque"

    def test_missing_quantity_stays_nan(self) -> None:
        df_out = normalize(_make_df({"quantity": ""}))
        assert pd.isna(df_out["quantity"].iloc[0])

    def test_missing_cargo_group_becomes_empty_string(self) -> None:
        df_out = normalize(_make_df({"cargo_group": ""}))
        assert df_out["cargo_group"].iloc[0] == ""
