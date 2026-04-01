"""
run_cost_forecast_spec.py — Eval specs for cost forecast

NOTE: run_cost_forecast is a JS service that depends on:
  1. Supabase auth (user session)
  2. Upstream plan run (sourceRunId)
  3. Cost rule sets from DB

These specs test the cost calculation logic in isolation,
not the full JS service flow (which requires integration tests).
"""

from ml.api.tool_eval import (
    ToolTestSpec, custom,
)


def _run_cost_calc(input_data):
    """
    Simulate cost calculation logic without Supabase dependencies.
    Tests the mathematical correctness of cost formulas.
    """
    # Cost calculation is JS-side, so we test the formula logic here
    materials = input_data.get("materials", [])
    rules = input_data.get("rules", {})
    results = []

    for mat in materials:
        qty = mat.get("qty", 0)
        unit_cost = mat.get("unit_cost", 0)
        action = mat.get("action", "normal")

        base_cost = qty * unit_cost
        markup = rules.get("markup_pct", 0) / 100
        expedite_premium = rules.get("expedite_premium_pct", 50) / 100

        if action == "expedite":
            total_cost = base_cost * (1 + markup + expedite_premium)
        elif action == "substitute":
            sub_premium = rules.get("substitution_premium_pct", 20) / 100
            total_cost = base_cost * (1 + markup + sub_premium)
        else:
            total_cost = base_cost * (1 + markup)

        results.append({
            "material": mat.get("material_code"),
            "action": action,
            "base_cost": round(base_cost, 2),
            "total_cost": round(total_cost, 2),
        })

    return {
        "success": True,
        "results": results,
        "total": round(sum(r["total_cost"] for r in results), 2),
    }


SPECS = [
    ToolTestSpec(
        tool_id="run_cost_forecast",
        scenario="normal_procurement",
        description="Normal procurement cost = qty * unit_cost * (1 + markup)",
        run_fn=_run_cost_calc,
        input_data={
            "materials": [
                {"material_code": "MAT-001", "qty": 100, "unit_cost": 50, "action": "normal"},
                {"material_code": "MAT-002", "qty": 200, "unit_cost": 30, "action": "normal"},
            ],
            "rules": {"markup_pct": 10},
        },
        tags=["fast", "core"],
        assertions=[
            custom("total_correct", lambda r: (
                abs(r["total"] - 11500) < 0.01,  # (100*50 + 200*30) * 1.1 = 11500
                f"Total: {r['total']} (expected 11500)"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_cost_forecast",
        scenario="expedite_premium",
        description="Expedite action adds 50% premium on top of markup",
        run_fn=_run_cost_calc,
        input_data={
            "materials": [
                {"material_code": "MAT-001", "qty": 100, "unit_cost": 50, "action": "expedite"},
            ],
            "rules": {"markup_pct": 10, "expedite_premium_pct": 50},
        },
        tags=["fast"],
        assertions=[
            custom("expedite_cost", lambda r: (
                abs(r["results"][0]["total_cost"] - 8000) < 0.01,
                # 100 * 50 * (1 + 0.1 + 0.5) = 8000
                f"Cost: {r['results'][0]['total_cost']} (expected 8000)"
            )),
        ],
    ),
]
