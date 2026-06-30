"""Column presence and type validator for the transformer pipeline."""

import logging
from typing import NamedTuple

import pandas as pd

logger = logging.getLogger(__name__)

# Fixed - mapping from raw CSV column names to internal alias names used by the pipeline
REQUIRED_COLUMN_MAP: dict[str, str] = {
    "Escala": "call_id",
    "Muelle Real": "berth_id",
    "Noray Inicio": "noray_start",
    "Noray Fin": "noray_end",
    "Fecha Atraque Real": "arrival_time",
    "Fecha Desatraque Real": "departure_time",
    "Buque Eslora": "vessel_length",
    "Buque GT": "vessel_gt",
    "Tipo Operación": "operation_type",
    "Grupo Mercancía": "cargo_group",
    "Naturaleza Mercancia": "cargo_nature",
    "Cantidad": "quantity",
}

# Fixed - set of internal alias names that must be present and non-null for a row to be kept
CRITICAL_FIELDS: frozenset[str] = frozenset(
    {"call_id", "berth_id", "arrival_time", "departure_time", "vessel_length", "vessel_gt"}
)


class ValidationResult(NamedTuple):
    """Outcome of schema-level column presence validation."""

    # Computed - True when all required columns are found in the DataFrame
    is_valid: bool

    # Computed - list of required column names that were absent from the DataFrame
    missing_columns: list[str]


def validate_schema(df: pd.DataFrame) -> ValidationResult:
    """
    Check that all required columns defined in REQUIRED_COLUMN_MAP are present in df.

    Args:
        df (pd.DataFrame): Raw DataFrame loaded from the uploaded file. Required.

    Returns:
        ValidationResult: is_valid=True when every required column is present,
        or is_valid=False with the list of missing column names.
    """
    missing = [col for col in REQUIRED_COLUMN_MAP if col not in df.columns]
    if missing:
        logger.warning("Schema validation failed — missing columns: %s", missing)
        return ValidationResult(is_valid=False, missing_columns=missing)

    logger.info("Schema validation passed — all %d required columns present.", len(REQUIRED_COLUMN_MAP))
    return ValidationResult(is_valid=True, missing_columns=[])


def rename_columns(df: pd.DataFrame) -> pd.DataFrame:
    """
    Rename raw input columns to their internal alias names and drop all extra columns.

    Only renames columns that exist in REQUIRED_COLUMN_MAP; any extra columns
    are dropped so downstream pipeline steps work with a clean, predictable schema.

    Args:
        df (pd.DataFrame): DataFrame that has passed schema validation. Required.

    Returns:
        pd.DataFrame: New DataFrame with renamed columns and only the required fields retained.
    """
    df = df.rename(columns=REQUIRED_COLUMN_MAP)
    return df[list(REQUIRED_COLUMN_MAP.values())].copy()
