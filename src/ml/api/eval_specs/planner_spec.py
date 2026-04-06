"""
planner_spec.py — Eval specs for deterministic tool planner.

Tests plan_from_profile() — given a data profile, does it select the right tools?
Uses structural assertions: expected tools present, unexpected tools absent.
"""

from ml.api.tool_eval import ToolTestSpec, custom


def _make_profile(sheets_config):
    """Build a minimal profile dict for testing."""
    from ml.api.kpi_calculator import _detect_role
    import pandas as pd

    profile = {"sheets": {}}
    for sn, rows in sheets_config.items():
        if not rows:
            profile["sheets"][sn] = {"row_count": 0, "columns": {}}
            continue
        df = pd.DataFrame(rows)
        cols = {}
        for col in df.columns:
            role = _detect_role(col, df[col])
            cols[col] = {"role": role, "dtype": "numeric" if role in ("revenue", "cost", "quantity", "price") else "text"}
        profile["sheets"][sn] = {"row_count": len(df), "columns": cols}
    return profile


def run_planner(input_data):
    """Run plan_from_profile and return tool list + reasoning."""
    from ml.api.mbr_agent import plan_from_profile
    sheets = input_data.get("sheets", {})
    profile = _make_profile(sheets)
    plan, reasoning = plan_from_profile(profile)
    return {"plan": plan, "reasoning": reasoning}


def _check_has_tools(result, expected):
    missing = [t for t in expected if t not in result["plan"]]
    if missing:
        return False, f"Missing: {missing}. Plan: {result['plan']}"
    return True, f"All expected tools present: {expected}"


def _check_not_has_tools(result, not_expected):
    found = [t for t in not_expected if t in result["plan"]]
    if found:
        return False, f"Should NOT have: {found}. Plan: {result['plan']}"
    return True, f"Correctly excluded: {not_expected}"


# ── Minimal test data ──

SALES_ROWS = [
    {"order_date": "2025-01-15", "product_code": "SKU-001", "qty": 100, "gross_revenue": 5000, "cogs": 2000, "region": "APAC"},
    {"order_date": "2025-02-01", "product_code": "SKU-002", "qty": 200, "gross_revenue": 8000, "cogs": 3200, "region": "AMER"},
] * 5  # 10 rows for forecast threshold

TARGET_ROWS = [
    {"period": "2025-01", "region": "APAC", "revenue_target": 10000},
    {"period": "2025-02", "region": "AMER", "revenue_target": 15000},
]

INVENTORY_ROWS = [
    {"product_code": "SKU-001", "on_hand_qty": 500, "safety_stock": 100, "unit_cost": 20},
]

SUPPLIER_ROWS = [
    {"invoice_id": "INV-001", "supplier_name": "Vendor A", "invoice_date": "2025-01-10", "due_date": "2025-02-10", "amount": 5000},
]

EXPENSE_ROWS = [
    {"expense_id": "EXP-001", "department": "Sales", "expense_type": "Travel", "amount": 3000, "expense_date": "2025-01-15"},
]

BOM_ROWS = [
    {"parent_material": "SKU-001", "child_material": "RM-A", "qty_per": 2},
]


