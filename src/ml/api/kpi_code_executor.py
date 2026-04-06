"""
kpi_code_executor.py — Sandbox for LLM-generated KPI calculation code.

4-layer safety:
  1. Code validation (block dangerous patterns)
  2. Sandbox execution (restricted builtins, df copy)
  3. Sanity checks (margin range, NaN, etc.)
  4. Fallback to deterministic calculator if anything fails

LLM writes pandas code → we exec it → extract results → audit trail.
"""

import json
import time
import logging
import re

import pandas as pd
import numpy as np

logger = logging.getLogger(__name__)


# ── Layer 1: Code Validation ─────────────────────────────────────────────

BLOCKED_PATTERNS = [
    "import ", "exec(", "eval(", "__", "open(", "os.", "sys.",
    "subprocess", "shutil", "pathlib", "socket", "requests",
    "globals(", "locals(", "compile(", "getattr(", "setattr(",
    "delattr(", "breakpoint(", "exit(", "quit(",
]

MAX_CODE_LENGTH = 5000
MAX_CODE_LINES = 100


def _strip_safe_imports(code: str) -> str:
    """Remove harmless import lines that LLM sometimes adds despite instructions.
    Only strips 'import pandas' and 'import numpy' — everything else stays blocked."""
    lines = code.split("\n")
    cleaned = []
    for line in lines:
        stripped = line.strip()
        if stripped in ("import pandas as pd", "import numpy as np",
                        "import pandas", "import numpy",
                        "from pandas import *", "from numpy import *"):
            continue  # Skip — pd and np are already in sandbox
        cleaned.append(line)
    return "\n".join(cleaned)


def validate_code(code: str) -> tuple[bool, str]:
    """Check code for dangerous patterns before execution."""
    if not code or not code.strip():
        return False, "Empty code"

    for pattern in BLOCKED_PATTERNS:
        if pattern in code:
            return False, f"Blocked pattern: {pattern}"

    if len(code) > MAX_CODE_LENGTH:
        return False, f"Code too long: {len(code)} chars (max {MAX_CODE_LENGTH})"

    lines = code.strip().split("\n")
    if len(lines) > MAX_CODE_LINES:
        return False, f"Too many lines: {len(lines)} (max {MAX_CODE_LINES})"

    return True, "OK"


# ── Layer 2: Sandbox Execution ───────────────────────────────────────────

ALLOWED_BUILTINS = {
    "len": len, "max": max, "min": min, "abs": abs, "round": round,
    "sum": sum, "sorted": sorted, "enumerate": enumerate, "range": range,
    "zip": zip, "isinstance": isinstance,
    "float": float, "int": int, "str": str, "bool": bool,
    "list": list, "dict": dict, "tuple": tuple, "set": set,
    "True": True, "False": False, "None": None,
}


