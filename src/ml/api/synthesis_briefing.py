"""
synthesis_briefing.py — Build role-specific, priority-ranked briefings for agents.

Replaces the old approach of dumping 3500 tokens of everything into every agent.
Each specialist gets only what it needs, sorted by importance, with [[ref]] IDs.

Architecture:
  metric_contract + benchmark_policy + forecast_contracts + validation_report
      ↓
  tag_metrics()         → adds role + priority_score to each metric
      ↓
  build_briefing()      → per-role filtered, sorted, markdown with [[ref]] IDs
      ↓
  resolve_references()  → replaces [[ref]] in agent prose with real numbers
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from typing import Any


# ── Metric Role Tagging ─────────────────────────────────────────────────

# These are not hardcoded column names — they're semantic categories
# derived from metric_id patterns that metric_registry already assigns.
_ROLE_PATTERNS: dict[str, list[str]] = {
    "financial": [
        "revenue", "profit", "margin", "discount", "cogs", "cost",
        "sales", "income", "expense", "budget",
    ],
    "operational": [
        "lead_time", "ship", "fulfillment", "delivery", "cycle_time",
        "processing", "on_time", "forecast", "demand", "unit",
        "quantity", "order", "item", "inventory", "stock", "supply",
    ],
    "risk": [
        "anomaly", "outlier", "stockout", "overdue", "variance",
        "deviation", "risk", "shortage",
    ],
}

# Risk sees everything that's a big outlier, regardless of category
_RISK_SEES_ALL_OUTLIERS = True


def _match_role(metric_id: str) -> str:
    """Assign a primary role to a metric based on its metric_id."""
    mid = (metric_id or "").lower()
    for role, patterns in _ROLE_PATTERNS.items():
        if any(pat in mid for pat in patterns):
            return role
    return "financial"  # default: financial sees unknowns


def _safe_float(value: Any) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        f = float(value)
        if not math.isnan(f) and not math.isinf(f):
            return f
    return 0.0


def _format_ref_value(value: Any) -> str:
    """Format a value for display when resolving references."""
    if isinstance(value, float):
        if abs(value) >= 1_000_000:
            return f"${value:,.0f}"
        elif abs(value) >= 1:
            return f"{value:,.2f}"
        else:
            return f"{value:.4f}"
    if isinstance(value, int):
        if abs(value) >= 10_000:
            return f"{value:,}"
        return str(value)
    return str(value)


# ── Priority Scoring ────────────────────────────────────────────────────

def compute_priority_scores(
    metric_contract: dict[str, Any],
    benchmark_policy: dict[str, Any],
) -> list[dict[str, Any]]:
    """Score every metric by how much attention it deserves.

    Score = abs(benchmark_delta) × revenue_weight.
    Metrics with no benchmark get a base score from their magnitude.
    Returns flat list of scored items (scalars + breakdown rows).
    """
    scored: list[dict[str, Any]] = []

    # Index scalar values for revenue weighting
    scalar_lookup: dict[str, Any] = {}
    for m in metric_contract.get("scalar_metrics", []):
        scalar_lookup[m["metric_id"]] = m

    total_revenue = _safe_float(scalar_lookup.get("total_revenue", {}).get("value"))

    # Score breakdown rows from benchmark policy (these have deltas)
    for comparison in benchmark_policy.get("comparisons", []):
        metric_id = comparison["metric_id"]
        dimension = comparison["dimension"]
        direction = comparison.get("preferred_direction", "unknown")

        peer_count = len(comparison.get("rows", []))

        for row in comparison.get("rows", []):
            dim_value = row.get("dimension_value", "?")
            metric_value = _safe_float(row.get("metric_value"))
            delta = _safe_float(row.get("delta_vs_benchmark"))
            delta_pct = _safe_float(row.get("delta_pct_vs_benchmark"))
            benchmark = _safe_float(row.get("benchmark_value"))

            # Revenue weight: if we have supporting revenue data, use it
            revenue_weight = 1.0
            for breakdown in metric_contract.get("breakdowns", []):
                if breakdown.get("dimension") != dimension:
                    continue
                if breakdown.get("metric_id") not in ("total_revenue", "sales"):
                    continue
                for brow in breakdown.get("rows", []):
                    if str(brow.get("dimension_value")) == str(dim_value):
                        rev = _safe_float(brow.get("metric_value"))
                        if total_revenue > 0 and rev > 0:
                            revenue_weight = rev / total_revenue

            # Priority = % deviation from benchmark × revenue weight
            # Use delta_pct (normalized) so margin delta and revenue delta are comparable
            pct_deviation = abs(delta_pct) if delta_pct else (abs(delta) / max(abs(benchmark), 0.01) * 100 if benchmark else 0)
            priority = pct_deviation * max(revenue_weight, 0.05)

            # Determine if this is "bad" based on preferred direction
            is_bad = False
            if direction == "higher_better" and delta < 0:
                is_bad = True
            elif direction == "lower_better" and delta > 0:
                is_bad = True

            # Bad metrics (wrong direction) get priority boost — problems > good news
            if is_bad:
                priority *= 1.5

            ref_id = f"{metric_id}:{dim_value}"

            # Layer 3: classify structural vs problematic
            item_for_classify = {
                "type": "breakdown_row", "metric_id": metric_id,
                "delta": delta, "direction": direction, "is_bad": is_bad,
            }
            from ml.api.kpi_guardrails import classify_deviation
            deviation_class = classify_deviation(item_for_classify)

            # Structural deviations (biggest segment is always big) get deprioritized
            if deviation_class == "structural":
                priority *= 0.01  # near zero — not a finding, just data structure

            scored.append({
                "ref_id": ref_id,
                "metric_id": metric_id,
                "dimension": dimension,
                "dimension_value": dim_value,
                "value": metric_value,
                "benchmark": benchmark,
                "delta": delta,
                "delta_pct": delta_pct,
                "direction": direction,
                "is_bad": is_bad,
                "revenue_weight": round(revenue_weight, 4),
                "priority_score": round(priority, 4),
                "role": _match_role(metric_id),
                "type": "breakdown_row",
                "peer_count": peer_count,
            })

    # Score scalar metrics (no delta, use magnitude or flag as context)
    for m in metric_contract.get("scalar_metrics", []):
        mid = m["metric_id"]
        value = _safe_float(m.get("value"))
        scored.append({
            "ref_id": mid,
            "metric_id": mid,
            "dimension": None,
            "dimension_value": None,
            "value": value,
            "benchmark": None,
            "delta": None,
            "delta_pct": None,
            "direction": m.get("preferred_direction", "unknown"),
            "is_bad": False,
            "revenue_weight": 1.0,
            "priority_score": 0.0,  # scalars are context, not findings
            "role": _match_role(mid),
            "type": "scalar",
            "display_name": m.get("display_name", mid),
            "unit": m.get("unit", "unknown"),
            "aggregation": m.get("aggregation", "unknown"),
            "definition": m.get("definition", ""),
        })

    # Sort by priority (highest first)
    scored.sort(key=lambda x: (-x["priority_score"], x["ref_id"]))
    return scored


# ── Causal Breakdown ────────────────────────────────────────────────────

def build_causal_context(
    scored_items: list[dict[str, Any]],
    metric_contract: dict[str, Any],
    top_n: int = 5,
) -> list[dict[str, Any]]:
    """For the top N outlier breakdown rows, find all other numeric columns
    for the same dimension value to provide causal explanation candidates.

    E.g., if Furniture margin is the #1 outlier, find Furniture's revenue,
    COGS, discount, quantity — whatever the data has.
    """
    # Get top N breakdown outliers
    outliers = [s for s in scored_items if s["type"] == "breakdown_row" and s["priority_score"] > 0][:top_n]

    causal_items = []
    for outlier in outliers:
        dim = outlier["dimension"]
        dim_val = str(outlier["dimension_value"])

        # Find all breakdowns with the same dimension
        supporting = {}
        for breakdown in metric_contract.get("breakdowns", []):
            if breakdown.get("dimension") != dim:
                continue
            bid = breakdown["metric_id"]
            if bid == outlier["metric_id"]:
                continue  # skip self
            for row in breakdown.get("rows", []):
                if str(row.get("dimension_value")) == dim_val:
                    val = row.get("metric_value")
                    if val is not None:
                        supporting[bid] = val

        if supporting:
            causal_items.append({
                "ref_id": outlier["ref_id"],
                "dimension_value": dim_val,
                "primary_metric": outlier["metric_id"],
                "primary_value": outlier["value"],
                "primary_delta": outlier["delta"],
                "explanation_candidates": supporting,
            })

    return causal_items


# ── Role-Based Briefing ─────────────────────────────────────────────────

def build_role_briefing(
    role: str,
    scored_items: list[dict[str, Any]],
    causal_context: list[dict[str, Any]],
    forecast_contracts: list[dict[str, Any]],
    validation_issues: list[dict[str, Any]],
    findings_chain: list[tuple[str, str]] | None = None,
) -> str:
    """Build a focused briefing for one specialist role.

    All numbers are real values (not placeholders). The agent copies them directly.
    """
    lines: list[str] = []

    # ── Scalars for this role ──
    role_scalars = [s for s in scored_items if s["type"] == "scalar" and s["role"] == role]
    if role_scalars:
        lines.append("## Key Metrics")
        lines.append("| Metric | Value | Unit |")
        lines.append("|--------|-------|------|")
        for s in role_scalars:
            lines.append(
                f"| {s.get('display_name', s['metric_id'])} | "
                f"{_format_ref_value(s['value'])} | {s.get('unit', '')} |"
            )

    # ── Top findings for this role (breakdown rows with priority) ──
    role_findings = [s for s in scored_items if s["type"] == "breakdown_row" and s["role"] == role and s["priority_score"] > 0]

    # Risk also sees all high-priority outliers regardless of role
    if role == "risk" and _RISK_SEES_ALL_OUTLIERS:
        all_outliers = [s for s in scored_items if s["type"] == "breakdown_row" and s["priority_score"] > 0]
        seen = {f["ref_id"] for f in role_findings}
        for item in all_outliers:
            if item["ref_id"] not in seen:
                role_findings.append(item)
                seen.add(item["ref_id"])
        role_findings.sort(key=lambda x: -x["priority_score"])

    if role_findings:
        lines.append("")
        lines.append("## Findings (sorted by importance — you MUST discuss the top 5)")
        for i, f in enumerate(role_findings[:15], 1):
            bad_marker = " ⚠️ PROBLEM" if f["is_bad"] else ""
            val_str = _format_ref_value(f["value"])
            delta_str = f", delta: {f['delta']:+.2f}" if f["delta"] else ""
            bench_str = f", benchmark: {_format_ref_value(f['benchmark'])}" if f["benchmark"] else ""
            lines.append(
                f"{i}. **{f['dimension_value']}** ({f['metric_id']}): "
                f"{val_str}{bench_str}{delta_str}{bad_marker}"
            )

    # ── Causal context for outliers ──
    role_causal = [c for c in causal_context
                   if any(f["ref_id"] == c["ref_id"] for f in role_findings[:5])]
    if role_causal:
        lines.append("")
        lines.append("## Explanation Candidates (use for causal reasoning — do NOT guess)")
        for c in role_causal:
            val_str = _format_ref_value(c["primary_value"])
            lines.append(f"\n**Why is {c['dimension_value']} {c['primary_metric']} = {val_str}?**")
            lines.append("Other data for this dimension:")
            for mid, val in c["explanation_candidates"].items():
                lines.append(f"  - {mid} = {_format_ref_value(val)}")

    # ── Forecast (operational only) ──
    if role == "operational" and forecast_contracts:
        lines.append("")
        lines.append("## Forecast Contract")
        for fc in forecast_contracts:
            lines.append(
                f"- {fc.get('label', 'Forecast')}: "
                f"measure={fc.get('measure_name', 'unknown')}, "
                f"unit={fc.get('value_unit', 'unknown')}, "
                f"granularity={fc.get('series_granularity', 'unknown')}"
            )

    # ── Validation warnings ──
    role_warnings = _filter_warnings_for_role(role, validation_issues)
    if role_warnings:
        lines.append("")
        lines.append("## Warnings")
        for w in role_warnings:
            lines.append(f"- [{w.get('severity', 'warning')}] {w.get('message', '')}")

    # ── Tool summaries ──
    if findings_chain:
        role_tools = _filter_tool_summaries_for_role(role, findings_chain)
        if role_tools:
            lines.append("")
            lines.append("## Tool Summaries")
            for tool_id, summary in role_tools:
                lines.append(f"\n### {tool_id}")
                lines.append(summary)

    return "\n".join(lines)


def _filter_warnings_for_role(role: str, issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Filter validation issues by relevance to role."""
    role_keywords = {
        "financial": ("revenue", "profit", "margin", "discount", "cost", "conflict", "ambig", "denominator"),
        "operational": ("lead_time", "forecast", "ship", "delivery", "empty_table", "granularity", "unit"),
        "risk": ("anomaly", "quarantine", "gap", "empty", "missing"),
    }
    keywords = role_keywords.get(role, ())
    result = []
    for issue in issues:
        msg = (issue.get("message", "") + issue.get("code", "")).lower()
        if any(kw in msg for kw in keywords):
            result.append(issue)
    # Risk sees all critical warnings
    if role == "risk":
        seen_msgs = {w["message"] for w in result}
        for issue in issues:
            if issue.get("severity") == "critical" and issue["message"] not in seen_msgs:
                result.append(issue)
    return result


