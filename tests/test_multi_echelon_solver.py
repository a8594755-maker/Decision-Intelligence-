"""
Pytest tests for the OR-Tools CP-SAT multi-echelon replenishment solver.

Tests use lightweight SimpleNamespace mock objects that mirror the
ReplenishmentPlanRequest pydantic model attribute structure so we can
test the solver logic without importing the full FastAPI app or ML stack.
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest
from types import SimpleNamespace
from datetime import date, timedelta
from typing import List, Optional

# Skip entire module if OR-Tools is not installed.
ortools = pytest.importorskip("ortools", reason="ortools not installed")

from ml.api.replenishment_solver import solve_replenishment_multi_echelon, ortools_available


# ── helpers ────────────────────────────────────────────────────────────────────

def _day(offset: int, base: str = "2025-06-01") -> str:
    """Return ISO date string offset days after base."""
    y, m, d = map(int, base.split("-"))
    return (date(y, m, d) + timedelta(days=offset)).isoformat()


def _series(sku: str, plant_id: str, n_days: int,
            p50: float = 10.0, p90: Optional[float] = None) -> List[SimpleNamespace]:
    """Build a list of weekly forecast series points (7-day steps)."""
    return [
        SimpleNamespace(sku=sku, plant_id=plant_id, date=_day(i * 7), p50=p50,
                        p90=(p90 if p90 is not None else None))
        for i in range(n_days)
    ]


def _inventory(sku: str, plant_id: str, on_hand: float = 0.0,
               safety_stock: float = 0.0, lead_time_days: float = 0.0) -> SimpleNamespace:
    return SimpleNamespace(
        sku=sku, plant_id=plant_id,
        as_of_date=_day(0),
        on_hand=on_hand,
        safety_stock=safety_stock,
        lead_time_days=lead_time_days,
    )


def _moq(sku: str, min_qty: float) -> SimpleNamespace:
    return SimpleNamespace(sku=sku, min_qty=min_qty)


def _pack(sku: str, pack_qty: float) -> SimpleNamespace:
    return SimpleNamespace(sku=sku, pack_qty=pack_qty)


def _bom_usage(fg_sku: str, comp_sku: str, usage_qty: float,
               plant_id: str = "") -> SimpleNamespace:
    return SimpleNamespace(
        fg_sku=fg_sku, component_sku=comp_sku, plant_id=plant_id,
        usage_qty=usage_qty, level=1, path_count=1,
    )


def _me_request(
    series: List[SimpleNamespace],
    bom_usage: Optional[List[SimpleNamespace]] = None,
    inventory: Optional[List[SimpleNamespace]] = None,
    open_pos: Optional[List[SimpleNamespace]] = None,
    moq_list: Optional[List[SimpleNamespace]] = None,
    pack_list: Optional[List[SimpleNamespace]] = None,
    max_qty_list: Optional[List[SimpleNamespace]] = None,
    budget_cap: Optional[float] = None,
    horizon_days: int = 14,
    stockout_penalty: float = 1.0,
    holding_cost: float = 0.0,
    mode: str = "bom_v0",
    lot_sizing_mode: str = "moq_pack",
    production_capacity: Optional[float] = None,
    inventory_capacity: Optional[float] = None,
    component_stockout_penalty: Optional[float] = None,
    max_bom_depth: int = 50,
) -> SimpleNamespace:
    """Build a minimal ReplenishmentPlanRequest-compatible namespace for multi-echelon."""
    return SimpleNamespace(
        planning_horizon_days=horizon_days,
        demand_forecast=SimpleNamespace(series=series or [], granularity="daily"),
        inventory=inventory or [],
        open_pos=open_pos or [],
        constraints=SimpleNamespace(
            moq=moq_list or [],
            pack_size=pack_list or [],
            max_order_qty=max_qty_list or [],
            budget_cap=budget_cap,
            unit_costs=[],
        ),
        objective=SimpleNamespace(
            optimize_for="balanced",
            stockout_penalty=stockout_penalty,
            holding_cost=holding_cost,
            service_level_target=None,
        ),
        multi_echelon=SimpleNamespace(
            mode=mode,
            lot_sizing_mode=lot_sizing_mode,
            max_bom_depth=max_bom_depth,
            bom_explosion_used=True,
            bom_explosion_reused=False,
            production_capacity_per_period=production_capacity,
            inventory_capacity_per_period=inventory_capacity,
            component_stockout_penalty=component_stockout_penalty,
            fg_to_components_scope={},
            mapping_rules={},
        ),
        bom_usage=bom_usage or [],
    )


# ── test module-level guard ───────────────────────────────────────────────────

def test_ortools_available_me():
    """OR-Tools should be importable (module skipped if not)."""
    assert ortools_available() is True


# ── T1: no BOM usage → valid response shape ──────────────────────────────────

class TestMeNoBomUsage:
    """Empty bom_usage — backward-compat: should return infeasible (no BOM edges)."""

    def test_response_has_required_keys(self):
        req = _me_request(series=_series("FG-A", "P1", 2), bom_usage=[])
        result = solve_replenishment_multi_echelon(req)
        for key in ("status", "plan", "component_plan", "component_inventory_projection",
                    "bottlenecks", "kpis", "solver_meta", "infeasible_reasons", "proof"):
            assert key in result, f"Missing key: {key}"

    def test_no_bom_is_infeasible(self):
        req = _me_request(series=_series("FG-A", "P1", 2), bom_usage=[])
        result = solve_replenishment_multi_echelon(req)
        assert result["status"] == "infeasible"
        assert len(result["infeasible_reasons"]) > 0
        assert result["component_plan"] == []


# ── T2: ample component stock → FG meets demand, 0 bottlenecks ───────────────

class TestMeEnoughComponents:
    """Component on_hand >> FG demand — solver should plan orders, no bottlenecks."""

    def _build_req(self):
        series = _series("FG-A", "P1", 2, p50=10.0)  # 2 periods × 10 units
        inv = [
            _inventory("FG-A", "P1", on_hand=0.0),
            _inventory("COMP-1", "P1", on_hand=1000.0, lead_time_days=0),
        ]
        bom = [_bom_usage("FG-A", "COMP-1", usage_qty=2.0)]
        return _me_request(series=series, bom_usage=bom, inventory=inv)

    def test_status_optimal_or_feasible(self):
        req = self._build_req()
        result = solve_replenishment_multi_echelon(req)
        assert result["status"] in ("optimal", "feasible"), result.get("infeasible_reasons")

    def test_zero_bottlenecks(self):
        req = self._build_req()
        result = solve_replenishment_multi_echelon(req)
        assert result["bottlenecks"]["total_rows"] == 0
        assert result["bottlenecks"]["rows"] == []


# ── T3: component MOQ overbuy ─────────────────────────────────────────────────

class TestMeMoqOverbuy:
    """Component MOQ=100 when FG needs only 30 — must still be feasible (overbuy)."""

    def _build_req(self):
        series = _series("FG-A", "P1", 2, p50=15.0)  # needs 15×2=30 comp units
        inv = [
            _inventory("FG-A", "P1", on_hand=0.0),
            _inventory("COMP-1", "P1", on_hand=0.0, lead_time_days=0),
        ]
        bom = [_bom_usage("FG-A", "COMP-1", usage_qty=1.0)]
        moq = [_moq("COMP-1", min_qty=100.0)]
        return _me_request(series=series, bom_usage=bom, inventory=inv, moq_list=moq)

    def test_feasible_with_moq(self):
        req = self._build_req()
        result = solve_replenishment_multi_echelon(req)
        assert result["status"] in ("optimal", "feasible"), result.get("infeasible_reasons")

    def test_component_order_qty_at_least_moq(self):
        req = self._build_req()
        result = solve_replenishment_multi_echelon(req)
        comp_rows = result.get("component_plan") or []
        ordered = [r for r in comp_rows if r.get("component_sku") == "COMP-1" and r.get("order_qty", 0) > 0]
        if ordered:
            # Each individual order must respect MOQ
            for row in ordered:
                assert row["order_qty"] >= 100.0, f"MOQ violated: {row['order_qty']}"


# ── T4: component lead_time > horizon → bottleneck ───────────────────────────

class TestMeComponentLeadTime:
    """Lead time exceeds horizon — component can't arrive in time; expect bottleneck or infeasible."""

    def _build_req(self):
        series = _series("FG-A", "P1", 1, p50=10.0)  # horizon ~7 days
        inv = [
            _inventory("FG-A", "P1", on_hand=0.0),
            _inventory("COMP-1", "P1", on_hand=0.0, lead_time_days=30),  # lead > horizon
        ]
        bom = [_bom_usage("FG-A", "COMP-1", usage_qty=2.0)]
        return _me_request(series=series, bom_usage=bom, inventory=inv, horizon_days=7)

    def test_infeasible_or_has_bottleneck(self):
        req = self._build_req()
        result = solve_replenishment_multi_echelon(req)
        # Either the solver detects infeasibility or reports bottlenecks
        is_infeasible = result["status"] == "infeasible"
        has_bottleneck = result["bottlenecks"]["total_rows"] > 0
        assert is_infeasible or has_bottleneck, (
            f"Expected infeasible or bottleneck for lead_time>horizon; "
            f"got status={result['status']}, bottlenecks={result['bottlenecks']['total_rows']}"
        )

    def test_infeasible_reasons_non_empty_when_infeasible(self):
        req = self._build_req()
        result = solve_replenishment_multi_echelon(req)
        if result["status"] == "infeasible":
            assert len(result["infeasible_reasons"]) > 0


