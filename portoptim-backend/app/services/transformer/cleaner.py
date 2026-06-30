"""Data cleaning step: removes empty rows, strips whitespace, deduplicates."""

import logging
from dataclasses import dataclass, field

import pandas as pd

logger = logging.getLogger(__name__)

# Fixed - string columns from which leading/trailing whitespace is stripped
STRING_COLUMNS: list[str] = [
    "call_id",
    "berth_id",
    "operation_type",
    "cargo_group",
    "cargo_nature",
]

# Fixed - column subset used to identify and drop duplicate records
DEDUP_SUBSET: list[str] = ["call_id", "operation_type"]

# Fixed - column subset that identifies concurrent operations of the same vessel at the same berth
CONCURRENT_KEY: list[str] = ["call_id", "berth_id", "arrival_time", "departure_time"]


@dataclass
class CleaningReport:
    """Counts of rows removed at each cleaning stage and any associated warnings."""

    # Computed - total number of rows before any cleaning is applied
    rows_before: int = 0

    # Computed - number of rows dropped because every column was null
    fully_empty_dropped: int = 0

    # Computed - number of rows dropped as exact duplicates on the deduplication key
    duplicates_dropped: int = 0

    # Computed - total number of rows remaining after all cleaning steps
    rows_after: int = 0

    # Computed - human-readable messages for each deduplication event
    warnings: list[str] = field(default_factory=list)


def clean(df: pd.DataFrame) -> tuple[pd.DataFrame, CleaningReport]:
    """
    Apply all cleaning steps to df in order.

    Steps:
        1. Drop rows where every selected column is null.
        2. Strip whitespace from string-type columns.
        3. Drop exact duplicate rows keyed on call_id and operation_type.

    Args:
        df (pd.DataFrame): Renamed DataFrame from the validation step. Required.

    Returns:
        tuple[pd.DataFrame, CleaningReport]: Cleaned DataFrame and a report with row counts.
    """
    report = CleaningReport(rows_before=len(df))

    before = len(df)
    df = df.dropna(how="all").copy()
    report.fully_empty_dropped = before - len(df)
    if report.fully_empty_dropped:
        logger.info("Dropped %d fully-empty rows.", report.fully_empty_dropped)

    for col in STRING_COLUMNS:
        if col in df.columns and df[col].dtype == object:
            df.loc[:, col] = df[col].str.strip()

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
    Collapse rows where the same vessel performs multiple operations at the same berth
    during the exact same time window into a single combined row.

    Rows are grouped by CONCURRENT_KEY (call_id, berth_id, arrival_time, departure_time).
    The merged row keeps first-row values for all vessel and berth fields, then:
        - operation_type: distinct values joined with ' y ' in occurrence order.
        - cargo_group and cargo_nature: distinct non-empty values joined with ' / '.
        - quantity: sum across the concurrent rows (NaN when all values are NaN).

    This step must run after normalization so that operation_type values are already
    in their canonical form (Embarque, Desembarque, Trasbordo).

    Args:
        df (pd.DataFrame): Normalised DataFrame from the normalization step. Required.

    Returns:
        tuple[pd.DataFrame, int]: Merged DataFrame and the number of rows removed by merging.
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

        seen: set[str] = set()
        op_parts: list[str] = []
        for op in group["operation_type"]:
            if op not in seen:
                seen.add(op)
                op_parts.append(op)
        base["operation_type"] = " y ".join(op_parts)

        for col in ("cargo_group", "cargo_nature"):
            if col in group.columns:
                distinct = [
                    v for v in dict.fromkeys(group[col].tolist()) if v
                ]
                base[col] = " / ".join(distinct) if distinct else ""

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
