"""API v1 package."""
from fastapi import APIRouter

from app.api.v1.routes.optimization import router as optimization_router
from app.api.v1.routes.transformer import router as transformer_router

api_v1_router = APIRouter(prefix="/api/v1")
api_v1_router.include_router(transformer_router)
api_v1_router.include_router(optimization_router)
