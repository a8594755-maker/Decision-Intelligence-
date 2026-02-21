"""Planning API contract parity + capacity enforcement tests."""
import os
import sys
from datetime import date, timedelta
from types import SimpleNamespace
from typing import Dict, List, Optional

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

pytest.importorskip("ortools", reason="ortools not installed")

from ml.api.replenishment_solver import solve_replenishment, solve_replenishment_multi_echelon
from ml.api.replenishment_heuristic import solve_replenishment_heuristic


STATUSES = {"OPTIMAL", "FEASIBLE", "INFEASIBLE", "TIMEOUT", "ERROR"}


def _day(offset: int, base: str = "2025-06-01") -> str:
    y, m, d = map(int, base.split("-"))
    return (date(y, m, d) + timedelta(days=offset)).isoformat()


def _series(
    sku: str,
    plant_id: str,
    n_days: int,
    p50: float,
    step_days: int = 1,
) -> List[SimpleNamespace]:
    return [
        SimpleNamespace(sku=sku, plant_id=plant_id, date=_day(i * step_days), p50=p50, p90=None)
        for i in range(n_days)
    ]


def _inventory(
    sku: str,
    plant_id: str,
    on_hand: float = 0.0,
    safety_stock: float = 0.0,
    lead_time_days: float = 0.0,
) -> SimpleNamespace:
    return SimpleNamespace(
        sku=sku,
        plant_id=plant_id,
        as_of_date=_day(0),
        on_hand=on_hand,
        safety_stock=safety_stock,
        lead_time_days=lead_time_days,
    )


def _request_single(
    series: List[SimpleNamespace],
    inventory: Optional[List[SimpleNamespace]] = None,
    moq: Optional[List[SimpleNamespace]] = None,
    horizon_days: int = 7,
    budget_cap: Optional[float] = None,
    stockout_penalty: float = 2.0,
    holding_cost: float = 0.0,
    inventory_capacity: Optional[float] = None,
    service_level_target: Optional[float] = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        contract_version="1.0",
        planning_horizon_days=horizon_days,
        demand_forecast=SimpleNamespace(series=series or [], granularity="daily"),
        inventory=inventory or [],
        open_pos=[],
        constraints=SimpleNamespace(
            moq=moq or [],
            pack_size=[],
            max_order_qty=[],
            budget_cap=budget_cap,
            unit_costs=[],
            inventory_capacity_per_period=inventory_capacity,
            production_capacity_per_period=None,
        ),
        objective=SimpleNamespace(
            optimize_for="balanced",
            stockout_penalty=stockout_penalty,
            holding_cost=holding_cost,
            service_level_target=service_level_target,
        ),
        multi_echelon=SimpleNamespace(
            mode="off",
            inventory_capacity_per_period=inventory_capacity,
            production_capacity_per_period=None,
            max_bom_depth=50,
            bom_explosion_used=False,
            bom_explosion_reused=False,
            lot_sizing_mode="moq_pack",
        ),
        bom_usage=[],
    )


def _request_multi(
    series: List[SimpleNamespace],
    inventory: List[SimpleNamespace],
    bom_usage: List[SimpleNamespace],
    inventory_capacity: Optional[float] = None,
    production_capacity: Optional[float] = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        contract_version="1.0",
        planning_horizon_days=14,
        demand_forecast=SimpleNamespace(series=series, granularity="daily"),
        inventory=inventory,
        open_pos=[],
        constraints=SimpleNamespace(
            moq=[],
            pack_size=[],
            max_order_qty=[],
            budget_cap=None,
            unit_costs=[],
            inventory_capacity_per_period=inventory_capacity,
            production_capacity_per_period=production_capacity,
        ),
        objective=SimpleNamespace(
            optimize_for="balanced",
            stockout_penalty=2.0,
            holding_cost=0.0,
            service_level_target=None,
        ),
        multi_echelon=SimpleNamespace(
            mode="bom_v0",
            lot_sizing_mode="moq_pack",
            max_bom_depth=50,
            bom_explosion_used=True,
            bom_explosion_reused=False,
            production_capacity_per_period=production_capacity,
            inventory_capacity_per_period=inventory_capacity,
            component_stockout_penalty=5.0,
            fg_to_components_scope={},
            mapping_rules={},
        ),
        bom_usage=bom_usage,
    )


def _moq(sku: str, min_qty: float) -> SimpleNamespace:
    return SimpleNamespace(sku=sku, min_qty=min_qty)


def _bom(fg_sku: str, component_sku: str, usage_qty: float, plant_id: str = "P1") -> SimpleNamespace:
    return SimpleNamespace(
        fg_sku=fg_sku,
        component_sku=component_sku,
        usage_qty=usage_qty,
        plant_id=plant_id,
        level=1,
        path_count=1,
    )


def _assert_contract_shape(resp: Dict):
    required_keys = {
        "contract_version",
        "status",
        "plan_lines",
        "plan",
        "component_plan",
        "component_inventory_projection",
        "bottlenecks",
        "kpis",
        "solver_meta",
        "infeasible_reasons",
        "proof",
    }
    assert required_keys <= set(resp.keys())
    assert resp["status"] in STATUSES
    assert isinstance(resp["plan_lines"], list)
    assert isinstance(resp["plan"], list)
    assert isinstance(resp["kpis"], dict)
    assert isinstance(resp["proof"], dict)
    assert isinstance(resp["proof"].get("constraints_checked"), list)
    assert isinstance(resp["proof"].get("objective_terms"), list)
    assert isinstance(resp["solver_meta"], dict)
    assert "engine" in resp["solver_meta"]
    assert "solve_time_ms" in resp["solver_meta"]
    assert "status" in resp["solver_meta"]