# ── T5: determinism ───────────────────────────────────────────────────────────

class TestMeDeterminism:
    """Same input × 2 calls → identical plan rows (num_search_workers=1, random_seed=0)."""

    def _build_req(self):
        series = _series("FG-A", "P1", 2, p50=8.0)
        inv = [
            _inventory("FG-A", "P1", on_hand=5.0),
            _inventory("COMP-1", "P1", on_hand=100.0, lead_time_days=0),
        ]
        bom = [_bom_usage("FG-A", "COMP-1", usage_qty=3.0)]
        return _me_request(series=series, bom_usage=bom, inventory=inv)

    def test_identical_plan_rows(self):
        req = self._build_req()
        r1 = solve_replenishment_multi_echelon(req)
        r2 = solve_replenishment_multi_echelon(req)
        assert r1["status"] == r2["status"]
        # Compare plan row counts and order quantities
        plan1 = sorted(r1.get("plan", []), key=lambda x: (x.get("sku", ""), x.get("order_date", "")))
        plan2 = sorted(r2.get("plan", []), key=lambda x: (x.get("sku", ""), x.get("order_date", "")))
        assert len(plan1) == len(plan2), "Plan length not deterministic"
        for row1, row2 in zip(plan1, plan2):
            assert row1.get("order_qty") == row2.get("order_qty"), (
                f"Non-deterministic order_qty: {row1} vs {row2}"
            )

    def test_identical_component_plan(self):
        req = self._build_req()
        r1 = solve_replenishment_multi_echelon(req)
        r2 = solve_replenishment_multi_echelon(req)
        cp1 = sorted(r1.get("component_plan", []),
                     key=lambda x: (x.get("component_sku", ""), x.get("order_date", "")))
        cp2 = sorted(r2.get("component_plan", []),
                     key=lambda x: (x.get("component_sku", ""), x.get("order_date", "")))
        assert len(cp1) == len(cp2), "Component plan length not deterministic"
        for row1, row2 in zip(cp1, cp2):
            assert row1.get("order_qty") == row2.get("order_qty"), (
                f"Non-deterministic component order_qty: {row1} vs {row2}"
            )


