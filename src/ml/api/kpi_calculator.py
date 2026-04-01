"""
kpi_calculator.py — Deterministic KPI Calculator

Architecture mirrors mbr_data_cleaning.py:
  LLM does column mapping (JSON config) → KpiCalculator executes deterministically

Flow:
  Step 1: profile_for_kpi()     — scan sheets, detect column roles (no LLM)
  Step 2: build_kpi_prompt()    — construct prompt for LLM to return JSON config
  Step 3: KpiCalculator.calculate() — execute pre-built calculators from config

Usage:
  from ml.api.kpi_calculator import execute_kpi_pipeline

  result = execute_kpi_pipeline(
      sheets_dict={"sales": [...], "inventory": [...]},
      call_llm_fn=your_llm_call,
      llm_config={"provider": "deepseek", "model": "deepseek-chat"},
  )
"""

import pandas as pd
import numpy as np
import re
import json
from datetime import datetime


# ================================================================
# Part 1: KPI DATA PROFILER
# ================================================================

# Keyword sets for semantic role detection
# "amount" and "total" removed from _REVENUE_KW — they're ambiguous
_REVENUE_KW = {
    "revenue", "net_revenue", "gross_revenue", "total_revenue",
    "sales", "net_sales", "gross_sales", "turnover", "gross_profit",
}
_COST_KW = {"cost", "cogs", "unit_cost", "total_cost", "price_cost"}
_EXPENSE_KW = {"expense", "spend", "amount"}  # "amount" defaults to expense context
_PRICE_KW = {"price", "unit_price", "selling_price", "list_price", "avg_price"}
_QTY_KW = {
    "qty", "quantity", "units", "volume", "count", "units_sold",
    "order_qty", "on_hand", "on_hand_qty", "qty_on_hand",
    "safety_stock", "qty_ordered", "qty_shipped",
    "qty_available", "qty_reserved", "qty_received",
}
_DATE_KW = {
    "date", "order_date", "invoice_date", "due_date", "ship_date",
    "expense_date", "received_date", "snapshot_date", "expiry_date",
    "created", "updated", "period", "month", "year",
}
_ID_KW = {
    "id", "code", "sku", "product_code", "product_sku",
    "customer_id", "order_id", "invoice_id", "invoice_no",
    "employee_id", "supplier_id", "expense_id", "batch_no",
}
_CAT_KW = {
    "category", "region", "channel", "department", "type",
    "status", "country", "segment", "group", "class", "tier",
    "payment_terms", "payment_status", "currency", "warehouse",
}
_TARGET_KW = {"target", "budget", "plan", "forecast", "goal"}
_PCT_KW = {"pct", "percent", "rate", "ratio", "margin", "discount"}
_NAME_KW = {
    "name", "customer_name", "product_name", "supplier",
    "supplier_name", "employee", "approved_by", "item", "description",
}


def _detect_role(col_name, series):
    """Detect semantic role of a column from its name and data."""
    cl = col_name.lower().strip()

    # Priority order matters — ID > Name > Date > Target > Pct > Revenue > Cost > Price > Qty > Expense > Category
    for kw in _ID_KW:
        if kw == cl or (len(kw) > 2 and kw in cl):
            return "id"
    for kw in _NAME_KW:
        if kw == cl or (len(kw) > 3 and kw in cl):
            return "name"
    for kw in _DATE_KW:
        if kw == cl or (len(kw) > 3 and kw in cl):
            return "date"
    for kw in _TARGET_KW:
        if kw in cl:
            return "target"
    for kw in _PCT_KW:
        if kw in cl:
            return "percentage"
    for kw in _REVENUE_KW:
        if kw == cl or (len(kw) > 4 and kw in cl):
            return "revenue"
    for kw in _COST_KW:
        if kw == cl or (len(kw) > 3 and kw in cl):
            return "cost"
    for kw in _PRICE_KW:
        if kw == cl or (len(kw) > 4 and kw in cl):
            return "price"
    for kw in _QTY_KW:
        if kw == cl or (len(kw) > 2 and kw in cl):
            return "quantity"
    for kw in _EXPENSE_KW:
        if kw == cl or (len(kw) > 4 and kw in cl):
            return "expense_amount"
    for kw in _CAT_KW:
        if kw == cl or (len(kw) > 3 and kw in cl):
            return "category"

    # Fallback: infer from data type
    non_null = series.dropna()
    if len(non_null) == 0:
        return "unknown"
    numeric = pd.to_numeric(non_null, errors="coerce")
    if numeric.notna().sum() / max(len(non_null), 1) > 0.8:
        return "numeric"
    if non_null.nunique() <= 20 and non_null.nunique() >= 2:
        return "category"
    return "text"


def _classify_sheet(sheet_name, columns_info):
    """Classify sheet type from name + column composition."""
    name_lower = sheet_name.lower().replace("_", " ").replace("-", " ")

    if any(kw in name_lower for kw in ("sales", "order", "transaction", "demand", "revenue")):
        return "sales"
    if any(kw in name_lower for kw in ("budget", "target", "plan", "forecast")):
        return "target"
    if any(kw in name_lower for kw in ("supplier", "invoice", "payable", "procurement", "purchase")):
        return "supplier"
    if any(kw in name_lower for kw in ("expense", "cost center", "opex", "spending")):
        return "expense"
    if any(kw in name_lower for kw in ("inventory", "stock", "warehouse", "snapshot")):
        return "inventory"
    if any(kw in name_lower for kw in ("customer", "client", "account", "master")):
        return "master"
    if any(kw in name_lower for kw in ("price", "pricing", "rate card")):
        return "reference"

    # Column-composition fallback
    roles = set()
    for col_info in columns_info.values():
        roles.add(col_info.get("role", "unknown"))

    if "revenue" in roles:
        return "sales"
    if "target" in roles:
        return "target"
    if "expense_amount" in roles and "revenue" not in roles:
        col_names_lower = {c.lower() for c in columns_info.keys()}
        if any(kw in " ".join(col_names_lower) for kw in ("supplier", "invoice", "vendor")):
            return "supplier"
        if any(kw in " ".join(col_names_lower) for kw in ("department", "expense", "employee")):
            return "expense"

    return "unknown"


def profile_for_kpi(sheets_dict):
    """
    Profile data for KPI calculation. No LLM call. ~50ms.

    Returns:
        {
            "sheets": {
                "sheet_name": {
                    "row_count": int,
                    "columns": {
                        "col_name": {
                            "dtype": "numeric|date|categorical|text",
                            "role": "revenue|cost|price|quantity|date|id|category|target|percentage|numeric|text|unknown",
                            "sample": [val1, val2, val3],
                            "null_pct": float,
                            "unique_count": int,
                            "values": [...] (if categorical, <=20 unique),
                            "stats": {min, max, mean} (if numeric),
                            "date_range": "YYYY-MM-DD to YYYY-MM-DD" (if date),
                        }
                    }
                }
            },
            "cross_sheet_joins": [
                {"column": "product_code", "sheets": ["sales", "inventory"], "overlap_pct": 95.0}
            ]
        }
    """
    result = {"sheets": {}, "cross_sheet_joins": []}

    all_id_values = {}  # {(sheet, col): set_of_values}

    for sheet_name, data in sheets_dict.items():
        if not data:
            continue
        df = pd.DataFrame(data)
        sheet_profile = {"row_count": len(df), "columns": {}}

        for col in df.columns:
            series = df[col]
            non_null = series.dropna()
            role = _detect_role(col, series)

            cp = {
                "role": role,
                "null_pct": round(series.isnull().sum() / max(len(df), 1) * 100, 1),
                "unique_count": int(series.nunique()),
            }

            # Sample values (first 3 non-null)
            if len(non_null) > 0:
                cp["sample"] = [str(x) for x in non_null.head(3).tolist()]

            # Numeric stats
            numeric = pd.to_numeric(non_null, errors="coerce")
            num_ratio = numeric.notna().sum() / max(len(non_null), 1)
            if num_ratio > 0.7:
                cp["dtype"] = "numeric"
                valid = numeric.dropna()
                if len(valid) > 0:
                    cp["stats"] = {
                        "min": round(float(valid.min()), 2),
                        "max": round(float(valid.max()), 2),
                        "mean": round(float(valid.mean()), 2),
                    }
            # Date detection
            elif role == "date":
                cp["dtype"] = "date"
                try:
                    parsed = pd.to_datetime(non_null, errors="coerce")
                    valid_dates = parsed.dropna()
                    if len(valid_dates) > 0:
                        cp["date_range"] = f"{valid_dates.min().strftime('%Y-%m-%d')} to {valid_dates.max().strftime('%Y-%m-%d')}"
                except Exception:
                    pass
            # Categorical
            elif series.nunique() <= 20 and series.nunique() >= 2:
                cp["dtype"] = "categorical"
                cp["values"] = sorted([str(v) for v in series.dropna().unique().tolist()])
            else:
                cp["dtype"] = "text"

            # Track ID columns for cross-sheet join detection
            if role == "id" or (cp.get("dtype") == "text" and cp["unique_count"] > 2):
                vals = set(non_null.astype(str).str.strip())
                if len(vals) > 1:
                    all_id_values[(sheet_name, col)] = vals

            sheet_profile["columns"][col] = cp

        result["sheets"][sheet_name] = sheet_profile

    # Cross-sheet join candidates
    checked = set()
    for (s1, c1), v1 in all_id_values.items():
        for (s2, c2), v2 in all_id_values.items():
            if s1 == s2:
                continue
            key = tuple(sorted([(s1, c1), (s2, c2)]))
            if key in checked:
                continue
            checked.add(key)
            overlap = v1 & v2
            if len(overlap) > 2:
                total = len(v1 | v2)
                result["cross_sheet_joins"].append({
                    "column_1": f"{s1}.{c1}",
                    "column_2": f"{s2}.{c2}",
                    "overlap_count": len(overlap),
                    "overlap_pct": round(len(overlap) / max(total, 1) * 100, 1),
                })

    return result


