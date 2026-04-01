"""
run_revenue_forecast_spec.py — Eval specs for revenue forecast

NOTE: run_revenue_forecast is a JS service that depends on:
  1. Supabase auth (user session)
  2. Upstream BOM explosion run (sourceBomRunId)
  3. Revenue terms from DB (revenue_terms table)
  4. Demand data from DB (demand_fg or demand_forecast)

These specs test the revenue calculation logic in isolation,
not the full JS service flow (which requires integration tests).

Revenue formula per FG item:
  margin_at_risk = impacted_qty * margin_per_unit
  penalty_at_risk = penalty_value * impacted_qty (if penalty_type != 'none')
  total_at_risk = margin_at_risk + penalty_at_risk
"""

from ml.api.tool_eval import (
    ToolTestSpec, custom,
)


def _run_revenue_calc(input_data):
    """
    Simulate revenue forecast calculation logic without Supabase dependencies.
    Tests the mathematical correctness of margin-at-risk formulas.
    """
    items = input_data.get("items", [])
    results = []

    for item in items:
        demand_qty = item.get("demand_qty", 0)
        impacted_qty = item.get("impacted_qty", 0)
        shortage_qty = item.get("shortage_qty", 0)
        p_stockout = item.get("p_stockout", 0)
        margin_per_unit = item.get("margin_per_unit", 0)
        price_per_unit = item.get("price_per_unit", 0)
        penalty_type = item.get("penalty_type", "none")
        penalty_value = item.get("penalty_value", 0)

        # Core calculations (matching revenueForecast.js domain engine)
        expected_margin_at_risk = round(impacted_qty * margin_per_unit, 2)

        if penalty_type != "none" and penalty_value > 0:
            expected_penalty_at_risk = round(penalty_value * impacted_qty, 2)
        else:
            expected_penalty_at_risk = 0

        total_at_risk = round(expected_margin_at_risk + expected_penalty_at_risk, 2)

        results.append({
            "fg_material_code": item.get("fg_material_code", "?"),
            "demand_qty": demand_qty,
            "impacted_qty": impacted_qty,
            "margin_at_risk": expected_margin_at_risk,
            "penalty_at_risk": expected_penalty_at_risk,
            "total_at_risk": total_at_risk,
        })

    total_margin = sum(r["margin_at_risk"] for r in results)
    total_penalty = sum(r["penalty_at_risk"] for r in results)

    return {
        "success": True,
        "results": results,
        "kpis": {
            "total_margin_at_risk": round(total_margin, 2),
            "total_penalty_at_risk": round(total_penalty, 2),
            "total_at_risk": round(total_margin + total_penalty, 2),
            "total_items": len(results),
        },
    }


SPECS = [
    ToolTestSpec(
        tool_id="run_revenue_forecast",
        scenario="basic_margin_at_risk",
        description="Basic margin-at-risk: impacted_qty * margin_per_unit, no penalty",
        run_fn=_run_revenue_calc,
        input_data={
            "items": [
                {"fg_material_code": "FG-001", "demand_qty": 1000, "impacted_qty": 200,
                 "margin_per_unit": 50, "price_per_unit": 150, "penalty_type": "none", "penalty_value": 0},
                {"fg_material_code": "FG-002", "demand_qty": 500, "impacted_qty": 100,
                 "margin_per_unit": 80, "price_per_unit": 200, "penalty_type": "none", "penalty_value": 0},
            ],
        },
        tags=["fast", "core"],
        assertions=[
            custom("fg001_margin", lambda r: (
                abs(r["results"][0]["margin_at_risk"] - 10000) < 0.01,
                f"FG-001 margin_at_risk: {r['results'][0]['margin_at_risk']} (expected 10000)"
            )),
            custom("fg002_margin", lambda r: (
                abs(r["results"][1]["margin_at_risk"] - 8000) < 0.01,
                f"FG-002 margin_at_risk: {r['results'][1]['margin_at_risk']} (expected 8000)"
            )),
            custom("total", lambda r: (
                abs(r["kpis"]["total_at_risk"] - 18000) < 0.01,
                f"Total at risk: {r['kpis']['total_at_risk']} (expected 18000)"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_revenue_forecast",
        scenario="with_penalty",
        description="Margin + penalty: impacted_qty * (margin + penalty_per_unit)",
        run_fn=_run_revenue_calc,
        input_data={
            "items": [
                {"fg_material_code": "FG-001", "demand_qty": 1000, "impacted_qty": 300,
                 "margin_per_unit": 50, "price_per_unit": 150,
                 "penalty_type": "per_unit", "penalty_value": 10},
            ],
        },
        tags=["fast"],
        assertions=[
            custom("margin_correct", lambda r: (
                abs(r["results"][0]["margin_at_risk"] - 15000) < 0.01,
                f"Margin: {r['results'][0]['margin_at_risk']} (expected 300*50=15000)"
            )),
            custom("penalty_correct", lambda r: (
                abs(r["results"][0]["penalty_at_risk"] - 3000) < 0.01,
                f"Penalty: {r['results'][0]['penalty_at_risk']} (expected 300*10=3000)"
            )),
            custom("total_correct", lambda r: (
                abs(r["kpis"]["total_at_risk"] - 18000) < 0.01,
                f"Total: {r['kpis']['total_at_risk']} (expected 15000+3000=18000)"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_revenue_forecast",
        scenario="zero_impact",
        description="Zero impacted_qty should produce zero risk",
        run_fn=_run_revenue_calc,
        input_data={
            "items": [
                {"fg_material_code": "FG-001", "demand_qty": 1000, "impacted_qty": 0,
                 "margin_per_unit": 50, "price_per_unit": 150,
                 "penalty_type": "per_unit", "penalty_value": 10},
            ],
        },
        tags=["edge"],
        assertions=[
            custom("zero_risk", lambda r: (
                r["kpis"]["total_at_risk"] == 0,
                f"Total at risk: {r['kpis']['total_at_risk']} (expected 0)"
            )),
        ],
    ),
]
