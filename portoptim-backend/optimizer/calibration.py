"""Phase 1 — Calibration: fits statistical models from a historical CSV for duration and manoeuvre estimation."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import pandas as pd
import structlog

logger = structlog.get_logger()

# Fixed - minimum number of observations required to trust a learned model cell
MIN_OBS = 5

# Fixed - cargo groups classified as hazardous requiring extra safety resources
HAZARDOUS_CARGO_GROUPS: frozenset[str] = frozenset({"Energético", "Químicos"})


def get_eslora_bucket(eslora: float) -> str:
    """
    Map a vessel length to a discrete size bucket used as a model key.

    Args:
        eslora (float): Vessel length overall in metres. Required.

    Returns:
        str: One of "<80m", "80-150m", "150-220m", or ">220m".
    """
    if eslora < 80:
        return "<80m"
    if eslora < 150:
        return "80-150m"
    if eslora < 220:
        return "150-220m"
    return ">220m"


class Calibration:
    """
    Optional calibration object that fits statistical models from historical port data.

    Pass csv_path to fit from a CSV file; omit for a no-op calibration that returns
    None for all queries, causing the duration estimator to fall back to the configured default.
    """

    def __init__(self, csv_path: Optional[str] = None) -> None:
        """
        Initialize calibration, optionally fitting models from a CSV file.

        Args:
            csv_path (str): Server-side path to the historical CSV file. Optional, defaults to None.
        """
        # Computed - median throughput rate (t/h) keyed by (tipo_operacion, grupo_mercancia)
        self.rate_model: dict[tuple[str, str], float] = {}
        # Computed - median operation duration (h) keyed by (tipo_operacion, grupo_mercancia, eslora_bucket)
        self.duration_model: dict[tuple[str, str, str], float] = {}
        # Computed - learned ratio of actual multi-operation duration to sum of individual estimates
        self.overlap_factor_learned: Optional[float] = None
        # Computed - median manoeuvre duration (h) keyed by (eslora_bucket, hazardous)
        self.maneuver_model: dict[tuple[str, bool], float] = {}

        if csv_path and Path(csv_path).exists():
            self._fit(csv_path)

    def get_rate(self, tipo_operacion: str, grupo_mercancia: str) -> Optional[float]:
        """
        Return the median throughput rate for a given operation and cargo group.

        Args:
            tipo_operacion (str): Type of port operation. Required.
            grupo_mercancia (str): Cargo group identifier. Required.

        Returns:
            Optional[float]: Median rate in tonnes per hour, or None if not calibrated.
        """
        return self.rate_model.get((tipo_operacion, grupo_mercancia))

    def get_duration(
        self, tipo_operacion: str, grupo_mercancia: str, eslora: float
    ) -> Optional[float]:
        """
        Return the median operation duration for a given operation, cargo group, and vessel size.

        Args:
            tipo_operacion (str): Type of port operation. Required.
            grupo_mercancia (str): Cargo group identifier. Required.
            eslora (float): Vessel length in metres used to select the size bucket. Required.

        Returns:
            Optional[float]: Median duration in hours, or None if not calibrated.
        """
        bucket = get_eslora_bucket(eslora)
        return self.duration_model.get((tipo_operacion, grupo_mercancia, bucket))

    def get_maneuver_duration(self, eslora: float, grupo_mercancia: str) -> float:
        """
        Return the estimated manoeuvre duration for docking or undocking.

        Falls back to the formula 0.5 + 0.3 * hazardous if the model cell has
        fewer than MIN_OBS observations or the model was not fitted at all.

        Args:
            eslora (float): Vessel length in metres. Required.
            grupo_mercancia (str): Cargo group identifier used to detect hazardous cargo. Required.

        Returns:
            float: Estimated single manoeuvre duration in hours.
        """
        hazardous = grupo_mercancia in HAZARDOUS_CARGO_GROUPS
        bucket = get_eslora_bucket(eslora)
        learned = self.maneuver_model.get((bucket, hazardous))
        if learned is not None:
            return learned
        return 0.5 + (0.3 if hazardous else 0.0)

    def stats(self) -> dict:
        """
        Return a summary of the fitted calibration models for inspection.

        Returns:
            dict: Entry counts and model contents for all four sub-models.
        """
        return {
            "rate_model_entries": len(self.rate_model),
            "duration_model_entries": len(self.duration_model),
            "overlap_factor_learned": self.overlap_factor_learned,
            "maneuver_model_entries": len(self.maneuver_model),
            "rate_model": {f"{k[0]}|{k[1]}": v for k, v in self.rate_model.items()},
            "duration_model": {
                f"{k[0]}|{k[1]}|{k[2]}": v for k, v in self.duration_model.items()
            },
            "maneuver_model": {
                f"{k[0]}|{'hazardous' if k[1] else 'normal'}": v
                for k, v in self.maneuver_model.items()
            },
        }

    def _fit(self, csv_path: str) -> None:
        """
        Fit all four statistical models from the historical CSV file.

        Args:
            csv_path (str): Server-side path to the historical CSV file. Required.
        """
        df = pd.read_csv(csv_path, low_memory=False)
        df = self._normalize_columns(df)
        self._build_rate_model(df)
        self._build_duration_model(df)
        self._learn_overlap_factor(df)
        self._build_maneuver_model(df)
        logger.info(
            "calibration_complete",
            csv=csv_path,
            rate_entries=len(self.rate_model),
            duration_entries=len(self.duration_model),
            overlap_factor=self.overlap_factor_learned,
            maneuver_entries=len(self.maneuver_model),
        )

    def _normalize_columns(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Rename CSV columns to internal names regardless of their original form.

        Args:
            df (pd.DataFrame): Raw DataFrame read from the CSV file. Required.

        Returns:
            pd.DataFrame: DataFrame with standardized column names and computed duration_h column.
        """
        rename: dict[str, str] = {}
        for col in df.columns:
            lower = col.lower().strip()
            if "atraque" in lower and ("fecha" in lower or "date" in lower):
                rename[col] = "fecha_atraque"
            elif "desatraque" in lower and ("fecha" in lower or "date" in lower):
                rename[col] = "fecha_desatraque"
            elif "eslora" in lower or lower in ("vessel_length", "length"):
                rename[col] = "eslora"
            elif "tipo" in lower and "oper" in lower:
                rename[col] = "tipo_operacion"
            elif "cantidad" in lower or lower in ("quantity", "cargo_quantity"):
                rename[col] = "cantidad"
            elif "grupo" in lower and ("mercan" in lower or "cargo" in lower):
                rename[col] = "grupo_mercancia"
            elif lower in ("escala", "call_id", "escala_id"):
                rename[col] = "escala"

        df = df.rename(columns=rename)

        if "fecha_atraque" in df.columns and "fecha_desatraque" in df.columns:
            df["fecha_atraque"] = pd.to_datetime(df["fecha_atraque"], errors="coerce")
            df["fecha_desatraque"] = pd.to_datetime(
                df["fecha_desatraque"], errors="coerce"
            )
            df["duration_h"] = (
                df["fecha_desatraque"] - df["fecha_atraque"]
            ).dt.total_seconds() / 3600
            df = df[df["duration_h"] > 0].copy()

        return df

    def _build_rate_model(self, df: pd.DataFrame) -> None:
        """
        Build the throughput rate model: median tonnes per hour per (operation, cargo) pair.

        Args:
            df (pd.DataFrame): Normalized historical DataFrame. Required.
        """
        required = {"tipo_operacion", "grupo_mercancia", "cantidad", "duration_h"}
        if not required.issubset(df.columns):
            return

        valid = df[
            (df["cantidad"].notna()) & (df["cantidad"] > 0) & (df["duration_h"] > 0)
        ].copy()
        valid["rate"] = valid["cantidad"] / valid["duration_h"]

        for (tipo, grupo), grp in valid.groupby(
            ["tipo_operacion", "grupo_mercancia"]
        ):
            if len(grp) >= MIN_OBS:
                r = float(grp["rate"].median())
                if r > 0:
                    self.rate_model[(tipo, grupo)] = r

    def _build_duration_model(self, df: pd.DataFrame) -> None:
        """
        Build the duration model: median operation duration per (operation, cargo, eslora bucket).

        Args:
            df (pd.DataFrame): Normalized historical DataFrame. Required.
        """
        required = {"tipo_operacion", "grupo_mercancia", "eslora", "duration_h"}
        if not required.issubset(df.columns):
            return

        df = df.copy()
        df["eslora_bucket"] = df["eslora"].apply(
            lambda x: get_eslora_bucket(float(x)) if pd.notna(x) else None
        )
        df = df.dropna(subset=["eslora_bucket"])

        for (tipo, grupo, bucket), grp in df.groupby(
            ["tipo_operacion", "grupo_mercancia", "eslora_bucket"]
        ):
            if len(grp) >= MIN_OBS:
                d = float(grp["duration_h"].median())
                if d > 0:
                    self.duration_model[(tipo, grupo, bucket)] = d

    def _learn_overlap_factor(self, df: pd.DataFrame) -> None:
        """
        Learn the overlap factor from port calls with multiple simultaneous operations.

        Args:
            df (pd.DataFrame): Normalized historical DataFrame. Required.
        """
        required = {"escala", "tipo_operacion", "duration_h"}
        if not required.issubset(df.columns):
            return

        multi_op = df.groupby("escala").filter(
            lambda x: x["tipo_operacion"].nunique() > 1
        )
        if len(multi_op) < MIN_OBS:
            return

        ratios: list[float] = []
        for _esc, grp in multi_op.groupby("escala"):
            actual = grp["duration_h"].mean()
            individual_sum = 0.0
            valid = True

            for _, row in grp.iterrows():
                tipo = str(row.get("tipo_operacion", ""))
                grupo = str(row.get("grupo_mercancia", ""))
                cantidad = row.get("cantidad", None)
                eslora = row.get("eslora", None)

                est: Optional[float] = None
                if pd.notna(cantidad) and float(cantidad) > 0:
                    rate = self.rate_model.get((tipo, grupo))
                    if rate:
                        est = float(cantidad) / rate

                if est is None and pd.notna(eslora):
                    bucket = get_eslora_bucket(float(eslora))
                    est = self.duration_model.get((tipo, grupo, bucket))

                if est is None or est <= 0:
                    valid = False
                    break
                individual_sum += est

            if valid and individual_sum > 0:
                ratios.append(actual / individual_sum)

        if ratios:
            self.overlap_factor_learned = float(pd.Series(ratios).median())

    def _build_maneuver_model(self, df: pd.DataFrame) -> None:
        """
        Build the manoeuvre duration model: median estimated manoeuvre time per (eslora bucket, hazardous).

        Uses a proxy target derived from vessel length and hazardous flag.
        Cells with fewer than MIN_OBS rows are skipped and fall back to the formula at query time.

        Args:
            df (pd.DataFrame): Normalized historical DataFrame. Required.
        """
        required = {"eslora", "grupo_mercancia"}
        if not required.issubset(df.columns):
            return

        work = df[df["eslora"].notna()].copy()
        work["eslora_bucket"] = work["eslora"].apply(
            lambda x: get_eslora_bucket(float(x))
        )
        work["hazardous"] = work["grupo_mercancia"].isin(HAZARDOUS_CARGO_GROUPS)
        work["maneuver_proxy"] = work["eslora"].apply(
            lambda x: 0.08 * float(x) / 10
        ) + work["hazardous"].apply(lambda h: 0.3 if h else 0.0)

        for (bucket, hazardous), grp in work.groupby(["eslora_bucket", "hazardous"]):
            if len(grp) >= MIN_OBS:
                median_val = float(grp["maneuver_proxy"].median())
                if median_val > 0:
                    self.maneuver_model[(bucket, bool(hazardous))] = median_val
