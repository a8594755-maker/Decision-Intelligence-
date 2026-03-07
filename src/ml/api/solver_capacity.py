"""
Capacity parsing, solver configuration, cancel support, and solver meta
building for the replenishment solver family.

Extracted from replenishment_solver.py to keep modules under ~2 000 lines.
"""
from __future__ import annotations

import math
import threading
import time
from datetime import date, timedelta
from typing import Any, Callable, Dict, List, Optional, Tuple

from ml.api.solver_utils import (
    SCALE, OBJ_SCALE, MAX_SOLVER_SECONDS, DIAGNOSE_SOLVER_SECONDS,
    DEFAULT_SOLVER_RANDOM_SEED, DEFAULT_SOLVER_NUM_SEARCH_WORKERS,
    DEFAULT_SOLVER_LOG_PROGRESS, DEFAULT_SOLVER_SINGLE_TIME_LIMIT_SECONDS,
    DEFAULT_SOLVER_MULTI_TIME_LIMIT_SECONDS,
    SolverRunSettings, SolverStatusInfo,
    _read_attr, _as_list, _read_path, _to_bool, _to_float,
    _payload_to_plain, _as_dict, _first_non_none, _parse_day,
)
from ml.api.planning_contract import PlanningStatus

try:
    from ortools.sat.python import cp_model as _cp_model

    _ORTOOLS_OK = True
except ImportError:
    _cp_model = None  # type: ignore[assignment]
    _ORTOOLS_OK = False


# ── capacity period resolution ────────────────────────────────────────────────

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


def _capacity_input_is_scalar(raw_value: Any) -> bool:
    if raw_value is None:
        return False
    if isinstance(raw_value, (int, float)):
        return True
    if isinstance(raw_value, str):
        return bool(str(raw_value).strip())
    return False


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


# ── solver run settings resolution ────────────────────────────────────────────

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


# ── solver execution helpers ──────────────────────────────────────────────────

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


# ── solver meta builder ──────────────────────────────────────────────────────

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
