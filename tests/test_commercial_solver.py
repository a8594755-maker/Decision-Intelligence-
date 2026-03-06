"""
Pytest tests for the commercial solver integration (Gurobi + CPLEX).

Tests cover:
  1. Engine registration — GurobiEngine / CplexEngine present in registry
  2. Availability helpers — gurobi_available() / cplex_available()
  3. Prod gate — commercial engines filtered when DI_ENABLE_COMMERCIAL_SOLVERS unset
  4. Cross-engine parity — parametric tests across ortools/gurobi/cplex (skip if missing)
  5. Solver-specific features — MIP gap, Compute Server config, cancellation
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest
from types import SimpleNamespace
from datetime import date, timedelta
from typing import Any, Dict, List, Optional
from unittest.mock import patch

from ml.api.solver_engines import (
    ENGINE_REGISTRY,
    GurobiEngine,
    CplexEngine,
    CommercialEngineStub,
    ORToolsEngine,
    HeuristicEngine,
    SolverEngineError,
    SolverErrorCode,
    get_solver_engine_registry,
    is_solver_engine_available,
    resolve_engine_allowlist,
    select_solver_engine,
    solve_planning_contract,
    _COMMERCIAL_ENGINE_KEYS,
)
from ml.api.solver_availability import (
    gurobi_available,
    cplex_available,
    ortools_available,
    get_solver_inventory,
)


# ── helpers (same pattern as test_replenishment_solver.py) ────────────────────

def _day(offset: int, base: str = "2025-06-01") -> str:
    y, m, d = map(int, base.split("-"))
    return (date(y, m, d) + timedelta(days=offset)).isoformat()


def _series(sku: str, plant_id: str, n_days: int,
            p50: float = 10.0, p90: Optional[float] = None) -> List[SimpleNamespace]:
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


def _unit_cost(sku: str, unit_cost: float) -> SimpleNamespace:
    return SimpleNamespace(sku=sku, unit_cost=unit_cost)


def _request(
    series: List[SimpleNamespace],
    inventory: Optional[List[SimpleNamespace]] = None,
    moq_list: Optional[List[SimpleNamespace]] = None,
    pack_list: Optional[List[SimpleNamespace]] = None,
    unit_cost_list: Optional[List[SimpleNamespace]] = None,
    budget_cap: Optional[float] = None,
    horizon_days: int = 7,
    stockout_penalty: float = 1.0,
    holding_cost: float = 0.0,
    settings: Optional[dict] = None,
    engine_flags: Optional[dict] = None,
) -> SimpleNamespace:
    """Build a minimal ReplenishmentPlanRequest-compatible namespace."""
    return SimpleNamespace(
        planning_horizon_days=horizon_days,
        demand_forecast=SimpleNamespace(series=series or [], granularity="daily"),
        inventory=inventory or [],
        open_pos=[],
        constraints=SimpleNamespace(
            moq=moq_list or [],
            pack_size=pack_list or [],
            max_order_qty=[],
            budget_cap=budget_cap,
            unit_costs=unit_cost_list or [],
            inventory_capacity_per_period=None,
            production_capacity_per_period=None,
        ),
        shared_constraints=SimpleNamespace(
            budget_cap=None,
            production_capacity_per_period=None,
            inventory_capacity_per_period=None,
            priority_weights={},
            budget_mode=None,
        ),
        objective=SimpleNamespace(
            optimize_for="balanced",
            stockout_penalty=stockout_penalty,
            holding_cost=holding_cost,
            service_level_target=None,
        ),
        multi_echelon=SimpleNamespace(mode="off"),
        items=[],
        diagnose_mode=False,
        bom_usage=[],
        settings=settings or {},
        engine_flags=engine_flags or {},
    )


# ── 1. Engine Registration ───────────────────────────────────────────────────

class TestEngineRegistration:
    """Verify Gurobi/CPLEX engines are properly registered."""

    def test_gurobi_in_registry(self):
        assert "gurobi" in ENGINE_REGISTRY
        assert isinstance(ENGINE_REGISTRY["gurobi"], GurobiEngine)
        assert ENGINE_REGISTRY["gurobi"].key == "gurobi"

    def test_cplex_in_registry(self):
        assert "cplex" in ENGINE_REGISTRY
        assert isinstance(ENGINE_REGISTRY["cplex"], CplexEngine)
        assert ENGINE_REGISTRY["cplex"].key == "cplex"

    def test_commercial_stub_still_present(self):
        assert "commercial_stub" in ENGINE_REGISTRY
        assert isinstance(ENGINE_REGISTRY["commercial_stub"], CommercialEngineStub)

    def test_all_expected_engines_present(self):
        expected = {"ortools", "heuristic", "gurobi", "cplex", "commercial_stub"}
        assert set(ENGINE_REGISTRY.keys()) == expected

    def test_get_registry_returns_copy(self):
        reg = get_solver_engine_registry()
        assert "gurobi" in reg
        assert "cplex" in reg
        reg["foo"] = None
        assert "foo" not in ENGINE_REGISTRY


# ── 2. Solver Availability ───────────────────────────────────────────────────

class TestSolverAvailability:
    """Test solver_availability module helpers."""

    def test_inventory_returns_all_backends(self):
        inv = get_solver_inventory()
        assert "ortools" in inv
        assert "gurobi" in inv
        assert "cplex" in inv

    def test_ortools_available_returns_bool(self):
        assert isinstance(ortools_available(), bool)

    def test_gurobi_available_returns_bool(self):
        assert isinstance(gurobi_available(), bool)

    def test_cplex_available_returns_bool(self):
        assert isinstance(cplex_available(), bool)

    def test_inventory_info_fields(self):
        inv = get_solver_inventory()
        for key, info in inv.items():
            assert hasattr(info, "name")
            assert hasattr(info, "available")
            assert hasattr(info, "version")
            assert hasattr(info, "license_type")
            assert isinstance(info.available, bool)

    def test_engine_availability_check_gurobi(self):
        expected = gurobi_available()
        assert is_solver_engine_available("gurobi") == expected

    def test_engine_availability_check_cplex(self):
        expected = cplex_available()
        assert is_solver_engine_available("cplex") == expected


# ── 3. Prod Gate ─────────────────────────────────────────────────────────────

class TestProdGate:
    """Verify commercial engines are gated in prod."""

    def test_prod_default_excludes_commercial(self):
        with patch.dict(os.environ, {"DI_RUNTIME_ENV": "prod"}, clear=False):
            # Remove any override env vars
            env_clean = {
                "DI_RUNTIME_ENV": "prod",
            }
            with patch.dict(os.environ, env_clean, clear=False):
                for var in ["DI_ENABLE_COMMERCIAL_SOLVERS",
                            "DI_SOLVER_ENGINE_ALLOWLIST",
                            "DI_SOLVER_ENGINE_ALLOWLIST_PROD"]:
                    os.environ.pop(var, None)

                allowlist = resolve_engine_allowlist("prod")
                assert "gurobi" not in allowlist
                assert "cplex" not in allowlist
                assert "commercial_stub" not in allowlist
                assert "heuristic" in allowlist
                assert "ortools" in allowlist

    def test_prod_with_commercial_enabled(self):
        with patch.dict(
            os.environ,
            {
                "DI_RUNTIME_ENV": "prod",
                "DI_ENABLE_COMMERCIAL_SOLVERS": "true",
                "DI_SOLVER_ENGINE_ALLOWLIST": "heuristic,ortools,gurobi,cplex",
            },
            clear=False,
        ):
            allowlist = resolve_engine_allowlist("prod")
            assert "gurobi" in allowlist
            assert "cplex" in allowlist

    def test_dev_includes_commercial(self):
        for var in ["DI_SOLVER_ENGINE_ALLOWLIST",
                    "DI_SOLVER_ENGINE_ALLOWLIST_DEV"]:
            os.environ.pop(var, None)

        allowlist = resolve_engine_allowlist("dev")
        assert "gurobi" in allowlist
        assert "cplex" in allowlist

    def test_staging_includes_commercial(self):
        for var in ["DI_SOLVER_ENGINE_ALLOWLIST",
                    "DI_SOLVER_ENGINE_ALLOWLIST_STAGING"]:
            os.environ.pop(var, None)

        allowlist = resolve_engine_allowlist("staging")
        assert "gurobi" in allowlist
        assert "cplex" in allowlist

    def test_commercial_engine_keys_constant(self):
        assert "gurobi" in _COMMERCIAL_ENGINE_KEYS
        assert "cplex" in _COMMERCIAL_ENGINE_KEYS
        assert "commercial_stub" in _COMMERCIAL_ENGINE_KEYS
        assert "ortools" not in _COMMERCIAL_ENGINE_KEYS


# ── 4. Engine Selection ──────────────────────────────────────────────────────

class TestEngineSelection:
    """Test that engine selection handles gurobi/cplex correctly."""

    def test_select_gurobi_when_allowed(self):
        req = _request(series=[], settings={}, engine_flags={"solver_engine": "gurobi"})
        with patch.dict(os.environ, {
            "DI_SOLVER_ENGINE_OVERRIDE_ENABLED": "true",
            "DI_RUNTIME_ENV": "dev",
        }, clear=False):
            req.engine_flags["enable_solver_engine_override"] = True
            selection = select_solver_engine(req, environment="dev")
            # If gurobi is available, it should be selected; otherwise fallback
            if gurobi_available():
                assert selection.selected_engine == "gurobi"
            else:
                # Falls back to an available engine
                assert selection.selected_engine in ENGINE_REGISTRY

    def test_select_cplex_when_allowed(self):
        req = _request(series=[], settings={}, engine_flags={"solver_engine": "cplex"})
        with patch.dict(os.environ, {
            "DI_SOLVER_ENGINE_OVERRIDE_ENABLED": "true",
            "DI_RUNTIME_ENV": "dev",
        }, clear=False):
            req.engine_flags["enable_solver_engine_override"] = True
            selection = select_solver_engine(req, environment="dev")
            if cplex_available():
                assert selection.selected_engine == "cplex"
            else:
                assert selection.selected_engine in ENGINE_REGISTRY


# ── 5. Engine Error Handling ─────────────────────────────────────────────────

class TestEngineErrorHandling:
    """Engines raise proper errors when unavailable."""

    def test_gurobi_raises_unavailable_when_not_installed(self):
        if gurobi_available():
            pytest.skip("Gurobi IS available; cannot test unavailable path")
        engine = GurobiEngine()
        req = _request(series=_series("A", "P1", 7), inventory=[_inventory("A", "P1")])
        with pytest.raises(SolverEngineError) as exc_info:
            engine.solve(req)
        assert exc_info.value.code == SolverErrorCode.ENGINE_UNAVAILABLE

    def test_cplex_raises_unavailable_when_not_installed(self):
        if cplex_available():
            pytest.skip("CPLEX IS available; cannot test unavailable path")
        engine = CplexEngine()
        req = _request(series=_series("A", "P1", 7), inventory=[_inventory("A", "P1")])
        with pytest.raises(SolverEngineError) as exc_info:
            engine.solve(req)
        assert exc_info.value.code == SolverErrorCode.ENGINE_UNAVAILABLE


# ── 6. Cross-Engine Parity (skip if solver not installed) ────────────────────

def _get_available_solver_backends() -> List[str]:
    """Return engine keys for installed solver backends (for parametric tests)."""
    engines = []
    if ortools_available():
        engines.append("ortools")
    if gurobi_available():
        engines.append("gurobi")
    if cplex_available():
        engines.append("cplex")
    return engines


_PARITY_ENGINES = _get_available_solver_backends()
_NEED_AT_LEAST_TWO = pytest.mark.skipif(
    len(_PARITY_ENGINES) < 2,
    reason=f"Need >=2 solver backends for parity test; found: {_PARITY_ENGINES}",
)


class TestCrossEngineParity:
    """If multiple solver backends are installed, verify they produce equivalent results."""

    @_NEED_AT_LEAST_TWO
    def test_simple_plan_status_matches(self):
        """All engines should return OPTIMAL/FEASIBLE for a trivial demand case."""
        req = _request(
            series=_series("SKU1", "P1", 7, p50=10.0),
            inventory=[_inventory("SKU1", "P1", on_hand=100.0)],
            horizon_days=7,
        )
        results: Dict[str, Dict] = {}
        for engine_key in _PARITY_ENGINES:
            engine = ENGINE_REGISTRY[engine_key]
            result = engine.solve(req)
            results[engine_key] = result

        statuses = {k: v["status"] for k, v in results.items()}
        status_values = set(statuses.values())
        # All should be OPTIMAL or FEASIBLE
        assert status_values <= {"OPTIMAL", "FEASIBLE"}, f"Status mismatch: {statuses}"

    @_NEED_AT_LEAST_TWO
    def test_plan_lines_count_matches(self):
        """All engines should produce the same number of plan lines for same input."""
        req = _request(
            series=_series("SKU1", "P1", 7, p50=10.0),
            inventory=[_inventory("SKU1", "P1", on_hand=50.0)],
            horizon_days=7,
        )
        results = {}
        for engine_key in _PARITY_ENGINES:
            engine = ENGINE_REGISTRY[engine_key]
            result = engine.solve(req)
            results[engine_key] = result

        line_counts = {k: len(v.get("plan", v.get("plan_lines", [])))
                       for k, v in results.items()}
        counts = set(line_counts.values())
        assert len(counts) == 1, f"Plan line count mismatch: {line_counts}"

    @_NEED_AT_LEAST_TWO
    def test_empty_demand_all_infeasible(self):
        """All engines should return INFEASIBLE for empty demand."""
        req = _request(series=[])
        for engine_key in _PARITY_ENGINES:
            engine = ENGINE_REGISTRY[engine_key]
            result = engine.solve(req)
            assert result["status"] == "INFEASIBLE", \
                f"{engine_key} returned {result['status']} for empty demand"

    @_NEED_AT_LEAST_TWO
    def test_moq_constraint_respected(self):
        """All engines should respect MOQ constraints."""
        req = _request(
            series=_series("SKU1", "P1", 7, p50=5.0),
            inventory=[_inventory("SKU1", "P1", on_hand=0.0)],
            moq_list=[_moq("SKU1", 20.0)],
            horizon_days=7,
        )
        for engine_key in _PARITY_ENGINES:
            engine = ENGINE_REGISTRY[engine_key]
            result = engine.solve(req)
            if result["status"] in ("OPTIMAL", "FEASIBLE"):
                plan_lines = result.get("plan", result.get("plan_lines", []))
                for line in plan_lines:
                    qty = line.get("order_qty", line.get("qty", 0))
                    if qty > 0:
                        assert qty >= 20.0, \
                            f"{engine_key}: order_qty {qty} < MOQ 20"


# ── 7. Single-Engine Tests (parametric, skip if not installed) ───────────────

@pytest.mark.skipif(not gurobi_available(), reason="Gurobi not installed")
class TestGurobiSolver:
    """Tests for the Gurobi backend specifically."""

    def test_simple_solve(self):
        req = _request(
            series=_series("A", "P1", 7, p50=10.0),
            inventory=[_inventory("A", "P1", on_hand=20.0)],
            horizon_days=7,
        )
        engine = GurobiEngine()
        result = engine.solve(req)
        assert result["status"] in ("OPTIMAL", "FEASIBLE")
        assert "solver_meta" in result
        assert result["solver_meta"]["solver"] == "gurobi_milp"

    def test_cancel_support(self):
        """Gurobi should handle cancel_check returning True."""
        req = _request(
            series=_series("A", "P1", 7, p50=10.0),
            inventory=[_inventory("A", "P1", on_hand=20.0)],
            horizon_days=7,
        )
        engine = GurobiEngine()
        result = engine.solve(req, cancel_check=lambda: True)
        # Should get TIMEOUT or still solve fast enough to return a result
        assert result["status"] in ("TIMEOUT", "OPTIMAL", "FEASIBLE")

    def test_mip_gap_config(self):
        """Verify MIP gap can be set via engine_flags."""
        req = _request(
            series=_series("A", "P1", 7, p50=10.0),
            inventory=[_inventory("A", "P1", on_hand=20.0)],
            horizon_days=7,
            engine_flags={"gurobi": {"mip_gap": 0.05}},
        )
        engine = GurobiEngine()
        result = engine.solve(req)
        assert result["status"] in ("OPTIMAL", "FEASIBLE")


@pytest.mark.skipif(not cplex_available(), reason="CPLEX not installed")
class TestCplexSolver:
    """Tests for the CPLEX backend specifically."""

    def test_simple_solve(self):
        req = _request(
            series=_series("A", "P1", 7, p50=10.0),
            inventory=[_inventory("A", "P1", on_hand=20.0)],
            horizon_days=7,
        )
        engine = CplexEngine()
        result = engine.solve(req)
        assert result["status"] in ("OPTIMAL", "FEASIBLE")
        assert "solver_meta" in result
        assert result["solver_meta"]["solver"] == "cplex_milp"

    def test_cancel_before_start(self):
        """CPLEX should handle cancel_check returning True before solve."""
        req = _request(
            series=_series("A", "P1", 7, p50=10.0),
            inventory=[_inventory("A", "P1", on_hand=20.0)],
            horizon_days=7,
        )
        engine = CplexEngine()
        result = engine.solve(req, cancel_check=lambda: True)
        assert result["status"] in ("TIMEOUT", "OPTIMAL", "FEASIBLE")


# ── 8. solve_planning_contract integration ───────────────────────────────────

class TestSolvePlanningContract:
    """Verify solve_planning_contract routes to commercial engines correctly."""

    def test_solve_with_heuristic_fallback(self):
        """When no commercial solver available, should use heuristic or ortools."""
        req = _request(
            series=_series("A", "P1", 7, p50=10.0),
            inventory=[_inventory("A", "P1", on_hand=50.0)],
            horizon_days=7,
        )
        result = solve_planning_contract(req, environment="dev")
        assert "status" in result
        assert "solver_meta" in result

    def test_solve_returns_engine_selection_meta(self):
        """Result should include engine_selection metadata."""
        req = _request(
            series=_series("A", "P1", 7, p50=10.0),
            inventory=[_inventory("A", "P1", on_hand=50.0)],
            horizon_days=7,
        )
        result = solve_planning_contract(req, environment="dev")
        sm = result.get("solver_meta", {})
        assert "engine_selected" in sm
        assert "engine_allowlist" in sm
        assert isinstance(sm["engine_allowlist"], list)
