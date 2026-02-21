"""Shared harness for deterministic planning regression fixtures."""
from __future__ import annotations

import copy
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from ml.api.planning_contract import PlanningStatus, normalize_status
from ml.api.solver_engines import is_solver_engine_available, solve_with_engine

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "planning"
CORE_FIXTURE_FILES = [
    "feasible_basic_single.json",
    "feasible_tight_capacity.json",
    "infeasible_capacity.json",
    "timeout_hard_case.json",
]
OPTIONAL_FIXTURE_FILES = [
    "multi_echelon_bom_basic.json",
]


def _to_namespace(value: Any) -> Any:
    if isinstance(value, dict):
        return SimpleNamespace(**{k: _to_namespace(v) for k, v in value.items()})
    if isinstance(value, list):
        return [_to_namespace(v) for v in value]
    return value


def load_fixture(file_name: str) -> Dict[str, Any]:
    with (FIXTURE_DIR / file_name).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_core_fixtures() -> List[Dict[str, Any]]:
    return [load_fixture(name) for name in CORE_FIXTURE_FILES]


def load_optional_fixtures() -> List[Dict[str, Any]]:
    return [load_fixture(name) for name in OPTIONAL_FIXTURE_FILES]


def get_status_type(result: Dict[str, Any]) -> str:
    return normalize_status(result.get("status"), PlanningStatus.ERROR).value


def get_status_family(status: str) -> str:
    if status in {PlanningStatus.OPTIMAL.value, PlanningStatus.FEASIBLE.value}:
        return "FEASIBLE_FAMILY"
    return status


def _is_multi_echelon_request(fixture: Dict[str, Any]) -> bool:
    request = fixture.get("request") or {}
    me = request.get("multi_echelon") or {}
    mode = str(me.get("mode") or "").strip().lower()
    return mode == "bom_v0"


def run_fixture_engine(fixture: Dict[str, Any], engine: str) -> Dict[str, Any]:
    request = _to_namespace(copy.deepcopy(fixture.get("request") or {}))

    if engine not in {"heuristic", "ortools", "commercial_stub"}:
        raise ValueError(f"Unsupported engine: {engine}")

    if engine == "ortools" and not is_solver_engine_available("ortools"):
        pytest.skip("ortools not installed")

    return solve_with_engine(engine, request)