def suggest_calculators(profile):
    """
    Based on the profile, suggest which calculators are likely applicable.
    Uses data-type inference as primary signal (not column names), so it works
    regardless of language or naming convention.
    Returns a list of {name, description, available: bool, reason: str}.
    """
    # Count data types across all sheets (language-agnostic)
    numeric_cols = 0
    date_cols = 0
    categorical_cols = 0
    total_cols = 0
    sheet_count = len(profile.get("sheets", {}))

    # Also check keyword-based roles as bonus signal
    all_roles = {}
    for sn, sp in profile.get("sheets", {}).items():
        for col, ci in sp.get("columns", {}).items():
            total_cols += 1
            dtype = ci.get("dtype", "text")
            if dtype == "numeric":
                numeric_cols += 1
            elif dtype == "date":
                date_cols += 1
            elif dtype == "categorical":
                categorical_cols += 1
            role = ci.get("role", "unknown")
            all_roles.setdefault(role, []).append((sn, col))

    # Keyword-based signals (bonus, not required)
    has_revenue = bool(all_roles.get("revenue"))
    has_cost = bool(all_roles.get("cost"))
    has_target = bool(all_roles.get("target"))

    # Data-type-based signals (primary, language-agnostic)
    has_numeric = numeric_cols >= 1
    has_dates = date_cols >= 1
    has_categories = categorical_cols >= 1
    has_multiple_sheets = sheet_count > 1
    has_two_numeric = numeric_cols >= 2  # for margin (revenue - cost)

    suggestions = [
        {
            "name": "revenue_summary",
            "description": "Total revenue + breakdown by month, region, category, etc.",
            "available": has_numeric,
            "reason": "Found numeric columns" if has_numeric else "No numeric columns found",
        },
        {
            "name": "gross_margin",
            "description": "Gross margin and margin% (revenue - COGS)",
            "available": has_two_numeric,
            "reason": "Found multiple numeric columns" if has_two_numeric else "Need at least 2 numeric columns (revenue + cost)",
        },
        {
            "name": "inventory_coverage",
            "description": "Inventory coverage days (on_hand / avg daily demand)",
            "available": has_numeric and has_dates and has_multiple_sheets,
            "reason": "Found numeric + date + multiple sheets" if (has_numeric and has_dates) else "Need inventory + demand data across sheets",
        },
        {
            "name": "period_comparison",
            "description": "Month-over-month, quarter-over-quarter, or year-over-year comparison",
            "available": has_dates and has_numeric,
            "reason": "Found date + numeric columns" if (has_dates and has_numeric) else "Need date + numeric columns",
        },
        {
            "name": "target_variance",
            "description": "Actual vs target with variance%",
            "available": has_multiple_sheets and has_numeric,
            "reason": "Found multiple sheets with numeric data" if has_multiple_sheets else "Need separate actual + target sheets",
        },
        {
            "name": "ap_aging",
            "description": "Accounts payable aging buckets (current/30/60/90+)",
            "available": date_cols >= 2 and has_numeric,
            "reason": "Found multiple date + numeric columns" if date_cols >= 2 else "Need at least 2 date columns (invoice + due) + amount",
        },
        {
            "name": "top_n",
            "description": "Top N entities (customers, products, suppliers) by metric",
            "available": has_categories and has_numeric,
            "reason": "Found categorical + numeric columns" if (has_categories and has_numeric) else "Need entity + metric columns",
        },
        {
            "name": "distribution",
            "description": "Value breakdown by category with percentages",
            "available": has_categories,
            "reason": "Found categorical columns" if has_categories else "No categorical columns found",
        },
        {
            "name": "trend",
            "description": "Time series trend (daily/weekly/monthly/quarterly)",
            "available": has_dates and has_numeric,
            "reason": "Found date + numeric columns" if (has_dates and has_numeric) else "Need date + numeric columns",
        },
        {
            "name": "ratio",
            "description": "Ratio/rate between two values (churn rate, conversion, NRR, etc.)",
            "available": has_two_numeric,
            "reason": "Found multiple numeric columns" if has_two_numeric else "Need at least 2 numeric columns",
        },
        {
            "name": "weighted_sum",
            "description": "Weighted sum/average (weighted pipeline, weighted score, etc.)",
            "available": has_two_numeric,
            "reason": "Found multiple numeric columns" if has_two_numeric else "Need value + weight columns",
        },
        {
            "name": "avg_by_group",
            "description": "Average metric by entity (avg resolution time, ARPU, etc.)",
            "available": has_categories,
            "reason": "Found categorical columns" if has_categories else "Need entity/category column",
        },
    ]
    return suggestions


# ================================================================
# Part 2: LLM PROMPT BUILDER
# ================================================================

SUPPORTED_CALCULATORS = {
    "revenue_summary": {
        "description": "Total revenue + breakdown by grouping columns. Handles multi-currency.",
        "params": {
            "source_sheet": "str — sheet containing revenue data",
            "amount_col": "str — column with revenue/amount values",
            "group_by_cols": "list[str] — columns to group by (e.g., ['month', 'region']). Creates one artifact per grouping.",
            "currency_col": "str — column with currency codes (optional). If present and multiple currencies exist, results are split by currency.",
        },
    },
    "gross_margin": {
        "description": "Gross margin and margin% from sales and cost data. ALWAYS uses aggregate formula: margin% = sum(profit) / sum(revenue) * 100. Supports multi-column joins for cross-sheet data.",
        "params": {
            "sales_sheet": "str — sheet with sales/revenue data",
            "cost_sheet": "str — sheet with cost data (can be same as sales_sheet if cost columns exist there)",
            "join_col": "str, list, or dict — column(s) to join on. str for single column. list for multi-column join (e.g., ['period','region']). dict for asymmetric: {'left': [...], 'right': [...]}",
            "revenue_col": "str — column with revenue/amount in sales_sheet",
            "cogs_col": "str — column with cost/amount in cost_sheet",
            "qty_col": "str — column with quantity (optional, only for unit_cost * qty scenarios)",
            "group_by": "list[str] — columns to group by (optional)",
            "currency_col": "str — currency column (optional). If multi-currency, results split by currency.",
            "filter_col": "str — optional column to filter REVENUE rows before calculation (e.g., 'status')",
            "filter_value": "str — value to filter revenue on (e.g., 'Active')",
            "cogs_filter_col": "str — optional column to filter COST rows (e.g., 'cost_type', 'category'). Use when cost sheet has multiple cost categories and only some are COGS.",
            "cogs_filter_value": "str or list — value(s) to include as COGS (e.g., 'Infrastructure' or ['Infrastructure','Hosting']). Other cost types (Personnel, Marketing, G&A) are excluded from COGS.",
        },
    },
    "inventory_coverage": {
        "description": "Inventory coverage days = on_hand / avg_daily_demand. avg_daily_demand uses the FULL sales period.",
        "params": {
            "inventory_sheet": "str — sheet with inventory data",
            "sales_sheet": "str — sheet with sales/demand data",
            "product_col": "str or dict — column to join inventory and sales on",
            "on_hand_col": "str — column with on-hand quantity",
            "demand_col": "str — column with demand/sales quantity",
            "date_col": "str — date column in sales (to compute period length)",
        },
    },
    "period_comparison": {
        "description": "Compare current vs prior period metrics. Auto-detects periods from data when mode is used.",
        "params": {
            "source_sheet": "str",
            "date_col": "str — date column (used to derive periods when mode is set)",
            "mode": "str — 'MoM' (month-over-month), 'YoY' (year-over-year), 'QoQ' (quarter-over-quarter). Auto-detects latest period and computes prior. If omitted, use current_period/prior_period.",
            "current_period": "str — explicit current period value (optional if mode is set)",
            "prior_period": "str — explicit prior period value (optional if mode is set)",
            "value_cols": "list[str] — columns to compare (numeric)",
            "group_by": "list[str] — optional grouping (e.g., by region)",
        },
    },
    "target_variance": {
        "description": "Actual vs target with variance and variance%. Aggregates actuals by join_cols before joining (actual is detail, target is summary). variance% = (actual - target) / abs(target) * 100",
        "params": {
            "actual_sheet": "str — sheet with actual (detail) data",
            "target_sheet": "str — sheet with target (summary) data",
            "join_cols": "list[str] — columns to join on (e.g., ['month', 'region'])",
            "actual_col": "str — column with actual values in actual_sheet",
            "target_col": "str — column with target values in target_sheet",
            "aggregate": "str — how to aggregate actuals before join: 'sum' (default), 'count', 'mean'",
            "date_col": "str — date column in actual_sheet (optional, to derive period columns for join)",
            "filter_col": "str — optional column to filter actual data before aggregation (e.g., 'status')",
            "filter_value": "str — value to filter on (e.g., 'Active')",
        },
    },
    "ap_aging": {
        "description": "Accounts payable aging buckets: Current, 1-30, 31-60, 61-90, 90+",
        "params": {
            "source_sheet": "str",
            "invoice_date_col": "str",
            "due_date_col": "str",
            "amount_col": "str",
            "group_by": "str — optional grouping column (e.g., supplier)",
            "currency_col": "str — currency column (optional). If multi-currency, produces one table per currency.",
            "as_of_date": "str — reference date (optional, defaults to max date in data)",
        },
    },
    "top_n": {
        "description": "Top N entities ranked by a metric. Splits by currency if multi-currency.",
        "params": {
            "source_sheet": "str",
            "group_col": "str — entity column (e.g., customer_name)",
            "value_col": "str — metric to rank by (e.g., total_amount)",
            "agg": "str — aggregation: 'sum' (default), 'count', 'mean'",
            "n": "int — number of top entities (default 10)",
            "label": "str — artifact label",
            "currency_col": "str — currency column (optional). If multi-currency, produces one table per currency.",
        },
    },
    "distribution": {
        "description": "Value breakdown by category with counts and percentages. Splits by currency if multi-currency.",
        "params": {
            "source_sheet": "str",
            "category_col": "str — grouping column",
            "value_col": "str — value column to aggregate (optional, uses count if omitted)",
            "agg": "str — aggregation: 'sum' (default), 'count', 'mean'",
            "currency_col": "str — currency column (optional). If multi-currency, produces one table per currency.",
        },
    },
    "trend": {
        "description": "Time series aggregation at specified frequency",
        "params": {
            "source_sheet": "str",
            "date_col": "str — date column",
            "value_col": "str — value to aggregate",
            "freq": "str — frequency: 'D' (daily), 'W' (weekly), 'M' (monthly), 'Q' (quarterly)",
            "agg": "str — aggregation: 'sum' (default), 'mean', 'count'",
        },
    },
    "ratio": {
        "description": "Calculate ratio between two values. Use for rates: churn rate, conversion rate, NRR, fill rate, etc. Supports cross-sheet (numerator from one sheet, denominator from another).",
        "params": {
            "source_sheet": "str — default sheet (used if numerator_sheet/denominator_sheet not set)",
            "numerator_col": "str — column for numerator",
            "denominator_col": "str — column for denominator",
            "numerator_sheet": "str — sheet for numerator (optional, defaults to source_sheet)",
            "denominator_sheet": "str — sheet for denominator (optional, defaults to source_sheet)",
            "group_by": "list[str] — optional grouping",
            "multiply_by": "int — multiply result (e.g., 100 for percentage). Default 1.",
            "filter_col": "str — optional filter column",
            "filter_value": "str — optional filter value",
        },
    },
    "weighted_sum": {
        "description": "Calculate weighted sum and weighted average. Use for: weighted pipeline value (deal_value * probability), weighted lead score, etc.",
        "params": {
            "source_sheet": "str",
            "value_col": "str — value column",
            "weight_col": "str — weight column (e.g., probability, quantity)",
            "group_by": "list[str] — optional grouping",
            "filter_col": "str — optional filter column",
            "filter_value": "str — optional filter value",
        },
    },
    "avg_by_group": {
        "description": "Average of a metric grouped by entity. Use for: avg resolution time by priority, avg deal size by rep, ARPU by segment, etc.",
        "params": {
            "source_sheet": "str",
            "value_col": "str — metric to average",
            "group_col": "str — entity to group by",
            "filter_col": "str — optional filter column",
            "filter_value": "str — optional filter value",
        },
    },
}


