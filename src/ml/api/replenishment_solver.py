"""
OR-Tools CP-SAT single-echelon replenishment MILP v0.

Decision variables per (SKU, plant, period t=0..T-1):
  order[t]  – int ≥ 0 : units ordered at day t (arrives at day t+lead_time)
  inv[t]    – int ≥ 0 : on-hand inventory at end of day t
  back[t]   – int ≥ 0 : backlog (unmet demand) at end of day t
  y[t]      – bool    : 1 if an order is placed on day t (MOQ enforcement)
  k[t]      – int ≥ 0 : pack-size multiple s.t. order[t] == k[t] × pack_size_s

Inventory balance (all quantities in integer SCALE units):
  inv[t] − back[t] = inv[t−1] − back[t−1]
                   + arriving_new[t]     # from order[t − lead_time]
                   + open_po[t]          # from pre-existing open POs
                   − demand[t]
  Initial: inv[-1]=on_hand, back[-1]=0

Hard constraints:
  order[t] ≥ moq × y[t]          (must order ≥ MOQ when placing an order)
  order[t] = 0  when y[t] = 0    (y[t] is a tight indicator)
  order[t] ≤ max_order_qty        (per-SKU cap, if set)
  order[t] = k[t] × pack_size_s  (pack-size multiple, if pack_size > 1)
  Σ_{s,t} order[s,t] ≤ budget_cap  (global budget coupling all SKUs)
  inv[t], back[t], order[t] ≥ 0

Objective (minimise):
  Σ_{s,t} [ order_s_t + stockout_penalty × back_s_t + holding_cost × inv_s_t ]
  (all divided by SCALE to convert integer → real cost)
"""
from __future__ import annotations

import copy
import math
import os
import threading
import time
from dataclasses import dataclass
from types import SimpleNamespace
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from ml.api.planning_contract import (
    PlanningStatus,
    finalize_planning_response,
    normalize_status,
)

try:
    from ortools.sat.python import cp_model as _cp_model

    _ORTOOLS_OK = True
except ImportError:
    _cp_model = None  # type: ignore[assignment]
    _ORTOOLS_OK = False

try:
    from ortools.linear_solver import pywraplp as _pywraplp

    _ORTOOLS_LINEAR_OK = True
except ImportError:
    _pywraplp = None  # type: ignore[assignment]
    _ORTOOLS_LINEAR_OK = False

# ── scaling constants ──────────────────────────────────────────────────────────
# All float quantities are multiplied by SCALE and rounded to integers for CP-SAT.
# 1 real unit = SCALE integer units  →  precision = 1/SCALE = 0.001 real units.
SCALE: int = 1_000

# Objective coefficients are also scaled (penalties may be floats like 2.5).
# true_cost ≈ integer_objective / (OBJ_SCALE * SCALE)
OBJ_SCALE: int = 1_000

MAX_SOLVER_SECONDS: float = 30.0
DIAGNOSE_SOLVER_SECONDS: float = 3.0
DEFAULT_SOLVER_RANDOM_SEED: int = int(os.getenv("DI_CP_SAT_RANDOM_SEED", "42"))
DEFAULT_SOLVER_NUM_SEARCH_WORKERS: int = max(1, int(os.getenv("DI_CP_SAT_NUM_SEARCH_WORKERS", "1")))
DEFAULT_SOLVER_LOG_PROGRESS: bool = str(os.getenv("DI_CP_SAT_LOG_PROGRESS", "false")).strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
DEFAULT_SOLVER_SINGLE_TIME_LIMIT_SECONDS: float = float(
    os.getenv("DI_CP_SAT_TIME_LIMIT_SECONDS", str(MAX_SOLVER_SECONDS))
)
DEFAULT_SOLVER_MULTI_TIME_LIMIT_SECONDS: float = float(
    os.getenv("DI_CP_SAT_MULTI_TIME_LIMIT_SECONDS", "25.0")
)


@dataclass(frozen=True)
class SolverRunSettings:
    """CP-SAT run policy: deterministic defaults with optional contract overrides."""

    time_limit_seconds: float
    random_seed: int
    num_search_workers: int
    log_search_progress: bool
    deterministic_mode: bool
    stop_after_first_solution: bool = False
    force_timeout: bool = False


@dataclass(frozen=True)
class SolverStatusInfo:
    status: PlanningStatus
    termination_reason: str
    status_name: str
    has_feasible_solution: bool
    time_limit_hit: bool


@dataclass(frozen=True)
class SupplierInfo:
    """V2: Per-supplier parameters for multi-supplier optimization."""
    supplier_id: str
    lead_time_days: int
    unit_cost: float
    moq_s: int        # scaled MOQ
    pack_s: int        # scaled pack size
    max_order_qty_s: int  # scaled max order qty
    fixed_order_cost: float


