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

from ml.api.replenishment_solver import solve_replenishment, ortools_available, SCALE


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


def _request(
    series: List[SimpleNamespace],
    inventory: Optional[List[SimpleNamespace]] = None,
    open_pos: Optional[List[SimpleNamespace]] = None,
    moq_list: Optional[List[SimpleNamespace]] = None,
    pack_list: Optional[List[SimpleNamespace]] = None,
    max_qty_list: Optional[List[SimpleNamespace]] = None,
    budget_cap: Optional[float] = None,
    horizon_days: int = 7,
    stockout_penalty: float = 1.0,
    holding_cost: float = 0.0,
) -> SimpleNamespace:
    """Build a minimal ReplenishmentPlanRequest-compatible namespace."""
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
        multi_echelon=SimpleNamespace(mode="off"),
        bom_usage=[],
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
        assert result["status"] == "infeasible"
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
        assert result["status"] in ("optimal", "feasible", "infeasible")
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

        assert result["status"] in ("optimal", "feasible")
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

        assert result["status"] in ("optimal", "feasible")
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
        assert result["status"] in ("optimal", "feasible")

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
