import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from ml.api.solver_engines import is_solver_engine_available, solve_with_engine

from tests.planning_test_utils import load_fixture, to_namespace


_ALLOWED_STATUSES = {"OPTIMAL", "FEASIBLE", "INFEASIBLE", "TIMEOUT", "ERROR"}
_REQUIRED_SOLVER_META_FIELDS = {
    "engine",
    "status",
    "termination_reason",
    "solve_time_ms",
    "time_limit",
    "seed",
    "workers",
}


def _assert_contract_shape(payload):
    assert payload["contract_version"] == "1.0"
    assert payload["status"] in _ALLOWED_STATUSES
    assert "solver_meta" in payload and isinstance(payload["solver_meta"], dict)
    assert "proof" in payload and isinstance(payload["proof"], dict)
    assert "plan_lines" in payload and isinstance(payload["plan_lines"], list)
    assert "plan" in payload and isinstance(payload["plan"], list)
    assert "infeasible_reasons" in payload and isinstance(payload["infeasible_reasons"], list)
    assert "infeasible_reason_details" in payload and isinstance(payload["infeasible_reason_details"], list)
    assert "diagnostics" in payload and isinstance(payload["diagnostics"], dict)
    assert _REQUIRED_SOLVER_META_FIELDS <= set(payload["solver_meta"].keys())


def _engines_for_parity():
    engines = ["heuristic", "commercial_stub"]
    if is_solver_engine_available("ortools"):
        engines.append("ortools")
    return engines


def _run_fixture_for_engines(fixture_name):
    fixture = load_fixture(fixture_name)
    request = to_namespace(fixture)
    engines = _engines_for_parity()
    return {engine: solve_with_engine(engine, request) for engine in engines}


def test_single_fixture_cross_engine_schema_parity():
    results = _run_fixture_for_engines("feasible_single.json")

    for payload in results.values():
        _assert_contract_shape(payload)
        assert payload["plan"] == payload["plan_lines"]

    key_sets = {engine: set(payload.keys()) for engine, payload in results.items()}
    assert len({frozenset(keys) for keys in key_sets.values()}) == 1

    solver_meta_key_sets = {
        engine: set(payload["solver_meta"].keys()) for engine, payload in results.items()
    }
    assert len({frozenset(keys) for keys in solver_meta_key_sets.values()}) == 1

    proof_key_sets = {
        engine: set(payload["proof"].keys()) for engine, payload in results.items()
    }
    assert len({frozenset(keys) for keys in proof_key_sets.values()}) == 1


def test_multi_sku_fixture_cross_engine_schema_parity():
    results = _run_fixture_for_engines("multi_sku_shared_capacity.json")

    for payload in results.values():
        _assert_contract_shape(payload)
        assert payload["status"] in _ALLOWED_STATUSES

    key_sets = {engine: set(payload.keys()) for engine, payload in results.items()}
    assert len({frozenset(keys) for keys in key_sets.values()}) == 1
