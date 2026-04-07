"""
metric_registry.py — Normalize KPI artifacts into a structured metric contract.

The contract sits between tool execution and synthesis so downstream agents
reason over explicit metric semantics instead of guessing from labels alone.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any
import math
import re


_SKIP_LABEL_PATTERNS = (
    "column mapping",
    "detection config",
    "verify",
    "audit",
    "cleaned_",
    "cleaning_log",
    "forecast contract",
)

_DATE_KEYWORDS = ("date", "day", "time", "timestamp", "datetime", "ship_date", "order_date", "deliver")
_ID_KEYWORDS = ("_id", "row_id", "order_id", "customer_id", "product_id", "postal", "zip", "code", "index")

_DIMENSION_HINTS = (
    "category",
    "sub_category",
    "segment",
    "region",
    "ship_mode",
    "ship mode",
    "department",
    "channel",
    "type",
    "supplier",
    "customer",
    "sku",
    "product",
)

_BREAKDOWN_META_KEYS = {
    "metric_id",
    "metric_display_name",
    "display_name",
    "metric_column",
    "unit",
    "aggregation",
    "definition",
    "numerator",
    "denominator",
    "preferred_direction",
    "scope",
    "source_metric_name",
}

_BREAKDOWN_METRIC_PRIORITY = (
    "margin_pct",
    "gross_margin_pct",
    "total_revenue",
    "revenue",
    "total_profit",
    "profit",
    "lead_time_days",
    "avg_lead_time_days",
    "actual_share_pct",
    "current_share_pct",
)

_GENERIC_VALUE_KEYS = {"value", "metric_value"}


def _slug(text: str) -> str:
    text = (text or "").strip().lower()
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return re.sub(r"_+", "_", text).strip("_")


_DIMENSION_HINT_SLUGS = {_slug(hint) for hint in _DIMENSION_HINTS}


def _display_name(text: str) -> str:
    return " ".join(part.capitalize() for part in _slug(text).split("_") if part)


def _format_value(value: Any) -> str:
    if isinstance(value, float):
        return f"{value:,.4f}" if abs(value) < 1 else f"{value:,.2f}"
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _safe_float(value: Any) -> float | None:
    if _is_number(value):
        return float(value)
    return None


def _should_skip_label(label: str) -> bool:
    label_lower = (label or "").lower()
    return any(pat in label_lower for pat in _SKIP_LABEL_PATTERNS)


_DERIVED_METRIC_SAFELIST = (
    "lead_time", "avg_lead_time", "cycle_time", "days_of_supply",
    "days_to_ship", "days_late", "delivery_days", "processing_time",
)


def _quarantine_reason(raw_name: str, value: Any) -> str | None:
    """Return a reason string if this metric should be quarantined, else None."""
    slug = _slug(raw_name)

    # Safelist: derived metrics that sound like dates but are real KPIs
    if any(safe in slug for safe in _DERIVED_METRIC_SAFELIST):
        return None

    # Date-sum: raw date column name + numeric value (summed dates are meaningless)
    if any(kw in slug for kw in _DATE_KEYWORDS):
        if _is_number(value):
            return "date_aggregation"

    # ID-sum: ID/code keyword (summed IDs are meaningless)
    if any(kw in slug for kw in _ID_KEYWORDS):
        return "id_aggregation"

    # NaN / inf slipped through
    if _is_number(value):
        fval = float(value)
        if math.isnan(fval) or math.isinf(fval):
            return "invalid_value"

    return None


def _infer_dimension(label: str, row: dict[str, Any]) -> str | None:
    label_lower = (label or "").lower()
    for hint in _DIMENSION_HINTS:
        if hint in label_lower:
            return hint.replace(" ", "_")

    row_keys = {_slug(k) for k in row.keys()}
    for candidate in (
        "category",
        "sub_category",
        "segment",
        "region",
        "ship_mode",
        "department",
        "channel",
        "type",
        "supplier",
        "customer",
        "sku",
        "product",
    ):
        if candidate in row_keys:
            return candidate

    if "name" in row_keys:
        return "name"
    return None


def _metric_family(metric_id: str) -> str:
    if "discount" in metric_id:
        return "discount_rate"
    if "margin" in metric_id:
        return "margin"
    if "lead_time" in metric_id:
        return "lead_time"
    return metric_id


def _metric_meta(raw_name: str, label: str = "", row_keys: set[str] | None = None) -> dict[str, Any]:
    raw_slug = _slug(raw_name)
    label_slug = _slug(label)
    joined = " ".join(filter(None, [raw_slug, label_slug]))
    row_keys = row_keys or set()

    # Per-unit / average metrics should NOT be mapped to aggregate metric_ids
    # e.g., "avg_revenue_per_order" is NOT "total_revenue"
    _is_per_unit = any(tok in raw_slug for tok in ("avg_", "per_", "mean_", "median_"))
    if _is_per_unit and not any(tok in raw_slug for tok in ("margin", "rate", "pct", "lead_time", "discount")):
        # This is a per-unit metric — give it its own metric_id, don't merge with totals
        return {
            "metric_id": raw_slug,
            "display_name": _display_name(raw_name),
            "unit": "currency" if any(tok in raw_slug for tok in ("revenue", "sales", "cost", "profit")) else "unknown",
            "aggregation": "mean_of_rows",
            "definition": f"Average metric: {raw_name}",
            "numerator": None,
            "denominator": None,
            "preferred_direction": "unknown",
        }

    if "effective_discount_rate" in joined or ("discount" in joined and "effective" in joined):
        return {
            "metric_id": "effective_discount_rate_weighted",
            "display_name": "Effective Discount Rate",
            "unit": "ratio",
            "aggregation": "ratio_of_sums",
            "definition": "total_discount / total_revenue",
            "numerator": "total_discount",
            "denominator": "total_revenue",
            "preferred_direction": "lower_better",
        }
    if (
        "avg_discount" in joined
        or "average_discount" in joined
        or ("discount" in joined and ("avg" in joined or "mean" in joined))
    ):
        return {
            "metric_id": "avg_discount_rate_unweighted",
            "display_name": "Average Discount Rate",
            "unit": "ratio",
            "aggregation": "mean_of_rows",
            "definition": "mean(row_discount_rate)",
            "numerator": "row_discount_rate",
            "denominator": None,
            "preferred_direction": "lower_better",
        }
    if raw_slug in {"discount_rate", "discount_pct"}:
        return {
            "metric_id": "discount_rate_ambiguous",
            "display_name": "Discount Rate",
            "unit": "ratio",
            "aggregation": "unknown",
            "definition": "Ambiguous discount metric — aggregation not explicit",
            "numerator": None,
            "denominator": None,
            "preferred_direction": "lower_better",
        }
    if "gross_margin_pct" in joined:
        return {
            "metric_id": "gross_margin_pct",
            "display_name": "Gross Margin %",
            "unit": "pct",
            "aggregation": "ratio_of_sums",
            "definition": "gross_margin / total_revenue * 100",
            "numerator": "gross_margin",
            "denominator": "total_revenue",
            "preferred_direction": "higher_better",
        }
    if "margin_pct" in joined or ("margin" in joined and "pct" in joined) or "profit_margin" in joined:
        return {
            "metric_id": "margin_pct",
            "display_name": "Margin %",
            "unit": "pct",
            "aggregation": "ratio_of_sums",
            "definition": "profit / revenue * 100",
            "numerator": "profit",
            "denominator": "revenue",
            "preferred_direction": "higher_better",
        }
    if "gross_margin" in joined or ("margin" in joined and "pct" not in joined):
        return {
            "metric_id": "gross_margin",
            "display_name": "Gross Margin",
            "unit": "currency",
            "aggregation": "sum",
            "definition": "total_revenue - total_cogs",
            "numerator": "total_revenue",
            "denominator": "total_cogs",
            "preferred_direction": "higher_better",
        }
    if "lead_time_by_ship_mode" in joined:
        return {
            "metric_id": "lead_time_days",
            "display_name": "Lead Time (Days)",
            "unit": "days",
            "aggregation": "mean_of_rows",
            "definition": "mean(ship_date - order_date)",
            "numerator": "days_between_ship_and_order",
            "denominator": None,
            "preferred_direction": "lower_better",
        }
    if "lead_time" in joined:
        return {
            "metric_id": "avg_lead_time_days",
            "display_name": "Average Lead Time (Days)",
            "unit": "days",
            "aggregation": "mean_of_rows",
            "definition": "mean(ship_date - order_date)",
            "numerator": "days_between_ship_and_order",
            "denominator": None,
            "preferred_direction": "lower_better",
        }
    if "revenue" in joined or raw_slug == "sales":
        return {
            "metric_id": "total_revenue",
            "display_name": "Revenue",
            "unit": "currency",
            "aggregation": "sum",
            "definition": "sum(net_revenue)",
            "numerator": "net_revenue",
            "denominator": None,
            "preferred_direction": "higher_better",
        }
    if "profit" in joined:
        return {
            "metric_id": "total_profit",
            "display_name": "Profit",
            "unit": "currency",
            "aggregation": "sum",
            "definition": "sum(profit)",
            "numerator": "profit",
            "denominator": None,
            "preferred_direction": "higher_better",
        }
    if "cogs" in joined or "cost" in joined:
        return {
            "metric_id": "total_cogs",
            "display_name": "COGS",
            "unit": "currency",
            "aggregation": "sum",
            "definition": "sum(cost_of_goods_sold)",
            "numerator": "cost_of_goods_sold",
            "denominator": None,
            "preferred_direction": "lower_better",
        }
    if "order" in joined and "avg" in joined and "value" in joined:
        return {
            "metric_id": "avg_order_value",
            "display_name": "Average Order Value",
            "unit": "currency",
            "aggregation": "ratio_of_sums",
            "definition": "total_revenue / total_orders",
            "numerator": "total_revenue",
            "denominator": "total_orders",
            "preferred_direction": "higher_better",
        }
    if "order" in joined and ("count" in joined or "total" in joined):
        return {
            "metric_id": "total_orders",
            "display_name": "Orders",
            "unit": "count",
            "aggregation": "count",
            "definition": "count(distinct_order_id)",
            "numerator": "distinct_order_id",
            "denominator": None,
            "preferred_direction": "higher_better",
        }
    if "quantity" in joined or "qty" in joined or "units" in joined:
        return {
            "metric_id": "units",
            "display_name": "Units",
            "unit": "count",
            "aggregation": "sum",
            "definition": "sum(quantity)",
            "numerator": "quantity",
            "denominator": None,
            "preferred_direction": "higher_better",
        }
    if "share" in joined:
        return {
            "metric_id": "share_pct",
            "display_name": "Share %",
            "unit": "pct",
            "aggregation": "ratio_of_sums",
            "definition": "dimension_total / grand_total * 100",
            "numerator": "dimension_total",
            "denominator": "grand_total",
            "preferred_direction": "higher_better",
        }
    if "anomaly" in joined and ("count" in joined or "total" in joined or raw_slug == "anomalies"):
        return {
            "metric_id": "anomaly_count",
            "display_name": "Anomaly Count",
            "unit": "count",
            "aggregation": "count",
            "definition": "count(flagged_rows)",
            "numerator": "flagged_rows",
            "denominator": None,
            "preferred_direction": "lower_better",
        }

    metric_id = raw_slug or "metric"
    return {
        "metric_id": metric_id,
        "display_name": _display_name(raw_name or label or metric_id),
        "unit": "unknown",
        "aggregation": "unknown",
        "definition": f"Derived from artifact field '{raw_name or label or metric_id}'",
        "numerator": None,
        "denominator": None,
        "preferred_direction": "unknown",
    }


def infer_metric_semantics(raw_name: str, label: str = "", row_keys: set[str] | None = None) -> dict[str, Any]:
    return _metric_meta(raw_name, label=label, row_keys=row_keys)


def infer_breakdown_spec(raw_name: str, label: str = "") -> dict[str, Any]:
    raw_slug = _slug(raw_name)
    metric_name = raw_name
    dimension = None

    if "_by_" in raw_slug:
        metric_part, dimension_part = raw_slug.rsplit("_by_", 1)
        if dimension_part in _DIMENSION_HINT_SLUGS:
            metric_name = metric_part or raw_name
            dimension = dimension_part

    pretty_label = label or ""
    meta = _metric_meta(metric_name, label=pretty_label or raw_name)
    dimension = dimension or _infer_dimension(pretty_label or raw_name, {dimension or "name": None}) or "name"

    return {
        **meta,
        "dimension": dimension,
        "label": pretty_label or f"{meta['display_name']} by {_display_name(dimension)}",
        "metric_column": meta["metric_id"],
        "source_metric_name": raw_name,
    }


def build_semantic_breakdown_artifact(raw_name: str, values: dict[Any, Any], label: str = "") -> dict[str, Any] | None:
    if not isinstance(values, dict) or not values:
        return None

    spec = infer_breakdown_spec(raw_name, label=label)
    dimension_key = spec["dimension"] or "name"
    metric_key = spec["metric_column"]
    rows = []

    for dim_value, metric_value in values.items():
        if isinstance(metric_value, (dict, list)):
            continue
        if metric_value is None:
            continue
        if isinstance(metric_value, float):
            metric_value = round(metric_value, 4)
        rows.append({
            dimension_key: dim_value,
            metric_key: metric_value,
        })

    if not rows:
        return None

    return {
        "type": "table",
        "label": spec["label"],
        "metric_id": spec["metric_id"],
        "metric_display_name": spec["display_name"],
        "metric_column": metric_key,
        "unit": spec["unit"],
        "aggregation": spec["aggregation"],
        "definition": spec["definition"],
        "numerator": spec["numerator"],
        "denominator": spec["denominator"],
        "preferred_direction": spec["preferred_direction"],
        "dimension": dimension_key,
        "source_metric_name": raw_name,
        "data": rows,
    }


def _is_scalar_artifact(label: str, data: list[dict[str, Any]]) -> bool:
    label_lower = (label or "").lower()
    looks_like_summary = (
        "overall" in label_lower
        or "kpi" in label_lower
        or label_lower.endswith("summary")
        or " summary" in label_lower
    )
    return (
        len(data) == 1
        and isinstance(data[0], dict)
        and looks_like_summary
        and "benchmark policy" not in label_lower
        and "metric contract" not in label_lower
        and "data gaps & warnings" not in label_lower
    )


def _extract_scalar_metrics(label: str, data: list[dict[str, Any]]) -> list[dict[str, Any]]:
    row = data[0]
    metrics = []
    for key, value in row.items():
        if value is None or isinstance(value, (dict, list)):
            continue
        # Enforce: scalar metric values must be numeric
        if not _is_number(value):
            continue
        meta = _metric_meta(key, label=label)
        entry = {
            **meta,
            "raw_name": key,
            "value": value,
            "scope": "overall",
            "source_artifact": label,
        }
        reason = _quarantine_reason(key, value)
        if reason:
            entry["quarantined"] = True
            entry["quarantine_reason"] = reason
        metrics.append(entry)
    return metrics


def _merge_artifact_metric_meta(artifact: dict[str, Any], meta: dict[str, Any]) -> dict[str, Any]:
    merged = dict(meta)
    if artifact.get("metric_id"):
        merged["metric_id"] = _slug(str(artifact.get("metric_id")))
    if artifact.get("metric_display_name"):
        merged["display_name"] = artifact.get("metric_display_name")
    for field in ("unit", "aggregation", "definition", "numerator", "denominator", "preferred_direction"):
        if artifact.get(field) is not None:
            merged[field] = artifact.get(field)
    return merged


def _metric_conflicts(left: Any, right: Any, unit: str) -> bool:
    if _is_number(left) and _is_number(right):
        abs_tol = 0.01 if unit in {"currency", "count", "days"} else 0.0001
        rel_tol = 1e-4
        return not math.isclose(float(left), float(right), rel_tol=rel_tol, abs_tol=abs_tol)
    return left != right


def _source_priority(label: str) -> int:
    """Lower number = higher trust. 'Overall KPIs' is the golden source."""
    label_lower = (label or "").lower()
    if "overall kpi" in label_lower:
        return 0  # LLM-computed or guardrail-filled KPIs — highest trust
    if "kpi" in label_lower:
        return 1
    if "summary" in label_lower and "margin" not in label_lower:
        return 2  # generic summaries, but not margin tables
    # Margin/revenue/cost calculation tables — they contain intermediate values
    # that may duplicate metrics like total_revenue. Lower priority.
    if "margin" in label_lower or "revenue" in label_lower or "cost" in label_lower:
        return 8
    return 5


def _canonicalize_scalar_metrics(scalars: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for metric in scalars:
        grouped[metric["metric_id"]].append(metric)

    canonical = []
    conflicts = []
    warnings = []

    for metric_id in sorted(grouped):
        if not grouped[metric_id]:
            continue

        candidates = sorted(
            grouped[metric_id],
            key=lambda item: (_source_priority(item.get("source_artifact", "")), item.get("source_artifact", "")),
        )
        chosen = dict(candidates[0])
        conflicting_candidates = [
            {
                "value": candidate.get("value"),
                "source_artifact": candidate.get("source_artifact"),
            }
            for candidate in candidates[1:]
            if _metric_conflicts(
                chosen.get("value"),
                candidate.get("value"),
                chosen.get("unit", "unknown"),
            )
        ]

        chosen["candidate_count"] = len(candidates)
        chosen["is_canonical"] = True
        canonical.append(chosen)

        if conflicting_candidates:
            conflict = {
                "metric_id": metric_id,
                "display_name": chosen.get("display_name"),
                "canonical_value": chosen.get("value"),
                "canonical_source": chosen.get("source_artifact"),
                "unit": chosen.get("unit"),
                "candidates": [
                    {
                        "value": candidate.get("value"),
                        "source_artifact": candidate.get("source_artifact"),
                    }
                    for candidate in candidates
                ],
            }
            conflicts.append(conflict)
            other_values = ", ".join(
                f"{entry['source_artifact']}={_format_value(entry['value'])}"
                for entry in conflicting_candidates
            )
            warnings.append({
                "severity": "critical",
                "code": "conflicting_metric_values",
                "metric_id": metric_id,
                "message": (
                    f"Metric '{metric_id}' has conflicting values across artifacts. "
                    f"Using canonical value {_format_value(chosen.get('value'))} from "
                    f"'{chosen.get('source_artifact')}'. Conflicting candidates: {other_values}."
                ),
            })

    return canonical, conflicts, warnings


def _numeric_keys_for_rows(data: list[dict[str, Any]], excluded: set[str]) -> dict[str, str]:
    key_lookup = {_slug(key): key for key in data[0].keys()}
    numeric_keys = {}
    for key_slug, original_key in key_lookup.items():
        if key_slug in excluded:
            continue
        if any(_is_number(row.get(original_key)) for row in data if isinstance(row, dict)):
            numeric_keys[key_slug] = original_key
    return numeric_keys


def _extract_breakdown(artifact: dict[str, Any]) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    data = artifact.get("data", [])
    label = artifact.get("label", "")
    warnings = []

    if not data or not isinstance(data[0], dict):
        return None, warnings

    row_keys = {_slug(k) for k in data[0].keys()}
    explicit_dimension = _slug(str(artifact.get("dimension") or "")) or None
    explicit_metric_id = _slug(str(artifact.get("metric_id") or "")) or None
    explicit_metric_column = _slug(str(artifact.get("metric_column") or "")) or None
    dimension = explicit_dimension or _infer_dimension(label, data[0])

    if not dimension and "name" not in row_keys:
        return None, warnings

    numeric_keys = _numeric_keys_for_rows(data, excluded={dimension or "", "name", *_BREAKDOWN_META_KEYS})
    metric_key = None
    meta = None

    if explicit_metric_id:
        meta = _merge_artifact_metric_meta(
            artifact,
            _metric_meta(explicit_metric_id, label=artifact.get("metric_display_name", label), row_keys=row_keys),
        )
        metric_key = explicit_metric_column if explicit_metric_column in numeric_keys else None
        if metric_key is None and meta["metric_id"] in numeric_keys:
            metric_key = meta["metric_id"]

    if meta is None:
        for candidate in _BREAKDOWN_METRIC_PRIORITY:
            if candidate in numeric_keys:
                metric_key = candidate
                break

        if metric_key is None and len(numeric_keys) == 1:
            metric_key = next(iter(numeric_keys))

        if metric_key is None and any(key in numeric_keys for key in _GENERIC_VALUE_KEYS):
            generic_key = next(key for key in _GENERIC_VALUE_KEYS if key in numeric_keys)
            inferred_meta = _metric_meta("", label=label, row_keys=row_keys)
            if inferred_meta["aggregation"] == "unknown" and inferred_meta["metric_id"] in {"metric", "value", "metric_value"}:
                warnings.append({
                    "severity": "critical",
                    "code": "ambiguous_generic_value_metric",
                    "source_artifact": label,
                    "message": (
                        f"Artifact '{label}' exposes a generic '{generic_key}' column without an explicit metric_id. "
                        "The breakdown was excluded from the metric contract."
                    ),
                })
                return None, warnings
            warnings.append({
                "severity": "warning",
                "code": "generic_value_metric",
                "source_artifact": label,
                "message": (
                    f"Artifact '{label}' uses a generic '{generic_key}' column. "
                    f"Metric semantics were inferred from the label as '{inferred_meta['metric_id']}'."
                ),
            })
            meta = inferred_meta
            metric_key = generic_key

        if meta is None:
            meta = _merge_artifact_metric_meta(
                artifact,
                _metric_meta(metric_key or "", label=artifact.get("metric_display_name", label), row_keys=row_keys),
            )

    actual_metric_column = numeric_keys.get(metric_key, metric_key)
    rows = []
    for row in data:
        if not isinstance(row, dict):
            continue

        dim_value = None
        for key, value in row.items():
            key_slug = _slug(key)
            if key_slug in {dimension, "name"}:
                dim_value = value
                break
        if dim_value is None:
            continue

        raw_metric_value = None
        if actual_metric_column:
            raw_metric_value = row.get(actual_metric_column)
        if raw_metric_value is None and metric_key in row:
            raw_metric_value = row.get(metric_key)

        supporting = {}
        for key, value in row.items():
            key_slug = _slug(key)
            if key_slug in {dimension, "name", metric_key} or key_slug in _BREAKDOWN_META_KEYS:
                continue
            if value is not None and not isinstance(value, (dict, list)):
                supporting[key_slug] = value

        rows.append({
            "dimension_value": dim_value,
            "metric_value": raw_metric_value,
            "supporting_metrics": supporting,
        })

    if not rows:
        return None, warnings

    return {
        "breakdown_id": f"{meta['metric_id']}__by__{dimension or 'name'}",
        "metric_id": meta["metric_id"],
        "display_name": meta["display_name"],
        "unit": meta["unit"],
        "aggregation": meta["aggregation"],
        "definition": meta["definition"],
        "numerator": meta["numerator"],
        "denominator": meta["denominator"],
        "preferred_direction": meta["preferred_direction"],
        "dimension": dimension or "name",
        "scope": f"by_{dimension or 'name'}",
        "source_artifact": label,
        "rows": rows,
    }, warnings


def build_metric_contract(all_artifacts: list[dict[str, Any]] | None) -> dict[str, Any]:
    scalar_candidates = []
    breakdowns = []
    warnings = []

    for art in all_artifacts or []:
        if art.get("type") != "table":
            continue
        label = art.get("label", "")
        if _should_skip_label(label):
            continue
        data = art.get("data", [])
        if not data or not isinstance(data, list) or not isinstance(data[0], dict):
            continue

        if _is_scalar_artifact(label, data):
            scalar_candidates.extend(_extract_scalar_metrics(label, data))
            continue

        breakdown, breakdown_warnings = _extract_breakdown(art)
        warnings.extend(breakdown_warnings)
        if breakdown:
            breakdowns.append(breakdown)

    scalar_metrics, scalar_conflicts, scalar_warnings = _canonicalize_scalar_metrics(scalar_candidates)
    warnings.extend(scalar_warnings)

    # Quarantine meaningless aggregates (date-sum, ID-sum, NaN/inf)
    clean_scalars = []
    quarantined = []
    for metric in scalar_metrics:
        if metric.get("quarantined"):
            quarantined.append(metric)
            warnings.append({
                "severity": "critical",
                "code": "quarantined_metric",
                "metric_id": metric["metric_id"],
                "message": (
                    f"Metric '{metric['metric_id']}' (raw: '{metric.get('raw_name', '')}') "
                    f"quarantined as '{metric['quarantine_reason']}'. "
                    "Do NOT use this value in analysis — it is not a business metric."
                ),
            })
        else:
            clean_scalars.append(metric)
    scalar_metrics = clean_scalars

    family_to_ids: dict[str, set[str]] = defaultdict(set)
    for metric in scalar_metrics:
        family_to_ids[_metric_family(metric["metric_id"])].add(metric["metric_id"])
    for breakdown in breakdowns:
        family_to_ids[_metric_family(breakdown["metric_id"])].add(breakdown["metric_id"])

    for family, metric_ids in sorted(family_to_ids.items()):
        if family == "discount_rate" and len(metric_ids) > 1:
            warnings.append({
                "severity": "warning",
                "code": "ambiguous_metric_family",
                "family": family,
                "metric_ids": sorted(metric_ids),
                "message": (
                    "Discount metrics use multiple aggregation methods. "
                    "Downstream analysis must cite the explicit metric_id, not a generic 'discount rate'."
                ),
            })
        if "discount_rate_ambiguous" in metric_ids:
            warnings.append({
                "severity": "critical",
                "code": "ambiguous_metric_name",
                "family": family,
                "metric_ids": sorted(metric_ids),
                "message": "An artifact exposed 'discount_rate' without an explicit aggregation definition.",
            })

    # Detect metrics that share a denominator — if multiple ratio metrics
    # reference the same base (e.g., "revenue") but define it differently,
    # flag as ambiguous.
    denominator_users: dict[str, list[str]] = defaultdict(list)
    for metric in scalar_metrics:
        denom = metric.get("denominator")
        if denom and metric.get("aggregation") == "ratio_of_sums":
            denominator_users[denom].append(metric["metric_id"])
    for breakdown in breakdowns:
        denom = breakdown.get("denominator")
        if denom and breakdown.get("aggregation") == "ratio_of_sums":
            denominator_users[denom].append(breakdown["metric_id"])

    for denom, users in denominator_users.items():
        if len(users) >= 2:
            warnings.append({
                "severity": "warning",
                "code": "shared_denominator_ambiguity",
                "message": (
                    f"Metrics {users} all divide by '{denom}'. "
                    f"Verify that '{denom}' has a single consistent definition "
                    f"(e.g., gross vs net) across all these metrics."
                ),
            })

    return {
        "scalar_metrics": scalar_metrics,
        "scalar_metric_candidates": scalar_candidates,
        "scalar_metric_conflicts": scalar_conflicts,
        "quarantined_metrics": quarantined,
        "breakdowns": breakdowns,
        "warnings": warnings,
    }


def build_metric_contract_artifacts(metric_contract: dict[str, Any]) -> list[dict[str, Any]]:
    artifacts = []

    scalar_rows = []
    for metric in metric_contract.get("scalar_metrics", []):
        scalar_rows.append({
            "metric_id": metric["metric_id"],
            "display_name": metric["display_name"],
            "value": metric["value"],
            "unit": metric["unit"],
            "aggregation": metric["aggregation"],
            "definition": metric["definition"],
            "scope": metric["scope"],
            "source_artifact": metric["source_artifact"],
            "candidate_count": metric.get("candidate_count", 1),
        })
    if scalar_rows:
        artifacts.append({
            "type": "table",
            "label": "Metric Contract — Scalars",
            "data": scalar_rows,
        })

    conflict_rows = []
    for conflict in metric_contract.get("scalar_metric_conflicts", []):
        conflict_rows.append({
            "metric_id": conflict["metric_id"],
            "canonical_value": conflict["canonical_value"],
            "canonical_source": conflict["canonical_source"],
            "candidate_values": "; ".join(
                f"{candidate['source_artifact']}={_format_value(candidate['value'])}"
                for candidate in conflict.get("candidates", [])
            ),
        })
    if conflict_rows:
        artifacts.append({
            "type": "table",
            "label": "Metric Contract — Scalar Conflicts",
            "data": conflict_rows,
        })

    breakdown_rows = []
    for breakdown in metric_contract.get("breakdowns", []):
        breakdown_rows.append({
            "breakdown_id": breakdown["breakdown_id"],
            "metric_id": breakdown["metric_id"],
            "dimension": breakdown["dimension"],
            "row_count": len(breakdown["rows"]),
            "aggregation": breakdown["aggregation"],
            "definition": breakdown["definition"],
            "preferred_direction": breakdown["preferred_direction"],
        })
    if breakdown_rows:
        artifacts.append({
            "type": "table",
            "label": "Metric Contract — Breakdowns",
            "data": breakdown_rows,
        })

    return artifacts


def metric_contract_to_markdown(metric_contract: dict[str, Any]) -> str:
    lines = []
    scalar_metrics = metric_contract.get("scalar_metrics", [])
    scalar_conflicts = metric_contract.get("scalar_metric_conflicts", [])
    breakdowns = metric_contract.get("breakdowns", [])
    warnings = metric_contract.get("warnings", [])

    if scalar_metrics:
        lines.append("## Metric Contract")
        lines.append("| Metric ID | Display | Value | Aggregation | Definition | Source |")
        lines.append("|-----------|---------|-------|-------------|------------|--------|")
        for metric in scalar_metrics[:20]:
            lines.append(
                f"| {metric['metric_id']} | {metric['display_name']} | {_format_value(metric['value'])} | "
                f"{metric['aggregation']} | {metric['definition']} | {metric.get('source_artifact', '')} |"
            )

    if scalar_conflicts:
        lines.append("")
        lines.append("## Canonical Metric Conflicts")
        for conflict in scalar_conflicts[:12]:
            candidate_text = ", ".join(
                f"{candidate['source_artifact']}={_format_value(candidate['value'])}"
                for candidate in conflict.get("candidates", [])
            )
            lines.append(
                f"- {conflict['metric_id']}: canonical={_format_value(conflict['canonical_value'])} "
                f"from {conflict['canonical_source']}; candidates: {candidate_text}"
            )

    if breakdowns:
        lines.append("")
        lines.append("## Structured Breakdowns")
        for breakdown in breakdowns[:12]:
            lines.append(
                f"- {breakdown['display_name']} by {breakdown['dimension']} "
                f"(metric_id={breakdown['metric_id']}, aggregation={breakdown['aggregation']}, "
                f"rows={len(breakdown['rows'])})"
            )

    quarantined = metric_contract.get("quarantined_metrics", [])
    if quarantined:
        lines.append("")
        lines.append("## Quarantined Metrics (DO NOT USE)")
        for metric in quarantined:
            lines.append(
                f"- {metric['metric_id']} (raw: '{metric.get('raw_name', '')}') — "
                f"reason: {metric.get('quarantine_reason', 'unknown')}. "
                "This is NOT a business metric."
            )

    if warnings:
        lines.append("")
        lines.append("## Metric Semantics Warnings")
        for warning in warnings:
            lines.append(f"- [{warning['severity']}] {warning['message']}")

    return "\n".join(lines).strip()
