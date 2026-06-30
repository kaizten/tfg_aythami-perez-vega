"""Pydantic model representing a raw vessel entity from port data."""

from typing import Optional
from pydantic import BaseModel, field_validator


class Vessel(BaseModel):
    """Lightweight model for raw vessel metadata extracted from port records."""

    # User-provided - unique port call identifier linking the vessel to a berth call
    call_id: str

    # User-provided - vessel name as recorded in the port dataset
    name: str

    # User-provided - gross tonnage of the vessel, optional
    vessel_gt: Optional[int] = None

    # User-provided - overall length of the vessel in metres, optional
    vessel_length: Optional[float] = None

    # User-provided - consignee company responsible for the cargo, optional
    consignee: Optional[str] = None

    # User-provided - stevedore company handling cargo operations, optional
    stevedore: Optional[str] = None

    # User-provided - flag state country of the vessel, optional
    country: Optional[str] = None

    # User-provided - last port of origin before this call, optional
    origin_port: Optional[str] = None

    @field_validator("call_id", "name", mode="before")
    @classmethod
    def strip_whitespace(cls, value: str) -> str:
        """
        Strip leading and trailing whitespace from string identifier fields.

        Args:
            value (str): Raw string value from the input data. Required.

        Returns:
            str: Stripped string, or the original value if it is not a string.
        """
        return value.strip() if isinstance(value, str) else value
