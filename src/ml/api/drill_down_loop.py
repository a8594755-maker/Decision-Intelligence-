"""
drill_down_loop.py — Autonomous drill-down loop for Digital Worker.

After initial analysis, the agent automatically drills deeper into findings.
LLM judges what to investigate next. Engine executes deterministically.

Architecture:
  Round 1: Initial analysis (KPI + anomaly + forecast) — already done
  Round 2-N: LLM picks dimension to drill → engine does groupby → new artifacts
  Stop: LLM says DONE, or max rounds hit, or no new insights

LLM does: business judgment (~100 tokens per round)
Engine does: all computation (pandas groupby, cross-dimension, filtering)
Safety: max 5 rounds, max 60s total, max 20 artifacts
"""

from __future__ import annotations

import logging
import time
from typing import Any

import pandas as pd

logger = logging.getLogger(__name__)

# Hard safety limits
MAX_ROUNDS = 5
MAX_DURATION_S = 60
MAX_DRILL_ARTIFACTS = 20


def build_drill_context(
    all_artifacts: list[dict[str, Any]],
    drill_history: list[dict[str, Any]],
) -> str:
    """Build a compact summary of current findings for LLM to judge next step."""
    lines = []

    # Scalar KPIs
    for art in all_artifacts:
        if art.get("label", "").lower() == "overall kpis" and art.get("data"):
            row = art["data"][0] if art["data"] else {}
            kpi_parts = []
            for k, v in row.items():
                if isinstance(v, float):
                    kpi_parts.append(f"{k}={v:,.2f}")
                elif isinstance(v, (int, str)):
                    kpi_parts.append(f"{k}={v}")
            if kpi_parts:
                lines.append("KPIs: " + " | ".join(kpi_parts[:8]))
            break

    # Variance decomposition (contribution_pp)
    for art in all_artifacts:
        mid = (art.get("metric_id") or "").lower()
        if "contribution" in mid and art.get("data"):
            lines.append(f"\n{art.get('label', 'Contribution')}:")
            for row in art["data"][:5]:
                dim = row.get("dimension_value", "?")
                contrib = row.get("contribution_pp", 0)
                drag = row.get("pct_of_drag")
                drag_str = f" ({drag:.0f}% of drag)" if drag else ""
                lines.append(f"  {dim}: contribution={contrib:+.2f}pp{drag_str}")

    # Previous drill-down results
    if drill_history:
        lines.append(f"\nPrevious drill-downs ({len(drill_history)} rounds):")
        for d in drill_history:
            lines.append(f"  Round {d['round']}: drilled into {d['target']} → {d['summary']}")

    return "\n".join(lines)


DRILL_JUDGE_PROMPT = """You are an autonomous data analyst. You just completed an analysis round.

## Current Findings:
{context}

## Available dimensions to drill into:
{available_dimensions}

## Task:
Decide: should you drill deeper into a specific dimension, or is the analysis complete?

Rules:
- DRILL if there's a finding that needs decomposition (e.g., a category with low margin — drill into its sub-categories, customers, or regions)
- DRILL if you see a large contributor but don't know WHY (e.g., Central region is -0.99pp but you haven't seen its product mix)
- DONE if the root causes are already identified with enough specificity for action
- DONE if further drilling would add detail but not change the recommendation
- Do NOT drill into the same dimension twice

Respond with EXACTLY one line:
  DRILL: [dimension_name] — [reason in 10 words or less]
  DONE: [one-sentence summary of what you found]"""


