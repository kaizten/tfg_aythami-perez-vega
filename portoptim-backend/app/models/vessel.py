"""Pydantic model representing a raw vessel entity from port data."""

from typing import Optional
from pydantic import BaseModel, field_validator


class Vessel(BaseModel):
    """Lightweight model for raw vessel metadata extracted from port records."""

    call_id: str
    name: str
    vessel_gt: Optional[int] = None
    vessel_length: Optional[float] = None
    consignee: Optional[str] = None
    stevedore: Optional[str] = None
    country: Optional[str] = None
    origin_port: Optional[str] = None

    @field_validator("call_id", "name", mode="before")
    @classmethod
    def strip_whitespace(cls, value: str) -> str:
        """Strip leading/trailing whitespace from string identifiers."""
        return value.strip() if isinstance(value, str) else value
