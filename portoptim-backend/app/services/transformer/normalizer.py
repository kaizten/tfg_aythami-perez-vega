"""Normalization step: parses dates, converts numeric types, standardizes enumerations."""

import logging
from datetime import datetime
from typing import Optional

import pandas as pd

logger = logging.getLogger(__name__)

# Date formats tried in order for every date field.
DATE_FORMATS: list[str] = [
    "%Y-%m-%d %H:%M:%S",
    "%d/%m/%Y %H:%M",
    "%d/%m/%Y",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d",
]

# Canonical operation type values accepted by the system.
VALID_OPERATION_TYPES: frozenset[str] = frozenset({"Embarque", "Desembarque", "Trasbordo"})

# Mapping of raw variants found in Spanish port data to their canonical form.
OPERATION_TYPE_MAP: dict[str, str] = {
    # Embarque variants
    "embarque": "Embarque",
    "carga": "Embarque",
    "loading": "Embarque",
    # Desembarque variants
    "desembarque": "Desembarque",
    "descarga": "Desembarque",
    "unloading": "Desembarque",
    "discharge": "Desembarque",
    # Trasbordo variants
    "trasbordo": "Trasbordo",
    "transshipment": "Trasbordo",
    "transhipment": "Trasbordo",
}


def _parse_date(raw: object) -> Optional[datetime]:
    """
    Attempt to parse *raw* as a datetime using the ordered list of DATE_FORMATS.

    Args:
        raw: The raw cell value from the DataFrame.

    Returns:
        A datetime object on success, or None if every format fails.
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
    Map a raw operation type string to its canonical value.

    Unrecognised values are kept as-is (uppercased) so they surface in validation.

    Args:
        raw: The raw cell value.

    Returns:
        Canonical operation type string.
    """
    if pd.isna(raw):
        return ""
    normalized = str(raw).strip().lower()
    return OPERATION_TYPE_MAP.get(normalized, str(raw).strip())


def normalize(df: pd.DataFrame) -> pd.DataFrame:
    """
    Apply all normalization transformations to *df* in-place (returns a copy).

    Transformations applied:
        - Parse arrival_time and departure_time with multi-format fallback.
        - Convert vessel_length and quantity to float.
        - Convert vessel_gt to Int64 (nullable integer).
        - Convert noray_start and noray_end to float.
        - Normalize operation_type to canonical values.
        - Fill missing cargo_group / cargo_nature with empty string.

    Args:
        df: Cleaned DataFrame from the cleaning step.

    Returns:
        New DataFrame with normalised column types.
    """
    df = df.copy()

    # --- Date columns ---
    df["arrival_time"] = df["arrival_time"].apply(_parse_date)
    df["departure_time"] = df["departure_time"].apply(_parse_date)

    # --- Numeric columns ---
    df["vessel_length"] = pd.to_numeric(df["vessel_length"], errors="coerce").astype(float)
    df["vessel_gt"] = pd.to_numeric(df["vessel_gt"], errors="coerce").astype("Int64")
    df["noray_start"] = pd.to_numeric(df["noray_start"], errors="coerce")
    df["noray_end"] = pd.to_numeric(df["noray_end"], errors="coerce")
    df["quantity"] = pd.to_numeric(df["quantity"], errors="coerce")

    # --- Enumeration columns ---
    df["operation_type"] = df["operation_type"].apply(_normalize_operation_type)

    # --- Optional string columns — replace NaN with empty string ---
    df["cargo_group"] = df["cargo_group"].fillna("").astype(str).str.strip()
    df["cargo_nature"] = df["cargo_nature"].fillna("").astype(str).str.strip()

    return df
