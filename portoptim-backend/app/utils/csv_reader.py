"""Utility for reading CSV and Excel files into a pandas DataFrame."""

import io
import logging
from typing import Union

import pandas as pd

logger = logging.getLogger(__name__)

# Fixed - set of MIME types accepted by the file upload endpoint
ACCEPTED_CONTENT_TYPES: frozenset[str] = frozenset(
    {
        "text/csv",
        "application/csv",
        "text/plain",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }
)


def read_file(
    content: bytes,
    filename: str,
    encoding: str = "utf-8",
) -> pd.DataFrame:
    """
    Parse raw file bytes into a DataFrame based on the extension in filename.

    Dispatches to _read_csv for .csv files and _read_excel for .xlsx/.xls files.
    Tries UTF-8 first for CSV; falls back to latin-1 if decoding fails.

    Args:
        content (bytes): Raw bytes of the uploaded file. Required.
        filename (str): Original file name used to determine the parser. Required.
        encoding (str): Primary character encoding to try for CSV files. Optional, defaults to 'utf-8'.

    Returns:
        pd.DataFrame: Raw DataFrame with all columns preserved as strings.

    Raises:
        ValueError: If the file extension is not supported or the file cannot be parsed.
    """
    lower_name = filename.lower()
    buffer = io.BytesIO(content)

    if lower_name.endswith(".csv"):
        return _read_csv(buffer, encoding=encoding)
    elif lower_name.endswith((".xlsx", ".xls")):
        return _read_excel(buffer)
    else:
        raise ValueError(
            f"Unsupported file type '{filename}'. Only .csv, .xlsx and .xls are accepted."
        )


def _read_csv(buffer: io.BytesIO, encoding: str) -> pd.DataFrame:
    """
    Read a CSV buffer into a DataFrame, falling back to latin-1 on UnicodeDecodeError.

    Args:
        buffer (io.BytesIO): In-memory bytes buffer of the CSV file. Required.
        encoding (str): Primary character encoding to attempt first. Required.

    Returns:
        pd.DataFrame: Parsed DataFrame with all columns as strings.

    Raises:
        ValueError: If the CSV cannot be parsed after both encoding attempts.
    """
    try:
        df = pd.read_csv(buffer, dtype=str, keep_default_na=False, encoding=encoding)
        logger.info("CSV parsed successfully with encoding=%s, rows=%d", encoding, len(df))
        return df
    except UnicodeDecodeError:
        logger.warning("UTF-8 decoding failed — retrying with latin-1.")
        buffer.seek(0)
        df = pd.read_csv(buffer, dtype=str, keep_default_na=False, encoding="latin-1")
        logger.info("CSV parsed with latin-1 fallback, rows=%d", len(df))
        return df
    except pd.errors.ParserError as exc:
        raise ValueError(f"CSV parse error: {exc}") from exc


def _read_excel(buffer: io.BytesIO) -> pd.DataFrame:
    """
    Read the first sheet of an Excel file into a DataFrame.

    Args:
        buffer (io.BytesIO): In-memory bytes buffer of the Excel file. Required.

    Returns:
        pd.DataFrame: Parsed DataFrame with all columns as strings.

    Raises:
        ValueError: If the Excel file cannot be parsed.
    """
    try:
        df = pd.read_excel(buffer, dtype=str, keep_default_na=False)
        logger.info("Excel parsed successfully, rows=%d", len(df))
        return df
    except Exception as exc:
        raise ValueError(f"Excel parse error: {exc}") from exc
