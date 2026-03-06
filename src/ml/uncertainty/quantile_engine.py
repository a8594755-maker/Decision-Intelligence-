"""
PR-C Deliverable 1: Model-Agnostic Quantile Engine
───────────────────────────────────────────────────
Generates p10/p50/p90 for ANY point forecast using conformal / residual-based
intervals.

Primary method: Conformal residual-based intervals
  p50 = point_forecast
  p10 = p50 + q10(residuals)
  p90 = p50 + q90(residuals)

Supports:
  - global residual pool
  - per-series residual pool
  - hybrid fallback (per-series if enough samples, else global)

Guarantees:
  - Monotonicity: p10 <= p50 <= p90
  - Bounds sanity: clamp to non-negative when enforce_non_negative=True
"""
import json
import logging
import os
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Literal, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

# Minimum samples required for per-series residual pool
MIN_SERIES_SAMPLES = 15

CalibrationScope = Literal["none", "global", "per_series", "hybrid_per_series"]


@dataclass
class QuantileEngineConfig:
    """Configurable parameters for the Quantile Engine."""
    quantile_low: float = 0.10
    quantile_high: float = 0.90
    min_series_samples: int = MIN_SERIES_SAMPLES
    enforce_non_negative: bool = True


@dataclass
class QuantileResult:
    """Result from quantile generation."""
    p10: List[float]
    p50: List[float]
    p90: List[float]
    calibration_scope: CalibrationScope
    monotonicity_fixes: int = 0
    clamp_events: int = 0
    uncertainty_method: str = "residual_conformal"
    residual_quantiles: Optional[Dict[str, float]] = None

    def to_dict(self) -> dict:
        return {
            "p10": self.p10,
            "p50": self.p50,
            "p90": self.p90,
            "calibration_scope": self.calibration_scope,
            "monotonicity_fixes": self.monotonicity_fixes,
            "clamp_events": self.clamp_events,
            "uncertainty_method": self.uncertainty_method,
            "residual_quantiles": self.residual_quantiles,
        }


@dataclass
class CalibrationData:
    """Persisted calibration artifact data."""
    global_residuals: Optional[List[float]] = None
    per_series_residuals: Optional[Dict[str, List[float]]] = None
    global_q10: Optional[float] = None
    global_q90: Optional[float] = None
    per_series_q10: Optional[Dict[str, float]] = None
    per_series_q90: Optional[Dict[str, float]] = None
    sample_counts: Optional[Dict[str, int]] = None
    scope: CalibrationScope = "none"

    def to_dict(self) -> dict:
        return {
            "global_q10": self.global_q10,
            "global_q90": self.global_q90,
            "per_series_q10": self.per_series_q10,
            "per_series_q90": self.per_series_q90,
            "sample_counts": self.sample_counts,
            "scope": self.scope,
        }