def _get_plan_rows(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = result.get("plan_lines")
    if isinstance(rows, list):
        return rows
    legacy = result.get("plan")
    if isinstance(legacy, list):
        return legacy
    return []


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def assert_contract_schema(result: Dict[str, Any], *, expect_multi: bool = False) -> None:
    required_root = [
        "contract_version",
        "status",
        "plan_lines",
        "plan",
        "kpis",
        "solver_meta",
        "infeasible_reasons",
        "proof",
    ]
    for key in required_root:
        assert key in result, f"missing key: {key}"

    assert str(result.get("contract_version") or "").startswith("1."), "contract_version must be 1.x"
    assert get_status_type(result) in {
        PlanningStatus.OPTIMAL.value,
        PlanningStatus.FEASIBLE.value,
        PlanningStatus.INFEASIBLE.value,
        PlanningStatus.TIMEOUT.value,
        PlanningStatus.ERROR.value,
    }

    kpis = result.get("kpis") or {}
    for key in (
        "estimated_service_level",
        "estimated_stockout_units",
        "estimated_holding_units",
        "estimated_total_cost",
    ):
        assert key in kpis, f"kpis missing key: {key}"

    solver_meta = result.get("solver_meta") or {}
    assert "engine" in solver_meta, "solver_meta.engine missing"
    assert "status" in solver_meta, "solver_meta.status missing"
    assert "solve_time_ms" in solver_meta, "solver_meta.solve_time_ms missing"

    proof = result.get("proof") or {}
    assert isinstance(proof.get("objective_terms"), list), "proof.objective_terms must be a list"
    assert isinstance(proof.get("constraints_checked"), list), "proof.constraints_checked must be a list"

    if expect_multi:
        for key in ("component_plan", "component_inventory_projection", "bottlenecks"):
            assert key in result, f"missing multi-echelon key: {key}"


def assert_hard_constraints(result: Dict[str, Any], request: Dict[str, Any]) -> None:
    constraints = request.get("constraints") or {}
    plan_rows = _get_plan_rows(result)

    moq_map = {
        str((row or {}).get("sku") or "").strip(): max(0.0, _to_float((row or {}).get("min_qty"), 0.0))
        for row in constraints.get("moq") or []
    }
    pack_map = {
        str((row or {}).get("sku") or "").strip(): max(0.0, _to_float((row or {}).get("pack_qty"), 0.0))
        for row in constraints.get("pack_size") or []
    }
    max_map = {
        str((row or {}).get("sku") or "").strip(): max(0.0, _to_float((row or {}).get("max_qty"), 0.0))
        for row in constraints.get("max_order_qty") or []
    }
    budget_cap = constraints.get("budget_cap")
    budget_cap_val = None if budget_cap is None else max(0.0, _to_float(budget_cap, 0.0))

    total_order_qty = 0.0
    for row in plan_rows:
        sku = str(row.get("sku") or "").strip()
        qty = _to_float(row.get("order_qty"), 0.0)
        assert qty >= -1e-9, f"negative order quantity: {qty}"
        if qty <= 0.0:
            continue
        total_order_qty += qty

        moq = moq_map.get(sku, 0.0)
        if moq > 0.0:
            assert qty + 1e-9 >= moq, f"MOQ violation for {sku}: qty={qty} < moq={moq}"

        pack = pack_map.get(sku, 0.0)
        if pack > 1.0:
            ratio = qty / pack
            assert abs(ratio - round(ratio)) <= 1e-6, f"Pack-size violation for {sku}: qty={qty}, pack={pack}"

        max_qty = max_map.get(sku, 0.0)
        if max_qty > 0.0:
            assert qty <= max_qty + 1e-9, f"max_order_qty violation for {sku}: qty={qty}, max={max_qty}"

    if budget_cap_val is not None:
        assert total_order_qty <= budget_cap_val + 1e-6, (
            f"budget cap violation: total_order_qty={total_order_qty}, budget_cap={budget_cap_val}"
        )


def assert_fixture_expectations(result: Dict[str, Any], fixture: Dict[str, Any]) -> None:
    exp = fixture.get("expectations") or {}
    status = get_status_type(result)

    allowed_statuses = exp.get("status_any") or []
    if allowed_statuses:
        assert status in set(allowed_statuses), f"status {status} not in expected {allowed_statuses}"

    if status in {PlanningStatus.INFEASIBLE.value, PlanningStatus.TIMEOUT.value, PlanningStatus.ERROR.value}:
        reasons = result.get("infeasible_reasons") or []
        assert len(reasons) > 0, "terminal status must include infeasible_reasons"

    plan_rows = _get_plan_rows(result)
    plan_bounds = exp.get("plan_rows") or {}
    if "min" in plan_bounds:
        assert len(plan_rows) >= int(plan_bounds["min"]), f"plan row count too low: {len(plan_rows)}"
    if "max" in plan_bounds:
        assert len(plan_rows) <= int(plan_bounds["max"]), f"plan row count too high: {len(plan_rows)}"

    total_order_qty = sum(max(0.0, _to_float(row.get("order_qty"), 0.0)) for row in plan_rows)
    order_bounds = exp.get("order_qty_total") or {}
    if "min" in order_bounds:
        assert total_order_qty + 1e-9 >= float(order_bounds["min"]), (
            f"order_qty_total below min: {total_order_qty} < {order_bounds['min']}"
        )
    if "max" in order_bounds:
        assert total_order_qty <= float(order_bounds["max"]) + 1e-9, (
            f"order_qty_total above max: {total_order_qty} > {order_bounds['max']}"
        )

    allow_null_kpis = bool(exp.get("kpi_allow_null", False))
    kpis = result.get("kpis") or {}
    for key, bounds in (exp.get("kpi_bounds") or {}).items():
        value = kpis.get(key)
        if value is None:
            assert allow_null_kpis, f"kpi {key} unexpectedly null"
            continue
        if "min" in bounds:
            assert value + 1e-9 >= float(bounds["min"]), f"kpi {key} below min: {value} < {bounds['min']}"
        if "max" in bounds:
            assert value <= float(bounds["max"]) + 1e-9, f"kpi {key} above max: {value} > {bounds['max']}"

    reasons_any_substrings = [str(item).lower() for item in (exp.get("reasons_any_substrings") or [])]
    if reasons_any_substrings:
        reasons_blob = "\n".join(str(reason) for reason in (result.get("infeasible_reasons") or [])).lower()
        assert any(text in reasons_blob for text in reasons_any_substrings), (
            f"none of expected reason substrings found: {reasons_any_substrings}"
        )

    required_constraints = set(exp.get("proof_constraints_required") or [])
    if required_constraints:
        actual_constraints = {
            str(item.get("name") or "")
            for item in (result.get("proof") or {}).get("constraints_checked", [])
            if isinstance(item, dict)
        }
        missing = sorted(required_constraints - actual_constraints)
        assert not missing, f"proof.constraints_checked missing: {missing}"

    if "bottlenecks_total_rows_max" in exp:
        bottlenecks = result.get("bottlenecks") or {}
        total_rows = int(_to_float(bottlenecks.get("total_rows"), 0.0))
        assert total_rows <= int(exp["bottlenecks_total_rows_max"]), (
            f"bottlenecks.total_rows too high: {total_rows}"
        )


def canonicalize_for_determinism(result: Dict[str, Any]) -> Dict[str, Any]:
    normalized = copy.deepcopy(result)

    solver_meta = normalized.get("solver_meta") or {}
    if isinstance(solver_meta, dict):
        solver_meta["solve_time_ms"] = 0

    if isinstance(normalized.get("infeasible_reasons"), list):
        normalized["infeasible_reasons"] = sorted(str(item) for item in normalized["infeasible_reasons"])

    plan_rows = _get_plan_rows(normalized)
    plan_rows = sorted(
        plan_rows,
        key=lambda row: (
            str(row.get("sku") or ""),
            str(row.get("plant_id") or ""),
            str(row.get("order_date") or ""),
            str(row.get("arrival_date") or ""),
            f"{_to_float(row.get('order_qty'), 0.0):.9f}",
        ),
    )
    normalized["plan_lines"] = plan_rows
    normalized["plan"] = copy.deepcopy(plan_rows)

    component_plan = normalized.get("component_plan")
    if isinstance(component_plan, list):
        normalized["component_plan"] = sorted(
            component_plan,
            key=lambda row: (
                str(row.get("component_sku") or ""),
                str(row.get("plant_id") or ""),
                str(row.get("order_date") or ""),
                str(row.get("arrival_date") or ""),
                f"{_to_float(row.get('order_qty'), 0.0):.9f}",
            ),
        )

    proof = normalized.get("proof") or {}
    if isinstance(proof.get("constraints_checked"), list):
        proof["constraints_checked"] = sorted(
            proof["constraints_checked"],
            key=lambda row: (
                str((row or {}).get("name") or ""),
                str((row or {}).get("details") or ""),
            ),
        )

    bottlenecks = normalized.get("bottlenecks")
    if isinstance(bottlenecks, dict) and "generated_at" in bottlenecks:
        bottlenecks["generated_at"] = "__normalized_timestamp__"

    return normalized
