import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest

ortools = pytest.importorskip("ortools", reason="ortools not installed")

from ml.api.replenishment_solver import solve_replenishment, solve_replenishment_multi_echelon

from tests.planning_test_utils import load_fixture, to_namespace


def _simulate_inventory_cap(payload, result):
    inv_rows = payload.get("inventory") or []
    if not inv_rows:
        return []

    seed = {
        (row["sku"], row.get("plant_id") or ""): float(row.get("on_hand") or 0.0)
        for row in inv_rows
    }

    demand_by_key_day = defaultdict(float)
    for row in payload["demand_forecast"]["series"]:
        key = (row["sku"], row.get("plant_id") or "")
        demand_by_key_day[(key, row["date"])] += float(row.get("p50") or 0.0)

    arrivals = defaultdict(float)
    for row in result.get("plan_lines") or []:
        key = (row["sku"], row.get("plant_id") or "")
        arrivals[(key, row["arrival_date"])] += float(row.get("order_qty") or 0.0)

    open_pos = defaultdict(float)
    for row in payload.get("open_pos") or []:
        key = (row["sku"], row.get("plant_id") or "")
        open_pos[(key, row["eta_date"])] += float(row.get("qty") or 0.0)

    all_days = sorted({row["date"] for row in payload["demand_forecast"]["series"]})
    projected = []
    for day in all_days:
        total_positive = 0.0
        for key in list(seed.keys()):
            stock = seed[key]
            stock += arrivals[(key, day)]
            stock += open_pos[(key, day)]
            stock -= demand_by_key_day[(key, day)]
            seed[key] = stock
            total_positive += max(0.0, stock)
        projected.append((day, total_positive))
    return projected


def test_inventory_capacity_binds_and_is_respected():
    fixture = load_fixture("tight_capacity_single.json")
    result = solve_replenishment(to_namespace(fixture))

    cap = float(fixture["shared_constraints"]["inventory_capacity_per_period"])
    projected = _simulate_inventory_cap(fixture, result)
    assert projected
    assert all(total <= cap + 1e-6 for _, total in projected)

    checks = result["proof"]["constraints_checked"]
    inv_checks = [
        c
        for c in checks
        if c["name"] in {"inventory_capacity", "shared_inventory_capacity", "shared_inventory_cap"}
    ]
    assert inv_checks


def test_capacity_infeasible_returns_tags_and_diagnose_output():
    fixture = load_fixture("infeasible_capacity_single.json")
    result = solve_replenishment(to_namespace(fixture))

    assert result["status"] == "INFEASIBLE"
    reasons = "\n".join(result.get("infeasible_reasons") or [])
    assert "CAP_PROD" in reasons or "CAP_INV" in reasons

    details = result.get("infeasible_reason_details") or []
    assert details
    assert details[0].get("category") in {"capacity", "demand_infeasible", "budget", "moq_pack", "lead_time"}
    assert details[0].get("suggested_actions")

    diagnostics = result.get("diagnostics") or {}
    assert diagnostics.get("mode") == "progressive_relaxation"
    assert diagnostics.get("relaxation_analysis")


def test_multi_echelon_bom_shortage_has_actionable_diagnostics():
    fixture = load_fixture("multi_echelon_bom_shortage.json")
    result = solve_replenishment_multi_echelon(to_namespace(fixture))

    assert result["status"] == "INFEASIBLE"
    assert result.get("bottlenecks", {}).get("total_rows", 0) > 0

    check_names = {c.get("name") for c in (result.get("proof", {}).get("constraints_checked") or [])}
    assert "component_feasibility" in check_names

    details = result.get("infeasible_reason_details") or []
    assert details
    assert details[0].get("top_offending_tags")
    assert details[0].get("suggested_actions")
