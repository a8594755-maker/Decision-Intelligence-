"""
mbr_agent.py — MBR ReAct Agent v2

Architecture: Planner → Executor (context chain) → Synthesizer

Flow:
  1. Planner: LLM sees sheet metadata → decides which tools to run
  2. Executor: runs tools in order, each gets cumulative context from prior tools
  3. Synthesizer: LLM writes structured executive summary from findings chain
"""

import json
import time
import os
import logging
import concurrent.futures
import asyncio

import pandas as pd
import numpy as np
import httpx

logger = logging.getLogger(__name__)


# ================================================================
# Part 1: PLANNER
# ================================================================

PLANNER_SYSTEM_PROMPT = """You are the planning module of an MBR (Monthly Business Review) agent.

Your job: given a workbook's sheet metadata, decide which analysis tools to run and in what order.

## Available Tools

| tool_id            | requires                               |
|--------------------|----------------------------------------|
| data_cleaning      | any                                    |
| kpi_calculation    | any sheet with numeric amount/revenue  |
| margin_analysis    | revenue sheet + cost/inventory sheet   |
| variance_analysis  | revenue sheet + target/budget sheet    |
| anomaly_detection  | any numeric sheet                      |
| inventory_health   | inventory sheet with on_hand/stock     |
| supplier_analysis  | supplier/invoice sheet with amounts    |
| expense_analysis   | expense sheet with amounts             |

## Rules

1. ALWAYS run data_cleaning first.
2. ALWAYS run kpi_calculation if any revenue/sales/amount data exists.
3. Only run a tool if its required sheets are present. Do NOT guess.
4. variance_analysis depends on kpi_calculation — must run after it.
5. anomaly_detection runs last, AFTER kpi and variance.
6. Maximum 6 tools per run. Prioritize by business impact:
   Revenue KPIs > Margins > Target Variance > Inventory > Anomalies > Expenses

## Output Format

Return ONLY a JSON array of tool_id strings in execution order. No explanation.

Example: ["data_cleaning", "kpi_calculation", "margin_analysis", "variance_analysis", "anomaly_detection"]
"""

PLANNER_USER_TEMPLATE = """Workbook: {filename}
Sheets detected:
{sheet_summary}

Total rows: {total_rows}
"""


# ================================================================
# Part 1b: DETERMINISTIC PLANNER (no LLM)
# ================================================================

def plan_from_profile(profile):
    """
    Deterministic tool selection based on data profile.
    Runs AFTER cleaning (sees canonical sheet/column names).
    Returns (tool_list, reasoning_dict).

    Logic:
      - Always first: data_cleaning (already ran, included for completeness)
      - Has revenue columns in sales sheet → kpi_calculation
      - Has revenue + cost in same sheet → margin_analysis (via kpi)
      - Has target/budget sheet → variance_analysis
      - Has inventory sheet → inventory_health
      - Has supplier/invoice sheet → supplier_analysis
      - Has expense sheet → expense_analysis
      - Has BOM sheet → bom_explosion
      - Has date + enough data points (>=10) → forecast
      - Always last: anomaly_detection
    """
    from ml.api.kpi_calculator import _classify_sheet, _detect_role

    sheets = profile.get("sheets", {})
    if not sheets:
        return ["data_cleaning"], {"reason": "no sheets found"}

    # Classify all sheets
    sheet_types = {}
    sheet_roles = {}  # sheet → set of column roles
    for sn, sp in sheets.items():
        cols = sp.get("columns", {})
        sheet_types[sn] = _classify_sheet(sn, cols)
        roles = set()
        for col_info in cols.values():
            role = col_info.get("role", "unknown")
            if role not in ("unknown", "text"):
                roles.add(role)
        sheet_roles[sn] = roles

    has_sales = any(t == "sales" for t in sheet_types.values())
    has_target = any(t == "target" for t in sheet_types.values())
    has_inventory = any(t == "inventory" for t in sheet_types.values())
    has_supplier = any(t == "supplier" for t in sheet_types.values())
    has_expense = any(t == "expense" for t in sheet_types.values())
    has_bom = any(sn.lower() in ("bom_edges", "bom", "bill_of_materials") for sn in sheets)

    # Check for revenue in sales sheets (not expense amounts)
    has_revenue = False
    has_cost = False
    has_date = False
    date_points = 0
    for sn, sp in sheets.items():
        if sheet_types.get(sn) == "sales":
            roles = sheet_roles.get(sn, set())
            if "revenue" in roles:
                has_revenue = True
            if "cost" in roles:
                has_cost = True
            if "date" in roles:
                has_date = True
                date_points = sp.get("row_count", 0)

    # Build plan with reasoning
    plan = ["data_cleaning"]
    reasoning = {}

    if has_revenue:
        plan.append("kpi_calculation")
        reasoning["kpi_calculation"] = "sales sheet has revenue columns"
        if has_cost:
            # margin_analysis is handled inside kpi_calculation (gross_margin calculator)
            reasoning["margin_included"] = "cost columns found, margin will be computed in KPI"

    if has_revenue and has_target:
        plan.append("variance_analysis")
        reasoning["variance_analysis"] = "sales + target/budget sheets found"

    if has_inventory:
        plan.append("inventory_health")
        reasoning["inventory_health"] = "inventory sheet found"

    if has_supplier:
        plan.append("supplier_analysis")
        reasoning["supplier_analysis"] = "supplier/invoice sheet found"

    if has_expense:
        plan.append("expense_analysis")
        reasoning["expense_analysis"] = "expense sheet found"

    if has_bom and has_revenue:
        plan.append("bom_explosion")
        reasoning["bom_explosion"] = "BOM edges + sales demand found"

    if has_date and date_points >= 10 and has_revenue:
        plan.append("forecast")
        reasoning["forecast"] = f"time series data with {date_points} points"

    # Cap middle tools at 7, then always append anomaly last
    plan = plan[:7]

    # Always last: anomaly detection (sees everything)
    plan.append("anomaly_detection")
    reasoning["anomaly_detection"] = "always runs last"

    reasoning["total_tools"] = len(plan)
    reasoning["sheet_types"] = sheet_types

    return plan, reasoning


# ================================================================
# Part 2: TOOL OUTPUT SUMMARIZERS
# ================================================================

