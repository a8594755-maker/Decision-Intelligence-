"""
Gurobi MILP single-echelon + multi-echelon replenishment solver.

Mathematical model is identical to the OR-Tools CP-SAT version in
``replenishment_solver.py``, translated to ``gurobipy`` native API.

Decision variables, constraints, and objective are the same; the only
differences are:
  - ``addGenConstrIndicator`` replaces ``OnlyEnforceIf`` for MOQ enforcement.
  - ``model.optimize(callback)`` replaces thread-based cancel support.
  - Native MIP gap, Compute Server / Cloud configuration via ``GurobiConfig``.

All quantities use the same integer scaling (SCALE = 1000) as CP-SAT so
that cross-engine parity tests produce numerically identical feasible
regions.
"""
from __future__ import annotations

import logging
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
from ml.api.replenishment_solver_common import (
    SCALE,
    OBJ_SCALE,
    DEFAULT_SOLVER_SINGLE_TIME_LIMIT_SECONDS,
    DEFAULT_SOLVER_MULTI_TIME_LIMIT_SECONDS,
    SolverRunSettings,
    SolverStatusInfo,
    SupplierInfo,
    s as _s,
    us as _us,
    to_float as _to_float,
    to_bool as _to_bool,
    to_int as _to_int,
    read_attr as _read_attr,
    read_path as _read_path,
    first_non_none as _first_non_none,
    as_list as _as_list,
    as_dict as _as_dict,
    parse_day as _parse_day,
    key as _key,
    parse_keyed_scaled_qty_map as _parse_keyed_scaled_qty_map,
    lookup_keyed_value as _lookup_keyed_value,
    build_qty_map as _build_qty_map,
    build_unit_cost_map as _build_unit_cost_map,
    capacity_for_period as _capacity_for_period,
    resolve_solver_run_settings as _resolve_solver_run_settings,
    mk_constraint_check as _mk_constraint_check,
    suggestions_for_categories as _suggestions_for_categories,
    summarize_infeasibility as _summarize_infeasibility,
    build_solver_meta as _build_solver_meta,
    build_qty_map_unscaled as _build_qty_map_unscaled,
    build_unit_cost_map as _build_unit_cost_map_common,
    empty_response as _empty_response,
    empty_response_multi_echelon as _empty_response_me,
)

logger = logging.getLogger(__name__)


# ── Gurobi configuration ─────────────────────────────────────────────────────

@dataclass(frozen=True)
class GurobiConfig:
    """Enterprise Gurobi solver configuration."""
    time_limit: float
    mip_gap: float
    threads: int
    seed: int
    output_flag: int
    compute_server: Optional[str] = None
    cloud_access_id: Optional[str] = None
    cloud_secret_key: Optional[str] = None
    log_file: Optional[str] = None


def _resolve_gurobi_config(
    settings: SolverRunSettings,
    payload: Any,
) -> GurobiConfig:
    """Build GurobiConfig from SolverRunSettings + Gurobi-specific overrides."""
    engine_flags = _as_dict(_read_attr(payload, "engine_flags", {}))
    grb_flags = _as_dict(engine_flags.get("gurobi", {}))
    solver_cfg = _as_dict(_read_path(payload, "settings.solver", {}))
    grb_solver_cfg = _as_dict(solver_cfg.get("gurobi", {}))

    return GurobiConfig(
        time_limit=settings.time_limit_seconds,
        mip_gap=_to_float(
            _first_non_none(
                grb_flags.get("mip_gap"),
                grb_solver_cfg.get("mip_gap"),
                os.getenv("DI_GUROBI_MIP_GAP"),
                0.01,
            ),
            0.01,
        ),
        threads=max(0, _to_int(
            _first_non_none(
                grb_flags.get("threads"),
                grb_solver_cfg.get("threads"),
                os.getenv("DI_GUROBI_THREADS"),
                0,
            ),
            0,
        )),
        seed=settings.random_seed,
        output_flag=1 if settings.log_search_progress else 0,
        compute_server=_first_non_none(
            grb_flags.get("compute_server"),
            grb_solver_cfg.get("compute_server"),
            os.getenv("DI_GUROBI_COMPUTE_SERVER"),
        ),
        cloud_access_id=_first_non_none(
            grb_flags.get("cloud_access_id"),
            os.getenv("GRB_CLOUDACCESSID"),
        ),
        cloud_secret_key=_first_non_none(
            grb_flags.get("cloud_secret_key"),
            os.getenv("GRB_CLOUDSECRETKEY"),
        ),
        log_file=_first_non_none(
            grb_flags.get("log_file"),
            grb_solver_cfg.get("log_file"),
            os.getenv("DI_GUROBI_LOG_FILE"),
        ),
    )


def _create_gurobi_env(config: GurobiConfig) -> Any:
    """Create a Gurobi environment (local, Compute Server, or Cloud)."""
    import gurobipy as gp

    env = gp.Env(empty=True)

    if config.compute_server:
        env.setParam("CSManager", config.compute_server)
        cs_access_id = os.getenv("DI_GUROBI_CS_ACCESS_ID", "")
        cs_secret = os.getenv("DI_GUROBI_CS_PASSWORD", "")
        if cs_access_id:
            env.setParam("CSAPIAccessID", cs_access_id)
        if cs_secret:
            env.setParam("CSAPISecret", cs_secret)
    elif config.cloud_access_id:
        env.setParam("CloudAccessID", config.cloud_access_id)
        env.setParam("CloudSecretKey", config.cloud_secret_key or "")

    env.setParam("OutputFlag", config.output_flag)
    env.start()
    return env


# ── status mapping ────────────────────────────────────────────────────────────

def _status_from_gurobi(model: Any, config: GurobiConfig) -> SolverStatusInfo:
    """Map Gurobi status to SolverStatusInfo."""
    from gurobipy import GRB

    grb_status = model.Status
    status_name = {
        GRB.OPTIMAL: "OPTIMAL",
        GRB.INFEASIBLE: "INFEASIBLE",
        GRB.INF_OR_UNBD: "INF_OR_UNBD",
        GRB.UNBOUNDED: "UNBOUNDED",
        GRB.SUBOPTIMAL: "SUBOPTIMAL",
        GRB.TIME_LIMIT: "TIME_LIMIT",
        GRB.NODE_LIMIT: "NODE_LIMIT",
        GRB.SOLUTION_LIMIT: "SOLUTION_LIMIT",
        GRB.INTERRUPTED: "INTERRUPTED",
        GRB.NUMERIC: "NUMERIC",
    }.get(grb_status, f"UNKNOWN_{grb_status}")

    has_incumbent = model.SolCount > 0

    if grb_status == GRB.OPTIMAL:
        return SolverStatusInfo(
            status=PlanningStatus.OPTIMAL,
            termination_reason="OPTIMAL",
            status_name=status_name,
            has_feasible_solution=True,
            time_limit_hit=False,
        )

    if grb_status in (GRB.SUBOPTIMAL, GRB.SOLUTION_LIMIT):
        return SolverStatusInfo(
            status=PlanningStatus.FEASIBLE,
            termination_reason="FEASIBLE",
            status_name=status_name,
            has_feasible_solution=True,
            time_limit_hit=False,
        )

    if grb_status in (GRB.TIME_LIMIT, GRB.NODE_LIMIT):
        if has_incumbent:
            return SolverStatusInfo(
                status=PlanningStatus.TIMEOUT,
                termination_reason="TIME_LIMIT_FEASIBLE",
                status_name=status_name,
                has_feasible_solution=True,
                time_limit_hit=True,
            )
        return SolverStatusInfo(
            status=PlanningStatus.TIMEOUT,
            termination_reason="TIME_LIMIT_NO_FEASIBLE",
            status_name=status_name,
            has_feasible_solution=False,
            time_limit_hit=True,
        )

    if grb_status == GRB.INTERRUPTED:
        return SolverStatusInfo(
            status=PlanningStatus.TIMEOUT,
            termination_reason="CANCELLED",
            status_name=status_name,
            has_feasible_solution=has_incumbent,
            time_limit_hit=False,
        )

    if grb_status in (GRB.INFEASIBLE, GRB.INF_OR_UNBD):
        return SolverStatusInfo(
            status=PlanningStatus.INFEASIBLE,
            termination_reason="INFEASIBLE",
            status_name=status_name,
            has_feasible_solution=False,
            time_limit_hit=False,
        )

    return SolverStatusInfo(
        status=PlanningStatus.ERROR,
        termination_reason=status_name,
        status_name=status_name,
        has_feasible_solution=False,
        time_limit_hit=False,
    )


# ── public API ────────────────────────────────────────────────────────────────

def gurobi_available() -> bool:
    """Return True if gurobipy is importable and licensed."""
    from ml.api.solver_availability import gurobi_available as _check
    return _check()