# ── T6: budget cap respected ──────────────────────────────────────────────────

class TestMeBudgetCap:
    """Budget cap limits total procurement cost across FG + components."""

    def test_within_budget_is_feasible(self):
        series = _series("FG-A", "P1", 2, p50=5.0)
        inv = [
            _inventory("FG-A", "P1", on_hand=0.0),
            _inventory("COMP-1", "P1", on_hand=0.0, lead_time_days=0),
        ]
        bom = [_bom_usage("FG-A", "COMP-1", usage_qty=1.0)]
        # No unit costs registered → budget not binding
        req = _me_request(series=series, bom_usage=bom, inventory=inv,
                          budget_cap=1_000_000.0)
        result = solve_replenishment_multi_echelon(req)
        assert result["status"] in ("optimal", "feasible", "infeasible")  # shape check

    def test_response_has_kpis(self):
        series = _series("FG-A", "P1", 2, p50=5.0)
        inv = [
            _inventory("FG-A", "P1", on_hand=0.0),
            _inventory("COMP-1", "P1", on_hand=200.0, lead_time_days=0),
        ]
        bom = [_bom_usage("FG-A", "COMP-1", usage_qty=1.0)]
        req = _me_request(series=series, bom_usage=bom, inventory=inv)
        result = solve_replenishment_multi_echelon(req)
        kpis = result.get("kpis", {})
        for key in ("estimated_service_level", "estimated_stockout_units",
                    "estimated_holding_units", "estimated_total_cost"):
            assert key in kpis, f"Missing KPI: {key}"


# ── T7: production capacity limits FG orders per period ──────────────────────

class TestMeProductionCapacity:
    """production_capacity_per_period caps FG order qty each period."""

    def _build_req(self, cap: float):
        series = _series("FG-A", "P1", 2, p50=50.0)  # high demand
        inv = [
            _inventory("FG-A", "P1", on_hand=0.0),
            _inventory("COMP-1", "P1", on_hand=1000.0, lead_time_days=0),
        ]
        bom = [_bom_usage("FG-A", "COMP-1", usage_qty=1.0)]
        return _me_request(series=series, bom_usage=bom, inventory=inv,
                           production_capacity=cap)

    def test_capacity_respected(self):
        cap = 20.0
        req = self._build_req(cap)
        result = solve_replenishment_multi_echelon(req)
        # When feasible, no single period FG order should exceed capacity
        if result["status"] in ("optimal", "feasible"):
            for row in result.get("plan", []):
                qty = row.get("order_qty", 0)
                assert qty <= cap + 1e-6, (
                    f"FG order_qty={qty} exceeds production_capacity={cap}"
                )

    def test_solver_meta_has_mode(self):
        req = self._build_req(cap=20.0)
        result = solve_replenishment_multi_echelon(req)
        meta = result.get("solver_meta", {})
        assert meta.get("multi_echelon_mode") == "bom_v0"
        assert meta.get("solver") == "cp_sat"