def summarize_tool_output(tool_id, result):
    """Convert structured tool output into concise text for downstream tools and synthesizer."""
    if not result:
        return f"{tool_id}: no results"

    # Helper: extract top rows from artifacts when summary_for_narrative is empty
    def _extract_from_artifacts(artifacts, max_tables=5, max_rows_per_table=5):
        lines = []
        for a in (artifacts or [])[:max_tables]:
            if a.get("type") != "table":
                continue
            label = a.get("label", "")
            if any(skip in label.lower() for skip in ("column mapping", "detection config", "verify")):
                continue
            data = a.get("data", [])
            if not data or not isinstance(data[0], dict):
                continue
            if len(data) == 1:
                row = data[0]
                vals = ", ".join(
                    f"{k}={v:,.2f}" if isinstance(v, float)
                    else f"{k}={v:,}" if isinstance(v, int)
                    else f"{k}={v}"
                    for k, v in row.items() if v is not None and k != "metric"
                )
                lines.append(f"{label}: {vals}")
            elif len(data) <= max_rows_per_table:
                lines.append(f"{label} ({len(data)} rows):")
                for row in data:
                    parts = [f"{k}={v:,.2f}" if isinstance(v, float) else f"{k}={v:,}" if isinstance(v, int) else f"{k}={v}" for k, v in list(row.items())[:6] if v is not None]
                    lines.append(f"  {' | '.join(parts)}")
            else:
                lines.append(f"{label} ({len(data)} rows, top 3):")
                for row in data[:3]:
                    parts = [f"{k}={v:,.2f}" if isinstance(v, float) else f"{k}={v:,}" if isinstance(v, int) else f"{k}={v}" for k, v in list(row.items())[:6] if v is not None]
                    lines.append(f"  {' | '.join(parts)}")
        return "\n".join(lines)

    if tool_id == "data_cleaning":
        n = result.get("sheets_cleaned", 0)
        rows = result.get("rows_after", 0)
        return f"Cleaned {n} sheets, {rows} rows after cleaning."

    elif tool_id == "kpi_calculation":
        summary = result.get("summary_for_narrative", "")
        if summary and len(summary) > 20:
            return summary[:800]

        lines = []
        # Core KPI metrics from result dict
        r = result.get("result", {})
        if r:
            parts = []
            for k, v in r.items():
                if isinstance(v, float):
                    parts.append(f"{k}: {v:,.2f}")
                elif isinstance(v, int):
                    parts.append(f"{k}: {v:,}")
            if parts:
                lines.append(" | ".join(parts[:8]))

        # Also extract target variance from artifacts (if present)
        for a in result.get("artifacts", []):
            label = (a.get("label") or "").lower()
            if "column mapping" in label or "verify" in label:
                continue
            data = a.get("data", [])
            if not data or not isinstance(data[0], dict):
                continue
            keys = set(data[0].keys())
            if "actual" in keys and "target" in keys:
                total_actual = sum(row.get("actual", 0) or 0 for row in data)
                total_target = sum(row.get("target", 0) or 0 for row in data)
                if total_target > 0:
                    pct = total_actual / total_target * 100
                    lines.append(f"Target attainment: {pct:.1f}% (actual={total_actual:,.0f} vs target={total_target:,.0f}, gap={total_actual - total_target:+,.0f})")
                    sorted_data = sorted(data, key=lambda row: row.get("variance", 0) or 0)
                    misses = [row for row in sorted_data if (row.get("variance", 0) or 0) < 0][:3]
                    if misses:
                        lines.append("Top misses:")
                        for row in misses:
                            ctx = " / ".join(str(v) for k, v in row.items() if k not in ("actual", "target", "variance", "variance_pct") and v is not None)[:60]
                            lines.append(f"  {ctx}: {row.get('variance_pct', 0):+.1f}% ({row.get('variance', 0):+,.0f})")
                break  # only need one target variance table

        if not lines:
            extracted = _extract_from_artifacts(result.get("artifacts", []))
            return extracted if extracted else "KPI calculation complete."
        return "\n".join(lines)

    elif tool_id == "margin_analysis":
        summary = result.get("summary_for_narrative", "")
        if summary and len(summary) > 20:
            return summary[:800]
        arts = result.get("artifacts", [])
        lines = []
        for a in arts[:5]:
            label = a.get("label", "").lower()
            if "column mapping" in label or "verify" in label:
                continue
            data = a.get("data", [])
            if not data or not isinstance(data[0], dict):
                continue
            if "overall" in label and "margin" in label and len(data) == 1:
                row = data[0]
                rev = row.get("total_revenue")
                cogs = row.get("total_cogs")
                margin = row.get("gross_margin")
                pct = row.get("margin_pct")
                if rev is not None:
                    lines.append(f"Overall: Revenue={rev:,.0f}, COGS={cogs:,.0f}, Margin={margin:,.0f} ({pct:.1f}%)")
            elif "margin by" in label:
                lines.append(f"{a['label']}:")
                for row in data[:5]:
                    group_key = next((f"{k}={v}" for k, v in row.items() if isinstance(v, str)), None)
                    pct = row.get("margin_pct")
                    rev = row.get("total_revenue")
                    if group_key and pct is not None:
                        lines.append(f"  {group_key}: margin={pct:.1f}%, revenue={rev:,.0f}")
        return "\n".join(lines) if lines else _extract_from_artifacts(arts) or "Margin analysis complete."

    elif tool_id == "variance_analysis":
        summary = result.get("summary_for_narrative", "")
        if summary and len(summary) > 20:
            return summary[:800]

        arts = result.get("artifacts", [])

        # Priority: target/actual variance first, then waterfall
        def _art_priority(a):
            label = (a.get("label") or "").lower()
            if "column mapping" in label or "verify" in label:
                return 99
            if "target" in label or "actual vs" in label:
                return 0
            if "variance" in label and "waterfall" not in label:
                return 1
            if "waterfall" in label and "summary" in label:
                return 2
            if "waterfall" in label:
                return 3
            if "contribution" in label:
                return 4
            if "drill" in label:
                return 5
            if "delta" in label:
                return 6
            return 7

        ordered_arts = sorted(arts, key=_art_priority)
        lines = []
        found_target_variance = False

        for a in ordered_arts[:6]:
            label = a.get("label", "").lower()
            if "column mapping" in label or "verify" in label:
                continue
            data = a.get("data", [])
            if not data or not isinstance(data[0], dict):
                continue

            first_row_keys = set(data[0].keys())
            is_target_variance = ("actual" in first_row_keys and "target" in first_row_keys)

            if is_target_variance and not found_target_variance:
                found_target_variance = True
                total_actual = sum(r.get("actual", 0) or 0 for r in data)
                total_target = sum(r.get("target", 0) or 0 for r in data)
                if total_target > 0:
                    lines.append(f"Overall target attainment: {total_actual / total_target * 100:.1f}% (actual={total_actual:,.0f} vs target={total_target:,.0f}, gap={total_actual - total_target:+,.0f})")
                sorted_data = sorted(data, key=lambda r: r.get("variance", 0) or 0)
                misses = [r for r in sorted_data if (r.get("variance", 0) or 0) < 0][:3]
                if misses:
                    lines.append("Top misses:")
                    for r in misses:
                        ctx = " / ".join(str(v) for k, v in r.items() if k not in ("actual", "target", "variance", "variance_pct") and v is not None)[:60]
                        lines.append(f"  {ctx}: {r.get('variance_pct', 0):+.1f}% ({r.get('variance', 0):+,.0f})")
                beats = [r for r in sorted_data[::-1] if (r.get("variance", 0) or 0) > 0][:2]
                if beats:
                    lines.append("Top beats:")
                    for r in beats:
                        ctx = " / ".join(str(v) for k, v in r.items() if k not in ("actual", "target", "variance", "variance_pct") and v is not None)[:60]
                        lines.append(f"  {ctx}: {r.get('variance_pct', 0):+.1f}% ({r.get('variance', 0):+,.0f})")

            elif "waterfall" in label and "summary" in label and len(lines) < 10:
                total_delta = next((r.get("value", 0) for r in data if str(r.get("component", "")).lower().startswith("total")), None)
                if total_delta is not None:
                    lines.append(f"MoM waterfall: total delta={total_delta:+,.0f}")
                    for r in data:
                        comp = r.get("component", "")
                        if "total" in comp.lower():
                            continue
                        val = r.get("value", 0)
                        if val and isinstance(val, (int, float)):
                            lines.append(f"  {comp}: {val:+,.0f}")

        return "\n".join(lines) if lines else _extract_from_artifacts(arts) or "Variance analysis complete."

    elif tool_id == "anomaly_detection":
        summary = result.get("summary_for_narrative", "")
        r = result.get("result", {})
        total = r.get("total_anomalies", 0)
        lines = []
        if total > 0:
            lines.append(f"Total anomalies: {total}")
        arts = result.get("artifacts", [])
        for a in arts[:5]:
            label = a.get("label", "").lower()
            data = a.get("data", [])
            if not data:
                continue
            if "summary" in label or "top" in label:
                for row in [r for r in data if r.get("severity") == "critical"][:5]:
                    col = row.get("column", "")
                    val = row.get("value", "")
                    z = row.get("z_score", "")
                    det = row.get("detector", "")
                    lines.append(f"[critical] {det}: {col}={val:,.1f} (z={z})" if isinstance(val, float) else f"[critical] {det}: {col}={val}")
                break
            elif "negative" in label:
                for row in data[:3]:
                    lines.append(f"[critical] negative_value: {row.get('column', '')}={row.get('value', '')}")
        if summary and len(summary) > 20 and not lines:
            return summary[:800]
        return "\n".join(lines) if lines else f"Found {total} anomalies."

    elif tool_id == "inventory_health":
        arts = result.get("artifacts", [])
        lines = []
        for a in arts:
            data = a.get("data", [])
            if not data:
                continue
            status_counts = {}
            for row in data:
                s = row.get("status", "unknown")
                status_counts[s] = status_counts.get(s, 0) + 1
            if status_counts:
                lines.append(f"Inventory status: {', '.join(f'{s}={c}' for s, c in sorted(status_counts.items()))} (total {len(data)} items)")
            for r in [r for r in data if r.get("status") == "critical"][:3]:
                sku = r.get("product_sku") or r.get("product_code") or r.get("product_name", "?")
                lines.append(f"  [critical] {sku}: qty_on_hand={r.get('qty_on_hand', '?')}")
            low = [r for r in data if r.get("status") == "low"]
            if low:
                lines.append(f"  {len(low)} items below safety stock")
        return "\n".join(lines) if lines else f"Inventory analysis: {len(arts)} tables."

    elif tool_id == "supplier_analysis":
        arts = result.get("artifacts", [])
        lines = []
        for a in arts[:3]:
            data = a.get("data", [])
            if not data or not isinstance(data[0], dict):
                continue
            label = a.get("label", "")
            if "status" in label.lower():
                lines.append("By payment status:")
                for row in data:
                    status = next((v for k, v in row.items() if "status" in k.lower()), None)
                    amt = next((v for k, v in row.items() if isinstance(v, (int, float)) and ("amount" in k.lower() or "total" in k.lower())), None)
                    if status and amt:
                        lines.append(f"  {status}: {amt:,.0f}")
            elif "supplier" in label.lower():
                total = sum(v for row in data for k, v in row.items() if isinstance(v, (int, float)) and "amount" in k.lower())
                lines.append(f"Total payable: {total:,.0f} across {len(data)} suppliers")
                if data:
                    name = next((v for k, v in data[0].items() if isinstance(v, str)), "?")
                    amt = next((v for k, v in data[0].items() if isinstance(v, (int, float))), 0)
                    lines.append(f"  Top: {name} ({amt:,.0f})")
        return "\n".join(lines) if lines else _extract_from_artifacts(arts) or "Supplier analysis complete."

    elif tool_id == "expense_analysis":
        arts = result.get("artifacts", [])
        lines = []
        for a in arts[:3]:
            data = a.get("data", [])
            if not data or not isinstance(data[0], dict):
                continue
            label = a.get("label", "")
            if "department" in label.lower() or "dept" in label.lower():
                total = sum(v for row in data for k, v in row.items() if isinstance(v, (int, float)) and ("amount" in k.lower() or "total" in k.lower()))
                lines.append(f"Total expenses: {total:,.0f}")
                lines.append("By department:")
                for row in data[:5]:
                    dept = next((v for k, v in row.items() if isinstance(v, str)), "?")
                    amt = next((v for k, v in row.items() if isinstance(v, (int, float)) and ("amount" in k.lower() or "total" in k.lower())), 0)
                    lines.append(f"  {dept}: {amt:,.0f}")
        return "\n".join(lines) if lines else _extract_from_artifacts(arts) or "Expense analysis complete."

    extracted = _extract_from_artifacts(result.get("artifacts", []))
    return extracted if extracted else f"{tool_id}: {len(result.get('artifacts', []))} artifacts."


