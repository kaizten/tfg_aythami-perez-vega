"""Data cleaning step: removes empty rows, strips whitespace, deduplicates."""

import logging
from dataclasses import dataclass, field

import pandas as pd

logger = logging.getLogger(__name__)

# String columns that should have leading/trailing whitespace removed.
STRING_COLUMNS: list[str] = [
    "call_id",
    "berth_id",
    "operation_type",
    "cargo_group",
    "cargo_nature",
]

# Subset of columns used to detect duplicate records.
DEDUP_SUBSET: list[str] = ["call_id", "operation_type"]


@dataclass
class CleaningReport:
    """Counts of rows removed at each cleaning stage."""

    rows_before: int = 0
    fully_empty_dropped: int = 0
    duplicates_dropped: int = 0
    rows_after: int = 0
    warnings: list[str] = field(default_factory=list)


def clean(df: pd.DataFrame) -> tuple[pd.DataFrame, CleaningReport]:
    """
    Apply all cleaning steps to *df* in order.

    Steps:
        1. Drop rows where every selected column is null.
        2. Strip whitespace from string-type columns.
        3. Drop exact duplicate rows (same call_id + operation_type, keep first).

    Args:
        df: Renamed DataFrame from the validation step.

    Returns:
        Tuple of (cleaned DataFrame, CleaningReport with row counts).
    """
    report = CleaningReport(rows_before=len(df))

    # Step 1 — drop fully empty rows (all values NaN); copy to avoid chained-assignment warnings
    before = len(df)
    df = df.dropna(how="all").copy()
    report.fully_empty_dropped = before - len(df)
    if report.fully_empty_dropped:
        logger.info("Dropped %d fully-empty rows.", report.fully_empty_dropped)

    # Step 2 — strip whitespace from string columns
    for col in STRING_COLUMNS:
        if col in df.columns and df[col].dtype == object:
            df.loc[:, col] = df[col].str.strip()

    # Step 3 — deduplicate on (call_id, operation_type)
    before = len(df)
    duplicate_mask = df.duplicated(subset=DEDUP_SUBSET, keep="first")
    if duplicate_mask.any():
        duplicate_ids = df.loc[duplicate_mask, "call_id"].tolist()
        warning_msg = (
            f"Dropped {duplicate_mask.sum()} duplicate rows "
            f"(same call_id + operation_type): {duplicate_ids[:5]}"
            + ("…" if len(duplicate_ids) > 5 else "")
        )
        logger.warning(warning_msg)
        report.warnings.append(warning_msg)

    df = df.drop_duplicates(subset=DEDUP_SUBSET, keep="first")
    report.duplicates_dropped = before - len(df)
    report.rows_after = len(df)

    return df, report
