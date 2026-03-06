"""Shared utilities for all replenishment solver backends (CP-SAT, Gurobi, CPLEX).

This module re-exports the core data-structures, parsing helpers, scaling
constants, and response-building functions that every solver backend needs.
The canonical implementation lives in ``replenishment_solver.py``; this file
provides a stable import surface so that commercial backends do **not** need
to import private helpers from the CP-SAT module directly.
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from ml.api.planning_contract import (
    PlanningStatus,
    finalize_planning_response,
    normalize_status,
)

# ── scaling constants ─────────────────────────────────────────────────────────
# All float quantities are multiplied by SCALE and rounded to integers.
# This keeps numerical parity across solvers (CP-SAT requires integers;
# Gurobi/CPLEX could use floats, but we keep SCALE for deterministic parity).
SCALE: int = 1_000
OBJ_SCALE: int = 1_000

MAX_SOLVER_SECONDS: float = 30.0
DEFAULT_SOLVER_RANDOM_SEED: int = int(os.getenv("DI_CP_SAT_RANDOM_SEED", "42"))
DEFAULT_SOLVER_NUM_SEARCH_WORKERS: int = max(1, int(os.getenv("DI_CP_SAT_NUM_SEARCH_WORKERS", "1")))
DEFAULT_SOLVER_LOG_PROGRESS: bool = str(os.getenv("DI_CP_SAT_LOG_PROGRESS", "false")).strip().lower() in {
    "1", "true", "yes", "on",
}
DEFAULT_SOLVER_SINGLE_TIME_LIMIT_SECONDS: float = float(
    os.getenv("DI_CP_SAT_TIME_LIMIT_SECONDS", str(MAX_SOLVER_SECONDS))
)
DEFAULT_SOLVER_MULTI_TIME_LIMIT_SECONDS: float = float(
    os.getenv("DI_CP_SAT_MULTI_TIME_LIMIT_SECONDS", "25.0")
)


# ── data structures ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SolverRunSettings:
    """Solver run policy: deterministic defaults with optional contract overrides."""

    time_limit_seconds: float
    random_seed: int
    num_search_workers: int
    log_search_progress: bool
    deterministic_mode: bool
    stop_after_first_solution: bool = False
    force_timeout: bool = False


@dataclass(frozen=True)
class SolverStatusInfo:
    """Unified solver status info across all backends."""

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
    moq_s: int       # scaled MOQ
    pack_s: int       # scaled pack size
    max_order_qty_s: int  # scaled max order qty
    fixed_order_cost: float


# ── scaling functions ─────────────────────────────────────────────────────────


def s(v: float) -> int:
    """Scale a real float to an integer (multiply by SCALE, round)."""
    return int(round(v * SCALE))


def us(v: int) -> float:
    """Unscale an integer back to a real float."""
    return v / SCALE


# ── type coercion & attribute access ──────────────────────────────────────────


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        v = float(value)
        if math.isnan(v) or math.isinf(v):
            return default
        return v
    except Exception:
        return default


def to_bool(value: Any, default: bool = False) -> bool:
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


def to_int(value: Any, default: int = 0, minimum: int = 0) -> int:
    try:
        parsed = int(value)
    except Exception:
        return max(minimum, int(default))
    return max(minimum, parsed)


def read_attr(obj: Any, name: str, default: Any = None) -> Any:
    """Read an attribute from object or dict with graceful fallback."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def read_path(obj: Any, path: str, default: Any = None) -> Any:
    cur = obj
    for part in path.split("."):
        cur = read_attr(cur, part, None)
        if cur is None:
            return default
    return cur


