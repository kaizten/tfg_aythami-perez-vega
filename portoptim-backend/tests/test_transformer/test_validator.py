"""Tests for app.services.transformer.validator."""

import pandas as pd
import pytest

from app.services.transformer.validator import (
    REQUIRED_COLUMN_MAP,
    ValidationResult,
    rename_columns,
    validate_schema,
)


def _make_df(columns: list[str]) -> pd.DataFrame:
    """Return an empty DataFrame with the given column names."""
    return pd.DataFrame(columns=columns)


class TestValidateSchema:
    def test_passes_when_all_required_columns_present(self) -> None:
        df = _make_df(list(REQUIRED_COLUMN_MAP.keys()))
        result = validate_schema(df)
        assert result.is_valid is True
        assert result.missing_columns == []

    def test_fails_when_one_column_missing(self) -> None:
        cols = list(REQUIRED_COLUMN_MAP.keys())
        df = _make_df(cols[1:])  # drop "Escala"
        result = validate_schema(df)
        assert result.is_valid is False
        assert "Escala" in result.missing_columns

    def test_fails_with_all_missing_columns(self) -> None:
        df = _make_df(["Columna Inventada", "Otra Columna"])
        result = validate_schema(df)
        assert result.is_valid is False
        assert len(result.missing_columns) == len(REQUIRED_COLUMN_MAP)

    def test_extra_columns_do_not_cause_failure(self) -> None:
        cols = list(REQUIRED_COLUMN_MAP.keys()) + ["Extra Column", "Another Extra"]
        df = _make_df(cols)
        result = validate_schema(df)
        assert result.is_valid is True

    def test_returns_named_tuple_with_correct_fields(self) -> None:
        df = _make_df(list(REQUIRED_COLUMN_MAP.keys()))
        result = validate_schema(df)
        assert isinstance(result, ValidationResult)
        assert hasattr(result, "is_valid")
        assert hasattr(result, "missing_columns")


class TestRenameColumns:
    def test_renames_all_required_columns(self) -> None:
        df = pd.DataFrame({col: ["x"] for col in REQUIRED_COLUMN_MAP})
        renamed = rename_columns(df)
        assert set(renamed.columns) == set(REQUIRED_COLUMN_MAP.values())

    def test_drops_extra_columns(self) -> None:
        cols = {col: ["x"] for col in REQUIRED_COLUMN_MAP}
        cols["Extra Column"] = ["y"]
        df = pd.DataFrame(cols)
        renamed = rename_columns(df)
        assert "Extra Column" not in renamed.columns
        assert len(renamed.columns) == len(REQUIRED_COLUMN_MAP)

    def test_preserves_row_count(self) -> None:
        df = pd.DataFrame({col: ["a", "b", "c"] for col in REQUIRED_COLUMN_MAP})
        renamed = rename_columns(df)
        assert len(renamed) == 3
