"""Pydantic model representing a fully transformed and validated berth call record."""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, computed_field, model_validator


class BerthCall(BaseModel):
    """A single standardized port call record after the transformation pipeline."""

    call_id: str
    berth_id: str
    noray_start: Optional[float] = None
    noray_end: Optional[float] = None
    arrival_time: datetime
    departure_time: datetime
    vessel_length: float
    vessel_gt: int
    operation_type: str
    cargo_group: str
    cargo_nature: str
    quantity: Optional[float] = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def duration_hours(self) -> float:
        """Total berthing duration in hours (departure − arrival)."""
        return (self.departure_time - self.arrival_time).total_seconds() / 3600

    @model_validator(mode="after")
    def departure_after_arrival(self) -> "BerthCall":
        """Ensure departure_time is strictly after arrival_time."""
        if self.departure_time <= self.arrival_time:
            raise ValueError(
                f"departure_time ({self.departure_time}) must be after "
                f"arrival_time ({self.arrival_time})"
            )
        return self
