"""Shared pytest fixtures."""

import pathlib
import pytest


FIXTURES_DIR = pathlib.Path(__file__).parent / "fixtures"


@pytest.fixture
def sample_csv_path() -> pathlib.Path:
    """Return the path to the sample port data CSV fixture."""
    return FIXTURES_DIR / "sample_port_data.csv"


@pytest.fixture
def sample_csv_bytes(sample_csv_path: pathlib.Path) -> bytes:
    """Return the raw bytes of the sample port data CSV fixture."""
    return sample_csv_path.read_bytes()
