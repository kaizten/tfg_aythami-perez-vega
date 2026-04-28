"""Tests for app.services.transformer.cleaner."""

import pandas as pd
import pytest

from app.services.transformer.cleaner import (
    DEDUP_SUBSET,
    STRING_COLUMNS,
    CleaningReport,
    clean,
)


def _make_row(**kwargs: object) -> dict[str, object]:
    """Return a dict with default valid values that can be overridden via kwargs."""
    base = {
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
    base.update(kwargs)
    return base


class TestClean:
    def test_returns_tuple_of_dataframe_and_report(self) -> None:
        df = pd.DataFrame([_make_row()])
        result = clean(df)
        assert isinstance(result, tuple)
        assert len(result) == 2
        df_out, report = result
        assert isinstance(df_out, pd.DataFrame)
        assert isinstance(report, CleaningReport)

    def test_drops_fully_empty_rows(self) -> None:
        rows = [_make_row(), {col: None for col in _make_row()}]
        df = pd.DataFrame(rows)
        df_out, report = clean(df)
        assert len(df_out) == 1
        assert report.fully_empty_dropped == 1

    def test_strips_whitespace_from_string_columns(self) -> None:
        row = _make_row(call_id="  ESC-001  ", berth_id=" M-04 ", operation_type=" Embarque ")
        df = pd.DataFrame([row])
        df_out, _ = clean(df)
        assert df_out.iloc[0]["call_id"] == "ESC-001"
        assert df_out.iloc[0]["berth_id"] == "M-04"
        assert df_out.iloc[0]["operation_type"] == "Embarque"

    def test_drops_duplicates_on_call_id_and_operation_type(self) -> None:
        rows = [
            _make_row(call_id="ESC-001", operation_type="Embarque"),
            _make_row(call_id="ESC-001", operation_type="Embarque"),  # exact duplicate
            _make_row(call_id="ESC-001", operation_type="Desembarque"),  # different op — kept
        ]
        df = pd.DataFrame(rows)
        df_out, report = clean(df)
        assert len(df_out) == 2
        assert report.duplicates_dropped == 1

    def test_report_rows_after_matches_output_length(self) -> None:
        rows = [_make_row(call_id=f"ESC-{i:03d}") for i in range(5)]
        df = pd.DataFrame(rows)
        df_out, report = clean(df)
        assert report.rows_after == len(df_out)

    def test_no_rows_dropped_from_clean_data(self) -> None:
        rows = [_make_row(call_id=f"ESC-{i:03d}") for i in range(3)]
        df = pd.DataFrame(rows)
        df_out, report = clean(df)
        assert len(df_out) == 3
        assert report.fully_empty_dropped == 0
        assert report.duplicates_dropped == 0

    def test_duplicate_warning_appended_to_report(self) -> None:
        rows = [_make_row(), _make_row()]  # same call_id + operation_type
        df = pd.DataFrame(rows)
        _, report = clean(df)
        assert len(report.warnings) >= 1
        assert any("duplicate" in w.lower() for w in report.warnings)
