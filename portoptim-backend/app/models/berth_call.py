"""Pydantic model representing a fully transformed and validated berth call record."""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, computed_field, model_validator


class BerthCall(BaseModel):
    """A single standardized port call record after the transformation pipeline."""

    # User-provided - unique identifier for the port call (e.g. 'T202200020')
    call_id: str

    # User-provided - identifier of the berth where the vessel moored
    berth_id: str

    # User-provided - mooring line start position number, optional
    noray_start: Optional[float] = None

    # User-provided - mooring line end position number, optional
    noray_end: Optional[float] = None

    # User-provided - datetime when the vessel arrived and moored at the berth
    arrival_time: datetime

    # User-provided - datetime when the vessel departed the berth
    departure_time: datetime

    # User-provided - overall length of the vessel in metres
    vessel_length: float

    # User-provided - gross tonnage of the vessel
    vessel_gt: int

    # User-provided - canonical operation type (Embarque, Desembarque, or Trasbordo)
    operation_type: str

    # User-provided - cargo commodity group classification
    cargo_group: str

    # User-provided - specific cargo nature or commodity subtype
    cargo_nature: str

    # User-provided - cargo quantity handled during the port call, optional
    quantity: Optional[float] = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def duration_hours(self) -> float:
        """
        Compute the total berthing duration in hours.

        Returns:
            float: Hours elapsed between arrival_time and departure_time.
        """
        return (self.departure_time - self.arrival_time).total_seconds() / 3600

    @model_validator(mode="after")
    def departure_after_arrival(self) -> "BerthCall":
        """
        Validate that departure_time is strictly after arrival_time.

        Returns:
            BerthCall: The validated model instance.

        Raises:
            ValueError: If departure_time is not strictly after arrival_time.
        """
        if self.departure_time <= self.arrival_time:
            raise ValueError(
                f"departure_time ({self.departure_time}) must be after "
                f"arrival_time ({self.arrival_time})"
            )
        return self