# ================================================================
# Part 2b: AUTO-DETECT KPI CONFIG (replaces LLM call, ~0ms)
# ================================================================

def build_kpi_config_from_profile(profile: dict) -> dict:
    """
    Build KPI calculator config deterministically from profile.
    Sheet-type-aware: only sales sheets get revenue_summary.
    Uses _classify_sheet + roles from _detect_role().
    """
    calculations = []
    sheets = profile.get("sheets", {})

    # First pass: classify all sheets
    sheet_types = {}
    for sheet_name, sheet_info in sheets.items():
        sheet_types[sheet_name] = _classify_sheet(sheet_name, sheet_info.get("columns", {}))

    sales_sheets = [sn for sn, st in sheet_types.items() if st == "sales"]
    target_sheets = [sn for sn, st in sheet_types.items() if st == "target"]
    inv_sheets = [sn for sn, st in sheet_types.items() if st == "inventory"]

    for sheet_name, sheet_info in sheets.items():
        cols = sheet_info.get("columns", {})
        sheet_type = sheet_types[sheet_name]
        n_rows = sheet_info.get("row_count", 0)
        if n_rows < 1:
            continue

        # Collect columns by role
        role_map = {}
        for col_name, col_info in cols.items():
            role = col_info.get("role", "unknown")
            role_map.setdefault(role, []).append(col_name)

        revenue_cols = role_map.get("revenue", [])
        cost_cols = role_map.get("cost", [])
        date_cols = role_map.get("date", [])
        cat_cols = role_map.get("category", [])
        qty_cols = role_map.get("quantity", [])
        target_cols = role_map.get("target", [])
        id_cols = role_map.get("id", [])
        name_cols = role_map.get("name", [])
        expense_cols = role_map.get("expense_amount", [])
        status_cols = [c for c in cols if cols[c].get("role") == "category"
                       and any(kw in c.lower() for kw in ("status", "state", "payment"))]

        amount_col = revenue_cols[0] if revenue_cols else None
        cost_col = cost_cols[0] if cost_cols else None
        date_col = date_cols[0] if date_cols else None
        qty_col = qty_cols[0] if qty_cols else None
        primary_cat = cat_cols[0] if cat_cols else None

        # ── SALES SHEET: full KPI treatment ──
        if sheet_type == "sales" and amount_col:
            if date_col:
                calculations.append({
                    "calculator": "revenue_summary",
                    "params": {"source_sheet": sheet_name, "amount_col": amount_col, "group_by_cols": [date_col]},
                    "label": f"{sheet_name} — Revenue by Period",
                })
            for cc in cat_cols[:3]:
                calculations.append({
                    "calculator": "revenue_summary",
                    "params": {"source_sheet": sheet_name, "amount_col": amount_col, "group_by_cols": [cc]},
                    "label": f"{sheet_name} — Revenue by {cc}",
                })
            calculations.append({
                "calculator": "revenue_summary",
                "params": {"source_sheet": sheet_name, "amount_col": amount_col},
                "label": f"{sheet_name} — Total Revenue",
            })
            entity_col = name_cols[0] if name_cols else (id_cols[0] if id_cols else None)
            if entity_col:
                calculations.append({
                    "calculator": "top_n",
                    "params": {"source_sheet": sheet_name, "value_col": amount_col, "group_col": entity_col, "n": 10},
                    "label": f"{sheet_name} — Top 10 by {entity_col}",
                })
            if cost_col:
                gm_params = {"sales_sheet": sheet_name, "cost_sheet": sheet_name,
                             "revenue_col": amount_col, "cogs_col": cost_col}
                if cat_cols:
                    gm_params["group_by"] = cat_cols[:2]
                calculations.append({"calculator": "gross_margin", "params": gm_params,
                                     "label": f"{sheet_name} — Gross Margin"})
            for sc in status_cols:
                calculations.append({
                    "calculator": "distribution",
                    "params": {"source_sheet": sheet_name, "category_col": sc, "value_col": amount_col},
                    "label": f"{sheet_name} — Distribution by {sc}",
                })
            if date_col:
                calculations.append({
                    "calculator": "trend",
                    "params": {"source_sheet": sheet_name, "date_col": date_col, "value_col": amount_col},
                    "label": f"{sheet_name} — Revenue Trend",
                })
            if primary_cat:
                calculations.append({
                    "calculator": "avg_by_group",
                    "params": {"source_sheet": sheet_name, "value_col": amount_col, "group_col": primary_cat},
                    "label": f"{sheet_name} — Avg {amount_col} by {primary_cat}",
                })
            # Within-sheet target variance (revenue col + target col in same sheet)
            if target_cols:
                tv_params = {
                    "actual_sheet": sheet_name, "target_sheet": sheet_name,
                    "actual_col": amount_col, "target_col": target_cols[0],
                }
                join_cols = []
                if date_col:
                    join_cols.append(date_col)
                join_cols.extend(cat_cols[:2])
                if join_cols:
                    tv_params["join_cols"] = join_cols
                calculations.append({
                    "calculator": "target_variance",
                    "params": tv_params,
                    "label": "Actual vs Target Variance",
                })

        # ── SUPPLIER SHEET: AP aging + distribution ──
        elif sheet_type == "supplier":
            sup_amount = expense_cols[0] if expense_cols else (cost_cols[0] if cost_cols else None)
            for cn in cols:
                if cn.lower() in ("total_amount", "amount", "invoice_amount"):
                    sup_amount = cn
                    break
            sup_name = name_cols[0] if name_cols else None
            due_date = next((dc for dc in date_cols if "due" in dc.lower()), None)
            inv_date = next((dc for dc in date_cols if "invoice" in dc.lower()), date_cols[0] if date_cols else None)
            if not due_date and len(date_cols) > 1:
                due_date = date_cols[1]
            if sup_amount and inv_date and due_date:
                calculations.append({
                    "calculator": "ap_aging",
                    "params": {"source_sheet": sheet_name, "invoice_date_col": inv_date,
                               "due_date_col": due_date, "amount_col": sup_amount, "group_by": sup_name},
                    "label": f"{sheet_name} — AP Aging",
                })
            if sup_amount and sup_name:
                calculations.append({
                    "calculator": "top_n",
                    "params": {"source_sheet": sheet_name, "value_col": sup_amount, "group_col": sup_name, "n": 10},
                    "label": f"{sheet_name} — Top Suppliers",
                })
            for sc in status_cols:
                if sup_amount:
                    calculations.append({
                        "calculator": "distribution",
                        "params": {"source_sheet": sheet_name, "category_col": sc, "value_col": sup_amount},
                        "label": f"{sheet_name} — by {sc}",
                    })

        # ── EXPENSE SHEET ──
        elif sheet_type == "expense":
            exp_amount = expense_cols[0] if expense_cols else None
            if not exp_amount:
                for cn in cols:
                    if cn.lower() in ("amount", "expense_amount", "total"):
                        exp_amount = cn
                        break
            if exp_amount:
                for cc in cat_cols[:3]:
                    calculations.append({
                        "calculator": "distribution",
                        "params": {"source_sheet": sheet_name, "category_col": cc, "value_col": exp_amount},
                        "label": f"{sheet_name} — Expense by {cc}",
                    })
                if date_col:
                    calculations.append({
                        "calculator": "trend",
                        "params": {"source_sheet": sheet_name, "date_col": date_col, "value_col": exp_amount},
                        "label": f"{sheet_name} — Expense Trend",
                    })
                for sc in status_cols:
                    calculations.append({
                        "calculator": "distribution",
                        "params": {"source_sheet": sheet_name, "category_col": sc, "value_col": exp_amount},
                        "label": f"{sheet_name} — Expense by {sc}",
                    })

        # ── TARGET, INVENTORY, MASTER, REFERENCE: skip per-sheet (handled in cross-sheet) ──

    # ── Cross-sheet: Target Variance (sales × target) ──
    if sales_sheets and target_sheets:
        sales_sn = sales_sheets[0]
        target_sn = target_sheets[0]
        s_cols = sheets[sales_sn]["columns"]
        t_cols = sheets[target_sn]["columns"]
        s_rev = next((c for c, i in s_cols.items() if i.get("role") == "revenue"), None)
        t_target = next((c for c, i in t_cols.items() if i.get("role") == "target"), None)
        if s_rev and t_target:
            s_cats = [c for c, i in s_cols.items() if i.get("role") in ("category", "date")]
            t_cats = [c for c, i in t_cols.items() if i.get("role") in ("category", "date")]
            common_joins = [c for c in s_cats if c in t_cats]
            s_date = next((c for c, i in s_cols.items() if i.get("role") == "date"), None)
            t_period = next((c for c in t_cats if "period" in c.lower()), None)
            tv_params = {"actual_sheet": sales_sn, "target_sheet": target_sn,
                         "actual_col": s_rev, "target_col": t_target, "aggregate": "sum"}
            if common_joins:
                tv_params["join_cols"] = common_joins[:3]
            elif t_period and s_date:
                tv_params["join_cols"] = [t_period]
                tv_params["date_col"] = s_date
                s_cat_names = {c for c, i in s_cols.items() if i.get("role") == "category"}
                t_cat_names = {c for c, i in t_cols.items() if i.get("role") == "category"}
                extra = list(s_cat_names & t_cat_names)
                if extra:
                    tv_params["join_cols"] = [t_period] + extra[:2]
            if tv_params.get("join_cols"):
                calculations.append({"calculator": "target_variance", "params": tv_params,
                                     "label": "Actual vs Target Variance"})

    # ── Cross-sheet: Gross Margin (sales × inventory) ──
    if sales_sheets and inv_sheets:
        sales_sn = sales_sheets[0]
        inv_sn = inv_sheets[0]
        s_cols = sheets[sales_sn]["columns"]
        i_cols = sheets[inv_sn]["columns"]
        s_rev = next((c for c, i in s_cols.items() if i.get("role") == "revenue"), None)
        i_cost = next((c for c, i in i_cols.items() if i.get("role") == "cost"), None)
        s_ids = [c for c, i in s_cols.items() if i.get("role") == "id"]
        i_ids = [c for c, i in i_cols.items() if i.get("role") == "id"]
        common_ids = set(s_ids) & set(i_ids)
        has_same_sheet_margin = any(c["calculator"] == "gross_margin" for c in calculations)
        if s_rev and i_cost and common_ids and not has_same_sheet_margin:
            join_col = list(common_ids)[0]
            s_qty = [c for c, i in s_cols.items() if i.get("role") == "quantity"]
            calculations.append({
                "calculator": "gross_margin",
                "params": {"sales_sheet": sales_sn, "cost_sheet": inv_sn,
                           "revenue_col": s_rev, "cogs_col": i_cost,
                           "join_col": join_col, "qty_col": s_qty[0] if s_qty else None},
                "label": "Cross-sheet Gross Margin (Sales x Inventory)",
            })

    # ── Cross-sheet: Inventory Coverage ──
    if inv_sheets and sales_sheets:
        inv_sn = inv_sheets[0]
        sales_sn = sales_sheets[0]
        i_cols = sheets[inv_sn]["columns"]
        s_cols = sheets[sales_sn]["columns"]
        on_hand = next((c for c in i_cols if any(kw in c.lower() for kw in ("on_hand", "qty_on_hand", "stock"))), None)
        s_qty = next((c for c, i in s_cols.items() if i.get("role") == "quantity"), None)
        s_date = next((c for c, i in s_cols.items() if i.get("role") == "date"), None)
        s_ids = [c for c, i in s_cols.items() if i.get("role") == "id"]
        i_ids = [c for c, i in i_cols.items() if i.get("role") == "id"]
        common_ids = set(s_ids) & set(i_ids)
        if on_hand and s_qty and s_date and common_ids:
            join_col = list(common_ids)[0]
            calculations.append({
                "calculator": "inventory_coverage",
                "params": {"inventory_sheet": inv_sn, "sales_sheet": sales_sn,
                           "product_col": join_col, "on_hand_col": on_hand,
                           "demand_col": s_qty, "date_col": s_date},
                "label": "Inventory Coverage Days",
            })

    return {"calculations": calculations} if calculations else None


