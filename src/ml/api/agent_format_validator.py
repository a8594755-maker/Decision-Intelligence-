"""
agent_format_validator.py — Detect unsupported data formats before tool selection.

Deterministic checks (no LLM). Catches:
  - Transposed financial statements (columns are dates, rows are line items)
  - Pivot tables (few rows, many columns)
  - No numeric data
  - Row-label format (first column is text descriptions)

When invalid format detected, LLM explains why and suggests alternatives.
"""

import re
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

# Date-like patterns for column names
_DATE_PATTERNS = [
    re.compile(r"^\d{4}-\d{2}-\d{2}$"),           # 2013-12-31
    re.compile(r"^\d{4}/\d{2}/\d{2}$"),           # 2013/12/31
    re.compile(r"^\d{4}-\d{2}$"),                  # 2013-12
    re.compile(r"^\d{4}$"),                         # 2013
    re.compile(r"^Q[1-4]\s*\d{4}$", re.I),        # Q1 2013
    re.compile(r"^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)", re.I),  # Jan, Feb...
    re.compile(r"^\d{1,2}/\d{1,2}/\d{2,4}$"),     # 1/15/2013
]


def _looks_like_date(col_name: str) -> bool:
    """Check if a column name looks like a date value."""
    s = str(col_name).strip()
    return any(p.match(s) for p in _DATE_PATTERNS)


def validate_data_format(profile: dict) -> tuple[bool, list[dict]]:
    """
    Check if uploaded data is in a format the system can process.

    Args:
        profile: Output from profile_for_kpi() — {sheets: {name: {columns, row_count}}}

    Returns:
        (can_process, issues) — True if OK, list of issue dicts if not
    """
    sheets = profile.get("sheets", {})
    if not sheets:
        return False, [{"issue": "no_data", "detail": "No sheets found in uploaded file"}]

    issues = []

    for sheet_name, sp in sheets.items():
        cols = sp.get("columns", {})
        row_count = sp.get("row_count", 0)
        col_names = list(cols.keys())
        col_count = len(col_names)

        if col_count == 0:
            continue

        # Count column types
        date_like_cols = sum(1 for c in col_names if _looks_like_date(c))
        numeric_cols = sum(1 for c, ci in cols.items()
                          if ci.get("role") in ("revenue", "cost", "quantity", "price", "percentage")
                          or ci.get("dtype") == "numeric")
        text_cols = sum(1 for c, ci in cols.items()
                        if ci.get("role") in ("text", "name", "id", "category", "unknown"))

        # ── Trap 1: Transposed financial statement ──
        # Columns are dates, rows are line items
        if col_count > 3 and date_like_cols > col_count * 0.5:
            issues.append({
                "sheet": sheet_name,
                "issue": "transposed_financial_statement",
                "detail": (
                    f"{date_like_cols}/{col_count} column headers are dates — "
                    f"this looks like a financial statement or pivot report, not transaction data"
                ),
                "severity": "blocking",
            })

        # ── Trap 2: Too few rows, too many columns (pivot table) ──
        if row_count < 10 and col_count > 15:
            issues.append({
                "sheet": sheet_name,
                "issue": "likely_pivot_table",
                "detail": f"{row_count} rows x {col_count} columns — looks like a pivot/summary table",
                "severity": "blocking",
            })

        # ── Trap 3: No numeric columns at all ──
        if numeric_cols == 0 and row_count > 0 and col_count > 1:
            # Check if raw values are numeric (role detection may have missed them)
            # This is a soft warning, not blocking
            issues.append({
                "sheet": sheet_name,
                "issue": "no_numeric_columns",
                "detail": f"No revenue/cost/quantity columns detected in {col_count} columns",
                "severity": "warning",
            })

        # ── Trap 4: Single column data ──
        if col_count == 1 and row_count > 0:
            issues.append({
                "sheet": sheet_name,
                "issue": "single_column",
                "detail": "Only 1 column — not enough structure for analysis",
                "severity": "blocking",
            })

    # Determine if we can process
    blocking = [i for i in issues if i.get("severity") == "blocking"]
    if blocking:
        return False, issues

    return True, issues


# ── LLM Rejection Explainer ─────────────────────────────────────────────

REJECTION_SYSTEM = """You are a helpful data analyst assistant. The user uploaded data that the system cannot process. Explain why clearly and suggest alternatives. Be concise (3-5 sentences). Use the user's language if you can detect it from the data (e.g., Chinese column names → respond in Chinese)."""

REJECTION_PROMPT = """The user uploaded a file, but the system detected format issues:

## Issues Found
{issues_text}

## Data Preview
Sheet names: {sheet_names}
Column names: {col_names}
Row count: {row_count}

## What the system needs
The system analyzes row-level transaction data, like:
| date | product | quantity | revenue | cost |
| 2025-01-01 | Widget A | 100 | 8500 | 4200 |

Explain to the user:
1. What format their data is in (be specific — financial statement? pivot table?)
2. Why the system can't process it
3. What format they should provide instead
4. If possible, offer to do a simpler analysis (e.g., trend calculation from the data as-is)"""


async def explain_rejection(profile: dict, issues: list[dict], llm_config: dict) -> str:
    """
    LLM explains why the data format is not supported.
    Uses 1 LLM call instead of tool selection + synthesis.
    """
    from ml.api.agent_tool_selector import _call_llm_via_proxy

    sheets = profile.get("sheets", {})
    sheet_names = list(sheets.keys())
    all_cols = []
    total_rows = 0
    for sp in sheets.values():
        all_cols.extend(sp.get("columns", {}).keys())
        total_rows += sp.get("row_count", 0)

    issues_text = "\n".join(
        f"- [{i['severity']}] {i['sheet']}: {i['issue']} — {i['detail']}"
        for i in issues
    )

    prompt = REJECTION_PROMPT.format(
        issues_text=issues_text,
        sheet_names=", ".join(sheet_names),
        col_names=", ".join(all_cols[:20]),
        row_count=total_rows,
    )

    try:
        response = await _call_llm_via_proxy(prompt, REJECTION_SYSTEM, llm_config)
        return response.strip()
    except Exception as e:
        logger.error(f"[FormatValidator] LLM rejection explain failed: {e}")
        # Fallback: deterministic message
        lines = ["The uploaded data format is not supported for analysis."]
        for i in issues:
            if i.get("severity") == "blocking":
                lines.append(f"- {i['detail']}")
        lines.append("\nPlease provide row-level transaction data (one row per order/transaction).")
        return "\n".join(lines)