async def run_drill_down_loop(
    df: pd.DataFrame,
    all_artifacts: list[dict[str, Any]],
    llm_call_fn,
    on_step=None,
) -> list[dict[str, Any]]:
    """Run autonomous drill-down loop.

    Args:
        df: Cleaned DataFrame (largest sheet)
        all_artifacts: Artifacts from initial analysis
        llm_call_fn: async fn(prompt, system) -> str
        on_step: SSE callback

    Returns:
        List of new drill-down artifacts to merge into all_artifacts.
    """
    # Find available dimensions and numeric columns
    cat_cols = [c for c in df.columns
                if not pd.api.types.is_numeric_dtype(df[c])
                and 2 <= df[c].nunique() <= 30]
    num_cols = [c for c in df.columns
                if pd.api.types.is_numeric_dtype(df[c])
                and not _is_id_or_date(c)]

    if not cat_cols or not num_cols:
        logger.info("[DrillDown] No dimensions or metrics to drill into")
        return []

    # Find revenue and profit columns for margin calculation
    rev_col = _find_col(df, ("revenue", "sales", "amount", "gross_revenue"))
    prof_col = _find_col(df, ("profit", "net_income"))

    drill_history: list[dict[str, Any]] = []
    drill_artifacts: list[dict[str, Any]] = []
    drilled_dims: set[str] = set()
    t0 = time.time()

    for round_num in range(1, MAX_ROUNDS + 1):
        # Safety checks
        if time.time() - t0 > MAX_DURATION_S:
            logger.info(f"[DrillDown] Stopping: time limit ({MAX_DURATION_S}s)")
            break
        if len(drill_artifacts) >= MAX_DRILL_ARTIFACTS:
            logger.info(f"[DrillDown] Stopping: artifact limit ({MAX_DRILL_ARTIFACTS})")
            break

        # Build context for LLM
        context = build_drill_context(all_artifacts + drill_artifacts, drill_history)
        available = [c for c in cat_cols if c not in drilled_dims]

        if not available:
            logger.info("[DrillDown] Stopping: no more dimensions to drill")
            break

        dims_str = ", ".join(available)
        prompt = DRILL_JUDGE_PROMPT.replace("{context}", context).replace("{available_dimensions}", dims_str)

        # LLM judges (~100 tokens)
        if on_step:
            await on_step({
                "type": "agent_status",
                "phase": f"drill_round_{round_num}",
                "status": "running",
                "model": "drill-down judge",
            })

        try:
            response = await llm_call_fn(prompt, "You are a data analyst deciding what to investigate next. Respond with one line only.")
            response = response.strip()
        except Exception as e:
            logger.warning(f"[DrillDown] LLM call failed: {e}")
            break

        logger.info(f"[DrillDown] Round {round_num}: {response}")

        # Parse response
        if response.upper().startswith("DONE"):
            summary = response.split(":", 1)[1].strip() if ":" in response else response
            drill_history.append({"round": round_num, "target": "DONE", "summary": summary})
            if on_step:
                await on_step({
                    "type": "agent_thinking",
                    "phase": f"drill_round_{round_num}",
                    "thinking": f"✅ **Investigation Complete**\n\n{summary}",
                })
                await on_step({"type": "agent_status", "phase": f"drill_round_{round_num}", "status": "done"})
            break

        if response.upper().startswith("DRILL"):
            # Parse: DRILL: dimension_name — reason
            parts = response.split(":", 1)[1].strip() if ":" in response else ""
            dim_name = parts.split("—")[0].strip().split("-")[0].strip() if parts else ""

            # Match to actual column name (fuzzy)
            target_col = _match_dimension(dim_name, available)
            if not target_col:
                logger.warning(f"[DrillDown] Could not match dimension '{dim_name}' to available: {available}")
                drill_history.append({"round": round_num, "target": dim_name, "summary": "dimension not found"})
                if on_step:
                    await on_step({
                        "type": "agent_thinking",
                        "phase": f"drill_round_{round_num}",
                        "thinking": f"⚠️ Could not find dimension '{dim_name}' — skipping.",
                    })
                continue

            drilled_dims.add(target_col)

            # Execute drill-down (deterministic)
            reason = parts.split("—")[1].strip() if "—" in parts else parts.split("-", 1)[1].strip() if "-" in parts else ""
            new_arts = _execute_drill(df, target_col, rev_col, prof_col, num_cols)
            drill_artifacts.extend(new_arts)

            # Build rich thinking text with results
            thinking_lines = [f"🔍 **Drilling into {target_col}** — {reason}"]
            summary = f"found {len(new_arts)} breakdowns"

            if new_arts and new_arts[0].get("data"):
                # Show top findings from the margin breakdown
                thinking_lines.append("")
                for art in new_arts:
                    if "Margin by" in art.get("label", "") and art.get("data"):
                        thinking_lines.append(f"**{art['label']}:**")
                        for row in art["data"][:5]:
                            dv = row.get("dimension_value", "?")
                            margin = row.get("margin_pct", "?")
                            contrib = row.get("contribution_pp")
                            rev = row.get("revenue", 0)
                            contrib_str = f", contribution={contrib:+.2f}pp" if contrib else ""
                            thinking_lines.append(f"  {dv}: margin={margin}%, revenue={rev:,.0f}{contrib_str}")
                        top_row = art["data"][0]
                        worst_val = top_row.get("dimension_value", "?")
                        worst_margin = top_row.get("margin_pct", "?")
                        summary = f"{worst_val} is worst at {worst_margin}% margin"
                        break

                # Show cross-dimension hotspots
                cross_arts = [a for a in new_arts if " × " in a.get("label", "")]
                if cross_arts:
                    thinking_lines.append("")
                    for ca in cross_arts[:2]:
                        thinking_lines.append(f"**{ca['label']}:**")
                        for row in ca["data"][:3]:
                            dv = row.get("dimension_value", "?")
                            margin = row.get("margin_pct", "?")
                            rev = row.get("revenue", 0)
                            thinking_lines.append(f"  {dv}: margin={margin}%, revenue={rev:,.0f}")

            drill_history.append({"round": round_num, "target": target_col, "summary": summary})

            if on_step:
                await on_step({
                    "type": "agent_thinking",
                    "phase": f"drill_round_{round_num}",
                    "thinking": "\n".join(thinking_lines),
                })

            if on_step:
                await on_step({
                    "type": "agent_status",
                    "phase": f"drill_round_{round_num}",
                    "status": "done",
                })
                for art in new_arts:
                    await on_step({
                        "type": "tool_finding",
                        "tool_id": f"drill_down_{target_col}",
                        "finding": f"{art.get('label', '')}: {len(art.get('data', []))} rows",
                    })
        else:
            # Unrecognized format — stop
            logger.warning(f"[DrillDown] Unrecognized response format: {response[:100]}")
            break

    elapsed = time.time() - t0
    logger.info(f"[DrillDown] Complete: {len(drill_history)} rounds, {len(drill_artifacts)} artifacts, {elapsed:.1f}s")

    # Add drill-down summary artifact
    if drill_history:
        drill_artifacts.append({
            "type": "summary",
            "label": "Drill-Down Investigation Log",
            "data": drill_history,
        })

    return drill_artifacts