# ================================================================
# Part 2b: TOOL DESCRIPTIONS & THINKING MESSAGES (for SSE progress)
# ================================================================

TOOL_DESCRIPTIONS = {
    "data_cleaning":     "Cleaning and validating raw data...",
    "kpi_calculation":   "Calculating revenue and operational KPIs...",
    "margin_analysis":   "Analyzing gross margins by category...",
    "variance_analysis": "Comparing actuals against targets...",
    "anomaly_detection": "Scanning for anomalies and data quality issues...",
    "inventory_health":  "Evaluating inventory coverage and stockout risks...",
    "supplier_analysis": "Reviewing supplier invoices and payables...",
    "expense_analysis":  "Summarizing expense reports by department...",
    "report_generation": "Building formatted Excel report...",
}

TOOL_THINKING_MESSAGES = {
    "data_cleaning": [
        "Scanning {n_sheets} sheets for data quality issues...",
        "Standardizing date formats and currencies...",
    ],
    "kpi_calculation": [
        "Processing {n_rows} records across {n_sheets} sheets...",
        "Aggregating revenue by month, region, category...",
    ],
    "margin_analysis": [
        "Joining unit costs from inventory data...",
        "Computing aggregate margin per category...",
    ],
    "variance_analysis": [
        "Matching target rows to actual performance...",
        "Identifying significant deviations (>15%)...",
    ],
    "anomaly_detection": [
        "Computing z-scores across numeric columns...",
        "Classifying anomalies: data quality vs business...",
    ],
    "inventory_health": [
        "Checking on-hand quantities against safety stock...",
        "Flagging critical and low-stock items...",
    ],
    "supplier_analysis": [
        "Aggregating invoice amounts by supplier...",
        "Checking payment status distribution...",
    ],
    "expense_analysis": [
        "Grouping expenses by department and type...",
        "Ranking top expense categories...",
    ],
    "report_generation": [
        "LLM selecting most important tables for report...",
        "Rendering Excel with charts and formatting...",
    ],
}


# ================================================================
# Part 3: TOOL EXECUTORS
# ================================================================

