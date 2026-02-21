"""Fixture-based forecast regression suite (contracts + invariants + KPI bounds)."""
from __future__ import annotations

import time

import pytest

from tests.regression.forecast_regression_harness import (
    assert_backtest_contract_schema,
    assert_fixture_expectations,
    assert_forecast_invariants,
    assert_inference_contract_schema,
    assert_runtime_budget,
    canonicalize_for_determinism,
    load_fixtures,
    run_backtest_fixture,
)


FORECAST_FIXTURES = load_fixtures()


@pytest.mark.parametrize("fixture", FORECAST_FIXTURES, ids=lambda f: f["id"])
def test_forecast_regression_fixture_contracts_invariants_and_kpis(fixture):
    started = time.perf_counter()
    backtest_result = run_backtest_fixture(fixture)
    elapsed = time.perf_counter() - started

    assert_runtime_budget(fixture, elapsed_seconds=elapsed)
    assert_forecast_invariants(backtest_result)
    assert_fixture_expectations(backtest_result, fixture)
    assert_backtest_contract_schema(backtest_result, fixture)
    assert_inference_contract_schema(backtest_result, fixture)


@pytest.mark.parametrize("fixture", FORECAST_FIXTURES, ids=lambda f: f["id"])
def test_forecast_regression_is_deterministic(fixture):
    run1 = run_backtest_fixture(fixture)
    run2 = run_backtest_fixture(fixture)

    assert canonicalize_for_determinism(run1) == canonicalize_for_determinism(run2)
