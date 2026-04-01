"""
risk_score_spec.py — Eval specs for risk score calculation

NOTE: JS service. Tests simulate the core formula:
  score = p_stockout * impact_usd * urgency_weight

Urgency weights: W+0=1.5, W+1=1.2, W+2+=1.0, noRisk=0.5
Score is in absolute dollar-risk units (unbounded above, floored at 0).
"""

from ml.api.tool_eval import ToolTestSpec, custom


def _calc_risk_score(input_data):
    """Simulate risk score domain logic."""
    items = input_data.get("items", [])
    current_bucket = input_data.get("current_bucket", "2026-W10")
    results = []

    urgency_map = {"W+0": 1.5, "W+1": 1.2, "W+2": 1.0, "none": 0.5}

    for item in items:
        p_stockout = max(0.0, min(1.0, item.get("p_stockout", 0)))
        margin_at_risk = max(0, item.get("margin_at_risk", 0))
        penalty_at_risk = max(0, item.get("penalty_at_risk", 0))
        impact_usd = margin_at_risk + penalty_at_risk
        urgency_key = item.get("urgency", "W+2")
        urgency_weight = urgency_map.get(urgency_key, 1.0)

        score = p_stockout * impact_usd * urgency_weight

        tier = "high" if score > 10000 else ("medium" if score > 1000 else "low")

        results.append({
            "material": item.get("material_code", "?"),
            "score": round(score, 2),
            "tier": tier,
            "p_stockout": p_stockout,
            "impact_usd": impact_usd,
            "urgency_weight": urgency_weight,
        })

    results.sort(key=lambda r: -r["score"])
    total = sum(r["score"] for r in results)
    high_count = sum(1 for r in results if r["tier"] == "high")

    return {
        "success": True,
        "results": results,
        "kpis": {
            "total_score": round(total, 2),
            "avg_score": round(total / max(len(results), 1), 2),
            "high_risk_count": high_count,
            "total_keys": len(results),
        },
    }


SPECS = [
    ToolTestSpec(
        tool_id="run_risk_score",
        scenario="normal_risk_calculation",
        description="p_stockout=0.8, impact=$50K, urgency W+0 → score = 0.8 * 50000 * 1.5 = 60000 (high)",
        run_fn=_calc_risk_score,
        input_data={
            "items": [
                {"material_code": "MAT-001", "p_stockout": 0.8,
                 "margin_at_risk": 40000, "penalty_at_risk": 10000, "urgency": "W+0"},
            ],
        },
        tags=["core"],
        assertions=[
            custom("score_60k", lambda r: (
                abs(r["results"][0]["score"] - 60000) < 0.01,
                f"Score: {r['results'][0]['score']} (expected 60000)"
            )),
            custom("tier_high", lambda r: (
                r["results"][0]["tier"] == "high",
                f"Tier: {r['results'][0]['tier']}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_risk_score",
        scenario="zero_demand_zero_risk",
        description="p_stockout=0, impact=0 → score = 0, no NaN",
        run_fn=_calc_risk_score,
        input_data={
            "items": [
                {"material_code": "MAT-002", "p_stockout": 0,
                 "margin_at_risk": 0, "penalty_at_risk": 0, "urgency": "none"},
            ],
        },
        tags=["edge"],
        assertions=[
            custom("score_zero", lambda r: (
                r["results"][0]["score"] == 0,
                f"Score: {r['results'][0]['score']}"
            )),
            custom("tier_low", lambda r: (
                r["results"][0]["tier"] == "low",
                f"Tier: {r['results'][0]['tier']}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_risk_score",
        scenario="high_shortage_near_term",
        description="100% stockout probability, $100K impact, W+0 urgency → score 150K",
        run_fn=_calc_risk_score,
        input_data={
            "items": [
                {"material_code": "MAT-003", "p_stockout": 1.0,
                 "margin_at_risk": 80000, "penalty_at_risk": 20000, "urgency": "W+0"},
            ],
        },
        tags=["core"],
        assertions=[
            custom("score_150k", lambda r: (
                abs(r["results"][0]["score"] - 150000) < 0.01,
                f"Score: {r['results'][0]['score']} (expected 1.0 * 100000 * 1.5 = 150000)"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_risk_score",
        scenario="ranking_by_score",
        description="3 items with different risk → sorted by score descending",
        run_fn=_calc_risk_score,
        input_data={
            "items": [
                {"material_code": "LOW", "p_stockout": 0.1, "margin_at_risk": 500, "penalty_at_risk": 0, "urgency": "W+2"},
                {"material_code": "HIGH", "p_stockout": 0.9, "margin_at_risk": 50000, "penalty_at_risk": 10000, "urgency": "W+0"},
                {"material_code": "MED", "p_stockout": 0.5, "margin_at_risk": 5000, "penalty_at_risk": 0, "urgency": "W+1"},
            ],
        },
        tags=["core"],
        assertions=[
            custom("sorted_desc", lambda r: (
                r["results"][0]["material"] == "HIGH" and r["results"][-1]["material"] == "LOW",
                f"Order: {[x['material'] for x in r['results']]}"
            )),
        ],
    ),
]
