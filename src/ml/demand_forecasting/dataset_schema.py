"""
Phase 1 – Deliverable 1.1: Dataset Schema Validator
────────────────────────────────────────────────────
Pydantic models that validate inbound payloads at the API boundary.

Usage:
    from ml.demand_forecasting.dataset_schema import (
        validate_forecast_payload,
        validate_train_payload,
    )
    errors = validate_forecast_payload(raw_dict)
    if errors:
        return JSONResponse(status_code=422, content={"errors": errors})
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


# ── Inbound schemas ──────────────────────────────────────────────────────


class InlineHistoryPoint(BaseModel):
    """A single (date, value) point in an inline history payload."""

    date: Optional[str] = None
    value: Optional[float] = None
    sales: Optional[float] = None
    qty: Optional[float] = None
    quantity: Optional[float] = None

    def resolved_value(self) -> Optional[float]:
        """Return the first non-None value field."""
        for v in (self.value, self.sales, self.qty, self.quantity):
            if v is not None:
                return v
        return None


class DemandForecastPayload(BaseModel):
    """Schema for /demand-forecast and /backtest payloads."""

    materialCode: str = Field(..., min_length=1, description="SKU / material code")
    horizonDays: int = Field(default=30, ge=1, le=730)
    modelType: Optional[str] = Field(
        default=None,
        description="Model type: prophet, lightgbm, chronos, or None for auto",
    )
    history: Optional[List[float]] = Field(
        default=None, description="Inline historical demand values"
    )
    historyPoints: Optional[List[InlineHistoryPoint]] = Field(
        default=None, description="Structured history with dates"
    )

    @field_validator("modelType")
    @classmethod
    def validate_model_type(cls, v):
        if v is not None:
            allowed = {"prophet", "lightgbm", "chronos", "xgboost", "ets", "auto"}
            if v.lower() not in allowed:
                raise ValueError(
                    f"modelType must be one of {sorted(allowed)}, got '{v}'"
                )
        return v

    @field_validator("history")
    @classmethod
    def validate_history_values(cls, v):
        if v is not None:
            if len(v) < 7:
                raise ValueError(
                    f"history must have at least 7 data points, got {len(v)}"
                )
            import math
            for i, val in enumerate(v):
                if math.isnan(val) or math.isinf(val):
                    raise ValueError(f"history[{i}] contains NaN or Inf")
        return v


class TrainModelPayload(BaseModel):
    """Schema for /train-model payloads."""

    modelType: str = Field(
        default="lightgbm",
        description="Model type: lightgbm, prophet, all",
    )
    days: int = Field(default=365, ge=30, le=3650)
    seed: int = Field(default=42)
    mape_gate: float = Field(default=20.0, ge=0, le=100)
    history: Optional[List[float]] = Field(
        default=None, description="Inline historical demand values"
    )
    historyStartDate: Optional[str] = None
    historyEndDate: Optional[str] = None
    use_optuna: bool = Field(default=True)
    optuna_trials: int = Field(default=30, ge=1, le=500)

    @field_validator("modelType")
    @classmethod
    def validate_model_type(cls, v):
        allowed = {"lightgbm", "prophet", "all", "xgboost", "ets"}
        if v.lower() not in allowed:
            raise ValueError(
                f"modelType must be one of {sorted(allowed)}, got '{v}'"
            )
        return v

    @field_validator("history")
    @classmethod
    def validate_history_min(cls, v):
        if v is not None and len(v) < 30:
            raise ValueError(
                f"Training requires at least 30 data points, got {len(v)}"
            )
        return v

    @field_validator("historyStartDate", "historyEndDate")
    @classmethod
    def validate_date_format(cls, v):
        if v is not None:
            try:
                datetime.strptime(v, "%Y-%m-%d")
            except ValueError:
                raise ValueError(f"Date must be YYYY-MM-DD format, got '{v}'")
        return v


class DemandPointPayload(BaseModel):
    """Schema for a single demand point in a planning request."""

    sku: str = Field(..., min_length=1)
    plant_id: Optional[str] = None
    date: str
    p50: float = Field(ge=0)
    p90: Optional[float] = Field(default=None, ge=0)
    p10: Optional[float] = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_quantile_order(self):
        if self.p10 is not None and self.p90 is not None:
            if self.p10 > self.p90:
                raise ValueError(
                    f"p10 ({self.p10}) must be <= p90 ({self.p90})"
                )
        if self.p10 is not None and self.p10 > self.p50:
            raise ValueError(f"p10 ({self.p10}) must be <= p50 ({self.p50})")
        if self.p90 is not None and self.p90 < self.p50:
            raise ValueError(f"p90 ({self.p90}) must be >= p50 ({self.p50})")
        return self


# ── Validation helpers ───────────────────────────────────────────────────


class ValidationError:
    """Structured validation error."""

    def __init__(self, field: str, message: str, value: Any = None):
        self.field = field
        self.message = message
        self.value = value

    def to_dict(self) -> Dict:
        d = {"field": self.field, "message": self.message}
        if self.value is not None:
            d["value"] = str(self.value)[:100]
        return d


def validate_forecast_payload(raw: Dict) -> List[Dict]:
    """
    Validate a raw forecast payload dict. Returns list of error dicts.
    Empty list = valid.
    """
    try:
        DemandForecastPayload(**raw)
        return []
    except Exception as e:
        return _pydantic_errors_to_dicts(e)


def validate_train_payload(raw: Dict) -> List[Dict]:
    """
    Validate a raw train payload dict. Returns list of error dicts.
    Empty list = valid.
    """
    try:
        TrainModelPayload(**raw)
        return []
    except Exception as e:
        return _pydantic_errors_to_dicts(e)


def validate_demand_points(points: List[Dict]) -> List[Dict]:
    """
    Validate a list of demand point dicts. Returns list of error dicts.
    Empty list = valid.
    """
    errors = []
    for i, pt in enumerate(points):
        try:
            DemandPointPayload(**pt)
        except Exception as e:
            for err in _pydantic_errors_to_dicts(e):
                err["index"] = i
                errors.append(err)
    return errors


def _pydantic_errors_to_dicts(exc: Exception) -> List[Dict]:
    """Convert pydantic ValidationError to list of error dicts."""
    from pydantic import ValidationError as PydanticValidationError

    if isinstance(exc, PydanticValidationError):
        return [
            {
                "field": ".".join(str(loc) for loc in e.get("loc", [])),
                "message": e.get("msg", str(e)),
                "type": e.get("type", "validation_error"),
            }
            for e in exc.errors()
        ]
    return [{"field": "unknown", "message": str(exc), "type": "error"}]