def _simulate_inventory_end_by_day(req: SimpleNamespace, plan_rows: List[Dict]) -> List[float]:
    series = sorted(req.demand_forecast.series, key=lambda r: r.date)
    sku = str(series[0].sku)
    plant = str(series[0].plant_id)

    demand_by_day: Dict[str, float] = {}
    for row in series:
        demand_by_day[row.date] = demand_by_day.get(row.date, 0.0) + float(row.p50)

    arrival_by_day: Dict[str, float] = {}
    for row in plan_rows:
        if row.get("sku") == sku and (row.get("plant_id") or "") == plant:
            arrival_day = str(row.get("arrival_date"))
            arrival_by_day[arrival_day] = arrival_by_day.get(arrival_day, 0.0) + float(row.get("order_qty", 0.0))

    on_hand = 0.0
    for inv in req.inventory:
        if str(inv.sku) == sku and str(inv.plant_id) == plant:
            on_hand = float(inv.on_hand)
            break

    end_inventory = []
    for day in sorted(demand_by_day.keys()):
        on_hand += arrival_by_day.get(day, 0.0)
        on_hand -= demand_by_day.get(day, 0.0)
        end_inventory.append(on_hand)
    return end_inventory


def _contains_capacity_tag(constraints_checked: List[Dict], tag_prefix: str) -> bool:
    for item in constraints_checked:
        if tag_prefix in str(item.get("tag", "")):
            return True
        tags = item.get("tags")
        if isinstance(tags, list) and any(tag_prefix in str(tag) for tag in tags):
            return True
    return False


class TestPlanningContractParity:
    def test_single_engine_schema_parity(self):
        req = _request_single(
            series=_series("SKU-A", "P1", n_days=4, p50=8.0),
            inventory=[_inventory("SKU-A", "P1", on_hand=2.0, lead_time_days=0.0)],
            horizon_days=4,
            stockout_penalty=3.0,
        )

        cp_resp = solve_replenishment(req)
        heur_resp = solve_replenishment_heuristic(req)

        _assert_contract_shape(cp_resp)
        _assert_contract_shape(heur_resp)

        assert set(cp_resp.keys()) == set(heur_resp.keys())
        assert cp_resp["status"] in STATUSES
        assert heur_resp["status"] in STATUSES

        assert cp_resp["contract_version"] == "1.0"
        assert heur_resp["contract_version"] == "1.0"

        assert cp_resp["solver_meta"]["engine"] == "cp_sat"
        assert heur_resp["solver_meta"]["engine"] == "heuristic"


class TestCapacityConstraints:
    def test_binding_inventory_capacity_single(self):
        req = _request_single(
            series=_series("SKU-CAP", "P1", n_days=4, p50=5.0),
            inventory=[_inventory("SKU-CAP", "P1", on_hand=0.0, lead_time_days=0.0)],
            moq=[_moq("SKU-CAP", 10.0)],
            horizon_days=4,
            stockout_penalty=50.0,
            inventory_capacity=5.0,
        )

        result = solve_replenishment(req)
        _assert_contract_shape(result)

        end_inventory = _simulate_inventory_end_by_day(req, result["plan_lines"])
        assert all(value <= 5.0 + 1e-6 for value in end_inventory)
        assert any(abs(value - 5.0) <= 1e-6 for value in end_inventory)

        constraints_checked = result["proof"]["constraints_checked"]
        assert _contains_capacity_tag(constraints_checked, "CAP_INV[")

    def test_inventory_capacity_can_drive_infeasible_status(self):
        req = _request_single(
            series=_series("SKU-INF", "P1", n_days=3, p50=6.0),
            inventory=[_inventory("SKU-INF", "P1", on_hand=0.0, lead_time_days=0.0)],
            moq=[_moq("SKU-INF", 20.0)],
            horizon_days=3,
            stockout_penalty=100.0,
            inventory_capacity=1.0,
            service_level_target=1.0,
        )

        result = solve_replenishment(req)
        _assert_contract_shape(result)

        assert result["status"] == "INFEASIBLE"
        reason_blob = " ".join(result.get("infeasible_reasons") or [])
        assert "CAP_INV" in reason_blob or "Inventory capacity" in reason_blob

        constraints_checked = result["proof"]["constraints_checked"]
        assert _contains_capacity_tag(constraints_checked, "CAP_INV[")

    def test_multi_echelon_capacity_tags_and_bom_consistency(self):
        req = _request_multi(
            series=_series("FG-A", "P1", n_days=2, p50=8.0, step_days=7),
            inventory=[
                _inventory("FG-A", "P1", on_hand=0.0, lead_time_days=0.0),
                _inventory("COMP-1", "P1", on_hand=200.0, lead_time_days=0.0),
            ],
            bom_usage=[_bom("FG-A", "COMP-1", 2.0, plant_id="P1")],
            inventory_capacity=250.0,
            production_capacity=20.0,
        )

        result = solve_replenishment_multi_echelon(req)
        _assert_contract_shape(result)

        assert result["status"] in STATUSES
        constraints_checked = result["proof"]["constraints_checked"]
        assert _contains_capacity_tag(constraints_checked, "CAP_INV[")
        assert _contains_capacity_tag(constraints_checked, "CAP_PROD[")

        bom_check = next((c for c in constraints_checked if c.get("name") == "bom_coupling"), None)
        assert bom_check is not None
        assert bom_check.get("passed") is True

        projection_rows = result.get("component_inventory_projection", {}).get("rows", [])
        assert isinstance(projection_rows, list)
        for row in projection_rows:
            assert float(row.get("on_hand_end", 0.0)) >= -1e-6