def _execute_drill(
    df: pd.DataFrame,
    target_col: str,
    rev_col: str | None,
    prof_col: str | None,
    num_cols: list[str],
) -> list[dict[str, Any]]:
    """Execute deterministic drill-down on a dimension. Returns artifacts."""
    artifacts = []

    # 1. If we have revenue + profit, calculate margin by this dimension
    if rev_col and prof_col:
        grouped = df.groupby(target_col, dropna=False).agg(
            revenue=(rev_col, "sum"),
            profit=(prof_col, "sum"),
        ).reset_index()
        grouped["margin_pct"] = (grouped["profit"] / grouped["revenue"].clip(lower=0.01) * 100).round(2)
        total_rev = float(df[rev_col].sum())
        if total_rev > 0:
            grouped["revenue_share_pct"] = (grouped["revenue"] / total_rev * 100).round(2)
        overall_margin = float(df[prof_col].sum()) / max(float(df[rev_col].sum()), 0.01) * 100
        grouped["deviation_from_avg"] = (grouped["margin_pct"] - overall_margin).round(2)
        grouped["contribution_pp"] = (grouped["deviation_from_avg"] * grouped.get("revenue_share_pct", 0) / 100).round(2)
        grouped = grouped.sort_values("contribution_pp")

        rows = []
        for _, r in grouped.iterrows():
            rows.append({
                "dimension_value": str(r[target_col]),
                "revenue": round(float(r["revenue"]), 2),
                "profit": round(float(r["profit"]), 2),
                "margin_pct": float(r["margin_pct"]),
                "revenue_share_pct": float(r.get("revenue_share_pct", 0)),
                "contribution_pp": float(r["contribution_pp"]),
            })
        if rows:
            artifacts.append({
                "type": "table",
                "label": f"Drill-Down: Margin by {target_col}",
                "data": rows,
            })

    # 2. Cross-dimension: for the worst performer in this dimension,
    #    break it down by other categorical columns
    if rev_col and prof_col and artifacts and artifacts[0].get("data"):
        worst = artifacts[0]["data"][0]  # sorted by contribution_pp ascending
        worst_val = worst["dimension_value"]

        # Filter to worst performer
        subset = df[df[target_col].astype(str) == worst_val]
        if len(subset) >= 5:
            other_cats = [c for c in df.columns
                          if c != target_col
                          and not pd.api.types.is_numeric_dtype(df[c])
                          and 2 <= df[c].nunique() <= 20]

            for other_col in other_cats[:3]:  # max 3 cross-dimensions
                cross = subset.groupby(other_col, dropna=False).agg(
                    revenue=(rev_col, "sum"),
                    profit=(prof_col, "sum"),
                ).reset_index()
                cross["margin_pct"] = (cross["profit"] / cross["revenue"].clip(lower=0.01) * 100).round(2)
                cross = cross.sort_values("revenue", ascending=False)

                cross_rows = []
                for _, r in cross.head(10).iterrows():
                    cross_rows.append({
                        "dimension_value": str(r[other_col]),
                        "revenue": round(float(r["revenue"]), 2),
                        "profit": round(float(r["profit"]), 2),
                        "margin_pct": float(r["margin_pct"]),
                    })
                if cross_rows:
                    artifacts.append({
                        "type": "table",
                        "label": f"Drill-Down: {worst_val} ({target_col}) × {other_col}",
                        "data": cross_rows,
                    })

    # 3. Simple numeric summary by this dimension (for non-financial data)
    if not rev_col or not prof_col:
        for num_col in num_cols[:3]:
            grouped = df.groupby(target_col, dropna=False)[num_col].agg(["sum", "mean", "count"]).reset_index()
            grouped = grouped.sort_values("sum", ascending=False)
            rows = []
            for _, r in grouped.head(10).iterrows():
                rows.append({
                    "dimension_value": str(r[target_col]),
                    "total": round(float(r["sum"]), 2),
                    "average": round(float(r["mean"]), 2),
                    "count": int(r["count"]),
                })
            if rows:
                artifacts.append({
                    "type": "table",
                    "label": f"Drill-Down: {num_col} by {target_col}",
                    "data": rows,
                })

    return artifacts


