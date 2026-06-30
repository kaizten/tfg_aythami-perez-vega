"""API v1 package — assembles all v1 routers under the /api/v1 prefix."""

from fastapi import APIRouter

from app.api.v1.routes.optimization import router as optimization_router
from app.api.v1.routes.transformer import router as transformer_router
from optimizer.router import router as optimizer_router

# Computed - top-level v1 router that aggregates all sub-routers
api_v1_router = APIRouter(prefix="/api/v1")
api_v1_router.include_router(transformer_router)
api_v1_router.include_router(optimization_router)
api_v1_router.include_router(optimizer_router)
