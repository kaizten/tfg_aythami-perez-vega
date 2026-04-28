"""Application settings loaded from environment variables via pydantic-settings."""

from functools import lru_cache
from typing import Literal

from pydantic import AnyHttpUrl, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Central configuration object. Values are read from a .env file if present."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "PortOptim Backend"
    app_env: Literal["development", "staging", "production"] = "development"
    app_version: str = "0.1.0"
    log_level: str = "INFO"

    allowed_origins: list[str] = ["http://localhost:4200", "http://localhost:3000"]
    max_upload_size_mb: int = 50

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def parse_origins(cls, value: object) -> list[str]:
        """Accept a comma-separated string or an already-split list."""
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",")]
        return value  # type: ignore[return-value]

    @property
    def max_upload_size_bytes(self) -> int:
        """Max upload size expressed in bytes."""
        return self.max_upload_size_mb * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    """Return the cached singleton Settings instance."""
    return Settings()
