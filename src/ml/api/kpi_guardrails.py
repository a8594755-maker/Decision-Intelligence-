"""
kpi_guardrails.py — Deterministic guardrails for KPI pipeline.

Three layers:
  1. KPI Minimum Spec: ensure required breakdowns exist, fill gaps deterministically
  2. Metric Contract Sanity Check: block contradictory canonical values
  3. Structural vs Problematic: classify benchmark deviations

Zero LLM calls. Pure Python.
"""

from __future__ import annotations

import logging
import math
from typing import Any

import pandas as pd

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════════
# Layer 1: KPI Minimum Spec
# ═══════════════════════════════════════════════════════════════════════════

# Required scalar KPIs — if column roles are detected, these must exist
REQUIRED_SCALARS = {
    "revenue": "total_revenue",
    "profit": "total_profit",
}

# Required breakdowns — for each dimension column that exists,
# compute these metrics via groupby
BREAKDOWN_METRICS = ["revenue", "profit", "margin_pct"]

# Dimension columns to check (by substring match in column name)
DIMENSION_HINTS = (
    "category", "sub_category", "segment", "region",
    "department", "channel", "ship_mode", "type",
)


def find_columns(df: pd.DataFrame) -> dict[str, str | None]:
    """Auto-detect revenue, profit, cost, discount columns by name."""
    roles: dict[str, str | None] = {
        "revenue": None, "profit": None, "cost": None, "discount": None,
    }
    for col in df.columns:
        cl = col.lower().strip()
        num = pd.to_numeric(df[col], errors="coerce")
        if num.notna().sum() < len(df) * 0.3:
            continue

        if not roles["revenue"] and any(kw in cl for kw in ("revenue", "sales", "gross_revenue")):
            roles["revenue"] = col
        elif not roles["profit"] and any(kw in cl for kw in ("profit", "net_income")):
            roles["profit"] = col
        elif not roles["cost"] and any(kw in cl for kw in ("cogs", "cost", "total_cost")):
            roles["cost"] = col
        elif not roles["discount"] and "discount" in cl:
            roles["discount"] = col

    return roles


def find_dimensions(df: pd.DataFrame) -> list[str]:
    """Find categorical dimension columns suitable for breakdowns."""
    dims = []
    for col in df.columns:
        cl = col.lower().strip()
        if not any(hint in cl for hint in DIMENSION_HINTS):
            continue
        if pd.api.types.is_numeric_dtype(df[col]):
            continue
        nunique = df[col].nunique()
        if 2 <= nunique <= 30:
            dims.append(col)
    return dims