def _read_attr(obj: Any, name: str, default: Any = None) -> Any:
    """Read an attribute from object or dict with graceful fallback."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _as_list(value: Any) -> List[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


def _read_path(obj: Any, path: str, default: Any = None) -> Any:
    cur = obj
    for part in path.split("."):
        cur = _read_attr(cur, part, None)
        if cur is None:
            return default
    return cur


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


def _payload_to_plain(obj: Any) -> Any:
    if obj is None:
        return None
    if hasattr(obj, "model_dump"):
        try:
            return obj.model_dump(mode="json")
        except TypeError:
            return obj.model_dump()
    if isinstance(obj, dict):
        return {k: _payload_to_plain(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_payload_to_plain(v) for v in obj]
    if isinstance(obj, tuple):
        return [_payload_to_plain(v) for v in obj]
    if hasattr(obj, "__dict__"):
        return {k: _payload_to_plain(v) for k, v in vars(obj).items()}
    return obj


def _plain_to_ns(obj: Any) -> Any:
    if isinstance(obj, dict):
        return SimpleNamespace(**{k: _plain_to_ns(v) for k, v in obj.items()})
    if isinstance(obj, list):
        return [_plain_to_ns(v) for v in obj]
    return obj


def _clone_payload(payload: Any) -> Any:
    if hasattr(payload, "model_copy"):
        try:
            return payload.model_copy(deep=True)
        except TypeError:
            pass
    return copy.deepcopy(payload)


def _set_path(obj: Any, path: str, value: Any) -> None:
    parts = path.split(".")
    cur = obj
    for part in parts[:-1]:
        nxt = _read_attr(cur, part, None)
        if nxt is None:
            nxt = {} if isinstance(cur, dict) else SimpleNamespace()
            if isinstance(cur, dict):
                cur[part] = nxt
            else:
                setattr(cur, part, nxt)
        cur = nxt
    last = parts[-1]
    if isinstance(cur, dict):
        cur[last] = value
    else:
        setattr(cur, last, value)


def _first_non_none(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def _as_dict(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    plain = _payload_to_plain(value)
    return plain if isinstance(plain, dict) else {}


def _resolve_solver_run_settings(payload: Any, default_time_limit_seconds: float) -> SolverRunSettings:
    """
    Resolve centralized CP-SAT policy from defaults + request overrides.
    Supported override paths:
      - settings.solver.{time_limit_seconds|max_time_in_seconds, random_seed, num_search_workers, log_search_progress}
      - engine_flags.{time_limit_seconds, random_seed, num_search_workers, log_search_progress}
      - internal _solver_time_limit_seconds (diagnostic path)
    """
    solver_cfg = _as_dict(_read_path(payload, "settings.solver", {}))
    direct_solver_cfg = _as_dict(_read_attr(payload, "solver", {}))
    engine_flags = _as_dict(_read_attr(payload, "engine_flags", {}))

    time_limit_raw = _first_non_none(
        _read_attr(payload, "_solver_time_limit_seconds", None),
        direct_solver_cfg.get("time_limit_seconds"),
        direct_solver_cfg.get("time_limit"),
        direct_solver_cfg.get("max_time_in_seconds"),
        solver_cfg.get("time_limit_seconds"),
        solver_cfg.get("max_time_in_seconds"),
        engine_flags.get("time_limit_seconds"),
        engine_flags.get("max_time_in_seconds"),
        default_time_limit_seconds,
    )
    time_limit_seconds = max(0.01, _to_float(time_limit_raw, default_time_limit_seconds))

    random_seed_raw = _first_non_none(
        direct_solver_cfg.get("random_seed"),
        direct_solver_cfg.get("seed"),
        solver_cfg.get("random_seed"),
        engine_flags.get("random_seed"),
        DEFAULT_SOLVER_RANDOM_SEED,
    )
    try:
        random_seed = int(random_seed_raw)
    except Exception:
        random_seed = DEFAULT_SOLVER_RANDOM_SEED

    num_workers_raw = _first_non_none(
        direct_solver_cfg.get("num_search_workers"),
        direct_solver_cfg.get("workers"),
        solver_cfg.get("num_search_workers"),
        engine_flags.get("num_search_workers"),
        DEFAULT_SOLVER_NUM_SEARCH_WORKERS,
    )
    try:
        num_search_workers = max(1, int(num_workers_raw))
    except Exception:
        num_search_workers = DEFAULT_SOLVER_NUM_SEARCH_WORKERS

    log_progress = _to_bool(
        _first_non_none(
            direct_solver_cfg.get("log_search_progress"),
            solver_cfg.get("log_search_progress"),
            engine_flags.get("log_search_progress"),
            DEFAULT_SOLVER_LOG_PROGRESS,
        ),
        DEFAULT_SOLVER_LOG_PROGRESS,
    )

    deterministic_mode_raw = _first_non_none(
        direct_solver_cfg.get("deterministic_mode"),
        direct_solver_cfg.get("deterministic"),
        solver_cfg.get("deterministic_mode"),
        solver_cfg.get("deterministic"),
        engine_flags.get("deterministic_mode"),
        engine_flags.get("deterministic"),
        None,
    )
    deterministic_mode = (
        _to_bool(deterministic_mode_raw, True)
        if deterministic_mode_raw is not None
        else num_search_workers == 1
    )
    if deterministic_mode:
        num_search_workers = 1

    stop_after_first_solution = _to_bool(
        _first_non_none(
            direct_solver_cfg.get("stop_after_first_solution"),
            solver_cfg.get("stop_after_first_solution"),
            engine_flags.get("stop_after_first_solution"),
            False,
        ),
        False,
    )
    force_timeout = _to_bool(
        _first_non_none(
            _read_attr(payload, "_solver_force_timeout", None),
            direct_solver_cfg.get("force_timeout"),
            solver_cfg.get("force_timeout"),
            engine_flags.get("force_timeout"),
            False,
        ),
        False,
    )

    return SolverRunSettings(
        time_limit_seconds=float(time_limit_seconds),
        random_seed=int(random_seed),
        num_search_workers=int(num_search_workers),
        log_search_progress=bool(log_progress),
        deterministic_mode=bool(deterministic_mode),
        stop_after_first_solution=bool(stop_after_first_solution),
        force_timeout=bool(force_timeout),
    )


def _apply_solver_run_settings(solver: Any, settings: SolverRunSettings) -> None:
    solver.parameters.max_time_in_seconds = float(settings.time_limit_seconds)
    solver.parameters.random_seed = int(settings.random_seed)
    solver.parameters.num_search_workers = int(settings.num_search_workers)
    solver.parameters.log_search_progress = bool(settings.log_search_progress)
    if settings.stop_after_first_solution:
        # Optional test/diagnostic mode: return a first feasible incumbent quickly.
        solver.parameters.stop_after_first_solution = True


def _solve_with_cancel_support(
    solver: Any,
    model: Any,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Tuple[int, bool]:
    if cancel_check is None:
        return solver.Solve(model), False

    stop_signal = threading.Event()
    stop_requested = {"value": False}

    def _watch_cancel() -> None:
        while not stop_signal.is_set():
            should_cancel = False
            try:
                should_cancel = bool(cancel_check())
            except Exception:
                should_cancel = False
            if should_cancel:
                stop_requested["value"] = True
                try:
                    solver.StopSearch()
                except Exception:
                    pass
                return
            time.sleep(0.05)

    watcher = threading.Thread(target=_watch_cancel, daemon=True)
    watcher.start()
    try:
        return solver.Solve(model), bool(stop_requested["value"])
    finally:
        stop_signal.set()
        watcher.join(timeout=0.2)


def _did_time_limit_hit(solver: Any, settings: SolverRunSettings, solve_time_ms: int) -> bool:
    limit_ms = int(round(float(settings.time_limit_seconds) * 1000))
    if limit_ms <= 0:
        return False
    wall_time_ms = 0
    try:
        wall_time_ms = int(round(float(solver.WallTime()) * 1000))
    except Exception:
        wall_time_ms = 0
    observed_ms = max(int(solve_time_ms or 0), wall_time_ms)
    return observed_ms >= max(0, limit_ms - 20)


def _status_from_cp(
    cp_status: int,
    solver: Any,
    settings: SolverRunSettings,
    solve_time_ms: int,
    *,
    stop_requested: bool = False,
) -> SolverStatusInfo:
    status_name = solver.StatusName(cp_status)
    time_limit_hit = _did_time_limit_hit(solver, settings, solve_time_ms)

    if cp_status == _cp_model.OPTIMAL:
        return SolverStatusInfo(
            status=PlanningStatus.OPTIMAL,
            termination_reason="OPTIMAL",
            status_name=status_name,
            has_feasible_solution=True,
            time_limit_hit=False,
        )

    if cp_status == _cp_model.FEASIBLE:
        status = PlanningStatus.TIMEOUT if time_limit_hit else PlanningStatus.FEASIBLE
        termination_reason = "TIME_LIMIT_FEASIBLE" if time_limit_hit else "FEASIBLE"
        if stop_requested:
            status = PlanningStatus.TIMEOUT
            termination_reason = "CANCELLED"
        return SolverStatusInfo(
            status=status,
            termination_reason=termination_reason,
            status_name=status_name,
            has_feasible_solution=True,
            time_limit_hit=time_limit_hit,
        )

    if cp_status == _cp_model.INFEASIBLE:
        return SolverStatusInfo(
            status=PlanningStatus.INFEASIBLE,
            termination_reason="INFEASIBLE",
            status_name=status_name,
            has_feasible_solution=False,
            time_limit_hit=False,
        )

    if cp_status == _cp_model.UNKNOWN:
        if stop_requested:
            return SolverStatusInfo(
                status=PlanningStatus.TIMEOUT,
                termination_reason="CANCELLED",
                status_name=status_name,
                has_feasible_solution=False,
                time_limit_hit=False,
            )
        if time_limit_hit:
            return SolverStatusInfo(
                status=PlanningStatus.TIMEOUT,
                termination_reason="TIME_LIMIT_NO_FEASIBLE",
                status_name=status_name,
                has_feasible_solution=False,
                time_limit_hit=True,
            )
        return SolverStatusInfo(
            status=PlanningStatus.ERROR,
            termination_reason="UNKNOWN",
            status_name=status_name,
            has_feasible_solution=False,
            time_limit_hit=False,
        )

    return SolverStatusInfo(
        status=PlanningStatus.ERROR,
        termination_reason=status_name or "ERROR",
        status_name=status_name,
        has_feasible_solution=False,
        time_limit_hit=False,
    )


def _capacity_for_period(raw: Any, idx: int, day: date) -> Optional[float]:
    """
    Resolve per-period capacity from scalar/list/dict inputs.
    Accepted forms:
      scalar -> same capacity every period
      [v0, v1, ...] -> by period index (tail value repeated)
      {"YYYY-MM-DD": v, "default": v0} or {"0": v, ...}
    """
    if raw is None:
        return None

    if isinstance(raw, (int, float, str)):
        val = _to_float(raw, -1.0)
        return None if val < 0.0 else val

    if isinstance(raw, (list, tuple)):
        if not raw:
            return None
        pick = raw[idx] if idx < len(raw) else raw[-1]
        val = _to_float(pick, -1.0)
        return None if val < 0.0 else val

    if isinstance(raw, dict):
        day_key = day.isoformat()
        if day_key in raw:
            val = _to_float(raw.get(day_key), -1.0)
            return None if val < 0.0 else val
        if idx in raw:
            val = _to_float(raw.get(idx), -1.0)
            return None if val < 0.0 else val
        idx_key = str(idx)
        if idx_key in raw:
            val = _to_float(raw.get(idx_key), -1.0)
            return None if val < 0.0 else val
        if "default" in raw:
            val = _to_float(raw.get("default"), -1.0)
            return None if val < 0.0 else val
    return None


def _mk_constraint_check(
    *,
    name: str,
    tag: str,
    passed: bool,
    details: str,
    description: str,
    severity: str = "hard",
    scope: str = "global",
    period: Optional[str] = None,
    sku: Optional[str] = None,
    echelon: str = "single",
    tags: Optional[List[str]] = None,
    binding: Optional[bool] = None,
    slack: Optional[float] = None,
    slack_unit: Optional[str] = None,
    shadow_price_approx: Optional[float] = None,
    shadow_price_dual: Optional[float] = None,
    shadow_price_unit: Optional[str] = None,
    shadow_price_method: Optional[str] = None,
    natural_language: Optional[str] = None,
) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "name": name,
        "tag": tag,
        "tags": [str(item) for item in (tags or []) if str(item).strip()],
        "passed": bool(passed),
        "details": details,
        "description": description,
        "severity": severity,
        "scope": scope,
        "period": period,
        "sku": sku,
        "echelon": echelon,
    }
    if binding is not None:
        result["binding"] = binding
    if slack is not None:
        result["slack"] = round(slack, 4)
    if slack_unit is not None:
        result["slack_unit"] = slack_unit
    if shadow_price_approx is not None:
        result["shadow_price_approx"] = round(shadow_price_approx, 4)
    if shadow_price_dual is not None:
        result["shadow_price_dual"] = round(shadow_price_dual, 4)
    if shadow_price_unit is not None:
        result["shadow_price_unit"] = shadow_price_unit
    if shadow_price_method is not None:
        result["shadow_price_method"] = shadow_price_method
    if natural_language is not None:
        result["natural_language"] = natural_language
    return result


def _suggestions_for_categories(categories: Set[str]) -> List[str]:
    actions: List[str] = []
    if "safety_stock" in categories:
        actions.append("Lower safety stock targets or increase supply to maintain buffer levels.")
    if "capacity" in categories:
        actions.append("Increase shared production/inventory capacity in constrained periods.")
        actions.append("Reduce demand target or allow backlog for constrained periods.")
    if "budget" in categories:
        actions.append("Increase shared budget cap or prioritize lower-cost SKUs.")
    if "moq_pack" in categories:
        actions.append("Reduce MOQ/pack constraints or relax max_order_qty caps.")
    if "lead_time" in categories:
        actions.append("Reduce lead times or bring in open POs earlier.")
    if "demand_infeasible" in categories:
        actions.append("Lower service_level_target or increase supply capacity.")
    if "bom_shortage" in categories:
        actions.append("Increase component supply or adjust BOM usage assumptions.")
    if not actions:
        actions.append("Relax one hard constraint family at a time and retry.")
    return actions[:6]


def _summarize_infeasibility(tags: List[str]) -> Dict[str, Any]:
    categories: Set[str] = set()
    for tag in tags:
        if tag.startswith("CAP_PROD") or tag.startswith("CAP_INV") or tag.startswith("CAP_VOL") or tag.startswith("CAP_WEIGHT"):
            categories.add("capacity")
        elif tag.startswith("BUDGET_GLOBAL") or tag.startswith("BUDGET_PERIOD"):
            categories.add("budget")
        elif tag.startswith("MOQ") or tag.startswith("PACK") or tag.startswith("MAXQ"):
            categories.add("moq_pack")
        elif tag.startswith("BALANCE_INV"):
            categories.add("lead_time")
        elif tag.startswith("SAFETY_STOCK"):
            categories.add("safety_stock")
        elif tag.startswith("SERVICE_LEVEL_GLOBAL"):
            categories.add("demand_infeasible")
        elif tag.startswith("BOM_LINK") or tag.startswith("COMP_FEAS"):
            categories.add("bom_shortage")

    category_list = sorted(categories) if categories else ["capacity"]
    suggestions = _suggestions_for_categories(set(category_list))
    return {
        "categories": category_list,
        "top_offending_tags": sorted(set(tags))[:12],
        "suggestions": suggestions,
    }


def _capacity_input_is_scalar(raw_value: Any) -> bool:
    if raw_value is None:
        return False
    if isinstance(raw_value, (int, float)):
        return True
    if isinstance(raw_value, str):
        return bool(str(raw_value).strip())
    return False


def _positive_shadow_from_dual(dual_value: Any) -> Optional[float]:
    try:
        dual = float(dual_value)
    except Exception:
        return None
    if not math.isfinite(dual):
        return None
    shadow = -dual  # For min LP with <= constraints, dual is typically non-positive.
    return 0.0 if shadow <= 1e-9 else float(shadow)


def _shadow_price_entry(
    *,
    shadow_price: float,
    interpretation: str,
    method: str = "lp_relaxation_dual",
    aggregation: Optional[str] = None,
    dual_value: Optional[float] = None,
    period_duals: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        # Keep backward compatibility with existing field naming.
        "shadow_price_approx": round(shadow_price, 6),
        # New explicit field: exact LP dual-derived shadow price.
        "shadow_price_dual": round(shadow_price, 6),
        "unit": "cost_reduction_per_unit_increase",
        "method": method,
        "interpretation": interpretation,
    }
    if aggregation is not None:
        payload["aggregation"] = aggregation
    if dual_value is not None and math.isfinite(dual_value):
        payload["dual_value_raw"] = round(float(dual_value), 6)
    if period_duals:
        payload["period_duals"] = period_duals
    return payload


def _compute_shadow_prices_lp_dual(
    payload: Any,
    constraints_checked_list: List[Dict[str, Any]],
) -> Dict[str, Dict[str, Any]]:
    """
    Compute exact shadow prices from LP relaxation duals.

    We rebuild a continuous relaxation of the single-echelon model and read
    dual values from GLOP, then map them back to business constraints.
    """
    if not _ORTOOLS_LINEAR_OK or _pywraplp is None:
        return {}

    binding_names = {
        str(c.get("name") or "").strip()
        for c in constraints_checked_list
        if c.get("binding") is True
    }
    supported_names = {
        "budget_cap",
        "shared_production_cap",
        "shared_inventory_cap",
        "budget_per_period",
        "volume_capacity",
        "weight_capacity",
        "service_level_target",
    }
    target_names = binding_names & supported_names
    if not target_names:
        return {}

    objective = _read_attr(payload, "objective", SimpleNamespace())
    constraints = _read_attr(payload, "constraints", SimpleNamespace())
    shared_constraints = _read_attr(payload, "shared_constraints", None)
    multi_echelon = _read_attr(payload, "multi_echelon", None)

    stockout_penalty = max(0.0, _to_float(_read_attr(objective, "stockout_penalty", 1.0), 1.0))
    holding_cost = max(0.0, _to_float(_read_attr(objective, "holding_cost", 0.0), 0.0))
    service_level_target_raw = _read_attr(objective, "service_level_target", None)
    service_level_target: Optional[float] = None
    if service_level_target_raw is not None:
        service_level_target = max(0.0, min(1.0, _to_float(service_level_target_raw, 0.0)))

    moq_s: Dict[str, int] = _build_qty_map(_read_attr(constraints, "moq", None), "min_qty")
    pack_s: Dict[str, int] = _build_qty_map(_read_attr(constraints, "pack_size", None), "pack_qty")
    maxq_s: Dict[str, int] = _build_qty_map(_read_attr(constraints, "max_order_qty", None), "max_qty")
    unit_cost_map: Dict[str, float] = _build_unit_cost_map_me(_read_attr(constraints, "unit_costs", None))
    sku_volume_map: Dict[str, float] = {}
    sku_weight_map: Dict[str, float] = {}
    suppliers_by_key: Dict[Tuple[str, str], List[SupplierInfo]] = {}

    budget_cap_raw = _first_non_none(
        _read_attr(shared_constraints, "budget_cap", None),
        _read_attr(constraints, "budget_cap", None),
    )
    budget_cap: Optional[float] = None
    if budget_cap_raw is not None:
        budget_cap = max(0.0, _to_float(budget_cap_raw, 0.0))

    budget_mode = str(_first_non_none(_read_attr(shared_constraints, "budget_mode", None), "auto")).strip().lower()
    prod_cap_raw = _first_non_none(
        _read_attr(shared_constraints, "production_capacity_per_period", None),
        _read_attr(multi_echelon, "production_capacity_per_period", None),
    )
    inv_cap_raw = _first_non_none(
        _read_attr(shared_constraints, "inventory_capacity_per_period", None),
        _read_attr(constraints, "inventory_capacity_per_period", None),
        _read_attr(multi_echelon, "inventory_capacity_per_period", None),
    )
    budget_per_period_raw = _read_attr(shared_constraints, "budget_per_period", None)
    volume_cap_raw = _read_attr(shared_constraints, "volume_capacity_per_period", None)
    weight_cap_raw = _read_attr(shared_constraints, "weight_capacity_per_period", None)

    # Demand parse: legacy + items[] (same source logic as CP-SAT path).
    forecast_by_key: Dict[Tuple[str, str], List[Tuple[date, int, Optional[int]]]] = {}
    p10_by_key: Dict[Tuple[str, str], List[Optional[int]]] = {}  # Phase 3: p10 for uncertainty
    for pt in _as_list(_read_path(payload, "demand_forecast.series", [])):
        sku = str(_read_attr(pt, "sku", "") or "").strip()
        if not sku:
            continue
        d = _parse_day(_read_attr(pt, "date", None))
        if not d:
            continue
        key = _key(_read_attr(pt, "sku", None), _read_attr(pt, "plant_id", None))
        p50_s = _s(max(0.0, _to_float(_read_attr(pt, "p50", 0.0), 0.0)))
        p90_raw = _read_attr(pt, "p90", None)
        p90_s = _s(max(0.0, _to_float(p90_raw, 0.0))) if p90_raw is not None else None
        p10_raw = _read_attr(pt, "p10", None)
        p10_s = _s(max(0.0, _to_float(p10_raw, 0.0))) if p10_raw is not None else None
        forecast_by_key.setdefault(key, []).append((d, p50_s, p90_s))
        p10_by_key.setdefault(key, []).append(p10_s)

    for item in _as_list(_read_attr(payload, "items", None)):
        sku = str(_read_attr(item, "sku", "") or "").strip()
        if not sku:
            continue
        item_plant = str(_read_attr(item, "plant_id", "") or "").strip()
        demand_rows = _first_non_none(
            _read_attr(item, "demand", None),
            _read_path(item, "demand_forecast.series", None),
            _read_attr(item, "series", None),
        )
        for pt in _as_list(demand_rows):
            d = _parse_day(_read_attr(pt, "date", None))
            if not d:
                continue
            plant = str(_first_non_none(_read_attr(pt, "plant_id", None), item_plant) or "").strip()
            key = _key(sku, plant)
            p50 = _first_non_none(_read_attr(pt, "p50", None), _read_attr(pt, "demand", None))
            p90 = _read_attr(pt, "p90", None)
            p10 = _read_attr(pt, "p10", None)
            p50_s = _s(max(0.0, _to_float(p50, 0.0)))
            p90_s = _s(max(0.0, _to_float(p90, 0.0))) if p90 is not None else None
            p10_s = _s(max(0.0, _to_float(p10, 0.0))) if p10 is not None else None
            forecast_by_key.setdefault(key, []).append((d, p50_s, p90_s))
            p10_by_key.setdefault(key, []).append(p10_s)

        item_constraints = _read_attr(item, "constraints", None)
        item_costs = _read_attr(item, "costs", None)

        moq_val = _first_non_none(
            _read_attr(item_constraints, "moq", None),
            _read_attr(item_constraints, "min_qty", None),
            _read_attr(item, "moq", None),
            _read_attr(item, "min_qty", None),
        )
        if moq_val is not None:
            moq_s[sku] = _s(max(0.0, _to_float(moq_val, 0.0)))

        pack_val = _first_non_none(
            _read_attr(item_constraints, "pack_size", None),
            _read_attr(item_constraints, "pack_qty", None),
            _read_attr(item, "pack_size", None),
            _read_attr(item, "pack_qty", None),
        )
        if pack_val is not None:
            pack_s[sku] = _s(max(0.0, _to_float(pack_val, 0.0)))

        max_val = _first_non_none(
            _read_attr(item_constraints, "max_order_qty", None),
            _read_attr(item_constraints, "max_qty", None),
            _read_attr(item, "max_order_qty", None),
            _read_attr(item, "max_qty", None),
        )
        if max_val is not None:
            maxq_s[sku] = _s(max(0.0, _to_float(max_val, 0.0)))

        unit_cost = _first_non_none(
            _read_attr(item_costs, "unit_cost", None),
            _read_attr(item_constraints, "unit_cost", None),
            _read_attr(item, "unit_cost", None),
        )
        if unit_cost is not None:
            unit_cost_map[sku] = max(0.0, _to_float(unit_cost, 0.0))

        volume_per_unit = _first_non_none(
            _read_attr(item, "volume_per_unit", None),
            _read_attr(item_constraints, "volume_per_unit", None),
        )
        if volume_per_unit is not None:
            sku_volume_map[sku] = max(0.0, _to_float(volume_per_unit, 0.0))

        weight_per_unit = _first_non_none(
            _read_attr(item, "weight_per_unit", None),
            _read_attr(item_constraints, "weight_per_unit", None),
        )
        if weight_per_unit is not None:
            sku_weight_map[sku] = max(0.0, _to_float(weight_per_unit, 0.0))

        supplier_rows = _as_list(_read_attr(item, "suppliers", None))
        if supplier_rows:
            key = _key(sku, item_plant)
            for sup in supplier_rows:
                sup_id = str(_read_attr(sup, "supplier_id", "") or "").strip()
                if not sup_id:
                    continue
                suppliers_by_key.setdefault(key, []).append(SupplierInfo(
                    supplier_id=sup_id,
                    lead_time_days=max(0, int(round(_to_float(_read_attr(sup, "lead_time_days", 0.0), 0.0)))),
                    unit_cost=max(0.0, _to_float(_read_attr(sup, "unit_cost", 0.0), 0.0)),
                    moq_s=_s(max(0.0, _to_float(_read_attr(sup, "moq", 0.0), 0.0))),
                    pack_s=_s(max(0.0, _to_float(_read_attr(sup, "pack_size", 0.0), 0.0))),
                    max_order_qty_s=_s(max(0.0, _to_float(_read_attr(sup, "max_order_qty", 0.0), 0.0))),
                    fixed_order_cost=max(0.0, _to_float(_read_attr(sup, "fixed_order_cost", 0.0), 0.0)),
                ))

    if not forecast_by_key:
        return {}

    for key in forecast_by_key:
        forecast_by_key[key].sort(key=lambda r: r[0])

    inventory_seed: Dict[Tuple[str, str], Dict[str, Any]] = {}

    def _upsert_inventory_seed(
        key: Tuple[str, str],
        as_of_day: Optional[date],
        on_hand: Any,
        safety_stock: Any,
        lead_time_days: Any,
    ) -> None:
        if as_of_day is None:
            return
        prev = inventory_seed.get(key)
        if prev and as_of_day <= prev["as_of_date"]:
            return
        inventory_seed[key] = {
            "as_of_date": as_of_day,
            "on_hand_s": _s(max(0.0, _to_float(on_hand, 0.0))),
            "safety_stock_s": _s(max(0.0, _to_float(safety_stock, 0.0))),
            "lead_time_days": max(0, int(round(_to_float(lead_time_days, 0.0)))),
        }

    for row in _as_list(_read_attr(payload, "inventory", None)):
        _upsert_inventory_seed(
            _key(_read_attr(row, "sku", None), _read_attr(row, "plant_id", None)),
            _parse_day(_read_attr(row, "as_of_date", None)),
            _read_attr(row, "on_hand", 0.0),
            _read_attr(row, "safety_stock", 0.0),
            _read_attr(row, "lead_time_days", 0.0),
        )

    for item in _as_list(_read_attr(payload, "items", None)):
        sku = str(_read_attr(item, "sku", "") or "").strip()
        if not sku:
            continue
        plant = str(_read_attr(item, "plant_id", "") or "").strip()
        key = _key(sku, plant)
        first_day = forecast_by_key.get(key, [(datetime.now(timezone.utc).date(), 0, None)])[0][0]
        as_of_day = _parse_day(_read_attr(item, "as_of_date", None)) or first_day
        _upsert_inventory_seed(
            key,
            as_of_day,
            _read_attr(item, "on_hand", 0.0),
            _read_attr(item, "safety_stock", 0.0),
            _read_attr(item, "lead_time_days", 0.0),
        )

    open_po_by_key: Dict[Tuple[str, str], Dict[date, int]] = {}
    for po in _as_list(_read_attr(payload, "open_pos", None)):
        d = _parse_day(_read_attr(po, "eta_date", None))
        if not d:
            continue
        key = _key(_read_attr(po, "sku", None), _read_attr(po, "plant_id", None))
        qty_s = _s(max(0.0, _to_float(_read_attr(po, "qty", 0.0), 0.0)))
        cal = open_po_by_key.setdefault(key, {})
        cal[d] = cal.get(d, 0) + qty_s

    horizon_days = max(1, int(_read_attr(payload, "planning_horizon_days", 1) or 1))
    ordered_keys = sorted(forecast_by_key.keys(), key=lambda k: (k[0], k[1]))
    key_records: Dict[Tuple[str, str], Dict[str, Any]] = {}
    total_demand_global = 0.0

    for key in ordered_keys:
        sku, _plant_id = key
        series = forecast_by_key[key]
        first_day = series[0][0]
        last_allowed = first_day + timedelta(days=horizon_days - 1)
        series = [(d, p50, p90) for d, p50, p90 in series if d <= last_allowed]
        if not series:
            continue

        seed = inventory_seed.get(key, {"on_hand_s": 0, "safety_stock_s": 0, "lead_time_days": 0})
        on_hand_s = int(seed["on_hand_s"])
        lead_time = int(seed["lead_time_days"])
        open_po_cal = open_po_by_key.get(key, {})

        days_list = [d for d, _, _ in series]
        demand_s_list = [p50 for _, p50, _ in series]
        total_demand_s = sum(demand_s_list)
        total_demand_global += _us(total_demand_s)

        sku_moq_s = int(moq_s.get(sku, 0))
        sku_pack_s = int(pack_s.get(sku, 0))
        sku_max_s = int(maxq_s.get(sku, 0))

        ub_order = max(total_demand_s, sku_moq_s if sku_moq_s else 1, on_hand_s + 1, SCALE)
        if sku_max_s > 0:
            ub_order = min(ub_order, max(sku_max_s, SCALE))
        ub_inv = on_hand_s + ub_order * len(days_list) + 1
        ub_back = max(total_demand_s + 1, SCALE)

        key_records[key] = {
            "days": days_list,
            "demand_s": demand_s_list,
            "on_hand_s": on_hand_s,
            "lead_time": lead_time,
            "open_po_cal_s": dict(open_po_cal),
            "safety_stock_s": int(seed.get("safety_stock_s", 0)),
            "ub_order_s": int(ub_order),
            "ub_inv_s": int(ub_inv),
            "ub_back_s": int(ub_back),
            "suppliers": suppliers_by_key.get(key, []),
            "sku_moq_s": sku_moq_s,
            "sku_pack_s": sku_pack_s,
            "sku_max_s": sku_max_s,
        }

    if not key_records:
        return {}

    solver = _pywraplp.Solver.CreateSolver("GLOP")
    if solver is None:
        return {}

    lp_objective = solver.Objective()
    lp_objective.SetMinimization()

    key_lp_vars: Dict[Tuple[str, str], Dict[str, Any]] = {}
    order_vars_by_day: Dict[date, List[Any]] = {}
    inv_vars_by_day: Dict[date, List[Any]] = {}
    all_order_vars: List[Any] = []

    for key_idx, key in enumerate(ordered_keys):
        rec = key_records.get(key)
        if rec is None:
            continue
        sku, _plant_id = key
        days_list: List[date] = rec["days"]
        demand_s_list: List[int] = rec["demand_s"]
        lead_time: int = rec["lead_time"]
        on_hand = _us(int(rec["on_hand_s"]))
        open_po_cal_s: Dict[date, int] = rec["open_po_cal_s"]
        sups: List[SupplierInfo] = rec["suppliers"]
        has_suppliers = len(sups) > 1

        ub_order = _us(int(rec["ub_order_s"]))
        ub_inv = _us(int(rec["ub_inv_s"]))
        ub_back = _us(int(rec["ub_back_s"]))

        sku_moq = _us(int(rec["sku_moq_s"]))
        sku_pack = _us(int(rec["sku_pack_s"]))
        sku_max = _us(int(rec["sku_max_s"]))

        order_vars = [solver.NumVar(0.0, ub_order, f"lp_ord_{key_idx}_{t}") for t in range(len(days_list))]
        inv_vars = [solver.NumVar(0.0, ub_inv, f"lp_inv_{key_idx}_{t}") for t in range(len(days_list))]
        back_vars = [solver.NumVar(0.0, ub_back, f"lp_back_{key_idx}_{t}") for t in range(len(days_list))]
        y_vars = [solver.NumVar(0.0, 1.0, f"lp_y_{key_idx}_{t}") for t in range(len(days_list))]

        k_vars: Optional[List[Any]] = None
        if sku_pack > 1.0 + 1e-9:
            max_k = ub_order / max(sku_pack, 1e-9) + 2.0
            k_vars = [solver.NumVar(0.0, max_k, f"lp_k_{key_idx}_{t}") for t in range(len(days_list))]

        supplier_order_vars: Dict[str, List[Any]] = {}
        if has_suppliers:
            for sup_idx, sup in enumerate(sups):
                sid = str(sup.supplier_id)
                s_order = [solver.NumVar(0.0, ub_order, f"lp_sord_{key_idx}_{sup_idx}_{t}") for t in range(len(days_list))]
                s_y = [solver.NumVar(0.0, 1.0, f"lp_sy_{key_idx}_{sup_idx}_{t}") for t in range(len(days_list))]
                supplier_order_vars[sid] = s_order

                sup_pack = _us(sup.pack_s)
                sup_moq = _us(sup.moq_s)
                sup_max = _us(sup.max_order_qty_s)

                s_k: Optional[List[Any]] = None
                if sup_pack > 1.0 + 1e-9:
                    s_k_ub = ub_order / max(sup_pack, 1e-9) + 2.0
                    s_k = [solver.NumVar(0.0, s_k_ub, f"lp_sk_{key_idx}_{sup_idx}_{t}") for t in range(len(days_list))]

                for t in range(len(days_list)):
                    if s_k is not None:
                        solver.Add(s_order[t] == s_k[t] * sup_pack)
                    if sup_moq > 0.0:
                        solver.Add(s_order[t] >= sup_moq * s_y[t])
                        solver.Add(s_order[t] <= ub_order * s_y[t])
                    else:
                        solver.Add(s_order[t] <= ub_order * s_y[t])
                    if sup_max > 0.0:
                        solver.Add(s_order[t] <= sup_max)

            for t in range(len(days_list)):
                solver.Add(order_vars[t] == sum(supplier_order_vars[s.supplier_id][t] for s in sups))

        for t, day in enumerate(days_list):
            order_vars_by_day.setdefault(day, []).append(order_vars[t])
            inv_vars_by_day.setdefault(day, []).append(inv_vars[t])

            if not has_suppliers:
                if k_vars is not None:
                    solver.Add(order_vars[t] == k_vars[t] * sku_pack)
                if sku_moq > 0.0:
                    solver.Add(order_vars[t] >= sku_moq * y_vars[t])
                    solver.Add(order_vars[t] <= ub_order * y_vars[t])
                else:
                    solver.Add(order_vars[t] <= ub_order * y_vars[t])
                if sku_max > 0.0:
                    solver.Add(order_vars[t] <= sku_max)

            demand = _us(int(demand_s_list[t]))
            open_po_t = _us(int(open_po_cal_s.get(day, 0)))
            rhs = (on_hand + open_po_t - demand) if t == 0 else (open_po_t - demand)

            lhs = inv_vars[t] - back_vars[t]
            if has_suppliers:
                for sup in sups:
                    order_idx = t - int(sup.lead_time_days)
                    if order_idx >= 0:
                        lhs = lhs - supplier_order_vars[sup.supplier_id][order_idx]
            else:
                order_idx = t - lead_time
                if order_idx >= 0:
                    lhs = lhs - order_vars[order_idx]
            if t > 0:
                lhs = lhs - inv_vars[t - 1] + back_vars[t - 1]
            solver.Add(lhs == rhs)

            lp_objective.SetCoefficient(order_vars[t], 1.0)
            lp_objective.SetCoefficient(back_vars[t], stockout_penalty)
            if holding_cost > 0.0:
                lp_objective.SetCoefficient(inv_vars[t], holding_cost)

        safety_stock = _us(int(rec["safety_stock_s"]))
        ss_slack_vars: Optional[List[Any]] = None
        if safety_stock > 1e-9:
            ss_slack_vars = [solver.NumVar(0.0, safety_stock, f"lp_ss_{key_idx}_{t}") for t in range(len(days_list))]
            for t in range(len(days_list)):
                solver.Add(inv_vars[t] + ss_slack_vars[t] >= safety_stock)

        key_lp_vars[key] = {
            "order": order_vars,
            "inv": inv_vars,
            "back": back_vars,
            "days": days_list,
            "supplier_order": supplier_order_vars,
            "end_back": back_vars[-1] if back_vars else None,
            "ss_slack": ss_slack_vars,
        }
        all_order_vars.extend(order_vars)

    if not key_lp_vars:
        return {}

    all_days = sorted(order_vars_by_day.keys())
    constraint_refs: Dict[str, Any] = {}
    family_refs: Dict[str, List[Tuple[str, Any]]] = {}
    family_scalar_mode: Dict[str, bool] = {}

    if prod_cap_raw is not None:
        prod_rows: List[Tuple[str, Any]] = []
        for idx, day in enumerate(all_days):
            cap = _capacity_for_period(prod_cap_raw, idx, day)
            if cap is None:
                continue
            day_orders = order_vars_by_day.get(day, [])
            if not day_orders:
                continue
            ct = solver.Add(sum(day_orders) <= max(0.0, float(cap)))
            prod_rows.append((day.isoformat(), ct))
        if prod_rows:
            family_refs["shared_production_cap"] = prod_rows
            family_scalar_mode["shared_production_cap"] = _capacity_input_is_scalar(prod_cap_raw)

    if inv_cap_raw is not None:
        inv_rows: List[Tuple[str, Any]] = []
        for idx, day in enumerate(all_days):
            cap = _capacity_for_period(inv_cap_raw, idx, day)
            if cap is None:
                continue
            day_inv = inv_vars_by_day.get(day, [])
            if not day_inv:
                continue
            ct = solver.Add(sum(day_inv) <= max(0.0, float(cap)))
            inv_rows.append((day.isoformat(), ct))
        if inv_rows:
            family_refs["shared_inventory_cap"] = inv_rows
            family_scalar_mode["shared_inventory_cap"] = _capacity_input_is_scalar(inv_cap_raw)

    if budget_cap is not None and all_order_vars:
        auto_cost_budget = any(v > 0.0 for v in unit_cost_map.values())
        use_cost_budget = budget_mode == "spend" or (budget_mode not in {"quantity"} and auto_cost_budget)
        if use_cost_budget:
            spend_terms: List[Any] = []
            for key in ordered_keys:
                key_vars = key_lp_vars.get(key)
                if not key_vars:
                    continue
                sku = key[0]
                coeff = max(0.0, unit_cost_map.get(sku, 1.0))
                for v in key_vars["order"]:
                    spend_terms.append(coeff * v)
            if spend_terms:
                constraint_refs["budget_cap"] = solver.Add(sum(spend_terms) <= float(budget_cap))
        else:
            constraint_refs["budget_cap"] = solver.Add(sum(all_order_vars) <= float(budget_cap))

    if service_level_target is not None:
        allowed_backlog = max(0.0, (1.0 - service_level_target) * total_demand_global)
        end_back_vars = [v["end_back"] for v in key_lp_vars.values() if v.get("end_back") is not None]
        if end_back_vars:
            constraint_refs["service_level_target"] = solver.Add(sum(end_back_vars) <= allowed_backlog)

    if budget_per_period_raw is not None:
        auto_cost = any(v > 0.0 for v in unit_cost_map.values())
        use_cost = budget_mode == "spend" or (budget_mode not in {"quantity"} and auto_cost)
        pp_rows: List[Tuple[str, Any]] = []
        for idx, day in enumerate(all_days):
            cap = _capacity_for_period(budget_per_period_raw, idx, day)
            if cap is None:
                continue
            if use_cost:
                spend_day: List[Any] = []
                for key in ordered_keys:
                    key_vars = key_lp_vars.get(key)
                    if not key_vars:
                        continue
                    sku = key[0]
                    coeff = max(0.0, unit_cost_map.get(sku, 1.0))
                    for t_idx, d in enumerate(key_vars["days"]):
                        if d == day:
                            spend_day.append(coeff * key_vars["order"][t_idx])
                if spend_day:
                    pp_rows.append((day.isoformat(), solver.Add(sum(spend_day) <= max(0.0, float(cap)))))
            else:
                day_orders = order_vars_by_day.get(day, [])
                if day_orders:
                    pp_rows.append((day.isoformat(), solver.Add(sum(day_orders) <= max(0.0, float(cap)))))
        if pp_rows:
            family_refs["budget_per_period"] = pp_rows
            family_scalar_mode["budget_per_period"] = _capacity_input_is_scalar(budget_per_period_raw)

    if volume_cap_raw is not None and sku_volume_map:
        vol_rows: List[Tuple[str, Any]] = []
        for idx, day in enumerate(all_days):
            cap = _capacity_for_period(volume_cap_raw, idx, day)
            if cap is None:
                continue
            vol_terms: List[Any] = []
            for key in ordered_keys:
                key_vars = key_lp_vars.get(key)
                if not key_vars:
                    continue
                sku = key[0]
                vol_coeff = max(0.0, sku_volume_map.get(sku, 0.0))
                if vol_coeff <= 0.0:
                    continue
                for t_idx, d in enumerate(key_vars["days"]):
                    if d == day:
                        vol_terms.append(vol_coeff * key_vars["inv"][t_idx])
            if vol_terms:
                vol_rows.append((day.isoformat(), solver.Add(sum(vol_terms) <= max(0.0, float(cap)))))
        if vol_rows:
            family_refs["volume_capacity"] = vol_rows
            family_scalar_mode["volume_capacity"] = _capacity_input_is_scalar(volume_cap_raw)

    if weight_cap_raw is not None and sku_weight_map:
        wt_rows: List[Tuple[str, Any]] = []
        for idx, day in enumerate(all_days):
            cap = _capacity_for_period(weight_cap_raw, idx, day)
            if cap is None:
                continue
            wt_terms: List[Any] = []
            for key in ordered_keys:
                key_vars = key_lp_vars.get(key)
                if not key_vars:
                    continue
                sku = key[0]
                wt_coeff = max(0.0, sku_weight_map.get(sku, 0.0))
                if wt_coeff <= 0.0:
                    continue
                for t_idx, d in enumerate(key_vars["days"]):
                    if d == day:
                        wt_terms.append(wt_coeff * key_vars["inv"][t_idx])
            if wt_terms:
                wt_rows.append((day.isoformat(), solver.Add(sum(wt_terms) <= max(0.0, float(cap)))))
        if wt_rows:
            family_refs["weight_capacity"] = wt_rows
            family_scalar_mode["weight_capacity"] = _capacity_input_is_scalar(weight_cap_raw)

    lp_status = solver.Solve()
    if lp_status not in {_pywraplp.Solver.OPTIMAL, _pywraplp.Solver.FEASIBLE}:
        return {}

    shadow_prices: Dict[str, Dict[str, Any]] = {}

    for name, ct in constraint_refs.items():
        if name not in target_names:
            continue
        shadow = _positive_shadow_from_dual(ct.dual_value())
        if shadow is None:
            continue
        if shadow > 0.0:
            interpretation = (
                f"Increasing {name} by 1 unit reduces estimated total cost by {shadow:.4f}."
            )
        else:
            interpretation = f"Constraint {name} is locally non-cost-reducing to relax."
        shadow_prices[name] = _shadow_price_entry(
            shadow_price=shadow,
            interpretation=interpretation,
            dual_value=float(ct.dual_value()),
        )

    for name, rows in family_refs.items():
        if name not in target_names:
            continue
        period_rows: List[Dict[str, Any]] = []
        for period, ct in rows:
            shadow = _positive_shadow_from_dual(ct.dual_value())
            if shadow is None:
                continue
            period_rows.append({
                "period": period,
                "dual_value_raw": round(float(ct.dual_value()), 6),
                "shadow_price_dual": round(shadow, 6),
            })
        if not period_rows:
            continue

        scalar_mode = bool(family_scalar_mode.get(name, False))
        if scalar_mode:
            agg_shadow = float(sum(row["shadow_price_dual"] for row in period_rows))
            aggregation = "sum_period_duals"
            interpretation = (
                f"Increasing scalar {name} cap by 1 in each period reduces estimated total cost by {agg_shadow:.4f}."
            )
        else:
            best = max(period_rows, key=lambda row: row["shadow_price_dual"])
            agg_shadow = float(best["shadow_price_dual"])
            aggregation = "max_period_dual"
            interpretation = (
                f"Relaxing {name} by 1 in period {best['period']} reduces estimated total cost by {agg_shadow:.4f}."
            )

        top_periods = sorted(period_rows, key=lambda row: row["shadow_price_dual"], reverse=True)[:10]
        shadow_prices[name] = _shadow_price_entry(
            shadow_price=agg_shadow,
            interpretation=interpretation,
            aggregation=aggregation,
            period_duals=top_periods,
        )

    return shadow_prices


def _compute_shadow_prices_parametric(
    payload: Any,
    constraints_checked_list: List[Dict[str, Any]],
) -> Dict[str, Dict[str, Any]]:
    """
    Fallback: approximate shadow prices via parametric perturbation.
    Kept for environments where LP dual extraction is unavailable.
    """
    shadow_prices: Dict[str, Dict[str, Any]] = {}

    perturbation_targets = [
        ("budget_cap", "shared_constraints.budget_cap", 0.10),
        ("shared_production_cap", "shared_constraints.production_capacity_per_period", 0.10),
        ("shared_inventory_cap", "shared_constraints.inventory_capacity_per_period", 0.10),
        ("budget_per_period", "shared_constraints.budget_per_period", 0.10),
    ]

    for name, path, delta_frac in perturbation_targets:
        matching = [c for c in constraints_checked_list if c.get("name") == name and c.get("binding")]
        if not matching:
            continue

        current_val = _read_path(payload, path, None)
        if current_val is None or not isinstance(current_val, (int, float)):
            continue

        delta = max(1.0, abs(float(current_val)) * delta_frac)

        trial_plus = _clone_payload(payload)
        _set_path(trial_plus, "diagnose_mode", False)
        _set_path(trial_plus, "_internal_diagnose", True)
        _set_path(trial_plus, "_solver_time_limit_seconds", DIAGNOSE_SOLVER_SECONDS)
        _set_path(trial_plus, "settings.compute_shadow_prices", False)
        _set_path(trial_plus, path, float(current_val) + delta)
        try:
            res_plus = solve_replenishment(trial_plus)
            obj_plus = res_plus.get("kpis", {}).get("estimated_total_cost")
        except Exception:
            obj_plus = None

        trial_minus = _clone_payload(payload)
        _set_path(trial_minus, "diagnose_mode", False)
        _set_path(trial_minus, "_internal_diagnose", True)
        _set_path(trial_minus, "_solver_time_limit_seconds", DIAGNOSE_SOLVER_SECONDS)
        _set_path(trial_minus, "settings.compute_shadow_prices", False)
        _set_path(trial_minus, path, max(0, float(current_val) - delta))
        try:
            res_minus = solve_replenishment(trial_minus)
            obj_minus = res_minus.get("kpis", {}).get("estimated_total_cost")
        except Exception:
            obj_minus = None

        if obj_plus is None or obj_minus is None:
            continue

        sp = (obj_minus - obj_plus) / (2 * delta)
        if not math.isfinite(sp):
            continue
        shadow_prices[name] = {
            "shadow_price_approx": round(sp, 6),
            "shadow_price_dual": None,
            "unit": "cost_reduction_per_unit_increase",
            "method": "parametric_perturbation",
            "delta_used": round(delta, 4),
            "base_value": round(float(current_val), 4),
            "interpretation": (
                f"Increasing {name} by 1 unit reduces total cost by ~{abs(sp):.4f}."
                if sp > 0
                else f"Constraint {name} is not cost-effective to relax."
            ),
        }

    return shadow_prices


def _compute_shadow_prices(
    payload: Any,
    constraints_checked_list: List[Dict[str, Any]],
    base_objective: float,
) -> Dict[str, Dict[str, Any]]:
    # Prefer exact LP dual values; backfill with perturbation fallback when needed.
    del base_objective  # kept in signature for backward compatibility
    exact = _compute_shadow_prices_lp_dual(payload, constraints_checked_list)
    if not exact:
        return _compute_shadow_prices_parametric(payload, constraints_checked_list)

    fallback_candidates = {
        str(c.get("name") or "").strip()
        for c in constraints_checked_list
        if c.get("binding") is True
    } & {
        "budget_cap",
        "shared_production_cap",
        "shared_inventory_cap",
        "budget_per_period",
    }
    missing = [name for name in sorted(fallback_candidates) if name not in exact]
    if not missing:
        return exact

    fallback = _compute_shadow_prices_parametric(payload, constraints_checked_list)
    for name in missing:
        entry = fallback.get(name)
        if entry:
            exact[name] = entry
    return exact


def _build_relaxation_summary(analyses: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """V2: Build relaxation summary from analysis results."""
    if not analyses:
        return None
    restoring = [a for a in analyses if a.get("feasible_after_relaxation")]
    if not restoring:
        return {"feasible_found": False, "levels_tried": len(analyses), "restoring_levels": []}
    best = min(restoring, key=lambda a: a.get("priority", 999))
    return {
        "feasible_found": True,
        "levels_tried": len(analyses),
        "restoring_levels": [a["relaxed_tags"][0] for a in restoring],
        "recommended_relaxation": best["relaxed_tags"][0],
        "recommendation_text": best.get("recommendation", ""),
    }


def _run_relaxation_analysis_single(payload: Any) -> List[Dict[str, Any]]:
    """
    Diagnose infeasibility by progressively relaxing constraint families.
    Returns small, deterministic analysis records.
    """
    analyses: List[Dict[str, Any]] = []

    relax_steps = [
        ("BUDGET_PERIOD", 2, "budget", "Remove per-period budget limits.", {"shared_constraints.budget_per_period": None}),
        ("BUDGET_GLOBAL", 3, "budget", "Increase or remove the global budget cap.", {"shared_constraints.budget_cap": None, "constraints.budget_cap": None}),
        ("SERVICE_LEVEL_GLOBAL", 4, "demand", "Lower the service level target.", {"objective.service_level_target": None}),
        ("CAP_PROD", 5, "capacity", "Increase production/ordering capacity.", {"shared_constraints.production_capacity_per_period": None}),
        ("CAP_INV", 6, "capacity", "Increase inventory storage capacity.", {"shared_constraints.inventory_capacity_per_period": None}),
        ("CAP_VOL", 7, "capacity", "Increase volume-based storage capacity.", {"shared_constraints.volume_capacity_per_period": None}),
        ("CAP_WEIGHT", 8, "capacity", "Increase weight-based capacity limits.", {"shared_constraints.weight_capacity_per_period": None}),
        ("LOT_SIZING", 9, "lot_sizing", "Relax MOQ, pack-size, or max-order-qty constraints.", {"constraints.moq": [], "constraints.pack_size": [], "constraints.max_order_qty": []}),
    ]

    for tag, priority, category, recommendation, updates in relax_steps:
        trial = _clone_payload(payload)
        # Force fast, non-recursive diagnose calls.
        _set_path(trial, "diagnose_mode", False)
        _set_path(trial, "_internal_diagnose", True)
        _set_path(trial, "_solver_time_limit_seconds", DIAGNOSE_SOLVER_SECONDS)
        for path, value in updates.items():
            _set_path(trial, path, value)
        try:
            trial_result = solve_replenishment(trial)
            trial_status = normalize_status(trial_result.get("status"), PlanningStatus.ERROR)
            feasible_after = trial_status in {PlanningStatus.OPTIMAL, PlanningStatus.FEASIBLE}
            delta_cost_proxy = trial_result.get("kpis", {}).get("estimated_total_cost")
        except Exception:
            feasible_after = False
            delta_cost_proxy = None
        analyses.append({
            "relaxed_tags": [tag],
            "priority": priority,
            "category": category,
            "recommendation": recommendation,
            "feasible_after_relaxation": feasible_after,
            "delta_cost_proxy": delta_cost_proxy,
        })
    return analyses


def _build_explain_summary(
    *,
    status: "PlanningStatus",
    constraints_checked: List[Dict[str, Any]],
    objective_terms: List[Dict[str, Any]],
    total_stockout: float,
    stockout_penalty: float,
    total_spend: float,
    budget_cap: Optional[float],
    budget_mode_effective: Optional[str],
) -> Dict[str, Any]:
    """Build a top-level explain_summary from solver results."""
    confidence_map = {
        PlanningStatus.OPTIMAL: "high",
        PlanningStatus.FEASIBLE: "medium",
    }
    confidence = confidence_map.get(status, "low")

    binding = [c for c in constraints_checked if c.get("binding") is True]
    top_binding = binding[0]["name"] if binding else None

    # Build headline
    parts: List[str] = []
    if total_stockout > 1e-6:
        parts.append(f"Projected shortage of {round(total_stockout, 0):.0f} units")
    if top_binding:
        parts.append(f"primary constraint is {top_binding}")
    headline = ", ".join(parts) if parts else "Plan meets all constraints with no projected shortage."

    # Build key relaxation suggestion from the top binding constraint
    key_relaxation: Optional[Dict[str, Any]] = None
    if top_binding == "budget_cap" and budget_cap is not None and budget_cap > 0:
        relax_amount = round(budget_cap * 0.10, 2)
        relax_unit = "USD" if budget_mode_effective == "spend" else "units"
        estimated_saving = round(stockout_penalty * total_stockout, 2) if total_stockout > 0 else 0.0
        if estimated_saving > 0:
            key_relaxation = {
                "constraint": "budget_cap",
                "relax_by": relax_amount,
                "relax_unit": relax_unit,
                "estimated_saving": estimated_saving,
                "saving_unit": "USD",
                "nl_text": (
                    f"Relaxing budget cap by {relax_unit} {relax_amount:,.0f} "
                    f"could reduce shortage penalty by up to {estimated_saving:,.0f} {relax_unit}."
                ),
            }
    elif top_binding and top_binding.startswith("shared_production"):
        if total_stockout > 0:
            estimated_saving = round(stockout_penalty * total_stockout * 0.5, 2)
            key_relaxation = {
                "constraint": top_binding,
                "relax_by": None,
                "relax_unit": "units/period",
                "estimated_saving": estimated_saving,
                "saving_unit": "USD",
                "nl_text": f"Increasing production capacity could reduce shortage penalty by ~{estimated_saving:,.0f} USD.",
            }
    elif top_binding == "moq" and total_stockout > 0:
        estimated_saving = round(stockout_penalty * total_stockout * 0.3, 2)
        key_relaxation = {
            "constraint": "moq",
            "relax_by": None,
            "relax_unit": "units",
            "estimated_saving": estimated_saving,
            "saving_unit": "USD",
            "nl_text": f"Relaxing MOQ requirements could reduce shortage penalty by ~{estimated_saving:,.0f} USD.",
        }

    return {
        "headline": headline,
        "top_binding_constraint": top_binding,
        "key_relaxation": key_relaxation,
        "confidence": confidence,
    }


# ── public API ─────────────────────────────────────────────────────────────────

def ortools_available() -> bool:
    """Return True if OR-Tools is importable."""
    return _ORTOOLS_OK


def solve_replenishment(
    payload: Any,
    run_settings: Optional[SolverRunSettings] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """
    Solve a replenishment plan using OR-Tools CP-SAT.
    Backward-compatible inputs:
      - legacy demand_forecast/inventory/open_pos/constraints
      - extended items[] and shared_constraints.
    """
    if not _ORTOOLS_OK:
        raise RuntimeError("ortools is not installed; cannot use CP-SAT solver")

    solver_settings = run_settings or _resolve_solver_run_settings(
        payload,
        default_time_limit_seconds=DEFAULT_SOLVER_SINGLE_TIME_LIMIT_SECONDS,
    )
    t0 = datetime.now(timezone.utc)
    if bool(getattr(solver_settings, "force_timeout", False)):
        return _empty_response(
            t0,
            "TIMEOUT",
            ["Forced timeout via settings.solver.force_timeout=true."],
            settings=solver_settings,
            termination_reason="FORCED_TIMEOUT",
            status_name="FORCED_TIMEOUT",
        )
    model = _cp_model.CpModel()

    objective = _read_attr(payload, "objective", SimpleNamespace())
    constraints = _read_attr(payload, "constraints", SimpleNamespace())
    shared_constraints = _read_attr(payload, "shared_constraints", None)
    multi_echelon = _read_attr(payload, "multi_echelon", None)

    diagnose_mode = _to_bool(
        _first_non_none(
            _read_attr(payload, "diagnose_mode", None),
            _read_path(payload, "settings.diagnose_mode", None),
        ),
        False,
    )
    internal_diagnose = _to_bool(_read_attr(payload, "_internal_diagnose", None), False)

    stockout_penalty = max(0.0, _to_float(_read_attr(objective, "stockout_penalty", 1.0), 1.0))
    holding_cost = max(0.0, _to_float(_read_attr(objective, "holding_cost", 0.0), 0.0))
    safety_stock_penalty_raw = _read_attr(objective, "safety_stock_violation_penalty", None)
    safety_stock_penalty: float = max(0.0, _to_float(safety_stock_penalty_raw, 10.0)) if safety_stock_penalty_raw is not None else 10.0
    service_level_target_raw = _read_attr(objective, "service_level_target", None)
    service_level_target: Optional[float] = None
    if service_level_target_raw is not None:
        service_level_target = max(0.0, min(1.0, _to_float(service_level_target_raw, 0.0)))

    forecast_uncertainty_cfg = _as_dict(_read_path(payload, "settings.forecast_uncertainty", {}))
    closed_loop_patch = _as_dict(
        _read_path(payload, "settings.closed_loop_meta.param_patch.patch", {})
    )
    safety_stock_alpha_raw = _first_non_none(
        _read_attr(objective, "safety_stock_alpha", None),
        forecast_uncertainty_cfg.get("safety_stock_alpha"),
        closed_loop_patch.get("safety_stock_alpha"),
        1.0,
    )
    safety_stock_alpha = max(0.0, _to_float(safety_stock_alpha_raw, 1.0))
    use_p90_for_safety_stock = _to_bool(
        _first_non_none(
            _read_attr(objective, "use_p90_for_safety_stock", None),
            forecast_uncertainty_cfg.get("use_p90_for_safety_stock"),
            True,
        ),
        True,
    )
    use_p90_for_service_level = _to_bool(
        _first_non_none(
            _read_attr(objective, "use_p90_for_service_level", None),
            forecast_uncertainty_cfg.get("use_p90_for_service_level"),
            True,
        ),
        True,
    )
    # Phase 3 – P3.2: Use p90 as primary demand constraint RHS (robust optimization)
    use_p90_demand_model = _to_bool(
        _first_non_none(
            _read_attr(objective, "use_p90_demand_model", None),
            forecast_uncertainty_cfg.get("use_p90_demand_model"),
            _read_path(payload, "settings.use_p90_demand_model", None),
            False,
        ),
        False,
    )
    closed_loop_safety_stock_by_key_s = _parse_keyed_scaled_qty_map(
        closed_loop_patch.get("safety_stock_by_key")
    )

    # Profit at Risk: per-SKU profit_per_unit as dynamic stockout penalty weight
    _par_map_raw = _read_path(payload, "objective.profit_per_unit_by_sku", None)
    if _par_map_raw is None:
        _par_map_raw = _read_path(payload, "settings.profit_per_unit_by_sku", None)
    profit_per_unit_by_sku: Dict[str, float] = {}
    if isinstance(_par_map_raw, dict):
        profit_per_unit_by_sku = {
            str(k): max(0.0, _to_float(v, 0.0))
            for k, v in _par_map_raw.items()
            if _to_float(v, 0.0) > 0
        }

    coeff_order = OBJ_SCALE
    coeff_stockout = int(round(stockout_penalty * OBJ_SCALE))
    coeff_holding = int(round(holding_cost * OBJ_SCALE))
    coeff_ss_penalty = int(round(safety_stock_penalty * OBJ_SCALE))

    # ── Risk signals: per-SKU overrides (backward-compatible no-ops when absent) ──
    _risk_signals = _read_attr(payload, "risk_signals", None)
    _rs = _risk_signals if _risk_signals is not None else SimpleNamespace()

    # Sub-gap 1: per-SKU safety stock penalty multiplier map
    _ss_penalty_map_raw = _read_attr(_rs, "ss_penalty_by_key", None)
    ss_penalty_by_key: Dict[str, float] = {}
    if isinstance(_ss_penalty_map_raw, dict):
        ss_penalty_by_key = {
            str(k): max(1.0, _to_float(v, 1.0))
            for k, v in _ss_penalty_map_raw.items()
        }

    # Sub-gap 2: dual source keys (minimum split constraint)
    _ds_raw = _read_attr(_rs, "dual_source_keys", None)
    dual_source_keys: set = set()
    if isinstance(_ds_raw, (list, tuple)):
        dual_source_keys = {str(k).strip() for k in _ds_raw if k}
    dual_source_min_split: float = max(0.0, min(0.5, _to_float(
        _read_attr(_rs, "dual_source_min_split_fraction", 0.2), 0.2
    )))

    # Sub-gap 3: expedite keys (lead time reduction + cost premium)
    _exp_raw = _read_attr(_rs, "expedite_keys", None)
    expedite_keys: set = set()
    if isinstance(_exp_raw, (list, tuple)):
        expedite_keys = {str(k).strip() for k in _exp_raw if k}
    expedite_lt_reduction: int = max(0, int(round(_to_float(
        _read_attr(_rs, "expedite_lead_time_reduction_days", 0), 0
    ))))
    expedite_cost_mult: float = max(1.0, _to_float(
        _read_attr(_rs, "expedite_cost_multiplier", 1.0), 1.0
    ))

    constraint_tags: List[Dict[str, Any]] = []

    def _tag(
        tag: str,
        description: str,
        *,
        severity: str = "hard",
        scope: str = "global",
        period: Optional[str] = None,
        sku: Optional[str] = None,
        echelon: str = "single",
    ) -> None:
        constraint_tags.append({
            "tag": tag,
            "description": description,
            "severity": severity,
            "scope": scope,
            "period": period,
            "sku": sku,
            "echelon": echelon,
        })

    moq_s: Dict[str, int] = _build_qty_map(_read_attr(constraints, "moq", None), "min_qty")
    pack_s: Dict[str, int] = _build_qty_map(_read_attr(constraints, "pack_size", None), "pack_qty")
    maxq_s: Dict[str, int] = _build_qty_map(_read_attr(constraints, "max_order_qty", None), "max_qty")
    unit_cost_map: Dict[str, float] = _build_unit_cost_map_me(_read_attr(constraints, "unit_costs", None))
    sku_priority_map: Dict[str, float] = {}
    sku_volume_map: Dict[str, float] = {}
    sku_weight_map: Dict[str, float] = {}
    suppliers_by_key: Dict[Tuple[str, str], List[SupplierInfo]] = {}

    budget_cap_raw = _first_non_none(
        _read_attr(shared_constraints, "budget_cap", None),
        _read_attr(constraints, "budget_cap", None),
    )
    budget_cap: Optional[float] = None
    if budget_cap_raw is not None:
        budget_cap = max(0.0, _to_float(budget_cap_raw, 0.0))
    budget_mode = str(_first_non_none(_read_attr(shared_constraints, "budget_mode", None), "auto")).strip().lower()

    prod_cap_raw = _first_non_none(
        _read_attr(shared_constraints, "production_capacity_per_period", None),
        _read_attr(multi_echelon, "production_capacity_per_period", None),
    )
    inv_cap_raw = _first_non_none(
        _read_attr(shared_constraints, "inventory_capacity_per_period", None),
        _read_attr(constraints, "inventory_capacity_per_period", None),
        _read_attr(multi_echelon, "inventory_capacity_per_period", None),
    )

    # V2: per-period budget, volume/weight capacity
    budget_per_period_raw = _read_attr(shared_constraints, "budget_per_period", None)
    volume_cap_raw = _read_attr(shared_constraints, "volume_capacity_per_period", None)
    weight_cap_raw = _read_attr(shared_constraints, "weight_capacity_per_period", None)

    # Demand parse: legacy + items[].
    forecast_by_key: Dict[Tuple[str, str], List[Tuple[date, int, Optional[int]]]] = {}
    p10_by_key: Dict[Tuple[str, str], List[Optional[int]]] = {}  # Phase 3: p10 for uncertainty
    for pt in _as_list(_read_path(payload, "demand_forecast.series", [])):
        sku = str(_read_attr(pt, "sku", "") or "").strip()
        if not sku:
            continue
        d = _parse_day(_read_attr(pt, "date", None))
        if not d:
            continue
        key = _key(_read_attr(pt, "sku", None), _read_attr(pt, "plant_id", None))
        p50_s = _s(max(0.0, _to_float(_read_attr(pt, "p50", 0.0), 0.0)))
        p90_raw = _read_attr(pt, "p90", None)
        p90_s = _s(max(0.0, _to_float(p90_raw, 0.0))) if p90_raw is not None else None
        p10_raw = _read_attr(pt, "p10", None)
        p10_s = _s(max(0.0, _to_float(p10_raw, 0.0))) if p10_raw is not None else None
        forecast_by_key.setdefault(key, []).append((d, p50_s, p90_s))
        p10_by_key.setdefault(key, []).append(p10_s)

    for item in _as_list(_read_attr(payload, "items", None)):
        sku = str(_read_attr(item, "sku", "") or "").strip()
        if not sku:
            continue
        item_plant = str(_read_attr(item, "plant_id", "") or "").strip()
        demand_rows = _first_non_none(
            _read_attr(item, "demand", None),
            _read_path(item, "demand_forecast.series", None),
            _read_attr(item, "series", None),
        )
        for pt in _as_list(demand_rows):
            d = _parse_day(_read_attr(pt, "date", None))
            if not d:
                continue
            plant = str(_first_non_none(_read_attr(pt, "plant_id", None), item_plant) or "").strip()
            key = _key(sku, plant)
            p50 = _first_non_none(_read_attr(pt, "p50", None), _read_attr(pt, "demand", None))
            p90 = _read_attr(pt, "p90", None)
            p10 = _read_attr(pt, "p10", None)
            p50_s = _s(max(0.0, _to_float(p50, 0.0)))
            p90_s = _s(max(0.0, _to_float(p90, 0.0))) if p90 is not None else None
            p10_s = _s(max(0.0, _to_float(p10, 0.0))) if p10 is not None else None
            forecast_by_key.setdefault(key, []).append((d, p50_s, p90_s))
            p10_by_key.setdefault(key, []).append(p10_s)

        item_constraints = _read_attr(item, "constraints", None)
        item_costs = _read_attr(item, "costs", None)

        moq_val = _first_non_none(
            _read_attr(item_constraints, "moq", None),
            _read_attr(item_constraints, "min_qty", None),
            _read_attr(item, "moq", None),
            _read_attr(item, "min_qty", None),
        )
        if moq_val is not None:
            moq_s[sku] = _s(max(0.0, _to_float(moq_val, 0.0)))

        pack_val = _first_non_none(
            _read_attr(item_constraints, "pack_size", None),
            _read_attr(item_constraints, "pack_qty", None),
            _read_attr(item, "pack_size", None),
            _read_attr(item, "pack_qty", None),
        )
        if pack_val is not None:
            pack_s[sku] = _s(max(0.0, _to_float(pack_val, 0.0)))

        max_val = _first_non_none(
            _read_attr(item_constraints, "max_order_qty", None),
            _read_attr(item_constraints, "max_qty", None),
            _read_attr(item, "max_order_qty", None),
            _read_attr(item, "max_qty", None),
        )
        if max_val is not None:
            maxq_s[sku] = _s(max(0.0, _to_float(max_val, 0.0)))

        unit_cost = _first_non_none(
            _read_attr(item_costs, "unit_cost", None),
            _read_attr(item_constraints, "unit_cost", None),
            _read_attr(item, "unit_cost", None),
        )
        if unit_cost is not None:
            unit_cost_map[sku] = max(0.0, _to_float(unit_cost, 0.0))

        priority = _first_non_none(_read_attr(item, "service_level_weight", None), _read_attr(item, "priority_weight", None))
        if priority is not None:
            sku_priority_map[sku] = max(0.01, _to_float(priority, 1.0))

        # V2: volume/weight per unit (for capacity constraints)
        volume_per_unit = _first_non_none(
            _read_attr(item, "volume_per_unit", None),
            _read_attr(item_constraints, "volume_per_unit", None),
        )
        if volume_per_unit is not None:
            sku_volume_map[sku] = max(0.0, _to_float(volume_per_unit, 0.0))
        weight_per_unit = _first_non_none(
            _read_attr(item, "weight_per_unit", None),
            _read_attr(item_constraints, "weight_per_unit", None),
        )
        if weight_per_unit is not None:
            sku_weight_map[sku] = max(0.0, _to_float(weight_per_unit, 0.0))

        # V2 Feature 1: Parse suppliers for multi-supplier optimization
        supplier_rows = _as_list(_read_attr(item, "suppliers", None))
        if supplier_rows:
            key = _key(sku, item_plant)
            for sup in supplier_rows:
                sup_id = str(_read_attr(sup, "supplier_id", "") or "").strip()
                if not sup_id:
                    continue
                suppliers_by_key.setdefault(key, []).append(SupplierInfo(
                    supplier_id=sup_id,
                    lead_time_days=max(0, int(round(_to_float(_read_attr(sup, "lead_time_days", 0.0), 0.0)))),
                    unit_cost=max(0.0, _to_float(_read_attr(sup, "unit_cost", 0.0), 0.0)),
                    moq_s=_s(max(0.0, _to_float(_read_attr(sup, "moq", 0.0), 0.0))),
                    pack_s=_s(max(0.0, _to_float(_read_attr(sup, "pack_size", 0.0), 0.0))),
                    max_order_qty_s=_s(max(0.0, _to_float(_read_attr(sup, "max_order_qty", 0.0), 0.0))),
                    fixed_order_cost=max(0.0, _to_float(_read_attr(sup, "fixed_order_cost", 0.0), 0.0)),
                ))

    if not forecast_by_key:
        return _empty_response(
            t0,
            "INFEASIBLE",
            ["No valid demand rows were provided in demand_forecast.series or items[].demand."],
            settings=solver_settings,
            termination_reason="INVALID_INPUT",
        )

    for key in forecast_by_key:
        forecast_by_key[key].sort(key=lambda r: r[0])

    inventory_seed: Dict[Tuple[str, str], Dict[str, Any]] = {}

    def _upsert_inventory_seed(
        key: Tuple[str, str],
        as_of_day: Optional[date],
        on_hand: Any,
        safety_stock: Any,
        lead_time_days: Any,
    ) -> None:
        if as_of_day is None:
            return
        prev = inventory_seed.get(key)
        if prev and as_of_day <= prev["as_of_date"]:
            return
        inventory_seed[key] = {
            "as_of_date": as_of_day,
            "on_hand_s": _s(max(0.0, _to_float(on_hand, 0.0))),
            "safety_stock_s": _s(max(0.0, _to_float(safety_stock, 0.0))),
            "lead_time_days": max(0, int(round(_to_float(lead_time_days, 0.0)))),
        }

    for row in _as_list(_read_attr(payload, "inventory", None)):
        _upsert_inventory_seed(
            _key(_read_attr(row, "sku", None), _read_attr(row, "plant_id", None)),
            _parse_day(_read_attr(row, "as_of_date", None)),
            _read_attr(row, "on_hand", 0.0),
            _read_attr(row, "safety_stock", 0.0),
            _read_attr(row, "lead_time_days", 0.0),
        )

    for item in _as_list(_read_attr(payload, "items", None)):
        sku = str(_read_attr(item, "sku", "") or "").strip()
        if not sku:
            continue
        plant = str(_read_attr(item, "plant_id", "") or "").strip()
        key = _key(sku, plant)
        first_day = forecast_by_key.get(key, [(datetime.now(timezone.utc).date(), 0, None)])[0][0]
        as_of_day = _parse_day(_read_attr(item, "as_of_date", None)) or first_day
        _upsert_inventory_seed(
            key,
            as_of_day,
            _read_attr(item, "on_hand", 0.0),
            _read_attr(item, "safety_stock", 0.0),
            _read_attr(item, "lead_time_days", 0.0),
        )

    open_po_by_key: Dict[Tuple[str, str], Dict[date, int]] = {}
    for po in _as_list(_read_attr(payload, "open_pos", None)):
        d = _parse_day(_read_attr(po, "eta_date", None))
        if not d:
            continue
        key = _key(_read_attr(po, "sku", None), _read_attr(po, "plant_id", None))
        qty_s = _s(max(0.0, _to_float(_read_attr(po, "qty", 0.0), 0.0)))
        cal = open_po_by_key.setdefault(key, {})
        cal[d] = cal.get(d, 0) + qty_s

    horizon_days = max(1, int(_read_attr(payload, "planning_horizon_days", 1) or 1))
    ordered_keys = sorted(forecast_by_key.keys(), key=lambda k: (k[0], k[1]))
    sku_var_maps: Dict[Tuple[str, str], Dict[str, Any]] = {}
    sku_meta: Dict[Tuple[str, str], Dict[str, Any]] = {}
    all_order_vars: List[Any] = []
    order_vars_by_day: Dict[date, List[Any]] = {}
    inv_vars_by_day: Dict[date, List[Any]] = {}
    total_demand_s_global = 0
    total_demand_s_for_service_level = 0
    keys_with_p90 = 0
    keys_with_derived_safety_stock = 0
    keys_with_closed_loop_safety_stock = 0
    obj_terms: List[Any] = []

    for key_idx, key in enumerate(ordered_keys):
        sku, plant_id = key
        series = forecast_by_key[key]
        first_day = series[0][0]
        last_allowed = first_day + timedelta(days=horizon_days - 1)
        series = [(d, p50, p90) for d, p50, p90 in series if d <= last_allowed]
        if not series:
            continue

        seed = inventory_seed.get(key, {"on_hand_s": 0, "safety_stock_s": 0, "lead_time_days": 0})
        on_hand_s: int = int(seed["on_hand_s"])
        lead_time: int = int(seed["lead_time_days"])

        # Risk-driven expedite: reduce effective lead time
        sku_key_str = f"{sku}|{plant_id or ''}"
        is_expedited = bool(sku_key_str in expedite_keys and expedite_lt_reduction > 0)
        original_lead_time = lead_time
        if is_expedited:
            lead_time = max(0, lead_time - expedite_lt_reduction)

        open_po_cal = open_po_by_key.get(key, {})

        days_list = [d for d, _, _ in series]
        # Phase 3 – P3.2: If use_p90_demand_model, use p90 as primary demand RHS
        if use_p90_demand_model:
            demand_s_list = [
                (p90 if p90 is not None else p50) for _, p50, p90 in series
            ]
        else:
            demand_s_list = [p50 for _, p50, _ in series]
        demand_for_service_level_s = [
            (p90 if (use_p90_for_service_level and p90 is not None) else p50)
            for _, p50, p90 in series
        ]
        T = len(days_list)

        total_demand_s = sum(demand_s_list)
        total_demand_s_global += total_demand_s
        total_demand_s_for_service_level += sum(demand_for_service_level_s)
        sku_moq_s = int(moq_s.get(sku, 0))
        sku_pack_s = int(pack_s.get(sku, 0))
        sku_max_s = int(maxq_s.get(sku, 0))
        sku_unit_cost = max(0.0, unit_cost_map.get(sku, 0.0))
        sku_priority = max(0.01, sku_priority_map.get(sku, 1.0))

        p90_values_s = [p90 for _, _, p90 in series if p90 is not None]
        if p90_values_s:
            keys_with_p90 += 1

        base_safety_stock_s_val = int(seed.get("safety_stock_s", 0))
        derived_safety_stock_s_val: Optional[int] = None
        if use_p90_for_safety_stock and p90_values_s:
            avg_p50_s = sum(p50 for _, p50, _ in series) / len(series)
            avg_p90_s = sum((p90 if p90 is not None else p50) for _, p50, p90 in series) / len(series)
            spread_s = max(0.0, avg_p90_s - avg_p50_s)
            derived_safety_stock_s_val = max(0, int(round(avg_p50_s + safety_stock_alpha * spread_s)))

        closed_loop_ss_override_s_val = _lookup_keyed_value(
            closed_loop_safety_stock_by_key_s,
            key,
        )
        if closed_loop_ss_override_s_val is not None:
            safety_stock_s_val = max(0, int(closed_loop_ss_override_s_val))
            keys_with_closed_loop_safety_stock += 1
        elif derived_safety_stock_s_val is not None:
            safety_stock_s_val = max(base_safety_stock_s_val, derived_safety_stock_s_val)
            if safety_stock_s_val > base_safety_stock_s_val:
                keys_with_derived_safety_stock += 1
        else:
            safety_stock_s_val = base_safety_stock_s_val

        ub_order = max(total_demand_s, sku_moq_s if sku_moq_s else 1, on_hand_s + 1, SCALE)
        if sku_max_s > 0:
            ub_order = min(ub_order, max(sku_max_s, SCALE))
        ub_inv = on_hand_s + ub_order * T + 1
        ub_back = max(total_demand_s + 1, SCALE)

        var_tag = f"{sku}_{plant_id or 'NA'}"
        order_vars = [model.NewIntVar(0, ub_order, f"ord_{var_tag}_{t}") for t in range(T)]
        inv_vars = [model.NewIntVar(0, ub_inv, f"inv_{var_tag}_{t}") for t in range(T)]
        back_vars = [model.NewIntVar(0, ub_back, f"back_{var_tag}_{t}") for t in range(T)]
        y_vars = [model.NewBoolVar(f"y_{var_tag}_{t}") for t in range(T)]

        k_vars: Optional[List[Any]] = None
        if sku_pack_s > SCALE:
            max_k = ub_order // sku_pack_s + 2
            k_vars = [model.NewIntVar(0, int(max_k), f"k_{var_tag}_{t}") for t in range(T)]

        tie_rank = len(ordered_keys) - key_idx
        # Profit at Risk: boost stockout penalty by profit_per_unit for high-margin SKUs
        _par_mult = 1.0
        if profit_per_unit_by_sku:
            _par_value = profit_per_unit_by_sku.get(sku, 0.0)
            if _par_value > 0:
                _par_mult = 1.0 + min(5.0, _par_value / max(sku_unit_cost / OBJ_SCALE, 0.01))
        back_coeff = max(1, int(round(coeff_stockout * max(1, int(round(sku_priority * 100))) * _par_mult)) + tie_rank)
        # Risk-driven expedite: apply cost premium to unit cost in objective
        effective_unit_cost = sku_unit_cost
        if is_expedited and expedite_cost_mult > 1.0:
            effective_unit_cost = sku_unit_cost * expedite_cost_mult
        order_coeff = max(1, coeff_order + int(round(effective_unit_cost * 10)))

        # V2 Feature 1: Multi-supplier variables
        sups = suppliers_by_key.get(key, [])
        has_suppliers = len(sups) > 1
        supplier_order_vars: Dict[str, List[Any]] = {}
        supplier_y_vars: Dict[str, List[Any]] = {}
        supplier_k_vars: Dict[str, Optional[List[Any]]] = {}

        if has_suppliers:
            for sup in sups:
                sid = sup.supplier_id
                s_tag = f"{var_tag}_{sid}"
                s_order = [model.NewIntVar(0, ub_order, f"ord_{s_tag}_{t}") for t in range(T)]
                s_y = [model.NewBoolVar(f"y_{s_tag}_{t}") for t in range(T)]
                supplier_order_vars[sid] = s_order
                supplier_y_vars[sid] = s_y

                s_k: Optional[List[Any]] = None
                if sup.pack_s > SCALE:
                    mk = ub_order // sup.pack_s + 2
                    s_k = [model.NewIntVar(0, int(mk), f"k_{s_tag}_{t}") for t in range(T)]
                supplier_k_vars[sid] = s_k

                for t in range(T):
                    if s_k is not None:
                        model.Add(s_order[t] == s_k[t] * sup.pack_s)
                    if sup.moq_s > 0:
                        model.Add(s_order[t] >= sup.moq_s).OnlyEnforceIf(s_y[t])
                        model.Add(s_order[t] == 0).OnlyEnforceIf(s_y[t].Not())
                    else:
                        model.Add(s_order[t] == 0).OnlyEnforceIf(s_y[t].Not())
                        model.Add(s_order[t] >= 1).OnlyEnforceIf(s_y[t])
                    if sup.max_order_qty_s > 0:
                        model.Add(s_order[t] <= sup.max_order_qty_s)

            # Aggregate: order[t] = sum of supplier orders
            for t in range(T):
                model.Add(order_vars[t] == sum(supplier_order_vars[s.supplier_id][t] for s in sups))

            # Risk-driven dual-source: minimum split across suppliers
            if sku_key_str in dual_source_keys and len(sups) >= 2:
                split_ppm = int(round(dual_source_min_split * 1_000_000))
                total_ord_aux = model.NewIntVar(0, ub_order * T + 1, f"ds_total_{var_tag}")
                model.Add(total_ord_aux == sum(order_vars[t] for t in range(T)))
                for sup in sups:
                    sid = sup.supplier_id
                    sup_total = model.NewIntVar(0, ub_order * T + 1, f"ds_sup_{var_tag}_{sid}")
                    model.Add(sup_total == sum(supplier_order_vars[sid][t] for t in range(T)))
                    # sup_total * 1_000_000 >= split_ppm * total_ord_aux
                    model.Add(sup_total * 1_000_000 >= split_ppm * total_ord_aux)
                _tag(
                    f"DUAL_SOURCE[{sku}]",
                    f"Risk-driven: each supplier >= {dual_source_min_split:.0%} of total.",
                    severity="hard", scope="sku", sku=sku,
                )

        for t in range(T):
            day = days_list[t]
            order_vars_by_day.setdefault(day, []).append(order_vars[t])
            inv_vars_by_day.setdefault(day, []).append(inv_vars[t])

            if not has_suppliers:
                # Single-supplier path (backward compatible)
                if k_vars is not None:
                    model.Add(order_vars[t] == k_vars[t] * sku_pack_s)
                    _tag(f"PACK[{sku},{t}]", "Order quantity must be a pack-size multiple.", scope="sku_period", period=day.isoformat(), sku=sku)

                if sku_moq_s > 0:
                    model.Add(order_vars[t] >= sku_moq_s).OnlyEnforceIf(y_vars[t])
                    model.Add(order_vars[t] == 0).OnlyEnforceIf(y_vars[t].Not())
                    _tag(f"MOQ[{sku},{t}]", "Order quantity must satisfy MOQ when ordered.", scope="sku_period", period=day.isoformat(), sku=sku)
                else:
                    model.Add(order_vars[t] == 0).OnlyEnforceIf(y_vars[t].Not())
                    model.Add(order_vars[t] >= 1).OnlyEnforceIf(y_vars[t])

                if sku_max_s > 0:
                    model.Add(order_vars[t] <= sku_max_s)
                    _tag(f"MAXQ[{sku},{t}]", "Per-SKU max order quantity.", scope="sku_period", period=day.isoformat(), sku=sku)

            # Inventory balance: handle multi-supplier lead times
            open_po_t = open_po_cal.get(day, 0)
            const_rhs = on_hand_s + open_po_t - demand_s_list[t] if t == 0 else open_po_t - demand_s_list[t]
            lhs = inv_vars[t] - back_vars[t]

            if has_suppliers:
                # Each supplier has its own lead time (with risk-driven expedite reduction)
                for sup in sups:
                    eff_lt = sup.lead_time_days
                    if is_expedited and expedite_lt_reduction > 0:
                        eff_lt = max(0, sup.lead_time_days - expedite_lt_reduction)
                    order_idx_s = t - eff_lt
                    if order_idx_s >= 0:
                        lhs = lhs - supplier_order_vars[sup.supplier_id][order_idx_s]
            else:
                order_idx = t - lead_time
                if order_idx >= 0:
                    lhs = lhs - order_vars[order_idx]

            if t > 0:
                lhs = lhs - inv_vars[t - 1] + back_vars[t - 1]
            model.Add(lhs == const_rhs)
            _tag(f"BALANCE_INV[{sku},{t}]", "Inventory flow balance.", scope="sku_period", period=day.isoformat(), sku=sku)

        all_order_vars.extend(order_vars)

        if has_suppliers:
            # Per-supplier objective terms (with risk-driven expedite cost premium)
            for sup in sups:
                sid = sup.supplier_id
                effective_sup_cost = sup.unit_cost
                if is_expedited and expedite_cost_mult > 1.0:
                    effective_sup_cost = sup.unit_cost * expedite_cost_mult
                sup_order_coeff = max(1, coeff_order + int(round(effective_sup_cost * 10)))
                for v in supplier_order_vars[sid]:
                    obj_terms.append(sup_order_coeff * v)
                if sup.fixed_order_cost > 0:
                    fixed_coeff = int(round(sup.fixed_order_cost * OBJ_SCALE))
                    for v in supplier_y_vars[sid]:
                        obj_terms.append(fixed_coeff * v)
        else:
            for v in order_vars:
                obj_terms.append(order_coeff * v)
        for v in back_vars:
            obj_terms.append(back_coeff * v)
        if coeff_holding > 0:
            for v in inv_vars:
                obj_terms.append(coeff_holding * v)

        # V2 Feature 6: Safety stock soft constraint (with risk-driven per-SKU penalty)
        ss_slack_vars: Optional[List[Any]] = None
        if safety_stock_s_val > 0:
            ss_slack_vars = [model.NewIntVar(0, safety_stock_s_val, f"ss_slack_{var_tag}_{t}") for t in range(T)]
            for t in range(T):
                model.Add(inv_vars[t] + ss_slack_vars[t] >= safety_stock_s_val)
                _tag(f"SAFETY_STOCK[{sku},{t}]", "Safety stock soft floor.", severity="soft", scope="sku_period", period=days_list[t].isoformat(), sku=sku)
            # Per-SKU penalty: multiply global ss_penalty by risk-driven multiplier
            ss_mult = ss_penalty_by_key.get(sku_key_str, 1.0)
            eff_ss_coeff = int(round(safety_stock_penalty * ss_mult * OBJ_SCALE))
            if eff_ss_coeff > 0:
                for v in ss_slack_vars:
                    obj_terms.append(eff_ss_coeff * v)

        sku_var_maps[key] = {
            "order": order_vars, "inv": inv_vars, "back": back_vars, "y": y_vars, "k": k_vars, "ss_slack": ss_slack_vars,
            "supplier_order": supplier_order_vars if has_suppliers else {},
            "supplier_y": supplier_y_vars if has_suppliers else {},
        }
        sku_meta[key] = {
            "days": days_list, "demand_s": demand_s_list, "lead_time": lead_time, "safety_stock_s": safety_stock_s_val,
            "suppliers": sups if has_suppliers else [],
            "lead_time_original": original_lead_time,
            "expedited": is_expedited,
            "expedite_lt_reduction": expedite_lt_reduction if is_expedited else 0,
            "expedite_cost_mult": expedite_cost_mult if is_expedited else 1.0,
            "dual_source_enforced": bool(has_suppliers and sku_key_str in dual_source_keys and len(sups) >= 2),
            "ss_penalty_mult": ss_penalty_by_key.get(sku_key_str, 1.0),
        }

    if not sku_var_maps:
        return _empty_response(
            t0,
            "INFEASIBLE",
            ["No valid SKU/plant data could be planned."],
            settings=solver_settings,
            termination_reason="INVALID_INPUT",
        )

    all_days = sorted(order_vars_by_day.keys())
    production_cap_by_day_s: Dict[date, int] = {}
    inventory_cap_by_day_s: Dict[date, int] = {}

    if prod_cap_raw is not None:
        for idx, day in enumerate(all_days):
            cap = _capacity_for_period(prod_cap_raw, idx, day)
            if cap is None:
                continue
            cap_s = _s(max(0.0, cap))
            production_cap_by_day_s[day] = cap_s
            model.Add(sum(order_vars_by_day.get(day, [])) <= cap_s)
            _tag(f"CAP_PROD[{day.isoformat()}]", "Shared production/order capacity across SKUs.", scope="period", period=day.isoformat())

    if inv_cap_raw is not None:
        for idx, day in enumerate(all_days):
            cap = _capacity_for_period(inv_cap_raw, idx, day)
            if cap is None:
                continue
            cap_s = _s(max(0.0, cap))
            inventory_cap_by_day_s[day] = cap_s
            model.Add(sum(inv_vars_by_day.get(day, [])) <= cap_s)
            _tag(f"CAP_INV[{day.isoformat()}]", "Shared inventory capacity across SKUs.", scope="period", period=day.isoformat())

    budget_cap_s: Optional[int] = None
    budget_mode_effective: Optional[str] = None
    if budget_cap is not None and all_order_vars:
        auto_cost_budget = any(v > 0.0 for v in unit_cost_map.values())
        use_cost_budget = budget_mode == "spend" or (budget_mode not in {"quantity"} and auto_cost_budget)
        if use_cost_budget:
            spend_terms: List[Any] = []
            for key in ordered_keys:
                if key not in sku_var_maps:
                    continue
                sku = key[0]
                coeff = max(0, int(round(max(0.0, unit_cost_map.get(sku, 1.0)) * SCALE)))
                for v in sku_var_maps[key]["order"]:
                    spend_terms.append(coeff * v)
            budget_cap_cost_s2 = int(round(budget_cap * SCALE * SCALE))
            model.Add(sum(spend_terms) <= budget_cap_cost_s2)
            budget_mode_effective = "spend"
            _tag("BUDGET_GLOBAL", "Shared budget cap across all SKUs (spend).")
        else:
            budget_cap_s = _s(budget_cap)
            model.Add(sum(all_order_vars) <= budget_cap_s)
            budget_mode_effective = "quantity"
            _tag("BUDGET_GLOBAL", "Shared budget cap across all SKUs (quantity).")

    service_level_demand_basis_s = (
        total_demand_s_for_service_level
        if (use_p90_for_service_level and total_demand_s_for_service_level > 0)
        else total_demand_s_global
    )
    service_level_basis_label = (
        "p90_or_p50"
        if (use_p90_for_service_level and total_demand_s_for_service_level > 0)
        else "p50"
    )
    if service_level_target is not None:
        allowed_backlog = int(round(max(0.0, 1.0 - service_level_target) * service_level_demand_basis_s))
        end_back_vars = [vars_["back"][-1] for vars_ in sku_var_maps.values() if vars_["back"]]
        if end_back_vars:
            model.Add(sum(end_back_vars) <= allowed_backlog)
            _tag("SERVICE_LEVEL_GLOBAL", "Hard end-of-horizon service-level target.")

    # V2 Feature 4: Per-period budget constraints
    budget_per_period_cap_s: Dict[date, int] = {}
    budget_per_period_mode: Optional[str] = None
    if budget_per_period_raw is not None:
        auto_cost = any(v > 0.0 for v in unit_cost_map.values())
        use_cost = budget_mode == "spend" or (budget_mode not in {"quantity"} and auto_cost)
        budget_per_period_mode = "spend" if use_cost else "quantity"
        for idx, day in enumerate(all_days):
            cap = _capacity_for_period(budget_per_period_raw, idx, day)
            if cap is None:
                continue
            if use_cost:
                spend_day: List[Any] = []
                for k2 in ordered_keys:
                    if k2 not in sku_var_maps:
                        continue
                    sk = k2[0]
                    m2 = sku_meta[k2]
                    coeff_c = max(0, int(round(max(0.0, unit_cost_map.get(sk, 1.0)) * SCALE)))
                    for t_idx, d in enumerate(m2["days"]):
                        if d == day:
                            spend_day.append(coeff_c * sku_var_maps[k2]["order"][t_idx])
                if spend_day:
                    cap_s2 = int(round(cap * SCALE * SCALE))
                    model.Add(sum(spend_day) <= cap_s2)
                    budget_per_period_cap_s[day] = cap_s2
            else:
                day_orders = order_vars_by_day.get(day, [])
                if day_orders:
                    cap_s_pp = _s(cap)
                    model.Add(sum(day_orders) <= cap_s_pp)
                    budget_per_period_cap_s[day] = cap_s_pp
            _tag(f"BUDGET_PERIOD[{day.isoformat()}]", "Per-period budget cap.", scope="period", period=day.isoformat())

    # V2 Feature 5: Volume-based inventory capacity
    volume_cap_by_day_s: Dict[date, int] = {}
    if volume_cap_raw is not None and sku_volume_map:
        for idx, day in enumerate(all_days):
            cap = _capacity_for_period(volume_cap_raw, idx, day)
            if cap is None:
                continue
            cap_s2 = int(round(cap * SCALE * SCALE))
            vol_terms: List[Any] = []
            for k2 in ordered_keys:
                if k2 not in sku_var_maps:
                    continue
                vol = sku_volume_map.get(k2[0], 0.0)
                if vol <= 0.0:
                    continue
                vol_coeff = max(0, int(round(vol * SCALE)))
                m2 = sku_meta[k2]
                for t_idx, d in enumerate(m2["days"]):
                    if d == day:
                        vol_terms.append(vol_coeff * sku_var_maps[k2]["inv"][t_idx])
            if vol_terms:
                model.Add(sum(vol_terms) <= cap_s2)
                volume_cap_by_day_s[day] = cap_s2
                _tag(f"CAP_VOL[{day.isoformat()}]", "Volume-based inventory capacity.", scope="period", period=day.isoformat())

    # V2 Feature 5: Weight-based inventory capacity
    weight_cap_by_day_s: Dict[date, int] = {}
    if weight_cap_raw is not None and sku_weight_map:
        for idx, day in enumerate(all_days):
            cap = _capacity_for_period(weight_cap_raw, idx, day)
            if cap is None:
                continue
            cap_s2 = int(round(cap * SCALE * SCALE))
            wt_terms: List[Any] = []
            for k2 in ordered_keys:
                if k2 not in sku_var_maps:
                    continue
                wt = sku_weight_map.get(k2[0], 0.0)
                if wt <= 0.0:
                    continue
                wt_coeff = max(0, int(round(wt * SCALE)))
                m2 = sku_meta[k2]
                for t_idx, d in enumerate(m2["days"]):
                    if d == day:
                        wt_terms.append(wt_coeff * sku_var_maps[k2]["inv"][t_idx])
            if wt_terms:
                model.Add(sum(wt_terms) <= cap_s2)
                weight_cap_by_day_s[day] = cap_s2
                _tag(f"CAP_WEIGHT[{day.isoformat()}]", "Weight-based inventory capacity.", scope="period", period=day.isoformat())

    if obj_terms:
        model.Minimize(sum(obj_terms))

    solver = _cp_model.CpSolver()
    _apply_solver_run_settings(solver, solver_settings)

    cp_status, stop_requested = _solve_with_cancel_support(solver, model, cancel_check=cancel_check)
    solve_time_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
    status_info = _status_from_cp(
        cp_status,
        solver,
        solver_settings,
        solve_time_ms,
        stop_requested=stop_requested,
    )

    if not status_info.has_feasible_solution:
        suspected_tags: List[str] = []
        if production_cap_by_day_s:
            suspected_tags.append("CAP_PROD")
        if inventory_cap_by_day_s:
            suspected_tags.append("CAP_INV")
        if budget_cap is not None:
            suspected_tags.append("BUDGET_GLOBAL")
        if service_level_target is not None:
            suspected_tags.append("SERVICE_LEVEL_GLOBAL")
        if not suspected_tags:
            suspected_tags.extend(["BALANCE_INV", "MOQ", "PACK", "MAXQ"])

        infeasibility_analysis = _summarize_infeasibility(suspected_tags)
        relaxation_analysis: List[Dict[str, Any]] = []
        if diagnose_mode and not internal_diagnose:
            relaxation_analysis = _run_relaxation_analysis_single(payload)
            restoring = [r["relaxed_tags"][0] for r in relaxation_analysis if r.get("feasible_after_relaxation")]
            if restoring:
                infeasibility_analysis = _summarize_infeasibility(restoring)
        relaxation_applied = _build_relaxation_summary(relaxation_analysis)

        diagnostics: Dict[str, Any] = {}
        if diagnose_mode and not internal_diagnose:
            diagnostics = {
                "mode": "progressive_relaxation",
                "relaxation_analysis": relaxation_analysis,
            }

        reasons_detailed = [{
            "category": c,
            "top_offending_tags": infeasibility_analysis["top_offending_tags"][:8],
            "suggested_actions": infeasibility_analysis["suggestions"][:4],
            "message": (
                f"Infeasible category '{c}'. "
                f"Likely conflicting tags: {', '.join(infeasibility_analysis['top_offending_tags'][:5])}."
            ),
        } for c in infeasibility_analysis["categories"]]

        constraints_checked: List[Dict[str, Any]] = [
            _mk_constraint_check(
                name="model_feasibility",
                tag="CP_FEASIBILITY",
                passed=False,
                details=f"CP-SAT status '{status_info.status_name}' ({status_info.termination_reason}).",
                description="Overall model feasibility status.",
            ),
        ]
        if budget_cap is not None:
            constraints_checked.append(_mk_constraint_check(
                name="budget_cap",
                tag="BUDGET_GLOBAL",
                passed=False,
                details="Budget family participates in infeasibility candidate set.",
                description="Shared budget cap across SKUs.",
            ))
        if production_cap_by_day_s:
            prod_period_tags = [f"CAP_PROD[{day.isoformat()}]" for day in sorted(production_cap_by_day_s.keys())]
            constraints_checked.append(_mk_constraint_check(
                name="shared_production_cap",
                tag="CAP_PROD",
                passed=False,
                details="Shared production capacity family participates in infeasibility candidate set.",
                description="Shared production capacity per period.",
                scope="period",
                tags=prod_period_tags,
            ))
        if inventory_cap_by_day_s:
            inv_period_tags = [f"CAP_INV[{day.isoformat()}]" for day in sorted(inventory_cap_by_day_s.keys())]
            constraints_checked.append(_mk_constraint_check(
                name="shared_inventory_cap",
                tag="CAP_INV",
                passed=False,
                details="Shared inventory capacity family participates in infeasibility candidate set.",
                description="Shared inventory capacity per period.",
                scope="period",
                tags=inv_period_tags,
            ))
        if service_level_target is not None:
            constraints_checked.append(_mk_constraint_check(
                name="service_level_target",
                tag="SERVICE_LEVEL_GLOBAL",
                passed=False,
                details="Hard service-level target may conflict with other constraints.",
                description="Hard end-of-horizon service-level target.",
            ))

        return finalize_planning_response(
            {
                "status": status_info.status.value,
                "plan_lines": [],
                "kpis": {
                    "estimated_service_level": None,
                    "estimated_stockout_units": None,
                    "estimated_holding_units": None,
                    "estimated_total_cost": None,
                },
                "shared_kpis": {
                    "total_cost": None,
                    "total_stockout_units": None,
                    "budget": None,
                    "production_capacity": None,
                    "inventory_capacity": None,
                },
                "binding_constraints": [],
                "shadow_prices": None,
                "relaxation_applied": relaxation_applied,
                "solver_meta": _build_solver_meta(
                    status_info=status_info,
                    settings=solver_settings,
                    solve_time_ms=solve_time_ms,
                    objective_value=None,
                    best_bound=None,
                    gap=None,
                ),
                "infeasible_reasons": [r["message"] for r in reasons_detailed],
                "infeasible_reason_details": reasons_detailed,
                "infeasible_reasons_detailed": reasons_detailed,
                "diagnostics": diagnostics,
                "proof": {
                    "objective_terms": [],
                    "constraints_checked": constraints_checked,
                    "constraint_tags": constraint_tags,
                    "infeasibility_analysis": infeasibility_analysis,
                    "relaxation_analysis": relaxation_analysis,
                    "diagnose_mode": bool(diagnose_mode),
                },
            },
            default_engine="cp_sat",
            default_status=status_info.status,
        )

    plan_rows: List[Dict[str, Any]] = []
    total_order_qty = 0.0
    total_spend = 0.0
    total_stockout = 0.0
    total_holding = 0.0
    total_demand = 0.0
    end_backlog_total = 0.0
    infeasible_reasons: List[str] = []
    infeasible_reasons_detailed: List[Dict[str, Any]] = []
    moq_failed = pack_failed = max_failed = nonneg_failed = 0

    for key in ordered_keys:
        if key not in sku_var_maps:
            continue
        sku, plant_id = key
        vars_ = sku_var_maps[key]
        meta = sku_meta[key]
        days_list = meta["days"]
        demand_s_list = meta["demand_s"]
        lead_time = meta["lead_time"]
        sku_moq_s = moq_s.get(sku, 0)
        sku_pack_s_val = pack_s.get(sku, 0)
        sku_max_s_val = maxq_s.get(sku, 0)
        sku_unit_cost = max(0.0, unit_cost_map.get(sku, 0.0))

        if vars_["back"]:
            end_backlog_total += _us(int(solver.Value(vars_["back"][-1])))

        for t in range(len(days_list)):
            order_val_s = int(solver.Value(vars_["order"][t]))
            inv_val_s = int(solver.Value(vars_["inv"][t]))
            back_val_s = int(solver.Value(vars_["back"][t]))

            total_demand += _us(demand_s_list[t])
            total_stockout += _us(back_val_s)
            total_holding += _us(inv_val_s)

            sup_vars = vars_.get("supplier_order", {})
            meta_sups = meta.get("suppliers", [])
            if order_val_s > 0 and meta_sups:
                # V2: Multi-supplier plan lines
                order_day = days_list[t]
                for sup in meta_sups:
                    sid = sup.supplier_id
                    s_val_s = int(solver.Value(sup_vars[sid][t]))
                    if s_val_s > 0:
                        s_qty = _us(s_val_s)
                        arrival_day = order_day + timedelta(days=sup.lead_time_days)
                        plan_rows.append({
                            "sku": sku,
                            "plant_id": plant_id or None,
                            "supplier_id": sid,
                            "order_date": order_day.isoformat(),
                            "arrival_date": arrival_day.isoformat(),
                            "order_qty": float(round(s_qty, 6)),
                        })
                        total_order_qty += s_qty
                        total_spend += s_qty * sup.unit_cost
            elif order_val_s > 0:
                # Single-supplier path (backward compatible)
                order_qty = _us(order_val_s)
                order_day = days_list[t]
                arrival_day = order_day + timedelta(days=lead_time)
                plan_rows.append({
                    "sku": sku,
                    "plant_id": plant_id or None,
                    "order_date": order_day.isoformat(),
                    "arrival_date": arrival_day.isoformat(),
                    "order_qty": float(round(order_qty, 6)),
                })
                total_order_qty += order_qty
                total_spend += order_qty * sku_unit_cost

            if order_val_s > 0:
                order_qty = _us(order_val_s)
                if order_qty < -1e-9:
                    nonneg_failed += 1
                if sku_moq_s > 0 and order_val_s < sku_moq_s - 1:
                    moq_failed += 1
                if sku_pack_s_val > SCALE and order_val_s % sku_pack_s_val > 1:
                    pack_failed += 1
                if sku_max_s_val > 0 and order_val_s > sku_max_s_val + 1:
                    max_failed += 1

    plan_rows.sort(key=lambda r: (r["sku"], r.get("plant_id") or "", r["order_date"]))

    # V2 Feature 6: Extract safety stock violations
    ss_violations: Dict[str, List[Dict[str, Any]]] = {}
    total_ss_violation_periods = 0
    for key in ordered_keys:
        if key not in sku_var_maps:
            continue
        sku_k, plant_k = key
        vars_ = sku_var_maps[key]
        meta_ = sku_meta[key]
        if vars_.get("ss_slack"):
            safety_stock_real = _us(meta_.get("safety_stock_s", 0))
            for t in range(len(meta_["days"])):
                slack_val = _us(int(solver.Value(vars_["ss_slack"][t])))
                if slack_val > 1e-6:
                    total_ss_violation_periods += 1
                    ss_violations.setdefault(sku_k, []).append({
                        "period": meta_["days"][t].isoformat(),
                        "shortfall": round(slack_val, 4),
                        "safety_stock_target": round(safety_stock_real, 4),
                        "actual_inventory": round(_us(int(solver.Value(vars_["inv"][t]))), 4),
                    })

    # V2 Feature 4: Per-period budget verification
    budget_pp_usage_by_day: Dict[date, float] = {}
    budget_pp_failed = 0
    if budget_per_period_cap_s:
        for day in sorted(budget_per_period_cap_s.keys()):
            if budget_per_period_mode == "spend":
                used_s2 = 0
                for k2 in ordered_keys:
                    if k2 not in sku_var_maps:
                        continue
                    sk = k2[0]
                    m2 = sku_meta[k2]
                    coeff_c = max(0, int(round(max(0.0, unit_cost_map.get(sk, 1.0)) * SCALE)))
                    for t_idx, d in enumerate(m2["days"]):
                        if d == day:
                            used_s2 += coeff_c * int(solver.Value(sku_var_maps[k2]["order"][t_idx]))
                budget_pp_usage_by_day[day] = used_s2 / (SCALE * SCALE) if SCALE else 0.0
            else:
                used_s = sum(int(solver.Value(v)) for v in order_vars_by_day.get(day, []))
                budget_pp_usage_by_day[day] = _us(used_s)
            cap_real = budget_pp_usage_by_day[day]
            cap_limit = budget_per_period_cap_s[day] / (SCALE * SCALE) if budget_per_period_mode == "spend" else _us(budget_per_period_cap_s[day])
            if cap_real > cap_limit + 1e-6:
                budget_pp_failed += 1

    # V2 Feature 5: Volume/weight verification
    volume_usage_by_day: Dict[date, float] = {}
    volume_failed = 0
    if volume_cap_by_day_s:
        for day in sorted(volume_cap_by_day_s.keys()):
            used_s2 = 0
            for k2 in ordered_keys:
                if k2 not in sku_var_maps:
                    continue
                vol = sku_volume_map.get(k2[0], 0.0)
                if vol <= 0.0:
                    continue
                vol_coeff = max(0, int(round(vol * SCALE)))
                m2 = sku_meta[k2]
                for t_idx, d in enumerate(m2["days"]):
                    if d == day:
                        used_s2 += vol_coeff * int(solver.Value(sku_var_maps[k2]["inv"][t_idx]))
            volume_usage_by_day[day] = used_s2 / (SCALE * SCALE) if SCALE else 0.0
            if used_s2 > volume_cap_by_day_s[day] + 1:
                volume_failed += 1

    weight_usage_by_day: Dict[date, float] = {}
    weight_failed = 0
    if weight_cap_by_day_s:
        for day in sorted(weight_cap_by_day_s.keys()):
            used_s2 = 0
            for k2 in ordered_keys:
                if k2 not in sku_var_maps:
                    continue
                wt = sku_weight_map.get(k2[0], 0.0)
                if wt <= 0.0:
                    continue
                wt_coeff = max(0, int(round(wt * SCALE)))
                m2 = sku_meta[k2]
                for t_idx, d in enumerate(m2["days"]):
                    if d == day:
                        used_s2 += wt_coeff * int(solver.Value(sku_var_maps[k2]["inv"][t_idx]))
            weight_usage_by_day[day] = used_s2 / (SCALE * SCALE) if SCALE else 0.0
            if used_s2 > weight_cap_by_day_s[day] + 1:
                weight_failed += 1

    service_level: Optional[float] = None
    if total_demand > 0.0:
        service_level = max(0.0, min(1.0, 1.0 - total_stockout / total_demand))

    est_cost = total_order_qty + stockout_penalty * total_stockout + holding_cost * total_holding

    production_usage_s_by_day = {
        day: sum(int(solver.Value(v)) for v in vars_)
        for day, vars_ in order_vars_by_day.items()
    }
    inventory_usage_s_by_day = {
        day: sum(int(solver.Value(v)) for v in vars_)
        for day, vars_ in inv_vars_by_day.items()
    }

    budget_passed = True
    budget_detail = "No budget cap provided."
    if budget_cap is not None:
        if budget_mode_effective == "spend":
            budget_passed = total_spend <= budget_cap + 1e-9
            budget_detail = f"Total spend {round(total_spend, 6)} vs cap {round(budget_cap, 6)}."
        else:
            budget_passed = total_order_qty <= budget_cap + 1e-9
            budget_detail = f"Total ordered qty {round(total_order_qty, 6)} vs cap {round(budget_cap, 6)}."
        if not budget_passed:
            infeasible_reasons.append("Shared budget cap exceeded.")
            infeasible_reasons_detailed.append({
                "category": "budget",
                "top_offending_tags": ["BUDGET_GLOBAL"],
                "suggested_actions": _suggestions_for_categories({"budget"}),
                "message": "Shared budget cap is violated.",
            })

    prod_failed = 0
    for day, cap_s in production_cap_by_day_s.items():
        if production_usage_s_by_day.get(day, 0) > cap_s + 1:
            prod_failed += 1

    inv_failed = 0
    for day, cap_s in inventory_cap_by_day_s.items():
        if inventory_usage_s_by_day.get(day, 0) > cap_s + 1:
            inv_failed += 1

    service_target_passed = True
    service_target_details = "No hard service_level_target provided."
    if service_level_target is not None:
        service_level_demand_basis_real = _us(service_level_demand_basis_s)
        allowed_backlog = max(0.0, (1.0 - service_level_target) * service_level_demand_basis_real)
        service_target_passed = end_backlog_total <= allowed_backlog + 1e-9
        service_target_details = (
            f"End backlog {round(end_backlog_total, 6)} vs allowed {round(allowed_backlog, 6)} "
            f"from service_level_target {round(service_level_target, 6)} using {service_level_basis_label} demand basis "
            f"{round(service_level_demand_basis_real, 6)}."
        )
        if not service_target_passed:
            infeasible_reasons.append("Hard service_level_target cannot be met.")
            infeasible_reasons_detailed.append({
                "category": "demand_infeasible",
                "top_offending_tags": ["SERVICE_LEVEL_GLOBAL"],
                "suggested_actions": _suggestions_for_categories({"demand_infeasible"}),
                "message": "Hard service-level target violated.",
            })

    # ── Compute slack, binding, and natural language for each constraint ──
    budget_slack: Optional[float] = None
    budget_binding = False
    budget_slack_unit: Optional[str] = None
    budget_nl: Optional[str] = None
    if budget_cap is not None:
        budget_used = total_spend if budget_mode_effective == "spend" else total_order_qty
        budget_slack = round(budget_cap - budget_used, 4)
        budget_slack_unit = "USD" if budget_mode_effective == "spend" else "units"
        budget_binding = budget_slack < budget_cap * 0.03  # within 3% of cap
        if budget_binding:
            budget_nl = f"Budget cap is nearly exhausted (remaining: {budget_slack:,.1f} {budget_slack_unit})."
        else:
            budget_nl = f"Budget utilization is healthy with {budget_slack:,.1f} {budget_slack_unit} remaining."

    # Production cap: min slack across all periods
    prod_min_slack: Optional[float] = None
    prod_binding = False
    prod_nl: Optional[str] = None
    if production_cap_by_day_s:
        slacks = []
        for day, cap_s in production_cap_by_day_s.items():
            used_s = production_usage_s_by_day.get(day, 0)
            slacks.append(_us(cap_s - used_s))
        prod_min_slack = round(min(slacks), 4) if slacks else None
        prod_binding = prod_min_slack is not None and prod_min_slack < 1.0
        if prod_binding:
            prod_nl = f"Production capacity is binding (tightest period slack: {prod_min_slack:,.1f} units)."

    # Inventory cap: min slack across all periods
    inv_min_slack: Optional[float] = None
    inv_binding = False
    inv_nl: Optional[str] = None
    if inventory_cap_by_day_s:
        slacks = []
        for day, cap_s in inventory_cap_by_day_s.items():
            used_s = inventory_usage_s_by_day.get(day, 0)
            slacks.append(_us(cap_s - used_s))
        inv_min_slack = round(min(slacks), 4) if slacks else None
        inv_binding = inv_min_slack is not None and inv_min_slack < 1.0
        if inv_binding:
            inv_nl = f"Inventory capacity is binding (tightest period slack: {inv_min_slack:,.1f} units)."

    # V2: Per-period budget binding detection
    budget_pp_min_slack: Optional[float] = None
    budget_pp_binding = False
    budget_pp_nl: Optional[str] = None
    if budget_per_period_cap_s:
        slacks = []
        for day in sorted(budget_per_period_cap_s.keys()):
            cap_real = budget_per_period_cap_s[day] / (SCALE * SCALE) if budget_per_period_mode == "spend" else _us(budget_per_period_cap_s[day])
            used_real = budget_pp_usage_by_day.get(day, 0.0)
            slacks.append(round(cap_real - used_real, 4))
        budget_pp_min_slack = min(slacks) if slacks else None
        budget_pp_binding = budget_pp_min_slack is not None and budget_pp_min_slack < max(1.0, (cap_real * 0.03 if cap_real else 1.0))
        if budget_pp_binding:
            budget_pp_nl = f"Per-period budget is binding (tightest slack: {budget_pp_min_slack:,.1f})."

    # V2: Volume capacity binding detection
    vol_min_slack: Optional[float] = None
    vol_binding = False
    vol_nl: Optional[str] = None
    if volume_cap_by_day_s:
        slacks = []
        for day in sorted(volume_cap_by_day_s.keys()):
            cap_real = volume_cap_by_day_s[day] / (SCALE * SCALE)
            used_real = volume_usage_by_day.get(day, 0.0)
            slacks.append(round(cap_real - used_real, 4))
        vol_min_slack = min(slacks) if slacks else None
        vol_binding = vol_min_slack is not None and vol_min_slack < 1.0
        if vol_binding:
            vol_nl = f"Volume capacity is binding (tightest slack: {vol_min_slack:,.1f})."

    # V2: Weight capacity binding detection
    wt_min_slack: Optional[float] = None
    wt_binding = False
    wt_nl: Optional[str] = None
    if weight_cap_by_day_s:
        slacks = []
        for day in sorted(weight_cap_by_day_s.keys()):
            cap_real = weight_cap_by_day_s[day] / (SCALE * SCALE)
            used_real = weight_usage_by_day.get(day, 0.0)
            slacks.append(round(cap_real - used_real, 4))
        wt_min_slack = min(slacks) if slacks else None
        wt_binding = wt_min_slack is not None and wt_min_slack < 1.0
        if wt_binding:
            wt_nl = f"Weight capacity is binding (tightest slack: {wt_min_slack:,.1f})."

    # V2: Safety stock binding detection
    ss_binding = total_ss_violation_periods > 0
    ss_nl = f"Safety stock breached in {total_ss_violation_periods} SKU-periods." if ss_binding else None

    moq_binding = moq_failed > 0
    moq_nl = f"MOQ violations on {moq_failed} rows." if moq_binding else None

    constraints_checked: List[Dict[str, Any]] = [
        _mk_constraint_check(
            name="order_qty_non_negative",
            tag="NONNEG",
            passed=nonneg_failed == 0,
            details=f"Negative quantity rows: {nonneg_failed}.",
            description="All planned order quantities must be non-negative.",
            scope="row",
            binding=nonneg_failed > 0,
        ),
        _mk_constraint_check(
            name="moq",
            tag="MOQ",
            passed=moq_failed == 0,
            details=f"Rows violating MOQ: {moq_failed}.",
            description="MOQ enforcement across SKU-period rows.",
            scope="sku_period",
            binding=moq_binding,
            slack=0.0 if moq_binding else None,
            slack_unit="units",
            natural_language=moq_nl,
        ),
        _mk_constraint_check(
            name="pack_size_multiple",
            tag="PACK",
            passed=pack_failed == 0,
            details=f"Rows violating pack-size multiple: {pack_failed}.",
            description="Pack-size multiple enforcement across SKU-period rows.",
            scope="sku_period",
            binding=pack_failed > 0,
        ),
        _mk_constraint_check(
            name="budget_cap",
            tag="BUDGET_GLOBAL",
            passed=budget_passed,
            details=budget_detail,
            description="Shared budget cap across all SKUs.",
            binding=budget_binding if budget_cap is not None else None,
            slack=budget_slack,
            slack_unit=budget_slack_unit,
            natural_language=budget_nl,
        ),
        _mk_constraint_check(
            name="max_order_qty",
            tag="MAXQ",
            passed=max_failed == 0,
            details=f"Rows violating max_order_qty: {max_failed}.",
            description="Max order quantity per SKU-period.",
            scope="sku_period",
            binding=max_failed > 0,
        ),
    ]
    if production_cap_by_day_s:
        prod_period_tags = [f"CAP_PROD[{day.isoformat()}]" for day in sorted(production_cap_by_day_s.keys())]
        constraints_checked.append(_mk_constraint_check(
            name="shared_production_cap",
            tag="CAP_PROD",
            passed=prod_failed == 0,
            details=f"Periods violating shared production cap: {prod_failed}.",
            description="Shared production/order capacity per period.",
            scope="period",
            tags=prod_period_tags,
            binding=prod_binding,
            slack=prod_min_slack,
            slack_unit="units",
            natural_language=prod_nl,
        ))
    if inventory_cap_by_day_s:
        inv_period_tags = [f"CAP_INV[{day.isoformat()}]" for day in sorted(inventory_cap_by_day_s.keys())]
        constraints_checked.append(_mk_constraint_check(
            name="shared_inventory_cap",
            tag="CAP_INV",
            passed=inv_failed == 0,
            details=f"Periods violating shared inventory cap: {inv_failed}.",
            description="Shared inventory capacity per period.",
            scope="period",
            tags=inv_period_tags,
            binding=inv_binding,
            slack=inv_min_slack,
            slack_unit="units",
            natural_language=inv_nl,
        ))
    if service_level_target is not None:
        constraints_checked.append(_mk_constraint_check(
            name="service_level_target",
            tag="SERVICE_LEVEL_GLOBAL",
            passed=service_target_passed,
            details=service_target_details,
            description="Hard end-of-horizon service-level target.",
        ))

    # V2: Safety stock constraint check
    constraints_checked.append(_mk_constraint_check(
        name="safety_stock",
        tag="SAFETY_STOCK",
        passed=total_ss_violation_periods == 0,
        details=f"Safety stock violations across {total_ss_violation_periods} SKU-periods.",
        description="Soft safety stock floor on inventory.",
        severity="soft",
        scope="sku_period",
        binding=ss_binding,
        natural_language=ss_nl,
    ))

    # V2: Per-period budget constraint check
    if budget_per_period_cap_s:
        pp_tags = [f"BUDGET_PERIOD[{day.isoformat()}]" for day in sorted(budget_per_period_cap_s.keys())]
        constraints_checked.append(_mk_constraint_check(
            name="budget_per_period",
            tag="BUDGET_PERIOD",
            passed=budget_pp_failed == 0,
            details=f"Periods violating per-period budget: {budget_pp_failed}.",
            description="Per-period budget cap.",
            scope="period",
            tags=pp_tags,
            binding=budget_pp_binding,
            slack=budget_pp_min_slack,
            slack_unit="USD" if budget_per_period_mode == "spend" else "units",
            natural_language=budget_pp_nl,
        ))

    # V2: Volume capacity constraint check
    if volume_cap_by_day_s:
        vol_tags = [f"CAP_VOL[{day.isoformat()}]" for day in sorted(volume_cap_by_day_s.keys())]
        constraints_checked.append(_mk_constraint_check(
            name="volume_capacity",
            tag="CAP_VOL",
            passed=volume_failed == 0,
            details=f"Periods violating volume capacity: {volume_failed}.",
            description="Volume-based inventory capacity per period.",
            scope="period",
            tags=vol_tags,
            binding=vol_binding,
            slack=vol_min_slack,
            slack_unit="volume_units",
            natural_language=vol_nl,
        ))

    # V2: Weight capacity constraint check
    if weight_cap_by_day_s:
        wt_tags = [f"CAP_WEIGHT[{day.isoformat()}]" for day in sorted(weight_cap_by_day_s.keys())]
        constraints_checked.append(_mk_constraint_check(
            name="weight_capacity",
            tag="CAP_WEIGHT",
            passed=weight_failed == 0,
            details=f"Periods violating weight capacity: {weight_failed}.",
            description="Weight-based inventory capacity per period.",
            scope="period",
            tags=wt_tags,
            binding=wt_binding,
            slack=wt_min_slack,
            slack_unit="weight_units",
            natural_language=wt_nl,
        ))

    if total_stockout > 1e-9:
        infeasible_reasons.append(
            f"Unmet demand backlog remains across horizon: {round(total_stockout, 6)} units."
        )
        reason_tags = []
        if production_cap_by_day_s:
            reason_tags.append("CAP_PROD")
        if inventory_cap_by_day_s:
            reason_tags.append("CAP_INV")
        if budget_cap is not None:
            reason_tags.append("BUDGET_GLOBAL")
        if service_level_target is not None:
            reason_tags.append("SERVICE_LEVEL_GLOBAL")
        infeasible_reasons_detailed.append({
            "category": "capacity" if reason_tags else "demand_infeasible",
            "top_offending_tags": reason_tags or ["BALANCE_INV"],
            "suggested_actions": _suggestions_for_categories({"capacity"} if reason_tags else {"demand_infeasible"}),
            "message": "Backlog remains under active hard constraints.",
        })

    all_passed = all(c["passed"] for c in constraints_checked)
    if status_info.status == PlanningStatus.TIMEOUT:
        status = PlanningStatus.TIMEOUT
    elif not all_passed:
        status = PlanningStatus.INFEASIBLE
    else:
        status = status_info.status if status_info.status in {
            PlanningStatus.OPTIMAL,
            PlanningStatus.FEASIBLE,
        } else PlanningStatus.FEASIBLE

    obj_int = float(solver.ObjectiveValue())
    bound_int = float(solver.BestObjectiveBound())
    obj_real = float(round(obj_int / (OBJ_SCALE * SCALE), 6))
    bound_real = float(round(bound_int / (OBJ_SCALE * SCALE), 6))
    gap = 0.0 if cp_status == _cp_model.OPTIMAL else float(round(abs(obj_int - bound_int) / max(abs(obj_int), 1.0), 6))

    budget_shared_kpi = None
    if budget_cap is not None:
        used = total_spend if budget_mode_effective == "spend" else total_order_qty
        budget_shared_kpi = {
            "mode": budget_mode_effective or "quantity",
            "used": round(used, 6),
            "cap": round(budget_cap, 6),
            "utilization": None if budget_cap <= 0 else round(used / budget_cap, 6),
        }

    production_shared_kpi = None
    if production_cap_by_day_s:
        period_rows: List[Dict[str, Any]] = []
        util_values: List[float] = []
        for day in sorted(production_cap_by_day_s.keys()):
            cap = _us(production_cap_by_day_s[day])
            used = _us(production_usage_s_by_day.get(day, 0))
            util = None if cap <= 0 else used / cap
            if util is not None:
                util_values.append(util)
            period_rows.append({
                "period": day.isoformat(),
                "used": round(used, 6),
                "cap": round(cap, 6),
                "utilization": None if util is None else round(util, 6),
            })
        production_shared_kpi = {
            "avg_utilization": None if not util_values else round(sum(util_values) / len(util_values), 6),
            "max_utilization": None if not util_values else round(max(util_values), 6),
            "binding_periods": [r["period"] for r in period_rows if (r["utilization"] or 0.0) >= 0.999],
            "periods": period_rows,
        }

    inventory_shared_kpi = None
    if inventory_cap_by_day_s:
        period_rows = []
        util_values = []
        for day in sorted(inventory_cap_by_day_s.keys()):
            cap = _us(inventory_cap_by_day_s[day])
            used = _us(inventory_usage_s_by_day.get(day, 0))
            util = None if cap <= 0 else used / cap
            if util is not None:
                util_values.append(util)
            period_rows.append({
                "period": day.isoformat(),
                "used": round(used, 6),
                "cap": round(cap, 6),
                "utilization": None if util is None else round(util, 6),
            })
        inventory_shared_kpi = {
            "avg_utilization": None if not util_values else round(sum(util_values) / len(util_values), 6),
            "max_utilization": None if not util_values else round(max(util_values), 6),
            "binding_periods": [r["period"] for r in period_rows if (r["utilization"] or 0.0) >= 0.999],
            "periods": period_rows,
        }

    # V2: Per-period budget shared KPI
    budget_pp_shared_kpi = None
    if budget_per_period_cap_s:
        pp_rows: List[Dict[str, Any]] = []
        pp_utils: List[float] = []
        for day in sorted(budget_per_period_cap_s.keys()):
            cap_real = budget_per_period_cap_s[day] / (SCALE * SCALE) if budget_per_period_mode == "spend" else _us(budget_per_period_cap_s[day])
            used_real = budget_pp_usage_by_day.get(day, 0.0)
            util_v = None if cap_real <= 0 else used_real / cap_real
            if util_v is not None:
                pp_utils.append(util_v)
            pp_rows.append({"period": day.isoformat(), "used": round(used_real, 6), "cap": round(cap_real, 6), "utilization": None if util_v is None else round(util_v, 6)})
        budget_pp_shared_kpi = {
            "mode": budget_per_period_mode or "quantity",
            "avg_utilization": None if not pp_utils else round(sum(pp_utils) / len(pp_utils), 6),
            "max_utilization": None if not pp_utils else round(max(pp_utils), 6),
            "binding_periods": [r["period"] for r in pp_rows if (r["utilization"] or 0.0) >= 0.999],
            "periods": pp_rows,
        }

    # V2: Volume capacity shared KPI
    volume_shared_kpi = None
    if volume_cap_by_day_s:
        v_rows: List[Dict[str, Any]] = []
        v_utils: List[float] = []
        for day in sorted(volume_cap_by_day_s.keys()):
            cap_real = volume_cap_by_day_s[day] / (SCALE * SCALE)
            used_real = volume_usage_by_day.get(day, 0.0)
            util_v = None if cap_real <= 0 else used_real / cap_real
            if util_v is not None:
                v_utils.append(util_v)
            v_rows.append({"period": day.isoformat(), "used": round(used_real, 6), "cap": round(cap_real, 6), "utilization": None if util_v is None else round(util_v, 6)})
        volume_shared_kpi = {
            "avg_utilization": None if not v_utils else round(sum(v_utils) / len(v_utils), 6),
            "max_utilization": None if not v_utils else round(max(v_utils), 6),
            "binding_periods": [r["period"] for r in v_rows if (r["utilization"] or 0.0) >= 0.999],
            "periods": v_rows,
        }

    # V2: Weight capacity shared KPI
    weight_shared_kpi = None
    if weight_cap_by_day_s:
        w_rows: List[Dict[str, Any]] = []
        w_utils: List[float] = []
        for day in sorted(weight_cap_by_day_s.keys()):
            cap_real = weight_cap_by_day_s[day] / (SCALE * SCALE)
            used_real = weight_usage_by_day.get(day, 0.0)
            util_v = None if cap_real <= 0 else used_real / cap_real
            if util_v is not None:
                w_utils.append(util_v)
            w_rows.append({"period": day.isoformat(), "used": round(used_real, 6), "cap": round(cap_real, 6), "utilization": None if util_v is None else round(util_v, 6)})
        weight_shared_kpi = {
            "avg_utilization": None if not w_utils else round(sum(w_utils) / len(w_utils), 6),
            "max_utilization": None if not w_utils else round(max(w_utils), 6),
            "binding_periods": [r["period"] for r in w_rows if (r["utilization"] or 0.0) >= 0.999],
            "periods": w_rows,
        }

    # V2 Feature 7: Binding constraints list
    binding_constraints = [c["name"] for c in constraints_checked if c.get("binding") is True]

    # V2 Feature 2: Shadow price analysis (opt-in)
    compute_sp = _to_bool(_read_path(payload, "settings.compute_shadow_prices", False), False)
    shadow_prices: Dict[str, Any] = {}
    if compute_sp and not internal_diagnose and status_info.has_feasible_solution:
        shadow_prices = _compute_shadow_prices(payload, constraints_checked, est_cost)
        for check in constraints_checked:
            sp_entry = shadow_prices.get(check["name"])
            if sp_entry:
                check["shadow_price_approx"] = sp_entry["shadow_price_approx"]
                if sp_entry.get("shadow_price_dual") is not None:
                    check["shadow_price_dual"] = sp_entry["shadow_price_dual"]
                check["shadow_price_unit"] = sp_entry["unit"]
                if sp_entry.get("method"):
                    check["shadow_price_method"] = sp_entry["method"]

    proof_infeasibility_tags = []
    for row in infeasible_reasons_detailed:
        proof_infeasibility_tags.extend(_as_list(row.get("top_offending_tags")))
    infeasibility_analysis = (
        _summarize_infeasibility(proof_infeasibility_tags)
        if proof_infeasibility_tags
        else {"categories": [], "top_offending_tags": [], "suggestions": []}
    )
    relaxation_analysis: List[Dict[str, Any]] = []
    if diagnose_mode and not internal_diagnose:
        relaxation_analysis = _run_relaxation_analysis_single(payload)
    relaxation_applied = _build_relaxation_summary(relaxation_analysis)
    diagnostics: Dict[str, Any] = {}
    if diagnose_mode and not internal_diagnose:
        diagnostics = {
            "mode": "progressive_relaxation",
            "relaxation_analysis": relaxation_analysis,
        }

    return finalize_planning_response(
        {
            "status": status.value,
            "plan_lines": plan_rows,
            "kpis": {
                "estimated_service_level": None if service_level is None else round(service_level, 6),
                "estimated_stockout_units": round(total_stockout, 6),
                "estimated_holding_units": round(total_holding, 6),
                "estimated_total_cost": round(est_cost, 6),
            },
            "shared_kpis": {
                "total_cost": round(est_cost, 6),
                "total_stockout_units": round(total_stockout, 6),
                "budget": budget_shared_kpi,
                "production_capacity": production_shared_kpi,
                "inventory_capacity": inventory_shared_kpi,
                "budget_per_period": budget_pp_shared_kpi,
                "volume_capacity": volume_shared_kpi,
                "weight_capacity": weight_shared_kpi,
                "safety_stock_violations": ss_violations if ss_violations else None,
            },
            "binding_constraints": binding_constraints,
            "shadow_prices": shadow_prices if shadow_prices else None,
            "relaxation_applied": relaxation_applied,
            "solver_meta": _build_solver_meta(
                status_info=SolverStatusInfo(
                    status=status,
                    termination_reason=status_info.termination_reason,
                    status_name=status_info.status_name,
                    has_feasible_solution=True,
                    time_limit_hit=status_info.time_limit_hit,
                ),
                settings=solver_settings,
                solve_time_ms=solve_time_ms,
                objective_value=obj_real,
                best_bound=bound_real,
                gap=gap,
                extra={
                    "deterministic_mode": bool(solver_settings.deterministic_mode),
                    "uncertainty_bridge": {
                        "safety_stock_alpha": round(safety_stock_alpha, 6),
                        "use_p90_for_safety_stock": bool(use_p90_for_safety_stock),
                        "use_p90_for_service_level": bool(use_p90_for_service_level),
                        "use_p90_demand_model": bool(use_p90_demand_model),
                        "service_level_demand_basis": service_level_basis_label,
                        "keys_with_p90": int(keys_with_p90),
                        "keys_with_derived_safety_stock": int(keys_with_derived_safety_stock),
                        "keys_with_closed_loop_safety_stock": int(keys_with_closed_loop_safety_stock),
                    },
                    "v2_features": {
                        "multi_supplier": bool(any(m.get("suppliers") for m in sku_meta.values())),
                        "shadow_prices": bool(shadow_prices),
                        "safety_stock_soft": bool(any(m.get("safety_stock_s", 0) > 0 for m in sku_meta.values())),
                        "per_period_budget": bool(budget_per_period_cap_s),
                        "volume_weight_capacity": bool(volume_cap_by_day_s or weight_cap_by_day_s),
                    },
                },
            ),
            "infeasible_reasons": sorted(set(infeasible_reasons)),
            "infeasible_reason_details": infeasible_reasons_detailed,
            "infeasible_reasons_detailed": infeasible_reasons_detailed,
            "diagnostics": diagnostics,
            "proof": {
                "objective_terms": [
                    {
                        "name": "ordered_units",
                        "value": round(total_order_qty, 6),
                        "note": "Total planned replenishment quantity.",
                        "units": "units",
                        "business_label": "Procurement volume",
                    },
                    {
                        "name": "stockout_units",
                        "value": round(total_stockout, 6),
                        "note": "Projected unmet demand units (backlog).",
                        "units": "units",
                        "business_label": "Shortage exposure",
                        "qty_driver": round(total_stockout, 6),
                        "unit_cost_driver": round(stockout_penalty, 6) if stockout_penalty else None,
                    },
                    {
                        "name": "holding_units",
                        "value": round(total_holding, 6),
                        "note": "Projected positive inventory accumulation.",
                        "units": "units",
                        "business_label": "Inventory holding",
                        "qty_driver": round(total_holding, 6),
                        "unit_cost_driver": round(holding_cost, 6) if holding_cost else None,
                    },
                    {
                        "name": "estimated_total_cost",
                        "value": round(est_cost, 6),
                        "note": "ordering_qty + stockout_penalty × backlog + holding_cost × inventory.",
                        "units": "cost_units",
                        "business_label": "Total plan cost",
                    },
                ],
                "constraints_checked": constraints_checked,
                "constraint_tags": constraint_tags,
                "infeasibility_analysis": infeasibility_analysis,
                "relaxation_analysis": relaxation_analysis,
                "diagnose_mode": bool(diagnose_mode),
            },
            "explain_summary": _build_explain_summary(
                status=status,
                constraints_checked=constraints_checked,
                objective_terms=[],
                total_stockout=total_stockout,
                stockout_penalty=stockout_penalty,
                total_spend=total_spend,
                budget_cap=budget_cap,
                budget_mode_effective=budget_mode_effective,
            ),
        },
        default_engine="cp_sat",
        default_status=status,
    )


# ── private helpers ────────────────────────────────────────────────────────────

def _s(v: float) -> int:
    """Scale a real float to an integer for CP-SAT (multiply by SCALE, round)."""
    return int(round(v * SCALE))


def _us(v: int) -> float:
    """Unscale a CP-SAT integer back to a real float."""
    return v / SCALE


def _parse_day(value: Any) -> Optional[date]:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        return datetime.strptime(raw[:10], "%Y-%m-%d").date()
    except Exception:
        return None


def _key(sku: Any, plant_id: Any) -> Tuple[str, str]:
    return (str(sku or "").strip(), str(plant_id or "").strip())


def _parse_sku_plant_key(raw_key: Any) -> Optional[Tuple[str, str]]:
    text = str(raw_key or "").strip()
    if not text:
        return None
    if "|" in text:
        sku, plant = text.split("|", 1)
    else:
        sku, plant = text, ""
    sku = sku.strip()
    plant = plant.strip()
    if not sku:
        return None
    return sku, plant


def _parse_keyed_scaled_qty_map(raw_map: Any) -> Dict[Tuple[str, str], int]:
    out: Dict[Tuple[str, str], int] = {}
    if not isinstance(raw_map, dict):
        return out
    for raw_key, raw_value in raw_map.items():
        parsed = _parse_sku_plant_key(raw_key)
        if parsed is None:
            continue
        out[parsed] = _s(max(0.0, _to_float(raw_value, 0.0)))
    return out


def _lookup_keyed_value(
    mapping: Dict[Tuple[str, str], Any],
    key: Tuple[str, str],
) -> Optional[Any]:
    if key in mapping:
        return mapping[key]
    sku, plant = key
    if plant and (sku, "") in mapping:
        return mapping[(sku, "")]
    return None


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        v = float(value)
        if math.isnan(v) or math.isinf(v):
            return default
        return v
    except Exception:
        return default


def _build_qty_map(rows: Any, attr: str) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for row in rows or []:
        sku = str(_read_attr(row, "sku", "") or "").strip()
        if not sku:
            continue
        v = _read_attr(row, attr, None)
        if v is None:
            continue
        out[sku] = _s(max(0.0, _to_float(v, 0.0)))
    return out


def _capacity_scalar_and_calendar(raw_value: Any) -> Tuple[Optional[float], Dict[date, float]]:
    """
    Parse either:
      - scalar capacity value
      - [{date, capacity}, ...] calendar
    and return (scalar_capacity, calendar_capacity_by_day).
    """
    if raw_value is None:
        return None, {}

    if isinstance(raw_value, (int, float, str)):
        cap = max(0.0, _to_float(raw_value, 0.0))
        return (cap if cap > 0.0 else None), {}

    rows = raw_value if isinstance(raw_value, list) else [raw_value]
    by_day: Dict[date, float] = {}
    for row in rows:
        if row is None:
            continue
        if isinstance(row, dict):
            cap_day = _parse_day(row.get("date"))
            cap_val = max(0.0, _to_float(row.get("capacity"), 0.0))
        else:
            cap_day = _parse_day(getattr(row, "date", None))
            cap_val = max(0.0, _to_float(getattr(row, "capacity", None), 0.0))
        if cap_day and cap_val > 0.0:
            by_day[cap_day] = cap_val
    return None, by_day


def _resolve_capacity_raw(payload: Any, section: str, attr: str) -> Any:
    section_obj = getattr(payload, section, None)
    if section_obj is None:
        return None
    return getattr(section_obj, attr, None)


def _resolve_inventory_capacity_single(payload: Any) -> Tuple[Optional[float], Dict[date, float]]:
    raw = _resolve_capacity_raw(payload, "constraints", "inventory_capacity_per_period")
    if raw is None:
        raw = _resolve_capacity_raw(payload, "multi_echelon", "inventory_capacity_per_period")
    return _capacity_scalar_and_calendar(raw)


def _resolve_shared_inventory_capacity_single(payload: Any) -> Tuple[Optional[float], Dict[date, float]]:
    raw = _resolve_capacity_raw(payload, "shared_constraints", "inventory_capacity_per_period")
    return _capacity_scalar_and_calendar(raw)


def _resolve_production_capacity_single(payload: Any) -> Tuple[Optional[float], Dict[date, float]]:
    raw = _resolve_capacity_raw(payload, "shared_constraints", "production_capacity_per_period")
    if raw is None:
        raw = _resolve_capacity_raw(payload, "constraints", "production_capacity_per_period")
    return _capacity_scalar_and_calendar(raw)


def _resolve_capacity_for_multi(payload: Any, attr: str) -> Tuple[Optional[float], Dict[date, float]]:
    raw = _resolve_capacity_raw(payload, "shared_constraints", attr)
    if raw is None:
        raw = _resolve_capacity_raw(payload, "multi_echelon", attr)
    if raw is None:
        raw = _resolve_capacity_raw(payload, "constraints", attr)
    return _capacity_scalar_and_calendar(raw)


def _resolve_budget_cap(payload: Any) -> Optional[float]:
    raw = _first_non_none(
        _read_path(payload, "shared_constraints.budget_cap", None),
        _read_path(payload, "constraints.budget_cap", None),
    )
    if raw is None:
        return None
    return max(0.0, _to_float(raw, 0.0))


def _resolve_priority_weights(payload: Any) -> Dict[str, float]:
    weights: Dict[str, float] = {}
    raw_weights = _read_path(payload, "shared_constraints.priority_weights", {}) or {}
    if isinstance(raw_weights, dict):
        for sku, val in raw_weights.items():
            key = str(sku or "").strip()
            if not key:
                continue
            weights[key] = max(0.01, _to_float(val, 1.0))

    for item in _read_attr(payload, "items", []) or []:
        sku = str(_read_attr(item, "sku", "")).strip()
        if not sku:
            continue
        priority_weight = _read_attr(item, "priority_weight", None)
        if priority_weight is None:
            continue
        weights[sku] = max(0.01, _to_float(priority_weight, 1.0))
    return weights


def _capacity_for_day(
    day: date,
    scalar_capacity: Optional[float],
    by_day_capacity: Dict[date, float],
) -> Optional[float]:
    if day in by_day_capacity:
        return by_day_capacity[day]
    return scalar_capacity


def _build_solver_meta(
    *,
    status_info: SolverStatusInfo,
    settings: SolverRunSettings,
    solve_time_ms: int,
    objective_value: Optional[float],
    best_bound: Optional[float],
    gap: Optional[float],
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "engine": "cp_sat",
        "solver": "cp_sat",
        "status": status_info.status.value,
        "termination_reason": status_info.termination_reason,
        "cp_status_name": status_info.status_name,
        "solve_time_ms": int(max(0, solve_time_ms)),
        "objective_value": objective_value,
        "best_bound": best_bound,
        "gap": gap,
        # Stable contract fields (preferred by contract v1.0)
        "time_limit": float(settings.time_limit_seconds),
        "seed": int(settings.random_seed),
        "workers": int(settings.num_search_workers),
        # Legacy/diagnostic fields retained for compatibility
        "time_limit_seconds": float(settings.time_limit_seconds),
        "max_time_in_seconds": float(settings.time_limit_seconds),
        "random_seed": int(settings.random_seed),
        "num_search_workers": int(settings.num_search_workers),
        "log_search_progress": bool(settings.log_search_progress),
        "deterministic_mode": bool(settings.deterministic_mode),
        "force_timeout_requested": bool(settings.force_timeout),
        "time_limit_hit": bool(status_info.time_limit_hit),
    }
    if extra:
        payload.update(extra)
    return payload


def _empty_response(
    t0: datetime,
    status: str,
    reasons: List[str],
    solve_time_ms: Optional[int] = None,
    settings: Optional[SolverRunSettings] = None,
    termination_reason: str = "NO_FEASIBLE_SOLUTION",
    status_name: str = "UNKNOWN",
) -> Dict[str, Any]:
    if solve_time_ms is None:
        solve_time_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
    normalized_status = normalize_status(status, PlanningStatus.ERROR)
    solver_settings = settings or SolverRunSettings(
        time_limit_seconds=DEFAULT_SOLVER_SINGLE_TIME_LIMIT_SECONDS,
        random_seed=DEFAULT_SOLVER_RANDOM_SEED,
        num_search_workers=DEFAULT_SOLVER_NUM_SEARCH_WORKERS,
        log_search_progress=DEFAULT_SOLVER_LOG_PROGRESS,
        deterministic_mode=DEFAULT_SOLVER_NUM_SEARCH_WORKERS == 1,
    )
    status_info = SolverStatusInfo(
        status=normalized_status,
        termination_reason=termination_reason,
        status_name=status_name,
        has_feasible_solution=False,
        time_limit_hit=normalized_status == PlanningStatus.TIMEOUT,
    )
    return finalize_planning_response({
        "status": status,
        "plan_lines": [],
        "kpis": {
            "estimated_service_level": None,
            "estimated_stockout_units": None,
            "estimated_holding_units": None,
            "estimated_total_cost": None,
        },
        "solver_meta": _build_solver_meta(
            status_info=status_info,
            settings=solver_settings,
            solve_time_ms=solve_time_ms,
            objective_value=None,
            best_bound=None,
            gap=None,
        ),
        "infeasible_reasons": reasons,
        "proof": {"objective_terms": [], "constraints_checked": []},
    }, default_engine="cp_sat", default_status=normalize_status(status, PlanningStatus.ERROR))


# ── multi-echelon private helpers ──────────────────────────────────────────────

def _infer_period_days_me(sorted_dates: List[Any]) -> int:
    """Return the median gap (in days) between consecutive planning-horizon dates."""
    if len(sorted_dates) <= 1:
        return 1
    deltas = []
    for i in range(1, len(sorted_dates)):
        days = int((sorted_dates[i] - sorted_dates[i - 1]).days)
        if days > 0:
            deltas.append(days)
    if not deltas:
        return 1
    deltas.sort()
    return max(1, deltas[len(deltas) // 2])


def _build_qty_map_me(rows: Any, attr: str) -> Dict[str, float]:
    """Return {sku: unscaled_float} from a list of constraint rows."""
    out: Dict[str, float] = {}
    for row in rows or []:
        sku = str(_read_attr(row, "sku", None) or "").strip()
        if not sku:
            continue
        v = _read_attr(row, attr, None)
        if v is None:
            continue
        out[sku] = max(0.0, _to_float(v, 0.0))
    return out


def _build_unit_cost_map_me(rows: Any) -> Dict[str, float]:
    """Return {sku: unit_cost_float} from a list of unit-cost constraint rows."""
    out: Dict[str, float] = {}
    for row in rows or []:
        sku = str(_read_attr(row, "sku", None) or "").strip()
        if not sku:
            continue
        v = _read_attr(row, "unit_cost", None)
        if v is None:
            continue
        out[sku] = max(0.0, _to_float(v, 0.0))
    return out


def _empty_response_me(
    t0: datetime,
    status: str,
    reasons: List[str],
    solve_time_ms: Optional[int] = None,
    settings: Optional[SolverRunSettings] = None,
    termination_reason: str = "NO_FEASIBLE_SOLUTION",
    status_name: str = "UNKNOWN",
) -> Dict[str, Any]:
    """Empty multi-echelon response (superset of single-echelon shape)."""
    if solve_time_ms is None:
        solve_time_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
    normalized_status = normalize_status(status, PlanningStatus.ERROR)
    solver_settings = settings or SolverRunSettings(
        time_limit_seconds=DEFAULT_SOLVER_MULTI_TIME_LIMIT_SECONDS,
        random_seed=DEFAULT_SOLVER_RANDOM_SEED,
        num_search_workers=DEFAULT_SOLVER_NUM_SEARCH_WORKERS,
        log_search_progress=DEFAULT_SOLVER_LOG_PROGRESS,
        deterministic_mode=DEFAULT_SOLVER_NUM_SEARCH_WORKERS == 1,
    )
    status_info = SolverStatusInfo(
        status=normalized_status,
        termination_reason=termination_reason,
        status_name=status_name,
        has_feasible_solution=False,
        time_limit_hit=normalized_status == PlanningStatus.TIMEOUT,
    )
    return finalize_planning_response({
        "status": status,
        "plan_lines": [],
        "component_plan": [],
        "component_inventory_projection": {"total_rows": 0, "rows": [], "truncated": False},
        "bottlenecks": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "items": [],
            "rows": [],
            "total_rows": 0,
        },
        "kpis": {
            "estimated_service_level": None,
            "estimated_stockout_units": None,
            "estimated_holding_units": None,
            "estimated_total_cost": None,
        },
        "solver_meta": _build_solver_meta(
            status_info=status_info,
            settings=solver_settings,
            solve_time_ms=solve_time_ms,
            objective_value=None,
            best_bound=None,
            gap=None,
            extra={"multi_echelon_mode": "bom_v0"},
        ),
        "infeasible_reasons": reasons,
        "proof": {"objective_terms": [], "constraints_checked": []},
    }, default_engine="cp_sat", default_status=normalize_status(status, PlanningStatus.ERROR))


# ── public multi-echelon API ───────────────────────────────────────────────────

def solve_replenishment_multi_echelon(
    payload: Any,
    run_settings: Optional[SolverRunSettings] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """
    Solve a BOM-coupled multi-echelon replenishment plan using OR-Tools CP-SAT.

    Decision variables per (item i, period t):
      order[i,t]  – int ≥ 0 : units ordered/produced at period t
      inv[i,t]    – int ≥ 0 : on-hand inventory at end of period t
      back[i,t]   – int ≥ 0 : backlog at end of period t
      y[i,t]      – bool    : 1 when an order is placed (MOQ enforcement)

    Item flow balance (supports multi-layer BOM):
      qty_scale * (inv[i,t] - back[i,t]) =
          qty_scale * (inv[i,t-1] - back[i,t-1] + arriving_i[t] - external_demand[i,t])
          - Σ_parent (usage[parent,i] * qty_scale) * produced_parent[t]

    Hard feasibility constraint (for every BOM child i):
      Σ_parent usage_scaled[parent,i] * produced_parent[t]
          <= qty_scale * (inv[i,t-1] + arriving_i[t])

    Parameters
    ----------
    payload : ReplenishmentPlanRequest (pydantic) or SimpleNamespace (tests)
        Required attributes: planning_horizon_days, demand_forecast.series,
        inventory, open_pos, constraints (moq/pack_size/max_order_qty/budget_cap/unit_costs),
        objective (holding_cost/stockout_penalty),
        multi_echelon (mode/lot_sizing_mode/max_bom_depth/bom_explosion_used/
                       bom_explosion_reused/production_capacity_per_period/
                       inventory_capacity_per_period/component_stockout_penalty),
        bom_usage ([{fg_sku, component_sku, plant_id, usage_qty}]).

    Returns
    -------
    dict – superset of solve_replenishment schema; additional keys:
        component_plan, component_inventory_projection, bottlenecks,
        plus multi-echelon fields in solver_meta and proof.
    """
    if not _ORTOOLS_OK:
        raise RuntimeError("ortools is not installed; cannot use CP-SAT multi-echelon solver")

    solver_settings = run_settings or _resolve_solver_run_settings(
        payload,
        default_time_limit_seconds=DEFAULT_SOLVER_MULTI_TIME_LIMIT_SECONDS,
    )
    diagnose_mode = _to_bool(
        _first_non_none(
            _read_attr(payload, "diagnose_mode", None),
            _read_path(payload, "settings.diagnose_mode", None),
        ),
        False,
    )
    internal_diagnose = _to_bool(_read_attr(payload, "_internal_diagnose", None), False)

    t0 = datetime.now(timezone.utc)
    if bool(getattr(solver_settings, "force_timeout", False)):
        return _empty_response_me(
            t0,
            "TIMEOUT",
            ["Forced timeout via settings.solver.force_timeout=true."],
            settings=solver_settings,
            termination_reason="FORCED_TIMEOUT",
            status_name="FORCED_TIMEOUT",
        )
    qty_scale: int = 1_000   # quantities: 1 real unit = qty_scale integer units
    cost_scale: int = 100    # cost coefficients (different from OBJ_SCALE in single-echelon)
    constraint_tags: List[Dict[str, Any]] = []

    def _tag(
        tag: str,
        description: str,
        *,
        severity: str = "hard",
        scope: str = "global",
        period: Optional[str] = None,
        sku: Optional[str] = None,
        echelon: str = "multi",
    ) -> None:
        constraint_tags.append({
            "tag": tag,
            "description": description,
            "severity": severity,
            "scope": scope,
            "period": period,
            "sku": sku,
            "echelon": echelon,
        })

    # ── 1. parse FG demand ────────────────────────────────────────────────────
    horizon_days = max(1, int(payload.planning_horizon_days or 1))
    demand_rows_by_fg: Dict[Tuple[str, str], List[Tuple[Any, float]]] = {}
    for pt in payload.demand_forecast.series or []:
        sku = str(getattr(pt, "sku", None) or "").strip()
        if not sku:
            continue
        d = _parse_day(pt.date)
        if not d:
            continue
        key = _key(pt.sku, pt.plant_id)
        demand_rows_by_fg.setdefault(key, []).append((d, max(0.0, _to_float(pt.p50, 0.0))))

    for key in list(demand_rows_by_fg.keys()):
        rows = sorted(demand_rows_by_fg[key], key=lambda r: r[0])
        if not rows:
            del demand_rows_by_fg[key]
            continue
        first_day = rows[0][0]
        last_day = first_day + timedelta(days=horizon_days - 1)
        filtered = [(d, q) for d, q in rows if d <= last_day]
        if filtered:
            demand_rows_by_fg[key] = filtered
        else:
            del demand_rows_by_fg[key]

    if not demand_rows_by_fg:
        return _empty_response_me(
            t0,
            "INFEASIBLE",
            ["No valid demand_forecast.series rows within horizon."],
            settings=solver_settings,
            termination_reason="INVALID_INPUT",
        )

    fg_keys = sorted(demand_rows_by_fg.keys(), key=lambda k: (k[0], k[1]))
    horizon_dates = sorted({d for rows in demand_rows_by_fg.values() for d, _ in rows})
    if not horizon_dates:
        return _empty_response_me(
            t0,
            "INFEASIBLE",
            ["No horizon dates could be derived from demand series."],
            settings=solver_settings,
            termination_reason="INVALID_INPUT",
        )

    period_days = _infer_period_days_me(horizon_dates)
    day_to_idx = {d: i for i, d in enumerate(horizon_dates)}
    n_periods = len(horizon_dates)

    # ── 2. parse raw BOM rows (resolve plant + graph later) ──────────────────
    raw_bom_rows: List[Dict[str, Any]] = []
    for usage in payload.bom_usage or []:
        parent_sku = str(getattr(usage, "fg_sku", None) or "").strip()
        child_sku = str(getattr(usage, "component_sku", None) or "").strip()
        usage_qty = max(0.0, _to_float(getattr(usage, "usage_qty", 0.0), 0.0))
        usage_plant = str(getattr(usage, "plant_id", None) or "").strip()
        if not parent_sku or not child_sku or usage_qty <= 0.0:
            continue
        if parent_sku == child_sku:
            continue
        raw_bom_rows.append(
            {
                "parent_sku": parent_sku,
                "child_sku": child_sku,
                "usage_qty": usage_qty,
                "plant_id": usage_plant,
                "level": getattr(usage, "level", None),
            }
        )

    if not raw_bom_rows:
        return _empty_response_me(
            t0,
            "INFEASIBLE",
            ["No valid BOM usage rows were provided; multi-echelon requires bom_usage."],
            settings=solver_settings,
            termination_reason="INVALID_INPUT",
        )

    # ── 3. inventory seed ─────────────────────────────────────────────────────
    inventory_state: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for row in payload.inventory or []:
        key = _key(row.sku, row.plant_id)
        d = _parse_day(row.as_of_date)
        if not d:
            continue
        prev = inventory_state.get(key)
        if not prev or d > prev["as_of_date"]:
            inventory_state[key] = {
                "as_of_date": d,
                "on_hand": max(0.0, _to_float(row.on_hand, 0.0)),
                "safety_stock": max(0.0, _to_float(row.safety_stock, 0.0))
                    if getattr(row, "safety_stock", None) is not None else 0.0,
                "lead_time_days": max(0.0, _to_float(row.lead_time_days, 0.0))
                    if getattr(row, "lead_time_days", None) is not None else 0.0,
            }

    # ── 4. open PO calendar (index-based) ─────────────────────────────────────
    open_pos_by_key_idx: Dict[Tuple[str, str], Dict[int, float]] = {}
    for po in payload.open_pos or []:
        eta_day = _parse_day(po.eta_date)
        if not eta_day or eta_day not in day_to_idx:
            continue
        key = _key(po.sku, po.plant_id)
        idx = day_to_idx[eta_day]
        bucket = open_pos_by_key_idx.setdefault(key, {})
        bucket[idx] = bucket.get(idx, 0.0) + max(0.0, _to_float(po.qty, 0.0))

    # ── 5. resolve BOM edges to item keys (multi-layer parent→child graph) ───
    usage_float: Dict[Tuple[Tuple[str, str], Tuple[str, str]], float] = {}
    sku_to_plants: Dict[str, Set[str]] = {}
    seed_keys = list(fg_keys) + list(inventory_state.keys()) + list(open_pos_by_key_idx.keys())
    for sku, plant in seed_keys:
        sku_to_plants.setdefault(sku, set()).add(plant)

    distinct_plants = sorted({plant for _, plant in seed_keys if plant})
    pending_rows = sorted(
        raw_bom_rows,
        key=lambda r: (
            0 if _to_float(r.get("level"), -1.0) >= 0.0 else 1,
            int(_to_float(r.get("level"), 10_000.0)),
            r["parent_sku"],
            r["child_sku"],
        ),
    )
    resolved_any = True
    while pending_rows and resolved_any:
        resolved_any = False
        next_pending: List[Dict[str, Any]] = []
        for row in pending_rows:
            parent_sku = row["parent_sku"]
            child_sku = row["child_sku"]
            usage_qty = float(row["usage_qty"])
            usage_plant = str(row.get("plant_id") or "").strip()

            candidate_plants: Set[str] = set()
            if usage_plant:
                candidate_plants.add(usage_plant)
            else:
                candidate_plants.update(sku_to_plants.get(parent_sku, set()))
                if not candidate_plants:
                    candidate_plants.update(sku_to_plants.get(child_sku, set()))
                if not candidate_plants:
                    candidate_plants.update({k[1] for k in fg_keys if k[0] == parent_sku})
                if not candidate_plants and len(distinct_plants) == 1:
                    candidate_plants.add(distinct_plants[0])

            if not candidate_plants:
                next_pending.append(row)
                continue

            resolved_any = True
            for plant in sorted(candidate_plants):
                parent_key = _key(parent_sku, plant)
                child_key = _key(child_sku, plant)
                pair = (parent_key, child_key)
                usage_float[pair] = usage_float.get(pair, 0.0) + usage_qty
                sku_to_plants.setdefault(parent_sku, set()).add(plant)
                sku_to_plants.setdefault(child_sku, set()).add(plant)
        pending_rows = next_pending

    unresolved_bom_rows = list(pending_rows)
    if not usage_float:
        message = "No valid BOM usage rows were provided; multi-echelon requires bom_usage."
        if unresolved_bom_rows:
            message = (
                "BOM rows could not be resolved to plant-scoped items. "
                "Provide plant_id on bom_usage rows or include matching parent inventory/demand context."
            )
        return _empty_response_me(
            t0,
            "INFEASIBLE",
            [message],
            settings=solver_settings,
            termination_reason="INVALID_INPUT",
        )

    usage_scaled: Dict[Tuple[Tuple[str, str], Tuple[str, str]], int] = {}
    parents_by_child: Dict[Tuple[str, str], List[Tuple[Tuple[str, str], int, float]]] = {}
    children_by_parent: Dict[Tuple[str, str], List[Tuple[Tuple[str, str], int, float]]] = {}
    for (parent_key, child_key), qty in usage_float.items():
        coeff = max(0, int(round(qty * qty_scale)))
        if coeff <= 0:
            continue
        usage_scaled[(parent_key, child_key)] = coeff
        parents_by_child.setdefault(child_key, []).append((parent_key, coeff, qty))
        children_by_parent.setdefault(parent_key, []).append((child_key, coeff, qty))

    component_keys = sorted(parents_by_child.keys(), key=lambda k: (k[0], k[1]))
    parent_keys = sorted(children_by_parent.keys(), key=lambda k: (k[0], k[1]))
    item_keys = sorted(set(fg_keys + parent_keys + component_keys), key=lambda k: (k[0], k[1]))
    item_index = {k: i for i, k in enumerate(item_keys)}

    # Map each BOM child to impacted FG demand SKUs (transitively).
    max_bom_depth_raw = _read_attr(payload.multi_echelon, "max_bom_depth", None)
    max_bom_depth = max(1, int(_to_float(max_bom_depth_raw, 50.0)))
    component_to_fgs: Dict[Tuple[str, str], Set[str]] = {k: set() for k in component_keys}
    root_fg_by_key: Dict[Tuple[str, str], Set[str]] = {k: {k[0]} for k in fg_keys}
    root_frontier: Dict[Tuple[str, str], Set[str]] = {k: {k[0]} for k in fg_keys}
    fg_scope_depth_used = 0
    while root_frontier and fg_scope_depth_used < max_bom_depth:
        next_frontier: Dict[Tuple[str, str], Set[str]] = {}
        for parent_key, fg_set in root_frontier.items():
            for child_key, _, _ in children_by_parent.get(parent_key, []):
                existing = root_fg_by_key.setdefault(child_key, set())
                new_fg = set(fg_set) - existing
                if not new_fg:
                    continue
                existing.update(new_fg)
                next_frontier.setdefault(child_key, set()).update(new_fg)
        root_frontier = next_frontier
        fg_scope_depth_used += 1
    for comp_key in component_keys:
        component_to_fgs[comp_key].update(root_fg_by_key.get(comp_key, set()))

    # ── 6. FG demand scaled + expected BOM-driven dependent demand ────────────
    demand_by_fg_idx_scaled: Dict[Tuple[str, str], Dict[int, int]] = {}
    for fg_key in fg_keys:
        demand_by_fg_idx_scaled[fg_key] = {}
        for d, qty in demand_rows_by_fg.get(fg_key, []):
            idx = day_to_idx[d]
            ds = int(round(max(0.0, qty) * qty_scale))
            demand_by_fg_idx_scaled[fg_key][idx] = demand_by_fg_idx_scaled[fg_key].get(idx, 0) + ds

    external_demand_float: Dict[Tuple[str, str], float] = {
        key: sum(q for _, q in demand_rows_by_fg.get(key, []))
        for key in fg_keys
    }
    expected_total_need_float: Dict[Tuple[str, str], float] = {
        key: external_demand_float.get(key, 0.0)
        for key in item_keys
    }
    demand_frontier: Dict[Tuple[str, str], float] = {
        key: qty for key, qty in expected_total_need_float.items() if qty > 0.0
    }
    expected_need_cap = 1_000_000_000.0
    expected_depth_used = 0
    while demand_frontier and expected_depth_used < max_bom_depth:
        next_frontier: Dict[Tuple[str, str], float] = {}
        for parent_key, parent_qty in demand_frontier.items():
            if parent_qty <= 0.0:
                continue
            for child_key, _, usage_qty in children_by_parent.get(parent_key, []):
                add = parent_qty * usage_qty
                if add <= 0.0:
                    continue
                capped_add = min(add, expected_need_cap)
                new_total = min(
                    expected_need_cap,
                    expected_total_need_float.get(child_key, 0.0) + capped_add,
                )
                delta = max(0.0, new_total - expected_total_need_float.get(child_key, 0.0))
                if delta <= 0.0:
                    continue
                expected_total_need_float[child_key] = new_total
                next_frontier[child_key] = min(
                    expected_need_cap,
                    next_frontier.get(child_key, 0.0) + delta,
                )
        demand_frontier = next_frontier
        expected_depth_used += 1

    expected_internal_demand_scaled: Dict[Tuple[str, str], int] = {}
    for key in item_keys:
        total_need = expected_total_need_float.get(key, 0.0)
        external_need = external_demand_float.get(key, 0.0)
        internal_need = max(0.0, total_need - external_need)
        expected_internal_demand_scaled[key] = max(0, int(round(internal_need * qty_scale)))

    # Demand-by-period propagation used for diagnostics/projection visibility.
    expected_need_by_key_idx: Dict[Tuple[str, str], Dict[int, float]] = {key: {} for key in item_keys}
    period_frontier: Dict[Tuple[str, str], Dict[int, float]] = {}
    for fg_key in fg_keys:
        bucket: Dict[int, float] = {}
        for t, demand_s in demand_by_fg_idx_scaled.get(fg_key, {}).items():
            qty = max(0.0, demand_s / qty_scale)
            if qty <= 0.0:
                continue
            bucket[t] = bucket.get(t, 0.0) + qty
            expected_need_by_key_idx[fg_key][t] = expected_need_by_key_idx[fg_key].get(t, 0.0) + qty
        if bucket:
            period_frontier[fg_key] = bucket

    period_depth_used = 0
    while period_frontier and period_depth_used < max_bom_depth:
        next_frontier: Dict[Tuple[str, str], Dict[int, float]] = {}
        for parent_key, period_qty in period_frontier.items():
            for child_key, _, usage_qty in children_by_parent.get(parent_key, []):
                child_total_bucket = expected_need_by_key_idx.setdefault(child_key, {})
                child_frontier_bucket = next_frontier.setdefault(child_key, {})
                for t, parent_qty in period_qty.items():
                    add = parent_qty * usage_qty
                    if add <= 0.0:
                        continue
                    prev_total = child_total_bucket.get(t, 0.0)
                    new_total = min(expected_need_cap, prev_total + add)
                    delta = max(0.0, new_total - prev_total)
                    if delta <= 0.0:
                        continue
                    child_total_bucket[t] = new_total
                    child_frontier_bucket[t] = min(
                        expected_need_cap,
                        child_frontier_bucket.get(t, 0.0) + delta,
                    )
        period_frontier = {
            key: bucket for key, bucket in next_frontier.items() if any(v > 0.0 for v in bucket.values())
        }
        period_depth_used += 1

    expected_dependent_need_by_key_idx: Dict[Tuple[str, str], Dict[int, float]] = {}
    for key in component_keys:
        total_bucket = expected_need_by_key_idx.get(key, {})
        ext_bucket = demand_by_fg_idx_scaled.get(key, {})
        dep_bucket: Dict[int, float] = {}
        for t, total in total_bucket.items():
            dep = max(0.0, total - (ext_bucket.get(t, 0) / qty_scale))
            if dep > 1e-12:
                dep_bucket[t] = dep
        expected_dependent_need_by_key_idx[key] = dep_bucket

    # ── 7. constraint maps (float, unscaled — scaled inline at point of use) ──
    moq_map = _build_qty_map_me(payload.constraints.moq, "min_qty")
    pack_map = _build_qty_map_me(payload.constraints.pack_size, "pack_qty")
    max_map = _build_qty_map_me(payload.constraints.max_order_qty, "max_qty")
    unit_cost_map = _build_unit_cost_map_me(getattr(payload.constraints, "unit_costs", None))
    budget_cap_scaled: Optional[int] = None
    if getattr(payload.constraints, "budget_cap", None) is not None:
        budget_cap_scaled = max(
            0, int(round(max(0.0, _to_float(payload.constraints.budget_cap, 0.0)) * qty_scale))
        )

    # ── 8. per-item derived constants ─────────────────────────────────────────
    lead_offsets: Dict[Tuple[str, str], int] = {}
    initial_on_hand_scaled: Dict[Tuple[str, str], int] = {}
    initial_safety_scaled: Dict[Tuple[str, str], int] = {}

    for key in item_keys:
        inv = inventory_state.get(key, {"on_hand": 0.0, "safety_stock": 0.0, "lead_time_days": 0.0})
        lead_offsets[key] = max(
            0, int(math.ceil(max(0.0, _to_float(inv.get("lead_time_days"), 0.0)) / period_days))
        )
        initial_on_hand_scaled[key] = max(0, int(round(max(0.0, _to_float(inv.get("on_hand"), 0.0)) * qty_scale)))
        initial_safety_scaled[key] = max(0, int(round(max(0.0, _to_float(inv.get("safety_stock"), 0.0)) * qty_scale)))

    # ── 9. variable upper bounds ──────────────────────────────────────────────
    order_ub_by_key: Dict[Tuple[str, str], int] = {}
    inv_ub_by_key: Dict[Tuple[str, str], int] = {}
    back_ub_by_key: Dict[Tuple[str, str], int] = {}

    for key in item_keys:
        sku = key[0]
        on_hand_s = initial_on_hand_scaled.get(key, 0)
        open_sum_s = int(round(sum((open_pos_by_key_idx.get(key, {}) or {}).values()) * qty_scale))
        demand_s = sum(demand_by_fg_idx_scaled.get(key, {}).values())
        comp_demand_s = expected_internal_demand_scaled.get(key, 0)
        safety_s = initial_safety_scaled.get(key, 0)
        base = max(qty_scale, on_hand_s + open_sum_s + demand_s + comp_demand_s + 2 * safety_s)
        max_s = int(round((max_map.get(sku, 0.0) or 0.0) * qty_scale))
        order_ub_by_key[key] = max(base * 2, qty_scale, max_s if max_s > 0 else 0)
        inv_ub_by_key[key] = max(base * 3, qty_scale)
        back_ub_by_key[key] = max(base * 3, qty_scale)

    # ── 10. build CP-SAT model ────────────────────────────────────────────────
    model = _cp_model.CpModel()
    order_vars: Dict[Tuple[Tuple[str, str], int], Any] = {}
    inv_vars: Dict[Tuple[Tuple[str, str], int], Any] = {}
    back_vars: Dict[Tuple[Tuple[str, str], int], Any] = {}

    me_lot_mode = str(getattr(payload.multi_echelon, "lot_sizing_mode", None) or "moq_pack").strip().lower()
    comp_apply_lot = me_lot_mode not in {"off", "none", "disabled"}

    for key in item_keys:
        sku = key[0]
        item_idx = item_index[key]
        is_component = key in component_keys
        use_lot = (not is_component) or comp_apply_lot
        moq_s = int(round((moq_map.get(sku, 0.0) or 0.0) * qty_scale))
        pack_s = int(round((pack_map.get(sku, 0.0) or 0.0) * qty_scale))
        max_s = int(round((max_map.get(sku, 0.0) or 0.0) * qty_scale))
        lead_offset = lead_offsets.get(key, 0)

        for t in range(n_periods):
            o_var = model.NewIntVar(0, order_ub_by_key[key], f"ord_{item_idx}_{t}")
            i_var = model.NewIntVar(0, inv_ub_by_key[key], f"inv_{item_idx}_{t}")
            b_var = model.NewIntVar(0, back_ub_by_key[key], f"back_{item_idx}_{t}")
            order_vars[(key, t)] = o_var
            inv_vars[(key, t)] = i_var
            back_vars[(key, t)] = b_var

            # Orders placed after the last deliverable period are locked to zero.
            if t + lead_offset >= n_periods:
                model.Add(o_var == 0)

            # Per-item maximum order quantity.
            if max_s > 0:
                model.Add(o_var <= max_s)
                _tag(
                    f"MAXQ[{sku},{t}]",
                    "Per-item max order quantity.",
                    scope="sku_period",
                    period=horizon_dates[t].isoformat(),
                    sku=sku,
                )

            # Pack-size multiple: order = pack * z.
            if use_lot and pack_s > qty_scale:
                z_ub = max(0, order_ub_by_key[key] // max(1, pack_s))
                z_var = model.NewIntVar(0, z_ub, f"pack_{item_idx}_{t}")
                model.Add(o_var == pack_s * z_var)
                _tag(
                    f"PACK[{sku},{t}]",
                    "Order must be pack-size multiple.",
                    scope="sku_period",
                    period=horizon_dates[t].isoformat(),
                    sku=sku,
                )

            # MOQ: o ≥ moq when ordered (y=1), o = 0 when not ordered (y=0).
            if use_lot and moq_s > 0:
                y_var = model.NewBoolVar(f"y_{item_idx}_{t}")
                model.Add(o_var <= order_ub_by_key[key] * y_var)
                model.Add(o_var >= moq_s * y_var)
                _tag(
                    f"MOQ[{sku},{t}]",
                    "MOQ enforcement when order placed.",
                    scope="sku_period",
                    period=horizon_dates[t].isoformat(),
                    sku=sku,
                )

    # ── 11. arrival helpers ───────────────────────────────────────────────────
    def _arrival(key: Tuple[str, str], t: int) -> Any:
        """Inbound at period t: open-PO constant + new order placed (t - lead_offset) periods ago."""
        open_s = int(round((open_pos_by_key_idx.get(key, {}).get(t, 0.0)) * qty_scale))
        src = t - lead_offsets.get(key, 0)
        if src >= 0:
            return open_s + order_vars[(key, src)]
        return open_s

    def _produced(key: Tuple[str, str], t: int) -> Any:
        """Produced/supplied quantity available at period t (arriving planned order)."""
        src = t - lead_offsets.get(key, 0)
        if src >= 0:
            return order_vars[(key, src)]
        return 0

    # ── 12. inventory balance constraints ─────────────────────────────────────
    for key in item_keys:
        for t in range(n_periods):
            prev_inv = inv_vars[(key, t - 1)] if t > 0 else initial_on_hand_scaled.get(key, 0)
            prev_back = back_vars[(key, t - 1)] if t > 0 else 0
            arrival = _arrival(key, t)
            demand_s = demand_by_fg_idx_scaled.get(key, {}).get(t, 0)
            bom_parent_terms = parents_by_child.get(key, [])
            consumption_terms = []
            for parent_key, coeff, _ in bom_parent_terms:
                pe = _produced(parent_key, t)
                if isinstance(pe, int) and pe == 0:
                    continue
                consumption_terms.append(coeff * pe)
            consumption = sum(consumption_terms) if consumption_terms else 0

            # Item flow with external demand + dependent BOM demand.
            model.Add(
                qty_scale * inv_vars[(key, t)] - qty_scale * back_vars[(key, t)]
                == qty_scale * prev_inv - qty_scale * prev_back
                + qty_scale * arrival - qty_scale * demand_s - consumption
            )
            if key in fg_keys:
                _tag(
                    f"BALANCE_INV[{key[0]},{t}]",
                    "FG inventory flow balance with external demand.",
                    scope="sku_period",
                    period=horizon_dates[t].isoformat(),
                    sku=key[0],
                )
            if bom_parent_terms:
                _tag(
                    f"BOM_LINK[{key[0]},{t}]",
                    "Component flow includes BOM-coupled parent production consumption.",
                    scope="sku_period",
                    period=horizon_dates[t].isoformat(),
                    sku=key[0],
                )

                # Hard feasibility: cannot consume more than available.
                model.Add(consumption <= qty_scale * (prev_inv + arrival))
                _tag(
                    f"COMP_FEAS[{key[0]},{t}]",
                    "Component consumption cannot exceed available inventory + arrivals.",
                    scope="sku_period",
                    period=horizon_dates[t].isoformat(),
                    sku=key[0],
                )

    # ── 13. global budget constraint ──────────────────────────────────────────
    if budget_cap_scaled is not None:
        model.Add(sum(order_vars.values()) <= budget_cap_scaled)
        _tag("BUDGET_GLOBAL", "Global shared budget cap across all items.")

    # ── 14. optional capacity constraints ─────────────────────────────────────
    prod_capacity_refs: List[Dict[str, Any]] = []
    inv_capacity_refs_me: List[Dict[str, Any]] = []

    prod_cap_scalar, prod_cap_by_day = _resolve_capacity_for_multi(payload, "production_capacity_per_period")
    for t, cap_day in enumerate(horizon_dates):
        prod_cap_t = _capacity_for_day(cap_day, prod_cap_scalar, prod_cap_by_day)
        if prod_cap_t is None or prod_cap_t <= 0.0:
            continue
        prod_cap_s = int(round(prod_cap_t * qty_scale))
        model.Add(sum(_produced(fg_key, t) for fg_key in fg_keys) <= prod_cap_s)
        _tag(
            f"CAP_PROD[{cap_day.isoformat()}]",
            "Shared production capacity for this period.",
            scope="period",
            period=cap_day.isoformat(),
        )
        prod_capacity_refs.append({
            "day": cap_day,
            "cap_s": prod_cap_s,
            "expr_terms": [_produced(fg_key, t) for fg_key in fg_keys],
        })

    inv_cap_scalar, inv_cap_by_day = _resolve_capacity_for_multi(payload, "inventory_capacity_per_period")
    for t, cap_day in enumerate(horizon_dates):
        inv_cap_t = _capacity_for_day(cap_day, inv_cap_scalar, inv_cap_by_day)
        if inv_cap_t is None or inv_cap_t <= 0.0:
            continue
        inv_cap_s = int(round(inv_cap_t * qty_scale))
        model.Add(sum(inv_vars[(key, t)] for key in item_keys) <= inv_cap_s)
        _tag(
            f"CAP_INV[{cap_day.isoformat()}]",
            "Shared inventory capacity for this period.",
            scope="period",
            period=cap_day.isoformat(),
        )
        inv_capacity_refs_me.append({
            "day": cap_day,
            "cap_s": inv_cap_s,
            "keys": list(item_keys),
            "t": t,
        })

    # Optional hard service-level target (on FG end backlog).
    service_level_target_raw = getattr(payload.objective, "service_level_target", None)
    service_level_target: Optional[float] = None
    service_level_allowed_fg_backlog_s: Optional[int] = None
    if service_level_target_raw is not None:
        service_level_target = max(0.0, min(1.0, _to_float(service_level_target_raw, 0.0)))
        total_fg_demand_s = sum(
            demand_by_fg_idx_scaled.get(fg_key, {}).get(t, 0)
            for fg_key in fg_keys
            for t in range(n_periods)
        )
        service_level_allowed_fg_backlog_s = int(round(max(0.0, 1.0 - service_level_target) * total_fg_demand_s))
        model.Add(
            sum(back_vars[(fg_key, n_periods - 1)] for fg_key in fg_keys) <= service_level_allowed_fg_backlog_s
        )
        _tag(
            "SERVICE_LEVEL_GLOBAL",
            "Hard FG end-of-horizon service-level target.",
        )

    # ── 15. objective ─────────────────────────────────────────────────────────
    holding_cost = _to_float(payload.objective.holding_cost, 0.0) \
        if getattr(payload.objective, "holding_cost", None) is not None else 0.0
    stockout_penalty = _to_float(payload.objective.stockout_penalty, 1.0) \
        if getattr(payload.objective, "stockout_penalty", None) is not None else 1.0
    comp_penalty_raw = getattr(payload.multi_echelon, "component_stockout_penalty", None)
    component_stockout_penalty = _to_float(comp_penalty_raw, stockout_penalty * 5.0) \
        if comp_penalty_raw is not None else max(stockout_penalty * 5.0, stockout_penalty)

    hold_coeff = max(0, int(round(holding_cost * cost_scale)))
    fg_back_coeff = max(1, int(round(stockout_penalty * cost_scale)))
    comp_back_coeff = max(1, int(round(component_stockout_penalty * cost_scale)))

    obj_terms: List[Any] = []
    for key in item_keys:
        sku = key[0]
        purchase_coeff = max(0, int(round((unit_cost_map.get(sku, 0.0) or 0.0) * cost_scale)))
        is_fg = key in fg_keys
        back_coeff = fg_back_coeff if is_fg else comp_back_coeff
        for t in range(n_periods):
            if hold_coeff > 0:
                obj_terms.append(hold_coeff * inv_vars[(key, t)])
            if back_coeff > 0:
                obj_terms.append(back_coeff * back_vars[(key, t)])
            if purchase_coeff > 0:
                obj_terms.append(purchase_coeff * order_vars[(key, t)])
            obj_terms.append(order_vars[(key, t)])

    if obj_terms:
        model.Minimize(sum(obj_terms))

    # ── 16. solve ─────────────────────────────────────────────────────────────
    solver = _cp_model.CpSolver()
    _apply_solver_run_settings(solver, solver_settings)

    cp_status, stop_requested = _solve_with_cancel_support(solver, model, cancel_check=cancel_check)
    solve_time_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
    status_info = _status_from_cp(
        cp_status,
        solver,
        solver_settings,
        solve_time_ms,
        stop_requested=stop_requested,
    )

    if not status_info.has_feasible_solution:
        reasons = ["CP-SAT did not find a feasible BOM-aware plan under current constraints."]
        suspected_tags = ["BOM_LINK", "COMP_FEAS"]
        constraints_checked: List[Dict[str, Any]] = [
            _mk_constraint_check(
                name="bom_coupling",
                tag="BOM_LINK",
                passed=False,
                details="No feasible solution found with hard BOM coupling constraints.",
                description="BOM-coupled flow feasibility.",
                echelon="multi",
            ),
        ]
        if prod_capacity_refs:
            reasons.append("Production capacity constraints CAP_PROD[*] were active in this run.")
            suspected_tags.append("CAP_PROD")
            prod_period_tags = sorted({f"CAP_PROD[{ref['day'].isoformat()}]" for ref in prod_capacity_refs})
            constraints_checked.append(_mk_constraint_check(
                name="production_capacity",
                tag="CAP_PROD",
                passed=False,
                details="No feasible solution found with CAP_PROD[*] constraints enabled.",
                description="Shared production capacity per period.",
                scope="period",
                echelon="multi",
                tags=prod_period_tags,
            ))
        if inv_capacity_refs_me:
            reasons.append("Inventory capacity constraints CAP_INV[*] were active in this run.")
            suspected_tags.append("CAP_INV")
            inv_period_tags = sorted({f"CAP_INV[{ref['day'].isoformat()}]" for ref in inv_capacity_refs_me})
            constraints_checked.append(_mk_constraint_check(
                name="inventory_capacity",
                tag="CAP_INV",
                passed=False,
                details="No feasible solution found with CAP_INV[*] constraints enabled.",
                description="Shared inventory capacity per period.",
                scope="period",
                echelon="multi",
                tags=inv_period_tags,
            ))
        if service_level_target is not None:
            suspected_tags.append("SERVICE_LEVEL_GLOBAL")
            constraints_checked.append(_mk_constraint_check(
                name="service_level_target",
                tag="SERVICE_LEVEL_GLOBAL",
                passed=False,
                details="Hard service-level target may conflict with supply/capacity constraints.",
                description="Hard FG service-level target.",
                echelon="multi",
            ))
        infeasibility_analysis = _summarize_infeasibility(suspected_tags)
        relaxation_analysis: List[Dict[str, Any]] = []
        if diagnose_mode and not internal_diagnose:
            # Keep diagnose mode fast for multi-echelon: report candidate relaxations.
            relaxation_analysis = [
                {"relaxed_tags": [tag], "feasible_after_relaxation": None, "delta_cost_proxy": None}
                for tag in sorted(set(suspected_tags))
            ]
        return finalize_planning_response(
            {
                **_empty_response_me(
                    t0,
                    status_info.status.value,
                    reasons,
                    solve_time_ms=solve_time_ms,
                    settings=solver_settings,
                    termination_reason=status_info.termination_reason,
                    status_name=status_info.status_name,
                ),
                "proof": {
                    "objective_terms": [],
                    "constraints_checked": constraints_checked,
                    "constraint_tags": constraint_tags,
                    "infeasibility_analysis": infeasibility_analysis,
                    "relaxation_analysis": relaxation_analysis,
                    "diagnose_mode": bool(diagnose_mode),
                },
            },
            default_engine="cp_sat",
            default_status=status_info.status,
        )

    # ── 17. extract plan rows ─────────────────────────────────────────────────
    plan_rows: List[Dict[str, Any]] = []
    component_plan_rows: List[Dict[str, Any]] = []
    all_order_rows: List[Dict[str, Any]] = []

    for key in item_keys:
        sku, plant_id = key
        lead_offset = lead_offsets.get(key, 0)
        for t in range(n_periods):
            qty_s_val = int(round(solver.Value(order_vars[(key, t)])))
            if qty_s_val <= 0:
                continue
            arrival_idx = t + lead_offset
            if arrival_idx >= n_periods:
                continue
            qty = qty_s_val / qty_scale
            base_row = {
                "order_date": horizon_dates[t].isoformat(),
                "arrival_date": horizon_dates[arrival_idx].isoformat(),
                "order_qty": float(round(qty, 6)),
                "plant_id": plant_id or None,
            }
            all_order_rows.append({**base_row, "sku": sku})
            if key in fg_keys:
                plan_rows.append({
                    "sku": sku,
                    "plant_id": plant_id or None,
                    "order_date": base_row["order_date"],
                    "arrival_date": base_row["arrival_date"],
                    "order_qty": base_row["order_qty"],
                })
            else:
                component_plan_rows.append({
                    "component_sku": sku,
                    "plant_id": plant_id or None,
                    "order_date": base_row["order_date"],
                    "arrival_date": base_row["arrival_date"],
                    "order_qty": base_row["order_qty"],
                })

    plan_rows.sort(key=lambda r: (r["sku"], r.get("plant_id") or "", r["order_date"]))
    component_plan_rows.sort(key=lambda r: (r["component_sku"], r.get("plant_id") or "", r["order_date"]))

    # ── 18. component inventory projection ────────────────────────────────────
    comp_proj_rows: List[Dict[str, Any]] = []
    for comp_key in component_keys:
        comp_sku, comp_plant = comp_key
        lead_offset = lead_offsets.get(comp_key, 0)
        for t in range(n_periods):
            day = horizon_dates[t]
            open_qty = max(0.0, (open_pos_by_key_idx.get(comp_key, {}) or {}).get(t, 0.0))
            src = t - lead_offset
            inbound_plan = int(round(solver.Value(order_vars[(comp_key, src)]))) / qty_scale if src >= 0 else 0.0
            dep_demand = max(
                0.0,
                expected_dependent_need_by_key_idx.get(comp_key, {}).get(t, 0.0),
            )
            on_hand_end = int(round(solver.Value(inv_vars[(comp_key, t)]))) / qty_scale
            backlog = int(round(solver.Value(back_vars[(comp_key, t)]))) / qty_scale
            comp_proj_rows.append({
                "component_sku": comp_sku,
                "plant_id": comp_plant or None,
                "date": day.isoformat(),
                "on_hand_end": float(round(on_hand_end, 6)),
                "backlog": float(round(backlog, 6)),
                "demand_dependent": float(round(dep_demand, 6)),
                "inbound_plan": float(round(inbound_plan, 6)),
                "inbound_open_pos": float(round(open_qty, 6)),
            })
    comp_proj_rows.sort(key=lambda r: (r["component_sku"], r.get("plant_id") or "", r["date"]))

    # ── 19. KPIs ──────────────────────────────────────────────────────────────
    total_fg_demand = sum(
        q for fg_key in fg_keys for _, q in demand_rows_by_fg.get(fg_key, [])
    )
    end_fg_backlog = sum(
        int(round(solver.Value(back_vars[(fg_key, n_periods - 1)]))) / qty_scale
        for fg_key in fg_keys
    )
    stockout_units = sum(
        int(round(solver.Value(back_vars[(fg_key, t)]))) / qty_scale
        for fg_key in fg_keys for t in range(n_periods)
    )
    holding_units = sum(
        int(round(solver.Value(inv_vars[(fg_key, t)]))) / qty_scale
        for fg_key in fg_keys for t in range(n_periods)
    )
    comp_stockout = sum(
        int(round(solver.Value(back_vars[(ck, t)]))) / qty_scale
        for ck in component_keys for t in range(n_periods)
    )
    comp_holding = sum(
        int(round(solver.Value(inv_vars[(ck, t)]))) / qty_scale
        for ck in component_keys for t in range(n_periods)
    )

    service_level: Optional[float] = None
    if total_fg_demand > 0.0:
        service_level = max(0.0, min(1.0, 1.0 - end_fg_backlog / total_fg_demand))

    obj_val = float(solver.ObjectiveValue())
    bound_val = float(solver.BestObjectiveBound())
    est_cost = obj_val / (qty_scale * cost_scale)
    best_bound_cost = bound_val / (qty_scale * cost_scale)
    gap = None
    if status_info.has_feasible_solution:
        if cp_status == _cp_model.OPTIMAL:
            gap = 0.0
        else:
            gap = abs(obj_val - bound_val) / max(abs(obj_val), 1.0)
            gap = float(round(gap, 6))

    # ── 20. constraint proof ──────────────────────────────────────────────────
    moq_failed = pack_failed = max_failed = nonneg_failed = 0
    for row in all_order_rows:
        sku = row["sku"]
        qty = _to_float(row["order_qty"], 0.0)
        if qty < -1e-9:
            nonneg_failed += 1
        moq_val = moq_map.get(sku, 0.0)
        if moq_val > 0.0 and qty > 0.0 and qty + 1e-9 < moq_val:
            moq_failed += 1
        pack_val = pack_map.get(sku, 0.0)
        if pack_val > 1.0 and qty > 0.0:
            ratio = qty / pack_val
            if abs(ratio - round(ratio)) > 1e-6:
                pack_failed += 1
        max_val = max_map.get(sku, 0.0)
        if max_val > 0.0 and qty - max_val > 1e-9:
            max_failed += 1

    total_order_qty = sum(_to_float(r["order_qty"], 0.0) for r in all_order_rows)
    budget_passed = True
    budget_detail = "No budget cap provided."
    if getattr(payload.constraints, "budget_cap", None) is not None:
        budget_cap_f = max(0.0, _to_float(payload.constraints.budget_cap, 0.0))
        budget_passed = total_order_qty <= budget_cap_f + 1e-9
        budget_detail = f"Total ordered qty {round(total_order_qty, 6)} vs cap {round(budget_cap_f, 6)}."

    # BOM coupling verification (post-solve).
    bom_coupling_failed = 0
    for comp_key in component_keys:
        for t in range(n_periods):
            prev_inv_s = int(round(solver.Value(inv_vars[(comp_key, t - 1)]))) if t > 0 else initial_on_hand_scaled.get(comp_key, 0)
            arr = _arrival(comp_key, t)
            arrival_s = int(round(solver.Value(arr))) if not isinstance(arr, int) else arr
            cons_s = 0
            for parent_key, coeff, _ in parents_by_child.get(comp_key, []):
                pe = _produced(parent_key, t)
                prod_s = int(round(solver.Value(pe))) if not isinstance(pe, int) else int(pe)
                cons_s += coeff * prod_s
            if cons_s > qty_scale * (prev_inv_s + arrival_s) + 1:
                bom_coupling_failed += 1

    prod_cap_failed = 0
    prod_cap_binding = 0
    prod_cap_tags: List[str] = []
    for ref in prod_capacity_refs:
        produced_s = 0
        for term in ref["expr_terms"]:
            produced_s += int(round(solver.Value(term))) if not isinstance(term, int) else int(term)
        cap_s = int(ref["cap_s"])
        tag = f"CAP_PROD[{ref['day'].isoformat()}]"
        if produced_s > cap_s + 1:
            prod_cap_failed += 1
            prod_cap_tags.append(tag)
        elif abs(produced_s - cap_s) <= 1:
            prod_cap_binding += 1
            prod_cap_tags.append(tag)

    inv_cap_failed = 0
    inv_cap_binding = 0
    inv_cap_tags: List[str] = []
    for ref in inv_capacity_refs_me:
        inv_total_s = 0
        t = int(ref["t"])
        for key in ref["keys"]:
            inv_total_s += int(round(solver.Value(inv_vars[(key, t)])))
        cap_s = int(ref["cap_s"])
        tag = f"CAP_INV[{ref['day'].isoformat()}]"
        if inv_total_s > cap_s + 1:
            inv_cap_failed += 1
            inv_cap_tags.append(tag)
        elif abs(inv_total_s - cap_s) <= 1:
            inv_cap_binding += 1
            inv_cap_tags.append(tag)

    # ── 21. bottleneck diagnostics ────────────────────────────────────────────
    bottleneck_items: List[Dict[str, Any]] = []
    for comp_key in component_keys:
        comp_sku, comp_plant = comp_key
        required_cum = 0.0
        available_cum = initial_on_hand_scaled.get(comp_key, 0) / qty_scale
        max_deficit = 0.0
        periods_impacted: List[str] = []

        for t, day in enumerate(horizon_dates):
            req_today = max(
                0.0,
                expected_dependent_need_by_key_idx.get(comp_key, {}).get(t, 0.0),
            )
            required_cum += req_today
            open_today = max(0.0, (open_pos_by_key_idx.get(comp_key, {}) or {}).get(t, 0.0))
            src = t - lead_offsets.get(comp_key, 0)
            planned_today = int(round(solver.Value(order_vars[(comp_key, src)]))) / qty_scale if src >= 0 else 0.0
            available_cum += open_today + planned_today
            deficit = max(0.0, required_cum - available_cum)
            if deficit > 1e-9:
                periods_impacted.append(day.isoformat())
                if deficit > max_deficit:
                    max_deficit = deficit

        if max_deficit > 1e-9:
            bottleneck_items.append({
                "component_sku": comp_sku,
                "plant_id": comp_plant or None,
                "missing_qty": float(round(max_deficit, 6)),
                "max_missing_qty": float(round(max_deficit, 6)),
                "periods_impacted": periods_impacted[:20],
                "affected_fg_skus": sorted(component_to_fgs.get(comp_key, set()))[:10],
                "evidence_refs": [
                    f"component_balance:{comp_sku}:{p}" for p in periods_impacted[:10]
                ],
            })

    bottleneck_items.sort(key=lambda r: (-r["missing_qty"], r["component_sku"], r.get("plant_id") or ""))
    bottlenecks_payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_rows": len(bottleneck_items),
        "rows": bottleneck_items,
        "items": bottleneck_items,
    }

    # ── 22. infeasible_reasons ────────────────────────────────────────────────
    infeasible_reasons: List[str] = []
    infeasible_reasons_detailed: List[Dict[str, Any]] = []
    if end_fg_backlog > 1e-9:
        infeasible_reasons.append(
            f"Unmet FG backlog remains at horizon end: {round(end_fg_backlog, 6)} units."
        )
        infeasible_reasons_detailed.append({
            "category": "demand_infeasible",
            "top_offending_tags": ["SERVICE_LEVEL_GLOBAL"] if service_level_target is not None else ["BOM_LINK"],
            "suggested_actions": _suggestions_for_categories({"demand_infeasible"}),
            "message": "FG end backlog remains above target.",
        })
    if bottleneck_items:
        infeasible_reasons.append(
            f"BOM bottlenecks detected: {len(bottleneck_items)} components constrained FG output."
        )
        infeasible_reasons_detailed.append({
            "category": "bom_shortage",
            "top_offending_tags": ["COMP_FEAS", "BOM_LINK"],
            "suggested_actions": _suggestions_for_categories({"bom_shortage"}),
            "message": "Component shortages constrained feasible FG output.",
        })
    if inv_capacity_refs_me and (end_fg_backlog > 1e-9 or bottleneck_items):
        infeasible_reasons.append("Inventory capacity constraints CAP_INV[*] contributed to infeasibility.")
        infeasible_reasons_detailed.append({
            "category": "capacity",
            "top_offending_tags": ["CAP_INV"],
            "suggested_actions": _suggestions_for_categories({"capacity"}),
            "message": "Shared inventory capacity is binding under current demand.",
        })
    if prod_capacity_refs and (end_fg_backlog > 1e-9 or bottleneck_items):
        infeasible_reasons.append("Production capacity constraints CAP_PROD[*] contributed to infeasibility.")
        infeasible_reasons_detailed.append({
            "category": "capacity",
            "top_offending_tags": ["CAP_PROD"],
            "suggested_actions": _suggestions_for_categories({"capacity"}),
            "message": "Shared production capacity is binding under current demand.",
        })

    constraints_checked = [
        _mk_constraint_check(
            name="order_qty_non_negative",
            tag="NONNEG",
            passed=nonneg_failed == 0,
            details=f"Negative quantity rows: {nonneg_failed}.",
            description="All plan quantities are non-negative.",
            scope="row",
            echelon="multi",
        ),
        _mk_constraint_check(
            name="moq",
            tag="MOQ",
            passed=moq_failed == 0,
            details=f"Rows violating MOQ: {moq_failed}.",
            description="MOQ enforcement across item-period rows.",
            scope="sku_period",
            echelon="multi",
        ),
        _mk_constraint_check(
            name="pack_size_multiple",
            tag="PACK",
            passed=pack_failed == 0,
            details=f"Rows violating pack-size multiple: {pack_failed}.",
            description="Pack-size multiple enforcement across item-period rows.",
            scope="sku_period",
            echelon="multi",
        ),
        _mk_constraint_check(
            name="budget_cap",
            tag="BUDGET_GLOBAL",
            passed=budget_passed,
            details=budget_detail,
            description="Shared budget cap across all items.",
            echelon="multi",
        ),
        _mk_constraint_check(
            name="max_order_qty",
            tag="MAXQ",
            passed=max_failed == 0,
            details=f"Rows violating max_order_qty: {max_failed}.",
            description="Max order quantity per item-period.",
            scope="sku_period",
            echelon="multi",
        ),
        _mk_constraint_check(
            name="bom_coupling",
            tag="BOM_LINK",
            passed=bom_coupling_failed == 0,
            details=f"BOM coupling violations: {bom_coupling_failed}.",
            description="Component consumption linked to parent item production via BOM usage.",
            scope="sku_period",
            echelon="multi",
        ),
        _mk_constraint_check(
            name="component_feasibility",
            tag="COMP_FEAS",
            passed=len(bottleneck_items) == 0,
            details=f"Detected component bottlenecks: {len(bottleneck_items)}.",
            description="Component availability supports requested FG production.",
            scope="sku_period",
            echelon="multi",
        ),
    ]
    if prod_capacity_refs:
        prod_period_tags = sorted({f"CAP_PROD[{ref['day'].isoformat()}]" for ref in prod_capacity_refs})
        constraints_checked.append(_mk_constraint_check(
            name="production_capacity",
            tag="CAP_PROD",
            passed=prod_cap_failed == 0,
            details=(
                f"CAP_PROD checks={len(prod_capacity_refs)}, "
                f"violations={prod_cap_failed}, binding={prod_cap_binding}."
            ),
            description="Shared production capacity per period.",
            scope="period",
            echelon="multi",
            tags=prod_period_tags,
        ))
    if inv_capacity_refs_me:
        inv_period_tags = sorted({f"CAP_INV[{ref['day'].isoformat()}]" for ref in inv_capacity_refs_me})
        constraints_checked.append(_mk_constraint_check(
            name="inventory_capacity",
            tag="CAP_INV",
            passed=inv_cap_failed == 0,
            details=(
                f"CAP_INV checks={len(inv_capacity_refs_me)}, "
                f"violations={inv_cap_failed}, binding={inv_cap_binding}."
            ),
            description="Shared inventory capacity per period.",
            scope="period",
            echelon="multi",
            tags=inv_period_tags,
        ))
    if service_level_target is not None:
        allowed_backlog_f = (service_level_allowed_fg_backlog_s or 0) / qty_scale
        constraints_checked.append(_mk_constraint_check(
            name="service_level_target",
            tag="SERVICE_LEVEL_GLOBAL",
            passed=end_fg_backlog <= allowed_backlog_f + 1e-9,
            details=(
                f"End FG backlog {round(end_fg_backlog, 6)} vs allowed "
                f"{round(allowed_backlog_f, 6)}."
            ),
            description="Hard FG service-level target.",
            echelon="multi",
        ))
    all_checks_passed = all(check.get("passed") is True for check in constraints_checked)
    if status_info.status == PlanningStatus.TIMEOUT:
        solve_status = PlanningStatus.TIMEOUT
    elif not all_checks_passed:
        solve_status = PlanningStatus.INFEASIBLE
    else:
        solve_status = status_info.status if status_info.status in {
            PlanningStatus.OPTIMAL,
            PlanningStatus.FEASIBLE,
        } else PlanningStatus.FEASIBLE

    me_meta = {
        "multi_echelon_mode": str(getattr(payload.multi_echelon, "mode", None) or "bom_v0"),
        "max_bom_depth": max_bom_depth,
        "bom_explosion_used": bool(getattr(payload.multi_echelon, "bom_explosion_used", False)),
        "bom_explosion_reused": bool(getattr(payload.multi_echelon, "bom_explosion_reused", False)),
        "period_days": period_days,
        "qty_scale": qty_scale,
        "fg_count": len(fg_keys),
        "component_count": len(component_keys),
        "bom_parent_count": len(parent_keys),
        "bom_edge_count": len(usage_scaled),
        "bom_rows_unresolved": len(unresolved_bom_rows),
        "bom_impact_scope_truncated": bool(root_frontier),
        "bom_expected_need_truncated": bool(demand_frontier),
        "bom_expected_need_by_period_truncated": bool(period_frontier),
        "bom_shortages_impacted_fg": bool(bottleneck_items),
    }

    return finalize_planning_response(
        {
            "status": solve_status.value,
            "plan_lines": plan_rows,
            "component_plan": component_plan_rows,
            "component_inventory_projection": {
                "total_rows": len(comp_proj_rows),
                "rows": comp_proj_rows,
                "truncated": False,
            },
            "bottlenecks": bottlenecks_payload,
            "kpis": {
                "estimated_service_level": None if service_level is None else round(service_level, 6),
                "estimated_stockout_units": round(stockout_units, 6),
                "estimated_holding_units": round(holding_units + comp_holding, 6),
                "estimated_total_cost": round(est_cost, 6),
            },
            "solver_meta": _build_solver_meta(
                status_info=SolverStatusInfo(
                    status=solve_status,
                    termination_reason=status_info.termination_reason,
                    status_name=status_info.status_name,
                    has_feasible_solution=True,
                    time_limit_hit=status_info.time_limit_hit,
                ),
                settings=solver_settings,
                solve_time_ms=solve_time_ms,
                objective_value=round(est_cost, 6),
                best_bound=round(best_bound_cost, 6),
                gap=gap,
                extra=me_meta,
            ),
            "infeasible_reasons": sorted(set(infeasible_reasons)),
            "infeasible_reason_details": infeasible_reasons_detailed,
            "infeasible_reasons_detailed": infeasible_reasons_detailed,
            "proof": {
                "objective_terms": [
                    {"name": "fg_holding_units", "value": round(holding_units, 6),
                     "note": "Total FG inventory holding quantity."},
                    {"name": "fg_stockout_units", "value": round(stockout_units, 6),
                     "note": "Total FG backlog quantity over horizon."},
                    {"name": "component_holding_units", "value": round(comp_holding, 6),
                     "note": "Total component inventory holding quantity."},
                    {"name": "component_stockout_units", "value": round(comp_stockout, 6),
                     "note": "Total component backlog quantity over horizon."},
                    {"name": "estimated_total_cost", "value": round(est_cost, 6),
                     "note": "CP-SAT weighted objective value proxy."},
                ],
                "constraints_checked": constraints_checked,
                "constraint_tags": constraint_tags,
                "infeasibility_analysis": (
                    _summarize_infeasibility(
                        [
                            tag
                            for reason in infeasible_reasons_detailed
                            for tag in _as_list(reason.get("top_offending_tags"))
                        ]
                    )
                    if infeasible_reasons_detailed
                    else {"categories": [], "top_offending_tags": [], "suggestions": []}
                ),
                "relaxation_analysis": (
                    [
                        {"relaxed_tags": ["CAP_PROD"], "feasible_after_relaxation": None, "delta_cost_proxy": None},
                        {"relaxed_tags": ["CAP_INV"], "feasible_after_relaxation": None, "delta_cost_proxy": None},
                        {"relaxed_tags": ["BUDGET_GLOBAL"], "feasible_after_relaxation": None, "delta_cost_proxy": None},
                    ]
                    if diagnose_mode and not internal_diagnose and bool(infeasible_reasons)
                    else []
                ),
                "diagnose_mode": bool(diagnose_mode),
            },
        },
        default_engine="cp_sat",
        default_status=solve_status,
    )
