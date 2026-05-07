"""Orchestrates the full data transformation pipeline."""

import logging
import re
from dataclasses import dataclass, field

import pandas as pd
from pydantic import ValidationError

from app.models.berth_call import BerthCall
from app.services.transformer.cleaner import clean, merge_concurrent_operations
from app.services.transformer.normalizer import normalize
from app.services.transformer.validator import (
    CRITICAL_FIELDS,
    ValidationResult,
    rename_columns,
    validate_schema,
)

logger = logging.getLogger(__name__)

_PORT_PREFIX_RE = re.compile(r"^([A-Za-z]+)")


def _port_code(call_id: str) -> str:
    """Extract the alphabetic port prefix from a call_id (e.g. 'T202200020' → 'T')."""
    m = _PORT_PREFIX_RE.match(call_id)
    return m.group(1).upper() if m else "UNKNOWN"


@dataclass
class TransformationSummary:
    """High-level statistics returned alongside the transformed data."""

    total_input_rows: int = 0
    valid_rows: int = 0
    skipped_rows: int = 0
    skipped_reasons: list[str] = field(default_factory=list)


@dataclass
class TransformationResult:
    """Full output of the transformation pipeline."""

    records: list[BerthCall]
    summary: TransformationSummary
    available_ports: list[str] = field(default_factory=list)


def _row_to_berth_call(
    row: pd.Series,
    summary: TransformationSummary,
) -> BerthCall | None:
    """
    Attempt to build a BerthCall from a single normalised DataFrame row.

    Rows with missing critical fields or invalid Pydantic data are skipped
    and counted in *summary* rather than raising an exception.

    Args:
        row: A single row from the normalised DataFrame.
        summary: Mutable summary object updated on skip.

    Returns:
        A BerthCall instance, or None if the row is invalid.
    """
    call_id = str(row.get("call_id", "")).strip()
    berth_id = str(row.get("berth_id", "")).strip()

    # Guard: critical string fields
    if not call_id or not berth_id:
        reason = f"Row skipped — missing call_id or berth_id (call_id={call_id!r})"
        logger.warning(reason)
        summary.skipped_rows += 1
        summary.skipped_reasons.append(reason)
        return None

    # Guard: critical date fields
    if pd.isna(row.get("arrival_time")) or pd.isna(row.get("departure_time")):
        reason = (
            f"Row skipped — unparseable or missing date for call_id={call_id!r}"
        )
        logger.warning(reason)
        summary.skipped_rows += 1
        summary.skipped_reasons.append(reason)
        return None

    # Guard: critical numeric fields
    if pd.isna(row.get("vessel_length")) or pd.isna(row.get("vessel_gt")):
        reason = (
            f"Row skipped — missing vessel_length or vessel_gt for call_id={call_id!r}"
        )
        logger.warning(reason)
        summary.skipped_rows += 1
        summary.skipped_reasons.append(reason)
        return None

    try:
        return BerthCall(
            call_id=call_id,
            berth_id=berth_id,
            noray_start=None if pd.isna(row.get("noray_start")) else float(row["noray_start"]),
            noray_end=None if pd.isna(row.get("noray_end")) else float(row["noray_end"]),
            arrival_time=row["arrival_time"],
            departure_time=row["departure_time"],
            vessel_length=float(row["vessel_length"]),
            vessel_gt=int(row["vessel_gt"]),
            operation_type=str(row.get("operation_type", "")),
            cargo_group=str(row.get("cargo_group", "")),
            cargo_nature=str(row.get("cargo_nature", "")),
            quantity=None if pd.isna(row.get("quantity")) else float(row["quantity"]),
        )
    except (ValidationError, ValueError, TypeError) as exc:
        reason = f"Row skipped — Pydantic validation error for call_id={call_id!r}: {exc}"
        logger.warning(reason)
        summary.skipped_rows += 1
        summary.skipped_reasons.append(reason)
        return None


def run_pipeline(df: pd.DataFrame) -> TransformationResult:
    """
    Execute the full transformation pipeline on a raw DataFrame.

    Pipeline stages:
        1. Schema validation (raises ValueError on missing columns).
        2. Column renaming.
        3. Cleaning (drop empty rows, deduplicate, strip whitespace).
        4. Normalization (parse dates, convert types, standardize enums).
        5. Row-level Pydantic model construction with per-row error recovery.

    Args:
        df: Raw DataFrame loaded from the uploaded CSV/Excel file.

    Returns:
        TransformationResult with a list of valid BerthCall records
        and a TransformationSummary.

    Raises:
        ValueError: If required columns are missing from the input schema.
    """
    summary = TransformationSummary(total_input_rows=len(df))

    # Stage 1 — schema validation
    validation: ValidationResult = validate_schema(df)
    if not validation.is_valid:
        raise ValueError(
            f"Input file is missing required columns: {validation.missing_columns}"
        )

    # Stage 2 — rename to internal aliases
    df = rename_columns(df)

    # Stage 3 — cleaning
    df, cleaning_report = clean(df)
    if cleaning_report.warnings:
        summary.skipped_reasons.extend(cleaning_report.warnings)

    # Stage 4 — normalization
    df = normalize(df)

    # Stage 4.5 — merge concurrent operations (same vessel, berth, and time window)
    df, merged_away = merge_concurrent_operations(df)
    if merged_away:
        msg = f"Merged {merged_away} rows with concurrent operations into combined operation types."
        logger.info(msg)
        summary.skipped_reasons.append(msg)

    # Stage 5 — row-level model construction
    records: list[BerthCall] = []
    for _, row in df.iterrows():
        berth_call = _row_to_berth_call(row, summary)
        if berth_call is not None:
            records.append(berth_call)

    summary.valid_rows = len(records)
    summary.skipped_rows = summary.total_input_rows - summary.valid_rows

    available_ports = sorted({_port_code(r.call_id) for r in records})

    logger.info(
        "Pipeline complete — input=%d, valid=%d, skipped=%d, ports=%s",
        summary.total_input_rows,
        summary.valid_rows,
        summary.skipped_rows,
        available_ports,
    )

    return TransformationResult(records=records, summary=summary, available_ports=available_ports)