def _make_sync_llm_caller(llm_config):
    """Create a synchronous LLM caller for use inside sync tool pipelines.
    Uses httpx synchronous client to avoid event loop conflicts."""

    def sync_call(sys_prompt, usr_prompt, cfg):
        api_key = llm_config.get("api_key") or os.getenv("DEEPSEEK_API_KEY")
        base_url = llm_config.get("base_url") or os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
        model = llm_config.get("model", "deepseek-chat")

        if not api_key:
            raise ValueError("No API key for LLM")

        url = f"{base_url}/chat/completions"
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        payload = {
            "model": model,
            "temperature": 0.1,
            "max_tokens": 4000,
            "messages": [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": usr_prompt},
            ],
        }
        resp = httpx.post(url, json=payload, headers=headers, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"].get("content") or ""

    return sync_call


def _run_eda_full(sheets_data):
    """Full EDA: per-column stats, correlations, distributions, quality score."""
    artifacts = []
    result = {}

    for sheet_name, rows in sheets_data.items():
        if not rows:
            continue
        df = pd.DataFrame(rows)
        n_rows, n_cols = len(df), len(df.columns)

        # Per-column stats
        col_stats = []
        numeric_cols = []
        for col in df.columns:
            series = df[col]
            numeric = pd.to_numeric(series, errors="coerce")
            null_pct = round(float(series.isna().sum() / max(n_rows, 1) * 100), 1)

            if numeric.notna().sum() > n_rows * 0.5:
                valid = numeric.dropna()
                numeric_cols.append(col)
                col_stats.append({
                    "column": col, "type": "numeric",
                    "count": int(valid.count()),
                    "mean": round(float(valid.mean()), 2),
                    "std": round(float(valid.std()), 2),
                    "min": round(float(valid.min()), 2),
                    "q25": round(float(valid.quantile(0.25)), 2),
                    "median": round(float(valid.median()), 2),
                    "q75": round(float(valid.quantile(0.75)), 2),
                    "max": round(float(valid.max()), 2),
                    "null_pct": null_pct,
                    "skewness": round(float(valid.skew()), 2) if len(valid) > 2 else None,
                })
            else:
                unique = int(series.nunique())
                top_val = series.mode().iloc[0] if len(series.mode()) > 0 else None
                col_stats.append({
                    "column": col, "type": "text",
                    "unique": unique,
                    "top_value": str(top_val) if top_val is not None else None,
                    "null_pct": null_pct,
                })

        artifacts.append({
            "type": "table", "label": f"Column Statistics — {sheet_name}",
            "data": col_stats,
        })

        # Correlation matrix (numeric cols only, max 15)
        if len(numeric_cols) >= 2:
            num_df = df[numeric_cols[:15]].apply(pd.to_numeric, errors="coerce")
            corr = num_df.corr()
            corr_rows = []
            for c1 in corr.columns:
                for c2 in corr.columns:
                    if c1 < c2:
                        val = corr.loc[c1, c2]
                        if pd.notna(val) and abs(val) > 0.3:
                            corr_rows.append({
                                "column_1": c1, "column_2": c2,
                                "correlation": round(float(val), 3),
                                "strength": "strong" if abs(val) > 0.7 else "moderate",
                            })
            corr_rows.sort(key=lambda x: -abs(x["correlation"]))
            if corr_rows:
                artifacts.append({
                    "type": "table", "label": f"Notable Correlations — {sheet_name}",
                    "data": corr_rows[:20],
                })

        # Data quality score
        completeness = round((1 - df.isna().sum().sum() / max(n_rows * n_cols, 1)) * 100, 1)
        uniqueness = round(sum(df[c].nunique() / max(n_rows, 1) for c in df.columns) / max(n_cols, 1) * 100, 1)
        quality_score = round(completeness * 0.6 + min(uniqueness, 100) * 0.2 + (20 if numeric_cols else 10), 1)

        result[f"{sheet_name}_rows"] = n_rows
        result[f"{sheet_name}_cols"] = n_cols
        result[f"{sheet_name}_numeric_cols"] = len(numeric_cols)
        result[f"{sheet_name}_quality_score"] = min(quality_score, 100)

    summary = f"EDA: {len(sheets_data)} sheets profiled. " + ", ".join(
        f"{k}={v}" for k, v in result.items()
    )
    return {"result": result, "artifacts": artifacts, "summary_for_narrative": summary}


def _run_regression(sheets_data):
    """OLS regression with diagnostics, feature importance, VIF."""
    # Use the largest sheet
    sheet_name = max(sheets_data, key=lambda s: len(sheets_data[s])) if sheets_data else None
    if not sheet_name:
        return {"result": {}, "artifacts": [], "summary_for_narrative": "No data for regression."}

    df = pd.DataFrame(sheets_data[sheet_name])

    # Find numeric columns
    numeric_cols = []
    for col in df.columns:
        numeric = pd.to_numeric(df[col], errors="coerce")
        if numeric.notna().sum() > len(df) * 0.5:
            numeric_cols.append(col)

    if len(numeric_cols) < 2:
        return {"result": {}, "artifacts": [],
                "summary_for_narrative": f"Regression: need >= 2 numeric columns, found {len(numeric_cols)}."}

    # Auto-detect target: prefer revenue > profit > sales > last numeric col
    target_priority = [
        ("total_revenue", 0), ("total revenue", 0), ("revenue", 1), ("gross_revenue", 1),
        ("total_profit", 2), ("profit", 3), ("sales", 4), ("total_sales", 4),
    ]
    target_col = numeric_cols[-1]
    best_score = 99
    for col in numeric_cols:
        cl = col.lower().strip().replace(" ", "_")
        for kw, score in target_priority:
            if kw == cl or (len(kw) > 4 and kw in cl):
                if score < best_score:
                    best_score = score
                    target_col = col
                break
    feature_cols = [c for c in numeric_cols if c != target_col][:10]

    if not feature_cols:
        return {"result": {}, "artifacts": [],
                "summary_for_narrative": "Regression: need >= 1 feature column."}

    # Build numeric matrix
    num_df = df[feature_cols + [target_col]].apply(pd.to_numeric, errors="coerce").dropna()
    if len(num_df) < 5:
        return {"result": {}, "artifacts": [],
                "summary_for_narrative": f"Regression: only {len(num_df)} valid rows after cleaning."}

    X = num_df[feature_cols].values
    y = num_df[target_col].values
    n, p = X.shape

    # Add intercept
    ones = np.ones((n, 1))
    X_int = np.hstack([ones, X])

    # OLS: beta = (X'X)^-1 X'y
    try:
        XtX_inv = np.linalg.inv(X_int.T @ X_int)
        beta = XtX_inv @ (X_int.T @ y)
    except np.linalg.LinAlgError:
        return {"result": {}, "artifacts": [],
                "summary_for_narrative": "Regression: matrix is singular (perfect multicollinearity)."}

    y_hat = X_int @ beta
    residuals = y - y_hat
    ss_res = float(np.sum(residuals ** 2))
    ss_tot = float(np.sum((y - np.mean(y)) ** 2))
    r_squared = round(1 - ss_res / max(ss_tot, 1e-10), 4)
    adj_r_squared = round(1 - (1 - r_squared) * (n - 1) / max(n - p - 1, 1), 4)
    mse = round(ss_res / max(n - p - 1, 1), 2)

    # Standard errors + t-stats
    sigma2 = ss_res / max(n - p - 1, 1)
    se = np.sqrt(np.diag(XtX_inv) * sigma2)
    t_stats = beta / np.where(se > 0, se, 1)

    coef_names = ["intercept"] + feature_cols
    coefficients = []
    for i, name in enumerate(coef_names):
        coefficients.append({
            "feature": name,
            "coefficient": round(float(beta[i]), 4),
            "std_error": round(float(se[i]), 4),
            "t_statistic": round(float(t_stats[i]), 2),
        })

    # Feature importance (standardized absolute coefficients)
    if p > 0:
        x_std = np.std(X, axis=0)
        std_coefs = np.abs(beta[1:]) * x_std / max(np.std(y), 1e-10)
        total = np.sum(std_coefs)
        importance = []
        for i, col in enumerate(feature_cols):
            importance.append({
                "feature": col,
                "importance": round(float(std_coefs[i] / max(total, 1e-10) * 100), 1),
            })
        importance.sort(key=lambda x: -x["importance"])
    else:
        importance = []

    result = {
        "target": target_col,
        "features": feature_cols,
        "r_squared": r_squared,
        "adj_r_squared": adj_r_squared,
        "mse": mse,
        "n_observations": n,
        "n_features": p,
    }

    artifacts = [
        {"type": "table", "label": f"Regression: {target_col} ~ {', '.join(feature_cols[:5])}",
         "data": [result]},
        {"type": "table", "label": "Coefficients", "data": coefficients},
    ]
    if importance:
        artifacts.append({"type": "table", "label": "Feature Importance", "data": importance})

    summary = (f"Regression: {target_col} ~ {len(feature_cols)} features. "
               f"R²={r_squared}, Adj R²={adj_r_squared}, n={n}")

    return {"result": result, "artifacts": artifacts, "summary_for_narrative": summary}


async def _run_forecast_tool(sheets_data, prior_outputs):
    """Run demand forecast on time-series data from sheets."""
    from ml.demand_forecasting.forecaster_factory import ForecasterFactory
    from ml.api.forecast_artifact_contract import build_forecast_artifact

    # Find sheet with date + qty/revenue columns
    for sn, rows in sheets_data.items():
        if not rows:
            continue
        df = pd.DataFrame(rows)
        date_col = None
        qty_col = None
        for col in df.columns:
            cl = col.lower().strip().replace(" ", "_")
            # Date detection: "Order Date", "order_date", "Order YearMonth", "日期", "Date", "period"
            if any(kw in cl for kw in ("date", "order_date", "yearmonth", "year_month", "period", "month", "日期")):
                if not date_col:  # prefer first match (usually the most granular)
                    date_col = col
            # Qty detection: "Order Quantity", "qty", "units_sold", "demand", "數量"
            if any(kw in cl for kw in ("qty", "quantity", "units", "demand", "volume", "數量", "order_quantity")):
                qty_col = col
            if not qty_col and any(kw in cl for kw in ("revenue", "sales", "gross_sales", "amount", "營收")):
                qty_col = col

        if date_col and qty_col:
            df[qty_col] = pd.to_numeric(df[qty_col], errors="coerce").fillna(0)
            daily = df.groupby(date_col)[qty_col].sum().sort_index()
            history = daily.tolist()
            history_index = list(daily.index)

            if len(history) < 10:
                return {"result": {}, "artifacts": [],
                        "summary_for_narrative": f"Forecast: need >=10 data points, found {len(history)}."}

            factory = ForecasterFactory()
            result = factory.predict_with_fallback(
                sku="AGENT-FORECAST", erp_connector=None, horizon_days=7,
                preferred_model="auto", inline_history=history,
            )

            ok = result.get("success", False)
            pred_data = result.get("prediction", {})
            preds = pred_data.get("predictions", [])
            p10 = pred_data.get("p10", [])
            p90 = pred_data.get("p90", [])
            model = pred_data.get("model_used", result.get("model_used", "?"))
            forecast_artifact = build_forecast_artifact(
                predictions=preds,
                p10=p10,
                p90=p90,
                model=model,
                source_measure_col=qty_col,
                source_date_col=date_col,
                history_index=history_index,
            )
            measure_display_name = forecast_artifact.get("measure_display_name", "Forecast")
            unit = forecast_artifact.get("value_unit", "unknown")
            granularity = forecast_artifact.get("series_granularity", "unknown")
            summary = (
                f"Forecast ({model}): {len(preds)} {granularity} predictions for {measure_display_name} "
                f"[unit={unit}]. P50 range: {min(preds):.0f}-{max(preds):.0f}"
                if preds else "No predictions"
            )

            return {
                "result": {"model": model, "horizon": len(preds), "history_points": len(history),
                           "predictions": preds, "p10": p10, "p90": p90,
                           "measure_name": forecast_artifact.get("measure_name"),
                           "value_unit": unit,
                           "series_granularity": granularity,
                           "source_measure_col": qty_col,
                           "source_date_col": date_col},
                "artifacts": [forecast_artifact],
                "summary_for_narrative": summary,
            }

    return {"result": {}, "artifacts": [],
            "summary_for_narrative": "Forecast: no sheet with date + quantity columns found."}


async def _run_solver_tool(sheets_data, prior_outputs):
    """Run replenishment solver using forecast output + inventory data."""
    from datetime import datetime, timedelta

    # Get forecast from prior tool output
    forecast_result = prior_outputs.get("forecast", {})
    preds = forecast_result.get("result", {}).get("predictions", [])

    # Get inventory from sheets
    inv_sheet = None
    for sn, rows in sheets_data.items():
        if not rows:
            continue
        cols_lower = {c.lower().strip(): c for c in pd.DataFrame(rows).columns}
        if any(kw in " ".join(cols_lower.keys()) for kw in ("on_hand", "safety_stock", "stock", "inventory", "庫存")):
            inv_sheet = sn
            break

    if not inv_sheet:
        return {"result": {}, "artifacts": [],
                "summary_for_narrative": "Solver: no inventory sheet found."}

    inv_rows = sheets_data[inv_sheet]
    df = pd.DataFrame(inv_rows)

    # Simple heuristic solver (no need for full API call)
    plan_lines = []
    for _, row in df.iterrows():
        sku = str(row.get("product_code", row.get("物料編碼", row.get(df.columns[0], "?"))))
        on_hand = float(pd.to_numeric(row.get("on_hand_qty", row.get("在庫數量", 0)), errors="coerce") or 0)
        ss = float(pd.to_numeric(row.get("safety_stock", row.get("安全庫存", 0)), errors="coerce") or 0)
        moq = float(pd.to_numeric(row.get("moq", row.get("MOQ", 1)), errors="coerce") or 1)

        # Use forecast if available, else estimate from history
        if preds:
            daily_demand = sum(preds) / max(len(preds), 1)
        else:
            daily_demand = on_hand / 30 if on_hand > 0 else 10

        demand_7d = daily_demand * 7
        projected = on_hand - demand_7d
        if projected < ss:
            order = max(0, ss - projected + demand_7d)
            if 0 < order < moq:
                order = moq
            order = round(order, 0)
            plan_lines.append({
                "sku": sku, "on_hand": round(on_hand, 0),
                "safety_stock": round(ss, 0), "demand_7d": round(demand_7d, 0),
                "projected": round(projected, 0), "order_qty": order,
            })

    plan_lines.sort(key=lambda x: -x["order_qty"])
    total_orders = sum(p["order_qty"] for p in plan_lines)
    summary = f"Replenishment plan: {len(plan_lines)} order lines, total qty={total_orders:.0f}"

    return {
        "result": {"plan_lines": len(plan_lines), "total_order_qty": total_orders},
        "artifacts": [{"type": "table", "label": "Replenishment Plan", "data": plan_lines}],
        "summary_for_narrative": summary,
    }


def _run_risk_score_tool(sheets_data, prior_outputs):
    """Calculate risk scores from inventory + supplier data."""
    scores = []
    for sn, rows in sheets_data.items():
        if not rows:
            continue
        df = pd.DataFrame(rows)
        cols_lower = {c.lower().strip(): c for c in df.columns}

        on_hand_col = None
        for kw in ("on_hand_qty", "在庫數量", "on_hand", "stock", "inventory", "warehouse_inventory", "warehouse inventory"):
            if kw in cols_lower:
                on_hand_col = cols_lower[kw]
                break
        if not on_hand_col:
            continue

        ss_col = None
        for kw in ("safety_stock", "安全庫存", "reorder_point", "min_stock"):
            if kw in cols_lower:
                ss_col = cols_lower[kw]
                break

        cost_col = None
        for kw in ("unit_cost", "單位成本(usd)", "cost", "cost_per_unit", "inventory_cost", "inventory cost per unit"):
            if kw in cols_lower:
                cost_col = cols_lower[kw]
                break

        for _, row in df.iterrows():
            sku = str(row.get(df.columns[0], "?"))
            on_hand = float(pd.to_numeric(row.get(on_hand_col, 0), errors="coerce") or 0)
            ss = float(pd.to_numeric(row.get(ss_col, 0) if ss_col else 0, errors="coerce") or 0)
            cost = float(pd.to_numeric(row.get(cost_col, 10) if cost_col else 10, errors="coerce") or 10)

            coverage = on_hand / max(ss / 30, 0.01) if ss > 0 else 999
            p_stockout = max(0, min(1, 1 - coverage / 60))
            impact = max(ss, 1) * cost
            urgency = 1.5 if coverage < 14 else (1.2 if coverage < 30 else 1.0)
            score = round(p_stockout * impact * urgency, 2)
            tier = "HIGH" if score > 10000 else ("MEDIUM" if score > 1000 else "LOW")

            scores.append({"sku": sku, "on_hand": round(on_hand, 0), "safety_stock": round(ss, 0),
                           "coverage_days": round(coverage, 1), "p_stockout": round(p_stockout, 2),
                           "risk_score": score, "tier": tier})

    if not scores:
        return {"result": {}, "artifacts": [],
                "summary_for_narrative": "Risk: no inventory data with on_hand column found."}

    scores.sort(key=lambda x: -x["risk_score"])
    high = sum(1 for s in scores if s["tier"] == "HIGH")
    summary = f"Risk: {len(scores)} items scored, {high} HIGH risk"

    return {
        "result": {"total_scored": len(scores), "high_risk": high},
        "artifacts": [{"type": "table", "label": "Risk Scores", "data": scores}],
        "summary_for_narrative": summary,
    }


def _run_bom_tool(sheets_data):
    """BOM explosion — compute component demand from finished goods."""
    bom_rows = None
    sales_rows = None
    for sn, rows in sheets_data.items():
        if not rows:
            continue
        cols = [c.lower().strip() for c in pd.DataFrame(rows).columns]
        if any("parent" in c or "child" in c or "bom" in c for c in cols):
            bom_rows = rows
        elif any("qty" in c or "revenue" in c or "demand" in c for c in cols):
            if not sales_rows:
                sales_rows = rows

    if not bom_rows:
        return {"result": {}, "artifacts": [],
                "summary_for_narrative": "BOM: no BOM/bill-of-materials sheet found."}

    bom_df = pd.DataFrame(bom_rows)
    # Find parent/child/qty columns
    parent_col = child_col = qty_col = None
    for col in bom_df.columns:
        cl = col.lower().strip()
        if "parent" in cl:
            parent_col = col
        elif "child" in cl:
            child_col = col
        elif "qty_per" in cl or "quantity" in cl:
            qty_col = col

    if not parent_col or not child_col:
        return {"result": {}, "artifacts": [],
                "summary_for_narrative": "BOM: could not find parent/child columns."}

    # Get FG demand
    fg_demand = {}
    if sales_rows:
        sales_df = pd.DataFrame(sales_rows)
        for col in sales_df.columns:
            if "qty" in col.lower() or "quantity" in col.lower():
                for pc_col in sales_df.columns:
                    if "product" in pc_col.lower() or "sku" in pc_col.lower() or "code" in pc_col.lower():
                        sales_df[col] = pd.to_numeric(sales_df[col], errors="coerce").fillna(0)
                        fg_demand = sales_df.groupby(pc_col)[col].sum().to_dict()
                        break
                break

    # Explode BOM
    bom_index = {}
    for _, edge in bom_df.iterrows():
        parent = str(edge.get(parent_col, ""))
        if parent:
            bom_index.setdefault(parent, []).append(edge)

    component_map = {}
    def explode(mat, qty, path, depth):
        if depth > 50 or mat in path:
            return
        for edge in bom_index.get(mat, []):
            child = str(edge[child_col])
            qty_per = float(pd.to_numeric(edge.get(qty_col, 1), errors="coerce") or 1)
            scrap = float(pd.to_numeric(edge.get("scrap_rate", 0), errors="coerce") or 0)
            yld = max(float(pd.to_numeric(edge.get("yield_rate", 1), errors="coerce") or 1), 0.01)
            child_qty = qty * qty_per * (1 + scrap) / yld
            component_map[child] = component_map.get(child, 0) + child_qty
            explode(child, child_qty, path | {mat}, depth + 1)

    for sku, qty in fg_demand.items():
        if str(sku) in bom_index:
            explode(str(sku), qty, set(), 0)

    if not component_map and fg_demand:
        return {"result": {}, "artifacts": [],
                "summary_for_narrative": f"BOM: {len(fg_demand)} FGs found but no BOM edges match."}

    comp_table = sorted([{"component": k, "total_qty": round(v, 1)} for k, v in component_map.items()],
                        key=lambda x: -x["total_qty"])
    summary = f"BOM: {len(fg_demand)} FGs → {len(component_map)} components"

    return {
        "result": {"fg_count": len(fg_demand), "component_count": len(component_map)},
        "artifacts": [{"type": "table", "label": "Component Demand (BOM Explosion)", "data": comp_table}],
        "summary_for_narrative": summary,
    }


def _add_deterministic_breakdowns(sheets_data, arts, scalar_kpis):
    """Auto-generate groupby breakdowns for every (numeric, categorical) pair.

    Fully generalized: no hardcoded column names or metric types.
    For each categorical column (2-30 unique values) and each numeric column,
    computes sum-based groupby and emits a semantic artifact.
    Skips pairs already produced by the LLM KPI code path.
    """
    from ml.api.metric_registry import build_semantic_breakdown_artifact, _slug

    for sn, rows in sheets_data.items():
        if not rows or len(rows) < 5:
            continue
        df = pd.DataFrame(rows)

        # Identify categorical columns (2-30 unique, non-numeric)
        cat_cols = []
        for col in df.columns:
            if pd.api.types.is_numeric_dtype(df[col]):
                continue
            nunique = df[col].nunique()
            if 2 <= nunique <= 30:
                cat_cols.append(col)

        # Identify numeric columns (>50% parseable as number)
        num_cols = []
        for col in df.columns:
            numeric = pd.to_numeric(df[col], errors="coerce")
            if numeric.notna().sum() > len(df) * 0.5:
                num_cols.append(col)
                df[col] = numeric  # ensure numeric dtype

        if not cat_cols or not num_cols:
            continue

        # Collect existing (metric_id, dimension) from LLM-produced artifacts
        existing = set()
        for a in arts:
            mid = _slug(a.get("metric_id") or "")
            dim = _slug(a.get("dimension") or "")
            if mid and dim:
                existing.add((mid, dim))

        # For every (categorical, numeric) pair, compute groupby sum
        for cat_col in cat_cols:
            dim_slug = _slug(cat_col)
            for num_col in num_cols:
                metric_slug = _slug(num_col)
                breakdown_key = (metric_slug, dim_slug)
                if breakdown_key in existing:
                    continue

                grouped = df.groupby(cat_col)[num_col].sum()
                if grouped.abs().sum() < 1e-9:
                    continue  # all zeros, skip

                values = {str(k): round(float(v), 4) for k, v in grouped.items()}
                art = build_semantic_breakdown_artifact(
                    f"{metric_slug}_by_{dim_slug}", values,
                    label=f"{num_col} by {cat_col}",
                )
                if art:
                    arts.append(art)
                    existing.add(breakdown_key)

        break  # Only process the largest sheet


async def _execute_tool(tool_id, sheets_data, prior_outputs, llm_config):
    """Execute a single tool and return structured result."""
    sync_llm = _make_sync_llm_caller(llm_config)

    if tool_id == "data_cleaning":
        from ml.api.mbr_data_cleaning import execute_cleaning_pipeline
        result = await asyncio.to_thread(execute_cleaning_pipeline, sheets_data, call_llm_fn=sync_llm)
        cleaned = {}
        for art in result.get("artifacts", []):
            if art.get("type") == "table" and art.get("label", "").startswith("cleaned_"):
                sn = art["label"].replace("cleaned_", "")
                cleaned[sn] = art["data"]
        return {
            "cleaned_sheets": cleaned,
            "sheets_cleaned": len(cleaned),
            "rows_after": sum(len(v) for v in cleaned.values()),
            "artifacts": result.get("artifacts", []),
            "kpi_formula": result.get("kpi_formula", {}),
            "date_columns": result.get("date_columns", []),
        }

    elif tool_id == "kpi_calculation":
        # Try LLM code generation first, fall back to deterministic
        llm_kpi_result = None
        try:
            from ml.api.kpi_code_executor import calculate_kpis_with_llm_code
            # Use the largest (sales) sheet
            sheet_name = list(sheets_data.keys())[0]
            for sn in sheets_data:
                if len(sheets_data[sn]) > len(sheets_data.get(sheet_name, [])):
                    sheet_name = sn
            df = pd.DataFrame(sheets_data[sheet_name])
            date_cols = prior_outputs.get("data_cleaning", {}).get("date_columns", [])
            llm_kpi_result = await calculate_kpis_with_llm_code(df, sheet_name, llm_config, all_sheets=sheets_data, date_columns=date_cols)
        except Exception as ex:
            logger.warning(f"[MBR Agent] LLM KPI code generation failed: {ex}")

        if llm_kpi_result and llm_kpi_result.get("success"):
            kpi_results = llm_kpi_result["results"]
            audit = llm_kpi_result["audit"]
            from ml.api.metric_registry import build_semantic_breakdown_artifact

            # Separate scalar KPIs from dict breakdowns
            scalar_kpis = {}
            breakdown_arts = []
            for k, v in kpi_results.items():
                if isinstance(v, dict):
                    semantic_artifact = build_semantic_breakdown_artifact(k, v)
                    if semantic_artifact:
                        breakdown_arts.append(semantic_artifact)
                elif isinstance(v, (list, pd.Series)):
                    pass  # Skip arrays
                else:
                    scalar_kpis[k] = v

            # Build artifacts from LLM results
            arts = [{
                "type": "table",
                "label": "Overall KPIs",
                "data": [scalar_kpis],
            }]
            arts.extend(breakdown_arts)
            if audit:
                arts.append({
                    "type": "table",
                    "label": "KPI Calculation Audit",
                    "data": [{
                        "method": audit.get("method", ""),
                        "reasoning": audit.get("reasoning", ""),
                        "derivations": ", ".join(audit.get("derivations", [])),
                        "code": audit.get("code", "")[:500],
                        "execution_ms": audit.get("execution_time_ms", 0),
                    }],
                })
            # Deterministic category/segment/region breakdowns (guaranteed — doesn't rely on LLM)
            _add_deterministic_breakdowns(sheets_data, arts, scalar_kpis)

            # Also run deterministic pipeline for breakdowns (by category, trend, etc.)
            from ml.api.kpi_calculator import execute_kpi_pipeline
            kpi_formula = prior_outputs.get("data_cleaning", {}).get("kpi_formula")
            det_result = await asyncio.to_thread(
                execute_kpi_pipeline, sheets_data, call_llm_fn=sync_llm, kpi_formula=kpi_formula
            )
            # Merge: LLM results override summary, deterministic provides breakdowns
            merged_result = det_result.get("result", {})
            merged_result.update(kpi_results)
            all_arts = arts + det_result.get("artifacts", [])
            return {
                "result": merged_result,
                "summary_for_narrative": det_result.get("summary_for_narrative", ""),
                "artifacts": all_arts,
                "kpi_audit": audit,
            }
        else:
            # Fallback: deterministic pipeline
            logger.info("[MBR Agent] Using deterministic KPI pipeline (LLM code failed or unavailable)")
            from ml.api.kpi_calculator import execute_kpi_pipeline
            kpi_formula = prior_outputs.get("data_cleaning", {}).get("kpi_formula")
            result = await asyncio.to_thread(
                execute_kpi_pipeline, sheets_data, call_llm_fn=sync_llm, kpi_formula=kpi_formula
            )
            return {
                "result": result.get("result", {}),
                "summary_for_narrative": result.get("summary_for_narrative", ""),
                "artifacts": result.get("artifacts", []),
            }

    elif tool_id == "margin_analysis":
        # DON'T re-run kpi_calculator — extract margin artifacts from prior kpi_calculation
        kpi_result = prior_outputs.get("kpi_calculation", {})
        if kpi_result:
            margin_arts = [a for a in kpi_result.get("artifacts", [])
                           if any(kw in a.get("label", "").lower()
                                  for kw in ("margin", "cogs", "cost", "profit"))]
            margin_result = {k: v for k, v in kpi_result.get("result", {}).items()
                            if any(kw in k.lower() for kw in ("margin", "cogs", "profit"))}
            return {
                "result": margin_result,
                "summary_for_narrative": kpi_result.get("summary_for_narrative", ""),
                "artifacts": margin_arts,
            }
        # Fallback: run kpi_calculator only if kpi_calculation wasn't in the plan
        from ml.api.kpi_calculator import execute_kpi_pipeline
        result = await asyncio.to_thread(execute_kpi_pipeline, sheets_data, call_llm_fn=sync_llm)
        margin_arts = [a for a in result.get("artifacts", [])
                       if "margin" in a.get("label", "").lower()]
        return {
            "result": {k: v for k, v in result.get("result", {}).items() if "margin" in k.lower()},
            "summary_for_narrative": result.get("summary_for_narrative", ""),
            "artifacts": margin_arts or result.get("artifacts", []),
        }

    elif tool_id == "variance_analysis":
        from ml.api.variance_analyzer import execute_variance_pipeline
        result = await asyncio.to_thread(execute_variance_pipeline, sheets_data, call_llm_fn=sync_llm)
        return {
            "result": result.get("result", {}),
            "summary_for_narrative": result.get("summary_for_narrative", ""),
            "artifacts": result.get("artifacts", []),
        }

    elif tool_id == "anomaly_detection":
        from ml.api.anomaly_engine import AnomalyDetector, build_auto_config, profile_for_anomaly
        profile = profile_for_anomaly(sheets_data)
        config = build_auto_config(profile)
        dfs = {name: pd.DataFrame(data) for name, data in sheets_data.items() if data}
        detector = AnomalyDetector(dfs)
        result = detector.detect(config)
        return {
            "result": result.get("result", {}),
            "summary_for_narrative": result.get("summary_for_narrative", ""),
            "artifacts": result.get("artifacts", []),
        }

    elif tool_id == "inventory_health":
        # Deterministic — no LLM needed
        arts = _run_inventory_health(sheets_data)
        return {"artifacts": arts}

    elif tool_id == "supplier_analysis":
        arts = _run_supplier_analysis(sheets_data)
        return {"artifacts": arts}

    elif tool_id == "expense_analysis":
        arts = _run_expense_analysis(sheets_data)
        return {"artifacts": arts}

    elif tool_id == "eda":
        result = _run_eda_full(sheets_data)
        return result

    elif tool_id == "regression":
        result = _run_regression(sheets_data)
        return result

    elif tool_id == "forecast":
        result = await _run_forecast_tool(sheets_data, prior_outputs)
        return result

    elif tool_id == "replenishment_plan":
        result = await _run_solver_tool(sheets_data, prior_outputs)
        return result

    elif tool_id == "risk_score":
        result = _run_risk_score_tool(sheets_data, prior_outputs)
        return result

    elif tool_id == "bom_explosion":
        result = _run_bom_tool(sheets_data)
        return result

    return {"error": f"Unknown tool: {tool_id}"}


def _run_inventory_health(sheets_data):
    """Simple inventory health check — no LLM."""
    arts = []
    for sn, rows in sheets_data.items():
        df = pd.DataFrame(rows)
        cols_lower = {c.lower(): c for c in df.columns}
        on_hand_col = cols_lower.get("on_hand_qty") or cols_lower.get("qty_on_hand") or cols_lower.get("on_hand") or cols_lower.get("stock")
        if not on_hand_col:
            continue
        safety_col = cols_lower.get("safety_stock") or cols_lower.get("min_stock")
        df[on_hand_col] = pd.to_numeric(df[on_hand_col], errors="coerce")
        result_rows = []
        for _, row in df.iterrows():
            oh = row.get(on_hand_col, 0) or 0
            ss = row.get(safety_col, 0) or 0 if safety_col else 0
            status = "critical" if oh <= 0 else ("low" if oh < ss else "healthy")
            r = {c: row[c] for c in df.columns[:6] if pd.notna(row[c])}
            r["status"] = status
            result_rows.append(r)
        if result_rows:
            arts.append({"type": "table", "label": f"Inventory Health — {sn}", "data": result_rows})
    return arts


def _run_supplier_analysis(sheets_data):
    """Simple supplier analysis — no LLM."""
    arts = []
    for sn, rows in sheets_data.items():
        df = pd.DataFrame(rows)
        cols_lower = {c.lower(): c for c in df.columns}
        amount_col = cols_lower.get("amount") or cols_lower.get("total") or cols_lower.get("invoice_amount")
        supplier_col = cols_lower.get("supplier_name") or cols_lower.get("supplier") or cols_lower.get("vendor")
        status_col = cols_lower.get("status") or cols_lower.get("payment_status")
        if not amount_col or not supplier_col:
            continue
        df[amount_col] = pd.to_numeric(df[amount_col], errors="coerce")
        by_supplier = df.groupby(supplier_col)[amount_col].agg(["sum", "count"]).reset_index()
        by_supplier.columns = [supplier_col, "total_amount", "invoice_count"]
        by_supplier = by_supplier.sort_values("total_amount", ascending=False).round(2)
        arts.append({"type": "table", "label": f"Supplier Summary — {sn}", "data": by_supplier.to_dict("records")})
        if status_col:
            by_status = df.groupby(status_col)[amount_col].agg(["sum", "count"]).reset_index()
            by_status.columns = [status_col, "total_amount", "count"]
            by_status = by_status.round(2)
            arts.append({"type": "table", "label": f"Supplier by Status — {sn}", "data": by_status.to_dict("records")})
    return arts


def _run_expense_analysis(sheets_data):
    """Simple expense analysis — no LLM."""
    arts = []
    for sn, rows in sheets_data.items():
        df = pd.DataFrame(rows)
        cols_lower = {c.lower(): c for c in df.columns}
        amount_col = cols_lower.get("amount") or cols_lower.get("expense_amount") or cols_lower.get("total")
        dept_col = cols_lower.get("department") or cols_lower.get("dept")
        type_col = cols_lower.get("expense_type") or cols_lower.get("type") or cols_lower.get("category")
        if not amount_col:
            continue
        df[amount_col] = pd.to_numeric(df[amount_col], errors="coerce")
        if dept_col:
            by_dept = df.groupby(dept_col)[amount_col].agg(["sum", "count"]).reset_index()
            by_dept.columns = [dept_col, "total_amount", "count"]
            by_dept = by_dept.sort_values("total_amount", ascending=False).round(2)
            arts.append({"type": "table", "label": f"Expense by Department — {sn}", "data": by_dept.to_dict("records")})
        if type_col:
            by_type = df.groupby(type_col)[amount_col].agg(["sum", "count"]).reset_index()
            by_type.columns = [type_col, "total_amount", "count"]
            by_type = by_type.sort_values("total_amount", ascending=False).round(2)
            arts.append({"type": "table", "label": f"Expense by Type — {sn}", "data": by_type.to_dict("records")})
    return arts


# ================================================================
# Part 4: CONTEXT CHAIN (run_pipeline)
# ================================================================

async def run_pipeline(plan, cleaned_sheets, llm_config, on_step=None, sheet_meta=None):
    """Execute tools in planned order with cumulative context passing."""
    context = {
        "tool_outputs": {},
        "findings_chain": [],
        "all_artifacts": [],
    }
    current_sheets = cleaned_sheets
    n_sheets = len(current_sheets)
    n_rows = sum(len(v) for v in current_sheets.values()) if current_sheets else 0

    for tool_id in plan:
        if tool_id == "data_cleaning":
            continue  # Already run before pipeline

        step_start = time.time()
        if on_step:
            await on_step({
                "type": "tool_start",
                "tool_id": tool_id,
                "description": TOOL_DESCRIPTIONS.get(tool_id, f"Running {tool_id}..."),
            })

        try:
            # Emit thinking messages before execution
            if on_step:
                msgs = TOOL_THINKING_MESSAGES.get(tool_id, [])
                for msg in msgs[:2]:
                    formatted = msg.format(n_rows=n_rows, n_sheets=n_sheets)
                    await on_step({
                        "type": "tool_thinking",
                        "tool_id": tool_id,
                        "detail": formatted,
                    })
                    await asyncio.sleep(0.05)

            result = await _execute_tool(tool_id, current_sheets, context["tool_outputs"], llm_config)
            duration_ms = int((time.time() - step_start) * 1000)

            context["tool_outputs"][tool_id] = result

            # Build concise text summary for downstream
            summary_text = summarize_tool_output(tool_id, result)
            context["findings_chain"].append((tool_id, summary_text))

            # Collect artifacts
            if result.get("artifacts"):
                context["all_artifacts"].extend(result["artifacts"])

            logger.info(f"[MBR Pipeline] {tool_id} done ({duration_ms}ms): {summary_text[:100]}")

            # Emit key findings (up to 2 lines)
            if on_step and summary_text:
                for line in summary_text.split("\n")[:2]:
                    line = line.strip()
                    if line and line != f"{tool_id}: no results":
                        await on_step({
                            "type": "tool_finding",
                            "tool_id": tool_id,
                            "finding": line[:200],
                        })

            if on_step:
                await on_step({
                    "type": "tool_done",
                    "tool_id": tool_id,
                    "duration_ms": duration_ms,
                    "status": "success",
                    "findings_count": len(summary_text.split("\n")) if summary_text else 0,
                })

        except Exception as e:
            duration_ms = int((time.time() - step_start) * 1000)
            error_msg = str(e)[:300]
            logger.error(f"[MBR Pipeline] {tool_id} failed: {error_msg}")
            context["findings_chain"].append((tool_id, f"ERROR: {error_msg}"))

            if on_step:
                await on_step({
                    "type": "tool_error",
                    "tool_id": tool_id,
                    "error": error_msg,
                    "recoverable": True,
                    "duration_ms": duration_ms,
                })

    return context


# ================================================================
# Part 5: SYNTHESIZER
# ================================================================

SYNTHESIZER_SYSTEM_PROMPT = """You are the executive summary writer for a Monthly Business Review (MBR) report.

You receive structured findings from multiple analysis tools. Write a concise, actionable summary
that a business leader can read in under 2 minutes.

## MANDATORY Structure (skip a section ONLY if the tool was not run)

### 1. Performance Snapshot
- Total revenue, with MoM trend for latest month
- Units sold and orders
- Gross margin % (if available)
- Best and worst performer (by region or category)

### 2. Target Attainment (if variance data exists)
- Overall attainment rate (actual / target %)
- Top 3 misses with: what, how bad (% and absolute), likely why
- Top 2 beats

### 3. Margin Insights (if margin data exists)
- Overall margin % and trend
- Best and worst margin categories with WHY

### 4. Operational Alerts (if inventory/supplier data exists)
- Products below safety stock
- Overdue payable amounts
- Cash flow implications

### 5. Anomalies Requiring Investigation (if anomaly data exists)
- ONLY critical and warning items
- Separate Data Quality from Business Anomalies
- Each: what + impact + recommended action
- Do NOT repeat items already in sections 2-4

### 6. Recommended Actions (ALWAYS)
- Max 5 actions, prioritized by financial impact
- Each must reference a specific finding
- Format: [PRIORITY] Action — Finding reference

## Writing Rules
1. Use SPECIFIC numbers. Never say "significant" — say "-96% vs target (-191K)"
2. Keep under 600 words
3. No filler phrases
4. Do NOT suggest "schedule a meeting" — give actionable steps
5. CURRENCY — CRITICAL:
   - If findings mention multiple currencies (USD, TWD, NTD, THB, etc.),
     do NOT label totals as any single currency.
     Write: "Total revenue: 12.16M (mixed currency)" or break down by currency.
   - If only one currency exists, use that currency label.
   - NEVER default to "THB" unless the data explicitly uses THB.
6. ANTI-HALLUCINATION — CRITICAL:
   - Only state facts that appear in the Tool Findings section.
   - If a tool output says "complete" with no numbers, write
     "data was not detailed enough for analysis" — do NOT invent numbers.
   - NEVER use placeholder text like "X THB" or "at X%".
   - When ranking (largest, worst, best), you MUST have actual values from findings.
"""

SYNTHESIZER_USER_TEMPLATE = """## Tool Findings

{findings_chain_text}

## Data Available
{table_summary}

Write the executive summary following the mandatory structure.
"""


# ================================================================
# Part 6: KEY TABLES SELECTION
# ================================================================

KEY_TABLE_PRIORITY = [
    "revenue", "month", "margin", "category", "variance", "target",
    "anomaly summary", "top customer", "top product", "inventory",
    "payment", "status", "supplier", "expense", "waterfall",
]


def select_key_tables(all_artifacts, max_tables=8):
    """Select the most important tables for display/download."""
    if not all_artifacts:
        return []

    # Score each artifact by label match to priority keywords
    scored = []
    for art in all_artifacts:
        if art.get("type") != "table" or not art.get("data"):
            continue
        label = (art.get("label") or "").lower()
        # Skip metadata tables
        if any(skip in label for skip in (
            "column mapping",
            "detection config",
            "metric contract",
            "benchmark policy",
            "data gaps & warnings",
        )):
            continue
        score = 0
        for i, kw in enumerate(KEY_TABLE_PRIORITY):
            if kw in label:
                score = len(KEY_TABLE_PRIORITY) - i
                break
        scored.append((score, art))

    scored.sort(key=lambda x: -x[0])
    return [art for _, art in scored[:max_tables]]


# ================================================================
# Part 7: LLM HELPERS
# ================================================================

async def _call_llm_raw(prompt, system_prompt, llm_config):
    """Raw LLM call (text completion)."""
    api_key = llm_config.get("api_key") or os.getenv("DEEPSEEK_API_KEY")
    base_url = llm_config.get("base_url") or os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    model = llm_config.get("model", "deepseek-chat")

    if not api_key:
        raise ValueError("No API key for LLM")

    url = f"{base_url}/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": model,
        "temperature": 0.1,
        "max_tokens": 4000,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
    }
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    return data["choices"][0]["message"].get("content") or ""