def build_kpi_prompt(profile, selected_calculators=None):
    """
    Build system + user prompt for LLM to return JSON calculator config.
    If selected_calculators is provided, only include those in the prompt.
    Returns (system_prompt, user_prompt).
    """
    calcs_to_show = SUPPORTED_CALCULATORS
    if selected_calculators:
        calcs_to_show = {k: v for k, v in SUPPORTED_CALCULATORS.items() if k in selected_calculators}

    calc_desc = "\n".join(
        f"  {name}:\n    {info['description']}\n    params: {json.dumps({k: v for k, v in info['params'].items()}, indent=6)}"
        for name, info in calcs_to_show.items()
    )

    system_prompt = f"""You are a business analyst configuring KPI calculations.
You receive a data profile (sheets, columns, types, sample values).
Return a JSON config that tells the KPI calculator engine what to compute.

AVAILABLE CALCULATORS:
{calc_desc}

RESPONSE FORMAT — return ONLY valid JSON:
{{
  "calculations": [
    {{
      "calculator": "calculator_name",
      "params": {{...calculator-specific params...}},
      "label": "Human-readable label for the output table"
    }},
    ...
  ]
}}

RULES:
1. Use ONLY calculators from the list above. Do not invent new ones.
2. Map column names EXACTLY as they appear in the data profile.
3. Include ALL applicable calculators based on the available data.
4. For revenue_summary: create separate entries for each useful grouping (by month, by region, by category, by product, etc.)
5. For gross_margin: if a separate cost/inventory sheet exists with unit_cost, use join. If cost columns are in the same sheet, set cost_sheet = sales_sheet.
6. For target_variance: only include if a target/budget sheet exists. Set aggregate="sum" since actual is detail-level. If actual has a date column but no "month" column, set date_col so the calculator can derive periods.
7. For top_n: include for customers, products, suppliers — any entity with an associated metric.
8. For trend: use the primary date column and main revenue/amount column.
9. For distribution: include for status, channel, payment_status — any useful categorical breakdown.
10. NEVER write Python code. Return ONLY the JSON config.
11. Each calculator call produces one or more output tables. Use descriptive labels.
12. MULTI-CURRENCY: if a currency column exists with multiple distinct values, set currency_col in revenue_summary, gross_margin, top_n, distribution, and ap_aging. Results will be split by currency automatically. NEVER mix currencies in aggregation — always set currency_col when the data has multiple currencies.
13. PERIOD COMPARISON: prefer mode="MoM" with date_col over explicit current_period/prior_period. The calculator auto-detects the latest period. Use MoM for monthly, QoQ for quarterly, YoY for yearly.
14. For period_comparison: can be used on ANY sheet (sales, expenses, etc.), not just revenue. Include it for expense analysis too if date data exists.
15. For gross_margin with SEPARATE revenue and cost sheets: use join_col as a list of shared columns (e.g., ["period", "region"]). The calculator aggregates both sides before joining. Do NOT use qty_col when costs are already totals. IMPORTANT: if the cost sheet has multiple cost categories (e.g., Infrastructure, Personnel, Marketing, G&A, R&D), set cogs_filter_col and cogs_filter_value to select ONLY direct costs (typically Infrastructure/Hosting for SaaS, or COGS/Raw Materials for manufacturing). Do NOT include all operating expenses as COGS.
16. For ratio: use for any rate calculation (churn_rate = churned_count / total_count * 100, conversion_rate, fill_rate, etc.). Set multiply_by=100 for percentage output.
17. For weighted_sum: use for weighted pipeline (deal_value * probability), weighted scores, etc.
18. For avg_by_group: use for ARPU, avg resolution time, avg deal size — any metric averaged per entity.
19. Use filter_col + filter_value when calculation should only include a subset (e.g., status='Active' for MRR, status='Won' for revenue).

RESPOND WITH ONLY VALID JSON. No markdown fences, no explanation."""

    user_prompt = "## Data Profile\n\n"
    for sheet_name, sp in profile["sheets"].items():
        user_prompt += f"### Sheet: {sheet_name} ({sp['row_count']} rows)\n"
        for col_name, ci in sp["columns"].items():
            parts = [f"role={ci['role']}", f"dtype={ci.get('dtype', '?')}"]
            if ci.get("stats"):
                parts.append(f"range=[{ci['stats']['min']} .. {ci['stats']['max']}]")
            if ci.get("date_range"):
                parts.append(f"range={ci['date_range']}")
            if ci.get("values"):
                parts.append(f"values={ci['values'][:10]}")
            if ci.get("sample"):
                parts.append(f"sample={ci['sample']}")
            user_prompt += f"  {col_name}: {', '.join(parts)}\n"
        user_prompt += "\n"

    if profile.get("cross_sheet_joins"):
        user_prompt += "### Cross-Sheet Join Candidates\n"
        for j in profile["cross_sheet_joins"]:
            user_prompt += f"  {j['column_1']} <-> {j['column_2']} (overlap: {j['overlap_pct']}%)\n"
        user_prompt += "\n"

    return system_prompt, user_prompt


