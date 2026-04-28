"""GET /api/v1/optimize — placeholder route for the optimization engine."""

from fastapi import APIRouter, status
from fastapi.responses import JSONResponse

router = APIRouter(prefix="/optimize", tags=["optimization"])


@router.post(
    "/",
    status_code=status.HTTP_501_NOT_IMPLEMENTED,
    summary="Run berth allocation optimization (not yet implemented)",
    description="Placeholder endpoint. Will accept BerthCall data and return an optimized schedule.",
    include_in_schema=True,
)
async def run_optimization() -> JSONResponse:
    """
    Stub endpoint for the future optimization module.

    Returns:
        501 Not Implemented with an explanatory message.
    """
    return JSONResponse(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        content={
            "detail": (
                "The optimization engine is not yet implemented. "
                "Complete the data_transformer module first."
            )
        },
    )
