"""Solver engine adapters and centralized engine selection policy."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Dict, Mapping, Optional, Protocol, Sequence, Tuple

from ml.governance import GovernanceStore
from ml.api.planning_contract import (
    PlanningStatus,
    build_contract_error_response,
    finalize_planning_response,
    normalize_status,
)
from ml.api.replenishment_heuristic import solve_replenishment_heuristic
from ml.api.replenishment_solver import (
    ortools_available,
    solve_replenishment,
    solve_replenishment_multi_echelon,
)
from ml.api.solver_availability import cplex_available, gurobi_available


class SolverErrorCode(str, Enum):
    ENGINE_NOT_ALLOWED = "ENGINE_NOT_ALLOWED"
    ENGINE_UNAVAILABLE = "ENGINE_UNAVAILABLE"
    ENGINE_NOT_REGISTERED = "ENGINE_NOT_REGISTERED"
    ENGINE_NOT_IMPLEMENTED = "ENGINE_NOT_IMPLEMENTED"
    ENGINE_RUNTIME_ERROR = "ENGINE_RUNTIME_ERROR"
    INVALID_ENGINE_REQUEST = "INVALID_ENGINE_REQUEST"


class SolverEngineError(RuntimeError):
    """Structured solver adapter exception with taxonomy code."""

    def __init__(
        self,
        code: SolverErrorCode,
        message: str,
        *,
        engine: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.engine = engine
        self.details = details or {}


class ISolverEngine(Protocol):
    key: str

    def solve(
        self,
        planning_contract: Any,
        *,
        cancel_check: Optional[Callable[[], bool]] = None,
    ) -> Dict[str, Any]:
        """Run the engine against planning contract payload and return planning result."""


@dataclass(frozen=True)
class EngineSelection:
    environment: str
    requested_engine: Optional[str]
    selected_engine: str
    source: str
    allowlist: Tuple[str, ...]
    notes: Tuple[str, ...] = ()


_ENGINE_KEY_TO_META_ENGINE = {
    "heuristic": "heuristic",
    "ortools": "cp_sat",
    "gurobi": "gurobi",
    "cplex": "cplex",
    "commercial_stub": "commercial_stub",
}

_ENGINE_KEY_TO_SOLVER_NAME = {
    "heuristic": "heuristic",
    "ortools": "cp_sat",
    "gurobi": "gurobi_milp",
    "cplex": "cplex_milp",
    "commercial_stub": "commercial_stub",
}

_STATUS_TO_TERMINATION_REASON = {
    PlanningStatus.OPTIMAL.value: "OPTIMAL",
    PlanningStatus.FEASIBLE.value: "FEASIBLE",
    PlanningStatus.INFEASIBLE.value: "INFEASIBLE",
    PlanningStatus.TIMEOUT.value: "TIMEOUT",
    PlanningStatus.ERROR.value: "ERROR",
}

# Keep solver_meta keys parity-stable across engines.
_CANONICAL_SOLVER_META_DEFAULTS = {
    "cp_status_name": "N/A",
    "objective_value": None,
    "best_bound": None,
    "gap": None,
    "time_limit_seconds": 0.0,
    "max_time_in_seconds": 0.0,
    "random_seed": 0,
    "num_search_workers": 1,
    "log_search_progress": False,
    "deterministic_mode": True,
    "force_timeout_requested": False,
    "time_limit_hit": False,
}

_COMMERCIAL_ENGINE_KEYS = frozenset({"gurobi", "cplex", "commercial_stub"})

_DEFAULT_ALLOWLISTS = {
    "prod": ("heuristic", "ortools"),
    "staging": ("heuristic", "ortools", "gurobi", "cplex", "commercial_stub"),
    "test": ("heuristic", "ortools", "gurobi", "cplex", "commercial_stub"),
    "dev": ("heuristic", "ortools", "gurobi", "cplex", "commercial_stub"),
}

_governance_store: Optional[GovernanceStore] = None


def _get_governance_store() -> GovernanceStore:
    global _governance_store
    if _governance_store is None:
        _governance_store = GovernanceStore()
    return _governance_store


def _read_attr(obj: Any, name: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _read_path(obj: Any, path: str, default: Any = None) -> Any:
    cur = obj
    for part in path.split("."):
        cur = _read_attr(cur, part, None)
        if cur is None:
            return default
    return cur


def _first_non_none(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def _to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _to_float(value: Any, default: float = 0.0, minimum: float = 0.0) -> float:
    try:
        parsed = float(value)
    except Exception:
        return max(minimum, float(default))
    if parsed < minimum:
        return minimum
    return parsed


def _to_int(value: Any, default: int = 0, minimum: int = 0) -> int:
    try:
        parsed = int(value)
    except Exception:
        return max(minimum, int(default))
    return max(minimum, parsed)


def _to_text_engine(value: Any) -> Optional[str]:
    text = str(value or "").strip().lower()
    return text or None


def _normalize_environment(value: Optional[str]) -> str:
    raw = str(value or "").strip().lower()
    if raw in {"production", "prod", "live"}:
        return "prod"
    if raw in {"staging", "stage", "preprod", "uat"}:
        return "staging"
    if raw in {"test", "testing", "ci", "qa"}:
        return "test"
    if raw in {"", "dev", "development", "local"}:
        return "dev"
    return raw


def resolve_runtime_environment(explicit_env: Optional[str] = None) -> str:
    if explicit_env:
        return _normalize_environment(explicit_env)
    return _normalize_environment(
        _first_non_none(
            os.getenv("DI_RUNTIME_ENV"),
            os.getenv("DI_ENV"),
            os.getenv("APP_ENV"),
            os.getenv("ENVIRONMENT"),
            os.getenv("NODE_ENV"),
            "dev",
        )
    )


def _parse_allowlist(raw_value: Optional[str]) -> Tuple[str, ...]:
    if not raw_value:
        return ()
    parts = [str(part).strip().lower() for part in str(raw_value).split(",")]
    values = sorted({part for part in parts if part})
    return tuple(values)


def _env_var_suffix(environment: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "_", str(environment).upper())


def resolve_engine_allowlist(environment: Optional[str] = None) -> Tuple[str, ...]:
    env_name = resolve_runtime_environment(environment)
    defaults = set(_DEFAULT_ALLOWLISTS.get(env_name, _DEFAULT_ALLOWLISTS["dev"]))

    global_override = _parse_allowlist(os.getenv("DI_SOLVER_ENGINE_ALLOWLIST"))
    if global_override:
        defaults = set(global_override)

    env_override_var = f"DI_SOLVER_ENGINE_ALLOWLIST_{_env_var_suffix(env_name)}"
    env_override = _parse_allowlist(os.getenv(env_override_var))
    if env_override:
        defaults = set(env_override)

    if env_name == "prod" and not _to_bool(os.getenv("DI_ENABLE_COMMERCIAL_SOLVERS"), False):
        defaults = {engine for engine in defaults if engine not in _COMMERCIAL_ENGINE_KEYS}

    if not defaults:
        defaults = {"heuristic"}

    return tuple(sorted(defaults))


def resolve_default_engine() -> str:
    fallback = _to_text_engine(os.getenv("DI_SOLVER_ENGINE", "heuristic")) or "heuristic"
    try:
        runtime_state = _get_governance_store().get_runtime_state()
    except Exception:
        return fallback
    governed = _to_text_engine((runtime_state or {}).get("solver_engine"))
    if governed == "cp_sat":
        governed = "ortools"
    if governed == "gurobi_milp":
        governed = "gurobi"
    if governed == "cplex_milp":
        governed = "cplex"
    return governed or fallback


def _resolve_requested_engine(planning_contract: Any) -> Optional[str]:
    return _to_text_engine(
        _first_non_none(
            _read_path(planning_contract, "engine_flags.solver_engine", None),
            _read_path(planning_contract, "settings.solver.engine", None),
            _read_path(planning_contract, "solver.engine", None),
        )
    )


def _request_override_enabled(planning_contract: Any) -> bool:
    global_flag = _to_bool(os.getenv("DI_SOLVER_ENGINE_OVERRIDE_ENABLED"), False)
    request_flag = _to_bool(
        _first_non_none(
            _read_path(planning_contract, "engine_flags.enable_solver_engine_override", None),
            _read_path(planning_contract, "settings.feature_flags.enable_solver_engine_override", None),
        ),
        False,
    )
    return bool(global_flag and request_flag)


def _is_multi_echelon_request(planning_contract: Any) -> bool:
    mode = str(_read_path(planning_contract, "multi_echelon.mode", "") or "").strip().lower()
    return mode == "bom_v0"


def _default_meta_engine_for(engine_key: str) -> str:
    return _ENGINE_KEY_TO_META_ENGINE.get(engine_key, engine_key)


def _default_solver_name_for(engine_key: str) -> str:
    return _ENGINE_KEY_TO_SOLVER_NAME.get(engine_key, engine_key)


def _first_available_engine(allowlist: Sequence[str]) -> Optional[str]:
    for engine in allowlist:
        if is_solver_engine_available(engine):
            return engine
    return None


def _normalize_engine_payload(
    payload: Dict[str, Any],
    *,
    engine_key: str,
) -> Dict[str, Any]:
    default_engine = _default_meta_engine_for(engine_key)
    normalized = finalize_planning_response(
        payload if isinstance(payload, dict) else {},
        default_engine=default_engine,
        default_status=PlanningStatus.ERROR,
    )
    status = normalize_status(normalized.get("status"), PlanningStatus.ERROR).value
    solver_meta = dict(normalized.get("solver_meta") or {})
    solver_meta.setdefault("engine", default_engine)
    solver_meta.setdefault("solver", _default_solver_name_for(engine_key))
    solver_meta["status"] = status
    solver_meta.setdefault("termination_reason", _STATUS_TO_TERMINATION_REASON.get(status, "ERROR"))
    solver_meta["time_limit"] = _to_float(solver_meta.get("time_limit"), 0.0, minimum=0.0)
    solver_meta["seed"] = _to_int(solver_meta.get("seed"), 0, minimum=0)
    solver_meta["workers"] = _to_int(solver_meta.get("workers"), 1, minimum=1)
    solver_meta["solve_time_ms"] = _to_int(solver_meta.get("solve_time_ms"), 0, minimum=0)

    # Canonical contract-level compatibility fields.
    solver_meta.setdefault("time_limit_seconds", float(solver_meta["time_limit"]))
    solver_meta.setdefault("max_time_in_seconds", float(solver_meta["time_limit"]))
    solver_meta.setdefault("random_seed", int(solver_meta["seed"]))
    solver_meta.setdefault("num_search_workers", int(solver_meta["workers"]))
    for key, value in _CANONICAL_SOLVER_META_DEFAULTS.items():
        solver_meta.setdefault(key, value)

    normalized["solver_meta"] = solver_meta
    # Preserve additive legacy key used by existing consumers/tests.
    if "infeasible_reasons_detailed" not in normalized:
        details = normalized.get("infeasible_reason_details")
        normalized["infeasible_reasons_detailed"] = details if isinstance(details, list) else []

    # Phase 4.3: Ensure proof has explain parity fields for all engines.
    proof = normalized.get("proof")
    if isinstance(proof, dict):
        proof.setdefault("shadow_prices", [])
        proof.setdefault("binding_constraints", [])
        proof.setdefault("explain_summary", "")

    # Ensure top-level explain parity fields exist across engines.
    normalized.setdefault("binding_constraints", [])
    normalized.setdefault("shadow_prices", None)
    normalized.setdefault("relaxation_applied", None)

    return normalized


def _attach_selection_meta(payload: Dict[str, Any], selection: EngineSelection) -> Dict[str, Any]:
    solver_meta = dict(payload.get("solver_meta") or {})
    solver_meta["engine_key"] = selection.selected_engine
    solver_meta["engine_selected"] = selection.selected_engine
    solver_meta["engine_requested"] = selection.requested_engine
    solver_meta["engine_source"] = selection.source
    solver_meta["engine_environment"] = selection.environment
    solver_meta["engine_allowlist"] = list(selection.allowlist)
    solver_meta["engine_selection_notes"] = list(selection.notes)
    payload["solver_meta"] = solver_meta
    return payload


def _build_engine_error_payload(
    error: SolverEngineError,
    *,
    selection: EngineSelection,
) -> Dict[str, Any]:
    payload = build_contract_error_response(
        engine=_default_meta_engine_for(selection.selected_engine),
        reason=str(error),
        termination_reason=error.code.value,
    )
    payload = _normalize_engine_payload(payload, engine_key=selection.selected_engine)
    solver_meta = dict(payload.get("solver_meta") or {})
    solver_meta["error_code"] = error.code.value
    solver_meta["error_engine"] = error.engine
    solver_meta["error_details"] = dict(error.details or {})
    payload["solver_meta"] = solver_meta
    return _attach_selection_meta(payload, selection)


class HeuristicEngine:
    key = "heuristic"

    def solve(
        self,
        planning_contract: Any,
        *,
        cancel_check: Optional[Callable[[], bool]] = None,
    ) -> Dict[str, Any]:
        if callable(cancel_check) and cancel_check():
            return _normalize_engine_payload(
                {
                    "status": PlanningStatus.TIMEOUT.value,
                    "plan_lines": [],
                    "infeasible_reasons": ["Planning canceled before heuristic solve started."],
                    "proof": {"objective_terms": [], "constraints_checked": []},
                    "solver_meta": {
                        "termination_reason": "CANCELLED",
                        "time_limit_hit": True,
                    },
                },
                engine_key=self.key,
            )

        try:
            result = solve_replenishment_heuristic(planning_contract)
        except Exception as exc:  # pragma: no cover - defensive adapter guard
            raise SolverEngineError(
                SolverErrorCode.ENGINE_RUNTIME_ERROR,
                f"Heuristic engine failed: {exc}",
                engine=self.key,
            ) from exc

        if _is_multi_echelon_request(planning_contract):
            result = dict(result or {})
            result.setdefault("component_plan", [])
            result.setdefault("component_inventory_projection", {"total_rows": 0, "rows": [], "truncated": False})
            result.setdefault("bottlenecks", {"generated_at": None, "total_rows": 0, "rows": [], "items": []})
            solver_meta = dict(result.get("solver_meta") or {})
            solver_meta.setdefault(
                "fallback_reason",
                "Heuristic adapter does not run BOM MILP; returned single-echelon fallback.",
            )
            solver_meta.setdefault("multi_echelon_mode", "bom_v0")
            result["solver_meta"] = solver_meta

        return _normalize_engine_payload(result, engine_key=self.key)


class ORToolsEngine:
    key = "ortools"

    def solve(
        self,
        planning_contract: Any,
        *,
        cancel_check: Optional[Callable[[], bool]] = None,
    ) -> Dict[str, Any]:
        if not ortools_available():
            raise SolverEngineError(
                SolverErrorCode.ENGINE_UNAVAILABLE,
                "OR-Tools is not installed; cannot use ortools engine.",
                engine=self.key,
            )

        try:
            if _is_multi_echelon_request(planning_contract):
                result = solve_replenishment_multi_echelon(planning_contract, cancel_check=cancel_check)
            else:
                result = solve_replenishment(planning_contract, cancel_check=cancel_check)
        except Exception as exc:
            raise SolverEngineError(
                SolverErrorCode.ENGINE_RUNTIME_ERROR,
                f"OR-Tools solve failed: {exc}",
                engine=self.key,
            ) from exc

        return _normalize_engine_payload(result, engine_key=self.key)


class CommercialEngineStub:
    key = "commercial_stub"

    def solve(
        self,
        planning_contract: Any,
        *,
        cancel_check: Optional[Callable[[], bool]] = None,
    ) -> Dict[str, Any]:
        payload = build_contract_error_response(
            engine=_default_meta_engine_for(self.key),
            reason="Commercial solver adapter is a stub. Integrate Gurobi/CPLEX plugin to enable.",
            termination_reason=SolverErrorCode.ENGINE_NOT_IMPLEMENTED.value,
        )
        return _normalize_engine_payload(payload, engine_key=self.key)


class GurobiEngine:
    key = "gurobi"

    def solve(
        self,
        planning_contract: Any,
        *,
        cancel_check: Optional[Callable[[], bool]] = None,
    ) -> Dict[str, Any]:
        if not gurobi_available():
            raise SolverEngineError(
                SolverErrorCode.ENGINE_UNAVAILABLE,
                "Gurobi is not installed or no valid license found; cannot use gurobi engine.",
                engine=self.key,
            )

        from ml.api.replenishment_solver_gurobi import (
            solve_replenishment_gurobi,
            solve_replenishment_multi_echelon_gurobi,
        )

        try:
            if _is_multi_echelon_request(planning_contract):
                result = solve_replenishment_multi_echelon_gurobi(
                    planning_contract, cancel_check=cancel_check
                )
            else:
                result = solve_replenishment_gurobi(
                    planning_contract, cancel_check=cancel_check
                )
        except Exception as exc:
            raise SolverEngineError(
                SolverErrorCode.ENGINE_RUNTIME_ERROR,
                f"Gurobi solve failed: {exc}",
                engine=self.key,
            ) from exc

        return _normalize_engine_payload(result, engine_key=self.key)


class CplexEngine:
    key = "cplex"

    def solve(
        self,
        planning_contract: Any,
        *,
        cancel_check: Optional[Callable[[], bool]] = None,
    ) -> Dict[str, Any]:
        if not cplex_available():
            raise SolverEngineError(
                SolverErrorCode.ENGINE_UNAVAILABLE,
                "CPLEX (docplex) is not installed or engine is not usable; cannot use cplex engine.",
                engine=self.key,
            )

        from ml.api.replenishment_solver_cplex import (
            solve_replenishment_cplex,
            solve_replenishment_multi_echelon_cplex,
        )

        try:
            if _is_multi_echelon_request(planning_contract):
                result = solve_replenishment_multi_echelon_cplex(
                    planning_contract, cancel_check=cancel_check
                )
            else:
                result = solve_replenishment_cplex(
                    planning_contract, cancel_check=cancel_check
                )
        except Exception as exc:
            raise SolverEngineError(
                SolverErrorCode.ENGINE_RUNTIME_ERROR,
                f"CPLEX solve failed: {exc}",
                engine=self.key,
            ) from exc

        return _normalize_engine_payload(result, engine_key=self.key)


ENGINE_REGISTRY: Dict[str, ISolverEngine] = {
    "ortools": ORToolsEngine(),
    "heuristic": HeuristicEngine(),
    "gurobi": GurobiEngine(),
    "cplex": CplexEngine(),
    "commercial_stub": CommercialEngineStub(),
}


def get_solver_engine_registry() -> Dict[str, ISolverEngine]:
    return dict(ENGINE_REGISTRY)


def is_solver_engine_available(engine_key: str) -> bool:
    normalized = _to_text_engine(engine_key)
    if normalized == "ortools":
        return bool(ortools_available())
    if normalized == "gurobi":
        return bool(gurobi_available())
    if normalized == "cplex":
        return bool(cplex_available())
    return normalized in ENGINE_REGISTRY


def select_solver_engine(
    planning_contract: Any,
    *,
    environment: Optional[str] = None,
    registry: Optional[Mapping[str, ISolverEngine]] = None,
) -> EngineSelection:
    registry_map = dict(registry or ENGINE_REGISTRY)
    runtime_env = resolve_runtime_environment(environment)
    configured_allowlist = resolve_engine_allowlist(runtime_env)
    allowlist = tuple(engine for engine in configured_allowlist if engine in registry_map)
    if not allowlist:
        allowlist = tuple(sorted(registry_map.keys()))

    requested_engine = _resolve_requested_engine(planning_contract)
    default_engine = resolve_default_engine()
    notes = []

    if default_engine not in registry_map:
        notes.append(
            f"Configured default engine '{default_engine}' is not registered; falling back to 'heuristic'."
        )
        default_engine = "heuristic" if "heuristic" in registry_map else next(iter(registry_map.keys()))

    selected_engine = default_engine
    source = "env"

    if requested_engine:
        if _request_override_enabled(planning_contract):
            selected_engine = requested_engine
            source = "feature_flag"
        else:
            notes.append(
                "Requested request-level engine override ignored; feature flag DI_SOLVER_ENGINE_OVERRIDE_ENABLED=false "
                "or request flag enable_solver_engine_override=false."
            )

    if selected_engine not in registry_map:
        notes.append(f"Requested engine '{selected_engine}' is not registered.")
        selected_engine = default_engine
        source = "fallback_default"

    if selected_engine not in allowlist:
        notes.append(
            f"Engine '{selected_engine}' is not allowed in environment '{runtime_env}'. Applying allowlist fallback."
        )
        if default_engine in allowlist:
            selected_engine = default_engine
        elif "heuristic" in allowlist:
            selected_engine = "heuristic"
        else:
            selected_engine = allowlist[0]
        source = "allowlist_fallback"

    if not is_solver_engine_available(selected_engine):
        fallback = _first_available_engine(allowlist)
        notes.append(f"Engine '{selected_engine}' is unavailable in runtime.")
        if fallback is not None:
            selected_engine = fallback
            source = "availability_fallback"
            notes.append(f"Fell back to available engine '{fallback}'.")
        else:
            notes.append("No available engine in allowlist; keeping current selection for error response.")

    return EngineSelection(
        environment=runtime_env,
        requested_engine=requested_engine,
        selected_engine=selected_engine,
        source=source,
        allowlist=allowlist,
        notes=tuple(notes),
    )


def _execute_engine(
    engine_key: str,
    *,
    planning_contract: Any,
    cancel_check: Optional[Callable[[], bool]],
    selection: EngineSelection,
    registry: Mapping[str, ISolverEngine],
    strict: bool,
) -> Dict[str, Any]:
    engine = registry.get(engine_key)
    if engine is None:
        err = SolverEngineError(
            SolverErrorCode.ENGINE_NOT_REGISTERED,
            f"Solver engine '{engine_key}' is not registered.",
            engine=engine_key,
        )
        if strict:
            raise err
        return _build_engine_error_payload(err, selection=selection)

    try:
        result = engine.solve(planning_contract, cancel_check=cancel_check)
    except SolverEngineError as err:
        if strict:
            raise
        return _build_engine_error_payload(err, selection=selection)
    except Exception as exc:  # pragma: no cover - defensive catch
        err = SolverEngineError(
            SolverErrorCode.ENGINE_RUNTIME_ERROR,
            f"Unhandled adapter runtime error in '{engine_key}': {exc}",
            engine=engine_key,
        )
        if strict:
            raise err from exc
        return _build_engine_error_payload(err, selection=selection)

    normalized = _normalize_engine_payload(result, engine_key=engine_key)
    return _attach_selection_meta(normalized, selection)


def solve_with_engine(
    engine_key: str,
    planning_contract: Any,
    *,
    cancel_check: Optional[Callable[[], bool]] = None,
    strict: bool = False,
    environment: Optional[str] = None,
    registry: Optional[Mapping[str, ISolverEngine]] = None,
) -> Dict[str, Any]:
    registry_map = dict(registry or ENGINE_REGISTRY)
    normalized_key = _to_text_engine(engine_key) or ""
    selection = EngineSelection(
        environment=resolve_runtime_environment(environment),
        requested_engine=normalized_key or None,
        selected_engine=normalized_key or "",
        source="direct",
        allowlist=tuple(sorted(registry_map.keys())),
        notes=(),
    )
    return _execute_engine(
        normalized_key,
        planning_contract=planning_contract,
        cancel_check=cancel_check,
        selection=selection,
        registry=registry_map,
        strict=strict,
    )


def solve_planning_contract(
    planning_contract: Any,
    *,
    cancel_check: Optional[Callable[[], bool]] = None,
    strict: bool = False,
    environment: Optional[str] = None,
    registry: Optional[Mapping[str, ISolverEngine]] = None,
) -> Dict[str, Any]:
    registry_map = dict(registry or ENGINE_REGISTRY)
    selection = select_solver_engine(
        planning_contract,
        environment=environment,
        registry=registry_map,
    )
    return _execute_engine(
        selection.selected_engine,
        planning_contract=planning_contract,
        cancel_check=cancel_check,
        selection=selection,
        registry=registry_map,
        strict=strict,
    )
