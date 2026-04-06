"""
forecast_artifact_contract.py — Normalize forecast artifacts for workspace synthesis.

The API forecast contract covers /demand-forecast responses. This module covers
table artifacts emitted inside analysis pipelines so downstream synthesis can
interpret forecast magnitude, unit, and granularity consistently.
"""

from __future__ import annotations

from statistics import median
from typing import Any

import re

import pandas as pd


FORECAST_ARTIFACT_CONTRACT_VERSION = "1.0"

_COUNT_HINTS = ("qty", "quantity", "units", "unit", "demand", "volume", "order_quantity", "count", "數量")
_CURRENCY_HINTS = ("revenue", "sales", "amount", "gross_sales", "net_sales", "gmv", "spend", "cost", "營收", "金額")


def _slug(text: str) -> str:
    text = (text or "").strip().lower()
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return re.sub(r"_+", "_", text).strip("_")


def _display_name(text: str) -> str:
    return " ".join(part.capitalize() for part in _slug(text).split("_") if part)


def infer_forecast_measure_contract(source_measure_col: str) -> dict[str, Any]:
    measure_slug = _slug(source_measure_col)
    if any(hint in measure_slug for hint in _COUNT_HINTS):
        return {
            "measure_name": "demand_units",
            "measure_display_name": "Demand Units",
            "value_unit": "count",
        }
    if any(hint in measure_slug for hint in _CURRENCY_HINTS):
        return {
            "measure_name": "revenue",
            "measure_display_name": "Revenue",
            "value_unit": "currency",
        }
    return {
        "measure_name": measure_slug or "forecast_value",
        "measure_display_name": _display_name(source_measure_col or "Forecast Value"),
        "value_unit": "unknown",
    }


def infer_series_granularity(series_values: list[Any] | pd.Series | pd.Index, source_date_col: str = "") -> str:
    values = list(series_values) if series_values is not None else []
    parsed = pd.to_datetime(pd.Series(values), errors="coerce")
    valid = parsed.dropna().sort_values().drop_duplicates()

    if len(valid) >= 2:
        deltas = [
            float((valid.iloc[idx] - valid.iloc[idx - 1]).total_seconds() / 86400.0)
            for idx in range(1, len(valid))
            if (valid.iloc[idx] - valid.iloc[idx - 1]).total_seconds() > 0
        ]
        if deltas:
            step = median(deltas)
            if step <= 1.5:
                return "daily"
            if step <= 8:
                return "weekly"
            if step <= 31.5:
                return "monthly"
            if step <= 92:
                return "quarterly"
            if step <= 370:
                return "yearly"
            return "irregular"

    date_slug = _slug(source_date_col)
    if any(token in date_slug for token in ("yearmonth", "month", "period")):
        return "monthly"
    if any(token in date_slug for token in ("week", "weekly")):
        return "weekly"
    if any(token in date_slug for token in ("quarter", "qtr")):
        return "quarterly"
    if "year" in date_slug:
        return "yearly"
    if "date" in date_slug or "day" in date_slug:
        return "daily"
    return "unknown"


def build_forecast_artifact(
    *,
    predictions: list[float],
    p10: list[float] | None = None,
    p90: list[float] | None = None,
    model: str = "unknown",
    source_measure_col: str = "",
    source_date_col: str = "",
    history_index: list[Any] | pd.Series | pd.Index | None = None,
) -> dict[str, Any]:
    measure = infer_forecast_measure_contract(source_measure_col)
    granularity = infer_series_granularity(history_index, source_date_col=source_date_col)

    rows = []
    for idx, prediction in enumerate(predictions or []):
        row = {"day": idx + 1, "p50": round(float(prediction), 1)}
        if p10 and idx < len(p10):
            row["p10"] = round(float(p10[idx]), 1)
        if p90 and idx < len(p90):
            row["p90"] = round(float(p90[idx]), 1)
        rows.append(row)

    label_measure = measure["measure_display_name"] if measure["measure_display_name"] != "Forecast Value" else "Forecast"
    label = f"{len(rows)}-Step {label_measure} Forecast ({model})" if rows else f"Forecast ({model})"

    return {
        "type": "table",
        "label": label,
        "artifact_contract": "forecast_series_v1",
        "forecast_contract_version": FORECAST_ARTIFACT_CONTRACT_VERSION,
        "measure_name": measure["measure_name"],
        "measure_display_name": measure["measure_display_name"],
        "value_unit": measure["value_unit"],
        "value_semantics": "sum_per_period",
        "series_granularity": granularity,
        "source_measure_col": source_measure_col,
        "source_date_col": source_date_col,
        "quantiles": ["p10", "p50", "p90"],
        "model": model,
        "data": rows,
    }


def extract_forecast_contracts(all_artifacts: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    contracts = []
    for art in all_artifacts or []:
        if art.get("type") != "table":
            continue
        label = (art.get("label") or "").lower()
        if art.get("artifact_contract") != "forecast_series_v1" and "forecast" not in label:
            continue

        contracts.append({
            "label": art.get("label", ""),
            "artifact_contract": art.get("artifact_contract") or "",
            "forecast_contract_version": art.get("forecast_contract_version") or "",
            "measure_name": art.get("measure_name") or "",
            "measure_display_name": art.get("measure_display_name") or "",
            "value_unit": art.get("value_unit") or "",
            "value_semantics": art.get("value_semantics") or "",
            "series_granularity": art.get("series_granularity") or "",
            "source_measure_col": art.get("source_measure_col") or "",
            "source_date_col": art.get("source_date_col") or "",
            "model": art.get("model") or "",
            "row_count": len(art.get("data") or []),
        })

    return contracts


def build_forecast_contract_artifacts(forecast_contracts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not forecast_contracts:
        return []
    return [{
        "type": "table",
        "label": "Forecast Contract Summary",
        "data": forecast_contracts,
    }]


def forecast_contracts_to_markdown(forecast_contracts: list[dict[str, Any]]) -> str:
    if not forecast_contracts:
        return ""

    lines = ["## Forecast Contract"]
    for contract in forecast_contracts[:8]:
        lines.append(
            f"- {contract['label']}: measure={contract.get('measure_name') or 'unknown'}, "
            f"unit={contract.get('value_unit') or 'unknown'}, "
            f"granularity={contract.get('series_granularity') or 'unknown'}, "
            f"source_measure_col={contract.get('source_measure_col') or 'unknown'}"
        )
    return "\n".join(lines)
