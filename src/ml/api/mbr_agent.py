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
        }

    elif tool_id == "kpi_calculation":
        from ml.api.kpi_calculator import execute_kpi_pipeline
        result = await asyncio.to_thread(execute_kpi_pipeline, sheets_data, call_llm_fn=sync_llm)
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
        if "column mapping" in label or "detection config" in label:
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

    # ── Step 1: Planner ──
    if on_step:
        await on_step({"type": "plan_start"})

    try:
        plan_response = await _call_llm_raw(
            PLANNER_USER_TEMPLATE.format(
                filename=filename,
                sheet_summary=sheet_summary,
                total_rows=total_rows,
            ),
            PLANNER_SYSTEM_PROMPT,
            llm_config,
        )
        # Parse JSON array
        plan_response = plan_response.strip()
        s = plan_response.find("[")
        e = plan_response.rfind("]")
        if s != -1 and e != -1:
            plan = json.loads(plan_response[s:e + 1])
        else:
            plan = json.loads(plan_response)

        # Ensure data_cleaning is first
        if "data_cleaning" not in plan:
            plan.insert(0, "data_cleaning")
        elif plan[0] != "data_cleaning":
            plan.remove("data_cleaning")
            plan.insert(0, "data_cleaning")

        # Cap at MAX_TOOLS
        plan = plan[:MAX_TOOLS]

        logger.info(f"[MBR Agent] Plan: {plan}")
        if on_step:
            await on_step({
                "type": "plan_done",
                "tools": plan,
                "reasoning": f"Found {len(sheets_data)} sheets with {total_rows} rows. "
                             f"Will run {len(plan)} analysis steps.",
            })

    except Exception as ex:
        logger.error(f"[MBR Agent] Planner failed: {ex}")
        plan = ["data_cleaning", "kpi_calculation", "anomaly_detection"]
        if on_step:
            await on_step({
                "type": "plan_done",
                "tools": plan,
                "reasoning": f"Planner fallback — running default pipeline ({len(plan)} steps).",
                "fallback": True,
            })

    # ── Step 2: Execute data_cleaning ──
    if on_step:
        await on_step({
            "type": "tool_start",
            "tool_id": "data_cleaning",
            "description": TOOL_DESCRIPTIONS.get("data_cleaning", "Cleaning data..."),
        })

    clean_start = time.time()
    clean_result = None
    try:
        # Emit thinking
        if on_step:
            n = len(sheets_data)
            await on_step({"type": "tool_thinking", "tool_id": "data_cleaning",
                           "detail": f"Scanning {n} sheets for data quality issues..."})

        clean_result = await _execute_tool("data_cleaning", sheets_data, {}, llm_config)
        clean_duration = int((time.time() - clean_start) * 1000)
        current_sheets = clean_result.get("cleaned_sheets") or sheets_data
        clean_summary = summarize_tool_output("data_cleaning", clean_result)
        steps_log.append({"tool": "data_cleaning", "duration_ms": clean_duration, "summary": clean_summary[:200]})

        # Emit findings
        if on_step:
            rows_removed = clean_result.get("rows_after", 0)
            n_cleaned = clean_result.get("sheets_cleaned", 0)
            await on_step({"type": "tool_thinking", "tool_id": "data_cleaning",
                           "detail": f"Standardized {n_cleaned} sheets, {rows_removed} rows after cleaning."})
            if clean_summary:
                await on_step({"type": "tool_finding", "tool_id": "data_cleaning",
                               "finding": clean_summary[:200]})
            await on_step({"type": "tool_done", "tool_id": "data_cleaning",
                           "duration_ms": clean_duration, "status": "success",
                           "findings_count": 1})

    except Exception as ex:
        clean_duration = int((time.time() - clean_start) * 1000)
        logger.error(f"[MBR Agent] Cleaning failed: {ex}")
        current_sheets = sheets_data
        steps_log.append({"tool": "data_cleaning", "error": str(ex)[:200], "duration_ms": clean_duration})
        if on_step:
            await on_step({"type": "tool_error", "tool_id": "data_cleaning",
                           "error": str(ex)[:200], "recoverable": True, "duration_ms": clean_duration})

    # ── Step 3: Execute remaining tools with context chain ──
    remaining_plan = [t for t in plan if t != "data_cleaning"]
    context = await run_pipeline(remaining_plan, current_sheets, llm_config, on_step=on_step)

    # Add cleaning to findings chain
    context["findings_chain"].insert(0, ("data_cleaning", summarize_tool_output("data_cleaning", clean_result or {})))

    # Log steps
    for tool_id, summary in context["findings_chain"][1:]:
        existing = next((s for s in steps_log if s.get("tool") == tool_id), None)
        if not existing:
            steps_log.append({"tool": tool_id, "summary": summary[:200]})

    # ── Step 4: Synthesizer (streaming) ──
    if on_step:
        await on_step({"type": "synthesize_start"})

    findings_text = ""
    for tool_id, findings in context["findings_chain"]:
        findings_text += f"\n### {tool_id}\n{findings}\n"

    key_tables = select_key_tables(context["all_artifacts"])
    table_summary = f"{len(key_tables)} key tables + {len(context['all_artifacts'])} total tables available"

    # Detect currencies from artifacts
    detected_currencies = set()
    for art in context["all_artifacts"]:
        for row in (art.get("data") or [])[:10]:
            if isinstance(row, dict):
                cur = row.get("currency")
                if cur and isinstance(cur, str) and len(cur) <= 5:
                    detected_currencies.add(cur.upper())

    currency_note = ""
    if len(detected_currencies) > 1:
        currency_note = (
            f"\n\n## CRITICAL: MULTIPLE CURRENCIES DETECTED\n"
            f"Currencies found: {sorted(detected_currencies)}\n"
            f"Do NOT label any total as a single currency. "
            f"Either break down by currency or state 'mixed currency'.\n"
        )
    elif len(detected_currencies) == 1:
        cur = list(detected_currencies)[0]
        currency_note = f"\n\nCurrency: All amounts are in {cur}.\n"

    narrative = ""
    synth_prompt = SYNTHESIZER_USER_TEMPLATE.format(
        findings_chain_text=findings_text + currency_note,
        table_summary=table_summary,
    )

    try:
        if on_step:
            # Streaming mode — emit chunks as they arrive
            word_count = 0
            async for chunk in _call_llm_stream(synth_prompt, SYNTHESIZER_SYSTEM_PROMPT, llm_config):
                narrative += chunk
                word_count += len(chunk.split())
                await on_step({"type": "synthesize_chunk", "text": chunk})
            await on_step({"type": "synthesize_done", "word_count": word_count})
        else:
            # Non-streaming fallback (for /agent/mbr non-SSE endpoint)
            narrative = await _call_llm_raw(synth_prompt, SYNTHESIZER_SYSTEM_PROMPT, llm_config)
    except Exception as ex:
        logger.error(f"[MBR Agent] Synthesizer failed: {ex}")
        narrative = f"Synthesizer error: {ex}\n\nRaw findings:\n{findings_text}"
        if on_step:
            await on_step({"type": "synthesize_done", "word_count": 0, "error": str(ex)[:200]})

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
