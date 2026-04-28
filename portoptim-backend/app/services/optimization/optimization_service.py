"""
Berth allocation optimization service — scaffold only.

This module will contain the optimization algorithm once the
data_transformer module is validated in production.
"""

import logging
from typing import Any

from app.models.berth_call import BerthCall

logger = logging.getLogger(__name__)


class OptimizationService:
    """
    Orchestrates the berth allocation optimization algorithm.

    Not yet implemented. Placeholder raises NotImplementedError
    to make the unfinished state explicit at runtime.
    """

    def optimize(self, berth_calls: list[BerthCall]) -> Any:
        """
        Run the optimization algorithm over a list of validated berth calls.

        Args:
            berth_calls: List of transformed and validated BerthCall records.

        Returns:
            Optimization result (schema TBD).

        Raises:
            NotImplementedError: Always — not yet implemented.
        """
        raise NotImplementedError(
            "OptimizationService.optimize() is not yet implemented. "
            "Complete the data_transformer module first."
        )