def solve_replenishment_gurobi(
    payload: Any,
    run_settings: Optional[SolverRunSettings] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """
    Solve a single-echelon replenishment plan using Gurobi MILP.

    Same mathematical model as ``solve_replenishment`` in the CP-SAT module.
    """
    import gurobipy as gp
    from gurobipy import GRB

    solver_settings = run_settings or _resolve_solver_run_settings(
        payload,
        default_time_limit_seconds=DEFAULT_SOLVER_SINGLE_TIME_LIMIT_SECONDS,
    )
    t0 = datetime.now(timezone.utc)

    if bool(getattr(solver_settings, "force_timeout", False)):
        return _empty_response(
            t0, "TIMEOUT",
            ["Forced timeout via settings.solver.force_timeout=true."],
            engine_name="gurobi",
            settings=solver_settings,
            termination_reason="FORCED_TIMEOUT",
            status_name="FORCED_TIMEOUT",
        )

    grb_config = _resolve_gurobi_config(solver_settings, payload)

    # ── parse objective parameters ────────────────────────────────────────
    objective = _read_attr(payload, "objective", SimpleNamespace())
    constraints = _read_attr(payload, "constraints", SimpleNamespace())
    shared_constraints = _read_attr(payload, "shared_constraints", None)

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
        ), True,
    )
    use_p90_for_service_level = _to_bool(
        _first_non_none(
            _read_attr(objective, "use_p90_for_service_level", None),
            forecast_uncertainty_cfg.get("use_p90_for_service_level"),
            True,
        ), True,
    )
    closed_loop_safety_stock_by_key_s = _parse_keyed_scaled_qty_map(
        closed_loop_patch.get("safety_stock_by_key")
    )

    coeff_order = OBJ_SCALE
    coeff_stockout = int(round(stockout_penalty * OBJ_SCALE))
    coeff_holding = int(round(holding_cost * OBJ_SCALE))

    # ── risk signals ──────────────────────────────────────────────────────
    _risk_signals = _read_attr(payload, "risk_signals", None)
    _rs = _risk_signals if _risk_signals is not None else SimpleNamespace()

    _ss_penalty_map_raw = _read_attr(_rs, "ss_penalty_by_key", None)
    ss_penalty_by_key: Dict[str, float] = {}
    if isinstance(_ss_penalty_map_raw, dict):
        ss_penalty_by_key = {
            str(k): max(1.0, _to_float(v, 1.0))
            for k, v in _ss_penalty_map_raw.items()
        }

    _ds_raw = _read_attr(_rs, "dual_source_keys", None)
    dual_source_keys: set = set()
    if isinstance(_ds_raw, (list, tuple)):
        dual_source_keys = {str(k).strip() for k in _ds_raw if k}
    dual_source_min_split: float = max(0.0, min(0.5, _to_float(
        _read_attr(_rs, "dual_source_min_split_fraction", 0.2), 0.2
    )))

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

    def _tag(tag: str, description: str, *, severity: str = "hard",
             scope: str = "global", period: Optional[str] = None,
             sku: Optional[str] = None, echelon: str = "single") -> None:
        constraint_tags.append({
            "tag": tag, "description": description, "severity": severity,
            "scope": scope, "period": period, "sku": sku, "echelon": echelon,
        })

    # ── parse constraints ─────────────────────────────────────────────────
    moq_s = _build_qty_map(_read_attr(constraints, "moq", None), "min_qty")
    pack_s = _build_qty_map(_read_attr(constraints, "pack_size", None), "pack_qty")
    maxq_s = _build_qty_map(_read_attr(constraints, "max_order_qty", None), "max_qty")
    unit_cost_map = _build_unit_cost_map(_read_attr(constraints, "unit_costs", None))
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
    )
    inv_cap_raw = _first_non_none(
        _read_attr(shared_constraints, "inventory_capacity_per_period", None),
        _read_attr(constraints, "inventory_capacity_per_period", None),
    )
    budget_per_period_raw = _read_attr(shared_constraints, "budget_per_period", None)
    volume_cap_raw = _read_attr(shared_constraints, "volume_capacity_per_period", None)
    weight_cap_raw = _read_attr(shared_constraints, "weight_capacity_per_period", None)

    # ── parse demand ──────────────────────────────────────────────────────
    forecast_by_key: Dict[Tuple[str, str], List[Tuple[date, int, Optional[int]]]] = {}
    for pt in _as_list(_read_path(payload, "demand_forecast.series", [])):
        sku = str(_read_attr(pt, "sku", "") or "").strip()
        if not sku:
            continue
        d = _parse_day(_read_attr(pt, "date", None))
        if not d:
            continue
        k = _key(_read_attr(pt, "sku", None), _read_attr(pt, "plant_id", None))
        p50_s = _s(max(0.0, _to_float(_read_attr(pt, "p50", 0.0), 0.0)))
        p90_raw = _read_attr(pt, "p90", None)
        p90_s = _s(max(0.0, _to_float(p90_raw, 0.0))) if p90_raw is not None else None
        forecast_by_key.setdefault(k, []).append((d, p50_s, p90_s))

    # items[] contract
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
            k = _key(sku, plant)
            p50 = _first_non_none(_read_attr(pt, "p50", None), _read_attr(pt, "demand", None))
            p90 = _read_attr(pt, "p90", None)
            p50_s = _s(max(0.0, _to_float(p50, 0.0)))
            p90_s = _s(max(0.0, _to_float(p90, 0.0))) if p90 is not None else None
            forecast_by_key.setdefault(k, []).append((d, p50_s, p90_s))

        item_constraints = _read_attr(item, "constraints", None)
        item_costs = _read_attr(item, "costs", None)
        moq_val = _first_non_none(_read_attr(item_constraints, "moq", None), _read_attr(item, "moq", None))
        if moq_val is not None:
            moq_s[sku] = _s(max(0.0, _to_float(moq_val, 0.0)))
        pack_val = _first_non_none(_read_attr(item_constraints, "pack_size", None), _read_attr(item, "pack_size", None))
        if pack_val is not None:
            pack_s[sku] = _s(max(0.0, _to_float(pack_val, 0.0)))
        max_val = _first_non_none(_read_attr(item_constraints, "max_order_qty", None), _read_attr(item, "max_order_qty", None))
        if max_val is not None:
            maxq_s[sku] = _s(max(0.0, _to_float(max_val, 0.0)))
        uc = _first_non_none(_read_attr(item_costs, "unit_cost", None), _read_attr(item, "unit_cost", None))
        if uc is not None:
            unit_cost_map[sku] = max(0.0, _to_float(uc, 0.0))

        vol = _first_non_none(_read_attr(item, "volume_per_unit", None))
        if vol is not None:
            sku_volume_map[sku] = max(0.0, _to_float(vol, 0.0))
        wt = _first_non_none(_read_attr(item, "weight_per_unit", None))
        if wt is not None:
            sku_weight_map[sku] = max(0.0, _to_float(wt, 0.0))

        pw = _read_attr(item, "priority_weight", None)
        if pw is not None:
            sku_priority_map[sku] = max(0.01, _to_float(pw, 1.0))

        supplier_rows = _as_list(_read_attr(item, "suppliers", None))
        if supplier_rows:
            k = _key(sku, item_plant)
            for sup in supplier_rows:
                sup_id = str(_read_attr(sup, "supplier_id", "") or "").strip()
                if not sup_id:
                    continue
                suppliers_by_key.setdefault(k, []).append(SupplierInfo(
                    supplier_id=sup_id,
                    lead_time_days=max(0, int(round(_to_float(_read_attr(sup, "lead_time_days", 0.0), 0.0)))),
                    unit_cost=max(0.0, _to_float(_read_attr(sup, "unit_cost", 0.0), 0.0)),
                    moq_s=_s(max(0.0, _to_float(_read_attr(sup, "moq", 0.0), 0.0))),
                    pack_s=_s(max(0.0, _to_float(_read_attr(sup, "pack_size", 0.0), 0.0))),
                    max_order_qty_s=_s(max(0.0, _to_float(_read_attr(sup, "max_order_qty", 0.0), 0.0))),
                    fixed_order_cost=max(0.0, _to_float(_read_attr(sup, "fixed_order_cost", 0.0), 0.0)),
                ))

    # priority weights from shared_constraints
    pw_raw = _read_attr(shared_constraints, "priority_weights", None)
    if isinstance(pw_raw, dict):
        for k_str, val in pw_raw.items():
            sku_priority_map[str(k_str).strip()] = max(0.01, _to_float(val, 1.0))

    if not forecast_by_key:
        return _empty_response(
            t0, "INFEASIBLE",
            ["No valid demand rows were provided in demand_forecast.series or items[].demand."],
            engine_name="gurobi", settings=solver_settings, termination_reason="INVALID_INPUT",
        )

    for k in forecast_by_key:
        forecast_by_key[k].sort(key=lambda r: r[0])

    # ── parse inventory ───────────────────────────────────────────────────
    inventory_seed: Dict[Tuple[str, str], Dict[str, Any]] = {}

    def _upsert_inv(k: Tuple[str, str], as_of: Optional[date],
                    on_hand: Any, ss: Any, lt: Any) -> None:
        if as_of is None:
            return
        prev = inventory_seed.get(k)
        if prev and as_of <= prev["as_of_date"]:
            return
        inventory_seed[k] = {
            "as_of_date": as_of,
            "on_hand_s": _s(max(0.0, _to_float(on_hand, 0.0))),
            "safety_stock_s": _s(max(0.0, _to_float(ss, 0.0))),
            "lead_time_days": max(0, int(round(_to_float(lt, 0.0)))),
        }

    for row in _as_list(_read_attr(payload, "inventory", None)):
        _upsert_inv(
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
        k = _key(sku, plant)
        first_day = forecast_by_key.get(k, [(datetime.now(timezone.utc).date(), 0, None)])[0][0]
        as_of = _parse_day(_read_attr(item, "as_of_date", None)) or first_day
        _upsert_inv(k, as_of, _read_attr(item, "on_hand", 0.0),
                     _read_attr(item, "safety_stock", 0.0),
                     _read_attr(item, "lead_time_days", 0.0))

    # ── parse open POs ────────────────────────────────────────────────────
    open_po_by_key: Dict[Tuple[str, str], Dict[date, int]] = {}
    for po in _as_list(_read_attr(payload, "open_pos", None)):
        d = _parse_day(_read_attr(po, "eta_date", None))
        if not d:
            continue
        k = _key(_read_attr(po, "sku", None), _read_attr(po, "plant_id", None))
        qty_s = _s(max(0.0, _to_float(_read_attr(po, "qty", 0.0), 0.0)))
        cal = open_po_by_key.setdefault(k, {})
        cal[d] = cal.get(d, 0) + qty_s

    horizon_days = max(1, int(_read_attr(payload, "planning_horizon_days", 1) or 1))
    ordered_keys = sorted(forecast_by_key.keys(), key=lambda k: (k[0], k[1]))

    # ══════════════════════════════════════════════════════════════════════
    # BUILD GUROBI MODEL
    # ══════════════════════════════════════════════════════════════════════
    env = _create_gurobi_env(grb_config)
    model = gp.Model("replenishment", env=env)

    model.Params.TimeLimit = grb_config.time_limit
    model.Params.MIPGap = grb_config.mip_gap
    model.Params.Seed = grb_config.seed
    if grb_config.threads > 0:
        model.Params.Threads = grb_config.threads
    if grb_config.log_file:
        model.Params.LogFile = grb_config.log_file

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

    for key_idx, k in enumerate(ordered_keys):
        sku, plant_id = k
        series = forecast_by_key[k]
        first_day = series[0][0]
        last_allowed = first_day + timedelta(days=horizon_days - 1)
        series = [(d, p50, p90) for d, p50, p90 in series if d <= last_allowed]
        if not series:
            continue

        seed = inventory_seed.get(k, {"on_hand_s": 0, "safety_stock_s": 0, "lead_time_days": 0})
        on_hand_s: int = int(seed["on_hand_s"])
        lead_time: int = int(seed["lead_time_days"])

        sku_key_str = f"{sku}|{plant_id or ''}"
        is_expedited = bool(sku_key_str in expedite_keys and expedite_lt_reduction > 0)
        original_lead_time = lead_time
        if is_expedited:
            lead_time = max(0, lead_time - expedite_lt_reduction)

        open_po_cal = open_po_by_key.get(k, {})
        days_list = [d for d, _, _ in series]
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

        # Safety stock computation
        base_ss = int(seed.get("safety_stock_s", 0))
        derived_ss: Optional[int] = None
        if use_p90_for_safety_stock and p90_values_s:
            avg_p50_s = sum(p50 for _, p50, _ in series) / len(series)
            avg_p90_s = sum((p90 if p90 is not None else p50) for _, p50, p90 in series) / len(series)
            spread_s = max(0.0, avg_p90_s - avg_p50_s)
            derived_ss = max(0, int(round(avg_p50_s + safety_stock_alpha * spread_s)))

        cl_override = _lookup_keyed_value(closed_loop_safety_stock_by_key_s, k)
        if cl_override is not None:
            safety_stock_s_val = max(0, int(cl_override))
            keys_with_closed_loop_safety_stock += 1
        elif derived_ss is not None:
            safety_stock_s_val = max(base_ss, derived_ss)
            if safety_stock_s_val > base_ss:
                keys_with_derived_safety_stock += 1
        else:
            safety_stock_s_val = base_ss

        # Variable bounds
        ub_order = max(total_demand_s, sku_moq_s if sku_moq_s else 1, on_hand_s + 1, SCALE)
        if sku_max_s > 0:
            ub_order = min(ub_order, max(sku_max_s, SCALE))
        ub_inv = on_hand_s + ub_order * T + 1
        ub_back = max(total_demand_s + 1, SCALE)

        var_tag = f"{sku}_{plant_id or 'NA'}"
        order_vars = [model.addVar(vtype=GRB.INTEGER, lb=0, ub=ub_order, name=f"ord_{var_tag}_{t}") for t in range(T)]
        inv_vars = [model.addVar(vtype=GRB.INTEGER, lb=0, ub=ub_inv, name=f"inv_{var_tag}_{t}") for t in range(T)]
        back_vars = [model.addVar(vtype=GRB.INTEGER, lb=0, ub=ub_back, name=f"back_{var_tag}_{t}") for t in range(T)]
        y_vars = [model.addVar(vtype=GRB.BINARY, name=f"y_{var_tag}_{t}") for t in range(T)]

        k_vars: Optional[List[Any]] = None
        if sku_pack_s > SCALE:
            max_k = ub_order // sku_pack_s + 2
            k_vars = [model.addVar(vtype=GRB.INTEGER, lb=0, ub=int(max_k), name=f"k_{var_tag}_{t}") for t in range(T)]

        # Objective coefficients (same as CP-SAT)
        tie_rank = len(ordered_keys) - key_idx
        back_coeff = max(1, coeff_stockout * max(1, int(round(sku_priority * 100))) + tie_rank)
        effective_unit_cost = sku_unit_cost
        if is_expedited and expedite_cost_mult > 1.0:
            effective_unit_cost = sku_unit_cost * expedite_cost_mult
        order_coeff = max(1, coeff_order + int(round(effective_unit_cost * 10)))

        # Multi-supplier variables
        sups = suppliers_by_key.get(k, [])
        has_suppliers = len(sups) > 1
        supplier_order_vars: Dict[str, List[Any]] = {}
        supplier_y_vars: Dict[str, List[Any]] = {}
        supplier_k_vars: Dict[str, Optional[List[Any]]] = {}

        model.update()  # ensure variables are registered

        if has_suppliers:
            for sup in sups:
                sid = sup.supplier_id
                s_tag = f"{var_tag}_{sid}"
                s_order = [model.addVar(vtype=GRB.INTEGER, lb=0, ub=ub_order, name=f"ord_{s_tag}_{t}") for t in range(T)]
                s_y = [model.addVar(vtype=GRB.BINARY, name=f"y_{s_tag}_{t}") for t in range(T)]
                supplier_order_vars[sid] = s_order
                supplier_y_vars[sid] = s_y

                s_k: Optional[List[Any]] = None
                if sup.pack_s > SCALE:
                    mk = ub_order // sup.pack_s + 2
                    s_k = [model.addVar(vtype=GRB.INTEGER, lb=0, ub=int(mk), name=f"k_{s_tag}_{t}") for t in range(T)]
                supplier_k_vars[sid] = s_k

            model.update()

            for sup in sups:
                sid = sup.supplier_id
                for t in range(T):
                    if supplier_k_vars[sid] is not None:
                        model.addConstr(supplier_order_vars[sid][t] == supplier_k_vars[sid][t] * sup.pack_s, name=f"pack_{sid}_{t}")
                    if sup.moq_s > 0:
                        model.addGenConstrIndicator(supplier_y_vars[sid][t], True, supplier_order_vars[sid][t], GRB.GREATER_EQUAL, sup.moq_s, name=f"moq_on_{sid}_{t}")
                        model.addGenConstrIndicator(supplier_y_vars[sid][t], False, supplier_order_vars[sid][t], GRB.EQUAL, 0, name=f"moq_off_{sid}_{t}")
                    else:
                        model.addGenConstrIndicator(supplier_y_vars[sid][t], False, supplier_order_vars[sid][t], GRB.EQUAL, 0, name=f"y_off_{sid}_{t}")
                        model.addGenConstrIndicator(supplier_y_vars[sid][t], True, supplier_order_vars[sid][t], GRB.GREATER_EQUAL, 1, name=f"y_on_{sid}_{t}")
                    if sup.max_order_qty_s > 0:
                        model.addConstr(supplier_order_vars[sid][t] <= sup.max_order_qty_s, name=f"maxq_{sid}_{t}")

            # Aggregate: order[t] = sum of supplier orders
            for t in range(T):
                model.addConstr(order_vars[t] == gp.quicksum(supplier_order_vars[sup.supplier_id][t] for sup in sups), name=f"agg_{var_tag}_{t}")

            # Dual-source constraint
            if sku_key_str in dual_source_keys and len(sups) >= 2:
                split_ppm = int(round(dual_source_min_split * 1_000_000))
                total_ord_aux = model.addVar(vtype=GRB.INTEGER, lb=0, ub=ub_order * T + 1, name=f"ds_total_{var_tag}")
                model.addConstr(total_ord_aux == gp.quicksum(order_vars[t] for t in range(T)), name=f"ds_total_eq_{var_tag}")
                for sup in sups:
                    sid = sup.supplier_id
                    sup_total = model.addVar(vtype=GRB.INTEGER, lb=0, ub=ub_order * T + 1, name=f"ds_sup_{var_tag}_{sid}")
                    model.addConstr(sup_total == gp.quicksum(supplier_order_vars[sid][t] for t in range(T)), name=f"ds_sup_eq_{var_tag}_{sid}")
                    model.addConstr(sup_total * 1_000_000 >= split_ppm * total_ord_aux, name=f"ds_split_{var_tag}_{sid}")
                _tag(f"DUAL_SOURCE[{sku}]", f"Risk-driven: each supplier >= {dual_source_min_split:.0%} of total.",
                     severity="hard", scope="sku", sku=sku)

        # ── per-period constraints ────────────────────────────────────────
        for t in range(T):
            day = days_list[t]
            order_vars_by_day.setdefault(day, []).append(order_vars[t])
            inv_vars_by_day.setdefault(day, []).append(inv_vars[t])

            if not has_suppliers:
                # Pack size
                if k_vars is not None:
                    model.addConstr(order_vars[t] == k_vars[t] * sku_pack_s, name=f"pack_{var_tag}_{t}")
                    _tag(f"PACK[{sku},{t}]", "Order quantity must be a pack-size multiple.", scope="sku_period", period=day.isoformat(), sku=sku)

                # MOQ via indicator constraints
                if sku_moq_s > 0:
                    model.addGenConstrIndicator(y_vars[t], True, order_vars[t], GRB.GREATER_EQUAL, sku_moq_s, name=f"moq_on_{var_tag}_{t}")
                    model.addGenConstrIndicator(y_vars[t], False, order_vars[t], GRB.EQUAL, 0, name=f"moq_off_{var_tag}_{t}")
                    _tag(f"MOQ[{sku},{t}]", "Order quantity must satisfy MOQ when ordered.", scope="sku_period", period=day.isoformat(), sku=sku)
                else:
                    model.addGenConstrIndicator(y_vars[t], False, order_vars[t], GRB.EQUAL, 0, name=f"y_off_{var_tag}_{t}")
                    model.addGenConstrIndicator(y_vars[t], True, order_vars[t], GRB.GREATER_EQUAL, 1, name=f"y_on_{var_tag}_{t}")

                # Max order
                if sku_max_s > 0:
                    model.addConstr(order_vars[t] <= sku_max_s, name=f"maxq_{var_tag}_{t}")
                    _tag(f"MAXQ[{sku},{t}]", "Per-SKU max order quantity.", scope="sku_period", period=day.isoformat(), sku=sku)

            # Inventory balance
            open_po_t = open_po_cal.get(day, 0)
            const_rhs = on_hand_s + open_po_t - demand_s_list[t] if t == 0 else open_po_t - demand_s_list[t]
            lhs = inv_vars[t] - back_vars[t]

            if has_suppliers:
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
            model.addConstr(lhs == const_rhs, name=f"bal_{var_tag}_{t}")
            _tag(f"BALANCE_INV[{sku},{t}]", "Inventory flow balance.", scope="sku_period", period=day.isoformat(), sku=sku)

        all_order_vars.extend(order_vars)

        # ── objective terms ───────────────────────────────────────────────
        if has_suppliers:
            for sup in sups:
                sid = sup.supplier_id
                eff_sup_cost = sup.unit_cost
                if is_expedited and expedite_cost_mult > 1.0:
                    eff_sup_cost = sup.unit_cost * expedite_cost_mult
                sup_order_coeff = max(1, coeff_order + int(round(eff_sup_cost * 10)))
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

        # Safety stock soft constraint
        ss_slack_vars: Optional[List[Any]] = None
        if safety_stock_s_val > 0:
            ss_slack_vars = [model.addVar(vtype=GRB.INTEGER, lb=0, ub=safety_stock_s_val, name=f"ss_slack_{var_tag}_{t}") for t in range(T)]
            model.update()
            for t in range(T):
                model.addConstr(inv_vars[t] + ss_slack_vars[t] >= safety_stock_s_val, name=f"ss_{var_tag}_{t}")
                _tag(f"SAFETY_STOCK[{sku},{t}]", "Safety stock soft floor.", severity="soft", scope="sku_period", period=days_list[t].isoformat(), sku=sku)
            ss_mult = ss_penalty_by_key.get(sku_key_str, 1.0)
            eff_ss_coeff = int(round(safety_stock_penalty * ss_mult * OBJ_SCALE))
            if eff_ss_coeff > 0:
                for v in ss_slack_vars:
                    obj_terms.append(eff_ss_coeff * v)

        sku_var_maps[k] = {
            "order": order_vars, "inv": inv_vars, "back": back_vars, "y": y_vars, "k": k_vars, "ss_slack": ss_slack_vars,
            "supplier_order": supplier_order_vars if has_suppliers else {},
            "supplier_y": supplier_y_vars if has_suppliers else {},
        }
        sku_meta[k] = {
            "days": days_list, "demand_s": demand_s_list, "lead_time": lead_time,
            "safety_stock_s": safety_stock_s_val, "suppliers": sups if has_suppliers else [],
            "lead_time_original": original_lead_time, "expedited": is_expedited,
            "expedite_lt_reduction": expedite_lt_reduction if is_expedited else 0,
            "expedite_cost_mult": expedite_cost_mult if is_expedited else 1.0,
            "dual_source_enforced": bool(has_suppliers and sku_key_str in dual_source_keys and len(sups) >= 2),
            "ss_penalty_mult": ss_penalty_by_key.get(sku_key_str, 1.0),
        }

    if not sku_var_maps:
        return _empty_response(
            t0, "INFEASIBLE",
            ["No valid SKU/plant data could be planned."],
            engine_name="gurobi", settings=solver_settings, termination_reason="INVALID_INPUT",
        )

    # ── shared constraints ────────────────────────────────────────────────
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
            model.addConstr(gp.quicksum(order_vars_by_day.get(day, [])) <= cap_s, name=f"cap_prod_{day.isoformat()}")
            _tag(f"CAP_PROD[{day.isoformat()}]", "Shared production/order capacity.", scope="period", period=day.isoformat())

    if inv_cap_raw is not None:
        for idx, day in enumerate(all_days):
            cap = _capacity_for_period(inv_cap_raw, idx, day)
            if cap is None:
                continue
            cap_s = _s(max(0.0, cap))
            inventory_cap_by_day_s[day] = cap_s
            model.addConstr(gp.quicksum(inv_vars_by_day.get(day, [])) <= cap_s, name=f"cap_inv_{day.isoformat()}")
            _tag(f"CAP_INV[{day.isoformat()}]", "Shared inventory capacity.", scope="period", period=day.isoformat())

    budget_cap_s: Optional[int] = None
    budget_mode_effective: Optional[str] = None
    if budget_cap is not None and all_order_vars:
        auto_cost_budget = any(v > 0.0 for v in unit_cost_map.values())
        use_cost_budget = budget_mode == "spend" or (budget_mode not in {"quantity"} and auto_cost_budget)
        if use_cost_budget:
            spend_terms: List[Any] = []
            for k in ordered_keys:
                if k not in sku_var_maps:
                    continue
                sk = k[0]
                coeff = max(0, int(round(max(0.0, unit_cost_map.get(sk, 1.0)) * SCALE)))
                for v in sku_var_maps[k]["order"]:
                    spend_terms.append(coeff * v)
            budget_cap_cost_s2 = int(round(budget_cap * SCALE * SCALE))
            model.addConstr(gp.quicksum(spend_terms) <= budget_cap_cost_s2, name="budget_global_spend")
            budget_mode_effective = "spend"
            _tag("BUDGET_GLOBAL", "Shared budget cap across all SKUs (spend).")
        else:
            budget_cap_s = _s(budget_cap)
            model.addConstr(gp.quicksum(all_order_vars) <= budget_cap_s, name="budget_global_qty")
            budget_mode_effective = "quantity"
            _tag("BUDGET_GLOBAL", "Shared budget cap across all SKUs (quantity).")

    # Service level
    service_level_demand_basis_s = (
        total_demand_s_for_service_level
        if (use_p90_for_service_level and total_demand_s_for_service_level > 0)
        else total_demand_s_global
    )
    service_level_basis_label = "p90_or_p50" if (use_p90_for_service_level and total_demand_s_for_service_level > 0) else "p50"
    if service_level_target is not None:
        allowed_backlog = int(round(max(0.0, 1.0 - service_level_target) * service_level_demand_basis_s))
        end_back_vars = [vars_["back"][-1] for vars_ in sku_var_maps.values() if vars_["back"]]
        if end_back_vars:
            model.addConstr(gp.quicksum(end_back_vars) <= allowed_backlog, name="service_level_global")
            _tag("SERVICE_LEVEL_GLOBAL", "Hard end-of-horizon service-level target.")

    # ── objective ─────────────────────────────────────────────────────────
    if obj_terms:
        model.setObjective(gp.quicksum(obj_terms), GRB.MINIMIZE)

    model.update()

    # ── solve ─────────────────────────────────────────────────────────────
    if cancel_check is not None:
        def _gurobi_callback(m: Any, where: int) -> None:
            if where == GRB.Callback.MIP or where == GRB.Callback.MIPNODE:
                try:
                    if cancel_check():
                        m.terminate()
                except Exception:
                    pass

        model.optimize(_gurobi_callback)
    else:
        model.optimize()

    solve_time_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
    status_info = _status_from_gurobi(model, grb_config)

    # ── infeasible path ───────────────────────────────────────────────────
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
        reasons_detailed = [{
            "category": c,
            "top_offending_tags": infeasibility_analysis["top_offending_tags"][:8],
            "suggested_actions": infeasibility_analysis["suggestions"][:4],
        } for c in infeasibility_analysis["categories"]]

        constraints_checked = [
            _mk_constraint_check(
                name="model_feasibility", tag="GRB_FEASIBILITY",
                passed=False,
                details=f"Gurobi status '{status_info.status_name}' ({status_info.termination_reason}).",
                description="Overall model feasibility status.",
            ),
        ]

        return finalize_planning_response({
            "status": status_info.status.value,
            "plan_lines": [],
            "kpis": {"estimated_service_level": None, "estimated_stockout_units": None,
                     "estimated_holding_units": None, "estimated_total_cost": None},
            "solver_meta": _build_solver_meta(
                engine_name="gurobi", solver_name="gurobi_milp",
                status_info=status_info, settings=solver_settings,
                solve_time_ms=solve_time_ms, objective_value=None,
                best_bound=None, gap=None,
            ),
            "infeasible_reasons": [f"Gurobi status: {status_info.status_name}"],
            "infeasible_reason_details": reasons_detailed,
            "proof": {"objective_terms": [], "constraints_checked": constraints_checked,
                      "constraint_tags": constraint_tags},
        }, default_engine="gurobi", default_status=status_info.status)

    # ══════════════════════════════════════════════════════════════════════
    # EXTRACT SOLUTION
    # ══════════════════════════════════════════════════════════════════════
    plan_rows: List[Dict[str, Any]] = []
    total_order_qty = 0.0
    total_spend = 0.0
    total_stockout = 0.0
    total_holding = 0.0
    total_demand = 0.0
    infeasible_reasons: List[str] = []

    for k in ordered_keys:
        if k not in sku_var_maps:
            continue
        sku, plant_id = k
        vars_ = sku_var_maps[k]
        meta = sku_meta[k]
        days_list = meta["days"]
        demand_s_list = meta["demand_s"]
        sups: List[SupplierInfo] = meta["suppliers"]
        lead_time_val: int = meta["lead_time"]
        T = len(days_list)

        total_demand += _us(sum(demand_s_list))

        if sups:
            for sup in sups:
                eff_lt = sup.lead_time_days
                if meta["expedited"] and expedite_lt_reduction > 0:
                    eff_lt = max(0, sup.lead_time_days - expedite_lt_reduction)
                for t in range(T):
                    s_qty_s = int(round(vars_["supplier_order"][sup.supplier_id][t].X))
                    if s_qty_s > 0:
                        s_qty = _us(s_qty_s)
                        order_day = days_list[t]
                        arrival_day = order_day + timedelta(days=eff_lt)
                        plan_rows.append({
                            "sku": sku,
                            "plant_id": plant_id or None,
                            "supplier_id": sup.supplier_id,
                            "order_date": order_day.isoformat(),
                            "arrival_date": arrival_day.isoformat(),
                            "order_qty": float(round(s_qty, 6)),
                        })
                        total_order_qty += s_qty
                        total_spend += s_qty * sup.unit_cost
        else:
            for t in range(T):
                order_val_s = int(round(vars_["order"][t].X))
                if order_val_s > 0:
                    order_qty = _us(order_val_s)
                    order_day = days_list[t]
                    arrival_day = order_day + timedelta(days=lead_time_val)
                    plan_rows.append({
                        "sku": sku,
                        "plant_id": plant_id or None,
                        "order_date": order_day.isoformat(),
                        "arrival_date": arrival_day.isoformat(),
                        "order_qty": float(round(order_qty, 6)),
                    })
                    total_order_qty += order_qty
                    total_spend += order_qty * sku_unit_cost

        for t in range(T):
            total_stockout += _us(int(round(vars_["back"][t].X)))
            total_holding += _us(int(round(vars_["inv"][t].X)))

    # ── KPIs ──────────────────────────────────────────────────────────────
    service_level = 1.0 - (total_stockout / total_demand) if total_demand > 0 else None
    est_cost = total_order_qty + stockout_penalty * total_stockout + holding_cost * total_holding

    # ── objective value / gap ─────────────────────────────────────────────
    obj_real = float(round(model.ObjVal / (OBJ_SCALE * SCALE), 6)) if hasattr(model, "ObjVal") else None
    bound_real = float(round(model.ObjBound / (OBJ_SCALE * SCALE), 6)) if hasattr(model, "ObjBound") else None
    gap = model.MIPGap if hasattr(model, "MIPGap") else None

    # ── constraint verification ───────────────────────────────────────────
    constraints_checked: List[Dict[str, Any]] = []
    all_passed = True

    # Budget check
    if budget_cap is not None:
        if budget_mode_effective == "spend":
            budget_used = total_spend
        else:
            budget_used = total_order_qty
        budget_passed = budget_used <= budget_cap * 1.001
        budget_slack = max(0.0, budget_cap - budget_used)
        budget_binding = budget_slack < budget_cap * 0.03 if budget_cap > 0 else False
        if not budget_passed:
            all_passed = False
            infeasible_reasons.append("Budget cap exceeded.")
        constraints_checked.append(_mk_constraint_check(
            name="budget_cap", tag="BUDGET_GLOBAL", passed=budget_passed,
            details=f"Used {budget_used:.2f} of {budget_cap:.2f} ({budget_mode_effective}).",
            description="Shared budget cap across all SKUs.",
            binding=budget_binding, slack=round(budget_slack, 4),
            slack_unit="USD" if budget_mode_effective == "spend" else "units",
        ))

    # Capacity checks
    for day in all_days:
        if day in production_cap_by_day_s:
            cap_s = production_cap_by_day_s[day]
            used_s = sum(int(round(v.X)) for v in order_vars_by_day.get(day, []))
            passed = used_s <= cap_s + 1
            if not passed:
                all_passed = False
            constraints_checked.append(_mk_constraint_check(
                name="shared_production_cap", tag=f"CAP_PROD[{day.isoformat()}]",
                passed=passed, details=f"Used {_us(used_s):.2f} of {_us(cap_s):.2f}.",
                description="Shared production capacity.", scope="period", period=day.isoformat(),
                binding=used_s >= cap_s - 1,
                slack=round(_us(max(0, cap_s - used_s)), 4), slack_unit="units",
            ))

    # Service level check
    if service_level_target is not None and service_level is not None:
        sl_passed = service_level >= service_level_target - 0.001
        if not sl_passed:
            all_passed = False
            infeasible_reasons.append(f"Service level {service_level:.4f} < target {service_level_target:.4f}.")
        constraints_checked.append(_mk_constraint_check(
            name="service_level_target", tag="SERVICE_LEVEL_GLOBAL",
            passed=sl_passed,
            details=f"Achieved {service_level:.4f} vs target {service_level_target:.4f}.",
            description="End-of-horizon service level target.",
            binding=abs(service_level - service_level_target) < 0.005 if service_level else False,
        ))

    # Overall feasibility
    status = status_info.status
    if status == PlanningStatus.TIMEOUT:
        status = PlanningStatus.TIMEOUT
    elif not all_passed:
        status = PlanningStatus.INFEASIBLE
    else:
        status = status_info.status if status_info.status in {PlanningStatus.OPTIMAL, PlanningStatus.FEASIBLE} else PlanningStatus.FEASIBLE

    # ── proof ─────────────────────────────────────────────────────────────
    objective_terms = [
        {"name": "ordered_units", "value": round(total_order_qty, 6),
         "note": "Total planned replenishment quantity.", "units": "units",
         "business_label": "Procurement volume"},
        {"name": "stockout_units", "value": round(total_stockout, 6),
         "note": "Projected unmet demand units (backlog).", "units": "units",
         "business_label": "Shortage exposure",
         "qty_driver": round(total_stockout, 6), "unit_cost_driver": round(stockout_penalty, 6)},
        {"name": "holding_units", "value": round(total_holding, 6),
         "note": "Projected positive inventory accumulation.", "units": "units",
         "business_label": "Inventory holding",
         "qty_driver": round(total_holding, 6), "unit_cost_driver": round(holding_cost, 6)},
        {"name": "estimated_total_cost", "value": round(est_cost, 6),
         "note": "ordering_qty + stockout_penalty × backlog + holding_cost × inventory.",
         "units": "cost_units", "business_label": "Total plan cost"},
    ]

    solver_meta = _build_solver_meta(
        engine_name="gurobi", solver_name="gurobi_milp",
        status_info=SolverStatusInfo(
            status=status, termination_reason=status_info.termination_reason,
            status_name=status_info.status_name,
            has_feasible_solution=True, time_limit_hit=status_info.time_limit_hit,
        ),
        settings=solver_settings, solve_time_ms=solve_time_ms,
        objective_value=obj_real, best_bound=bound_real, gap=gap,
        extra={
            "gurobi_node_count": int(model.NodeCount) if hasattr(model, "NodeCount") else None,
            "gurobi_simplex_iterations": int(model.IterCount) if hasattr(model, "IterCount") else None,
            "uncertainty_bridge": {
                "safety_stock_alpha": round(safety_stock_alpha, 6),
                "use_p90_for_safety_stock": bool(use_p90_for_safety_stock),
                "use_p90_for_service_level": bool(use_p90_for_service_level),
                "service_level_demand_basis": service_level_basis_label,
                "keys_with_p90": keys_with_p90,
                "keys_with_derived_safety_stock": keys_with_derived_safety_stock,
                "keys_with_closed_loop_safety_stock": keys_with_closed_loop_safety_stock,
            },
        },
    )

    # ── cleanup ───────────────────────────────────────────────────────────
    try:
        model.dispose()
        env.dispose()
    except Exception:
        pass

    return finalize_planning_response({
        "status": status.value,
        "plan_lines": plan_rows,
        "kpis": {
            "estimated_service_level": round(service_level, 6) if service_level is not None else None,
            "estimated_stockout_units": round(total_stockout, 6),
            "estimated_holding_units": round(total_holding, 6),
            "estimated_total_cost": round(est_cost, 6),
        },
        "solver_meta": solver_meta,
        "infeasible_reasons": sorted(set(infeasible_reasons)),
        "infeasible_reason_details": [],
        "proof": {
            "objective_terms": objective_terms,
            "constraints_checked": constraints_checked,
            "constraint_tags": constraint_tags,
        },
    }, default_engine="gurobi", default_status=status)


def _infer_period_days_grb(sorted_dates: List[Any]) -> int:
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


def _build_qty_map_me_grb(rows: Any, attr: str) -> Dict[str, float]:
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


def _build_unit_cost_map_me_grb(rows: Any) -> Dict[str, float]:
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


def _capacity_scalar_and_calendar_grb(raw_value: Any) -> Tuple[Optional[float], Dict[date, float]]:
    """Parse scalar capacity or [{date, capacity},...] calendar."""
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


def _resolve_capacity_raw_grb(payload: Any, section: str, attr: str) -> Any:
    section_obj = getattr(payload, section, None)
    if section_obj is None:
        return None
    return getattr(section_obj, attr, None)


def _resolve_capacity_for_multi_grb(
    payload: Any, attr: str,
) -> Tuple[Optional[float], Dict[date, float]]:
    raw = _resolve_capacity_raw_grb(payload, "shared_constraints", attr)
    if raw is None:
        raw = _resolve_capacity_raw_grb(payload, "multi_echelon", attr)
    if raw is None:
        raw = _resolve_capacity_raw_grb(payload, "constraints", attr)
    return _capacity_scalar_and_calendar_grb(raw)


def _capacity_for_day_grb(
    day: date,
    scalar_capacity: Optional[float],
    by_day_capacity: Dict[date, float],
) -> Optional[float]:
    if day in by_day_capacity:
        return by_day_capacity[day]
    return scalar_capacity


# ── public multi-echelon API ───────────────────────────────────────────────────


def solve_replenishment_multi_echelon_gurobi(
    payload: Any,
    run_settings: Optional[SolverRunSettings] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """
    Multi-echelon BOM-coupled MILP using Gurobi.

    Decision variables per (item i, period t):
      order[i,t]  - int >= 0 : units ordered/produced at period t
      inv[i,t]    - int >= 0 : on-hand inventory at end of period t
      back[i,t]   - int >= 0 : backlog at end of period t
      y[i,t]      - bool     : 1 when an order is placed (MOQ enforcement)

    Item flow balance (supports multi-layer BOM):
      qty_scale * (inv[i,t] - back[i,t]) =
          qty_scale * (inv[i,t-1] - back[i,t-1] + arriving_i[t] - external_demand[i,t])
          - SUM_parent (usage[parent,i] * qty_scale) * produced_parent[t]

    Hard feasibility constraint (for every BOM child i):
      SUM_parent usage_scaled[parent,i] * produced_parent[t]
          <= qty_scale * (inv[i,t-1] + arriving_i[t])
    """
    import gurobipy as gp
    from gurobipy import GRB

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

    t0 = datetime.now(timezone.utc)
    if bool(getattr(solver_settings, "force_timeout", False)):
        return _empty_response_me(
            t0,
            "TIMEOUT",
            ["Forced timeout via settings.solver.force_timeout=true."],
            engine_name="gurobi",
            settings=solver_settings,
            termination_reason="FORCED_TIMEOUT",
            status_name="FORCED_TIMEOUT",
        )

    qty_scale: int = 1_000
    cost_scale: int = 100
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
        k = _key(pt.sku, pt.plant_id)
        demand_rows_by_fg.setdefault(k, []).append((d, max(0.0, _to_float(pt.p50, 0.0))))

    for k in list(demand_rows_by_fg.keys()):
        rows = sorted(demand_rows_by_fg[k], key=lambda r: r[0])
        if not rows:
            del demand_rows_by_fg[k]
            continue
        first_day = rows[0][0]
        last_day = first_day + timedelta(days=horizon_days - 1)
        filtered = [(d, q) for d, q in rows if d <= last_day]
        if filtered:
            demand_rows_by_fg[k] = filtered
        else:
            del demand_rows_by_fg[k]

    if not demand_rows_by_fg:
        return _empty_response_me(
            t0,
            "INFEASIBLE",
            ["No valid demand_forecast.series rows within horizon."],
            engine_name="gurobi",
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
            engine_name="gurobi",
            settings=solver_settings,
            termination_reason="INVALID_INPUT",
        )

    period_days = _infer_period_days_grb(horizon_dates)
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
        raw_bom_rows.append({
            "parent_sku": parent_sku,
            "child_sku": child_sku,
            "usage_qty": usage_qty,
            "plant_id": usage_plant,
            "level": getattr(usage, "level", None),
        })

    if not raw_bom_rows:
        return _empty_response_me(
            t0,
            "INFEASIBLE",
            ["No valid BOM usage rows were provided; multi-echelon requires bom_usage."],
            engine_name="gurobi",
            settings=solver_settings,
            termination_reason="INVALID_INPUT",
        )

    # ── 3. inventory seed ─────────────────────────────────────────────────────
    inventory_state: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for row in payload.inventory or []:
        k = _key(row.sku, row.plant_id)
        d = _parse_day(row.as_of_date)
        if not d:
            continue
        prev = inventory_state.get(k)
        if not prev or d > prev["as_of_date"]:
            inventory_state[k] = {
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
        k = _key(po.sku, po.plant_id)
        idx = day_to_idx[eta_day]
        bucket = open_pos_by_key_idx.setdefault(k, {})
        bucket[idx] = bucket.get(idx, 0.0) + max(0.0, _to_float(po.qty, 0.0))

    # ── 5. resolve BOM edges to item keys (multi-layer parent->child graph) ───
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
                    candidate_plants.update({kk[1] for kk in fg_keys if kk[0] == parent_sku})
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
            engine_name="gurobi",
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
        next_frontier_fg: Dict[Tuple[str, str], Set[str]] = {}
        for parent_key, fg_set in root_frontier.items():
            for child_key, _, _ in children_by_parent.get(parent_key, []):
                existing = root_fg_by_key.setdefault(child_key, set())
                new_fg = set(fg_set) - existing
                if not new_fg:
                    continue
                existing.update(new_fg)
                next_frontier_fg.setdefault(child_key, set()).update(new_fg)
        root_frontier = next_frontier_fg
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
        k: sum(q for _, q in demand_rows_by_fg.get(k, []))
        for k in fg_keys
    }
    expected_total_need_float: Dict[Tuple[str, str], float] = {
        k: external_demand_float.get(k, 0.0)
        for k in item_keys
    }
    demand_frontier: Dict[Tuple[str, str], float] = {
        k: qty for k, qty in expected_total_need_float.items() if qty > 0.0
    }
    expected_need_cap = 1_000_000_000.0
    expected_depth_used = 0
    while demand_frontier and expected_depth_used < max_bom_depth:
        next_frontier_dem: Dict[Tuple[str, str], float] = {}
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
                next_frontier_dem[child_key] = min(
                    expected_need_cap,
                    next_frontier_dem.get(child_key, 0.0) + delta,
                )
        demand_frontier = next_frontier_dem
        expected_depth_used += 1

    expected_internal_demand_scaled: Dict[Tuple[str, str], int] = {}
    for k in item_keys:
        total_need = expected_total_need_float.get(k, 0.0)
        external_need = external_demand_float.get(k, 0.0)
        internal_need = max(0.0, total_need - external_need)
        expected_internal_demand_scaled[k] = max(0, int(round(internal_need * qty_scale)))

    # Demand-by-period propagation for diagnostics / projection visibility.
    expected_need_by_key_idx: Dict[Tuple[str, str], Dict[int, float]] = {k: {} for k in item_keys}
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
        next_period_frontier: Dict[Tuple[str, str], Dict[int, float]] = {}
        for parent_key, period_qty in period_frontier.items():
            for child_key, _, usage_qty in children_by_parent.get(parent_key, []):
                child_total_bucket = expected_need_by_key_idx.setdefault(child_key, {})
                child_frontier_bucket = next_period_frontier.setdefault(child_key, {})
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
            k: b for k, b in next_period_frontier.items() if any(v > 0.0 for v in b.values())
        }
        period_depth_used += 1

    expected_dependent_need_by_key_idx: Dict[Tuple[str, str], Dict[int, float]] = {}
    for k in component_keys:
        total_bucket = expected_need_by_key_idx.get(k, {})
        ext_bucket = demand_by_fg_idx_scaled.get(k, {})
        dep_bucket: Dict[int, float] = {}
        for t, total in total_bucket.items():
            dep = max(0.0, total - (ext_bucket.get(t, 0) / qty_scale))
            if dep > 1e-12:
                dep_bucket[t] = dep
        expected_dependent_need_by_key_idx[k] = dep_bucket

    # ── 7. constraint maps (float, unscaled) ──────────────────────────────────
    moq_map = _build_qty_map_me_grb(payload.constraints.moq, "min_qty")
    pack_map = _build_qty_map_me_grb(payload.constraints.pack_size, "pack_qty")
    max_map = _build_qty_map_me_grb(payload.constraints.max_order_qty, "max_qty")
    unit_cost_map = _build_unit_cost_map_me_grb(getattr(payload.constraints, "unit_costs", None))
    budget_cap_scaled: Optional[int] = None
    if getattr(payload.constraints, "budget_cap", None) is not None:
        budget_cap_scaled = max(
            0, int(round(max(0.0, _to_float(payload.constraints.budget_cap, 0.0)) * qty_scale))
        )

    # ── 8. per-item derived constants ─────────────────────────────────────────
    lead_offsets: Dict[Tuple[str, str], int] = {}
    initial_on_hand_scaled: Dict[Tuple[str, str], int] = {}
    initial_safety_scaled: Dict[Tuple[str, str], int] = {}

    for k in item_keys:
        inv = inventory_state.get(k, {"on_hand": 0.0, "safety_stock": 0.0, "lead_time_days": 0.0})
        lead_offsets[k] = max(
            0, int(math.ceil(max(0.0, _to_float(inv.get("lead_time_days"), 0.0)) / period_days))
        )
        initial_on_hand_scaled[k] = max(0, int(round(max(0.0, _to_float(inv.get("on_hand"), 0.0)) * qty_scale)))
        initial_safety_scaled[k] = max(0, int(round(max(0.0, _to_float(inv.get("safety_stock"), 0.0)) * qty_scale)))

    # ── 9. variable upper bounds ──────────────────────────────────────────────
    order_ub_by_key: Dict[Tuple[str, str], int] = {}
    inv_ub_by_key: Dict[Tuple[str, str], int] = {}
    back_ub_by_key: Dict[Tuple[str, str], int] = {}

    for k in item_keys:
        sku = k[0]
        on_hand_s = initial_on_hand_scaled.get(k, 0)
        open_sum_s = int(round(sum((open_pos_by_key_idx.get(k, {}) or {}).values()) * qty_scale))
        demand_s = sum(demand_by_fg_idx_scaled.get(k, {}).values())
        comp_demand_s = expected_internal_demand_scaled.get(k, 0)
        safety_s = initial_safety_scaled.get(k, 0)
        base = max(qty_scale, on_hand_s + open_sum_s + demand_s + comp_demand_s + 2 * safety_s)
        max_s = int(round((max_map.get(sku, 0.0) or 0.0) * qty_scale))
        order_ub_by_key[k] = max(base * 2, qty_scale, max_s if max_s > 0 else 0)
        inv_ub_by_key[k] = max(base * 3, qty_scale)
        back_ub_by_key[k] = max(base * 3, qty_scale)

    # ── 10. build Gurobi model ────────────────────────────────────────────────
    grb_config = _resolve_gurobi_config(solver_settings, payload)
    env = _create_gurobi_env(grb_config)
    model = gp.Model("replenishment_multi_echelon", env=env)

    model.Params.TimeLimit = grb_config.time_limit
    model.Params.MIPGap = grb_config.mip_gap
    model.Params.Seed = grb_config.seed
    if grb_config.threads > 0:
        model.Params.Threads = grb_config.threads
    if grb_config.log_file:
        model.Params.LogFile = grb_config.log_file

    order_vars: Dict[Tuple[Tuple[str, str], int], Any] = {}
    inv_vars: Dict[Tuple[Tuple[str, str], int], Any] = {}
    back_vars: Dict[Tuple[Tuple[str, str], int], Any] = {}

    me_lot_mode = str(getattr(payload.multi_echelon, "lot_sizing_mode", None) or "moq_pack").strip().lower()
    comp_apply_lot = me_lot_mode not in {"off", "none", "disabled"}

    for k in item_keys:
        sku = k[0]
        item_idx = item_index[k]
        is_component = k in component_keys
        use_lot = (not is_component) or comp_apply_lot
        moq_s = int(round((moq_map.get(sku, 0.0) or 0.0) * qty_scale))
        pack_s = int(round((pack_map.get(sku, 0.0) or 0.0) * qty_scale))
        max_s = int(round((max_map.get(sku, 0.0) or 0.0) * qty_scale))
        lead_offset = lead_offsets.get(k, 0)

        for t in range(n_periods):
            o_var = model.addVar(
                vtype=GRB.INTEGER, lb=0, ub=order_ub_by_key[k],
                name=f"ord_{item_idx}_{t}",
            )
            i_var = model.addVar(
                vtype=GRB.INTEGER, lb=0, ub=inv_ub_by_key[k],
                name=f"inv_{item_idx}_{t}",
            )
            b_var = model.addVar(
                vtype=GRB.INTEGER, lb=0, ub=back_ub_by_key[k],
                name=f"back_{item_idx}_{t}",
            )
            order_vars[(k, t)] = o_var
            inv_vars[(k, t)] = i_var
            back_vars[(k, t)] = b_var

    model.update()

    # Apply lot-sizing constraints and lock orders after last deliverable period.
    for k in item_keys:
        sku = k[0]
        item_idx = item_index[k]
        is_component = k in component_keys
        use_lot = (not is_component) or comp_apply_lot
        moq_s = int(round((moq_map.get(sku, 0.0) or 0.0) * qty_scale))
        pack_s = int(round((pack_map.get(sku, 0.0) or 0.0) * qty_scale))
        max_s = int(round((max_map.get(sku, 0.0) or 0.0) * qty_scale))
        lead_offset = lead_offsets.get(k, 0)

        for t in range(n_periods):
            o_var = order_vars[(k, t)]

            # Orders placed after the last deliverable period are locked to zero.
            if t + lead_offset >= n_periods:
                model.addConstr(o_var == 0, name=f"lock_{item_idx}_{t}")

            # Per-item maximum order quantity.
            if max_s > 0:
                model.addConstr(o_var <= max_s, name=f"maxq_{item_idx}_{t}")
                _tag(
                    f"MAXQ[{sku},{t}]",
                    "Per-item max order quantity.",
                    scope="sku_period",
                    period=horizon_dates[t].isoformat(),
                    sku=sku,
                )

            # Pack-size multiple: order = pack * z.
            if use_lot and pack_s > qty_scale:
                z_ub = max(0, order_ub_by_key[k] // max(1, pack_s))
                z_var = model.addVar(
                    vtype=GRB.INTEGER, lb=0, ub=z_ub,
                    name=f"pack_{item_idx}_{t}",
                )
                model.addConstr(o_var == pack_s * z_var, name=f"pack_eq_{item_idx}_{t}")
                _tag(
                    f"PACK[{sku},{t}]",
                    "Order must be pack-size multiple.",
                    scope="sku_period",
                    period=horizon_dates[t].isoformat(),
                    sku=sku,
                )

            # MOQ: o >= moq when ordered (y=1), o = 0 when not ordered (y=0).
            if use_lot and moq_s > 0:
                y_var = model.addVar(vtype=GRB.BINARY, name=f"y_{item_idx}_{t}")
                model.addGenConstrIndicator(
                    y_var, True, o_var, GRB.GREATER_EQUAL, moq_s,
                    name=f"moq_on_{item_idx}_{t}",
                )
                model.addGenConstrIndicator(
                    y_var, False, o_var, GRB.EQUAL, 0,
                    name=f"moq_off_{item_idx}_{t}",
                )
                _tag(
                    f"MOQ[{sku},{t}]",
                    "MOQ enforcement when order placed.",
                    scope="sku_period",
                    period=horizon_dates[t].isoformat(),
                    sku=sku,
                )

    model.update()

    # ── 11. arrival / produced helpers ────────────────────────────────────────
    def _arrival_expr(k: Tuple[str, str], t: int) -> Any:
        """Inbound at period t: open-PO constant + new order placed (t - lead_offset) periods ago."""
        open_s = int(round((open_pos_by_key_idx.get(k, {}).get(t, 0.0)) * qty_scale))
        src = t - lead_offsets.get(k, 0)
        if src >= 0:
            return open_s + order_vars[(k, src)]
        return open_s

    def _produced_expr(k: Tuple[str, str], t: int) -> Any:
        """Produced/supplied quantity available at period t (arriving planned order)."""
        src = t - lead_offsets.get(k, 0)
        if src >= 0:
            return order_vars[(k, src)]
        return 0

    # ── 12. inventory balance constraints ─────────────────────────────────────
    for k in item_keys:
        for t in range(n_periods):
            prev_inv = inv_vars[(k, t - 1)] if t > 0 else initial_on_hand_scaled.get(k, 0)
            prev_back = back_vars[(k, t - 1)] if t > 0 else 0
            arrival = _arrival_expr(k, t)
            demand_s = demand_by_fg_idx_scaled.get(k, {}).get(t, 0)
            bom_parent_terms = parents_by_child.get(k, [])

            consumption_terms: List[Any] = []
            for parent_key, coeff, _ in bom_parent_terms:
                pe = _produced_expr(parent_key, t)
                if isinstance(pe, int) and pe == 0:
                    continue
                consumption_terms.append(coeff * pe)
            consumption = sum(consumption_terms) if consumption_terms else 0

            # Item flow with external demand + dependent BOM demand.
            model.addConstr(
                qty_scale * inv_vars[(k, t)] - qty_scale * back_vars[(k, t)]
                == qty_scale * prev_inv - qty_scale * prev_back
                + qty_scale * arrival - qty_scale * demand_s - consumption,
                name=f"bal_{item_index[k]}_{t}",
            )
            if k in fg_keys:
                _tag(
                    f"BALANCE_INV[{k[0]},{t}]",
                    "FG inventory flow balance with external demand.",
                    scope="sku_period",
                    period=horizon_dates[t].isoformat(),
                    sku=k[0],
                )
            if bom_parent_terms:
                _tag(
                    f"BOM_LINK[{k[0]},{t}]",
                    "Component flow includes BOM-coupled parent production consumption.",
                    scope="sku_period",
                    period=horizon_dates[t].isoformat(),
                    sku=k[0],
                )

                # Hard feasibility: cannot consume more than available.
                model.addConstr(
                    consumption <= qty_scale * (prev_inv + arrival),
                    name=f"comp_feas_{item_index[k]}_{t}",
                )
                _tag(
                    f"COMP_FEAS[{k[0]},{t}]",
                    "Component consumption cannot exceed available inventory + arrivals.",
                    scope="sku_period",
                    period=horizon_dates[t].isoformat(),
                    sku=k[0],
                )

    # ── 13. global budget constraint ──────────────────────────────────────────
    if budget_cap_scaled is not None:
        model.addConstr(
            gp.quicksum(order_vars.values()) <= budget_cap_scaled,
            name="budget_global",
        )
        _tag("BUDGET_GLOBAL", "Global shared budget cap across all items.")

    # ── 14. optional capacity constraints ─────────────────────────────────────
    prod_capacity_refs: List[Dict[str, Any]] = []
    inv_capacity_refs_me: List[Dict[str, Any]] = []

    prod_cap_scalar, prod_cap_by_day = _resolve_capacity_for_multi_grb(payload, "production_capacity_per_period")
    for t, cap_day in enumerate(horizon_dates):
        prod_cap_t = _capacity_for_day_grb(cap_day, prod_cap_scalar, prod_cap_by_day)
        if prod_cap_t is None or prod_cap_t <= 0.0:
            continue
        prod_cap_s = int(round(prod_cap_t * qty_scale))
        prod_terms = [_produced_expr(fg_key, t) for fg_key in fg_keys]
        model.addConstr(
            gp.quicksum(term for term in prod_terms if not (isinstance(term, int) and term == 0)) <= prod_cap_s,
            name=f"cap_prod_{t}",
        )
        _tag(
            f"CAP_PROD[{cap_day.isoformat()}]",
            "Shared production capacity for this period.",
            scope="period",
            period=cap_day.isoformat(),
        )
        prod_capacity_refs.append({
            "day": cap_day,
            "cap_s": prod_cap_s,
            "fg_keys": list(fg_keys),
            "t": t,
        })

    inv_cap_scalar, inv_cap_by_day = _resolve_capacity_for_multi_grb(payload, "inventory_capacity_per_period")
    for t, cap_day in enumerate(horizon_dates):
        inv_cap_t = _capacity_for_day_grb(cap_day, inv_cap_scalar, inv_cap_by_day)
        if inv_cap_t is None or inv_cap_t <= 0.0:
            continue
        inv_cap_s = int(round(inv_cap_t * qty_scale))
        model.addConstr(
            gp.quicksum(inv_vars[(k, t)] for k in item_keys) <= inv_cap_s,
            name=f"cap_inv_{t}",
        )
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
        model.addConstr(
            gp.quicksum(back_vars[(fg_key, n_periods - 1)] for fg_key in fg_keys) <= service_level_allowed_fg_backlog_s,
            name="service_level_global",
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
    for k in item_keys:
        sku = k[0]
        purchase_coeff = max(0, int(round((unit_cost_map.get(sku, 0.0) or 0.0) * cost_scale)))
        is_fg = k in fg_keys
        back_coeff = fg_back_coeff if is_fg else comp_back_coeff
        for t in range(n_periods):
            if hold_coeff > 0:
                obj_terms.append(hold_coeff * inv_vars[(k, t)])
            if back_coeff > 0:
                obj_terms.append(back_coeff * back_vars[(k, t)])
            if purchase_coeff > 0:
                obj_terms.append(purchase_coeff * order_vars[(k, t)])
            obj_terms.append(order_vars[(k, t)])

    if obj_terms:
        model.setObjective(gp.quicksum(obj_terms), GRB.MINIMIZE)

    # ── 16. solve ─────────────────────────────────────────────────────────────
    # Cancel callback support
    if cancel_check is not None:
        def _grb_cancel_callback(model_cb: Any, where: int) -> None:
            if where == GRB.Callback.MIP or where == GRB.Callback.MIPNODE:
                if cancel_check():
                    model_cb.terminate()
        model.optimize(_grb_cancel_callback)
    else:
        model.optimize()

    solve_time_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
    status_info = _status_from_gurobi(model, grb_config)

    if not status_info.has_feasible_solution:
        reasons = ["Gurobi did not find a feasible BOM-aware plan under current constraints."]
        suspected_tags = ["BOM_LINK", "COMP_FEAS"]
        constraints_checked_inf: List[Dict[str, Any]] = [
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
            constraints_checked_inf.append(_mk_constraint_check(
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
            constraints_checked_inf.append(_mk_constraint_check(
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
            constraints_checked_inf.append(_mk_constraint_check(
                name="service_level_target",
                tag="SERVICE_LEVEL_GLOBAL",
                passed=False,
                details="Hard service-level target may conflict with supply/capacity constraints.",
                description="Hard FG service-level target.",
                echelon="multi",
            ))
        infeasibility_analysis = _summarize_infeasibility(suspected_tags)
        relaxation_analysis: List[Dict[str, Any]] = []
        if diagnose_mode:
            relaxation_analysis = [
                {"relaxed_tags": [tag], "feasible_after_relaxation": None, "delta_cost_proxy": None}
                for tag in sorted(set(suspected_tags))
            ]

        # Cleanup
        try:
            model.dispose()
            env.dispose()
        except Exception:
            pass

        return finalize_planning_response(
            {
                **_empty_response_me(
                    t0,
                    status_info.status.value,
                    reasons,
                    engine_name="gurobi",
                    solve_time_ms=solve_time_ms,
                    settings=solver_settings,
                    termination_reason=status_info.termination_reason,
                    status_name=status_info.status_name,
                ),
                "proof": {
                    "objective_terms": [],
                    "constraints_checked": constraints_checked_inf,
                    "constraint_tags": constraint_tags,
                    "infeasibility_analysis": infeasibility_analysis,
                    "relaxation_analysis": relaxation_analysis,
                    "diagnose_mode": bool(diagnose_mode),
                },
            },
            default_engine="gurobi",
            default_status=status_info.status,
        )

    # ── 17. extract plan rows ─────────────────────────────────────────────────
    plan_rows: List[Dict[str, Any]] = []
    component_plan_rows: List[Dict[str, Any]] = []
    all_order_rows: List[Dict[str, Any]] = []

    for k in item_keys:
        sku, plant_id = k
        lead_offset = lead_offsets.get(k, 0)
        for t in range(n_periods):
            qty_s_val = int(round(order_vars[(k, t)].X))
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
            if k in fg_keys:
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
            inbound_plan = int(round(order_vars[(comp_key, src)].X)) / qty_scale if src >= 0 else 0.0
            dep_demand = max(
                0.0,
                expected_dependent_need_by_key_idx.get(comp_key, {}).get(t, 0.0),
            )
            on_hand_end = int(round(inv_vars[(comp_key, t)].X)) / qty_scale
            backlog = int(round(back_vars[(comp_key, t)].X)) / qty_scale
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
        int(round(back_vars[(fg_key, n_periods - 1)].X)) / qty_scale
        for fg_key in fg_keys
    )
    stockout_units = sum(
        int(round(back_vars[(fg_key, t)].X)) / qty_scale
        for fg_key in fg_keys for t in range(n_periods)
    )
    holding_units = sum(
        int(round(inv_vars[(fg_key, t)].X)) / qty_scale
        for fg_key in fg_keys for t in range(n_periods)
    )
    comp_stockout = sum(
        int(round(back_vars[(ck, t)].X)) / qty_scale
        for ck in component_keys for t in range(n_periods)
    )
    comp_holding = sum(
        int(round(inv_vars[(ck, t)].X)) / qty_scale
        for ck in component_keys for t in range(n_periods)
    )

    service_level: Optional[float] = None
    if total_fg_demand > 0.0:
        service_level = max(0.0, min(1.0, 1.0 - end_fg_backlog / total_fg_demand))

    obj_val = float(model.ObjVal)
    bound_val = float(model.ObjBound) if hasattr(model, "ObjBound") else obj_val
    est_cost = obj_val / (qty_scale * cost_scale)
    best_bound_cost = bound_val / (qty_scale * cost_scale)
    gap = None
    if status_info.has_feasible_solution:
        if status_info.status == PlanningStatus.OPTIMAL:
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
            prev_inv_s = int(round(inv_vars[(comp_key, t - 1)].X)) if t > 0 else initial_on_hand_scaled.get(comp_key, 0)
            arr = _arrival_expr(comp_key, t)
            arrival_s = int(round(arr.getValue())) if hasattr(arr, "getValue") else int(arr)
            cons_s = 0
            for parent_key, coeff, _ in parents_by_child.get(comp_key, []):
                pe = _produced_expr(parent_key, t)
                if isinstance(pe, int):
                    prod_s = int(pe)
                else:
                    prod_s = int(round(pe.getValue())) if hasattr(pe, "getValue") else int(round(pe.X))
                cons_s += coeff * prod_s
            if cons_s > qty_scale * (prev_inv_s + arrival_s) + 1:
                bom_coupling_failed += 1

    prod_cap_failed = 0
    prod_cap_binding = 0
    prod_cap_tags: List[str] = []
    for ref in prod_capacity_refs:
        produced_s = 0
        t = ref["t"]
        for fg_key in ref["fg_keys"]:
            pe = _produced_expr(fg_key, t)
            if isinstance(pe, int):
                produced_s += int(pe)
            else:
                produced_s += int(round(pe.getValue())) if hasattr(pe, "getValue") else int(round(pe.X))
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
        for k in ref["keys"]:
            inv_total_s += int(round(inv_vars[(k, t)].X))
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
            planned_today = int(round(order_vars[(comp_key, src)].X)) / qty_scale if src >= 0 else 0.0
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
        "gurobi_node_count": int(model.NodeCount) if hasattr(model, "NodeCount") else None,
        "gurobi_simplex_iterations": int(model.IterCount) if hasattr(model, "IterCount") else None,
    }

    # ── cleanup ───────────────────────────────────────────────────────────────
    try:
        model.dispose()
        env.dispose()
    except Exception:
        pass

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
                engine_name="gurobi",
                solver_name="gurobi_milp_multi_echelon",
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
                     "note": "Gurobi weighted objective value proxy."},
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
                    if diagnose_mode and bool(infeasible_reasons)
                    else []
                ),
                "diagnose_mode": bool(diagnose_mode),
            },
        },
        default_engine="gurobi",
        default_status=solve_status,
    )