def _is_id_or_date(col_name: str) -> bool:
    """Check if column is an ID or date column (not worth aggregating)."""
    cl = col_name.lower()
    return any(kw in cl for kw in ("_id", "id", "postal", "zip", "code", "index", "date", "day", "time"))


def _find_col(df: pd.DataFrame, keywords: tuple[str, ...]) -> str | None:
    """Find first column matching any keyword."""
    for col in df.columns:
        cl = col.lower().strip()
        if any(kw in cl for kw in keywords):
            num = pd.to_numeric(df[col], errors="coerce")
            if num.notna().sum() > len(df) * 0.5:
                return col
    return None


def _match_dimension(name: str, available: list[str]) -> str | None:
    """Fuzzy match LLM dimension name to actual column name."""
    def _norm(s: str) -> str:
        return s.lower().strip().replace(" ", "_").replace("-", "_")

    name_norm = _norm(name)

    # Exact match (normalized)
    for col in available:
        if _norm(col) == name_norm:
            return col

    # Substring match (normalized)
    for col in available:
        cn = _norm(col)
        if name_norm in cn or cn in name_norm:
            return col

    # Word overlap
    name_words = set(name_norm.split("_"))
    best_col = None
    best_score = 0
    for col in available:
        col_words = set(_norm(col).split("_"))
        overlap = len(name_words & col_words)
        if overlap > best_score:
            best_score = overlap
            best_col = col

    return best_col if best_score > 0 else None
