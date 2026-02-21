"""Fixture-based planning regression suite with parity and determinism checks."""
from __future__ import annotations

import math

import pytest

from tests.planning_regression_harness import (
    assert_contract_schema,
    assert_fixture_expectations,
    assert_hard_constraints,
    canonicalize_for_determinism,
    get_status_family,
    get_status_type,
    load_core_fixtures,
    load_optional_fixtures,
    run_fixture_engine,
)


CORE_FIXTURES = load_core_fixtures()
OPTIONAL_FIXTURES = load_optional_fixtures()
PARITY_FIXTURES = [
    fixture for fixture in CORE_FIXTURES if set(fixture.get("engines") or []) >= {"heuristic", "ortools"}
]


def _to_float(value, default=0.0):
    try:
        return float(value)
    except Exception:
        return default


def _assert_runtime_budget_ms(result, fixture):
    request = fixture.get("request") or {}
    settings = request.get("settings") or {}
    solver = settings.get("solver") or {}

    # Tie budget to fixture time_limit_seconds with a fixed buffer.
    time_limit_seconds = max(0.05, _to_float(solver.get("time_limit_seconds"), 5.0))
    budget_ms = (time_limit_seconds * 1000.0) + 1500.0

    solve_time_ms = _to_float((result.get("solver_meta") or {}).get("solve_time_ms"), float("nan"))
    assert math.isfinite(solve_time_ms), "solver_meta.solve_time_ms must be finite"
    assert solve_time_ms <= budget_ms, (
        f"runtime budget exceeded for fixture={fixture.get('id')}: "
        f"{solve_time_ms:.2f}ms > {budget_ms:.2f}ms"
    )


def _expected_status_family(fixture):
    statuses = set((fixture.get("expectations") or {}).get("status_any") or [])
    if not statuses:
        return None
    if statuses <= {"OPTIMAL", "FEASIBLE"}:
        return "FEASIBLE_FAMILY"
    if len(statuses) == 1:
        return list(statuses)[0]
    return None


@pytest.mark.parametrize("fixture", CORE_FIXTURES, ids=lambda f: f["id"])
@pytest.mark.parametrize("engine", ["heuristic", "ortools"])
def test_planning_regression_fixture_contracts_and_invariants(fixture, engine):
    if engine not in (fixture.get("engines") or []):
        pytest.skip(f"fixture {fixture['id']} does not target engine={engine}")

    result = run_fixture_engine(fixture, engine)
    assert_contract_schema(result, expect_multi=False)
    assert_hard_constraints(result, fixture["request"])
    assert_fixture_expectations(result, fixture)
    _assert_runtime_budget_ms(result, fixture)


@pytest.mark.parametrize("fixture", CORE_FIXTURES, ids=lambda f: f["id"])
@pytest.mark.parametrize("engine", ["heuristic", "ortools"])
def test_planning_regression_is_deterministic(fixture, engine):
    if engine not in (fixture.get("engines") or []):
        pytest.skip(f"fixture {fixture['id']} does not target engine={engine}")

    run1 = run_fixture_engine(fixture, engine)
    run2 = run_fixture_engine(fixture, engine)

    assert canonicalize_for_determinism(run1) == canonicalize_for_determinism(run2)


@pytest.mark.parametrize("fixture", OPTIONAL_FIXTURES, ids=lambda f: f["id"])
def test_optional_multi_echelon_fixture_contracts_and_expectations(fixture):
    result = run_fixture_engine(fixture, "ortools")
    assert_contract_schema(result, expect_multi=True)
    assert_fixture_expectations(result, fixture)
    _assert_runtime_budget_ms(result, fixture)


@pytest.mark.parametrize("fixture", PARITY_FIXTURES, ids=lambda f: f["id"])
def test_cross_engine_parity_contract_and_status_family(fixture):
    heuristic_result = run_fixture_engine(fixture, "heuristic")
    ortools_result = run_fixture_engine(fixture, "ortools")

    assert_contract_schema(heuristic_result, expect_multi=False)
    assert_contract_schema(ortools_result, expect_multi=False)
    _assert_runtime_budget_ms(heuristic_result, fixture)
    _assert_runtime_budget_ms(ortools_result, fixture)

    assert heuristic_result.get("contract_version") == ortools_result.get("contract_version")

    heuristic_status = get_status_type(heuristic_result)
    ortools_status = get_status_type(ortools_result)
    heuristic_family = get_status_family(heuristic_status)
    ortools_family = get_status_family(ortools_status)
    assert heuristic_family == ortools_family, (
        f"status family mismatch: heuristic={heuristic_status}, ortools={ortools_status}"
    )

    expected_family = _expected_status_family(fixture)
    if expected_family is not None:
        assert heuristic_family == expected_family, (
            f"fixture {fixture['id']} expected family={expected_family}, got={heuristic_family}"
        )

    for result in (heuristic_result, ortools_result):
        proof = result.get("proof") or {}
        solver_meta = result.get("solver_meta") or {}
        assert isinstance(proof.get("objective_terms"), list)
        assert isinstance(proof.get("constraints_checked"), list)
        assert isinstance(solver_meta, dict) and len(solver_meta) > 0

    if heuristic_family in {"INFEASIBLE", "TIMEOUT", "ERROR"}:
        heuristic_reasons = heuristic_result.get("infeasible_reasons") or []
        ortools_reasons = ortools_result.get("infeasible_reasons") or []
        assert len(heuristic_reasons) > 0
        assert len(ortools_reasons) > 0