def _filter_tool_summaries_for_role(
    role: str, findings_chain: list[tuple[str, str]],
) -> list[tuple[str, str]]:
    """Filter tool findings by relevance to role."""
    role_tools = {
        "financial": ("kpi", "variance", "cleaning"),
        "operational": ("forecast", "eda", "cleaning", "solver", "bom"),
        "risk": ("anomaly", "risk", "inventory"),
    }
    keywords = role_tools.get(role, ())
    result = []
    for tool_id, summary in findings_chain:
        if any(kw in tool_id.lower() for kw in keywords):
            if summary and summary.strip():
                result.append((tool_id, summary))
    return result


# ── Reference Resolution ────────────────────────────────────────────────

def build_reference_table(
    scored_items: list[dict[str, Any]],
    metric_contract: dict[str, Any],
) -> dict[str, str]:
    """Build a lookup table: ref_id → formatted display value.

    Covers both scalar refs (e.g., [[total_revenue]]) and
    breakdown refs (e.g., [[margin_pct:Furniture]]).
    """
    table: dict[str, str] = {}

    # Scalars
    for m in metric_contract.get("scalar_metrics", []):
        mid = m["metric_id"]
        table[mid] = _format_ref_value(m.get("value"))

    # Breakdown rows (from scored items which include benchmark data)
    for item in scored_items:
        if item["type"] == "breakdown_row":
            ref = item["ref_id"]
            table[ref] = _format_ref_value(item["value"])
            # Also register benchmark ref
            if item["benchmark"] is not None:
                table[f"{ref}:benchmark"] = _format_ref_value(item["benchmark"])
            if item["delta"] is not None:
                table[f"{ref}:delta"] = _format_ref_value(item["delta"])

    # Also index raw breakdown data from contract
    for breakdown in metric_contract.get("breakdowns", []):
        mid = breakdown["metric_id"]
        for row in breakdown.get("rows", []):
            dim_val = row.get("dimension_value", "")
            val = row.get("metric_value")
            if val is not None:
                ref = f"{mid}:{dim_val}"
                if ref not in table:
                    table[ref] = _format_ref_value(val)

    return table