# ================================================================
# Part 3: KPI CALCULATOR ENGINE
# ================================================================

class KpiCalculator:
    """
    Deterministic KPI calculator engine.
    Executes pre-built calculator functions based on JSON config from LLM.
    """

    def __init__(self, sheets):
        """sheets: dict of {name: pd.DataFrame}"""
        # Force all numeric-looking columns to numeric dtype (defense against object dtype)
        self.sheets = {}
        for name, df in sheets.items():
            df = df.copy()
            for col in df.columns:
                if pd.api.types.is_string_dtype(df[col]) or df[col].dtype == object:
                    coerced = pd.to_numeric(df[col], errors="coerce")
                    # If >50% of non-null values converted successfully, use numeric version
                    non_null = df[col].dropna()
                    if len(non_null) > 0 and coerced.notna().sum() / len(non_null) > 0.5:
                        df[col] = coerced
            self.sheets[name] = df
        self.log = []
        self.result_summary = {}

    def calculate(self, config):
        """
        Execute all calculations from LLM config.

        Parameters:
            config: {"calculations": [...]} from LLM

        Returns:
            {
                "result": {summary_key: value, ...},
                "artifacts": [{"type": "table", "label": str, "data": [row_dicts]}],
            }
        """
        calculations = config.get("calculations", [])
        all_artifacts = []
        used_labels = set()

        for calc in calculations:
            name = calc.get("calculator")
            if name not in SUPPORTED_CALCULATORS:
                self.log.append({"action": "skip_unknown", "calculator": name})
                continue

            handler = getattr(self, f"_calc_{name}", None)
            if not handler:
                self.log.append({"action": "skip_no_handler", "calculator": name})
                continue

            try:
                label = calc.get("label", name)
                params = calc.get("params", {})
                artifacts = handler(params, label)
                # Deduplicate labels
                for a in artifacts:
                    base = a["label"]
                    lbl = base
                    i = 2
                    while lbl in used_labels:
                        lbl = f"{base} ({i})"
                        i += 1
                    a["label"] = lbl
                    used_labels.add(lbl)
                all_artifacts.extend(artifacts)
                self.log.append({
                    "action": "calculated", "calculator": name, "label": label,
                    "artifacts": len(artifacts), "params_used": params,
                })
            except Exception as e:
                self.log.append({"action": "error", "calculator": name, "error": str(e)[:200]})

        # Add column mapping metadata artifact for transparency
        mapping_rows = []
        for calc in calculations:
            name = calc.get("calculator", "")
            p = calc.get("params", {})
            row = {"calculator": name, "label": calc.get("label", "")}
            # Extract key column mappings
            for key in ["source_sheet", "sales_sheet", "cost_sheet", "inventory_sheet",
                         "actual_sheet", "target_sheet",
                         "amount_col", "revenue_col", "cogs_col", "qty_col",
                         "value_col", "date_col", "currency_col",
                         "join_col", "group_col", "category_col"]:
                if key in p:
                    val = p[key]
                    row[key] = str(val) if not isinstance(val, str) else val
            mapping_rows.append(row)

        if mapping_rows:
            all_artifacts.append({
                "type": "table",
                "label": "Column Mapping (verify)",
                "data": mapping_rows,
            })

        # Build summary for narrative (top findings only, not all tables)
        summary_lines = []
        for a in all_artifacts[:15]:
            if a.get("label", "").startswith("Column Mapping"):
                continue
            data = a.get("data", [])
            if not data:
                continue
            if len(data) == 1 and isinstance(data[0], dict):
                # Single-row summary (e.g., Overall Revenue)
                vals = ", ".join(f"{k}={v}" for k, v in data[0].items() if v is not None)
                summary_lines.append(f"{a['label']}: {vals}")
            elif len(data) <= 5:
                summary_lines.append(f"{a['label']}: {len(data)} rows — top: {data[0]}")
            else:
                summary_lines.append(f"{a['label']}: {len(data)} rows")

        return {
            "result": self.result_summary,
            "artifacts": all_artifacts,
            "summary_for_narrative": "\n".join(summary_lines[:10]),
        }

    # -- Helper methods --

    def _get_sheet(self, name):
        if name not in self.sheets:
            raise ValueError(f"Sheet '{name}' not found. Available: {list(self.sheets.keys())}")
        return self.sheets[name]

    def _require_cols(self, df, cols, context=""):
        missing = [c for c in cols if c not in df.columns]
        if missing:
            raise ValueError(f"Missing columns {missing} in {context}. Available: {list(df.columns)}")

    def _to_numeric(self, series):
        return pd.to_numeric(series, errors="coerce")

    def _safe_div(self, a, b):
        """Division guarding against zero."""
        if b == 0 or pd.isna(b):
            return None
        return a / b

    def _nan_safe_records(self, df):
        """Convert DataFrame to records, replacing NaN with None for JSON safety."""
        return df.where(df.notna(), None).to_dict("records")

    # -- Calculator implementations --

    def _calc_revenue_summary(self, params, label):
        sheet = self._get_sheet(params["source_sheet"])
        amount_col = params["amount_col"]
        currency_col = params.get("currency_col")
        self._require_cols(sheet, [amount_col], params["source_sheet"])

        amount = self._to_numeric(sheet[amount_col])

        # Check multi-currency
        multi_currency = False
        if currency_col and currency_col in sheet.columns:
            currencies = sheet[currency_col].dropna().unique()
            multi_currency = len(currencies) > 1

        if multi_currency:
            # Split by currency
            overall_rows = []
            for cur in sorted(currencies):
                mask = sheet[currency_col] == cur
                cur_total = float(self._to_numeric(sheet.loc[mask, amount_col]).sum())
                overall_rows.append({"currency": cur, "total_revenue": round(cur_total, 2), "transactions": int(mask.sum())})
            artifacts = [{"type": "table", "label": "Overall Revenue by Currency", "data": overall_rows}]
            self.result_summary["total_revenue_by_currency"] = {r["currency"]: r["total_revenue"] for r in overall_rows}
        else:
            total = float(amount.sum())
            if "total_revenue" not in self.result_summary:
                self.result_summary["total_revenue"] = round(total, 2)
            artifacts = [{"type": "table", "label": "Overall Revenue", "data": [{"metric": "Total Revenue", "value": round(total, 2)}]}]

        # Grouped breakdowns
        group_by_cols = params.get("group_by_cols", [])
        for col in group_by_cols:
            if col not in sheet.columns:
                continue
            group_keys = [col] + ([currency_col] if multi_currency else [])
            grouped = sheet.groupby(group_keys, dropna=False).agg(
                revenue=(amount_col, lambda x: round(self._to_numeric(x).sum(), 2)),
                transactions=(amount_col, "count"),
            ).reset_index()
            grouped = grouped.sort_values("revenue", ascending=False)
            artifacts.append({
                "type": "table",
                "label": f"Revenue by {col}" + (" by Currency" if multi_currency else ""),
                "data": self._nan_safe_records(grouped),
            })

        return artifacts

    def _calc_gross_margin(self, params, label):
        sales_df = self._get_sheet(params["sales_sheet"])
        cost_sheet = params.get("cost_sheet", params["sales_sheet"])
        cost_df = self._get_sheet(cost_sheet)

        revenue_col = params["revenue_col"]
        cogs_col = params["cogs_col"]
        qty_col = params.get("qty_col")
        join_col = params.get("join_col")
        group_by = params.get("group_by", [])
        currency_col = params.get("currency_col")
        filter_col = params.get("filter_col")
        filter_value = params.get("filter_value")
        cogs_filter_col = params.get("cogs_filter_col")
        cogs_filter_value = params.get("cogs_filter_value")

        self._require_cols(sales_df, [revenue_col], params["sales_sheet"])
        self._require_cols(cost_df, [cogs_col], cost_sheet)

        # Apply optional filter (e.g., status='Active')
        if filter_col and filter_value and filter_col in sales_df.columns:
            sales_df = sales_df[sales_df[filter_col].astype(str) == str(filter_value)].copy()

        # Determine join columns
        if cost_sheet != params["sales_sheet"] and join_col:
            if isinstance(join_col, dict):
                left_cols = join_col["left"] if isinstance(join_col["left"], list) else [join_col["left"]]
                right_cols = join_col["right"] if isinstance(join_col["right"], list) else [join_col["right"]]
            elif isinstance(join_col, list):
                left_cols = right_cols = join_col
            else:
                left_cols = right_cols = [join_col]
            self._require_cols(sales_df, left_cols, params["sales_sheet"])
            self._require_cols(cost_df, right_cols, cost_sheet)
            cross_sheet = True
        else:
            cross_sheet = False

        # Currency handling
        currency_keys = []
        if currency_col:
            if currency_col in sales_df.columns:
                currency_keys = [currency_col]

        if cross_sheet:
            # ── CROSS-SHEET: aggregate BOTH sides first, then join on aggregated results ──
            # Revenue side: group by join_cols (+ currency)
            rev_group = left_cols + currency_keys
            rev_agg = sales_df.copy()
            rev_agg[revenue_col] = self._to_numeric(rev_agg[revenue_col])
            rev_summed = rev_agg.groupby(rev_group, dropna=False)[revenue_col].sum().reset_index()
            rev_summed = rev_summed.rename(columns={revenue_col: "_revenue"})

            # Cost side: apply optional cogs_filter (e.g., cost_type='Infrastructure')
            cost_filtered = cost_df.copy()
            if cogs_filter_col and cogs_filter_value and cogs_filter_col in cost_filtered.columns:
                if isinstance(cogs_filter_value, list):
                    cost_filtered = cost_filtered[cost_filtered[cogs_filter_col].isin(cogs_filter_value)]
                else:
                    cost_filtered = cost_filtered[cost_filtered[cogs_filter_col].astype(str) == str(cogs_filter_value)]

            cost_currency = [currency_col] if currency_col and currency_col in cost_filtered.columns else []
            cost_group = right_cols + cost_currency
            cost_agg = cost_filtered
            cost_agg[cogs_col] = self._to_numeric(cost_agg[cogs_col])
            cost_summed = cost_agg.groupby(cost_group, dropna=False)[cogs_col].sum().reset_index()
            cost_summed = cost_summed.rename(columns={cogs_col: "_cogs"})

            # Join aggregated results
            df = rev_summed.merge(cost_summed, left_on=rev_group, right_on=cost_group, how="left")
            df["_cogs"] = df["_cogs"].fillna(0)
            df["_profit"] = df["_revenue"] - df["_cogs"]
        else:
            # ── SAME SHEET: revenue and cost columns in same row ──
            df = sales_df.copy()
            df["_revenue"] = self._to_numeric(df[revenue_col])
            raw_cost = self._to_numeric(df[cogs_col])
            if qty_col and qty_col in df.columns:
                df["_cogs"] = raw_cost * self._to_numeric(df[qty_col])
            else:
                df["_cogs"] = raw_cost
            df["_profit"] = df["_revenue"] - df["_cogs"]

        # Multi-currency check
        multi_currency = bool(currency_keys) and currency_col in df.columns and df[currency_col].nunique() > 1

        # Build margin artifacts
        def _build_margin_row(sub_df):
            rev = float(sub_df["_revenue"].sum())
            cogs = float(sub_df["_cogs"].sum())
            profit = float(sub_df["_profit"].sum())
            pct = self._safe_div(profit, rev) * 100 if rev else None
            return {
                "total_revenue": round(rev, 2),
                "total_cogs": round(cogs, 2),
                "gross_margin": round(profit, 2),
                "margin_pct": round(pct, 2) if pct is not None else None,
            }

        # Sanity check: if COGS > 3x revenue on cross-sheet join, flag as warning
        if cross_sheet:
            total_rev_check = float(df["_revenue"].sum())
            total_cogs_check = float(df["_cogs"].sum())
            if total_rev_check > 0 and total_cogs_check > total_rev_check * 3:
                self.log.append({
                    "action": "warning", "calculator": "gross_margin",
                    "message": f"COGS ({total_cogs_check:,.0f}) exceeds revenue ({total_rev_check:,.0f}) by "
                               f"{total_cogs_check/total_rev_check:.1f}x. "
                               f"Verify cost definition — set cogs_filter_col/cogs_filter_value to select only direct costs.",
                })

        # Overall
        if multi_currency:
            overall_rows = []
            for cur in sorted(df[currency_col].dropna().unique()):
                row = _build_margin_row(df[df[currency_col] == cur])
                row["currency"] = cur
                overall_rows.append(row)
            artifacts = [{"type": "table", "label": "Overall Gross Margin by Currency", "data": overall_rows}]
        else:
            row = _build_margin_row(df)
            if "gross_margin" not in self.result_summary:
                self.result_summary["gross_margin"] = row["gross_margin"]
                self.result_summary["gross_margin_pct"] = row["margin_pct"]
            artifacts = [{"type": "table", "label": "Overall Gross Margin", "data": [row]}]

        # Grouped margin breakdowns
        for col in group_by:
            if col not in df.columns:
                continue
            group_keys = [col] + ([currency_col] if multi_currency else [])
            g = df.groupby(group_keys, dropna=False).agg(
                total_revenue=("_revenue", "sum"),
                total_cogs=("_cogs", "sum"),
                gross_margin=("_profit", "sum"),
            ).reset_index()
            g["margin_pct"] = (g["gross_margin"] / g["total_revenue"].clip(lower=0.01) * 100).round(2)
            for c in ["total_revenue", "total_cogs", "gross_margin"]:
                g[c] = g[c].round(2)
            g = g.sort_values("total_revenue", ascending=False)
            artifacts.append({
                "type": "table",
                "label": f"Margin by {col}" + (" by Currency" if multi_currency else ""),
                "data": self._nan_safe_records(g),
            })

        return artifacts

    def _calc_inventory_coverage(self, params, label):
        inv_df = self._get_sheet(params["inventory_sheet"])
        sales_df = self._get_sheet(params["sales_sheet"])

        product_col = params["product_col"]
        on_hand_col = params["on_hand_col"]
        demand_col = params["demand_col"]
        date_col = params["date_col"]

        if isinstance(product_col, dict):
            inv_prod = product_col.get("inventory", product_col.get("right"))
            sales_prod = product_col.get("sales", product_col.get("left"))
        else:
            inv_prod = sales_prod = product_col

        self._require_cols(inv_df, [inv_prod, on_hand_col], params["inventory_sheet"])
        self._require_cols(sales_df, [sales_prod, demand_col, date_col], params["sales_sheet"])

        # Compute period length from sales dates
        dates = pd.to_datetime(sales_df[date_col], errors="coerce").dropna()
        if len(dates) < 2:
            raise ValueError(f"Not enough dates in {date_col} to compute period")
        period_days = max((dates.max() - dates.min()).days, 1)

        # Total demand per product over entire period
        demand_by_product = (
            sales_df.groupby(sales_prod)[demand_col]
            .apply(lambda x: self._to_numeric(x).sum())
            .reset_index()
            .rename(columns={demand_col: "total_demand"})
        )
        demand_by_product["avg_daily_demand"] = (demand_by_product["total_demand"] / period_days).round(4)

        # Aggregate inventory per product (sum across warehouses)
        inv_by_product = (
            inv_df.groupby(inv_prod)
            .agg(on_hand=(on_hand_col, lambda x: self._to_numeric(x).sum()))
            .reset_index()
        )

        # Join
        if inv_prod != sales_prod:
            merged = inv_by_product.merge(demand_by_product, left_on=inv_prod, right_on=sales_prod, how="left")
        else:
            merged = inv_by_product.merge(demand_by_product, on=inv_prod, how="left")

        merged["coverage_days"] = merged.apply(
            lambda r: round(self._safe_div(r["on_hand"], r["avg_daily_demand"]), 1)
            if r["avg_daily_demand"] and r["avg_daily_demand"] > 0 else None, axis=1
        )
        merged = merged.sort_values("coverage_days", ascending=True, na_position="last")

        return [{
            "type": "table",
            "label": label,
            "data": self._nan_safe_records(merged),
        }]

    def _calc_period_comparison(self, params, label):
        df = self._get_sheet(params["source_sheet"])
        date_col = params.get("date_col")
        mode = params.get("mode")  # MoM, YoY, QoQ
        current = params.get("current_period")
        prior = params.get("prior_period")
        value_cols = params["value_cols"]
        group_by = params.get("group_by", [])

        # Auto-detect periods from date column + mode
        if mode and date_col and date_col in df.columns:
            dates = pd.to_datetime(df[date_col], errors="coerce").dropna()
            if len(dates) == 0:
                raise ValueError(f"No valid dates in {date_col}")

            latest = dates.max()
            if mode == "MoM":
                current = latest.strftime("%Y-%m")
                prior_date = latest - pd.DateOffset(months=1)
                prior = prior_date.strftime("%Y-%m")
                df["_period"] = pd.to_datetime(df[date_col], errors="coerce").dt.strftime("%Y-%m")
            elif mode == "YoY":
                current = latest.strftime("%Y-%m")
                prior_date = latest - pd.DateOffset(years=1)
                prior = prior_date.strftime("%Y-%m")
                df["_period"] = pd.to_datetime(df[date_col], errors="coerce").dt.strftime("%Y-%m")
            elif mode == "QoQ":
                current = f"{latest.year}-Q{(latest.month - 1) // 3 + 1}"
                prior_q = latest - pd.DateOffset(months=3)
                prior = f"{prior_q.year}-Q{(prior_q.month - 1) // 3 + 1}"
                df["_period"] = pd.to_datetime(df[date_col], errors="coerce").apply(
                    lambda d: f"{d.year}-Q{(d.month - 1) // 3 + 1}" if pd.notna(d) else None
                )
            else:
                raise ValueError(f"Unknown mode: {mode}. Use MoM, YoY, or QoQ.")
            period_col = "_period"
        else:
            period_col = params.get("period_col", params.get("date_col"))
            if not period_col:
                raise ValueError("Need either date_col+mode or period_col+current_period+prior_period")

        if not current or not prior:
            raise ValueError("Could not determine current/prior periods")

        self._require_cols(df, [c for c in [period_col] + value_cols if c in df.columns], params["source_sheet"])

        df_current = df[df[period_col].astype(str) == str(current)]
        df_prior = df[df[period_col].astype(str) == str(prior)]

        agg_cols = {col: (col, lambda x: self._to_numeric(x).sum()) for col in value_cols}

        if group_by:
            self._require_cols(df, group_by, params["source_sheet"])
            cur_agg = df_current.groupby(group_by).agg(**agg_cols).reset_index()
            pri_agg = df_prior.groupby(group_by).agg(**agg_cols).reset_index()
            merged = cur_agg.merge(pri_agg, on=group_by, how="outer", suffixes=("_current", "_prior"))
        else:
            cur_vals = {col: float(self._to_numeric(df_current[col]).sum()) for col in value_cols}
            pri_vals = {col: float(self._to_numeric(df_prior[col]).sum()) for col in value_cols}
            rows = []
            for col in value_cols:
                c, p = cur_vals[col], pri_vals[col]
                delta = c - p
                pct = self._safe_div(delta, abs(p)) * 100 if p else None
                rows.append({
                    "metric": col,
                    "current": round(c, 2),
                    "prior": round(p, 2),
                    "delta": round(delta, 2),
                    "delta_pct": round(pct, 2) if pct is not None else None,
                })
            return [{"type": "table", "label": label, "data": rows}]

        # With group_by: compute deltas per group
        result_rows = []
        for _, row in merged.iterrows():
            r = {col: row[col] for col in group_by}
            for col in value_cols:
                c_key = f"{col}_current"
                p_key = f"{col}_prior"
                c_val = float(row.get(c_key, 0) or 0)
                p_val = float(row.get(p_key, 0) or 0)
                r[f"{col}_current"] = round(c_val, 2)
                r[f"{col}_prior"] = round(p_val, 2)
                r[f"{col}_delta"] = round(c_val - p_val, 2)
                r[f"{col}_delta_pct"] = round(self._safe_div(c_val - p_val, abs(p_val)) * 100, 2) if p_val else None
            result_rows.append(r)

        return [{"type": "table", "label": label, "data": result_rows}]

    def _calc_target_variance(self, params, label):
        actual_df = self._get_sheet(params["actual_sheet"])
        target_df = self._get_sheet(params["target_sheet"])
        join_cols = params["join_cols"]
        actual_col = params["actual_col"]
        target_col = params["target_col"]
        agg_fn = params.get("aggregate", "sum")
        filter_col = params.get("filter_col")
        filter_value = params.get("filter_value")

        actual_df = actual_df.copy()

        # Apply optional filter (e.g., status='Active' for MRR)
        if filter_col and filter_value and filter_col in actual_df.columns:
            actual_df = actual_df[actual_df[filter_col].astype(str) == str(filter_value)]

        # If a join_col is "month" but only exists in target, derive it from date_col in actual
        date_col = params.get("date_col")
        for jc in join_cols:
            if jc not in actual_df.columns and date_col and date_col in actual_df.columns:
                # Derive period column from date
                dates = pd.to_datetime(actual_df[date_col], errors="coerce")
                if jc == "month" or "month" in jc.lower():
                    actual_df[jc] = dates.dt.strftime("%Y-%m")
                elif jc == "quarter" or "quarter" in jc.lower():
                    actual_df[jc] = dates.apply(lambda d: f"{d.year}-Q{(d.month-1)//3+1}" if pd.notna(d) else None)
                elif jc == "year" or "year" in jc.lower():
                    actual_df[jc] = dates.dt.strftime("%Y")

        self._require_cols(actual_df, join_cols + [actual_col], params["actual_sheet"])
        self._require_cols(target_df, join_cols + [target_col], params["target_sheet"])

        # Aggregate actuals by join columns (actual is detail-level, target is summary)
        agg_map = {"sum": "sum", "count": "count", "mean": "mean"}
        pandas_agg = agg_map.get(agg_fn, "sum")
        actual_numeric = actual_df.copy()
        actual_numeric[actual_col] = self._to_numeric(actual_numeric[actual_col])
        actual_agg = (
            actual_numeric.groupby(join_cols)[actual_col]
            .agg(pandas_agg)
            .reset_index()
            .rename(columns={actual_col: "actual"})
        )

        # Targets — also aggregate by join_cols in case target sheet has multiple rows per key
        target_subset = target_df[join_cols + [target_col]].copy()
        target_subset[target_col] = self._to_numeric(target_subset[target_col])
        target_agg = (
            target_subset.groupby(join_cols)[target_col]
            .sum()
            .reset_index()
            .rename(columns={target_col: "target"})
        )

        # Inner join on target — only show rows where target exists and > 0
        merged = actual_agg.merge(target_agg, on=join_cols, how="inner")
        merged["actual"] = merged["actual"].fillna(0).round(2)
        merged["target"] = merged["target"].fillna(0).round(2)
        # Filter out zero targets (no meaningful comparison)
        merged = merged[merged["target"].abs() > 0].copy()
        merged["variance"] = (merged["actual"] - merged["target"]).round(2)
        merged["variance_pct"] = (merged["variance"] / merged["target"].abs() * 100).round(2)

        return [{"type": "table", "label": label, "data": self._nan_safe_records(merged)}]

    def _calc_ap_aging(self, params, label):
        df = self._get_sheet(params["source_sheet"])
        inv_date_col = params["invoice_date_col"]
        due_date_col = params["due_date_col"]
        amount_col = params["amount_col"]
        group_by = params.get("group_by")
        currency_col = params.get("currency_col")
        as_of = params.get("as_of_date")

        self._require_cols(df, [inv_date_col, due_date_col, amount_col], params["source_sheet"])

        df = df.copy()
        df["_due"] = pd.to_datetime(df[due_date_col], errors="coerce")
        df["_amount"] = self._to_numeric(df[amount_col])

        if as_of:
            ref_date = pd.to_datetime(as_of)
        else:
            ref_date = df["_due"].max()
            if pd.isna(ref_date):
                ref_date = pd.Timestamp.now()

        df["_days_past_due"] = (ref_date - df["_due"]).dt.days

        def bucket(days):
            if pd.isna(days) or days < 0:
                return "Current"
            if days <= 30:
                return "1-30 days"
            if days <= 60:
                return "31-60 days"
            if days <= 90:
                return "61-90 days"
            return "90+ days"

        df["_bucket"] = df["_days_past_due"].apply(bucket)

        # Multi-currency: split by currency
        multi_currency = currency_col and currency_col in df.columns and df[currency_col].nunique() > 1

        def _aging_from(sub_df):
            if group_by and group_by in sub_df.columns:
                pivot = sub_df.groupby([group_by, "_bucket"])["_amount"].sum().reset_index()
                pivot.columns = [group_by, "aging_bucket", "amount"]
                pivot["amount"] = pivot["amount"].round(2)
                return self._nan_safe_records(pivot.sort_values([group_by, "aging_bucket"]))
            else:
                agg = sub_df.groupby("_bucket")["_amount"].agg(["sum", "count"]).reset_index()
                agg.columns = ["aging_bucket", "total_amount", "invoice_count"]
                agg["total_amount"] = agg["total_amount"].round(2)
                return self._nan_safe_records(agg)

        if multi_currency:
            artifacts = []
            for cur in sorted(df[currency_col].dropna().unique()):
                sub = df[df[currency_col] == cur]
                result = _aging_from(sub)
                artifacts.append({"type": "table", "label": f"{label} ({cur})", "data": result})
            return artifacts
        else:
            return [{"type": "table", "label": label, "data": _aging_from(df)}]

    def _calc_top_n(self, params, label):
        df = self._get_sheet(params["source_sheet"])
        group_col = params["group_col"]
        value_col = params["value_col"]
        agg = params.get("agg", "sum")
        n = params.get("n", 10)
        currency_col = params.get("currency_col")

        self._require_cols(df, [group_col, value_col], params["source_sheet"])

        # Multi-currency: split by currency
        multi_currency = currency_col and currency_col in df.columns and df[currency_col].nunique() > 1

        def _top_from(sub_df):
            numeric_vals = self._to_numeric(sub_df[value_col])
            if agg == "sum":
                grouped = numeric_vals.groupby(sub_df[group_col]).sum()
            elif agg == "count":
                grouped = numeric_vals.groupby(sub_df[group_col]).count()
            elif agg == "mean":
                grouped = numeric_vals.groupby(sub_df[group_col]).mean()
            else:
                grouped = numeric_vals.groupby(sub_df[group_col]).sum()
            top = grouped.nlargest(n).reset_index()
            top.columns = [group_col, value_col]
            top[value_col] = top[value_col].round(2)
            return top

        if multi_currency:
            artifacts = []
            for cur in sorted(df[currency_col].dropna().unique()):
                sub = df[df[currency_col] == cur]
                top = _top_from(sub)
                top["currency"] = cur
                artifacts.append({
                    "type": "table",
                    "label": f"{label} ({cur})",
                    "data": self._nan_safe_records(top),
                })
            return artifacts
        else:
            top = _top_from(df)
            return [{"type": "table", "label": label, "data": self._nan_safe_records(top)}]

    def _calc_distribution(self, params, label):
        df = self._get_sheet(params["source_sheet"])
        cat_col = params["category_col"]
        value_col = params.get("value_col")
        currency_col = params.get("currency_col")
        agg = params.get("agg", "sum" if value_col else "count")

        self._require_cols(df, [cat_col], params["source_sheet"])

        multi_currency = currency_col and currency_col in df.columns and df[currency_col].nunique() > 1

        def _dist_from(sub_df):
            if value_col and value_col in sub_df.columns:
                numeric_vals = self._to_numeric(sub_df[value_col])
                if agg == "sum":
                    grouped = numeric_vals.groupby(sub_df[cat_col]).sum()
                elif agg == "mean":
                    grouped = numeric_vals.groupby(sub_df[cat_col]).mean()
                else:
                    grouped = sub_df.groupby(cat_col)[value_col].count()
                col_label = value_col
            else:
                grouped = sub_df.groupby(cat_col).size()
                col_label = "count"

            result = grouped.reset_index()
            result.columns = [cat_col, col_label]
            total = float(result[col_label].sum())
            result["percentage"] = (result[col_label] / total * 100).round(2) if total > 0 else 0
            if result[col_label].dtype in ["float64", "float32"]:
                result[col_label] = result[col_label].round(2)
            result = result.sort_values(col_label, ascending=False)
            return result

        if multi_currency:
            artifacts = []
            for cur in sorted(df[currency_col].dropna().unique()):
                sub = df[df[currency_col] == cur]
                result = _dist_from(sub)
                result["currency"] = cur
                artifacts.append({
                    "type": "table",
                    "label": f"{label} ({cur})",
                    "data": self._nan_safe_records(result),
                })
            return artifacts
        else:
            result = _dist_from(df)
            return [{"type": "table", "label": label, "data": self._nan_safe_records(result)}]

    def _calc_trend(self, params, label):
        df = self._get_sheet(params["source_sheet"])
        date_col = params["date_col"]
        value_col = params["value_col"]
        freq_raw = params.get("freq", "M")
        # Pandas >= 2.2 requires 'ME' for month-end, 'QE' for quarter-end
        freq_map = {"M": "ME", "Q": "QE", "Y": "YE"}
        freq = freq_map.get(freq_raw, freq_raw)
        agg = params.get("agg", "sum")

        self._require_cols(df, [date_col, value_col], params["source_sheet"])

        df = df.copy()
        df["_date"] = pd.to_datetime(df[date_col], errors="coerce")
        df["_value"] = self._to_numeric(df[value_col])
        df = df.dropna(subset=["_date", "_value"])

        if len(df) == 0:
            return [{"type": "table", "label": label, "data": []}]

        df = df.set_index("_date")
        if agg == "sum":
            resampled = df["_value"].resample(freq).sum()
        elif agg == "mean":
            resampled = df["_value"].resample(freq).mean()
        elif agg == "count":
            resampled = df["_value"].resample(freq).count()
        else:
            resampled = df["_value"].resample(freq).sum()

        result = resampled.reset_index()
        result.columns = ["period", value_col]
        result["period"] = result["period"].dt.strftime("%Y-%m-%d")
        result[value_col] = result[value_col].round(2)

        return [{"type": "table", "label": label, "data": self._nan_safe_records(result)}]

    def _calc_ratio(self, params, label):
        """Calculate ratio between two columns or two aggregated values across sheets."""
        source = params.get("source_sheet")
        numerator_col = params["numerator_col"]
        denominator_col = params["denominator_col"]
        group_by = params.get("group_by", [])
        filter_col = params.get("filter_col")
        filter_value = params.get("filter_value")
        multiply_by = params.get("multiply_by", 1)  # e.g., 100 for percentage

        # Support cross-sheet: numerator from one sheet, denominator from another
        num_sheet = params.get("numerator_sheet", source)
        den_sheet = params.get("denominator_sheet", source)

        num_df = self._get_sheet(num_sheet)
        den_df = self._get_sheet(den_sheet)
        self._require_cols(num_df, [numerator_col], num_sheet)
        self._require_cols(den_df, [denominator_col], den_sheet)

        if filter_col and filter_value:
            if filter_col in num_df.columns:
                num_df = num_df[num_df[filter_col].astype(str) == str(filter_value)]
            if filter_col in den_df.columns:
                den_df = den_df[den_df[filter_col].astype(str) == str(filter_value)]

        if group_by:
            # Group both, join, compute ratio
            valid_num_groups = [g for g in group_by if g in num_df.columns]
            valid_den_groups = [g for g in group_by if g in den_df.columns]
            if valid_num_groups and valid_den_groups:
                num_agg = num_df.groupby(valid_num_groups)[numerator_col].apply(
                    lambda x: self._to_numeric(x).sum()).reset_index().rename(columns={numerator_col: "numerator"})
                den_agg = den_df.groupby(valid_den_groups)[denominator_col].apply(
                    lambda x: self._to_numeric(x).sum()).reset_index().rename(columns={denominator_col: "denominator"})
                merged = num_agg.merge(den_agg, on=valid_num_groups, how="outer")
                merged["ratio"] = (merged["numerator"] / merged["denominator"].clip(lower=0.01) * multiply_by).round(2)
                return [{"type": "table", "label": label, "data": self._nan_safe_records(merged)}]

        # No grouping: single ratio
        num_val = float(self._to_numeric(num_df[numerator_col]).sum())
        den_val = float(self._to_numeric(den_df[denominator_col]).sum())
        ratio = self._safe_div(num_val, den_val)
        if ratio is not None:
            ratio = round(ratio * multiply_by, 2)
        self.result_summary[label.lower().replace(" ", "_")] = ratio
        return [{"type": "table", "label": label, "data": [{
            "numerator": round(num_val, 2), "denominator": round(den_val, 2), "ratio": ratio,
        }]}]

    def _calc_weighted_sum(self, params, label):
        """Calculate weighted sum: sum(value_col * weight_col)."""
        df = self._get_sheet(params["source_sheet"])
        value_col = params["value_col"]
        weight_col = params["weight_col"]
        group_by = params.get("group_by", [])
        filter_col = params.get("filter_col")
        filter_value = params.get("filter_value")

        self._require_cols(df, [value_col, weight_col], params["source_sheet"])

        if filter_col and filter_value and filter_col in df.columns:
            df = df[df[filter_col].astype(str) == str(filter_value)]

        df = df.copy()
        df["_weighted"] = self._to_numeric(df[value_col]) * self._to_numeric(df[weight_col])

        if group_by:
            valid_groups = [g for g in group_by if g in df.columns]
            if valid_groups:
                result = df.groupby(valid_groups).agg(
                    weighted_sum=("_weighted", "sum"),
                    total_weight=(weight_col, lambda x: self._to_numeric(x).sum()),
                ).reset_index()
                result["weighted_avg"] = (result["weighted_sum"] / result["total_weight"].clip(lower=0.01)).round(2)
                result["weighted_sum"] = result["weighted_sum"].round(2)
                result["total_weight"] = result["total_weight"].round(2)
                return [{"type": "table", "label": label, "data": self._nan_safe_records(result)}]

        total = float(df["_weighted"].sum())
        total_w = float(self._to_numeric(df[weight_col]).sum())
        avg = self._safe_div(total, total_w)
        return [{"type": "table", "label": label, "data": [{
            "weighted_sum": round(total, 2),
            "total_weight": round(total_w, 2),
            "weighted_avg": round(avg, 2) if avg else None,
        }]}]

    def _calc_avg_by_group(self, params, label):
        """Calculate average of a metric grouped by an entity."""
        df = self._get_sheet(params["source_sheet"])
        value_col = params["value_col"]
        group_col = params["group_col"]
        filter_col = params.get("filter_col")
        filter_value = params.get("filter_value")

        self._require_cols(df, [value_col, group_col], params["source_sheet"])

        if filter_col and filter_value and filter_col in df.columns:
            df = df[df[filter_col].astype(str) == str(filter_value)]

        numeric = self._to_numeric(df[value_col])
        result = numeric.groupby(df[group_col]).agg(["mean", "sum", "count"]).reset_index()
        result.columns = [group_col, "avg", "total", "count"]
        result["avg"] = result["avg"].round(2)
        result["total"] = result["total"].round(2)
        result = result.sort_values("total", ascending=False)

        overall_avg = round(float(numeric.mean()), 2)
        self.result_summary[f"avg_{value_col}"] = overall_avg

        return [{"type": "table", "label": label, "data": self._nan_safe_records(result)}]

    def get_log(self):
        return self.log