class QuantileEngine:
    """
    Model-agnostic quantile generator using conformal / residual-based intervals.

    Usage:
        engine = QuantileEngine()
        engine.fit(residuals_global=[...], residuals_per_series={"SKU-A": [...]})
        result = engine.predict_quantiles(point_forecasts=[100, 110, 120])
    """

    def __init__(self, config: Optional[QuantileEngineConfig] = None):
        self.config = config or QuantileEngineConfig()
        self._calibration: CalibrationData = CalibrationData()
        self._fitted = False

    @property
    def is_fitted(self) -> bool:
        return self._fitted

    @property
    def calibration_scope(self) -> CalibrationScope:
        return self._calibration.scope

    def fit(
        self,
        residuals_global: Optional[List[float]] = None,
        residuals_per_series: Optional[Dict[str, List[float]]] = None,
    ) -> "QuantileEngine":
        """
        Fit the quantile engine on backtest residuals.

        Residuals are defined as: actual - predicted (forecast error).
        Positive residual = forecast was too low.

        Args:
            residuals_global: Pooled residuals from all series.
            residuals_per_series: Per-series residuals keyed by series ID.

        Returns:
            self (for chaining)
        """
        cal = CalibrationData()
        q_lo = self.config.quantile_low
        q_hi = self.config.quantile_high

        has_global = residuals_global is not None and len(residuals_global) > 0
        has_per_series = (
            residuals_per_series is not None
            and len(residuals_per_series) > 0
        )

        # Compute global quantiles
        if has_global:
            arr = np.array(residuals_global, dtype=np.float64)
            cal.global_residuals = residuals_global
            cal.global_q10 = float(np.quantile(arr, q_lo))
            cal.global_q90 = float(np.quantile(arr, q_hi))

        # Compute per-series quantiles
        if has_per_series:
            cal.per_series_residuals = residuals_per_series
            cal.per_series_q10 = {}
            cal.per_series_q90 = {}
            cal.sample_counts = {}
            for series_id, resids in residuals_per_series.items():
                cal.sample_counts[series_id] = len(resids)
                if len(resids) >= self.config.min_series_samples:
                    arr = np.array(resids, dtype=np.float64)
                    cal.per_series_q10[series_id] = float(np.quantile(arr, q_lo))
                    cal.per_series_q90[series_id] = float(np.quantile(arr, q_hi))

        # Determine scope
        has_valid_per_series = (
            cal.per_series_q10 is not None and len(cal.per_series_q10) > 0
        )
        if has_valid_per_series and has_global:
            cal.scope = "hybrid_per_series"
        elif has_valid_per_series:
            cal.scope = "per_series"
        elif has_global:
            cal.scope = "global"
        else:
            cal.scope = "none"

        self._calibration = cal
        self._fitted = cal.scope != "none"
        return self

    def predict_quantiles(
        self,
        point_forecasts: List[float],
        series_id: Optional[str] = None,
    ) -> QuantileResult:
        """
        Generate p10/p50/p90 from point forecasts.

        Args:
            point_forecasts: Model point predictions (one per horizon step).
            series_id: If provided and per-series calibration is available, use it.

        Returns:
            QuantileResult with p10, p50, p90 arrays.
        """
        pf = np.array(point_forecasts, dtype=np.float64)
        n = len(pf)

        if not self._fitted:
            # No calibration data available: use heuristic confidence band.
            # Use ±20% to produce a wider, more realistic uncertainty range.
            # A narrow ±10% band can mislead planners into under-ordering safety stock.
            logger.warning(
                "QuantileEngine not calibrated (no backtest residuals). "
                "Using ±20%% heuristic for %d point forecasts. "
                "Run backtest calibration to get conformal intervals.",
                n,
            )
            p10 = (pf * 0.80).tolist()
            p50 = pf.tolist()
            p90 = (pf * 1.20).tolist()
            result = QuantileResult(
                p10=p10, p50=p50, p90=p90,
                calibration_scope="none",
                uncertainty_method="heuristic_fallback_20pct",
            )
            return self._enforce_constraints(result)

        cal = self._calibration
        q10_offset, q90_offset = self._resolve_offsets(series_id)

        p50 = pf.copy()
        p10 = pf + q10_offset  # q10 of residuals is typically negative
        p90 = pf + q90_offset  # q90 of residuals is typically positive

        monotonicity_fixes = 0
        clamp_events = 0

        # Monotonicity enforcement: p10 <= p50 <= p90
        for i in range(n):
            if p10[i] > p50[i]:
                p10[i] = p50[i]
                monotonicity_fixes += 1
            if p90[i] < p50[i]:
                p90[i] = p50[i]
                monotonicity_fixes += 1

        # Non-negative clamping
        if self.config.enforce_non_negative:
            for i in range(n):
                if p10[i] < 0:
                    p10[i] = 0.0
                    clamp_events += 1
                if p50[i] < 0:
                    p50[i] = 0.0
                    clamp_events += 1
                if p90[i] < 0:
                    p90[i] = 0.0
                    clamp_events += 1

        scope = cal.scope
        if (
            series_id
            and cal.per_series_q10
            and series_id in cal.per_series_q10
        ):
            scope = "per_series"
        elif scope == "hybrid_per_series" and (
            not series_id
            or not cal.per_series_q10
            or series_id not in cal.per_series_q10
        ):
            scope = "global"

        result = QuantileResult(
            p10=p10.tolist(),
            p50=p50.tolist(),
            p90=p90.tolist(),
            calibration_scope=scope,
            monotonicity_fixes=monotonicity_fixes,
            clamp_events=clamp_events,
            uncertainty_method="residual_conformal",
            residual_quantiles={"q10_offset": q10_offset, "q90_offset": q90_offset},
        )
        return result

    def _resolve_offsets(self, series_id: Optional[str]) -> Tuple[float, float]:
        """Resolve q10/q90 residual offsets, with hybrid fallback."""
        cal = self._calibration

        # Try per-series first
        if series_id and cal.per_series_q10 and series_id in cal.per_series_q10:
            return cal.per_series_q10[series_id], cal.per_series_q90[series_id]

        # Fall back to global
        if cal.global_q10 is not None:
            return cal.global_q10, cal.global_q90

        # Should not reach here if fitted
        return 0.0, 0.0

    def _enforce_constraints(self, result: QuantileResult) -> QuantileResult:
        """Post-hoc enforcement for unfitted results."""
        fixes = 0
        clamps = 0
        for i in range(len(result.p50)):
            if result.p10[i] > result.p50[i]:
                result.p10[i] = result.p50[i]
                fixes += 1
            if result.p90[i] < result.p50[i]:
                result.p90[i] = result.p50[i]
                fixes += 1
            if self.config.enforce_non_negative:
                if result.p10[i] < 0:
                    result.p10[i] = 0.0
                    clamps += 1
                if result.p50[i] < 0:
                    result.p50[i] = 0.0
                    clamps += 1
                if result.p90[i] < 0:
                    result.p90[i] = 0.0
                    clamps += 1
        result.monotonicity_fixes = fixes
        result.clamp_events = clamps
        return result

    # ── Persistence ──

    def save(self, path: str) -> None:
        """Save calibration data to JSON file."""
        os.makedirs(os.path.dirname(path) if os.path.dirname(path) else ".", exist_ok=True)
        data = self._calibration.to_dict()
        data["config"] = {
            "quantile_low": self.config.quantile_low,
            "quantile_high": self.config.quantile_high,
            "min_series_samples": self.config.min_series_samples,
            "enforce_non_negative": self.config.enforce_non_negative,
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        logger.info("Calibration data saved to %s", path)

    def load(self, path: str) -> "QuantileEngine":
        """Load calibration data from JSON file."""
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)

        cal = CalibrationData(
            global_q10=data.get("global_q10"),
            global_q90=data.get("global_q90"),
            per_series_q10=data.get("per_series_q10"),
            per_series_q90=data.get("per_series_q90"),
            sample_counts=data.get("sample_counts"),
            scope=data.get("scope", "none"),
        )
        self._calibration = cal
        self._fitted = cal.scope != "none"

        config_data = data.get("config")
        if config_data:
            self.config = QuantileEngineConfig(
                quantile_low=config_data.get("quantile_low", 0.10),
                quantile_high=config_data.get("quantile_high", 0.90),
                min_series_samples=config_data.get("min_series_samples", MIN_SERIES_SAMPLES),
                enforce_non_negative=config_data.get("enforce_non_negative", True),
            )

        logger.info("Calibration data loaded from %s (scope=%s)", path, cal.scope)
        return self

    def get_calibration_report(self) -> dict:
        """Generate calibration report artifact data."""
        cal = self._calibration
        return {
            "residual_pool": cal.scope,
            "sample_counts": cal.sample_counts or {},
            "quantiles_used": {
                "global_q10": cal.global_q10,
                "global_q90": cal.global_q90,
                "per_series_q10": cal.per_series_q10,
                "per_series_q90": cal.per_series_q90,
            },
            "config": {
                "quantile_low": self.config.quantile_low,
                "quantile_high": self.config.quantile_high,
                "min_series_samples": self.config.min_series_samples,
                "enforce_non_negative": self.config.enforce_non_negative,
            },
        }