def sanitize_output(text: str) -> str:
    """Safety net: strip any stray [[...]] or [UNRESOLVED: ...] from final output.

    Since agents now see real numbers (not placeholders), they should write
    real numbers. But if any [[...]] leak through, strip the brackets silently
    instead of showing broken output to the user.
    """
    # Strip [[ref_id]] → just show ref_id as plain text
    text = re.sub(r"\[\[([^\]]+)\]\]", r"\1", text)
    # Strip [UNRESOLVED: ...] → just show the content
    text = re.sub(r"\[UNRESOLVED:\s*([^\]]*)\]", r"\1", text)
    return text


# ── Key Metrics Table (system-generated, not LLM) ──────────────────────

def build_key_metrics_table(
    scored_items: list[dict[str, Any]],
    metric_contract: dict[str, Any],
) -> str:
    """Generate the Key Metrics markdown table deterministically.

    This replaces the LLM-generated Key Metrics section.
    """
    lines = ["| Metric | Value | vs Benchmark |"]
    lines.append("|--------|-------|-------------|")

    # Add scalar totals first
    for s in scored_items:
        if s["type"] != "scalar":
            continue
        if s["metric_id"] in ("total_revenue", "total_profit", "gross_margin_pct",
                              "total_cogs", "total_orders", "avg_lead_time_days"):
            name = s.get("display_name", s["metric_id"])
            val = _format_ref_value(s["value"])
            lines.append(f"| {name} | {val} | — |")

    # Add top 3 outlier findings — only with statistically meaningful benchmarks (3+ peers)
    outliers = [
        s for s in scored_items
        if s["type"] == "breakdown_row" and s["is_bad"]
        and s.get("benchmark") is not None
        and s.get("peer_count", 0) >= 3  # need 3+ data points for meaningful peer median
    ][:3]
    for o in outliers:
        name = f"{o['dimension_value']} {o['metric_id'].replace('_', ' ')}"
        val = _format_ref_value(o["value"])
        delta_str = f"{o['delta']:+.2f}" if o["delta"] is not None else "—"
        lines.append(f"| {name} | {val} | {delta_str} |")

    return "\n".join(lines)
