"""
Phase 3 – Deliverable 3.3: Simulation → Re-Optimization Feedback Loop
──────────────────────────────────────────────────────────────────────
Takes simulation results (stockouts, excess inventory, costs) and
derives constraint tightening inputs for the replenishment solver.

Usage:
    from ml.simulation.feedback_loop import derive_reoptimization_inputs

    reopt = derive_reoptimization_inputs(sim_result, original_plan)
"""
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def derive_reoptimization_inputs(
    sim_result: Dict[str, Any],
    original_plan: Optional[Dict[str, Any]] = None,
    config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Analyze simulation results and derive constraint tightening inputs
    for re-optimization.

    Args:
        sim_result: Output from SimulationOrchestrator.run().to_dict().
            Expected keys: kpis, daily_log, scenario, etc.
        original_plan: The original planning payload (optional, for diffing).
        config: Override thresholds.

    Returns:
        Dict with:
          - adjustments: List of {type, sku, plant_id, adjustment, reason}
          - constraint_overrides: Dict to merge into solver payload
          - summary: Human-readable summary
          - should_reoptimize: bool
    """
    cfg = {
        "min_fill_rate_pct": 95.0,
        "max_stockout_days_pct": 5.0,
        "excess_inventory_threshold_pct": 150.0,
        "safety_stock_uplift_pct": 20.0,
        "max_iterations": 3,
        **(config or {}),
    }

    kpis = sim_result.get("kpis", {})
    fill_rate = kpis.get("fill_rate_pct", 100.0)
    stockout_days = kpis.get("stockout_days", 0)
    total_days = kpis.get("total_days", 1)
    avg_inventory = kpis.get("avg_inventory", 0)
    total_cost = kpis.get("total_cost", 0)

    adjustments = []
    constraint_overrides = {}
    reasons = []

    # --- Check fill rate ---
    if fill_rate < cfg["min_fill_rate_pct"]:
        gap_pct = cfg["min_fill_rate_pct"] - fill_rate
        uplift = cfg["safety_stock_uplift_pct"] * (1 + gap_pct / 100)
        adjustments.append({
            "type": "safety_stock_uplift",
            "adjustment_pct": round(uplift, 2),
            "reason": f"Fill rate {fill_rate:.1f}% below target {cfg['min_fill_rate_pct']}%",
        })
        constraint_overrides["safety_stock_multiplier"] = round(1 + uplift / 100, 4)
        reasons.append(f"Low fill rate ({fill_rate:.1f}%)")

    # --- Check stockout frequency ---
    stockout_pct = (stockout_days / total_days * 100) if total_days > 0 else 0
    if stockout_pct > cfg["max_stockout_days_pct"]:
        adjustments.append({
            "type": "stockout_penalty_increase",
            "adjustment_multiplier": 1.5,
            "reason": f"Stockout days {stockout_pct:.1f}% exceeds {cfg['max_stockout_days_pct']}% threshold",
        })
        constraint_overrides["stockout_penalty_multiplier"] = 1.5
        reasons.append(f"High stockout frequency ({stockout_pct:.1f}%)")

    # --- Check excess inventory ---
    if original_plan:
        target_inventory = original_plan.get("target_avg_inventory", avg_inventory)
        if target_inventory > 0:
            excess_ratio = (avg_inventory / target_inventory) * 100
            if excess_ratio > cfg["excess_inventory_threshold_pct"]:
                adjustments.append({
                    "type": "holding_cost_increase",
                    "adjustment_multiplier": 1.3,
                    "reason": f"Avg inventory {excess_ratio:.0f}% of target",
                })
                constraint_overrides["holding_cost_multiplier"] = 1.3
                reasons.append(f"Excess inventory ({excess_ratio:.0f}% of target)")

    should_reoptimize = len(adjustments) > 0

    summary = "Simulation feedback: "
    if should_reoptimize:
        summary += "; ".join(reasons)
        summary += f". Recommending re-optimization with {len(adjustments)} adjustments."
    else:
        summary += f"Fill rate {fill_rate:.1f}%, no adjustments needed."

    return {
        "should_reoptimize": should_reoptimize,
        "adjustments": adjustments,
        "constraint_overrides": constraint_overrides,
        "summary": summary,
        "sim_kpis": {
            "fill_rate_pct": round(fill_rate, 2),
            "stockout_days": stockout_days,
            "stockout_pct": round(stockout_pct, 2),
            "avg_inventory": round(avg_inventory, 2),
            "total_cost": round(total_cost, 2),
        },
        "config_used": cfg,
    }