def first_non_none(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def as_list(value: Any) -> List[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


def as_dict(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    plain = _payload_to_plain(value)
    return plain if isinstance(plain, dict) else {}


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


# ── data parsing ──────────────────────────────────────────────────────────────


def parse_day(value: Any) -> Optional[date]:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        return datetime.strptime(raw[:10], "%Y-%m-%d").date()
    except Exception:
        return None


def key(sku: Any, plant_id: Any) -> Tuple[str, str]:
    return (str(sku or "").strip(), str(plant_id or "").strip())


def parse_sku_plant_key(raw_key: Any) -> Optional[Tuple[str, str]]:
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


def parse_keyed_scaled_qty_map(raw_map: Any) -> Dict[Tuple[str, str], int]:
    out: Dict[Tuple[str, str], int] = {}
    if not isinstance(raw_map, dict):
        return out
    for raw_key, raw_value in raw_map.items():
        parsed = parse_sku_plant_key(raw_key)
        if parsed is None:
            continue
        out[parsed] = s(max(0.0, to_float(raw_value, 0.0)))
    return out


def lookup_keyed_value(
    mapping: Dict[Tuple[str, str], Any],
    k: Tuple[str, str],
) -> Optional[Any]:
    if k in mapping:
        return mapping[k]
    sku, plant = k
    if plant and (sku, "") in mapping:
        return mapping[(sku, "")]
    return None


# ── constraint parsing ────────────────────────────────────────────────────────


def build_qty_map(rows: Any, attr: str) -> Dict[str, int]:
    """Build {sku: scaled_int} from a list of constraint rows."""
    out: Dict[str, int] = {}
    for row in rows or []:
        sku = str(read_attr(row, "sku", "") or "").strip()
        if not sku:
            continue
        v = read_attr(row, attr, None)
        if v is None:
            continue
        out[sku] = s(max(0.0, to_float(v, 0.0)))
    return out


def build_qty_map_unscaled(rows: Any, attr: str) -> Dict[str, float]:
    """Return {sku: unscaled_float} from a list of constraint rows."""
    out: Dict[str, float] = {}
    for row in rows or []:
        sku = str(read_attr(row, "sku", "") or "").strip()
        if not sku:
            continue
        v = read_attr(row, attr, None)
        if v is None:
            continue
        out[sku] = max(0.0, to_float(v, 0.0))
    return out


def build_unit_cost_map(rows: Any) -> Dict[str, float]:
    """Return {sku: unit_cost_float} from unit cost rows."""
    out: Dict[str, float] = {}
    for row in rows or []:
        sku = str(read_attr(row, "sku", "") or "").strip()
        if not sku:
            continue
        v = read_attr(row, "unit_cost", None)
        if v is None:
            continue
        out[sku] = max(0.0, to_float(v, 0.0))
    return out


def capacity_for_period(raw: Any, idx: int, day: date) -> Optional[float]:
    """Resolve per-period capacity from scalar/list/dict inputs."""
    if raw is None:
        return None

    if isinstance(raw, (int, float, str)):
        val = to_float(raw, -1.0)
        return None if val < 0.0 else val

    if isinstance(raw, (list, tuple)):
        if not raw:
            return None
        pick = raw[idx] if idx < len(raw) else raw[-1]
        val = to_float(pick, -1.0)
        return None if val < 0.0 else val

    if isinstance(raw, dict):
        day_key = day.isoformat()
        if day_key in raw:
            val = to_float(raw.get(day_key), -1.0)
            return None if val < 0.0 else val
        if idx in raw:
            val = to_float(raw.get(idx), -1.0)
            return None if val < 0.0 else val
        idx_key = str(idx)
        if idx_key in raw:
            val = to_float(raw.get(idx_key), -1.0)
            return None if val < 0.0 else val
        if "default" in raw:
            val = to_float(raw.get("default"), -1.0)
            return None if val < 0.0 else val
    return None


# ── solver settings resolution ────────────────────────────────────────────────


def resolve_solver_run_settings(
    payload: Any,
    default_time_limit_seconds: float,
) -> SolverRunSettings:
    """Resolve solver policy from defaults + request overrides."""
    solver_cfg = as_dict(read_path(payload, "settings.solver", {}))
    direct_solver_cfg = as_dict(read_attr(payload, "solver", {}))
    engine_flags = as_dict(read_attr(payload, "engine_flags", {}))

    time_limit_raw = first_non_none(
        read_attr(payload, "_solver_time_limit_seconds", None),
        direct_solver_cfg.get("time_limit_seconds"),
        direct_solver_cfg.get("time_limit"),
        direct_solver_cfg.get("max_time_in_seconds"),
        solver_cfg.get("time_limit_seconds"),
        solver_cfg.get("max_time_in_seconds"),
        engine_flags.get("time_limit_seconds"),
        engine_flags.get("max_time_in_seconds"),
        default_time_limit_seconds,
    )
    time_limit_seconds = max(0.01, to_float(time_limit_raw, default_time_limit_seconds))

    random_seed_raw = first_non_none(
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

    num_workers_raw = first_non_none(
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

    log_progress = to_bool(
        first_non_none(
            direct_solver_cfg.get("log_search_progress"),
            solver_cfg.get("log_search_progress"),
            engine_flags.get("log_search_progress"),
            DEFAULT_SOLVER_LOG_PROGRESS,
        ),
        DEFAULT_SOLVER_LOG_PROGRESS,
    )

    deterministic_mode_raw = first_non_none(
        direct_solver_cfg.get("deterministic_mode"),
        direct_solver_cfg.get("deterministic"),
        solver_cfg.get("deterministic_mode"),
        solver_cfg.get("deterministic"),
        engine_flags.get("deterministic_mode"),
        engine_flags.get("deterministic"),
        None,
    )
    deterministic_mode = (
        to_bool(deterministic_mode_raw, True)
        if deterministic_mode_raw is not None
        else num_search_workers == 1
    )
    if deterministic_mode:
        num_search_workers = 1

    stop_after_first_solution = to_bool(
        first_non_none(
            direct_solver_cfg.get("stop_after_first_solution"),
            solver_cfg.get("stop_after_first_solution"),
            engine_flags.get("stop_after_first_solution"),
            False,
        ),
        False,
    )
    force_timeout = to_bool(
        first_non_none(
            read_attr(payload, "_solver_force_timeout", None),
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


# ── constraint check & proof helpers ──────────────────────────────────────────


def mk_constraint_check(
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


def suggestions_for_categories(categories: Set[str]) -> List[str]:
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


def summarize_infeasibility(tags: List[str]) -> Dict[str, Any]:
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
    suggestions_list = suggestions_for_categories(set(category_list))
    return {
        "categories": category_list,
        "top_offending_tags": sorted(set(tags))[:12],
        "suggestions": suggestions_list,
    }


# ── solver meta & response helpers ────────────────────────────────────────────


def build_solver_meta(
    *,
    engine_name: str,
    solver_name: str,
    status_info: SolverStatusInfo,
    settings: SolverRunSettings,
    solve_time_ms: int,
    objective_value: Optional[float],
    best_bound: Optional[float],
    gap: Optional[float],
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build the solver_meta dict for the planning response."""
    payload: Dict[str, Any] = {
        "engine": engine_name,
        "solver": solver_name,
        "status": status_info.status.value,
        "termination_reason": status_info.termination_reason,
        "cp_status_name": status_info.status_name,
        "solve_time_ms": int(max(0, solve_time_ms)),
        "objective_value": objective_value,
        "best_bound": best_bound,
        "gap": gap,
        # Stable contract fields
        "time_limit": float(settings.time_limit_seconds),
        "seed": int(settings.random_seed),
        "workers": int(settings.num_search_workers),
        # Legacy/diagnostic fields
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


def empty_response(
    t0: datetime,
    status: str,
    reasons: List[str],
    *,
    engine_name: str = "cp_sat",
    solve_time_ms: Optional[int] = None,
    settings: Optional[SolverRunSettings] = None,
    termination_reason: str = "NO_FEASIBLE_SOLUTION",
    status_name: str = "UNKNOWN",
) -> Dict[str, Any]:
    """Build a standard empty (infeasible/timeout) response."""
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
    return finalize_planning_response(
        {
            "status": status,
            "plan_lines": [],
            "kpis": {
                "estimated_service_level": None,
                "estimated_stockout_units": None,
                "estimated_holding_units": None,
                "estimated_total_cost": None,
            },
            "solver_meta": build_solver_meta(
                engine_name=engine_name,
                solver_name=engine_name,
                status_info=status_info,
                settings=solver_settings,
                solve_time_ms=solve_time_ms,
                objective_value=None,
                best_bound=None,
                gap=None,
            ),
            "infeasible_reasons": reasons,
            "proof": {"objective_terms": [], "constraints_checked": []},
        },
        default_engine=engine_name,
        default_status=normalized_status,
    )


def empty_response_multi_echelon(
    t0: datetime,
    status: str,
    reasons: List[str],
    *,
    engine_name: str = "cp_sat",
    solve_time_ms: Optional[int] = None,
    settings: Optional[SolverRunSettings] = None,
    termination_reason: str = "NO_FEASIBLE_SOLUTION",
    status_name: str = "UNKNOWN",
) -> Dict[str, Any]:
    """Empty multi-echelon response (superset of single-echelon shape)."""
    result = empty_response(
        t0, status, reasons,
        engine_name=engine_name,
        solve_time_ms=solve_time_ms,
        settings=settings,
        termination_reason=termination_reason,
        status_name=status_name,
    )
    result.setdefault("component_plan", [])
    result.setdefault("component_inventory_projection", {"total_rows": 0, "rows": [], "truncated": False})
    result.setdefault("bottlenecks", {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "items": [],
        "rows": [],
        "total_rows": 0,
    })
    return result