def ensure_required_breakdowns(
    df: pd.DataFrame,
    existing_results: dict[str, Any],
    existing_artifacts: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Check if required breakdowns exist. Fill gaps deterministically.

    Returns (extra_results, extra_artifacts) to merge into KPI output.
    """
    from ml.api.metric_registry import build_semantic_breakdown_artifact

    roles = find_columns(df)
    dims = find_dimensions(df)
    rev_col = roles["revenue"]
    prof_col = roles["profit"]
    disc_col = roles["discount"]

    if not rev_col or not prof_col:
        return {}, []

    # Ensure numeric
    df = df.copy()
    df[rev_col] = pd.to_numeric(df[rev_col], errors="coerce").fillna(0)
    df[prof_col] = pd.to_numeric(df[prof_col], errors="coerce").fillna(0)
    if disc_col:
        df[disc_col] = pd.to_numeric(df[disc_col], errors="coerce").fillna(0)

    # Ensure scalar totals
    extra_results = {}
    if "total_revenue" not in existing_results or existing_results.get("total_revenue", 0) == 0:
        extra_results["total_revenue"] = round(float(df[rev_col].sum()), 2)
    if "total_profit" not in existing_results or existing_results.get("total_profit", 0) == 0:
        extra_results["total_profit"] = round(float(df[prof_col].sum()), 2)

    total_rev = float(df[rev_col].sum())
    if total_rev > 0 and ("gross_margin_pct" not in existing_results or existing_results.get("gross_margin_pct", 0) == 0):
        extra_results["gross_margin_pct"] = round(float(df[prof_col].sum()) / total_rev * 100, 2)

    # Ensure discount rate
    if disc_col and "effective_discount_rate" not in existing_results:
        disc_values = df[disc_col]
        if disc_values.max() <= 1.0:
            # Ratio column: revenue-weighted average
            extra_results["effective_discount_rate"] = round(
                float((df[disc_col] * df[rev_col]).sum() / max(total_rev, 1) * 100), 2
            )
        else:
            # Amount column: sum / revenue
            extra_results["effective_discount_rate"] = round(
                float(disc_values.sum() / max(total_rev, 1) * 100), 2
            )

    # Check existing breakdown labels
    existing_labels = set()
    for art in existing_artifacts:
        mid = (art.get("metric_id") or "").lower()
        dim = (art.get("dimension") or "").lower()
        if mid and dim:
            existing_labels.add((mid, dim))
        lbl = (art.get("label") or "").lower()
        if " by " in lbl:
            existing_labels.add(lbl)

    # Fill missing breakdowns
    extra_artifacts = []
    for dim_col in dims:
        dim_slug = dim_col.lower().strip().replace(" ", "_")

        # Margin by dimension
        if ("margin_pct", dim_slug) not in existing_labels:
            grouped = df.groupby(dim_col).agg(
                rev=(rev_col, "sum"), prof=(prof_col, "sum"),
            ).reset_index()
            margin_dict = {}
            for _, row in grouped.iterrows():
                rv = float(row["rev"])
                margin_dict[str(row[dim_col])] = round(float(row["prof"]) / max(rv, 0.01) * 100, 2)
            art = build_semantic_breakdown_artifact(
                f"profit_margin_by_{dim_slug}", margin_dict, label=f"Margin by {dim_col}",
            )
            if art:
                extra_artifacts.append(art)

    filled = len(extra_results) + len(extra_artifacts)
    if filled:
        logger.info(f"[KPIGuardrails] Filled {len(extra_results)} scalar gaps + {len(extra_artifacts)} breakdown gaps")

    return extra_results, extra_artifacts


# ═══════════════════════════════════════════════════════════════════════════
# Layer 2: Metric Contract Sanity Check
# ═══════════════════════════════════════════════════════════════════════════

def sanity_check_contract(metric_contract: dict[str, Any]) -> list[dict[str, Any]]:
    """Check metric contract for impossible values. Returns list of issues found + fixed."""
    issues = []
    scalars = metric_contract.get("scalar_metrics", [])

    # Index scalars by metric_id for cross-checks
    scalar_map = {m["metric_id"]: m for m in scalars}

    revenue = scalar_map.get("total_revenue", {}).get("value")
    profit = scalar_map.get("total_profit", {}).get("value")
    margin_pct = scalar_map.get("gross_margin_pct", {}).get("value")
    gross_margin = scalar_map.get("gross_margin", {}).get("value")

    # Check: revenue must be > 0 (if it exists)
    if revenue is not None and _safe(revenue) <= 0:
        issues.append({
            "severity": "critical",
            "code": "revenue_zero_or_negative",
            "metric_id": "total_revenue",
            "message": f"total_revenue = {revenue}, which is impossible for a dataset with transactions.",
        })

    # Check: margin_pct must be in [-100, 100]
    if margin_pct is not None and abs(_safe(margin_pct)) > 100:
        issues.append({
            "severity": "critical",
            "code": "margin_pct_out_of_range",
            "metric_id": "gross_margin_pct",
            "message": f"gross_margin_pct = {margin_pct}, which is outside [-100%, 100%].",
        })

    # Check: gross_margin must not equal revenue (unless margin is 100%)
    if gross_margin is not None and revenue is not None:
        gm = _safe(gross_margin)
        rev = _safe(revenue)
        if rev > 0 and gm > 0 and abs(gm - rev) / rev < 0.001:
            issues.append({
                "severity": "critical",
                "code": "gross_margin_equals_revenue",
                "metric_id": "gross_margin",
                "message": f"gross_margin ({gm:,.2f}) ≈ total_revenue ({rev:,.2f}). "
                           "This likely means a canonical value resolution error.",
            })

    # Check: profit should not be > revenue
    if profit is not None and revenue is not None:
        pr = _safe(profit)
        rev = _safe(revenue)
        if rev > 0 and pr > rev * 1.01:
            issues.append({
                "severity": "warning",
                "code": "profit_exceeds_revenue",
                "metric_id": "total_profit",
                "message": f"total_profit ({pr:,.2f}) > total_revenue ({rev:,.2f}). Check data integrity.",
            })

    # Check: scalar conflicts with >5x ratio between candidates
    for conflict in metric_contract.get("scalar_metric_conflicts", []):
        candidates = conflict.get("candidates", [])
        if len(candidates) >= 2:
            values = [_safe(c.get("value", 0)) for c in candidates if _safe(c.get("value", 0)) != 0]
            if values and max(values) / max(min(values), 0.01) > 5:
                issues.append({
                    "severity": "critical",
                    "code": "extreme_conflict_ratio",
                    "metric_id": conflict["metric_id"],
                    "message": f"Metric '{conflict['metric_id']}' has candidates differing by >5x: "
                               f"{[f'{v:,.2f}' for v in values]}. Canonical resolution may be wrong.",
                })

    if issues:
        logger.warning(f"[KPIGuardrails] Sanity check found {len(issues)} issues")

    return issues


# ═══════════════════════════════════════════════════════════════════════════
# Layer 3: Structural vs Problematic Classification
# ═══════════════════════════════════════════════════════════════════════════

# Metrics where large positive delta is just structure (biggest segment is always big)
_STRUCTURAL_METRICS = {"share_pct", "total_revenue", "total_orders", "units", "total_profit", "quantity"}

# Metrics where delta direction matters for business health
_RATE_METRICS = {"margin_pct", "gross_margin_pct", "on_time_rate", "fill_rate",
                 "effective_discount_rate_weighted", "avg_lead_time_days"}


def classify_deviation(item: dict[str, Any]) -> str:
    """Classify a scored benchmark deviation as structural, problematic, or neutral.

    Returns: "structural" | "problematic" | "neutral"
    """
    if item.get("type") != "breakdown_row":
        return "neutral"

    metric_id = item.get("metric_id", "")
    delta = item.get("delta", 0) or 0
    direction = item.get("direction", "unknown")

    # Share/volume metrics: being large is structural, not a problem
    if metric_id in _STRUCTURAL_METRICS:
        return "structural"

    # Rate/efficiency metrics: check direction
    if metric_id in _RATE_METRICS or "pct" in metric_id or "rate" in metric_id:
        if direction == "higher_better" and delta < 0:
            return "problematic"
        if direction == "lower_better" and delta > 0:
            return "problematic"
        return "neutral"

    # Unknown metrics: if is_bad flag is set, treat as problematic
    if item.get("is_bad"):
        return "problematic"

    return "neutral"


# ═══════════════════════════════════════════════════════════════════════════
# Layer 4: Cross-Sectional Variance Decomposition
# ═══════════════════════════════════════════════════════════════════════════

# Rate metrics where decomposition makes sense (metric = sum(x)/sum(y) by dimension)
_DECOMPOSABLE_RATE_METRICS = {"margin_pct", "gross_margin_pct", "profit_margin_pct"}
# Weight metrics used to compute revenue share for decomposition
_WEIGHT_METRIC_IDS = {"total_revenue", "sales", "revenue"}


def build_variance_decomposition(
    metric_contract: dict[str, Any],
) -> list[dict[str, Any]]:
    """Decompose overall rate metrics into dimensional contributions.

    For each rate breakdown (e.g., margin_pct by category), computes how much
    each dimension value contributes to the overall rate vs. the weighted average.

    Example output:
      Furniture margin 2.49%, revenue share 32.3% → drags overall margin by -3.22pp

    Pure deterministic. Zero LLM calls. Works for any dataset.
    Returns list of artifacts.
    """
    scalars = {m["metric_id"]: m for m in metric_contract.get("scalar_metrics", [])}
    breakdowns = metric_contract.get("breakdowns", [])
    artifacts = []

    for breakdown in breakdowns:
        metric_id = breakdown.get("metric_id", "")
        dimension = breakdown.get("dimension", "")
        rows = breakdown.get("rows", [])

        # Only decompose rate metrics with 3+ rows
        if metric_id not in _DECOMPOSABLE_RATE_METRICS:
            continue
        if len(rows) < 2:
            continue

        # Find the overall scalar for this metric
        overall_value = None
        for sid in (metric_id, "gross_margin_pct", "margin_pct"):
            if sid in scalars:
                overall_value = _safe(scalars[sid].get("value"))
                break
        if overall_value is None or overall_value == 0:
            continue

        # Find corresponding revenue/weight breakdown for the same dimension
        weight_breakdown = None
        for wb in breakdowns:
            if wb.get("dimension") != dimension:
                continue
            if wb.get("metric_id") in _WEIGHT_METRIC_IDS:
                weight_breakdown = wb
                break

        if not weight_breakdown or not weight_breakdown.get("rows"):
            continue

        # Build lookup: dimension_value → revenue
        revenue_map = {}
        total_weight = 0.0
        for wr in weight_breakdown["rows"]:
            dim_val = str(wr.get("dimension_value", ""))
            rev = _safe(wr.get("metric_value"))
            if rev > 0:
                revenue_map[dim_val] = rev
                total_weight += rev

        if total_weight <= 0:
            continue

        # Compute decomposition
        decomp_rows = []
        for row in rows:
            dim_val = str(row.get("dimension_value", ""))
            rate = _safe(row.get("metric_value"))
            rev = revenue_map.get(dim_val, 0)
            if rev <= 0:
                continue

            revenue_share = rev / total_weight * 100
            deviation = rate - overall_value
            contribution_pp = deviation * (rev / total_weight)

            decomp_rows.append({
                "dimension_value": dim_val,
                "metric_value": round(rate, 2),
                "revenue_share_pct": round(revenue_share, 2),
                "deviation_from_avg": round(deviation, 2),
                "contribution_pp": round(contribution_pp, 2),
            })

        if not decomp_rows:
            continue

        # Sort by contribution (most negative first = biggest drag)
        decomp_rows.sort(key=lambda r: r["contribution_pp"])

        # Calculate pct_of_gap for the negative contributors
        total_negative = sum(r["contribution_pp"] for r in decomp_rows if r["contribution_pp"] < 0)
        for r in decomp_rows:
            if total_negative < 0 and r["contribution_pp"] < 0:
                r["pct_of_drag"] = round(r["contribution_pp"] / total_negative * 100, 1)
            else:
                r["pct_of_drag"] = None

        display_name = breakdown.get("display_name", metric_id)
        artifacts.append({
            "type": "table",
            "label": f"{display_name} Contribution by {dimension.replace('_', ' ').title()}",
            "metric_id": f"{metric_id}_contribution",
            "dimension": dimension,
            "overall_value": overall_value,
            "data": decomp_rows,
        })

    if artifacts:
        logger.info(f"[KPIGuardrails] Built {len(artifacts)} variance decomposition artifacts")

    return artifacts


def _safe(value: Any) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        f = float(value)
        if not math.isnan(f) and not math.isinf(f):
            return f
    return 0.0