SPECS = [
    ToolTestSpec(
        tool_id="planner",
        scenario="full_mbr_data",
        description="All sheet types present → all tools selected",
        run_fn="ml.api.eval_specs.planner_spec.run_planner",
        input_data={"sheets": {
            "sales_transactions": SALES_ROWS,
            "monthly_budget": TARGET_ROWS,
            "inventory_snapshot": INVENTORY_ROWS,
            "supplier_invoices": SUPPLIER_ROWS,
            "expense_reports": EXPENSE_ROWS,
            "bom_edges": BOM_ROWS,
        }},
        tags=["core"],
        assertions=[
            custom("has_cleaning", lambda r: _check_has_tools(r, ["data_cleaning"])),
            custom("has_kpi", lambda r: _check_has_tools(r, ["kpi_calculation"])),
            custom("has_variance", lambda r: _check_has_tools(r, ["variance_analysis"])),
            custom("has_inventory", lambda r: _check_has_tools(r, ["inventory_health"])),
            custom("has_anomaly", lambda r: _check_has_tools(r, ["anomaly_detection"])),
            custom("has_bom", lambda r: _check_has_tools(r, ["bom_explosion"])),
            custom("anomaly_is_last", lambda r: (
                r["plan"][-1] == "anomaly_detection",
                f"Last tool: {r['plan'][-1]}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="planner",
        scenario="sales_only",
        description="Only sales sheet → KPI + forecast + anomaly, NOT variance/inventory/BOM",
        run_fn="ml.api.eval_specs.planner_spec.run_planner",
        input_data={"sheets": {"sales_transactions": SALES_ROWS}},
        tags=["core"],
        assertions=[
            custom("has_kpi", lambda r: _check_has_tools(r, ["kpi_calculation"])),
            custom("has_anomaly", lambda r: _check_has_tools(r, ["anomaly_detection"])),
            custom("no_variance", lambda r: _check_not_has_tools(r, ["variance_analysis"])),
            custom("no_inventory", lambda r: _check_not_has_tools(r, ["inventory_health"])),
            custom("no_bom", lambda r: _check_not_has_tools(r, ["bom_explosion"])),
        ],
    ),

    ToolTestSpec(
        tool_id="planner",
        scenario="sales_plus_budget",
        description="Sales + budget → KPI + variance, NOT inventory/BOM",
        run_fn="ml.api.eval_specs.planner_spec.run_planner",
        input_data={"sheets": {
            "sales_transactions": SALES_ROWS,
            "monthly_budget": TARGET_ROWS,
        }},
        tags=["core"],
        assertions=[
            custom("has_kpi", lambda r: _check_has_tools(r, ["kpi_calculation"])),
            custom("has_variance", lambda r: _check_has_tools(r, ["variance_analysis"])),
            custom("no_inventory", lambda r: _check_not_has_tools(r, ["inventory_health"])),
            custom("no_bom", lambda r: _check_not_has_tools(r, ["bom_explosion"])),
        ],
    ),

    ToolTestSpec(
        tool_id="planner",
        scenario="expense_only",
        description="Only expense sheet → expense_analysis + anomaly, NOT kpi (expense ≠ revenue)",
        run_fn="ml.api.eval_specs.planner_spec.run_planner",
        input_data={"sheets": {"expense_reports": EXPENSE_ROWS}},
        tags=["core", "regression"],
        assertions=[
            custom("has_expense", lambda r: _check_has_tools(r, ["expense_analysis"])),
            custom("has_anomaly", lambda r: _check_has_tools(r, ["anomaly_detection"])),
            custom("no_kpi", lambda r: _check_not_has_tools(r, ["kpi_calculation"])),
            custom("no_variance", lambda r: _check_not_has_tools(r, ["variance_analysis"])),
            custom("no_bom", lambda r: _check_not_has_tools(r, ["bom_explosion"])),
        ],
    ),

    ToolTestSpec(
        tool_id="planner",
        scenario="empty_data",
        description="Empty sheets → only cleaning, no analysis tools",
        run_fn="ml.api.eval_specs.planner_spec.run_planner",
        input_data={"sheets": {"empty_sheet": []}},
        tags=["edge"],
        assertions=[
            custom("has_cleaning", lambda r: _check_has_tools(r, ["data_cleaning"])),
            custom("minimal_plan", lambda r: (
                len(r["plan"]) <= 2,
                f"Plan has {len(r['plan'])} tools (expected ≤2): {r['plan']}"
            )),
            custom("no_kpi", lambda r: _check_not_has_tools(r, ["kpi_calculation"])),
        ],
    ),

    ToolTestSpec(
        tool_id="planner",
        scenario="inventory_plus_sales",
        description="Inventory + sales → KPI + inventory_health, NOT variance",
        run_fn="ml.api.eval_specs.planner_spec.run_planner",
        input_data={"sheets": {
            "sales_transactions": SALES_ROWS,
            "inventory_snapshot": INVENTORY_ROWS,
        }},
        tags=["core"],
        assertions=[
            custom("has_kpi", lambda r: _check_has_tools(r, ["kpi_calculation"])),
            custom("has_inventory", lambda r: _check_has_tools(r, ["inventory_health"])),
            custom("no_variance", lambda r: _check_not_has_tools(r, ["variance_analysis"])),
        ],
    ),

    ToolTestSpec(
        tool_id="planner",
        scenario="supplier_only",
        description="Only supplier sheet → supplier_analysis + anomaly, NOT KPI",
        run_fn="ml.api.eval_specs.planner_spec.run_planner",
        input_data={"sheets": {"supplier_invoices": SUPPLIER_ROWS}},
        tags=["core"],
        assertions=[
            custom("has_supplier", lambda r: _check_has_tools(r, ["supplier_analysis"])),
            custom("has_anomaly", lambda r: _check_has_tools(r, ["anomaly_detection"])),
            custom("no_kpi", lambda r: _check_not_has_tools(r, ["kpi_calculation"])),
        ],
    ),

    ToolTestSpec(
        tool_id="planner",
        scenario="forecast_eligible",
        description="Sales with 10+ rows and date column → forecast included",
        run_fn="ml.api.eval_specs.planner_spec.run_planner",
        input_data={"sheets": {"sales_transactions": SALES_ROWS}},  # 10 rows
        tags=["core"],
        assertions=[
            custom("has_forecast", lambda r: _check_has_tools(r, ["forecast"])),
        ],
    ),

    ToolTestSpec(
        tool_id="planner",
        scenario="order_correct",
        description="Verify tool execution order: cleaning first, anomaly last",
        run_fn="ml.api.eval_specs.planner_spec.run_planner",
        input_data={"sheets": {
            "sales_transactions": SALES_ROWS,
            "monthly_budget": TARGET_ROWS,
        }},
        tags=["core"],
        assertions=[
            custom("cleaning_first", lambda r: (
                r["plan"][0] == "data_cleaning",
                f"First: {r['plan'][0]}"
            )),
            custom("anomaly_last", lambda r: (
                r["plan"][-1] == "anomaly_detection",
                f"Last: {r['plan'][-1]}"
            )),
            custom("kpi_before_variance", lambda r: (
                r["plan"].index("kpi_calculation") < r["plan"].index("variance_analysis"),
                f"KPI at {r['plan'].index('kpi_calculation')}, variance at {r['plan'].index('variance_analysis')}"
            )),
        ],
    ),
]
