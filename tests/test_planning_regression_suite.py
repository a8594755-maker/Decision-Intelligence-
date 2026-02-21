"""Deterministic fixture-based regression tests for Phase 1 planning."""
from __future__ import annotations

import pytest

from tests.planning_regression_harness import (
    assert_contract_schema,
    assert_fixture_expectations,
    assert_hard_constraints,
    canonicalize_for_determinism,
    load_core_fixtures,
    load_optional_fixtures,
    run_fixture_engine,
)


CORE_FIXTURES = load_core_fixtures()
OPTIONAL_FIXTURES = load_optional_fixtures()


@pytest.mark.parametrize("fixture", CORE_FIXTURES, ids=lambda f: f["id"])
@pytest.mark.parametrize("engine", ["heuristic", "ortools"])
def test_planning_regression_fixture_contracts(fixture, engine):
    if engine not in (fixture.get("engines") or []):
        pytest.skip(f"fixture {fixture['id']} does not target engine={engine}")

    result = run_fixture_engine(fixture, engine)
    assert_contract_schema(result, expect_multi=False)
    assert_hard_constraints(result, fixture["request"])
    assert_fixture_expectations(result, fixture)


@pytest.mark.parametrize("fixture", CORE_FIXTURES, ids=lambda f: f["id"])
@pytest.mark.parametrize("engine", ["heuristic", "ortools"])
def test_planning_regression_is_deterministic(fixture, engine):
    if engine not in (fixture.get("engines") or []):
        pytest.skip(f"fixture {fixture['id']} does not target engine={engine}")

    run1 = run_fixture_engine(fixture, engine)
    run2 = run_fixture_engine(fixture, engine)

    assert canonicalize_for_determinism(run1) == canonicalize_for_determinism(run2)


@pytest.mark.parametrize("fixture", OPTIONAL_FIXTURES, ids=lambda f: f["id"])
def test_optional_multi_echelon_fixture_contract(fixture):
    result = run_fixture_engine(fixture, "ortools")
    assert_contract_schema(result, expect_multi=True)
    assert_fixture_expectations(result, fixture)