def execute_kpi_code(code: str, df: pd.DataFrame, expected_outputs: list[str]) -> dict:
    """
    Execute LLM-generated code in a restricted sandbox.

    Args:
        code: Python code string (operates on `df`, `pd`, `np`)
        df: Cleaned DataFrame
        expected_outputs: Variable names to extract

    Returns:
        {
            "success": bool,
            "results": {"total_revenue": 123456, ...},
            "error": str or None,
            "sanity_issues": [...],
            "execution_time_ms": int,
        }
    """
    # Layer 1: Validate
    is_safe, reason = validate_code(code)
    if not is_safe:
        return {"success": False, "results": {}, "error": f"Validation failed: {reason}",
                "sanity_issues": [], "execution_time_ms": 0}

    # Layer 2: Execute in sandbox
    # Strip column name whitespace to prevent " Sales" vs "Sales" mismatches
    clean_df = df.copy()
    clean_df.columns = [c.strip() if isinstance(c, str) else c for c in clean_df.columns]

    # Coerce numeric-looking columns to float (Excel reads as object/str)
    for col in clean_df.columns:
        if not pd.api.types.is_numeric_dtype(clean_df[col]):
            converted = pd.to_numeric(clean_df[col], errors="coerce")
            if converted.notna().sum() > len(clean_df) * 0.3:
                clean_df[col] = converted

    sandbox_globals = {
        "__builtins__": ALLOWED_BUILTINS,
        "pd": pd,
        "np": np,
        "df": clean_df,
    }
    sandbox_locals = {}

    t0 = time.time()
    try:
        exec(code, sandbox_globals, sandbox_locals)
    except Exception as e:
        return {"success": False, "results": {}, "error": f"{type(e).__name__}: {e}",
                "sanity_issues": [], "execution_time_ms": int((time.time() - t0) * 1000)}

    elapsed_ms = int((time.time() - t0) * 1000)

    # Extract outputs
    results = {}
    missing = []
    for var in expected_outputs:
        if var in sandbox_locals:
            val = sandbox_locals[var]
            if isinstance(val, (np.integer,)):
                val = int(val)
            elif isinstance(val, (np.floating,)):
                val = round(float(val), 2)
                if np.isnan(val) or np.isinf(val):
                    val = None
            elif isinstance(val, pd.Series):
                val = val.to_dict()
            elif isinstance(val, pd.DataFrame):
                val = val.to_dict(orient="records")
            results[var] = val
        else:
            missing.append(var)

    if missing:
        return {"success": False, "results": results, "error": f"Missing outputs: {missing}",
                "sanity_issues": [], "execution_time_ms": elapsed_ms}

    # Layer 3: Sanity checks
    sanity_issues = _sanity_check(results)

    return {
        "success": True,
        "results": results,
        "error": None,
        "sanity_issues": sanity_issues,
        "execution_time_ms": elapsed_ms,
    }


# ── Layer 3: Sanity Checks ───────────────────────────────────────────────

def _sanity_check(results: dict) -> list[str]:
    """Check results for obviously wrong values."""
    issues = []

    margin_pct = results.get("gross_margin_pct")
    if margin_pct is not None and (margin_pct > 100 or margin_pct < -100):
        issues.append(f"margin_pct={margin_pct}% outside [-100, 100]")

    rev = results.get("total_revenue")
    cogs = results.get("total_cogs")
    if rev is not None and cogs is not None and rev > 0:
        if cogs > rev * 10:
            issues.append(f"COGS ({cogs:,.0f}) is 10x+ revenue ({rev:,.0f})")

    for k, v in results.items():
        if v is None:
            issues.append(f"{k} is None")
        elif isinstance(v, float) and (np.isnan(v) or np.isinf(v)):
            issues.append(f"{k} is NaN/Inf")

    return issues


# ── LLM Prompt ───────────────────────────────────────────────────────────

KPI_CODE_SYSTEM = "You are a supply chain and business data analyst. Return ONLY valid JSON."

