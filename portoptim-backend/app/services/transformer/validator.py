"""Column presence and type validator for the transformer pipeline."""

import logging
from typing import NamedTuple

import pandas as pd

logger = logging.getLogger(__name__)

# Maps input CSV column names to the internal aliases used by the rest of the pipeline.
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

# Columns that must be present AND non-null on a row for it to be kept.
CRITICAL_FIELDS: frozenset[str] = frozenset(
    {"call_id", "berth_id", "arrival_time", "departure_time", "vessel_length", "vessel_gt"}
)


class ValidationResult(NamedTuple):
    """Outcome of schema-level validation."""

    is_valid: bool
    missing_columns: list[str]


def validate_schema(df: pd.DataFrame) -> ValidationResult:
    """
    Check that all required columns are present in *df*.

    Args:
        df: Raw DataFrame loaded from the uploaded file.

    Returns:
        ValidationResult with is_valid=True when every required column is found,
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
    Rename raw input columns to their internal alias names.

    Only renames columns that exist in REQUIRED_COLUMN_MAP; any extra columns
    are dropped so downstream code works with a clean, predictable schema.

    Args:
        df: DataFrame that has passed schema validation.

    Returns:
        New DataFrame with renamed and filtered columns.
    """
    df = df.rename(columns=REQUIRED_COLUMN_MAP)
    return df[list(REQUIRED_COLUMN_MAP.values())].copy()
