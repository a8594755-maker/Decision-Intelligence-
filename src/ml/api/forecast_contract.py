"""Forecast API contract v1.0 models and response normalization utilities.

Mirrors the pattern established by planning_contract.py:
- Versioned Pydantic models with ConfigDict(extra="allow")
- finalize_*_response() normalization functions
- Backward-compatible: all legacy fields preserved, new fields additive
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


FORECAST_API_CONTRACT_VERSION = "1.0"


# ---------------------------------------------------------------------------
# Forecast models
# ---------------------------------------------------------------------------

class ForecastPoint(BaseModel):
    """Single forecast data point with canonical quantiles."""

    model_config = ConfigDict(extra="allow")

    date: str = ""
    p10: Optional[float] = None
    p50: float = 0.0
    p90: Optional[float] = None
    # Backward-compatible aliases (auto-populated from canonical fields)
    forecast: Optional[float] = None
    lower: Optional[float] = None
    upper: Optional[float] = None

    @model_validator(mode="after")
    def _populate_aliases(self) -> "ForecastPoint":
        if self.forecast is None:
            self.forecast = self.p50
        if self.lower is None and self.p10 is not None:
            self.lower = self.p10
        if self.upper is None and self.p90 is not None:
            self.upper = self.p90
        return self


class ForecastSeriesMeta(BaseModel):
    """Metadata about the forecast model and inference run."""

    model_config = ConfigDict(extra="allow")

    model: str = "unknown"
    model_version: str = "unknown"
    risk_score: Optional[float] = None
    inference_mode: Optional[str] = None


class ForecastResponse(BaseModel):
    """Canonical /demand-forecast response envelope."""

    model_config = ConfigDict(extra="allow")

    forecast_contract_version: str = FORECAST_API_CONTRACT_VERSION
    materialCode: str = ""
    horizon: int = 0
    points: List[ForecastPoint] = Field(default_factory=list)
    series_meta: ForecastSeriesMeta = Field(default_factory=ForecastSeriesMeta)
    # Legacy fields preserved for backward compatibility
    forecast: Dict[str, Any] = Field(default_factory=dict)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    cached: bool = False
    comparison: Optional[Dict[str, Any]] = None
    consensus_warning: Optional[Dict[str, Any]] = None

    @field_validator("forecast_contract_version")
    @classmethod
    def _validate_version(cls, value: str) -> str:
        text = str(value or "").strip() or FORECAST_API_CONTRACT_VERSION
        if not text.startswith("1."):
            raise ValueError(
                f"Unsupported forecast contract version '{text}'. Expected 1.x for this API instance."
            )
        return text


# ---------------------------------------------------------------------------
# Backtest models
# ---------------------------------------------------------------------------

class BacktestResultRow(BaseModel):
    """Single model result within a backtest run."""

    model_config = ConfigDict(extra="allow")

    model: str
    success: bool = True
    mape: Optional[float] = None
    bias: Optional[float] = None
    grade: Optional[str] = None
    forecast: List[float] = Field(default_factory=list)
    actual: List[float] = Field(default_factory=list)
    points: List[ForecastPoint] = Field(default_factory=list)


class BacktestMetrics(BaseModel):
    """Aggregate accuracy metrics from a backtest."""

    model_config = ConfigDict(extra="allow")

    mape: Optional[float] = None
    mase: Optional[float] = None
    bias: Optional[float] = None
    coverage_10_90: Optional[float] = None
    pinball_loss_p10: Optional[float] = None
    pinball_loss_p50: Optional[float] = None
    pinball_loss_p90: Optional[float] = None


class BacktestDiagnostics(BaseModel):
    """Diagnostic metadata from a backtest."""

    model_config = ConfigDict(extra="allow")

    train_points: int = 0
    test_days: int = 0
    consensus_level: Optional[str] = None
    mape_variance: Optional[float] = None


class BacktestResponse(BaseModel):
    """Canonical /backtest response envelope."""

    model_config = ConfigDict(extra="allow")

    forecast_contract_version: str = FORECAST_API_CONTRACT_VERSION
    sku: str = ""
    metrics: BacktestMetrics = Field(default_factory=BacktestMetrics)
    diagnostics: BacktestDiagnostics = Field(default_factory=BacktestDiagnostics)
    results: List[BacktestResultRow] = Field(default_factory=list)
    best_model: Dict[str, Any] = Field(default_factory=dict)
    calibration_scope: str = "none"
    # Legacy fields preserved
    consensus: Dict[str, Any] = Field(default_factory=dict)
    reliability: Optional[str] = None
    recommendation: Optional[str] = None
    accuracy_score: Optional[float] = None

    @field_validator("forecast_contract_version")
    @classmethod
    def _validate_version(cls, value: str) -> str:
        text = str(value or "").strip() or FORECAST_API_CONTRACT_VERSION
        if not text.startswith("1."):
            raise ValueError(
                f"Unsupported forecast contract version '{text}'. Expected 1.x for this API instance."
            )
        return text


# ---------------------------------------------------------------------------
# Normalization / finalization helpers
# ---------------------------------------------------------------------------

def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        v = float(value)
        return v if v == v else default  # NaN check
    except Exception:
        return default


def _clamp_non_negative(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    return max(0.0, value)


def finalize_forecast_response(
    payload: Dict[str, Any],
    *,
    material_code: str,
    horizon: int,
) -> Dict[str, Any]:
    """Normalize a raw forecast dict to the v1.0 forecast contract.

    Builds canonical ``points[]`` from legacy ``predictions`` /
    ``confidence_interval`` arrays when ``points`` is not already present.
    All existing fields pass through untouched.
    """
    root = dict(payload or {})

    root["forecast_contract_version"] = str(
        root.get("forecast_contract_version") or FORECAST_API_CONTRACT_VERSION
    )
    root["materialCode"] = material_code
    root["horizon"] = horizon

    # Build canonical points[] from legacy prediction arrays if not already set
    forecast_data = root.get("forecast") or {}
    prediction_data = root.get("_prediction_data") or {}

    if not root.get("points"):
        predictions = (
            prediction_data.get("predictions")
            or forecast_data.get("predictions")
            or []
        )
        ci = (
            prediction_data.get("confidence_interval")
            or forecast_data.get("confidence_interval")
            or []
        )
        # Prefer explicit p10/p50/p90 arrays from prediction_data
        p10_arr = prediction_data.get("p10")
        p50_arr = prediction_data.get("p50") or predictions
        p90_arr = prediction_data.get("p90")

        points: List[Dict[str, Any]] = []
        for i in range(len(p50_arr)):
            p50 = _clamp_non_negative(_safe_float(p50_arr[i]))
            if p10_arr and i < len(p10_arr):
                p10 = _clamp_non_negative(_safe_float(p10_arr[i]))
            elif i < len(ci):
                p10 = _clamp_non_negative(_safe_float(ci[i][0] if isinstance(ci[i], (list, tuple)) else None))
            else:
                p10 = None
            if p90_arr and i < len(p90_arr):
                p90 = _safe_float(p90_arr[i])
            elif i < len(ci):
                p90 = _safe_float(ci[i][1] if isinstance(ci[i], (list, tuple)) else None)
            else:
                p90 = None

            # Enforce invariant: p10 <= p50 <= p90
            if p10 is not None and p10 > p50:
                p10 = p50
            if p90 is not None and p90 < p50:
                p90 = p50

            points.append({"date": "", "p10": p10, "p50": p50, "p90": p90})

        root["points"] = points

    # Build series_meta from forecast data
    if not root.get("series_meta"):
        root["series_meta"] = {
            "model": str(forecast_data.get("model") or "unknown"),
            "model_version": str(forecast_data.get("model_version") or "unknown"),
            "risk_score": forecast_data.get("risk_score"),
            "inference_mode": (root.get("metadata") or {}).get("inference_mode"),
        }

    # Remove internal-only key
    root.pop("_prediction_data", None)

    validated = ForecastResponse.model_validate(root)
    return validated.model_dump(mode="json")


def finalize_backtest_response(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize a raw backtest dict to the v1.0 forecast contract.

    Adds ``forecast_contract_version``, structures ``metrics`` and
    ``diagnostics`` from flat fields. Existing fields preserved.
    """
    root = dict(payload or {})

    root["forecast_contract_version"] = str(
        root.get("forecast_contract_version") or FORECAST_API_CONTRACT_VERSION
    )
    root.setdefault("calibration_scope", "none")

    # Build structured metrics from best_model
    if not root.get("metrics") or not isinstance(root.get("metrics"), dict):
        best = root.get("best_model") or {}
        root["metrics"] = {
            "mape": best.get("mape"),
            "bias": None,
            "coverage_10_90": None,
        }

    # Build diagnostics
    if not root.get("diagnostics") or not isinstance(root.get("diagnostics"), dict):
        consensus = root.get("consensus") or {}
        root["diagnostics"] = {
            "train_points": root.get("train_points", 0),
            "test_days": root.get("test_days", 0),
            "consensus_level": consensus.get("level"),
            "mape_variance": consensus.get("mape_variance"),
        }

    validated = BacktestResponse.model_validate(root)
    return validated.model_dump(mode="json")
