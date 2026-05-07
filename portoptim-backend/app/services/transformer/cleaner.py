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

# Key used to identify concurrent operations of the same vessel at the same berth.
CONCURRENT_KEY: list[str] = ["call_id", "berth_id", "arrival_time", "departure_time"]


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


def merge_concurrent_operations(df: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    """
    Collapse rows where the same vessel performs multiple operations at the same
    berth during the exact same time window (identical call_id, berth_id,
    arrival_time and departure_time) into a single row.

    The merged row keeps first-row values for all vessel/berth fields and:
      - operation_type: joined with " y " in occurrence order (e.g. "Embarque y Trasbordo").
      - cargo_group / cargo_nature: distinct values joined with " / ".
      - quantity: sum of all rows (NaN when all are NaN).

    This step must run **after** normalization so that operation_type values
    are already in their canonical form (Embarque, Desembarque, Trasbordo).

    Args:
        df: Normalised DataFrame from the normalization step.

    Returns:
        Tuple of (merged DataFrame, number of rows removed by merging).
    """
    group_sizes = df.groupby(CONCURRENT_KEY, sort=False).size()
    if (group_sizes > 1).sum() == 0:
        return df, 0

    merged_rows: list[pd.Series] = []
    rows_removed = 0

    for _, group in df.groupby(CONCURRENT_KEY, sort=False):
        if len(group) == 1:
            merged_rows.append(group.iloc[0])
            continue

        base = group.iloc[0].copy()

        # Combine operation types in occurrence order, no duplicates.
        seen: set[str] = set()
        op_parts: list[str] = []
        for op in group["operation_type"]:
            if op not in seen:
                seen.add(op)
                op_parts.append(op)
        base["operation_type"] = " y ".join(op_parts)

        # Combine cargo fields — join distinct non-empty values.
        for col in ("cargo_group", "cargo_nature"):
            if col in group.columns:
                distinct = [
                    v for v in dict.fromkeys(group[col].tolist()) if v  # preserve order, skip ""
                ]
                base[col] = " / ".join(distinct) if distinct else ""

        # Sum quantity across the concurrent rows.
        if "quantity" in group.columns:
            base["quantity"] = group["quantity"].sum(min_count=1)

        merged_rows.append(base)
        rows_removed += len(group) - 1
        logger.info(
            "Merged %d concurrent operations for call_id=%r into '%s'.",
            len(group),
            base["call_id"],
            base["operation_type"],
        )

    result = pd.DataFrame(merged_rows).reset_index(drop=True)
    return result, rows_removed