async def _call_llm_stream(prompt, system_prompt, llm_config):
    """Streaming LLM call — yields text chunks as they arrive."""
    api_key = llm_config.get("api_key") or os.getenv("DEEPSEEK_API_KEY")
    base_url = llm_config.get("base_url") or os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    model = llm_config.get("model", "deepseek-chat")

    if not api_key:
        raise ValueError("No API key for LLM")

    url = f"{base_url}/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": model,
        "temperature": 0.1,
        "max_tokens": 4000,
        "stream": True,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
    }
    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                chunk_str = line[6:].strip()
                if chunk_str == "[DONE]":
                    break
                try:
                    chunk = json.loads(chunk_str)
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    text = delta.get("content")
                    if text:
                        yield text
                except (json.JSONDecodeError, IndexError, KeyError):
                    continue


# ================================================================
# Part 8: MAIN AGENT ENTRY POINT
# ================================================================

MAX_TOOLS = 6


async def run_mbr_agent(sheets_data, llm_config=None, on_step=None, filename="uploaded.xlsx"):
    """
    Run the full MBR agent: Planner → Executor → Synthesizer.

    Args:
        sheets_data: dict of {sheet_name: [row_dicts]}
        llm_config: {"provider", "model", "api_key", "base_url"}
        on_step: async callback for SSE progress events
        filename: original filename for display

    Returns:
        {
            "narrative": str,
            "key_tables": [...],       # 5-8 most important tables
            "all_artifacts": [...],    # everything (for Excel download)
            "steps": [...],
            "total_duration_ms": int,
        }
    """
    start = time.time()

    if llm_config is None:
        llm_config = {
            "provider": os.getenv("MBR_LLM_PROVIDER", "deepseek"),
            "model": os.getenv("MBR_LLM_MODEL", "deepseek-chat"),
            "api_key": os.getenv("DEEPSEEK_API_KEY"),
            "base_url": os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        }

    steps_log = []

    # ── Step 0: Build sheet summary for planner ──
    sheet_lines = []
    for sn, rows in sheets_data.items():
        cols = list(rows[0].keys()) if rows else []
        sheet_lines.append(f"  {sn}: {len(rows)} rows, columns: {', '.join(cols[:12])}")
    sheet_summary = "\n".join(sheet_lines)
    total_rows = sum(len(r) for r in sheets_data.values())

    # ── Step 1: Clean first, then plan (cleaning standardizes schema) ──
    if on_step:
        await on_step({"type": "tool_start", "tool_id": "data_cleaning",
                        "description": TOOL_DESCRIPTIONS.get("data_cleaning", "Cleaning data...")})

    clean_start = time.time()
    clean_result = None
    try:
        if on_step:
            await on_step({"type": "tool_thinking", "tool_id": "data_cleaning",
                           "detail": f"Scanning {len(sheets_data)} sheets for data quality issues..."})
        clean_result = await _execute_tool("data_cleaning", sheets_data, {}, llm_config)
        clean_duration = int((time.time() - clean_start) * 1000)
        current_sheets = clean_result.get("cleaned_sheets") or sheets_data
        clean_summary = summarize_tool_output("data_cleaning", clean_result)
        steps_log.append({"tool": "data_cleaning", "duration_ms": clean_duration, "summary": clean_summary[:200]})

        if on_step:
            await on_step({"type": "tool_finding", "tool_id": "data_cleaning", "finding": clean_summary[:200]})
            await on_step({"type": "tool_done", "tool_id": "data_cleaning",
                           "duration_ms": clean_duration, "status": "success"})
    except Exception as ex:
        clean_duration = int((time.time() - clean_start) * 1000)
        logger.error(f"[MBR Agent] Cleaning failed: {ex}")
        current_sheets = sheets_data
        steps_log.append({"tool": "data_cleaning", "error": str(ex)[:200], "duration_ms": clean_duration})
        if on_step:
            await on_step({"type": "tool_error", "tool_id": "data_cleaning",
                           "error": str(ex)[:200], "recoverable": True})

    # ── Step 2: Planner (deterministic, runs on CLEANED data) ──
    if on_step:
        await on_step({"type": "plan_start"})

    from ml.api.kpi_calculator import profile_for_kpi
    profile = profile_for_kpi(current_sheets)
    plan, reasoning = plan_from_profile(profile)

    # Remove data_cleaning from plan (already ran above)
    plan = [t for t in plan if t != "data_cleaning"]

    if len(plan) <= 1:
        # Only anomaly_detection — profile might have failed, try LLM fallback
        logger.info(f"[MBR Agent] Deterministic plan too minimal ({plan}), trying LLM fallback")
        try:
            plan_response = await _call_llm_raw(
                PLANNER_USER_TEMPLATE.format(
                    filename=filename, sheet_summary=sheet_summary, total_rows=total_rows,
                ),
                PLANNER_SYSTEM_PROMPT, llm_config,
            )
            plan_response = plan_response.strip()
            s = plan_response.find("[")
            e = plan_response.rfind("]")
            if s != -1 and e != -1:
                llm_plan = json.loads(plan_response[s:e + 1])
                llm_plan = [t for t in llm_plan if t != "data_cleaning"]
                if len(llm_plan) > len(plan):
                    plan = llm_plan
                    reasoning["fallback"] = "LLM planner used (deterministic was too minimal)"
        except Exception as ex:
            logger.warning(f"[MBR Agent] LLM planner fallback also failed: {ex}")
            reasoning["fallback_error"] = str(ex)[:100]

    plan = plan[:MAX_TOOLS]
    logger.info(f"[MBR Agent] Plan (post-clean): {plan} | Reasoning: {reasoning}")

    if on_step:
        await on_step({
            "type": "plan_done",
            "tools": ["data_cleaning"] + plan,  # show full plan including cleaning
            "reasoning": f"Deterministic planner: {len(plan)} tools. " +
                         ", ".join(f"{k}={v}" for k, v in reasoning.items()
                                  if k not in ("sheet_types", "total_tools")),
        })

    # ── Step 3: Execute remaining tools with context chain ──
    context = await run_pipeline(plan, current_sheets, llm_config, on_step=on_step)

    # Add cleaning to findings chain
    context["findings_chain"].insert(0, ("data_cleaning", summarize_tool_output("data_cleaning", clean_result or {})))

    # Log steps
    for tool_id, summary in context["findings_chain"][1:]:
        existing = next((s for s in steps_log if s.get("tool") == tool_id), None)
        if not existing:
            steps_log.append({"tool": tool_id, "summary": summary[:200]})

    # ── Step 4: Shared Synthesizer ──
    from ml.api.agent_synthesizer import prepare_analysis_context, synthesize

    analysis_context = prepare_analysis_context(context["all_artifacts"])
    if analysis_context.get("enriched_artifacts"):
        context["all_artifacts"].extend(analysis_context["enriched_artifacts"])

    narrative = await synthesize(
        context["findings_chain"],
        llm_config,
        on_step=on_step,
        all_artifacts=context["all_artifacts"],
        analysis_context=analysis_context,
    )

    key_tables = select_key_tables(context["all_artifacts"])

    # ── Step 5: Generate formatted Excel report ──
    excel_report = None
    if on_step:
        await on_step({
            "type": "tool_start",
            "tool_id": "report_generation",
            "description": TOOL_DESCRIPTIONS.get("report_generation", "Building report..."),
        })
        await on_step({"type": "tool_thinking", "tool_id": "report_generation",
                       "detail": "LLM selecting most important tables for report..."})

    report_start = time.time()
    try:
        from ml.api.mbr_report_builder import build_mbr_report

        report_input = {
            "all_artifacts": context["all_artifacts"],
            "narrative": narrative,
            "findings_chain": context["findings_chain"],
            "steps": steps_log,
        }

        excel_report = await build_mbr_report(
            agent_result=report_input,
            llm_config=llm_config,
            call_llm_fn=_call_llm_raw,
        )

        report_duration = int((time.time() - report_start) * 1000)
        if on_step:
            await on_step({"type": "tool_thinking", "tool_id": "report_generation",
                           "detail": "Rendering Excel with charts and formatting..."})
            await on_step({"type": "tool_done", "tool_id": "report_generation",
                           "duration_ms": report_duration, "status": "success"})

    except Exception as ex:
        report_duration = int((time.time() - report_start) * 1000)
        logger.error(f"[MBR Agent] Report generation failed: {ex}")
        if on_step:
            await on_step({"type": "tool_error", "tool_id": "report_generation",
                           "error": str(ex)[:200], "recoverable": True,
                           "duration_ms": report_duration})

    total_duration = int((time.time() - start) * 1000)

    # ── Final: agent_done ──
    if on_step:
        await on_step({
            "type": "agent_done",
            "total_duration_ms": total_duration,
            "tools_run": len(plan) + 1,
            "tables_generated": len(key_tables),
            "total_artifacts": len(context["all_artifacts"]),
        })

    return {
        "narrative": narrative,
        "key_tables": key_tables,
        "all_artifacts": context["all_artifacts"],
        "steps": steps_log,
        "findings_chain": context["findings_chain"],
        "plan": plan,
        "total_duration_ms": total_duration,
        "excel_report": excel_report,
    }
