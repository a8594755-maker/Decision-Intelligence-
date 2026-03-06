"""
IBM CPLEX (docplex) MILP single-echelon + multi-echelon replenishment solver.

Mathematical model is identical to CP-SAT and Gurobi versions, translated
to the ``docplex.mp`` API.  See ``replenishment_solver_gurobi.py`` for the
detailed constraint-by-constraint commentary.

Key translation notes vs CP-SAT:
  - ``model.add_indicator(y, expr, active_value=1)`` replaces ``OnlyEnforceIf(y)``
  - ``model.integer_var / binary_var`` replaces ``NewIntVar / NewBoolVar``
  - ``model.minimize(model.sum(terms))`` replaces ``Minimize(sum(terms))``
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
    SCALE, OBJ_SCALE,
    DEFAULT_SOLVER_SINGLE_TIME_LIMIT_SECONDS,
    DEFAULT_SOLVER_MULTI_TIME_LIMIT_SECONDS,
    SolverRunSettings, SolverStatusInfo, SupplierInfo,
    s as _s, us as _us, to_float as _to_float, to_bool as _to_bool, to_int as _to_int,
    read_attr as _read_attr, read_path as _read_path, first_non_none as _first_non_none,
    as_list as _as_list, as_dict as _as_dict, parse_day as _parse_day, key as _key,
    parse_keyed_scaled_qty_map as _parse_keyed_scaled_qty_map,
    lookup_keyed_value as _lookup_keyed_value,
    build_qty_map as _build_qty_map, build_unit_cost_map as _build_unit_cost_map,
    build_qty_map_unscaled as _build_qty_map_unscaled,
    capacity_for_period as _capacity_for_period,
    resolve_solver_run_settings as _resolve_solver_run_settings,
    mk_constraint_check as _mk_constraint_check,
    summarize_infeasibility as _summarize_infeasibility,
    suggestions_for_categories as _suggestions_for_categories,
    build_solver_meta as _build_solver_meta,
    empty_response as _empty_response,
    empty_response_multi_echelon as _empty_response_me,
)

logger = logging.getLogger(__name__)


# ── CPLEX configuration ──────────────────────────────────────────────────────

@dataclass(frozen=True)
class CplexConfig:
    """CPLEX solver configuration."""
    time_limit: float
    mip_gap: float
    threads: int
    seed: int
    log_output: bool


def _resolve_cplex_config(settings: SolverRunSettings, payload: Any) -> CplexConfig:
    engine_flags = _as_dict(_read_attr(payload, "engine_flags", {}))
    cpx_flags = _as_dict(engine_flags.get("cplex", {}))
    solver_cfg = _as_dict(_read_path(payload, "settings.solver", {}))
    cpx_solver_cfg = _as_dict(solver_cfg.get("cplex", {}))

    return CplexConfig(
        time_limit=settings.time_limit_seconds,
        mip_gap=_to_float(_first_non_none(
            cpx_flags.get("mip_gap"), cpx_solver_cfg.get("mip_gap"),
            os.getenv("DI_CPLEX_MIP_GAP"), 0.01,
        ), 0.01),
        threads=max(0, _to_int(_first_non_none(
            cpx_flags.get("threads"), cpx_solver_cfg.get("threads"),
            os.getenv("DI_CPLEX_THREADS"), 0,
        ), 0)),
        seed=settings.random_seed,
        log_output=settings.log_search_progress,
    )


# ── status mapping ────────────────────────────────────────────────────────────

def _status_from_cplex(solution: Any, model: Any, config: CplexConfig) -> SolverStatusInfo:
    """Map CPLEX solve result to SolverStatusInfo."""
    if solution is not None:
        status_str = str(solution.solve_details.status if hasattr(solution, "solve_details") else "FEASIBLE")
        if "optimal" in status_str.lower():
            return SolverStatusInfo(PlanningStatus.OPTIMAL, "OPTIMAL", status_str, True, False)
        if "feasible" in status_str.lower() or "integer" in status_str.lower():
            return SolverStatusInfo(PlanningStatus.FEASIBLE, "FEASIBLE", status_str, True, False)
        if "time" in status_str.lower() or "limit" in status_str.lower():
            return SolverStatusInfo(PlanningStatus.TIMEOUT, "TIME_LIMIT_FEASIBLE", status_str, True, True)
        return SolverStatusInfo(PlanningStatus.FEASIBLE, "FEASIBLE", status_str, True, False)

    # No solution found
    solve_details = model.solve_details if hasattr(model, "solve_details") else None
    status_str = str(solve_details.status if solve_details else "NO_SOLUTION")
    if "infeasible" in status_str.lower():
        return SolverStatusInfo(PlanningStatus.INFEASIBLE, "INFEASIBLE", status_str, False, False)
    if "time" in status_str.lower() or "limit" in status_str.lower():
        return SolverStatusInfo(PlanningStatus.TIMEOUT, "TIME_LIMIT_NO_FEASIBLE", status_str, False, True)
    return SolverStatusInfo(PlanningStatus.ERROR, status_str, status_str, False, False)


# ── public API ────────────────────────────────────────────────────────────────

def cplex_available() -> bool:
    from ml.api.solver_availability import cplex_available as _check
    return _check()


def solve_replenishment_cplex(
    payload: Any,
    run_settings: Optional[SolverRunSettings] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """Solve a single-echelon replenishment plan using IBM CPLEX via docplex."""
    from docplex.mp.model import Model

    solver_settings = run_settings or _resolve_solver_run_settings(
        payload, DEFAULT_SOLVER_SINGLE_TIME_LIMIT_SECONDS,
    )
    t0 = datetime.now(timezone.utc)

    if bool(getattr(solver_settings, "force_timeout", False)):
        return _empty_response(
            t0, "TIMEOUT",
            ["Forced timeout via settings.solver.force_timeout=true."],
            engine_name="cplex", settings=solver_settings,
            termination_reason="FORCED_TIMEOUT", status_name="FORCED_TIMEOUT",
        )

    cpx_config = _resolve_cplex_config(solver_settings, payload)

    # ── parse all inputs (same logic as Gurobi solver) ────────────────────
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
    closed_loop_patch = _as_dict(_read_path(payload, "settings.closed_loop_meta.param_patch.patch", {}))
    safety_stock_alpha = max(0.0, _to_float(_first_non_none(
        _read_attr(objective, "safety_stock_alpha", None),
        forecast_uncertainty_cfg.get("safety_stock_alpha"),
        closed_loop_patch.get("safety_stock_alpha"), 1.0,
    ), 1.0))
    use_p90_for_safety_stock = _to_bool(_first_non_none(
        _read_attr(objective, "use_p90_for_safety_stock", None),
        forecast_uncertainty_cfg.get("use_p90_for_safety_stock"), True,
    ), True)
    use_p90_for_service_level = _to_bool(_first_non_none(
        _read_attr(objective, "use_p90_for_service_level", None),
        forecast_uncertainty_cfg.get("use_p90_for_service_level"), True,
    ), True)
    closed_loop_safety_stock_by_key_s = _parse_keyed_scaled_qty_map(
        closed_loop_patch.get("safety_stock_by_key"))

    coeff_order = OBJ_SCALE
    coeff_stockout = int(round(stockout_penalty * OBJ_SCALE))
    coeff_holding = int(round(holding_cost * OBJ_SCALE))

    # Risk signals
    _rs = _read_attr(payload, "risk_signals", None) or SimpleNamespace()
    ss_penalty_by_key: Dict[str, float] = {}
    _ssp = _read_attr(_rs, "ss_penalty_by_key", None)
    if isinstance(_ssp, dict):
        ss_penalty_by_key = {str(k2): max(1.0, _to_float(v, 1.0)) for k2, v in _ssp.items()}
    dual_source_keys: set = set()
    _dsk = _read_attr(_rs, "dual_source_keys", None)
    if isinstance(_dsk, (list, tuple)):
        dual_source_keys = {str(k2).strip() for k2 in _dsk if k2}
    dual_source_min_split = max(0.0, min(0.5, _to_float(_read_attr(_rs, "dual_source_min_split_fraction", 0.2), 0.2)))
    expedite_keys: set = set()
    _ek = _read_attr(_rs, "expedite_keys", None)
    if isinstance(_ek, (list, tuple)):
        expedite_keys = {str(k2).strip() for k2 in _ek if k2}
    expedite_lt_reduction = max(0, int(round(_to_float(_read_attr(_rs, "expedite_lead_time_reduction_days", 0), 0))))
    expedite_cost_mult = max(1.0, _to_float(_read_attr(_rs, "expedite_cost_multiplier", 1.0), 1.0))

    constraint_tags: List[Dict[str, Any]] = []

    def _tag(tag: str, desc: str, **kw: Any) -> None:
        constraint_tags.append({"tag": tag, "description": desc, "severity": kw.get("severity", "hard"),
                                "scope": kw.get("scope", "global"), "period": kw.get("period"),
                                "sku": kw.get("sku"), "echelon": "single"})

    moq_s = _build_qty_map(_read_attr(constraints, "moq", None), "min_qty")
    pack_s = _build_qty_map(_read_attr(constraints, "pack_size", None), "pack_qty")
    maxq_s = _build_qty_map(_read_attr(constraints, "max_order_qty", None), "max_qty")
    unit_cost_map = _build_unit_cost_map(_read_attr(constraints, "unit_costs", None))
    sku_priority_map: Dict[str, float] = {}

    budget_cap_raw = _first_non_none(_read_attr(shared_constraints, "budget_cap", None), _read_attr(constraints, "budget_cap", None))
    budget_cap: Optional[float] = max(0.0, _to_float(budget_cap_raw, 0.0)) if budget_cap_raw is not None else None
    budget_mode = str(_first_non_none(_read_attr(shared_constraints, "budget_mode", None), "auto")).strip().lower()
    prod_cap_raw = _read_attr(shared_constraints, "production_capacity_per_period", None)
    inv_cap_raw = _first_non_none(
        _read_attr(shared_constraints, "inventory_capacity_per_period", None),
        _read_attr(constraints, "inventory_capacity_per_period", None),
    )

    # Parse demand
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

    for item in _as_list(_read_attr(payload, "items", None)):
        sku = str(_read_attr(item, "sku", "") or "").strip()
        if not sku:
            continue
        item_plant = str(_read_attr(item, "plant_id", "") or "").strip()
        demand_rows = _first_non_none(_read_attr(item, "demand", None),
                                       _read_path(item, "demand_forecast.series", None),
                                       _read_attr(item, "series", None))
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
        pw = _read_attr(item, "priority_weight", None)
        if pw is not None:
            sku_priority_map[sku] = max(0.01, _to_float(pw, 1.0))

    pw_raw = _read_attr(shared_constraints, "priority_weights", None)
    if isinstance(pw_raw, dict):
        for k_str, val in pw_raw.items():
            sku_priority_map[str(k_str).strip()] = max(0.01, _to_float(val, 1.0))

    if not forecast_by_key:
        return _empty_response(t0, "INFEASIBLE",
                               ["No valid demand rows."],
                               engine_name="cplex", settings=solver_settings,
                               termination_reason="INVALID_INPUT")

    for k in forecast_by_key:
        forecast_by_key[k].sort(key=lambda r: r[0])

    # Inventory
    inventory_seed: Dict[Tuple[str, str], Dict[str, Any]] = {}

    def _upsert_inv(k: Tuple[str, str], as_of: Optional[date], oh: Any, ss: Any, lt: Any) -> None:
        if as_of is None:
            return
        prev = inventory_seed.get(k)
        if prev and as_of <= prev["as_of_date"]:
            return
        inventory_seed[k] = {"as_of_date": as_of, "on_hand_s": _s(max(0.0, _to_float(oh, 0.0))),
                             "safety_stock_s": _s(max(0.0, _to_float(ss, 0.0))),
                             "lead_time_days": max(0, int(round(_to_float(lt, 0.0))))}

    for row in _as_list(_read_attr(payload, "inventory", None)):
        _upsert_inv(_key(_read_attr(row, "sku", None), _read_attr(row, "plant_id", None)),
                     _parse_day(_read_attr(row, "as_of_date", None)),
                     _read_attr(row, "on_hand", 0.0), _read_attr(row, "safety_stock", 0.0),
                     _read_attr(row, "lead_time_days", 0.0))

    for item in _as_list(_read_attr(payload, "items", None)):
        sku = str(_read_attr(item, "sku", "") or "").strip()
        if not sku:
            continue
        plant = str(_read_attr(item, "plant_id", "") or "").strip()
        k = _key(sku, plant)
        first_day = forecast_by_key.get(k, [(datetime.now(timezone.utc).date(), 0, None)])[0][0]
        _upsert_inv(k, _parse_day(_read_attr(item, "as_of_date", None)) or first_day,
                     _read_attr(item, "on_hand", 0.0), _read_attr(item, "safety_stock", 0.0),
                     _read_attr(item, "lead_time_days", 0.0))

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
    # BUILD CPLEX MODEL
    # ══════════════════════════════════════════════════════════════════════
    mdl = Model(name="replenishment")
    mdl.parameters.timelimit = cpx_config.time_limit
    mdl.parameters.mip.tolerances.mipgap = cpx_config.mip_gap
    if cpx_config.threads > 0:
        mdl.parameters.threads = cpx_config.threads
    mdl.parameters.randomseed = cpx_config.seed
    if not cpx_config.log_output:
        mdl.set_log_output(None)

    sku_var_maps: Dict[Tuple[str, str], Dict[str, Any]] = {}
    sku_meta: Dict[Tuple[str, str], Dict[str, Any]] = {}
    all_order_vars: List[Any] = []
    order_vars_by_day: Dict[date, List[Any]] = {}
    inv_vars_by_day: Dict[date, List[Any]] = {}
    total_demand_s_global = 0
    total_demand_s_for_service_level = 0
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
        on_hand_s = int(seed["on_hand_s"])
        lead_time = int(seed["lead_time_days"])

        sku_key_str = f"{sku}|{plant_id or ''}"
        is_expedited = bool(sku_key_str in expedite_keys and expedite_lt_reduction > 0)
        original_lead_time = lead_time
        if is_expedited:
            lead_time = max(0, lead_time - expedite_lt_reduction)

        open_po_cal = open_po_by_key.get(k, {})
        days_list = [d for d, _, _ in series]
        demand_s_list = [p50 for _, p50, _ in series]
        demand_for_service_level_s = [
            (p90 if (use_p90_for_service_level and p90 is not None) else p50) for _, p50, p90 in series
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

        # Safety stock
        p90_values_s = [p90 for _, _, p90 in series if p90 is not None]
        base_ss = int(seed.get("safety_stock_s", 0))
        derived_ss: Optional[int] = None
        if use_p90_for_safety_stock and p90_values_s:
            avg_p50_s = sum(p50 for _, p50, _ in series) / len(series)
            avg_p90_s = sum((p90 if p90 is not None else p50) for _, p50, p90 in series) / len(series)
            derived_ss = max(0, int(round(avg_p50_s + safety_stock_alpha * max(0.0, avg_p90_s - avg_p50_s))))
        cl_override = _lookup_keyed_value(closed_loop_safety_stock_by_key_s, k)
        safety_stock_s_val = max(0, int(cl_override)) if cl_override is not None else (max(base_ss, derived_ss) if derived_ss is not None else base_ss)

        ub_order = max(total_demand_s, sku_moq_s if sku_moq_s else 1, on_hand_s + 1, SCALE)
        if sku_max_s > 0:
            ub_order = min(ub_order, max(sku_max_s, SCALE))
        ub_inv = on_hand_s + ub_order * T + 1
        ub_back = max(total_demand_s + 1, SCALE)

        var_tag = f"{sku}_{plant_id or 'NA'}"
        order_vars = [mdl.integer_var(lb=0, ub=ub_order, name=f"ord_{var_tag}_{t}") for t in range(T)]
        inv_vars = [mdl.integer_var(lb=0, ub=ub_inv, name=f"inv_{var_tag}_{t}") for t in range(T)]
        back_vars = [mdl.integer_var(lb=0, ub=ub_back, name=f"back_{var_tag}_{t}") for t in range(T)]
        y_vars = [mdl.binary_var(name=f"y_{var_tag}_{t}") for t in range(T)]

        k_vars: Optional[List[Any]] = None
        if sku_pack_s > SCALE:
            max_k = ub_order // sku_pack_s + 2
            k_vars = [mdl.integer_var(lb=0, ub=int(max_k), name=f"k_{var_tag}_{t}") for t in range(T)]

        tie_rank = len(ordered_keys) - key_idx
        back_coeff = max(1, coeff_stockout * max(1, int(round(sku_priority * 100))) + tie_rank)
        effective_unit_cost = sku_unit_cost * expedite_cost_mult if (is_expedited and expedite_cost_mult > 1.0) else sku_unit_cost
        order_coeff = max(1, coeff_order + int(round(effective_unit_cost * 10)))

        for t in range(T):
            day = days_list[t]
            order_vars_by_day.setdefault(day, []).append(order_vars[t])
            inv_vars_by_day.setdefault(day, []).append(inv_vars[t])

            # Pack size
            if k_vars is not None:
                mdl.add_constraint(order_vars[t] == k_vars[t] * sku_pack_s, ctname=f"pack_{var_tag}_{t}")
                _tag(f"PACK[{sku},{t}]", "Pack-size multiple.", scope="sku_period", period=day.isoformat(), sku=sku)

            # MOQ via indicator
            if sku_moq_s > 0:
                mdl.add_indicator(y_vars[t], order_vars[t] >= sku_moq_s, active_value=1, name=f"moq_on_{var_tag}_{t}")
                mdl.add_indicator(y_vars[t], order_vars[t] == 0, active_value=0, name=f"moq_off_{var_tag}_{t}")
                _tag(f"MOQ[{sku},{t}]", "MOQ constraint.", scope="sku_period", period=day.isoformat(), sku=sku)
            else:
                mdl.add_indicator(y_vars[t], order_vars[t] == 0, active_value=0, name=f"y_off_{var_tag}_{t}")
                mdl.add_indicator(y_vars[t], order_vars[t] >= 1, active_value=1, name=f"y_on_{var_tag}_{t}")

            if sku_max_s > 0:
                mdl.add_constraint(order_vars[t] <= sku_max_s, ctname=f"maxq_{var_tag}_{t}")
                _tag(f"MAXQ[{sku},{t}]", "Max order qty.", scope="sku_period", period=day.isoformat(), sku=sku)

            # Inventory balance
            open_po_t = open_po_cal.get(day, 0)
            const_rhs = on_hand_s + open_po_t - demand_s_list[t] if t == 0 else open_po_t - demand_s_list[t]
            lhs = inv_vars[t] - back_vars[t]
            order_idx = t - lead_time
            if order_idx >= 0:
                lhs = lhs - order_vars[order_idx]
            if t > 0:
                lhs = lhs - inv_vars[t - 1] + back_vars[t - 1]
            mdl.add_constraint(lhs == const_rhs, ctname=f"bal_{var_tag}_{t}")
            _tag(f"BALANCE_INV[{sku},{t}]", "Inventory balance.", scope="sku_period", period=day.isoformat(), sku=sku)

        all_order_vars.extend(order_vars)

        # Objective terms
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
            ss_slack_vars = [mdl.integer_var(lb=0, ub=safety_stock_s_val, name=f"ss_{var_tag}_{t}") for t in range(T)]
            for t in range(T):
                mdl.add_constraint(inv_vars[t] + ss_slack_vars[t] >= safety_stock_s_val, ctname=f"ss_{var_tag}_{t}")
                _tag(f"SAFETY_STOCK[{sku},{t}]", "Safety stock soft floor.", severity="soft", scope="sku_period", period=days_list[t].isoformat(), sku=sku)
            ss_mult = ss_penalty_by_key.get(sku_key_str, 1.0)
            eff_ss_coeff = int(round(safety_stock_penalty * ss_mult * OBJ_SCALE))
            if eff_ss_coeff > 0:
                for v in ss_slack_vars:
                    obj_terms.append(eff_ss_coeff * v)

        sku_var_maps[k] = {"order": order_vars, "inv": inv_vars, "back": back_vars, "y": y_vars, "k": k_vars, "ss_slack": ss_slack_vars}
        sku_meta[k] = {"days": days_list, "demand_s": demand_s_list, "lead_time": lead_time, "safety_stock_s": safety_stock_s_val}

    if not sku_var_maps:
        return _empty_response(t0, "INFEASIBLE", ["No valid SKU/plant data."],
                               engine_name="cplex", settings=solver_settings, termination_reason="INVALID_INPUT")

    # Shared constraints
    all_days = sorted(order_vars_by_day.keys())
    if prod_cap_raw is not None:
        for idx, day in enumerate(all_days):
            cap = _capacity_for_period(prod_cap_raw, idx, day)
            if cap is None:
                continue
            cap_s = _s(max(0.0, cap))
            mdl.add_constraint(mdl.sum(order_vars_by_day.get(day, [])) <= cap_s, ctname=f"cap_prod_{day.isoformat()}")
            _tag(f"CAP_PROD[{day.isoformat()}]", "Production capacity.", scope="period", period=day.isoformat())

    if inv_cap_raw is not None:
        for idx, day in enumerate(all_days):
            cap = _capacity_for_period(inv_cap_raw, idx, day)
            if cap is None:
                continue
            cap_s = _s(max(0.0, cap))
            mdl.add_constraint(mdl.sum(inv_vars_by_day.get(day, [])) <= cap_s, ctname=f"cap_inv_{day.isoformat()}")
            _tag(f"CAP_INV[{day.isoformat()}]", "Inventory capacity.", scope="period", period=day.isoformat())

    budget_mode_effective: Optional[str] = None
    if budget_cap is not None and all_order_vars:
        auto_cost = any(v > 0.0 for v in unit_cost_map.values())
        use_cost = budget_mode == "spend" or (budget_mode not in {"quantity"} and auto_cost)
        if use_cost:
            spend_terms: List[Any] = []
            for k in ordered_keys:
                if k not in sku_var_maps:
                    continue
                coeff = max(0, int(round(max(0.0, unit_cost_map.get(k[0], 1.0)) * SCALE)))
                for v in sku_var_maps[k]["order"]:
                    spend_terms.append(coeff * v)
            mdl.add_constraint(mdl.sum(spend_terms) <= int(round(budget_cap * SCALE * SCALE)), ctname="budget_global")
            budget_mode_effective = "spend"
            _tag("BUDGET_GLOBAL", "Shared budget cap (spend).")
        else:
            mdl.add_constraint(mdl.sum(all_order_vars) <= _s(budget_cap), ctname="budget_global")
            budget_mode_effective = "quantity"
            _tag("BUDGET_GLOBAL", "Shared budget cap (quantity).")

    # Service level
    service_level_demand_basis_s = total_demand_s_for_service_level if (use_p90_for_service_level and total_demand_s_for_service_level > 0) else total_demand_s_global
    if service_level_target is not None:
        allowed_backlog = int(round(max(0.0, 1.0 - service_level_target) * service_level_demand_basis_s))
        end_back_vars = [vars_["back"][-1] for vars_ in sku_var_maps.values() if vars_["back"]]
        if end_back_vars:
            mdl.add_constraint(mdl.sum(end_back_vars) <= allowed_backlog, ctname="service_level")
            _tag("SERVICE_LEVEL_GLOBAL", "Service level target.")

    # Objective
    if obj_terms:
        mdl.minimize(mdl.sum(obj_terms))

    # ── solve ─────────────────────────────────────────────────────────────
    solution = mdl.solve()
    solve_time_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
    status_info = _status_from_cplex(solution, mdl, cpx_config)

    if not status_info.has_feasible_solution:
        return finalize_planning_response({
            "status": status_info.status.value, "plan_lines": [],
            "kpis": {"estimated_service_level": None, "estimated_stockout_units": None,
                     "estimated_holding_units": None, "estimated_total_cost": None},
            "solver_meta": _build_solver_meta(engine_name="cplex", solver_name="cplex_milp",
                                               status_info=status_info, settings=solver_settings,
                                               solve_time_ms=solve_time_ms, objective_value=None,
                                               best_bound=None, gap=None),
            "infeasible_reasons": [f"CPLEX status: {status_info.status_name}"],
            "proof": {"objective_terms": [], "constraints_checked": [], "constraint_tags": constraint_tags},
        }, default_engine="cplex", default_status=status_info.status)

    # ── extract solution ──────────────────────────────────────────────────
    plan_rows: List[Dict[str, Any]] = []
    total_order_qty = 0.0
    total_stockout = 0.0
    total_holding = 0.0
    total_demand = 0.0

    for k in ordered_keys:
        if k not in sku_var_maps:
            continue
        sku, plant_id = k
        vars_ = sku_var_maps[k]
        meta = sku_meta[k]
        days_list = meta["days"]
        lead_time_val = meta["lead_time"]
        T = len(days_list)
        total_demand += _us(sum(meta["demand_s"]))

        for t in range(T):
            order_val_s = int(round(solution.get_value(vars_["order"][t])))
            if order_val_s > 0:
                order_qty = _us(order_val_s)
                order_day = days_list[t]
                arrival_day = order_day + timedelta(days=lead_time_val)
                plan_rows.append({"sku": sku, "plant_id": plant_id or None,
                                  "order_date": order_day.isoformat(), "arrival_date": arrival_day.isoformat(),
                                  "order_qty": float(round(order_qty, 6))})
                total_order_qty += order_qty
            total_stockout += _us(int(round(solution.get_value(vars_["back"][t]))))
            total_holding += _us(int(round(solution.get_value(vars_["inv"][t]))))

    service_level = 1.0 - (total_stockout / total_demand) if total_demand > 0 else None
    est_cost = total_order_qty + stockout_penalty * total_stockout + holding_cost * total_holding

    obj_real = float(round(mdl.objective_value / (OBJ_SCALE * SCALE), 6)) if hasattr(mdl, "objective_value") and mdl.objective_value is not None else None
    gap = None
    try:
        gap = mdl.solve_details.mip_relative_gap if hasattr(mdl.solve_details, "mip_relative_gap") else None
    except Exception:
        pass

    objective_terms = [
        {"name": "ordered_units", "value": round(total_order_qty, 6), "note": "Total planned.", "units": "units"},
        {"name": "stockout_units", "value": round(total_stockout, 6), "note": "Backlog.", "units": "units"},
        {"name": "holding_units", "value": round(total_holding, 6), "note": "Holding.", "units": "units"},
        {"name": "estimated_total_cost", "value": round(est_cost, 6), "note": "Total cost.", "units": "cost_units"},
    ]

    try:
        mdl.end()
    except Exception:
        pass

    return finalize_planning_response({
        "status": status_info.status.value,
        "plan_lines": plan_rows,
        "kpis": {"estimated_service_level": round(service_level, 6) if service_level is not None else None,
                 "estimated_stockout_units": round(total_stockout, 6),
                 "estimated_holding_units": round(total_holding, 6),
                 "estimated_total_cost": round(est_cost, 6)},
        "solver_meta": _build_solver_meta(
            engine_name="cplex", solver_name="cplex_milp",
            status_info=status_info, settings=solver_settings,
            solve_time_ms=solve_time_ms, objective_value=obj_real, best_bound=None, gap=gap,
        ),
        "infeasible_reasons": [],
        "proof": {"objective_terms": objective_terms, "constraints_checked": [], "constraint_tags": constraint_tags},
    }, default_engine="cplex", default_status=status_info.status)


# ── multi-echelon private helpers ──────────────────────────────────────────────

def _infer_period_days_cplex(sorted_dates: List[date]) -> int:
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


def _build_qty_map_me_cplex(rows: Any, attr: str) -> Dict[str, float]:
    """Return {sku: unscaled_float} from a list of constraint rows."""
    out: Dict[str, float] = {}
    for row in _as_list(rows):
        sku = str(_read_attr(row, "sku", None) or "").strip()
        if not sku:
            continue
        v = _read_attr(row, attr, None)
        if v is None:
            continue
        out[sku] = max(0.0, _to_float(v, 0.0))
    return out


def _build_unit_cost_map_me_cplex(rows: Any) -> Dict[str, float]:
    """Return {sku: unit_cost_float} from a list of unit-cost constraint rows."""
    out: Dict[str, float] = {}
    for row in _as_list(rows):
        sku = str(_read_attr(row, "sku", None) or "").strip()
        if not sku:
            continue
        v = _read_attr(row, "unit_cost", None)
        if v is None:
            continue
        out[sku] = max(0.0, _to_float(v, 0.0))
    return out


def _capacity_scalar_and_calendar_cplex(raw_value: Any) -> Tuple[Optional[float], Dict[date, float]]:
    """Parse scalar or [{date, capacity}] calendar."""
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


def _resolve_capacity_raw_cplex(payload: Any, section: str, attr: str) -> Any:
    section_obj = getattr(payload, section, None)
    if section_obj is None:
        return None
    return getattr(section_obj, attr, None)


def _resolve_capacity_for_multi_cplex(payload: Any, attr: str) -> Tuple[Optional[float], Dict[date, float]]:
    raw = _resolve_capacity_raw_cplex(payload, "shared_constraints", attr)
    if raw is None:
        raw = _resolve_capacity_raw_cplex(payload, "multi_echelon", attr)
    if raw is None:
        raw = _resolve_capacity_raw_cplex(payload, "constraints", attr)
    return _capacity_scalar_and_calendar_cplex(raw)


def _capacity_for_day_cplex(
    day: date,
    scalar_capacity: Optional[float],
    by_day_capacity: Dict[date, float],
) -> Optional[float]:
    if day in by_day_capacity:
        return by_day_capacity[day]
    return scalar_capacity


# ── public multi-echelon API ─────────────────────────────────────────────────

def solve_replenishment_multi_echelon_cplex(
    payload: Any,
    run_settings: Optional[SolverRunSettings] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """
    Solve a BOM-coupled multi-echelon replenishment plan using IBM CPLEX via docplex.

    Decision variables per (item i, period t):
      order[i,t]  -- int >= 0 : units ordered/produced at period t
      inv[i,t]    -- int >= 0 : on-hand inventory at end of period t
      back[i,t]   -- int >= 0 : backlog at end of period t

    Item flow balance (supports multi-layer BOM):
      qty_scale * (inv[i,t] - back[i,t]) =
          qty_scale * (inv[i,t-1] - back[i,t-1] + arriving_i[t] - external_demand[i,t])
          - sum_parent (usage[parent,i] * qty_scale) * produced_parent[t]

    Hard feasibility constraint (for every BOM child i):
      sum_parent usage_scaled[parent,i] * produced_parent[t]
          <= qty_scale * (inv[i,t-1] + arriving_i[t])
    """
    from docplex.mp.model import Model

    solver_settings = run_settings or _resolve_solver_run_settings(
        payload,
        default_time_limit_seconds=DEFAULT_SOLVER_MULTI_TIME_LIMIT_SECONDS,
    )
    t0 = datetime.now(timezone.utc)

    if bool(getattr(solver_settings, "force_timeout", False)):
        return _empty_response_me(
            t0, "TIMEOUT",
            ["Forced timeout via settings.solver.force_timeout=true."],
            engine_name="cplex", settings=solver_settings,
            termination_reason="FORCED_TIMEOUT", status_name="FORCED_TIMEOUT",
        )

    cpx_config = _resolve_cplex_config(solver_settings, payload)
    qty_scale: int = 1_000   # quantities: 1 real unit = qty_scale integer units
    cost_scale: int = 100    # cost coefficients

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
            "tag": tag, "description": description, "severity": severity,
            "scope": scope, "period": period, "sku": sku, "echelon": echelon,
        })

    # ── 1. parse FG demand ────────────────────────────────────────────────────
    horizon_days = max(1, int(_read_attr(payload, "planning_horizon_days", 1) or 1))
    demand_rows_by_fg: Dict[Tuple[str, str], List[Tuple[date, float]]] = {}

    for pt in _as_list(_read_path(payload, "demand_forecast.series", [])):
        sku = str(_read_attr(pt, "sku", None) or "").strip()
        if not sku:
            continue
        d = _parse_day(_read_attr(pt, "date", None))
        if not d:
            continue
        k = _key(_read_attr(pt, "sku", None), _read_attr(pt, "plant_id", None))
        demand_rows_by_fg.setdefault(k, []).append(
            (d, max(0.0, _to_float(_read_attr(pt, "p50", 0.0), 0.0)))
        )

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
            t0, "INFEASIBLE",
            ["No valid demand_forecast.series rows within horizon."],
            engine_name="cplex", settings=solver_settings,
            termination_reason="INVALID_INPUT",
        )

    fg_keys = sorted(demand_rows_by_fg.keys(), key=lambda k: (k[0], k[1]))
    horizon_dates = sorted({d for rows in demand_rows_by_fg.values() for d, _ in rows})
    if not horizon_dates:
        return _empty_response_me(
            t0, "INFEASIBLE",
            ["No horizon dates could be derived from demand series."],
            engine_name="cplex", settings=solver_settings,
            termination_reason="INVALID_INPUT",
        )

    period_days = _infer_period_days_cplex(horizon_dates)
    day_to_idx: Dict[date, int] = {d: i for i, d in enumerate(horizon_dates)}
    n_periods = len(horizon_dates)

    # ── 2. parse raw BOM rows ─────────────────────────────────────────────────
    raw_bom_rows: List[Dict[str, Any]] = []
    for usage in _as_list(_read_attr(payload, "bom_usage", [])):
        parent_sku = str(_read_attr(usage, "fg_sku", None) or "").strip()
        child_sku = str(_read_attr(usage, "component_sku", None) or "").strip()
        usage_qty = max(0.0, _to_float(_read_attr(usage, "usage_qty", 0.0), 0.0))
        usage_plant = str(_read_attr(usage, "plant_id", None) or "").strip()
        if not parent_sku or not child_sku or usage_qty <= 0.0:
            continue
        if parent_sku == child_sku:
            continue
        raw_bom_rows.append({
            "parent_sku": parent_sku,
            "child_sku": child_sku,
            "usage_qty": usage_qty,
            "plant_id": usage_plant,
            "level": _read_attr(usage, "level", None),
        })

    if not raw_bom_rows:
        return _empty_response_me(
            t0, "INFEASIBLE",
            ["No valid BOM usage rows were provided; multi-echelon requires bom_usage."],
            engine_name="cplex", settings=solver_settings,
            termination_reason="INVALID_INPUT",
        )

    # ── 3. inventory seed ─────────────────────────────────────────────────────
    inventory_state: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for row in _as_list(_read_attr(payload, "inventory", [])):
        k = _key(_read_attr(row, "sku", None), _read_attr(row, "plant_id", None))
        d = _parse_day(_read_attr(row, "as_of_date", None))
        if not d:
            continue
        prev = inventory_state.get(k)
        if not prev or d > prev["as_of_date"]:
            inventory_state[k] = {
                "as_of_date": d,
                "on_hand": max(0.0, _to_float(_read_attr(row, "on_hand", 0.0), 0.0)),
                "safety_stock": max(0.0, _to_float(_read_attr(row, "safety_stock", 0.0), 0.0))
                    if _read_attr(row, "safety_stock", None) is not None else 0.0,
                "lead_time_days": max(0.0, _to_float(_read_attr(row, "lead_time_days", 0.0), 0.0))
                    if _read_attr(row, "lead_time_days", None) is not None else 0.0,
            }

    # ── 4. open PO calendar (index-based) ─────────────────────────────────────
    open_pos_by_key_idx: Dict[Tuple[str, str], Dict[int, float]] = {}
    for po in _as_list(_read_attr(payload, "open_pos", [])):
        eta_day = _parse_day(_read_attr(po, "eta_date", None))
        if not eta_day or eta_day not in day_to_idx:
            continue
        k = _key(_read_attr(po, "sku", None), _read_attr(po, "plant_id", None))
        idx = day_to_idx[eta_day]
        bucket = open_pos_by_key_idx.setdefault(k, {})
        bucket[idx] = bucket.get(idx, 0.0) + max(0.0, _to_float(_read_attr(po, "qty", 0.0), 0.0))

    # ── 5. resolve BOM edges to item keys (multi-layer parent->child graph) ──
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
            t0, "INFEASIBLE", [message],
            engine_name="cplex", settings=solver_settings,
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
    item_keys = sorted(set(list(fg_keys) + parent_keys + component_keys), key=lambda k: (k[0], k[1]))
    item_index = {k: i for i, k in enumerate(item_keys)}

    # Map each BOM child to impacted FG demand SKUs (transitively).
    me_cfg = _read_attr(payload, "multi_echelon", SimpleNamespace())
    max_bom_depth_raw = _read_attr(me_cfg, "max_bom_depth", None)
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
        k: external_demand_float.get(k, 0.0) for k in item_keys
    }
    demand_frontier: Dict[Tuple[str, str], float] = {
        k: qty for k, qty in expected_total_need_float.items() if qty > 0.0
    }
    expected_need_cap = 1_000_000_000.0
    expected_depth_used = 0
    while demand_frontier and expected_depth_used < max_bom_depth:
        next_frontier_demand: Dict[Tuple[str, str], float] = {}
        for parent_key, parent_qty in demand_frontier.items():
            if parent_qty <= 0.0:
                continue
            for child_key, _, usage_qty_f in children_by_parent.get(parent_key, []):
                add = parent_qty * usage_qty_f
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
                next_frontier_demand[child_key] = min(
                    expected_need_cap,
                    next_frontier_demand.get(child_key, 0.0) + delta,
                )
        demand_frontier = next_frontier_demand
        expected_depth_used += 1

    expected_internal_demand_scaled: Dict[Tuple[str, str], int] = {}
    for k in item_keys:
        total_need = expected_total_need_float.get(k, 0.0)
        external_need = external_demand_float.get(k, 0.0)
        internal_need = max(0.0, total_need - external_need)
        expected_internal_demand_scaled[k] = max(0, int(round(internal_need * qty_scale)))

    # Demand-by-period propagation for diagnostics/projection visibility.
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
            for child_key, _, usage_qty_f in children_by_parent.get(parent_key, []):
                child_total_bucket = expected_need_by_key_idx.setdefault(child_key, {})
                child_frontier_bucket = next_period_frontier.setdefault(child_key, {})
                for t, parent_qty in period_qty.items():
                    add = parent_qty * usage_qty_f
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
            k: bkt for k, bkt in next_period_frontier.items() if any(v > 0.0 for v in bkt.values())
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
    constraints_obj = _read_attr(payload, "constraints", SimpleNamespace())
    moq_map = _build_qty_map_me_cplex(_read_attr(constraints_obj, "moq", []), "min_qty")
    pack_map = _build_qty_map_me_cplex(_read_attr(constraints_obj, "pack_size", []), "pack_qty")
    max_map = _build_qty_map_me_cplex(_read_attr(constraints_obj, "max_order_qty", []), "max_qty")
    unit_cost_map = _build_unit_cost_map_me_cplex(_read_attr(constraints_obj, "unit_costs", []))
    budget_cap_scaled: Optional[int] = None
    budget_cap_raw = _read_attr(constraints_obj, "budget_cap", None)
    if budget_cap_raw is not None:
        budget_cap_scaled = max(
            0, int(round(max(0.0, _to_float(budget_cap_raw, 0.0)) * qty_scale))
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

    # ══════════════════════════════════════════════════════════════════════
    # BUILD CPLEX MODEL
    # ══════════════════════════════════════════════════════════════════════
    mdl = Model(name="replenishment_multi_echelon")
    mdl.parameters.timelimit = cpx_config.time_limit
    mdl.parameters.mip.tolerances.mipgap = cpx_config.mip_gap
    if cpx_config.threads > 0:
        mdl.parameters.threads = cpx_config.threads
    mdl.parameters.randomseed = cpx_config.seed
    if not cpx_config.log_output:
        mdl.set_log_output(None)

    me_lot_mode = str(_read_attr(me_cfg, "lot_sizing_mode", None) or "moq_pack").strip().lower()
    comp_apply_lot = me_lot_mode not in {"off", "none", "disabled"}

    order_vars: Dict[Tuple[Tuple[str, str], int], Any] = {}
    inv_vars: Dict[Tuple[Tuple[str, str], int], Any] = {}
    back_vars: Dict[Tuple[Tuple[str, str], int], Any] = {}

    # ── 10. create decision variables ─────────────────────────────────────────
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
            var_tag = f"{sku}_{k[1] or 'NA'}_{t}"
            o_var = mdl.integer_var(lb=0, ub=order_ub_by_key[k], name=f"ord_{item_idx}_{t}")
            i_var = mdl.integer_var(lb=0, ub=inv_ub_by_key[k], name=f"inv_{item_idx}_{t}")
            b_var = mdl.integer_var(lb=0, ub=back_ub_by_key[k], name=f"back_{item_idx}_{t}")
            order_vars[(k, t)] = o_var
            inv_vars[(k, t)] = i_var
            back_vars[(k, t)] = b_var

            # Orders placed after the last deliverable period are locked to zero.
            if t + lead_offset >= n_periods:
                mdl.add_constraint(o_var == 0, ctname=f"lock_{item_idx}_{t}")

            # Per-item maximum order quantity.
            if max_s > 0:
                mdl.add_constraint(o_var <= max_s, ctname=f"maxq_{item_idx}_{t}")
                _tag(
                    f"MAXQ[{sku},{t}]", "Per-item max order quantity.",
                    scope="sku_period", period=horizon_dates[t].isoformat(), sku=sku,
                )

            # Pack-size multiple: order = pack * z.
            if use_lot and pack_s > qty_scale:
                z_ub = max(0, order_ub_by_key[k] // max(1, pack_s))
                z_var = mdl.integer_var(lb=0, ub=int(z_ub), name=f"pack_{item_idx}_{t}")
                mdl.add_constraint(o_var == pack_s * z_var, ctname=f"packc_{item_idx}_{t}")
                _tag(
                    f"PACK[{sku},{t}]", "Order must be pack-size multiple.",
                    scope="sku_period", period=horizon_dates[t].isoformat(), sku=sku,
                )

            # MOQ: o >= moq when ordered (y=1), o = 0 when not ordered (y=0).
            if use_lot and moq_s > 0:
                y_var = mdl.binary_var(name=f"y_{item_idx}_{t}")
                mdl.add_indicator(y_var, o_var >= moq_s, active_value=1, name=f"moq_on_{item_idx}_{t}")
                mdl.add_indicator(y_var, o_var == 0, active_value=0, name=f"moq_off_{item_idx}_{t}")
                _tag(
                    f"MOQ[{sku},{t}]", "MOQ enforcement when order placed.",
                    scope="sku_period", period=horizon_dates[t].isoformat(), sku=sku,
                )

    # ── 11. arrival helpers ───────────────────────────────────────────────────
    def _arrival(k: Tuple[str, str], t: int) -> Any:
        """Inbound at period t: open-PO constant + new order placed (t - lead_offset) periods ago."""
        open_s = int(round((open_pos_by_key_idx.get(k, {}).get(t, 0.0)) * qty_scale))
        src = t - lead_offsets.get(k, 0)
        if src >= 0:
            return open_s + order_vars[(k, src)]
        return open_s

    def _produced(k: Tuple[str, str], t: int) -> Any:
        """Produced/supplied quantity available at period t (arriving planned order)."""
        src = t - lead_offsets.get(k, 0)
        if src >= 0:
            return order_vars[(k, src)]
        return 0

    # ── 12. inventory balance constraints + BOM coupling ──────────────────────
    for k in item_keys:
        item_idx = item_index[k]
        for t in range(n_periods):
            prev_inv = inv_vars[(k, t - 1)] if t > 0 else initial_on_hand_scaled.get(k, 0)
            prev_back = back_vars[(k, t - 1)] if t > 0 else 0
            arrival = _arrival(k, t)
            demand_s = demand_by_fg_idx_scaled.get(k, {}).get(t, 0)

            # BOM consumption terms: sum of (usage_coeff * produced_parent) for all parents.
            bom_parent_terms = parents_by_child.get(k, [])
            consumption_terms = []
            for parent_key, coeff, _ in bom_parent_terms:
                pe = _produced(parent_key, t)
                if isinstance(pe, int) and pe == 0:
                    continue
                consumption_terms.append(coeff * pe)
            consumption = mdl.sum(consumption_terms) if consumption_terms else 0

            # Item flow balance with external demand + dependent BOM demand.
            mdl.add_constraint(
                qty_scale * inv_vars[(k, t)] - qty_scale * back_vars[(k, t)]
                == qty_scale * prev_inv - qty_scale * prev_back
                + qty_scale * arrival - qty_scale * demand_s - consumption,
                ctname=f"bal_{item_idx}_{t}",
            )
            if k in fg_keys:
                _tag(
                    f"BALANCE_INV[{k[0]},{t}]",
                    "FG inventory flow balance with external demand.",
                    scope="sku_period", period=horizon_dates[t].isoformat(), sku=k[0],
                )
            if bom_parent_terms:
                _tag(
                    f"BOM_LINK[{k[0]},{t}]",
                    "Component flow includes BOM-coupled parent production consumption.",
                    scope="sku_period", period=horizon_dates[t].isoformat(), sku=k[0],
                )

                # Hard feasibility: cannot consume more than available.
                mdl.add_constraint(
                    consumption <= qty_scale * (prev_inv + arrival),
                    ctname=f"comp_feas_{item_idx}_{t}",
                )
                _tag(
                    f"COMP_FEAS[{k[0]},{t}]",
                    "Component consumption cannot exceed available inventory + arrivals.",
                    scope="sku_period", period=horizon_dates[t].isoformat(), sku=k[0],
                )

    # ── 13. global budget constraint ──────────────────────────────────────────
    if budget_cap_scaled is not None:
        mdl.add_constraint(
            mdl.sum(order_vars.values()) <= budget_cap_scaled,
            ctname="budget_global",
        )
        _tag("BUDGET_GLOBAL", "Global shared budget cap across all items.")

    # ── 14. optional capacity constraints ─────────────────────────────────────
    prod_capacity_refs: List[Dict[str, Any]] = []
    inv_capacity_refs_me: List[Dict[str, Any]] = []

    prod_cap_scalar, prod_cap_by_day = _resolve_capacity_for_multi_cplex(
        payload, "production_capacity_per_period",
    )
    for t, cap_day in enumerate(horizon_dates):
        prod_cap_t = _capacity_for_day_cplex(cap_day, prod_cap_scalar, prod_cap_by_day)
        if prod_cap_t is None or prod_cap_t <= 0.0:
            continue
        prod_cap_s = int(round(prod_cap_t * qty_scale))
        prod_terms = [_produced(fg_key, t) for fg_key in fg_keys]
        mdl.add_constraint(
            mdl.sum(prod_terms) <= prod_cap_s,
            ctname=f"cap_prod_{cap_day.isoformat()}",
        )
        _tag(
            f"CAP_PROD[{cap_day.isoformat()}]",
            "Shared production capacity for this period.",
            scope="period", period=cap_day.isoformat(),
        )
        prod_capacity_refs.append({
            "day": cap_day, "cap_s": prod_cap_s, "expr_terms": prod_terms,
        })

    inv_cap_scalar, inv_cap_by_day = _resolve_capacity_for_multi_cplex(
        payload, "inventory_capacity_per_period",
    )
    for t, cap_day in enumerate(horizon_dates):
        inv_cap_t = _capacity_for_day_cplex(cap_day, inv_cap_scalar, inv_cap_by_day)
        if inv_cap_t is None or inv_cap_t <= 0.0:
            continue
        inv_cap_s = int(round(inv_cap_t * qty_scale))
        mdl.add_constraint(
            mdl.sum(inv_vars[(k, t)] for k in item_keys) <= inv_cap_s,
            ctname=f"cap_inv_{cap_day.isoformat()}",
        )
        _tag(
            f"CAP_INV[{cap_day.isoformat()}]",
            "Shared inventory capacity for this period.",
            scope="period", period=cap_day.isoformat(),
        )
        inv_capacity_refs_me.append({
            "day": cap_day, "cap_s": inv_cap_s, "keys": list(item_keys), "t": t,
        })

    # Optional hard service-level target (on FG end backlog).
    objective_obj = _read_attr(payload, "objective", SimpleNamespace())
    service_level_target_raw = _read_attr(objective_obj, "service_level_target", None)
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
        mdl.add_constraint(
            mdl.sum(back_vars[(fg_key, n_periods - 1)] for fg_key in fg_keys) <= service_level_allowed_fg_backlog_s,
            ctname="service_level",
        )
        _tag("SERVICE_LEVEL_GLOBAL", "Hard FG end-of-horizon service-level target.")

    # ── 15. objective ─────────────────────────────────────────────────────────
    holding_cost = _to_float(_read_attr(objective_obj, "holding_cost", 0.0), 0.0)
    stockout_penalty = _to_float(_read_attr(objective_obj, "stockout_penalty", 1.0), 1.0)
    comp_penalty_raw = _read_attr(me_cfg, "component_stockout_penalty", None)
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
        mdl.minimize(mdl.sum(obj_terms))

    # ── 16. solve ─────────────────────────────────────────────────────────────
    solution = mdl.solve()
    solve_time_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
    status_info = _status_from_cplex(solution, mdl, cpx_config)

    if not status_info.has_feasible_solution:
        reasons = ["CPLEX did not find a feasible BOM-aware plan under current constraints."]
        suspected_tags = ["BOM_LINK", "COMP_FEAS"]
        constraints_checked: List[Dict[str, Any]] = [
            _mk_constraint_check(
                name="bom_coupling", tag="BOM_LINK", passed=False,
                details="No feasible solution found with hard BOM coupling constraints.",
                description="BOM-coupled flow feasibility.", echelon="multi",
            ),
        ]
        if prod_capacity_refs:
            reasons.append("Production capacity constraints CAP_PROD[*] were active in this run.")
            suspected_tags.append("CAP_PROD")
            prod_period_tags = sorted({f"CAP_PROD[{ref['day'].isoformat()}]" for ref in prod_capacity_refs})
            constraints_checked.append(_mk_constraint_check(
                name="production_capacity", tag="CAP_PROD", passed=False,
                details="No feasible solution found with CAP_PROD[*] constraints enabled.",
                description="Shared production capacity per period.",
                scope="period", echelon="multi", tags=prod_period_tags,
            ))
        if inv_capacity_refs_me:
            reasons.append("Inventory capacity constraints CAP_INV[*] were active in this run.")
            suspected_tags.append("CAP_INV")
            inv_period_tags = sorted({f"CAP_INV[{ref['day'].isoformat()}]" for ref in inv_capacity_refs_me})
            constraints_checked.append(_mk_constraint_check(
                name="inventory_capacity", tag="CAP_INV", passed=False,
                details="No feasible solution found with CAP_INV[*] constraints enabled.",
                description="Shared inventory capacity per period.",
                scope="period", echelon="multi", tags=inv_period_tags,
            ))
        if service_level_target is not None:
            suspected_tags.append("SERVICE_LEVEL_GLOBAL")
            constraints_checked.append(_mk_constraint_check(
                name="service_level_target", tag="SERVICE_LEVEL_GLOBAL", passed=False,
                details="Hard service-level target may conflict with supply/capacity constraints.",
                description="Hard FG service-level target.", echelon="multi",
            ))
        infeasibility_analysis = _summarize_infeasibility(suspected_tags)

        try:
            mdl.end()
        except Exception:
            pass

        return finalize_planning_response(
            {
                **_empty_response_me(
                    t0, status_info.status.value, reasons,
                    engine_name="cplex", solve_time_ms=solve_time_ms,
                    settings=solver_settings,
                    termination_reason=status_info.termination_reason,
                    status_name=status_info.status_name,
                ),
                "proof": {
                    "objective_terms": [],
                    "constraints_checked": constraints_checked,
                    "constraint_tags": constraint_tags,
                    "infeasibility_analysis": infeasibility_analysis,
                    "relaxation_analysis": [],
                },
            },
            default_engine="cplex",
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
            qty_s_val = int(round(solution.get_value(order_vars[(k, t)])))
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
            inbound_plan = int(round(solution.get_value(order_vars[(comp_key, src)]))) / qty_scale if src >= 0 else 0.0
            dep_demand = max(
                0.0,
                expected_dependent_need_by_key_idx.get(comp_key, {}).get(t, 0.0),
            )
            on_hand_end = int(round(solution.get_value(inv_vars[(comp_key, t)]))) / qty_scale
            backlog = int(round(solution.get_value(back_vars[(comp_key, t)]))) / qty_scale
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
        int(round(solution.get_value(back_vars[(fg_key, n_periods - 1)]))) / qty_scale
        for fg_key in fg_keys
    )
    stockout_units = sum(
        int(round(solution.get_value(back_vars[(fg_key, t)]))) / qty_scale
        for fg_key in fg_keys for t in range(n_periods)
    )
    holding_units = sum(
        int(round(solution.get_value(inv_vars[(fg_key, t)]))) / qty_scale
        for fg_key in fg_keys for t in range(n_periods)
    )
    comp_stockout = sum(
        int(round(solution.get_value(back_vars[(ck, t)]))) / qty_scale
        for ck in component_keys for t in range(n_periods)
    )
    comp_holding = sum(
        int(round(solution.get_value(inv_vars[(ck, t)]))) / qty_scale
        for ck in component_keys for t in range(n_periods)
    )

    service_level: Optional[float] = None
    if total_fg_demand > 0.0:
        service_level = max(0.0, min(1.0, 1.0 - end_fg_backlog / total_fg_demand))

    obj_val = float(mdl.objective_value) if hasattr(mdl, "objective_value") and mdl.objective_value is not None else 0.0
    est_cost = obj_val / (qty_scale * cost_scale)

    gap = None
    try:
        gap_raw = mdl.solve_details.mip_relative_gap if hasattr(mdl.solve_details, "mip_relative_gap") else None
        if gap_raw is not None:
            gap = float(round(gap_raw, 6))
    except Exception:
        pass

    best_bound_cost: Optional[float] = None
    try:
        best_bound_raw = mdl.solve_details.best_bound if hasattr(mdl.solve_details, "best_bound") else None
        if best_bound_raw is not None:
            best_bound_cost = float(round(best_bound_raw / (qty_scale * cost_scale), 6))
    except Exception:
        pass

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
    if budget_cap_raw is not None:
        budget_cap_f = max(0.0, _to_float(budget_cap_raw, 0.0))
        budget_passed = total_order_qty <= budget_cap_f + 1e-9
        budget_detail = f"Total ordered qty {round(total_order_qty, 6)} vs cap {round(budget_cap_f, 6)}."

    # BOM coupling verification (post-solve).
    bom_coupling_failed = 0
    for comp_key in component_keys:
        for t in range(n_periods):
            prev_inv_s = int(round(solution.get_value(inv_vars[(comp_key, t - 1)]))) if t > 0 else initial_on_hand_scaled.get(comp_key, 0)
            arr = _arrival(comp_key, t)
            arrival_s = int(round(solution.get_value(arr))) if not isinstance(arr, int) else arr
            cons_s = 0
            for parent_key, coeff, _ in parents_by_child.get(comp_key, []):
                pe = _produced(parent_key, t)
                prod_s = int(round(solution.get_value(pe))) if not isinstance(pe, int) else int(pe)
                cons_s += coeff * prod_s
            if cons_s > qty_scale * (prev_inv_s + arrival_s) + 1:
                bom_coupling_failed += 1

    prod_cap_failed = 0
    prod_cap_binding = 0
    prod_cap_tags: List[str] = []
    for ref in prod_capacity_refs:
        produced_s = 0
        for term in ref["expr_terms"]:
            produced_s += int(round(solution.get_value(term))) if not isinstance(term, int) else int(term)
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
        t_ref = int(ref["t"])
        for k_ref in ref["keys"]:
            inv_total_s += int(round(solution.get_value(inv_vars[(k_ref, t_ref)])))
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
            planned_today = int(round(solution.get_value(order_vars[(comp_key, src)]))) / qty_scale if src >= 0 else 0.0
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

    constraints_checked_final = [
        _mk_constraint_check(
            name="order_qty_non_negative", tag="NONNEG",
            passed=nonneg_failed == 0,
            details=f"Negative quantity rows: {nonneg_failed}.",
            description="All plan quantities are non-negative.",
            scope="row", echelon="multi",
        ),
        _mk_constraint_check(
            name="moq", tag="MOQ",
            passed=moq_failed == 0,
            details=f"Rows violating MOQ: {moq_failed}.",
            description="MOQ enforcement across item-period rows.",
            scope="sku_period", echelon="multi",
        ),
        _mk_constraint_check(
            name="pack_size_multiple", tag="PACK",
            passed=pack_failed == 0,
            details=f"Rows violating pack-size multiple: {pack_failed}.",
            description="Pack-size multiple enforcement across item-period rows.",
            scope="sku_period", echelon="multi",
        ),
        _mk_constraint_check(
            name="budget_cap", tag="BUDGET_GLOBAL",
            passed=budget_passed,
            details=budget_detail,
            description="Shared budget cap across all items.",
            echelon="multi",
        ),
        _mk_constraint_check(
            name="max_order_qty", tag="MAXQ",
            passed=max_failed == 0,
            details=f"Rows violating max_order_qty: {max_failed}.",
            description="Max order quantity per item-period.",
            scope="sku_period", echelon="multi",
        ),
        _mk_constraint_check(
            name="bom_coupling", tag="BOM_LINK",
            passed=bom_coupling_failed == 0,
            details=f"BOM coupling violations: {bom_coupling_failed}.",
            description="Component consumption linked to parent item production via BOM usage.",
            scope="sku_period", echelon="multi",
        ),
        _mk_constraint_check(
            name="component_feasibility", tag="COMP_FEAS",
            passed=len(bottleneck_items) == 0,
            details=f"Detected component bottlenecks: {len(bottleneck_items)}.",
            description="Component availability supports requested FG production.",
            scope="sku_period", echelon="multi",
        ),
    ]
    if prod_capacity_refs:
        prod_period_tags_final = sorted({f"CAP_PROD[{ref['day'].isoformat()}]" for ref in prod_capacity_refs})
        constraints_checked_final.append(_mk_constraint_check(
            name="production_capacity", tag="CAP_PROD",
            passed=prod_cap_failed == 0,
            details=f"CAP_PROD checks={len(prod_capacity_refs)}, violations={prod_cap_failed}, binding={prod_cap_binding}.",
            description="Shared production capacity per period.",
            scope="period", echelon="multi", tags=prod_period_tags_final,
        ))
    if inv_capacity_refs_me:
        inv_period_tags_final = sorted({f"CAP_INV[{ref['day'].isoformat()}]" for ref in inv_capacity_refs_me})
        constraints_checked_final.append(_mk_constraint_check(
            name="inventory_capacity", tag="CAP_INV",
            passed=inv_cap_failed == 0,
            details=f"CAP_INV checks={len(inv_capacity_refs_me)}, violations={inv_cap_failed}, binding={inv_cap_binding}.",
            description="Shared inventory capacity per period.",
            scope="period", echelon="multi", tags=inv_period_tags_final,
        ))
    if service_level_target is not None:
        allowed_backlog_f = (service_level_allowed_fg_backlog_s or 0) / qty_scale
        constraints_checked_final.append(_mk_constraint_check(
            name="service_level_target", tag="SERVICE_LEVEL_GLOBAL",
            passed=end_fg_backlog <= allowed_backlog_f + 1e-9,
            details=f"End FG backlog {round(end_fg_backlog, 6)} vs allowed {round(allowed_backlog_f, 6)}.",
            description="Hard FG service-level target.", echelon="multi",
        ))

    all_checks_passed = all(check.get("passed") is True for check in constraints_checked_final)
    if status_info.time_limit_hit:
        solve_status = PlanningStatus.TIMEOUT
    elif not all_checks_passed:
        solve_status = PlanningStatus.INFEASIBLE
    else:
        solve_status = status_info.status if status_info.status in {
            PlanningStatus.OPTIMAL, PlanningStatus.FEASIBLE,
        } else PlanningStatus.FEASIBLE

    me_meta = {
        "multi_echelon_mode": str(_read_attr(me_cfg, "mode", None) or "bom_v0"),
        "max_bom_depth": max_bom_depth,
        "bom_explosion_used": bool(_read_attr(me_cfg, "bom_explosion_used", False)),
        "bom_explosion_reused": bool(_read_attr(me_cfg, "bom_explosion_reused", False)),
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

    try:
        mdl.end()
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
                engine_name="cplex", solver_name="cplex_milp_multi_echelon",
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
                best_bound=best_bound_cost,
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
                     "note": "CPLEX weighted objective value proxy."},
                ],
                "constraints_checked": constraints_checked_final,
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
                "relaxation_analysis": [],
            },
        },
        default_engine="cplex",
        default_status=solve_status,
    )