KPI_CODE_PROMPT = """Write Python/pandas code to calculate KPIs from this dataset.

## Dataset
Sheet: {sheet_name} ({row_count} rows)

Columns:
{column_profiles}

## Step 1: Identify the data domain
Look at column names and values to determine what kind of data this is:
- **Sales/Revenue data**: has revenue, sales, price × qty, COGS, profit → calculate revenue KPIs
- **Procurement/Purchase data**: has PO, supplier, order qty, delivery qty, unit price, delivery dates → calculate procurement KPIs
- **Production data**: has work orders, planned vs actual qty, yield, defects, production lines → calculate production KPIs
- **Inventory data**: has on-hand qty, safety stock, warehouse, cost → calculate inventory KPIs
- **Supplier scorecard**: has supplier names, on-time rate, quality rate, lead time → calculate supplier KPIs
- **Budget vs actual**: has budget amount, actual amount, achievement rate → calculate variance KPIs

## Step 2: Calculate domain-appropriate KPIs
Based on the domain detected, calculate the RIGHT KPIs:

**For Sales/Revenue:**
- total_revenue, total_cogs, gross_margin, gross_margin_pct

**For Procurement:**
- total_purchase_amount: sum of order amounts
- total_orders: count of POs
- on_time_delivery_rate: % of orders where actual delivery <= required delivery date
- short_shipment_rate: % of orders where delivered qty < ordered qty
- avg_lead_time: average days between order date and delivery date
- quality_pass_rate: % of orders with passing quality status
- top_suppliers_by_spend: top 5 suppliers by total spend

**For Production:**
- total_planned_qty, total_actual_output, total_good_qty, total_defect_qty
- overall_yield_rate: sum(good_qty) / sum(actual_output) * 100 (AGGREGATE, not mean of per-row yield)
- on_time_completion_rate: % of work orders completed on or before planned end date
- output_achievement_rate: sum(actual_output) / sum(planned_qty) * 100

**For Inventory:**
- total_inventory_value: sum of inventory value
- items_below_safety_stock: count where on_hand < safety_stock
- avg_days_of_supply: estimate from on_hand / daily demand if demand data available

**For Budget vs Actual:**
- total_budget, total_actual, overall_achievement_rate
- over_budget_categories: categories where actual > budget

## Rules
1. Code operates on DataFrame `df` with ORIGINAL column names (not mapped names)
2. Do NOT import anything (pd and np are pre-loaded)
3. Do NOT print anything — just assign variables
4. Handle zero denominators: use max(denominator, 1)
5. For percentage KPIs: use AGGREGATE method (sum/sum), NEVER mean of per-row percentages
6. CRITICAL: Do NOT calculate revenue/margin from procurement data. Purchase amount is COST, not revenue.
7. If dates exist, parse them: pd.to_datetime(df[col], errors='coerce')
8. REVENUE COLUMN SELECTION: If multiple revenue-like columns exist (e.g., "Sales" and "Order Item Total"):
   - Check which column's sum matches profit + cost relationships
   - Prefer NET revenue (after discounts) over GROSS (before discounts)
   - If a "discount" column exists, NET = GROSS - DISCOUNT. Use NET for margin calculations.
   - If a "profit" column's values are derived from one revenue column (profit / revenue ≈ profit_ratio), use THAT revenue column

Return JSON:
{{
  "domain": "sales|procurement|production|inventory|supplier|budget",
  "code": "total_purchase_amount = df['amount'].sum()\\n...",
  "reasoning": "This is procurement data because columns include PO number, supplier, order qty, delivery dates. Calculating procurement KPIs, not revenue margin.",
  "outputs": ["total_purchase_amount", "on_time_delivery_rate", ...],
  "derivations": []
}}"""


def _select_relevant_columns(df: pd.DataFrame, max_cols: int = 20) -> list[str]:
    """Select the most relevant columns for KPI analysis.

    When a dataset has 50+ columns, sending all to LLM causes it to lose focus.
    Priority: financial keywords > other numeric > text dimensions (limited).
    """
    financial_kw = {
        "sales", "revenue", "cost", "profit", "price", "margin", "amount",
        "total", "discount", "cogs", "qty", "quantity", "units", "value",
        "budget", "actual", "target", "spend", "freight", "order",
        "benefit", "income", "expense", "fee", "tax",
        # Chinese
        "金額", "成本", "營收", "利潤", "數量", "單價", "總計", "預算",
    }

    scored = []
    for col in df.columns:
        cl = col.strip().lower()
        numeric = pd.to_numeric(df[col], errors="coerce")
        is_numeric = numeric.notna().sum() > len(df) * 0.3

        # Score: financial keyword + numeric = highest
        kw_match = any(k in cl for k in financial_kw)
        if kw_match and is_numeric:
            scored.append((0, col))   # financial numeric — best
        elif is_numeric:
            scored.append((1, col))   # other numeric
        elif kw_match:
            scored.append((2, col))   # financial text (rare)
        elif any(k in cl for k in ("date", "month", "year", "period", "日期")):
            scored.append((3, col))   # date columns — useful for context
        elif df[col].nunique() < 20:
            scored.append((4, col))   # low-cardinality dimension
        else:
            scored.append((5, col))   # skip high-cardinality text

    scored.sort(key=lambda x: x[0])
    selected = [col for _, col in scored[:max_cols]]

    if len(df.columns) > max_cols:
        logger.info(f"[KPICode] Filtered {len(df.columns)} columns → {len(selected)} for LLM prompt")

    return selected


