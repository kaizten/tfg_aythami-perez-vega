"""Normalization step: parses dates, converts numeric types, standardizes enumerations."""

import logging
from datetime import datetime
from typing import Optional

import pandas as pd

logger = logging.getLogger(__name__)

# Fixed - ordered list of date format strings tried when parsing date cell values
DATE_FORMATS: list[str] = [
    "%Y-%m-%d %H:%M:%S",
    "%d/%m/%Y %H:%M",
    "%d/%m/%Y",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d",
]

# Fixed - set of canonical operation type values accepted by the system
VALID_OPERATION_TYPES: frozenset[str] = frozenset({"Embarque", "Desembarque", "Trasbordo"})

# Fixed - mapping of raw Spanish port data variants to their canonical operation type
OPERATION_TYPE_MAP: dict[str, str] = {
    "embarque": "Embarque",
    "carga": "Embarque",
    "loading": "Embarque",
    "desembarque": "Desembarque",
    "descarga": "Desembarque",
    "unloading": "Desembarque",
    "discharge": "Desembarque",
    "trasbordo": "Trasbordo",
    "transshipment": "Trasbordo",
    "transhipment": "Trasbordo",
}


def _parse_date(raw: object) -> Optional[datetime]:
    """
    Attempt to parse a raw cell value as a datetime using the ordered DATE_FORMATS list.

    Args:
        raw (object): The raw cell value from the DataFrame. Required.

    Returns:
        datetime | None: A datetime object on success, or None if every format fails
        or the value is null/empty.
    """
    if pd.isna(raw) or raw == "":
        return None

    text = str(raw).strip()

    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue

    logger.debug("Could not parse date value: %r", text)
    return None


def _normalize_operation_type(raw: object) -> str:
    """
    Map a raw operation type string to its canonical value using OPERATION_TYPE_MAP.

    Unrecognised values are kept as-is (stripped) so they surface during validation.

    Args:
        raw (object): The raw cell value from the operation_type column. Required.

    Returns:
        str: Canonical operation type string, or an empty string if the value is null.
    """
    if pd.isna(raw):
        return ""
    normalized = str(raw).strip().lower()
    return OPERATION_TYPE_MAP.get(normalized, str(raw).strip())


def normalize(df: pd.DataFrame) -> pd.DataFrame:
    """
    Apply all normalization transformations to df and return a new copy.

    Transformations applied:
        - Parse arrival_time and departure_time with multi-format fallback.
        - Convert vessel_length and quantity to float.
        - Convert vessel_gt to nullable Int64.
        - Convert noray_start and noray_end to float.
        - Normalize operation_type to canonical values via OPERATION_TYPE_MAP.
        - Fill missing cargo_group and cargo_nature with empty string.

    Args:
        df (pd.DataFrame): Cleaned DataFrame from the cleaning step. Required.

    Returns:
        pd.DataFrame: New DataFrame with normalised column types and values.
    """
    df = df.copy()

    df["arrival_time"] = df["arrival_time"].apply(_parse_date)
    df["departure_time"] = df["departure_time"].apply(_parse_date)

    df["vessel_length"] = pd.to_numeric(df["vessel_length"], errors="coerce").astype(float)
    df["vessel_gt"] = pd.to_numeric(df["vessel_gt"], errors="coerce").astype("Int64")
    df["noray_start"] = pd.to_numeric(df["noray_start"], errors="coerce")
    df["noray_end"] = pd.to_numeric(df["noray_end"], errors="coerce")
    df["quantity"] = pd.to_numeric(df["quantity"], errors="coerce")

    df["operation_type"] = df["operation_type"].apply(_normalize_operation_type)

    df["cargo_group"] = df["cargo_group"].fillna("").astype(str).str.strip()
    df["cargo_nature"] = df["cargo_nature"].fillna("").astype(str).str.strip()

    return df
