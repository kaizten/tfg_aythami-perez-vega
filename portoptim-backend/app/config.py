"""Application settings loaded from environment variables via pydantic-settings."""

from functools import lru_cache
from typing import Literal

from pydantic import AnyHttpUrl, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Central configuration object. Values are read from a .env file if present."""

    # Fixed - pydantic-settings configuration: .env file path and encoding
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Fixed - application display name shown in API documentation
    app_name: str = "PortOptim Backend"

    # Fixed - deployment environment controlling runtime behaviour
    app_env: Literal["development", "staging", "production"] = "development"

    # Fixed - semantic version string shown in API documentation
    app_version: str = "0.1.0"

    # Fixed - minimum log severity level for the root logger
    log_level: str = "INFO"

    # Fixed - list of CORS-allowed frontend origins
    allowed_origins: list[str] = ["http://localhost:4200", "http://localhost:3000"]

    # Fixed - maximum accepted upload size in megabytes
    max_upload_size_mb: int = 50

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def parse_origins(cls, value: object) -> list[str]:
        """
        Accept a comma-separated string or an already-split list for allowed_origins.

        Args:
            value (object): Raw value from the environment variable or default.

        Returns:
            list[str]: List of origin URL strings.
        """
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",")]
        return value  # type: ignore[return-value]

    @property
    def max_upload_size_bytes(self) -> int:
        """
        Convert the megabyte upload limit to bytes.

        Returns:
            int: Maximum upload size expressed in bytes.
        """
        return self.max_upload_size_mb * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    """
    Return the cached singleton Settings instance.

    Returns:
        Settings: Application settings object loaded from environment.
    """
    return Settings()