def build_column_profile_for_kpi(df: pd.DataFrame) -> str:
    """Build compact column profile for the LLM prompt.
    Filters to most relevant columns when dataset has many columns."""
    relevant_cols = _select_relevant_columns(df)

    lines = []
    for raw_col in relevant_cols:
        col = raw_col.strip() if isinstance(raw_col, str) else raw_col
        series = df[raw_col]
        numeric = pd.to_numeric(series, errors="coerce")
        num_ratio = numeric.notna().sum() / max(len(series), 1)

        if num_ratio > 0.5:
            valid = numeric.dropna()
            lines.append(
                f"  {col}: numeric | "
                f"range=[{valid.min():,.2f} .. {valid.max():,.2f}] | "
                f"mean={valid.mean():,.2f} | sum={valid.sum():,.2f}"
            )
        else:
            unique = series.nunique()
            samples = [str(x) for x in series.dropna().unique()[:4]]
            lines.append(f"  {col}: text | unique={unique} | samples={samples}")

    if len(df.columns) > len(relevant_cols):
        lines.append(f"  ... ({len(df.columns) - len(relevant_cols)} more columns omitted — not financial)")

    return "\n".join(lines)


# ── Column Role Detection (lightweight LLM call) ────────────────────────

COLUMN_ROLE_PROMPT = """Given these columns from a dataset, identify which column serves each role.

Columns:
{column_list}

Return JSON:
{{
  "revenue_col": "column name for NET revenue/sales (after discounts, not gross)",
  "cost_col": "column name for COGS/total cost (null if not found)",
  "profit_col": "column name for profit (null if not found)",
  "discount_col": "column name for discount amount (null if not found)",
  "reasoning": "brief explanation of why you chose each"
}}

Rules:
- If both GROSS and NET revenue exist, pick NET (after discounts). Look at the values: if col_A - discount = col_B, then col_B is NET.
- If a profit column exists, check: profit / revenue should give a reasonable ratio (0-100%). Pick the revenue column that makes this work.
- "Sales per customer" or "Benefit per order" are NOT total revenue — they are per-unit metrics.
- Return ONLY the JSON. No markdown."""


async def _detect_column_roles(df: pd.DataFrame, llm_config: dict) -> dict:
    """Lightweight LLM call to identify which columns are revenue/cost/profit.
    Runs BEFORE KPI code generation to give the code generator clear targets."""
    from ml.api.agent_tool_selector import _call_llm_via_proxy

    relevant = _select_relevant_columns(df, max_cols=15)
    col_info = []
    for col in relevant:
        series = df[col]
        num = pd.to_numeric(series, errors="coerce")
        if num.notna().sum() > len(df) * 0.3:
            col_info.append(f"  {col}: numeric, sum={num.sum():,.0f}, mean={num.mean():,.1f}")
        else:
            col_info.append(f"  {col}: text, unique={series.nunique()}")

    prompt = COLUMN_ROLE_PROMPT.format(column_list="\n".join(col_info))

    try:
        raw = await _call_llm_via_proxy(prompt, "Return ONLY valid JSON.", llm_config)
        raw = raw.strip()
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        s = raw.find("{")
        e = raw.rfind("}")
        if s >= 0 and e > s:
            roles = json.loads(raw[s:e + 1])
            logger.info(f"[KPICode] Column roles detected: rev={roles.get('revenue_col')}, "
                        f"cost={roles.get('cost_col')}, profit={roles.get('profit_col')}")
            return roles
    except Exception as ex:
        logger.warning(f"[KPICode] Column role detection failed: {ex}")

    return {}


# ── Main Entry Point ─────────────────────────────────────────────────────

