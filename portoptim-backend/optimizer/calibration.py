"""
Phase 1 — Calibration.

Reads a historical CSV (optional) and builds three generic statistical models:
  • rate_model      – median t/h per (tipo_operacion, grupo_mercancia)
  • duration_model  – median duration per (tipo_operacion, grupo_mercancia, eslora_bucket)
  • overlap_factor_learned – ratio of actual multi-op duration to sum of individual estimates

No berth name or port-specific field is ever stored; all patterns are learned
by operation type and cargo group so the models work with any port config.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import pandas as pd
import structlog

logger = structlog.get_logger()

MIN_OBS = 5  # minimum observations required to trust a model cell


def get_eslora_bucket(eslora: float) -> str:
    if eslora < 80:
        return "<80m"
    if eslora < 150:
        return "80-150m"
    if eslora < 220:
        return "150-220m"
    return ">220m"


class Calibration:
    """
    Optional calibration object.  Pass csv_path to fit from historical data;
    omit (or pass None) for a no-op calibration that always returns None,
    letting the duration estimator fall back to the configured default.
    """

    def __init__(self, csv_path: Optional[str] = None) -> None:
        self.rate_model: dict[tuple[str, str], float] = {}
        self.duration_model: dict[tuple[str, str, str], float] = {}
        self.overlap_factor_learned: Optional[float] = None

        if csv_path and Path(csv_path).exists():
            self._fit(csv_path)

    # ── Public interface ───────────────────────────────────────────────────────

    def get_rate(self, tipo_operacion: str, grupo_mercancia: str) -> Optional[float]:
        """Median t/h for this (operation, cargo) pair, or None if not calibrated."""
        return self.rate_model.get((tipo_operacion, grupo_mercancia))

    def get_duration(
        self, tipo_operacion: str, grupo_mercancia: str, eslora: float
    ) -> Optional[float]:
        """Median duration (h) for this (operation, cargo, eslora bucket), or None."""
        bucket = get_eslora_bucket(eslora)
        return self.duration_model.get((tipo_operacion, grupo_mercancia, bucket))

    def stats(self) -> dict:
        return {
            "rate_model_entries": len(self.rate_model),
            "duration_model_entries": len(self.duration_model),
            "overlap_factor_learned": self.overlap_factor_learned,
            "rate_model": {f"{k[0]}|{k[1]}": v for k, v in self.rate_model.items()},
            "duration_model": {
                f"{k[0]}|{k[1]}|{k[2]}": v for k, v in self.duration_model.items()
            },
        }

    # ── Fitting ────────────────────────────────────────────────────────────────

    def _fit(self, csv_path: str) -> None:
        df = pd.read_csv(csv_path, low_memory=False)
        df = self._normalize_columns(df)
        self._build_rate_model(df)
        self._build_duration_model(df)
        self._learn_overlap_factor(df)
        logger.info(
            "calibration_complete",
            csv=csv_path,
            rate_entries=len(self.rate_model),
            duration_entries=len(self.duration_model),
            overlap_factor=self.overlap_factor_learned,
        )

    def _normalize_columns(self, df: pd.DataFrame) -> pd.DataFrame:
        """Rename CSV columns to internal names regardless of their original form."""
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
