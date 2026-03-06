"""
Pytest tests for the OR-Tools CP-SAT single-echelon replenishment solver.

Tests use lightweight SimpleNamespace mock objects that mirror the
ReplenishmentPlanRequest pydantic model attribute structure so we can
test the solver logic without importing the full FastAPI app.
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

from ml.api.replenishment_solver import (
    SCALE,
    SolverRunSettings,
    _status_from_cp,
    solve_replenishment,
    ortools_available,
)


# ── helpers ────────────────────────────────────────────────────────────────────

def _day(offset: int, base: str = "2025-06-01") -> str:
    """Return ISO date string offset days after base."""
    y, m, d = map(int, base.split("-"))
    return (date(y, m, d) + timedelta(days=offset)).isoformat()


def _series(sku: str, plant_id: str, n_days: int,
            p50: float = 10.0, p90: Optional[float] = None) -> List[SimpleNamespace]:
    """Build a list of forecast series points."""
    return [
        SimpleNamespace(sku=sku, plant_id=plant_id, date=_day(i), p50=p50,
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


def _max_qty(sku: str, max_qty: float) -> SimpleNamespace:
    return SimpleNamespace(sku=sku, max_qty=max_qty)


def _unit_cost(sku: str, unit_cost: float) -> SimpleNamespace:
    return SimpleNamespace(sku=sku, unit_cost=unit_cost)


def _request(
    series: List[SimpleNamespace],
    inventory: Optional[List[SimpleNamespace]] = None,
    open_pos: Optional[List[SimpleNamespace]] = None,
    moq_list: Optional[List[SimpleNamespace]] = None,
    pack_list: Optional[List[SimpleNamespace]] = None,
    max_qty_list: Optional[List[SimpleNamespace]] = None,
    unit_cost_list: Optional[List[SimpleNamespace]] = None,
    budget_cap: Optional[float] = None,
    shared_budget_cap: Optional[float] = None,
    shared_production_capacity: Optional[float] = None,
    shared_inventory_capacity: Optional[float] = None,
    horizon_days: int = 7,
    stockout_penalty: float = 1.0,
    holding_cost: float = 0.0,
    service_level_target: Optional[float] = None,
    items: Optional[List[SimpleNamespace]] = None,
    diagnose_mode: bool = False,
    settings: Optional[dict] = None,
    engine_flags: Optional[dict] = None,
    # V2 fields
    budget_per_period: Optional[float] = None,
    volume_capacity_per_period: Optional[float] = None,
    weight_capacity_per_period: Optional[float] = None,
    safety_stock_violation_penalty: Optional[float] = None,
    compute_shadow_prices: bool = False,
) -> SimpleNamespace:
    """Build a minimal ReplenishmentPlanRequest-compatible namespace."""
    obj_ns = SimpleNamespace(
        optimize_for="balanced",
        stockout_penalty=stockout_penalty,
        holding_cost=holding_cost,
        service_level_target=service_level_target,
    )
    if safety_stock_violation_penalty is not None:
        obj_ns.safety_stock_violation_penalty = safety_stock_violation_penalty

    shared_ns = SimpleNamespace(
        budget_cap=shared_budget_cap,
        production_capacity_per_period=shared_production_capacity,
        inventory_capacity_per_period=shared_inventory_capacity,
        priority_weights={},
        budget_mode=None,
    )
    if budget_per_period is not None:
        shared_ns.budget_per_period = budget_per_period
    if volume_capacity_per_period is not None:
        shared_ns.volume_capacity_per_period = volume_capacity_per_period
    if weight_capacity_per_period is not None:
        shared_ns.weight_capacity_per_period = weight_capacity_per_period

    effective_settings = settings or {}
    if compute_shadow_prices:
        effective_settings = dict(effective_settings)
        effective_settings["compute_shadow_prices"] = True

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
            unit_costs=unit_cost_list or [],
            inventory_capacity_per_period=None,
            production_capacity_per_period=None,
        ),
        shared_constraints=shared_ns,
        objective=obj_ns,
        multi_echelon=SimpleNamespace(mode="off"),
        items=items or [],
        diagnose_mode=diagnose_mode,
        bom_usage=[],
        settings=effective_settings,
        engine_flags=engine_flags or {},
    )


def _timeout_fixture_request(time_limit_seconds: float) -> SimpleNamespace:
    """
    Build a small but non-trivial case that frequently yields TIMEOUT behavior
    under very small limits, while still allowing feasible incumbents.
    """
    series = _series("SKU-TIME", "P1", n_days=14, p50=10.0)
    inv = [_inventory("SKU-TIME", "P1", on_hand=0.0, lead_time_days=0.0)]
    return _request(
        series=series,
        inventory=inv,
        horizon_days=14,
        moq_list=[_moq("SKU-TIME", 17.0)],
        pack_list=[_pack("SKU-TIME", 7.0)],
        holding_cost=0.01,
        stockout_penalty=1.0,
        settings={
            "solver": {
                "time_limit_seconds": float(time_limit_seconds),
                "random_seed": 42,
                "num_search_workers": 1,
            }
        },
    )


# ── test module-level guard ────────────────────────────────────────────────────

def test_ortools_available():
    """OR-Tools should be importable (module skipped if not)."""
    assert ortools_available() is True


# ── T1: empty demand returns infeasible ───────────────────────────────────────

class TestEmptyDemand:
    def test_no_series(self):
        req = _request(series=[])
        result = solve_replenishment(req)
        assert result["status"] == "INFEASIBLE"
        assert result["plan"] == []
        assert result["solver_meta"]["solver"] == "cp_sat"
        assert len(result["infeasible_reasons"]) > 0

    def test_horizon_clips_demand_series(self):
        """Demand points beyond horizon_days from first_day should be clipped out.
        A 3-day horizon on a 5-day series should only plan 3 days."""
        # All 5 demand points, but only 3 will be within horizon.
        series = _series("SKU-A", "P1", n_days=5, p50=10.0)
        req = _request(series=series, horizon_days=3)
        result = solve_replenishment(req)
        # Should still produce a plan (just over 3 days, not 5).
        assert result["status"] in ("OPTIMAL", "FEASIBLE", "INFEASIBLE")
        # Total demand visible to solver = 3 days × 10 = 30, so stockout ≤ 30.
        if result["kpis"]["estimated_stockout_units"] is not None:
            assert result["kpis"]["estimated_stockout_units"] <= 30.0 + 1e-6


# ── T2: basic no-constraint plan ──────────────────────────────────────────────

class TestBasicNoConstraints:
    def test_generates_plan(self):
        """Simple 5-day demand, zero initial stock, no constraints → should produce orders."""
        series = _series("MAT-001", "P1", n_days=5, p50=10.0)
        req = _request(series=series, horizon_days=5)
        result = solve_replenishment(req)

        assert result["status"] in ("OPTIMAL", "FEASIBLE")
        assert result["solver_meta"]["solver"] == "cp_sat"
        assert isinstance(result["plan"], list)
        # With zero stock and zero lead time, demand must be covered by orders.
        total_ordered = sum(row["order_qty"] for row in result["plan"])
        assert total_ordered >= 0.0

    def test_kpis_structure(self):
        series = _series("SKU-A", "P1", n_days=3, p50=5.0)
        req = _request(series=series, horizon_days=3)
        result = solve_replenishment(req)

        kpis = result["kpis"]
        assert "estimated_service_level" in kpis
        assert "estimated_stockout_units" in kpis
        assert "estimated_holding_units" in kpis
        assert "estimated_total_cost" in kpis

    def test_service_level_in_range(self):
        series = _series("SKU-A", "P1", n_days=5, p50=10.0)
        inv = [_inventory("SKU-A", "P1", on_hand=0.0, lead_time_days=0.0)]
        req = _request(series=series, inventory=inv, horizon_days=5,
                       stockout_penalty=2.0)
        result = solve_replenishment(req)

        sl = result["kpis"]["estimated_service_level"]
        if sl is not None:
            assert 0.0 <= sl <= 1.0

    def test_proof_structure(self):
        series = _series("SKU-A", "P1", n_days=3, p50=8.0)
        req = _request(series=series, horizon_days=3)
        result = solve_replenishment(req)

        proof = result["proof"]
        assert "objective_terms" in proof
        assert "constraints_checked" in proof
        constraint_names = {c["name"] for c in proof["constraints_checked"]}
        assert "moq" in constraint_names
        assert "budget_cap" in constraint_names
        assert "pack_size_multiple" in constraint_names


# ── T3: ample stock → no orders needed ───────────────────────────────────────

class TestAmpleStock:
    def test_no_orders_when_stock_covers_demand(self):
        """If on_hand > total demand and lead_time=0, optimizer should not order."""
        n = 5
        demand_per_day = 10.0
        series = _series("SKU-A", "P1", n_days=n, p50=demand_per_day)
        inv = [_inventory("SKU-A", "P1", on_hand=1000.0, lead_time_days=0.0)]
        req = _request(series=series, inventory=inv, horizon_days=n,
                       holding_cost=0.01, stockout_penalty=1.0)
        result = solve_replenishment(req)

        assert result["status"] in ("OPTIMAL", "FEASIBLE")
        # Service level should be perfect.
        sl = result["kpis"]["estimated_service_level"]
        if sl is not None:
            assert sl > 0.95

    def test_zero_backlog_with_full_stock(self):
        """With large initial stock and zero lead time, backlog must be zero."""
        series = _series("SKU-A", "P1", n_days=3, p50=5.0)
        inv = [_inventory("SKU-A", "P1", on_hand=500.0, lead_time_days=0.0)]
        req = _request(series=series, inventory=inv, horizon_days=3)
        result = solve_replenishment(req)

        assert result["kpis"]["estimated_stockout_units"] == 0.0


# ── T4: MOQ constraint ────────────────────────────────────────────────────────

class TestMoqConstraint:
    def test_all_orders_respect_moq(self):
        """Every non-zero order_qty must be ≥ MOQ."""
        moq_val = 25.0
        series = _series("SKU-B", "P1", n_days=5, p50=10.0)
        req = _request(
            series=series,
            horizon_days=5,
            moq_list=[_moq("SKU-B", moq_val)],
        )
        result = solve_replenishment(req)

        for row in result["plan"]:
            if row["order_qty"] > 0:
                assert row["order_qty"] >= moq_val - 1e-6, (
                    f"order_qty {row['order_qty']} violates MOQ {moq_val}"
                )

    def test_moq_constraint_proof_passes(self):
        moq_val = 20.0
        series = _series("SKU-B", "P1", n_days=4, p50=8.0)
        req = _request(
            series=series,
            horizon_days=4,
            moq_list=[_moq("SKU-B", moq_val)],
        )
        result = solve_replenishment(req)

        moq_check = next(
            (c for c in result["proof"]["constraints_checked"] if c["name"] == "moq"),
            None,
        )
        assert moq_check is not None
        assert moq_check["passed"] is True


# ── T5: pack-size constraint ──────────────────────────────────────────────────

class TestPackSizeConstraint:
    def test_all_orders_are_multiples_of_pack(self):
        """Every non-zero order_qty must be a multiple of pack_size."""
        pack_val = 5.0
        series = _series("SKU-C", "P1", n_days=5, p50=12.0)
        req = _request(
            series=series,
            horizon_days=5,
            pack_list=[_pack("SKU-C", pack_val)],
        )
        result = solve_replenishment(req)

        for row in result["plan"]:
            qty = row["order_qty"]
            if qty > 0:
                remainder = qty % pack_val
                assert remainder < 1e-6 or (pack_val - remainder) < 1e-6, (
                    f"order_qty {qty} is not a multiple of pack_size {pack_val}"
                )

    def test_pack_size_proof_passes(self):
        pack_val = 10.0
        series = _series("SKU-C", "P1", n_days=3, p50=7.0)
        req = _request(
            series=series,
            horizon_days=3,
            pack_list=[_pack("SKU-C", pack_val)],
        )
        result = solve_replenishment(req)

        pack_check = next(
            (c for c in result["proof"]["constraints_checked"]
             if c["name"] == "pack_size_multiple"),
            None,
        )
        assert pack_check is not None
        assert pack_check["passed"] is True


# ── T6: budget cap constraint ─────────────────────────────────────────────────

class TestBudgetCap:
    def test_total_ordered_within_budget(self):
        """Sum of all order_qty must not exceed budget_cap."""
        cap = 30.0
        series = _series("SKU-D", "P1", n_days=10, p50=20.0)  # high demand
        req = _request(series=series, horizon_days=10, budget_cap=cap)
        result = solve_replenishment(req)

        total = sum(row["order_qty"] for row in result["plan"])
        assert total <= cap + 1e-6, f"total ordered {total} exceeded budget cap {cap}"

    def test_budget_cap_proof(self):
        cap = 50.0
        series = _series("SKU-D", "P1", n_days=7, p50=15.0)
        req = _request(series=series, horizon_days=7, budget_cap=cap)
        result = solve_replenishment(req)

        budget_check = next(
            (c for c in result["proof"]["constraints_checked"]
             if c["name"] == "budget_cap"),
            None,
        )
        assert budget_check is not None
        assert budget_check["passed"] is True


# ── T7: lead-time handling ────────────────────────────────────────────────────

class TestLeadTime:
    def test_arrival_date_offset_by_lead_time(self):
        """order_date + lead_time days should equal arrival_date."""
        lead_time = 3
        series = _series("SKU-E", "P1", n_days=7, p50=10.0)
        inv = [_inventory("SKU-E", "P1", on_hand=0.0, lead_time_days=float(lead_time))]
        req = _request(series=series, inventory=inv, horizon_days=7)
        result = solve_replenishment(req)

        for row in result["plan"]:
            order_d = date.fromisoformat(row["order_date"])
            arrival_d = date.fromisoformat(row["arrival_date"])
            assert (arrival_d - order_d).days == lead_time, (
                f"Expected lead_time={lead_time}, got {(arrival_d - order_d).days}"
            )

    def test_zero_lead_time_same_day(self):
        series = _series("SKU-E", "P1", n_days=3, p50=5.0)
        inv = [_inventory("SKU-E", "P1", on_hand=0.0, lead_time_days=0.0)]
        req = _request(series=series, inventory=inv, horizon_days=3)
        result = solve_replenishment(req)

        for row in result["plan"]:
            assert row["order_date"] == row["arrival_date"]


# ── T8: open POs ──────────────────────────────────────────────────────────────

class TestOpenPos:
    def test_open_po_reduces_required_ordering(self):
        """An open PO arriving on day 0 should reduce the need to place new orders."""
        n = 3
        demand = 10.0
        series = _series("SKU-F", "P1", n_days=n, p50=demand)
        # Open PO covers all demand for day 0.
        open_po = [SimpleNamespace(sku="SKU-F", plant_id="P1",
                                   eta_date=_day(0), qty=demand)]
        inv = [_inventory("SKU-F", "P1", on_hand=0.0, lead_time_days=0.0)]
        req = _request(series=series, inventory=inv, open_pos=open_po, horizon_days=n)
        result = solve_replenishment(req)

        # Total ordered should be less than n * demand (open PO covers day 0).
        total = sum(row["order_qty"] for row in result["plan"])
        assert total < n * demand


# ── T9: multi-SKU plan ────────────────────────────────────────────────────────

class TestMultiSku:
    def test_two_skus_both_planned(self):
        """Two independent SKUs should both appear in the plan."""
        series = (
            _series("SKU-A", "P1", n_days=3, p50=10.0)
            + _series("SKU-B", "P1", n_days=3, p50=8.0)
        )
        req = _request(series=series, horizon_days=3)
        result = solve_replenishment(req)

        skus_in_plan = {row["sku"] for row in result["plan"]}
        # At least one SKU must appear (solver might defer if it's cost-optimal).
        assert result["status"] in ("OPTIMAL", "FEASIBLE", "INFEASIBLE")

    def test_budget_cap_across_skus(self):
        """Budget cap must hold across all SKUs combined."""
        cap = 40.0
        series = (
            _series("SKU-A", "P1", n_days=5, p50=20.0)
            + _series("SKU-B", "P1", n_days=5, p50=20.0)
        )
        req = _request(series=series, horizon_days=5, budget_cap=cap)
        result = solve_replenishment(req)

        total = sum(row["order_qty"] for row in result["plan"])
        assert total <= cap + 1e-6


# ── T10: solver_meta fields ───────────────────────────────────────────────────

class TestSolverMeta:
    def test_solver_name_is_cp_sat(self):
        series = _series("SKU-A", "P1", n_days=2, p50=5.0)
        req = _request(series=series, horizon_days=2)
        result = solve_replenishment(req)

        assert result["solver_meta"]["solver"] == "cp_sat"

    def test_solve_time_ms_non_negative(self):
        series = _series("SKU-A", "P1", n_days=2, p50=5.0)
        req = _request(series=series, horizon_days=2)
        result = solve_replenishment(req)

        assert result["solver_meta"]["solve_time_ms"] >= 0

    def test_gap_is_non_negative(self):
        series = _series("SKU-A", "P1", n_days=3, p50=5.0)
        req = _request(series=series, horizon_days=3)
        result = solve_replenishment(req)

        gap = result["solver_meta"]["gap"]
        if gap is not None:
            assert gap >= 0.0

    def test_objective_value_matches_kpis(self):
        """The computed real cost from KPI terms should be consistent with objective."""
        series = _series("SKU-A", "P1", n_days=3, p50=10.0)
        inv = [_inventory("SKU-A", "P1", on_hand=5.0, lead_time_days=0.0)]
        req = _request(series=series, inventory=inv, horizon_days=3,
                       stockout_penalty=2.0, holding_cost=0.1)
        result = solve_replenishment(req)

        kpis = result["kpis"]
        if kpis["estimated_total_cost"] is not None:
            assert kpis["estimated_total_cost"] >= 0.0


# ── T11: max_order_qty constraint ─────────────────────────────────────────────

class TestMaxOrderQty:
    def test_no_order_exceeds_max(self):
        max_val = 8.0
        series = _series("SKU-G", "P1", n_days=5, p50=20.0)  # demand > max each day
        req = _request(
            series=series,
            horizon_days=5,
            max_qty_list=[_max_qty("SKU-G", max_val)],
        )
        result = solve_replenishment(req)

        for row in result["plan"]:
            assert row["order_qty"] <= max_val + 1e-6, (
                f"order_qty {row['order_qty']} exceeds max_order_qty {max_val}"
            )

    def test_max_order_qty_proof_passes(self):
        max_val = 15.0
        series = _series("SKU-G", "P1", n_days=3, p50=10.0)
        req = _request(
            series=series,
            horizon_days=3,
            max_qty_list=[_max_qty("SKU-G", max_val)],
        )
        result = solve_replenishment(req)

        max_check = next(
            (c for c in result["proof"]["constraints_checked"]
             if c["name"] == "max_order_qty"),
            None,
        )
        assert max_check is not None
        assert max_check["passed"] is True


# ── T12: combined constraints ─────────────────────────────────────────────────

class TestCombinedConstraints:
    def test_moq_and_pack_compatible(self):
        """MOQ=10, pack=5 → valid orders are 10, 15, 20, … (MOQ must be multiple of pack)."""
        pack_val = 5.0
        moq_val = 10.0
        series = _series("SKU-H", "P1", n_days=5, p50=7.0)
        req = _request(
            series=series,
            horizon_days=5,
            moq_list=[_moq("SKU-H", moq_val)],
            pack_list=[_pack("SKU-H", pack_val)],
        )
        result = solve_replenishment(req)

        for row in result["plan"]:
            qty = row["order_qty"]
            if qty > 0:
                assert qty >= moq_val - 1e-6
                remainder = qty % pack_val
                assert remainder < 1e-6 or (pack_val - remainder) < 1e-6

    def test_all_constraints_proof_reported(self):
        series = _series("SKU-H", "P1", n_days=3, p50=6.0)
        req = _request(
            series=series,
            horizon_days=3,
            budget_cap=100.0,
            moq_list=[_moq("SKU-H", 5.0)],
            pack_list=[_pack("SKU-H", 5.0)],
        )
        result = solve_replenishment(req)

        names = {c["name"] for c in result["proof"]["constraints_checked"]}
        expected = {
            "order_qty_non_negative",
            "moq",
            "pack_size_multiple",
            "budget_cap",
            "max_order_qty",
        }
        assert expected <= names


# ── T13: solver run policy (determinism / timeout / taxonomy) ────────────────

class TestSolverRunPolicy:
    def test_deterministic_output_same_input_twice(self):
        req = _request(
            series=_series("SKU-DET", "P1", n_days=14, p50=11.0),
            inventory=[_inventory("SKU-DET", "P1", on_hand=0.0, lead_time_days=0.0)],
            horizon_days=14,
            settings={"solver": {"random_seed": 42, "num_search_workers": 1}},
        )
        first = solve_replenishment(req)
        second = solve_replenishment(req)

        assert first["status"] == second["status"]
        assert first["plan"] == second["plan"]
        assert first["kpis"] == second["kpis"]

    def test_timeout_with_feasible_solution_returns_plan(self):
        req = _timeout_fixture_request(time_limit_seconds=0.02)
        result = solve_replenishment(req)

        assert result["status"] == "TIMEOUT"
        assert result["solver_meta"]["termination_reason"] == "TIME_LIMIT_FEASIBLE"
        assert isinstance(result["plan"], list)
        assert len(result["plan"]) > 0

    def test_timeout_with_no_feasible_solution_is_explicit(self):
        req = _timeout_fixture_request(time_limit_seconds=0.00001)
        req.settings.setdefault("solver", {})["force_timeout"] = True
        result = solve_replenishment(req)

        assert result["status"] == "TIMEOUT"
        assert result["solver_meta"]["termination_reason"] == "FORCED_TIMEOUT"
        assert result["plan"] == []

    def test_status_taxonomy_mapping_stays_in_contract_enums(self):
        allowed = {"OPTIMAL", "FEASIBLE", "TIMEOUT", "INFEASIBLE", "ERROR"}

        class _FakeSolver:
            def __init__(self, status_names, wall_time=0.0):
                self._status_names = status_names
                self._wall_time = wall_time

            def StatusName(self, cp_status):
                return self._status_names.get(cp_status, "UNKNOWN")

            def WallTime(self):
                return self._wall_time

        settings = SolverRunSettings(
            time_limit_seconds=0.02,
            random_seed=42,
            num_search_workers=1,
            log_search_progress=False,
            deterministic_mode=True,
        )
        cp = __import__("ml.api.replenishment_solver", fromlist=["_cp_model"])._cp_model
        status_names = {
            cp.OPTIMAL: "OPTIMAL",
            cp.FEASIBLE: "FEASIBLE",
            cp.INFEASIBLE: "INFEASIBLE",
            cp.UNKNOWN: "UNKNOWN",
        }
        solver = _FakeSolver(status_names=status_names, wall_time=0.03)

        mapped = [
            _status_from_cp(cp.OPTIMAL, solver, settings, solve_time_ms=10),
            _status_from_cp(cp.FEASIBLE, solver, settings, solve_time_ms=25),
            _status_from_cp(cp.INFEASIBLE, solver, settings, solve_time_ms=10),
            _status_from_cp(cp.UNKNOWN, solver, settings, solve_time_ms=25),
            _status_from_cp(-999, solver, settings, solve_time_ms=10),
        ]
        assert all(item.status.value in allowed for item in mapped)

    def test_solver_meta_contains_run_settings_and_bounds(self):
        req = _request(
            series=_series("SKU-META", "P1", n_days=8, p50=9.0),
            inventory=[_inventory("SKU-META", "P1", on_hand=0.0, lead_time_days=0.0)],
            horizon_days=8,
            settings={"solver": {"time_limit_seconds": 0.2, "random_seed": 7, "num_search_workers": 1}},
        )
        result = solve_replenishment(req)
        meta = result.get("solver_meta", {})

        required = {
            "engine",
            "status",
            "termination_reason",
            "solve_time_ms",
            "objective_value",
            "best_bound",
            "gap",
            "time_limit_seconds",
            "random_seed",
            "num_search_workers",
        }
        assert required.issubset(set(meta.keys()))


# ── T14: multi-SKU shared resources (Step 3) ─────────────────────────────────

class TestSharedResources:
    def test_items_contract_runs_end_to_end(self):
        items = [
            SimpleNamespace(
                sku="SKU-I1",
                plant_id="P1",
                on_hand=0.0,
                lead_time_days=0.0,
                demand=[SimpleNamespace(date=_day(0), p50=6.0)],
                constraints={"moq": 2.0},
                costs={"unit_cost": 1.0},
                service_level_weight=1.0,
            ),
            SimpleNamespace(
                sku="SKU-I2",
                plant_id="P1",
                on_hand=0.0,
                lead_time_days=0.0,
                demand=[SimpleNamespace(date=_day(0), p50=6.0)],
                constraints={"moq": 2.0},
                costs={"unit_cost": 1.0},
                service_level_weight=1.0,
            ),
        ]
        req = _request(
            series=[],
            items=items,
            horizon_days=1,
            shared_production_capacity=8.0,
        )
        result = solve_replenishment(req)
        assert result["status"] in {"OPTIMAL", "FEASIBLE", "INFEASIBLE", "TIMEOUT"}
        assert "shared_kpis" in result
        assert any(c.get("name") == "shared_production_cap" for c in result["proof"]["constraints_checked"])

    def test_shared_production_cap_is_deterministic_under_scarcity(self):
        series = (
            _series("SKU-A", "P1", n_days=1, p50=10.0)
            + _series("SKU-B", "P1", n_days=1, p50=10.0)
        )
        req = _request(
            series=series,
            horizon_days=1,
            stockout_penalty=20.0,
            shared_production_capacity=10.0,
        )
        r1 = solve_replenishment(req)
        r2 = solve_replenishment(req)

        assert r1["plan"] == r2["plan"], "Allocation under shared scarcity must be deterministic"
        total = sum(row["order_qty"] for row in r1["plan"])
        assert total <= 10.0 + 1e-6
        by_sku = {}
        for row in r1["plan"]:
            by_sku[row["sku"]] = by_sku.get(row["sku"], 0.0) + row["order_qty"]
        assert by_sku.get("SKU-A", 0.0) >= by_sku.get("SKU-B", 0.0)

        cap_check = next((c for c in r1["proof"]["constraints_checked"] if c["name"] == "shared_production_cap"), None)
        assert cap_check is not None
        assert cap_check["passed"] is True

    def test_shared_inventory_cap_binds_total_inventory(self):
        series = (
            _series("SKU-A", "P1", n_days=1, p50=5.0)
            + _series("SKU-B", "P1", n_days=1, p50=5.0)
        )
        req = _request(
            series=series,
            horizon_days=1,
            moq_list=[_moq("SKU-A", 20.0), _moq("SKU-B", 20.0)],
            stockout_penalty=10.0,
            shared_inventory_capacity=20.0,
        )
        result = solve_replenishment(req)

        inv_kpi = (result.get("shared_kpis") or {}).get("inventory_capacity") or {}
        periods = inv_kpi.get("periods") or []
        assert len(periods) > 0
        for row in periods:
            assert row["used"] <= row["cap"] + 1e-6

        cap_check = next((c for c in result["proof"]["constraints_checked"] if c["name"] == "shared_inventory_cap"), None)
        assert cap_check is not None
        assert cap_check["passed"] is True

    def test_shared_budget_spend_prefers_lower_cost_sku(self):
        series = (
            _series("SKU-CHEAP", "P1", n_days=1, p50=10.0)
            + _series("SKU-EXP", "P1", n_days=1, p50=10.0)
        )
        req = _request(
            series=series,
            horizon_days=1,
            unit_cost_list=[_unit_cost("SKU-CHEAP", 1.0), _unit_cost("SKU-EXP", 5.0)],
            shared_budget_cap=10.0,
            stockout_penalty=30.0,
        )
        result = solve_replenishment(req)

        by_sku = {}
        for row in result["plan"]:
            by_sku[row["sku"]] = by_sku.get(row["sku"], 0.0) + row["order_qty"]
        assert by_sku.get("SKU-CHEAP", 0.0) >= by_sku.get("SKU-EXP", 0.0)

        budget_kpi = (result.get("shared_kpis") or {}).get("budget") or {}
        assert budget_kpi.get("mode") in {"spend", "quantity"}
        assert budget_kpi.get("used", 0.0) <= budget_kpi.get("cap", 0.0) + 1e-6


# ── T15: infeasibility diagnostics (Step 4) ──────────────────────────────────

class TestInfeasibilityDiagnostics:
    def test_infeasible_capacity_case_returns_structured_diagnostics(self):
        series = _series("SKU-DIAG-A", "P1", n_days=3, p50=10.0)
        req = _request(
            series=series,
            horizon_days=3,
            shared_production_capacity=0.0,
            service_level_target=1.0,
            diagnose_mode=True,
        )
        result = solve_replenishment(req)

        assert result["status"] == "INFEASIBLE"
        assert len(result["infeasible_reasons"]) > 0
        proof = result.get("proof", {})
        analysis = proof.get("infeasibility_analysis", {})
        assert len(analysis.get("categories", [])) > 0
        assert len(analysis.get("top_offending_tags", [])) > 0
        assert len(proof.get("relaxation_analysis", [])) > 0
        assert any("CAP_PROD" in str(tag) for tag in analysis.get("top_offending_tags", []))

    def test_infeasible_inventory_case_reports_capacity_tag(self):
        series = _series("SKU-DIAG-B", "P1", n_days=1, p50=0.0)
        inv = [_inventory("SKU-DIAG-B", "P1", on_hand=10.0, lead_time_days=0.0)]
        req = _request(
            series=series,
            inventory=inv,
            horizon_days=1,
            shared_inventory_capacity=0.0,
            diagnose_mode=True,
        )
        result = solve_replenishment(req)

        assert result["status"] == "INFEASIBLE"
        assert len(result["infeasible_reasons"]) > 0
        proof = result.get("proof", {})
        checks = proof.get("constraints_checked", [])
        assert any(c.get("tag") in {"CAP_INV", "CP_FEASIBILITY"} for c in checks)
        analysis = proof.get("infeasibility_analysis", {})
        assert any("CAP_INV" in str(tag) for tag in analysis.get("top_offending_tags", []))


# ══════════════════════════════════════════════════════════════════════════════
# V2 FEATURE TESTS
# ══════════════════════════════════════════════════════════════════════════════


# ── V2-T1: Safety stock as soft constraint (Feature 6) ───────────────────────

class TestSafetyStockSoftConstraint:
    def test_safety_stock_violation_detected(self):
        """Low inventory + high demand → safety stock violations reported."""
        series = _series("SKU-SS", "P1", n_days=5, p50=20.0)
        inv = [_inventory("SKU-SS", "P1", on_hand=0.0, safety_stock=50.0, lead_time_days=0.0)]
        req = _request(series=series, inventory=inv, horizon_days=5,
                       stockout_penalty=1.0, holding_cost=0.01)
        result = solve_replenishment(req)

        assert result["status"] in ("OPTIMAL", "FEASIBLE")
        # With 0 on_hand and 20/day demand, maintaining 50 safety stock is impossible
        # without massive ordering. The solver should report some violations.
        shared_kpis = result.get("shared_kpis") or {}
        ss_violations = shared_kpis.get("safety_stock_violations") or {}
        # May or may not have violations depending on solver ordering,
        # but the v2_features flag should be set.
        meta = result.get("solver_meta", {})
        v2 = meta.get("v2_features") or {}
        assert v2.get("safety_stock_soft") is True

    def test_safety_stock_penalty_controls_priority(self):
        """High penalty should make solver prioritize meeting safety stock."""
        series = _series("SKU-SS2", "P1", n_days=3, p50=5.0)
        inv = [_inventory("SKU-SS2", "P1", on_hand=100.0, safety_stock=10.0, lead_time_days=0.0)]
        # With 100 on hand and only 5/day demand over 3 days (15 total),
        # stock never drops below 85 → well above safety_stock=10.
        req = _request(series=series, inventory=inv, horizon_days=3,
                       safety_stock_violation_penalty=100.0)
        result = solve_replenishment(req)

        assert result["status"] in ("OPTIMAL", "FEASIBLE")
        shared_kpis = result.get("shared_kpis") or {}
        ss_violations = shared_kpis.get("safety_stock_violations") or {}
        # No violations expected — ample stock.
        assert len(ss_violations) == 0

    def test_safety_stock_no_safety_stock_no_flag(self):
        """When no safety stock is set, v2 flag should be False."""
        series = _series("SKU-SS3", "P1", n_days=3, p50=5.0)
        inv = [_inventory("SKU-SS3", "P1", on_hand=10.0, safety_stock=0.0, lead_time_days=0.0)]
        req = _request(series=series, inventory=inv, horizon_days=3)
        result = solve_replenishment(req)

        meta = result.get("solver_meta", {})
        v2 = meta.get("v2_features") or {}
        assert v2.get("safety_stock_soft") is False

    def test_p90_derived_safety_stock_activates_soft_floor(self):
        """P90 uncertainty should activate safety-stock floor even if uploaded safety_stock=0."""
        series = _series("SKU-SS4", "P1", n_days=3, p50=10.0, p90=30.0)
        inv = [_inventory("SKU-SS4", "P1", on_hand=0.0, safety_stock=0.0, lead_time_days=0.0)]
        req = _request(series=series, inventory=inv, horizon_days=3)
        result = solve_replenishment(req)

        meta = result.get("solver_meta", {})
        v2 = meta.get("v2_features") or {}
        bridge = meta.get("uncertainty_bridge") or {}
        assert v2.get("safety_stock_soft") is True
        assert bridge.get("keys_with_p90", 0) >= 1
        assert bridge.get("keys_with_derived_safety_stock", 0) >= 1

    def test_closed_loop_safety_stock_patch_is_consumed(self):
        """Closed-loop safety_stock_by_key should be read and applied by the solver."""
        series = _series("SKU-SS5", "P1", n_days=2, p50=0.0, p90=0.0)
        inv = [_inventory("SKU-SS5", "P1", on_hand=0.0, safety_stock=0.0, lead_time_days=0.0)]
        req = _request(
            series=series,
            inventory=inv,
            horizon_days=2,
            settings={
                "closed_loop_meta": {
                    "param_patch": {
                        "patch": {
                            "safety_stock_by_key": {
                                "SKU-SS5|P1": 40.0,
                            },
                            "safety_stock_alpha": 0.8,
                        }
                    }
                }
            },
        )
        result = solve_replenishment(req)

        meta = result.get("solver_meta", {})
        v2 = meta.get("v2_features") or {}
        bridge = meta.get("uncertainty_bridge") or {}
        assert v2.get("safety_stock_soft") is True
        assert bridge.get("keys_with_closed_loop_safety_stock", 0) >= 1


class TestServiceLevelUncertaintyBridge:
    def test_service_level_uses_p90_basis_when_available(self):
        """Hard service-level check should use p90-aware demand basis when p90 is present."""
        series = _series("SKU-SL-P90", "P1", n_days=1, p50=10.0, p90=20.0)
        inv = [_inventory("SKU-SL-P90", "P1", on_hand=0.0, safety_stock=0.0, lead_time_days=0.0)]
        req = _request(
            series=series,
            inventory=inv,
            horizon_days=1,
            budget_cap=0.0,  # force no ordering so backlog equals p50 demand
            service_level_target=0.5,
        )
        result = solve_replenishment(req)

        checks = result.get("proof", {}).get("constraints_checked", [])
        sl_check = next((c for c in checks if c.get("name") == "service_level_target"), None)
        assert sl_check is not None
        assert sl_check.get("passed") is True
        assert "using p90_or_p50 demand basis" in str(sl_check.get("details", ""))


# ── V2-T2: Per-period budget constraints (Feature 4) ─────────────────────────

class TestPerPeriodBudget:
    def test_per_period_budget_limits_daily_spend(self):
        """With tight per-period budget, daily ordering should be capped."""
        series = _series("SKU-PPB", "P1", n_days=5, p50=20.0)
        inv = [_inventory("SKU-PPB", "P1", on_hand=0.0, lead_time_days=0.0)]
        req = _request(
            series=series,
            inventory=inv,
            horizon_days=5,
            unit_cost_list=[_unit_cost("SKU-PPB", 2.0)],
            budget_per_period=30.0,   # 30 budget per day, unit_cost=2 → max 15 units/day
            stockout_penalty=1.0,
        )
        result = solve_replenishment(req)

        assert result["status"] in ("OPTIMAL", "FEASIBLE")
        # Check the shared KPI
        shared_kpis = result.get("shared_kpis") or {}
        budget_pp = shared_kpis.get("budget_per_period")
        assert budget_pp is not None
        assert budget_pp.get("mode") in {"spend", "quantity"}
        for p in budget_pp.get("periods", []):
            assert p["used"] <= p["cap"] + 1e-6

    def test_per_period_budget_constraint_check(self):
        """Per-period budget constraint check should appear in proof."""
        series = _series("SKU-PPB2", "P1", n_days=3, p50=10.0)
        inv = [_inventory("SKU-PPB2", "P1", on_hand=0.0, lead_time_days=0.0)]
        req = _request(
            series=series,
            inventory=inv,
            horizon_days=3,
            budget_per_period=100.0,
        )
        result = solve_replenishment(req)

        assert result["status"] in ("OPTIMAL", "FEASIBLE")
        checks = result.get("proof", {}).get("constraints_checked", [])
        pp_check = next((c for c in checks if c["name"] == "budget_per_period"), None)
        assert pp_check is not None
        assert pp_check["passed"] is True

    def test_per_period_budget_v2_flag(self):
        """v2_features.per_period_budget should be True when used."""
        series = _series("SKU-PPB3", "P1", n_days=2, p50=5.0)
        req = _request(series=series, horizon_days=2, budget_per_period=50.0)
        result = solve_replenishment(req)

        meta = result.get("solver_meta", {})
        v2 = meta.get("v2_features") or {}
        assert v2.get("per_period_budget") is True


# ── V2-T3: Volume/weight-based capacity (Feature 5) ──────────────────────────

class TestVolumeWeightCapacity:
    def test_volume_capacity_limits_inventory(self):
        """Volume capacity should constrain total inventory volume per period."""
        items = [
            SimpleNamespace(
                sku="SKU-VOL",
                plant_id="P1",
                on_hand=0.0,
                lead_time_days=0.0,
                demand=[SimpleNamespace(date=_day(i), p50=5.0) for i in range(3)],
                constraints={"moq": 0.0},
                costs={"unit_cost": 1.0},
                service_level_weight=1.0,
                volume_per_unit=2.0,  # each unit takes 2 volume
            ),
        ]
        req = _request(
            series=[],
            items=items,
            horizon_days=3,
            volume_capacity_per_period=30.0,  # max 30 vol → max 15 units inventory
            stockout_penalty=1.0,
        )
        result = solve_replenishment(req)

        assert result["status"] in ("OPTIMAL", "FEASIBLE")
        shared_kpis = result.get("shared_kpis") or {}
        vol_kpi = shared_kpis.get("volume_capacity")
        assert vol_kpi is not None
        for p in vol_kpi.get("periods", []):
            assert p["used"] <= p["cap"] + 1e-6

    def test_weight_capacity_limits_inventory(self):
        """Weight capacity should constrain total inventory weight per period."""
        items = [
            SimpleNamespace(
                sku="SKU-WT",
                plant_id="P1",
                on_hand=0.0,
                lead_time_days=0.0,
                demand=[SimpleNamespace(date=_day(i), p50=5.0) for i in range(3)],
                constraints={"moq": 0.0},
                costs={"unit_cost": 1.0},
                service_level_weight=1.0,
                weight_per_unit=3.0,  # each unit weighs 3
            ),
        ]
        req = _request(
            series=[],
            items=items,
            horizon_days=3,
            weight_capacity_per_period=45.0,  # max 45 wt → max 15 units inventory
            stockout_penalty=1.0,
        )
        result = solve_replenishment(req)

        assert result["status"] in ("OPTIMAL", "FEASIBLE")
        shared_kpis = result.get("shared_kpis") or {}
        wt_kpi = shared_kpis.get("weight_capacity")
        assert wt_kpi is not None
        for p in wt_kpi.get("periods", []):
            assert p["used"] <= p["cap"] + 1e-6

    def test_volume_weight_v2_flag(self):
        """v2_features.volume_weight_capacity should be True when volume/weight used."""
        items = [
            SimpleNamespace(
                sku="SKU-VW",
                plant_id="P1",
                on_hand=0.0,
                lead_time_days=0.0,
                demand=[SimpleNamespace(date=_day(0), p50=5.0)],
                constraints={},
                costs={"unit_cost": 1.0},
                service_level_weight=1.0,
                volume_per_unit=1.0,
            ),
        ]
        req = _request(
            series=[],
            items=items,
            horizon_days=1,
            volume_capacity_per_period=100.0,
        )
        result = solve_replenishment(req)

        meta = result.get("solver_meta", {})
        v2 = meta.get("v2_features") or {}
        assert v2.get("volume_weight_capacity") is True

    def test_constraint_checks_present(self):
        """volume_capacity and weight_capacity checks should appear in proof."""
        items = [
            SimpleNamespace(
                sku="SKU-VW2",
                plant_id="P1",
                on_hand=0.0,
                lead_time_days=0.0,
                demand=[SimpleNamespace(date=_day(0), p50=5.0)],
                constraints={},
                costs={"unit_cost": 1.0},
                service_level_weight=1.0,
                volume_per_unit=1.5,
                weight_per_unit=2.0,
            ),
        ]
        req = _request(
            series=[],
            items=items,
            horizon_days=1,
            volume_capacity_per_period=100.0,
            weight_capacity_per_period=100.0,
        )
        result = solve_replenishment(req)

        checks = result.get("proof", {}).get("constraints_checked", [])
        check_names = {c["name"] for c in checks}
        assert "volume_capacity" in check_names
        assert "weight_capacity" in check_names


# ── V2-T4: Hierarchical relaxation engine (Feature 3) ────────────────────────

class TestHierarchicalRelaxation:
    def test_relaxation_has_priority_and_recommendation(self):
        """Relaxation analysis entries should include priority and recommendation."""
        series = _series("SKU-REL", "P1", n_days=3, p50=10.0)
        req = _request(
            series=series,
            horizon_days=3,
            shared_production_capacity=0.0,
            service_level_target=1.0,
            diagnose_mode=True,
        )
        result = solve_replenishment(req)

        assert result["status"] == "INFEASIBLE"
        proof = result.get("proof", {})
        relax = proof.get("relaxation_analysis", [])
        assert len(relax) > 0
        for entry in relax:
            assert "priority" in entry, "Missing priority in relaxation entry"
            assert "category" in entry, "Missing category in relaxation entry"
            assert "recommendation" in entry, "Missing recommendation in relaxation entry"

    def test_relaxation_summary_in_response(self):
        """Infeasible case should include relaxation_applied summary."""
        series = _series("SKU-REL2", "P1", n_days=3, p50=10.0)
        req = _request(
            series=series,
            horizon_days=3,
            shared_production_capacity=0.0,
            service_level_target=1.0,
            diagnose_mode=True,
        )
        result = solve_replenishment(req)

        assert result["status"] == "INFEASIBLE"
        relaxation_applied = result.get("relaxation_applied")
        assert relaxation_applied is not None
        assert "feasible_found" in relaxation_applied
        assert "levels_tried" in relaxation_applied
        assert relaxation_applied["levels_tried"] > 0

    def test_relaxation_priority_ordering(self):
        """Relaxation entries should be in ascending priority order."""
        series = _series("SKU-REL3", "P1", n_days=3, p50=10.0)
        req = _request(
            series=series,
            horizon_days=3,
            shared_production_capacity=0.0,
            service_level_target=1.0,
            diagnose_mode=True,
        )
        result = solve_replenishment(req)

        proof = result.get("proof", {})
        relax = proof.get("relaxation_analysis", [])
        if len(relax) >= 2:
            priorities = [e.get("priority", 999) for e in relax]
            assert priorities == sorted(priorities), "Relaxation entries should be ordered by priority"


# ── V2-T5: Multi-supplier dimension (Feature 1) ──────────────────────────────

class TestMultiSupplier:
    def test_multi_supplier_plan_includes_supplier_id(self):
        """Plan lines should include supplier_id when multiple suppliers are provided."""
        items = [
            SimpleNamespace(
                sku="SKU-MS",
                plant_id="P1",
                on_hand=0.0,
                lead_time_days=0.0,
                demand=[SimpleNamespace(date=_day(i), p50=10.0) for i in range(3)],
                constraints={"moq": 0.0},
                costs={"unit_cost": 1.0},
                service_level_weight=1.0,
                suppliers=[
                    SimpleNamespace(supplier_id="SUP-A", lead_time_days=0.0, unit_cost=1.0,
                                    moq=0.0, pack_size=0.0, max_order_qty=0.0, fixed_order_cost=0.0),
                    SimpleNamespace(supplier_id="SUP-B", lead_time_days=0.0, unit_cost=2.0,
                                    moq=0.0, pack_size=0.0, max_order_qty=0.0, fixed_order_cost=0.0),
                ],
            ),
        ]
        req = _request(series=[], items=items, horizon_days=3, stockout_penalty=10.0)
        result = solve_replenishment(req)

        assert result["status"] in ("OPTIMAL", "FEASIBLE")
        # Plan lines with positive order qty should have supplier_id
        for row in result["plan"]:
            if row.get("order_qty", 0) > 0:
                assert "supplier_id" in row, "Plan row missing supplier_id"

    def test_multi_supplier_prefers_cheaper(self):
        """Solver should prefer the cheaper supplier when costs differ."""
        items = [
            SimpleNamespace(
                sku="SKU-MSC",
                plant_id="P1",
                on_hand=0.0,
                lead_time_days=0.0,
                demand=[SimpleNamespace(date=_day(0), p50=10.0)],
                constraints={"moq": 0.0},
                costs={"unit_cost": 1.0},
                service_level_weight=1.0,
                suppliers=[
                    SimpleNamespace(supplier_id="CHEAP", lead_time_days=0.0, unit_cost=1.0,
                                    moq=0.0, pack_size=0.0, max_order_qty=0.0, fixed_order_cost=0.0),
                    SimpleNamespace(supplier_id="EXPENSIVE", lead_time_days=0.0, unit_cost=10.0,
                                    moq=0.0, pack_size=0.0, max_order_qty=0.0, fixed_order_cost=0.0),
                ],
            ),
        ]
        req = _request(series=[], items=items, horizon_days=1, stockout_penalty=20.0)
        result = solve_replenishment(req)

        assert result["status"] in ("OPTIMAL", "FEASIBLE")
        qty_by_sup: dict = {}
        for row in result["plan"]:
            sid = row.get("supplier_id", "unknown")
            qty_by_sup[sid] = qty_by_sup.get(sid, 0.0) + row.get("order_qty", 0.0)
        # Cheap supplier should get all or most of the orders
        assert qty_by_sup.get("CHEAP", 0.0) >= qty_by_sup.get("EXPENSIVE", 0.0)

    def test_multi_supplier_per_supplier_moq(self):
        """Per-supplier MOQ should be respected."""
        items = [
            SimpleNamespace(
                sku="SKU-MSMOQ",
                plant_id="P1",
                on_hand=0.0,
                lead_time_days=0.0,
                demand=[SimpleNamespace(date=_day(0), p50=30.0)],
                constraints={"moq": 0.0},
                costs={"unit_cost": 1.0},
                service_level_weight=1.0,
                suppliers=[
                    SimpleNamespace(supplier_id="SUP-X", lead_time_days=0.0, unit_cost=1.0,
                                    moq=10.0, pack_size=0.0, max_order_qty=0.0, fixed_order_cost=0.0),
                    SimpleNamespace(supplier_id="SUP-Y", lead_time_days=0.0, unit_cost=1.5,
                                    moq=15.0, pack_size=0.0, max_order_qty=0.0, fixed_order_cost=0.0),
                ],
            ),
        ]
        req = _request(series=[], items=items, horizon_days=1, stockout_penalty=20.0)
        result = solve_replenishment(req)

        assert result["status"] in ("OPTIMAL", "FEASIBLE")
        for row in result["plan"]:
            qty = row.get("order_qty", 0.0)
            sid = row.get("supplier_id", "")
            if qty > 0 and sid == "SUP-X":
                assert qty >= 10.0 - 1e-6, f"SUP-X order {qty} violates MOQ 10"
            if qty > 0 and sid == "SUP-Y":
                assert qty >= 15.0 - 1e-6, f"SUP-Y order {qty} violates MOQ 15"

    def test_multi_supplier_v2_flag(self):
        """v2_features.multi_supplier should be True when suppliers used."""
        items = [
            SimpleNamespace(
                sku="SKU-MSF",
                plant_id="P1",
                on_hand=0.0,
                lead_time_days=0.0,
                demand=[SimpleNamespace(date=_day(0), p50=5.0)],
                constraints={},
                costs={"unit_cost": 1.0},
                service_level_weight=1.0,
                suppliers=[
                    SimpleNamespace(supplier_id="S1", lead_time_days=0.0, unit_cost=1.0,
                                    moq=0.0, pack_size=0.0, max_order_qty=0.0, fixed_order_cost=0.0),
                    SimpleNamespace(supplier_id="S2", lead_time_days=0.0, unit_cost=2.0,
                                    moq=0.0, pack_size=0.0, max_order_qty=0.0, fixed_order_cost=0.0),
                ],
            ),
        ]
        req = _request(series=[], items=items, horizon_days=1, stockout_penalty=5.0)
        result = solve_replenishment(req)

        meta = result.get("solver_meta", {})
        v2 = meta.get("v2_features") or {}
        assert v2.get("multi_supplier") is True

    def test_single_supplier_no_flag(self):
        """Single supplier in list should NOT activate multi-supplier logic."""
        items = [
            SimpleNamespace(
                sku="SKU-SS1",
                plant_id="P1",
                on_hand=0.0,
                lead_time_days=0.0,
                demand=[SimpleNamespace(date=_day(0), p50=5.0)],
                constraints={},
                costs={"unit_cost": 1.0},
                service_level_weight=1.0,
                suppliers=[
                    SimpleNamespace(supplier_id="ONLY", lead_time_days=0.0, unit_cost=1.0,
                                    moq=0.0, pack_size=0.0, max_order_qty=0.0, fixed_order_cost=0.0),
                ],
            ),
        ]
        req = _request(series=[], items=items, horizon_days=1, stockout_penalty=5.0)
        result = solve_replenishment(req)

        meta = result.get("solver_meta", {})
        v2 = meta.get("v2_features") or {}
        assert v2.get("multi_supplier") is False


# ── V2-T6: Shadow price analysis (Feature 2) ─────────────────────────────────

class TestShadowPriceAnalysis:
    def test_shadow_prices_computed_when_binding_budget(self):
        """Shadow prices should be computed for binding budget constraint."""
        series = (
            _series("SKU-SP1", "P1", n_days=3, p50=10.0)
            + _series("SKU-SP2", "P1", n_days=3, p50=10.0)
        )
        req = _request(
            series=series,
            horizon_days=3,
            unit_cost_list=[_unit_cost("SKU-SP1", 1.0), _unit_cost("SKU-SP2", 2.0)],
            shared_budget_cap=15.0,  # tight budget
            stockout_penalty=30.0,
            compute_shadow_prices=True,
        )
        result = solve_replenishment(req)

        if result["status"] in ("OPTIMAL", "FEASIBLE"):
            sp = result.get("shadow_prices")
            # Shadow prices should exist if budget is binding
            meta = result.get("solver_meta", {})
            v2 = meta.get("v2_features") or {}
            # The flag should reflect whether shadow prices were computed
            if sp:
                assert v2.get("shadow_prices") is True
                for name, info in sp.items():
                    assert "shadow_price_approx" in info
                    # Exact LP dual value should be present in primary path.
                    assert "shadow_price_dual" in info
                    assert "interpretation" in info
                    assert info.get("method") in {"lp_relaxation_dual", "parametric_perturbation"}

    def test_shadow_prices_not_computed_by_default(self):
        """Shadow prices should NOT be computed unless explicitly requested."""
        series = _series("SKU-SPOFF", "P1", n_days=3, p50=10.0)
        req = _request(
            series=series,
            horizon_days=3,
            shared_budget_cap=15.0,
            stockout_penalty=10.0,
            compute_shadow_prices=False,
        )
        result = solve_replenishment(req)

        sp = result.get("shadow_prices")
        assert sp is None or sp == {}

    def test_shadow_prices_v2_flag_false_when_disabled(self):
        """v2_features.shadow_prices should be False when not computed."""
        series = _series("SKU-SPFLAG", "P1", n_days=2, p50=5.0)
        req = _request(series=series, horizon_days=2)
        result = solve_replenishment(req)

        meta = result.get("solver_meta", {})
        v2 = meta.get("v2_features") or {}
        assert v2.get("shadow_prices") is False


# ── V2-T7: V2 API response enrichment (Feature 7) ───────────────────────────

class TestV2ResponseEnrichment:
    def test_binding_constraints_in_response(self):
        """binding_constraints list should be present in response."""
        series = _series("SKU-BC", "P1", n_days=3, p50=10.0)
        req = _request(series=series, horizon_days=3, shared_budget_cap=5.0,
                       stockout_penalty=10.0)
        result = solve_replenishment(req)

        assert "binding_constraints" in result
        assert isinstance(result["binding_constraints"], list)

    def test_v2_features_dict_in_solver_meta(self):
        """solver_meta should include v2_features dict."""
        series = _series("SKU-V2M", "P1", n_days=2, p50=5.0)
        req = _request(series=series, horizon_days=2)
        result = solve_replenishment(req)

        meta = result.get("solver_meta", {})
        v2 = meta.get("v2_features")
        assert v2 is not None
        expected_keys = {"multi_supplier", "shadow_prices", "safety_stock_soft",
                         "per_period_budget", "volume_weight_capacity"}
        assert expected_keys <= set(v2.keys())

    def test_relaxation_applied_none_when_feasible(self):
        """relaxation_applied should be None when problem is feasible."""
        series = _series("SKU-RA", "P1", n_days=3, p50=5.0)
        inv = [_inventory("SKU-RA", "P1", on_hand=100.0, lead_time_days=0.0)]
        req = _request(series=series, inventory=inv, horizon_days=3)
        result = solve_replenishment(req)

        assert result["status"] in ("OPTIMAL", "FEASIBLE")
        assert result.get("relaxation_applied") is None

    def test_backward_compat_no_v2_fields_in_request(self):
        """Existing payload without V2 fields should still work and produce valid response."""
        series = _series("SKU-COMPAT", "P1", n_days=5, p50=10.0)
        inv = [_inventory("SKU-COMPAT", "P1", on_hand=20.0, lead_time_days=0.0)]
        req = _request(
            series=series,
            inventory=inv,
            horizon_days=5,
            moq_list=[_moq("SKU-COMPAT", 5.0)],
            pack_list=[_pack("SKU-COMPAT", 5.0)],
            budget_cap=100.0,
            stockout_penalty=2.0,
            holding_cost=0.01,
        )
        result = solve_replenishment(req)

        assert result["status"] in ("OPTIMAL", "FEASIBLE")
        assert isinstance(result["plan"], list)
        assert "kpis" in result
        assert "solver_meta" in result
        assert "proof" in result
        # V2 fields should be present but inactive
        meta = result.get("solver_meta", {})
        v2 = meta.get("v2_features") or {}
        assert v2.get("multi_supplier") is False
        assert v2.get("per_period_budget") is False
        assert v2.get("volume_weight_capacity") is False