# ================================================================
# Part 4: PIPELINE ENTRY POINT
# ================================================================

def execute_kpi_pipeline(sheets_dict, call_llm_fn=None, llm_config=None):
    """
    Full KPI pipeline. Mirrors execute_cleaning_pipeline().

    Parameters:
        sheets_dict: {"sheet_name": [list of row dicts]}
        call_llm_fn: fn(system_prompt, user_prompt, config) -> raw string
        llm_config: dict

    Returns:
        {
            "result": {summary_key: value, ...},
            "artifacts": [{"type": "table", "label": str, "data": [...]}],
            "profile": {...},
            "config": {...},
        }
    """
    # Stage 0: Profile
    profile = profile_for_kpi(sheets_dict)

    # Stage 1: Deterministic config from profile (~0ms)
    kpi_config = build_kpi_config_from_profile(profile)

    # Stage 1b: LLM fallback ONLY if auto-detect produced nothing
    if not kpi_config and call_llm_fn:
        sys_prompt, usr_prompt = build_kpi_prompt(profile)
        for attempt in range(3):
            try:
                raw = call_llm_fn(sys_prompt, usr_prompt, llm_config)
                raw = raw.strip()
                s = raw.find("{")
                e = raw.rfind("}")
                if s != -1 and e != -1:
                    raw = raw[s:e + 1]
                raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
                raw = re.sub(r"\s*```$", "", raw.strip())
                kpi_config = json.loads(raw)
                break
            except (json.JSONDecodeError, Exception):
                if attempt == 2:
                    kpi_config = None

    if not kpi_config:
        return {
            "result": {},
            "artifacts": [],
            "profile": profile,
            "config": None,
            "error": "Failed to build KPI config (auto-detect and LLM both failed)",
        }

    # Stage 2: Calculate
    dfs = {name: pd.DataFrame(data) for name, data in sheets_dict.items() if data}
    calc = KpiCalculator(dfs)
    calc_result = calc.calculate(kpi_config)

    return {
        "result": calc_result["result"],
        "artifacts": calc_result["artifacts"],
        "profile": profile,
        "config": kpi_config,
        "log": calc.get_log(),
    }
