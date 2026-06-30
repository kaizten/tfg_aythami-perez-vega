"""POST /api/v1/transform — upload a port dataset and receive transformed BerthCall records."""

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, UploadFile, status
from fastapi.responses import JSONResponse

from app.config import Settings, get_settings
from app.core.exceptions import FileTooLargeError, InvalidFileError, TransformationError
from app.services.transformer.transformer_service import TransformationResult, run_pipeline
from app.utils.csv_reader import read_file

logger = logging.getLogger(__name__)

# Fixed - FastAPI router for transformation endpoints, mounted under /transform
router = APIRouter(prefix="/transform", tags=["transformer"])


def _build_response(result: TransformationResult) -> dict[str, Any]:
    """
    Serialise a TransformationResult into the JSON response shape expected by the frontend.

    Args:
        result (TransformationResult): Output from the transformation pipeline. Required.

    Returns:
        dict[str, Any]: Dictionary with transformation_summary, available_ports, and data fields.
    """
    return {
        "transformation_summary": {
            "total_input_rows": result.summary.total_input_rows,
            "valid_rows": result.summary.valid_rows,
            "skipped_rows": result.summary.skipped_rows,
            "skipped_reasons": result.summary.skipped_reasons,
        },
        "available_ports": result.available_ports,
        "data": [call.model_dump(mode="json") for call in result.records],
    }


@router.post(
    "/",
    status_code=status.HTTP_200_OK,
    summary="Transform port dataset",
    description=(
        "Upload a CSV or Excel file containing raw Spanish port call records. "
        "Returns an array of standardised BerthCall objects and a transformation summary."
    ),
)
async def transform_dataset(
    file: Annotated[UploadFile, File(description="CSV or Excel file with port call data")],
    settings: Annotated[Settings, Depends(get_settings)],
) -> JSONResponse:
    """
    POST /api/v1/transform/ — receive an uploaded file, run the transformation pipeline, and return results.

    Args:
        file (UploadFile): The multipart-uploaded CSV or Excel file. Required.
        settings (Settings): Injected application settings. Required.

    Returns:
        JSONResponse: HTTP 200 with transformation_summary, available_ports, and data fields.

    Raises:
        FileTooLargeError: File exceeds the configured size limit.
        InvalidFileError: File cannot be parsed due to bad format or encoding.
        TransformationError: Pipeline fails due to missing required columns.
    """
    content = await file.read()
    size_mb = len(content) / (1024 * 1024)

    if len(content) > settings.max_upload_size_bytes:
        raise FileTooLargeError(size_mb=size_mb, limit_mb=settings.max_upload_size_mb)

    logger.info(
        "Received file '%s' (%.2f MB) for transformation.", file.filename, size_mb
    )

    try:
        df = read_file(content=content, filename=file.filename or "upload.csv")
    except ValueError as exc:
        raise InvalidFileError(detail=str(exc)) from exc

    try:
        result = run_pipeline(df)
    except ValueError as exc:
        raise TransformationError(detail=str(exc)) from exc

    return JSONResponse(content=_build_response(result))
