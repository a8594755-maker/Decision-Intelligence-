"""
benchmark_policy.py — Deterministic comparison rules for dimensional breakdowns.

This removes benchmark choice from LLM free-form reasoning. The policy produces
one primary comparison rule per breakdown, so downstream writing stays consistent.
"""

from __future__ import annotations

from typing import Any
import statistics


def _safe_number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def _primary_method(valid_count: int) -> str:
    return "peer_median_excluding_self" if valid_count >= 3 else "peer_average_excluding_self"


def _benchmark_from_peers(values: list[float], method: str) -> float | None:
    if not values:
        return None
    if method == "peer_median_excluding_self":
        return float(statistics.median(values))
    return float(sum(values) / max(len(values), 1))


def build_benchmark_policy(metric_contract: dict[str, Any]) -> dict[str, Any]:
    comparisons = []

    for breakdown in metric_contract.get("breakdowns", []):
        valid_rows = [
            row for row in breakdown.get("rows", [])
            if _safe_number(row.get("metric_value")) is not None
        ]
        if len(valid_rows) < 2:
            continue

        method = _primary_method(len(valid_rows))
        comparison_rows = []
        for idx, row in enumerate(valid_rows):
            current_value = _safe_number(row.get("metric_value"))
            peers = [
                _safe_number(peer.get("metric_value"))
                for peer_idx, peer in enumerate(valid_rows)
                if peer_idx != idx
            ]
            peers = [value for value in peers if value is not None]
            benchmark_value = _benchmark_from_peers(peers, method)
            delta_abs = None
            delta_pct = None
            if current_value is not None and benchmark_value is not None:
                delta_abs = round(current_value - benchmark_value, 4)
                if benchmark_value not in (0, 0.0):
                    delta_pct = round(((current_value - benchmark_value) / abs(benchmark_value)) * 100, 2)
            comparison_rows.append({
                "dimension_value": row.get("dimension_value"),
                "metric_value": current_value,
                "benchmark_value": round(benchmark_value, 4) if benchmark_value is not None else None,
                "benchmark_type": method,
                "delta_vs_benchmark": delta_abs,
                "delta_pct_vs_benchmark": delta_pct,
                "preferred_direction": breakdown.get("preferred_direction", "unknown"),
            })

        comparisons.append({
            "breakdown_id": breakdown["breakdown_id"],
            "metric_id": breakdown["metric_id"],
            "display_name": breakdown["display_name"],
            "dimension": breakdown["dimension"],
            "policy": method,
            "preferred_direction": breakdown.get("preferred_direction", "unknown"),
            "rows": comparison_rows,
        })

    return {"comparisons": comparisons}


def build_benchmark_artifacts(benchmark_policy: dict[str, Any]) -> list[dict[str, Any]]:
    artifacts = []
    summary_rows = []

    for comparison in benchmark_policy.get("comparisons", []):
        summary_rows.append({
            "breakdown_id": comparison["breakdown_id"],
            "metric_id": comparison["metric_id"],
            "dimension": comparison["dimension"],
            "policy": comparison["policy"],
            "preferred_direction": comparison["preferred_direction"],
        })
        artifacts.append({
            "type": "table",
            "label": f"Benchmark Policy — {comparison['display_name']} by {comparison['dimension']}",
            "data": comparison["rows"],
        })

    if summary_rows:
        artifacts.insert(0, {
            "type": "table",
            "label": "Benchmark Policy Summary",
            "data": summary_rows,
        })

    return artifacts


def benchmark_policy_to_markdown(benchmark_policy: dict[str, Any]) -> str:
    lines = []
    comparisons = benchmark_policy.get("comparisons", [])
    if not comparisons:
        return ""

    lines.append("## Benchmark Policy")
    for comparison in comparisons[:12]:
        lines.append(
            f"- {comparison['display_name']} by {comparison['dimension']}: "
            f"use {comparison['policy']} as the ONLY primary benchmark."
        )
        for row in comparison["rows"][:6]:
            metric_value = row.get("metric_value")
            benchmark_value = row.get("benchmark_value")
            delta_abs = row.get("delta_vs_benchmark")
            lines.append(
                f"  {row.get('dimension_value')}: value={metric_value}, "
                f"benchmark={benchmark_value}, delta={delta_abs}"
            )
    return "\n".join(lines)
