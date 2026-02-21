import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest

ortools = pytest.importorskip("ortools", reason="ortools not installed")

from ml.api.replenishment_solver import (
    SolverRunSettings,
    _cp_model,
    _status_from_cp,
    solve_replenishment,
)

from tests.planning_test_utils import canonicalize_for_compare, load_fixture, to_namespace


class _FakeSolver:
    def __init__(self, wall_time_s: float):
        self._wall_time_s = wall_time_s

    def StatusName(self, _status):
        return "FEASIBLE"

    def WallTime(self):
        return self._wall_time_s


def test_deterministic_output_stable_in_ci_mode():
    fixture = load_fixture("feasible_single.json")
    request = to_namespace(fixture)

    run1 = solve_replenishment(request)
    run2 = solve_replenishment(request)

    assert canonicalize_for_compare(run1) == canonicalize_for_compare(run2)


def test_timeout_fixture_no_feasible_returns_timeout_status():
    fixture = load_fixture("timeout_single.json")
    result = solve_replenishment(to_namespace(fixture))

    assert result["status"] == "TIMEOUT"
    assert result["plan_lines"] == []
    assert result["solver_meta"]["termination_reason"] in {"FORCED_TIMEOUT", "TIME_LIMIT_NO_FEASIBLE"}


def test_timeout_semantics_with_feasible_solution_mapping():
    settings = SolverRunSettings(
        time_limit_seconds=1.0,
        random_seed=0,
        num_search_workers=1,
        log_search_progress=False,
        deterministic_mode=True,
    )
    info = _status_from_cp(
        _cp_model.FEASIBLE,
        _FakeSolver(wall_time_s=1.0),
        settings,
        solve_time_ms=1000,
    )

    assert info.status.value == "TIMEOUT"
    assert info.termination_reason == "TIME_LIMIT_FEASIBLE"
    assert info.has_feasible_solution is True


def test_timeout_semantics_without_feasible_solution_mapping():
    settings = SolverRunSettings(
        time_limit_seconds=1.0,
        random_seed=0,
        num_search_workers=1,
        log_search_progress=False,
        deterministic_mode=True,
    )
    info = _status_from_cp(
        _cp_model.UNKNOWN,
        _FakeSolver(wall_time_s=1.0),
        settings,
        solve_time_ms=1000,
    )

    assert info.status.value == "TIMEOUT"
    assert info.termination_reason == "TIME_LIMIT_NO_FEASIBLE"
    assert info.has_feasible_solution is False
