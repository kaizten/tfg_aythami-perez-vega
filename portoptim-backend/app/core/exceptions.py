"""Custom HTTP exceptions and global exception handlers for FastAPI."""

from fastapi import Request, status
from fastapi.responses import JSONResponse


class TransformationError(Exception):
    """Raised when the transformation pipeline encounters an unrecoverable error."""

    def __init__(self, detail: str) -> None:
        """
        Initialise TransformationError with a human-readable error message.

        Args:
            detail (str): Description of the transformation failure. Required.
        """
        self.detail = detail
        super().__init__(detail)


class InvalidFileError(Exception):
    """Raised when the uploaded file cannot be parsed as CSV or Excel."""

    def __init__(self, detail: str) -> None:
        """
        Initialise InvalidFileError with a human-readable error message.

        Args:
            detail (str): Description of why the file is invalid. Required.
        """
        self.detail = detail
        super().__init__(detail)


class FileTooLargeError(Exception):
    """Raised when the uploaded file exceeds the configured size limit."""

    def __init__(self, size_mb: float, limit_mb: int) -> None:
        """
        Initialise FileTooLargeError with the actual and allowed file sizes.

        Args:
            size_mb (float): Actual size of the uploaded file in megabytes. Required.
            limit_mb (int): Configured maximum allowed size in megabytes. Required.
        """
        self.detail = (
            f"File size {size_mb:.1f} MB exceeds the maximum allowed {limit_mb} MB."
        )
        super().__init__(self.detail)


async def transformation_error_handler(
    _request: Request, exc: TransformationError
) -> JSONResponse:
    """
    Return a structured 422 response for TransformationError exceptions.

    Args:
        _request (Request): The incoming FastAPI request (unused). Required.
        exc (TransformationError): The raised exception containing the error detail. Required.

    Returns:
        JSONResponse: HTTP 422 response with a detail field describing the error.
    """
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": exc.detail},
    )


async def invalid_file_error_handler(
    _request: Request, exc: InvalidFileError
) -> JSONResponse:
    """
    Return a structured 400 response for InvalidFileError exceptions.

    Args:
        _request (Request): The incoming FastAPI request (unused). Required.
        exc (InvalidFileError): The raised exception containing the error detail. Required.

    Returns:
        JSONResponse: HTTP 400 response with a detail field describing the error.
    """
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={"detail": exc.detail},
    )


async def file_too_large_handler(
    _request: Request, exc: FileTooLargeError
) -> JSONResponse:
    """
    Return a structured 413 response for FileTooLargeError exceptions.

    Args:
        _request (Request): The incoming FastAPI request (unused). Required.
        exc (FileTooLargeError): The raised exception containing the error detail. Required.

    Returns:
        JSONResponse: HTTP 413 response with a detail field describing the size violation.
    """
    return JSONResponse(
        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        content={"detail": exc.detail},
    )
