"""
kpi_spec.py — Test specs for KPI Calculator
"""

from ml.api.tool_eval import (
    ToolTestSpec, close, exists, count, custom,
)

SPECS = [
    ToolTestSpec(
        tool_id="kpi_calculator",
        scenario="simple_2row",
        description="Minimal sales data — sanity check revenue + margin",
        run_fn="ml.api.kpi_calculator.execute_kpi_pipeline",
        input_data={
            "Sales": [
                {"month": "Jan", "region": "APAC", "revenue": 100000, "units": 50, "cogs": 40000},
                {"month": "Feb", "region": "APAC", "revenue": 120000, "units": 65, "cogs": 48000},
            ]
        },
        tags=["fast", "core"],
        assertions=[
            exists("has_artifacts", "artifacts"),
            count("artifact_count", "artifacts", 2, 20),
            custom("total_revenue_220k", lambda r: _check_revenue(r, 220000)),
            custom("margin_pct_60", lambda r: _check_margin_pct(r, 60.0, 1.0)),
        ],
    ),

    ToolTestSpec(
        tool_id="kpi_calculator",
        scenario="margin_aggregate_not_average",
        description="Margin% must be sum(margin)/sum(revenue)*100, NOT mean of per-row%",
        run_fn="ml.api.kpi_calculator.execute_kpi_pipeline",
        input_data={
            "sales_data": [
                {"gross_revenue": 1000000, "cogs": 500000, "category": "A"},
                {"gross_revenue": 1000, "cogs": 100, "category": "B"},
            ]
        },
        tags=["fast", "core", "regression"],
        assertions=[
            # Correct: (1001000-500100)/1001000*100 = 49.99%
            # Wrong (simple avg): (50% + 90%) / 2 = 70%
            custom("margin_is_aggregate", lambda r: _check_margin_pct(r, 49.99, 1.0)),
        ],
    ),

    ToolTestSpec(
        tool_id="kpi_calculator",
        scenario="target_variance_within_sheet",
        description="Target column in same sheet should produce target_variance artifact",
        run_fn="ml.api.kpi_calculator.execute_kpi_pipeline",
        input_data={
            "Sales": [
                {"month": "Jan", "region": "APAC", "revenue": 100000, "target": 120000},
                {"month": "Feb", "region": "APAC", "revenue": 120000, "target": 110000},
            ]
        },
        tags=["fast", "core"],
        assertions=[
            custom("has_target_variance", lambda r: _has_artifact_with_columns(r, "actual", "target")),
        ],
    ),
    # ── Schema Generalization: different column names, same business meaning ──

    ToolTestSpec(
        tool_id="kpi_calculator",
        scenario="schema_alt_names_sales_amount",
        description="Column 'sales_amount' instead of 'revenue' — should still detect as revenue",
        run_fn="ml.api.kpi_calculator.execute_kpi_pipeline",
        input_data={
            "orders": [
                {"order_date": "2024-01-15", "customer": "Acme", "sales_amount": 50000, "cost_of_sales": 20000, "qty": 100},
                {"order_date": "2024-02-01", "customer": "Beta", "sales_amount": 75000, "cost_of_sales": 30000, "qty": 150},
            ]
        },
        tags=["fast", "generalization"],
        assertions=[
            exists("has_artifacts", "artifacts"),
            # 'sales_amount' should be detected as revenue role → revenue_summary should run
            # Note: 'sales' is in _REVENUE_KW, and 'sales_amount' contains 'sales'
            custom("revenue_detected", lambda r: (
                any("revenue" in (a.get("label") or "").lower() or "total" in (a.get("label") or "").lower()
                    for a in r.get("artifacts", [])),
                f"Artifacts: {[a.get('label') for a in r.get('artifacts', [])[:5]]}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="kpi_calculator",
        scenario="schema_alt_names_net_revenue",
        description="Column 'net_revenue' + 'total_cost' — verify margin = (125000-50000)/125000 = 60%",
        run_fn="ml.api.kpi_calculator.execute_kpi_pipeline",
        input_data={
            "transactions": [
                {"period": "2024-Q1", "region": "NA", "net_revenue": 75000, "total_cost": 30000, "units_sold": 200},
                {"period": "2024-Q2", "region": "EU", "net_revenue": 50000, "total_cost": 20000, "units_sold": 150},
            ]
        },
        tags=["fast", "generalization"],
        assertions=[
            custom("total_revenue_125k", lambda r: _check_revenue(r, 125000)),
            custom("margin_pct_60", lambda r: _check_margin_pct(r, 60.0, 1.0)),
        ],
    ),

    ToolTestSpec(
        tool_id="kpi_calculator",
        scenario="schema_erp_abbreviations",
        description="ERP-style short column names: qty, unit_price — should detect roles",
        run_fn="ml.api.kpi_calculator.execute_kpi_pipeline",
        input_data={
            "sales_transactions": [
                {"order_date": "2024-01-15", "product_code": "SKU-001", "qty": 100, "unit_price": 50, "gross_revenue": 5000, "cogs": 2000, "customer_name": "Client A"},
                {"order_date": "2024-02-01", "product_code": "SKU-002", "qty": 200, "unit_price": 30, "gross_revenue": 6000, "cogs": 2400, "customer_name": "Client B"},
            ]
        },
        tags=["fast", "generalization"],
        assertions=[
            custom("revenue_11k", lambda r: _check_revenue(r, 11000)),
            custom("margin_pct_60", lambda r: _check_margin_pct(r, 60.0, 1.0)),
        ],
    ),

    ToolTestSpec(
        tool_id="kpi_calculator",
        scenario="schema_sheet_type_classification",
        description="3 sheets with different types: sales + target + expense — only sales gets revenue_summary",
        run_fn="ml.api.kpi_calculator.execute_kpi_pipeline",
        input_data={
            "sales_orders": [
                {"order_date": "2024-01-15", "net_revenue": 100000, "cogs": 40000, "region": "APAC"},
                {"order_date": "2024-02-01", "net_revenue": 80000, "cogs": 32000, "region": "AMER"},
            ],
            "monthly_budget": [
                {"period": "2024-01", "region": "APAC", "revenue_target": 120000},
                {"period": "2024-02", "region": "AMER", "revenue_target": 90000},
            ],
            "expense_reports": [
                {"expense_date": "2024-01-10", "department": "Sales", "amount": 5000, "status": "Approved"},
                {"expense_date": "2024-02-15", "department": "Marketing", "amount": 8000, "status": "Pending"},
            ],
        },
        tags=["fast", "generalization", "core"],
        assertions=[
            custom("revenue_180k", lambda r: _check_revenue(r, 180000)),
            # Expense sheet should NOT be counted as revenue
            custom("no_expense_revenue", lambda r: (
                not any("expense" in (a.get("label") or "").lower() and "revenue" in (a.get("label") or "").lower()
                        for a in r.get("artifacts", [])),
                f"Artifacts: {[a.get('label') for a in r.get('artifacts', [])[:8]]}"
            )),
            # Should have target variance artifact
            custom("has_variance", lambda r: (
                any("variance" in (a.get("label") or "").lower() or "target" in (a.get("label") or "").lower()
                    for a in r.get("artifacts", [])),
                f"Artifacts: {[a.get('label') for a in r.get('artifacts', [])[:8]]}"
            )),
            # Should have expense distribution artifact
            custom("has_expense", lambda r: (
                any("expense" in (a.get("label") or "").lower()
                    for a in r.get("artifacts", [])),
                f"Artifacts: {[a.get('label') for a in r.get('artifacts', [])[:8]]}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="kpi_calculator",
        scenario="schema_numeric_string_dtype",
        description="Revenue/cost values as strings (common from JSON/Excel) — must be coerced to numeric",
        run_fn="ml.api.kpi_calculator.execute_kpi_pipeline",
        input_data={
            "sales": [
                {"date": "2024-01", "gross_revenue": "100000", "cogs": "40000", "region": "APAC"},
                {"date": "2024-02", "gross_revenue": "120000", "cogs": "48000", "region": "APAC"},
            ]
        },
        tags=["fast", "regression", "generalization"],
        assertions=[
            # String "100000" + "120000" must NOT become "100000120000" — must be 220000
            custom("revenue_not_string_concat", lambda r: _check_revenue(r, 220000)),
            custom("margin_60pct", lambda r: _check_margin_pct(r, 60.0, 1.0)),
        ],
    ),
]


def _check_revenue(result, expected, tolerance_pct=1.0):
    for art in result.get("artifacts", []):
        label = (art.get("label") or "").lower()
        if "overall revenue" in label or "total revenue" in label:
            data = art.get("data", [])
            if data and isinstance(data[0], dict):
                val = data[0].get("value") or data[0].get("total_revenue")
                if val is not None:
                    diff = abs(float(val) - expected) / max(abs(expected), 0.01) * 100
                    if diff <= tolerance_pct:
                        return True, f"Revenue {float(val):,.0f} matches {expected:,.0f}"
                    return False, f"Revenue {float(val):,.0f} vs expected {expected:,.0f}"
    rev = result.get("result", {}).get("total_revenue")
    if rev is not None:
        diff = abs(float(rev) - expected) / max(abs(expected), 0.01) * 100
        if diff <= tolerance_pct:
            return True, f"Revenue {float(rev):,.0f} matches"
        return False, f"Revenue {float(rev):,.0f} vs expected {expected:,.0f}"
    return False, "No revenue found"


def _check_margin_pct(result, expected_pct, tolerance_pct=1.0):
    for art in result.get("artifacts", []):
        label = (art.get("label") or "").lower()
        if "overall" in label and "margin" in label:
            data = art.get("data", [])
            if data and isinstance(data[0], dict):
                pct = data[0].get("margin_pct")
                if pct is not None:
                    diff = abs(float(pct) - expected_pct)
                    if diff <= tolerance_pct:
                        return True, f"Margin {float(pct):.1f}% matches {expected_pct:.1f}%"
                    return False, f"Margin {float(pct):.1f}% vs expected {expected_pct:.1f}%"
    return False, "No margin_pct found"


def _has_artifact_with_columns(result, *col_names):
    for art in result.get("artifacts", []):
        data = art.get("data", [])
        if data and isinstance(data[0], dict):
            keys = set(data[0].keys())
            if all(c in keys for c in col_names):
                return True, f"Found artifact with columns {col_names}: {art.get('label')}"
    return False, f"No artifact with columns {col_names}"
