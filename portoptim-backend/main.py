"""FastAPI application entry point."""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1 import api_v1_router
from app.config import get_settings
from app.core.exceptions import (
    FileTooLargeError,
    InvalidFileError,
    TransformationError,
    file_too_large_handler,
    invalid_file_error_handler,
    transformation_error_handler,
)

settings = get_settings()

logging.basicConfig(
    level=settings.log_level.upper(),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)

app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description=(
        "REST API for transforming and optimizing maritime port scheduling data. "
        "Built for the PortOptim TFG project."
    ),
    docs_url="/docs",
    redoc_url="/redoc",
)

# --- CORS ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Exception handlers ---
app.add_exception_handler(TransformationError, transformation_error_handler)  # type: ignore[arg-type]
app.add_exception_handler(InvalidFileError, invalid_file_error_handler)  # type: ignore[arg-type]
app.add_exception_handler(FileTooLargeError, file_too_large_handler)  # type: ignore[arg-type]

# --- Routers ---
app.include_router(api_v1_router)


@app.get("/health", tags=["meta"])
async def health_check() -> dict[str, str]:
    """Liveness probe — returns app name and version."""
    return {"status": "ok", "app": settings.app_name, "version": settings.app_version}