async def calculate_kpis_with_llm_code(
    df: pd.DataFrame,
    sheet_name: str,
    llm_config: dict,
    all_sheets: dict = None,
) -> dict:
    """
    LLM generates pandas code → sandbox executes → audit trail.
    If all_sheets is provided, includes profiles of all sheets so LLM understands the full dataset.

    Returns:
        {
            "success": bool,
            "results": {"total_revenue": ..., "gross_margin_pct": ...},
            "audit": {"code": ..., "reasoning": ..., "derivations": ...},
            "error": str or None,
        }
    """
    from ml.api.agent_tool_selector import _call_llm_via_proxy

    col_profile = build_column_profile_for_kpi(df)

    # Step 0: Detect column roles (lightweight LLM call)
    # This tells the code generator WHICH columns to use, avoiding the
    # "53 columns, LLM picks wrong one" problem.
    column_roles = await _detect_column_roles(df, llm_config)
    role_hint = ""
    if column_roles.get("revenue_col"):
        role_hint = f"\n\n## Pre-identified Column Roles (use these — do NOT pick different columns)\n"
        role_hint += f"  Revenue column: '{column_roles['revenue_col']}'\n"
        if column_roles.get("cost_col"):
            role_hint += f"  Cost/COGS column: '{column_roles['cost_col']}'\n"
        if column_roles.get("profit_col"):
            role_hint += f"  Profit column: '{column_roles['profit_col']}'\n"
        if column_roles.get("discount_col"):
            role_hint += f"  Discount column: '{column_roles['discount_col']}'\n"
        if column_roles.get("reasoning"):
            role_hint += f"  Reasoning: {column_roles['reasoning']}\n"

    # Include other sheets' profiles for context
    other_sheets_info = ""
    if all_sheets:
        other_profiles = []
        for sn, rows in all_sheets.items():
            if sn == sheet_name or not rows:
                continue
            other_df = pd.DataFrame(rows)
            cols_summary = ", ".join(
                f"{c.strip()}" for c in list(other_df.columns)[:8]
            )
            other_profiles.append(f"  - {sn} ({len(other_df)} rows): [{cols_summary}]")
        if other_profiles:
            other_sheets_info = "\n\n## Other sheets in this workbook (for context)\n" + "\n".join(other_profiles)

    prompt = KPI_CODE_PROMPT.format(
        sheet_name=sheet_name,
        row_count=len(df),
        column_profiles=col_profile,
    ) + role_hint + other_sheets_info

    try:
        raw = await _call_llm_via_proxy(prompt, KPI_CODE_SYSTEM, llm_config)
        raw = raw.strip()
        # Strip markdown fences
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        s = raw.find("{")
        e = raw.rfind("}")
        if s >= 0 and e > s:
            raw = raw[s:e + 1]
        llm_output = json.loads(raw)
    except Exception as ex:
        logger.error(f"[KPICode] LLM call/parse failed: {ex}")
        return {"success": False, "results": {}, "audit": {}, "error": str(ex)}

    code = _strip_safe_imports(llm_output.get("code", ""))
    reasoning = llm_output.get("reasoning", "")
    expected = llm_output.get("outputs", [])
    derivations = llm_output.get("derivations", [])

    logger.info(f"[KPICode] LLM generated {len(code)} chars code, {len(expected)} outputs")

    # Execute in sandbox
    execution = execute_kpi_code(code, df, expected)

    audit = {
        "method": "llm_generated_code",
        "code": code,
        "reasoning": reasoning,
        "derivations": derivations,
        "outputs": expected,
        "execution_time_ms": execution["execution_time_ms"],
        "sanity_issues": execution.get("sanity_issues", []),
    }

    if not execution["success"]:
        logger.warning(f"[KPICode] Execution failed: {execution['error']}")
        audit["error"] = execution["error"]

        # Provide helpful fallback info instead of empty results
        numeric_cols = [c for c in df.columns if pd.to_numeric(df[c], errors="coerce").notna().sum() > len(df) * 0.3]
        fallback_info = {
            "error_message": f"LLM-generated code failed: {execution['error']}",
            "available_numeric_columns": numeric_cols[:15],
            "suggestion": "Please check the column mapping or manually specify which column is revenue/cost in the chat.",
            "total_rows": len(df),
        }
        return {"success": False, "results": fallback_info, "audit": audit, "error": execution["error"]}

    logger.info(f"[KPICode] Success: {execution['results']}")
    return {
        "success": True,
        "results": execution["results"],
        "audit": audit,
        "error": None,
    }
