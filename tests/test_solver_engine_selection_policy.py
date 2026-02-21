import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from ml.api.solver_engines import (
    get_solver_engine_registry,
    resolve_engine_allowlist,
    select_solver_engine,
    solve_planning_contract,
)
from tests.planning_test_utils import load_fixture, to_namespace


def _base_request():
    fixture = load_fixture("feasible_single.json")
    return fixture


def test_solver_registry_contains_expected_engines():
    registry = get_solver_engine_registry()
    assert {"ortools", "heuristic", "commercial_stub"} <= set(registry.keys())
    for engine in registry.values():
        assert hasattr(engine, "solve")


def test_selection_defaults_to_env_engine(monkeypatch):
    monkeypatch.setenv("DI_SOLVER_ENGINE", "heuristic")
    monkeypatch.setenv("DI_ENV", "dev")
    monkeypatch.delenv("DI_SOLVER_ENGINE_OVERRIDE_ENABLED", raising=False)

    selection = select_solver_engine(to_namespace(_base_request()))
    assert selection.selected_engine == "heuristic"
    assert selection.source == "env"


def test_request_override_requires_feature_flag(monkeypatch):
    request = _base_request()
    request.setdefault("engine_flags", {})["solver_engine"] = "commercial_stub"

    monkeypatch.setenv("DI_SOLVER_ENGINE", "heuristic")
    monkeypatch.setenv("DI_ENV", "dev")
    monkeypatch.setenv("DI_SOLVER_ENGINE_OVERRIDE_ENABLED", "true")

    no_flag_selection = select_solver_engine(to_namespace(request))
    assert no_flag_selection.selected_engine == "heuristic"
    assert any("override ignored" in note.lower() for note in no_flag_selection.notes)

    request.setdefault("engine_flags", {})["enable_solver_engine_override"] = True
    enabled_selection = select_solver_engine(to_namespace(request))
    assert enabled_selection.selected_engine == "commercial_stub"
    assert enabled_selection.source == "feature_flag"


def test_prod_disables_commercial_engine_by_default(monkeypatch):
    request = _base_request()
    request.setdefault("engine_flags", {})["solver_engine"] = "commercial_stub"
    request.setdefault("engine_flags", {})["enable_solver_engine_override"] = True

    monkeypatch.setenv("DI_ENV", "prod")
    monkeypatch.setenv("DI_SOLVER_ENGINE", "heuristic")
    monkeypatch.setenv("DI_SOLVER_ENGINE_OVERRIDE_ENABLED", "true")
    monkeypatch.delenv("DI_ENABLE_COMMERCIAL_SOLVERS", raising=False)

    selection = select_solver_engine(to_namespace(request))
    assert selection.selected_engine == "heuristic"
    assert "commercial_stub" not in selection.allowlist


def test_env_specific_allowlist_override(monkeypatch):
    monkeypatch.setenv("DI_SOLVER_ENGINE_ALLOWLIST_TEST", "heuristic")
    allowlist = resolve_engine_allowlist("test")
    assert allowlist == ("heuristic",)


def test_solver_execution_includes_selection_metadata(monkeypatch):
    monkeypatch.setenv("DI_SOLVER_ENGINE", "heuristic")
    monkeypatch.setenv("DI_ENV", "test")
    monkeypatch.delenv("DI_SOLVER_ENGINE_OVERRIDE_ENABLED", raising=False)

    result = solve_planning_contract(to_namespace(_base_request()))
    assert result["contract_version"] == "1.0"
    assert result["status"] in {"OPTIMAL", "FEASIBLE", "INFEASIBLE", "TIMEOUT", "ERROR"}
    solver_meta = result.get("solver_meta") or {}
    for field in (
        "engine_key",
        "engine_selected",
        "engine_requested",
        "engine_source",
        "engine_environment",
        "engine_allowlist",
        "engine_selection_notes",
    ):
        assert field in solver_meta
