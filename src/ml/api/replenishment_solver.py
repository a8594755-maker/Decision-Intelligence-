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

from types import SimpleNamespace
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

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

# ── Imports from extracted modules ─────────────────────────────────────────────
from ml.api.solver_utils import (  # noqa: E402
    SCALE, OBJ_SCALE, MAX_SOLVER_SECONDS, DIAGNOSE_SOLVER_SECONDS,
    DEFAULT_SOLVER_RANDOM_SEED, DEFAULT_SOLVER_NUM_SEARCH_WORKERS,
    DEFAULT_SOLVER_LOG_PROGRESS, DEFAULT_SOLVER_SINGLE_TIME_LIMIT_SECONDS,
    DEFAULT_SOLVER_MULTI_TIME_LIMIT_SECONDS,
    SolverRunSettings, SolverStatusInfo, SupplierInfo,
    _read_attr, _as_list, _read_path, _to_bool, _to_float,
    _payload_to_plain, _plain_to_ns, _clone_payload, _set_path,
    _first_non_none, _as_dict,
    _s, _us, _parse_day, _key, _parse_sku_plant_key,
    _parse_keyed_scaled_qty_map, _lookup_keyed_value, _build_qty_map,
)
from ml.api.solver_capacity import (  # noqa: E402
    _capacity_for_period, _capacity_input_is_scalar,
    _capacity_scalar_and_calendar, _resolve_capacity_raw,
    _resolve_inventory_capacity_single, _resolve_shared_inventory_capacity_single,
    _resolve_production_capacity_single, _resolve_capacity_for_multi,
    _resolve_budget_cap, _resolve_priority_weights, _capacity_for_day,
    _resolve_solver_run_settings, _apply_solver_run_settings,
    _solve_with_cancel_support, _did_time_limit_hit, _status_from_cp,
    _build_solver_meta,
)
from ml.api.solver_analysis import (  # noqa: E402
    _mk_constraint_check, _suggestions_for_categories, _summarize_infeasibility,
    _positive_shadow_from_dual, _shadow_price_entry,
    _compute_shadow_prices, _build_relaxation_summary,
    _run_relaxation_analysis_single, _build_explain_summary,
    _build_unit_cost_map_me,
)
from ml.api.solver_helpers import (  # noqa: E402
    _make_tag_collector, _determine_final_status,
    _build_proof_and_diagnostics, _build_base_constraint_checks,
    _propagate_bom_demand, _propagate_bom_demand_by_period,
    _empty_response,
)

# Re-export for backward compatibility
__all__ = ['SCALE', 'OBJ_SCALE', 'SolverRunSettings', 'SolverStatusInfo', 'SupplierInfo',
           'solve_replenishment', 'solve_replenishment_multi_echelon', 'ortools_available']


# ── local helpers for post-solve verification ──────────────────────────────────

def _compute_capacity_binding(
    cap_by_day_s: Dict[date, int],
    usage_by_day: Dict[date, Any],
    label: str,
    *,
    scale_divisor: int = 1,
    threshold: float = 1.0,
) -> Tuple[Optional[float], bool, Optional[str]]:
    """Compute (min_slack, is_binding, natural_language) for a period-capacity family."""
    if not cap_by_day_s:
        return None, False, None
    slacks: List[float] = []
    for day, cap_s in cap_by_day_s.items():
        cap_real = cap_s / scale_divisor if scale_divisor > 1 else _us(cap_s)
        used = usage_by_day.get(day, 0)
        used_real = used / scale_divisor if scale_divisor > 1 else _us(used)
        slacks.append(cap_real - used_real)
    min_slack = round(min(slacks), 4) if slacks else None
    binding = min_slack is not None and min_slack < threshold
    nl = f"{label} is binding (tightest period slack: {min_slack:,.1f})." if binding else None
    return min_slack, binding, nl


def _build_period_capacity_kpi(
    cap_by_day_s: Dict[date, int],
    usage_by_day: Dict[date, Any],
    *,
    scale_divisor: int = 1,
    extra_fields: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Build a shared KPI dict with per-period utilization breakdown."""
    if not cap_by_day_s:
        return None
    rows: List[Dict[str, Any]] = []
    utils: List[float] = []
    for day in sorted(cap_by_day_s.keys()):
        cap_real = cap_by_day_s[day] / scale_divisor if scale_divisor > 1 else _us(cap_by_day_s[day])
        used = usage_by_day.get(day, 0)
        used_real = used / scale_divisor if scale_divisor > 1 else _us(used)
        util = None if cap_real <= 0 else used_real / cap_real
        if util is not None:
            utils.append(util)
        rows.append({
            "period": day.isoformat(),
            "used": round(used_real, 6),
            "cap": round(cap_real, 6),
            "utilization": None if util is None else round(util, 6),
        })
    result: Dict[str, Any] = {
        "avg_utilization": None if not utils else round(sum(utils) / len(utils), 6),
        "max_utilization": None if not utils else round(max(utils), 6),
        "binding_periods": [r["period"] for r in rows if (r["utilization"] or 0.0) >= 0.999],
        "periods": rows,
    }
    if extra_fields:
        result.update(extra_fields)
    return result


def _extract_plan_verify_single(
    ordered_keys: List[Tuple[str, str]],
    sku_var_maps: Dict[Tuple[str, str], Dict[str, Any]],
    sku_meta: Dict[Tuple[str, str], Dict[str, Any]],
    solver: Any,
    moq_s: Dict[str, int],
    pack_s: Dict[str, int],
    maxq_s: Dict[str, int],
    unit_cost_map: Dict[str, float],
) -> Dict[str, Any]:
    """Extract plan rows from solved single-echelon model and verify constraints.

    Returns dict with keys: plan_rows, total_order_qty, total_spend, total_stockout,
    total_holding, total_demand, end_backlog_total, nonneg_failed, moq_failed,
    pack_failed, max_failed, ss_violations, total_ss_violation_periods.
    """
    plan_rows: List[Dict[str, Any]] = []
    total_order_qty = total_spend = total_stockout = total_holding = total_demand = end_backlog_total = 0.0
    moq_failed = pack_failed = max_failed = nonneg_failed = 0

    for key in ordered_keys:
        if key not in sku_var_maps:
            continue
        sku, plant_id = key
        vars_ = sku_var_maps[key]
        meta = sku_meta[key]
        days_list, demand_s_list = meta["days"], meta["demand_s"]
        lead_time = meta["lead_time"]
        sku_moq_s, sku_pack_s_val, sku_max_s_val = moq_s.get(sku, 0), pack_s.get(sku, 0), maxq_s.get(sku, 0)
        sku_uc = max(0.0, unit_cost_map.get(sku, 0.0))
        if vars_["back"]:
            end_backlog_total += _us(int(solver.Value(vars_["back"][-1])))

        for t in range(len(days_list)):
            order_val_s = int(solver.Value(vars_["order"][t]))
            inv_val_s = int(solver.Value(vars_["inv"][t]))
            back_val_s = int(solver.Value(vars_["back"][t]))
            total_demand += _us(demand_s_list[t])
            total_stockout += _us(back_val_s)
            total_holding += _us(inv_val_s)
            sup_vars, meta_sups = vars_.get("supplier_order", {}), meta.get("suppliers", [])
            if order_val_s > 0 and meta_sups:
                for sup in meta_sups:
                    s_val_s = int(solver.Value(sup_vars[sup.supplier_id][t]))
                    if s_val_s > 0:
                        s_qty = _us(s_val_s)
                        plan_rows.append({"sku": sku, "plant_id": plant_id or None, "supplier_id": sup.supplier_id,
                            "order_date": days_list[t].isoformat(),
                            "arrival_date": (days_list[t] + timedelta(days=sup.lead_time_days)).isoformat(),
                            "order_qty": float(round(s_qty, 6))})
                        total_order_qty += s_qty; total_spend += s_qty * sup.unit_cost
            elif order_val_s > 0:
                order_qty = _us(order_val_s)
                plan_rows.append({"sku": sku, "plant_id": plant_id or None,
                    "order_date": days_list[t].isoformat(),
                    "arrival_date": (days_list[t] + timedelta(days=lead_time)).isoformat(),
                    "order_qty": float(round(order_qty, 6))})
                total_order_qty += order_qty; total_spend += order_qty * sku_uc
            if order_val_s > 0:
                if _us(order_val_s) < -1e-9: nonneg_failed += 1
                if sku_moq_s > 0 and order_val_s < sku_moq_s - 1: moq_failed += 1
                if sku_pack_s_val > SCALE and order_val_s % sku_pack_s_val > 1: pack_failed += 1
                if sku_max_s_val > 0 and order_val_s > sku_max_s_val + 1: max_failed += 1

    plan_rows.sort(key=lambda r: (r["sku"], r.get("plant_id") or "", r["order_date"]))

    # Safety stock violations
    ss_violations: Dict[str, List[Dict[str, Any]]] = {}
    total_ss_violation_periods = 0
    for key in ordered_keys:
        if key not in sku_var_maps:
            continue
        vars_ = sku_var_maps[key]
        meta_ = sku_meta[key]
        if vars_.get("ss_slack"):
            safety_stock_real = _us(meta_.get("safety_stock_s", 0))
            for t in range(len(meta_["days"])):
                slack_val = _us(int(solver.Value(vars_["ss_slack"][t])))
                if slack_val > 1e-6:
                    total_ss_violation_periods += 1
                    ss_violations.setdefault(key[0], []).append({
                        "period": meta_["days"][t].isoformat(), "shortfall": round(slack_val, 4),
                        "safety_stock_target": round(safety_stock_real, 4),
                        "actual_inventory": round(_us(int(solver.Value(vars_["inv"][t]))), 4)})

    return {
        "plan_rows": plan_rows, "total_order_qty": total_order_qty, "total_spend": total_spend,
        "total_stockout": total_stockout, "total_holding": total_holding, "total_demand": total_demand,
        "end_backlog_total": end_backlog_total, "nonneg_failed": nonneg_failed, "moq_failed": moq_failed,
        "pack_failed": pack_failed, "max_failed": max_failed,
        "ss_violations": ss_violations, "total_ss_violation_periods": total_ss_violation_periods,
    }


def _verify_budget_pp_single(
    budget_per_period_cap_s: Dict[date, int],
    budget_per_period_mode: Optional[str],
    ordered_keys: List[Tuple[str, str]],
    sku_var_maps: Dict[Tuple[str, str], Dict[str, Any]],
    sku_meta: Dict[Tuple[str, str], Dict[str, Any]],
    unit_cost_map: Dict[str, float],
    order_vars_by_day: Dict[date, List[Any]],
    solver: Any,
) -> Tuple[Dict[date, float], int]:
    """Verify per-period budget after solve. Returns (usage_by_day, failed_count)."""
    usage: Dict[date, float] = {}
    failed = 0
    for day in sorted(budget_per_period_cap_s.keys()):
        if budget_per_period_mode == "spend":
            used_s2 = 0
            for k2 in ordered_keys:
                if k2 not in sku_var_maps:
                    continue
                coeff_c = max(0, int(round(max(0.0, unit_cost_map.get(k2[0], 1.0)) * SCALE)))
                for t_idx, d in enumerate(sku_meta[k2]["days"]):
                    if d == day:
                        used_s2 += coeff_c * int(solver.Value(sku_var_maps[k2]["order"][t_idx]))
            usage[day] = used_s2 / (SCALE * SCALE) if SCALE else 0.0
        else:
            used_s = sum(int(solver.Value(v)) for v in order_vars_by_day.get(day, []))
            usage[day] = _us(used_s)
        cap_limit = budget_per_period_cap_s[day] / (SCALE * SCALE) if budget_per_period_mode == "spend" else _us(budget_per_period_cap_s[day])
        if usage[day] > cap_limit + 1e-6:
            failed += 1
    return usage, failed


def _build_infeasible_response_single(
    *,
    t0: datetime,
    status_info: SolverStatusInfo,
    solver_settings: SolverRunSettings,
    solve_time_ms: int,
    constraint_tags: List[Dict[str, Any]],
    diagnose_mode: bool,
    internal_diagnose: bool,
    payload: Any,
    production_cap_by_day_s: Dict,
    inventory_cap_by_day_s: Dict,
    budget_cap: Optional[float],
    service_level_target: Optional[float],
) -> Dict[str, Any]:
    """Build the full infeasible-case response for single-echelon solver."""
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
        diagnostics = {"mode": "progressive_relaxation", "relaxation_analysis": relaxation_analysis}

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
            name="model_feasibility", tag="CP_FEASIBILITY", passed=False,
            details=f"CP-SAT status '{status_info.status_name}' ({status_info.termination_reason}).",
            description="Overall model feasibility status.",
        ),
    ]
    _infeasible_cap_checks = [
        (budget_cap is not None, "budget_cap", "BUDGET_GLOBAL",
         "Budget family participates in infeasibility candidate set.", "Shared budget cap across SKUs.", None),
        (bool(production_cap_by_day_s), "shared_production_cap", "CAP_PROD",
         "Shared production capacity family participates in infeasibility candidate set.",
         "Shared production capacity per period.", sorted(production_cap_by_day_s.keys()) if production_cap_by_day_s else []),
        (bool(inventory_cap_by_day_s), "shared_inventory_cap", "CAP_INV",
         "Shared inventory capacity family participates in infeasibility candidate set.",
         "Shared inventory capacity per period.", sorted(inventory_cap_by_day_s.keys()) if inventory_cap_by_day_s else []),
    ]
    for active, cname, ctag, cdetails, cdesc, days_list in _infeasible_cap_checks:
        if not active:
            continue
        kwargs: Dict[str, Any] = {"name": cname, "tag": ctag, "passed": False, "details": cdetails, "description": cdesc}
        if days_list is not None:
            kwargs["scope"] = "period"
            kwargs["tags"] = [f"{ctag}[{day.isoformat()}]" for day in days_list]
        constraints_checked.append(_mk_constraint_check(**kwargs))
    if service_level_target is not None:
        constraints_checked.append(_mk_constraint_check(
            name="service_level_target", tag="SERVICE_LEVEL_GLOBAL", passed=False,
            details="Hard service-level target may conflict with other constraints.",
            description="Hard end-of-horizon service-level target.",
        ))

    return finalize_planning_response(
        {
            "status": status_info.status.value,
            "plan_lines": [],
            "kpis": {
                "estimated_service_level": None, "estimated_stockout_units": None,
                "estimated_holding_units": None, "estimated_total_cost": None,
            },
            "shared_kpis": {
                "total_cost": None, "total_stockout_units": None,
                "budget": None, "production_capacity": None, "inventory_capacity": None,
            },
            "binding_constraints": [],
            "shadow_prices": None,
            "relaxation_applied": relaxation_applied,
            "solver_meta": _build_solver_meta(
                status_info=status_info, settings=solver_settings,
                solve_time_ms=solve_time_ms, objective_value=None, best_bound=None, gap=None,
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
            True,  # enabled by default for robust (conservative) planning
        ),
        True,
    )
    # Phase 3 – P3.3: Use p10 as primary demand constraint RHS (optimistic planning)
    use_p10_demand_model = _to_bool(
        _first_non_none(
            _read_attr(objective, "use_p10_demand_model", None),
            forecast_uncertainty_cfg.get("use_p10_demand_model"),
            _read_path(payload, "settings.use_p10_demand_model", None),
            False,
        ),
        False,
    )
    # p10 takes precedence over p90 if both are set (caller responsibility to not set both)
    if use_p10_demand_model:
        use_p90_demand_model = False
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

    constraint_tags, _tag = _make_tag_collector("single")

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

        ic = _read_attr(item, "constraints", None)
        icost = _read_attr(item, "costs", None)
        # Per-item constraint overrides: (target_dict, names_to_search, scale_fn)
        for tgt, names, sources in [
            (moq_s, ["moq", "min_qty"], [ic, item]),
            (pack_s, ["pack_size", "pack_qty"], [ic, item]),
            (maxq_s, ["max_order_qty", "max_qty"], [ic, item]),
        ]:
            v = _first_non_none(*(
                _read_attr(src, n, None) for src in sources for n in names))
            if v is not None:
                tgt[sku] = _s(max(0.0, _to_float(v, 0.0)))
        uc = _first_non_none(_read_attr(icost, "unit_cost", None),
                             _read_attr(ic, "unit_cost", None), _read_attr(item, "unit_cost", None))
        if uc is not None:
            unit_cost_map[sku] = max(0.0, _to_float(uc, 0.0))
        pr = _first_non_none(_read_attr(item, "service_level_weight", None),
                             _read_attr(item, "priority_weight", None))
        if pr is not None:
            sku_priority_map[sku] = max(0.01, _to_float(pr, 1.0))
        for per_unit_map, attr_name in [(sku_volume_map, "volume_per_unit"), (sku_weight_map, "weight_per_unit")]:
            wv = _first_non_none(_read_attr(item, attr_name, None), _read_attr(ic, attr_name, None))
            if wv is not None:
                per_unit_map[sku] = max(0.0, _to_float(wv, 0.0))

        # V2 Feature 1: Parse suppliers for multi-supplier optimization
        for sup in _as_list(_read_attr(item, "suppliers", None)):
            sup_id = str(_read_attr(sup, "supplier_id", "") or "").strip()
            if not sup_id:
                continue
            _sf = lambda a, d=0.0: max(0.0, _to_float(_read_attr(sup, a, d), d))  # noqa: E731
            suppliers_by_key.setdefault(_key(sku, item_plant), []).append(SupplierInfo(
                supplier_id=sup_id, lead_time_days=max(0, int(round(_sf("lead_time_days")))),
                unit_cost=_sf("unit_cost"), moq_s=_s(_sf("moq")), pack_s=_s(_sf("pack_size")),
                max_order_qty_s=_s(_sf("max_order_qty")), fixed_order_cost=_sf("fixed_order_cost"),
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
        raw_series = forecast_by_key[key]
        raw_p10 = p10_by_key.get(key, [])
        first_day = raw_series[0][0]
        last_allowed = first_day + timedelta(days=horizon_days - 1)
        series = [(d, p50, p90) for d, p50, p90 in raw_series if d <= last_allowed]
        p10_series = [raw_p10[i] for i, (d, _, _) in enumerate(raw_series) if d <= last_allowed]
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
        # Phase 3 – P3.2/P3.3: Demand basis selection
        #   use_p10_demand_model → optimistic lower-bound (reduces excess stock)
        #   use_p90_demand_model → conservative upper-bound (robust, avoids stockouts)
        #   default (p50)        → expected-value planning
        if use_p10_demand_model and p10_series:
            demand_s_list = [
                (p10 if p10 is not None else p50)
                for (_, p50, _), p10 in zip(series, p10_series)
            ]
        elif use_p90_demand_model:
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

    # V2 Feature 5: Volume/weight-based inventory capacity (unified builder)
    def _add_weighted_inv_cap(raw: Any, per_unit_map: Dict[str, float], tag_prefix: str, desc: str) -> Dict[date, int]:
        cap_dict: Dict[date, int] = {}
        if raw is None or not per_unit_map:
            return cap_dict
        for idx, day in enumerate(all_days):
            cap = _capacity_for_period(raw, idx, day)
            if cap is None:
                continue
            cap_s2 = int(round(cap * SCALE * SCALE))
            terms: List[Any] = []
            for k2 in ordered_keys:
                if k2 not in sku_var_maps:
                    continue
                w = per_unit_map.get(k2[0], 0.0)
                if w <= 0.0:
                    continue
                w_coeff = max(0, int(round(w * SCALE)))
                m2 = sku_meta[k2]
                for t_idx, d in enumerate(m2["days"]):
                    if d == day:
                        terms.append(w_coeff * sku_var_maps[k2]["inv"][t_idx])
            if terms:
                model.Add(sum(terms) <= cap_s2)
                cap_dict[day] = cap_s2
                _tag(f"{tag_prefix}[{day.isoformat()}]", desc, scope="period", period=day.isoformat())
        return cap_dict

    volume_cap_by_day_s = _add_weighted_inv_cap(volume_cap_raw, sku_volume_map, "CAP_VOL", "Volume-based inventory capacity.")
    weight_cap_by_day_s = _add_weighted_inv_cap(weight_cap_raw, sku_weight_map, "CAP_WEIGHT", "Weight-based inventory capacity.")

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
        return _build_infeasible_response_single(
            t0=t0, status_info=status_info, solver_settings=solver_settings,
            solve_time_ms=solve_time_ms, constraint_tags=constraint_tags,
            diagnose_mode=diagnose_mode, internal_diagnose=internal_diagnose,
            payload=payload, production_cap_by_day_s=production_cap_by_day_s,
            inventory_cap_by_day_s=inventory_cap_by_day_s,
            budget_cap=budget_cap, service_level_target=service_level_target,
        )

    _pv = _extract_plan_verify_single(ordered_keys, sku_var_maps, sku_meta, solver, moq_s, pack_s, maxq_s, unit_cost_map)
    plan_rows, total_order_qty, total_spend = _pv["plan_rows"], _pv["total_order_qty"], _pv["total_spend"]
    total_stockout, total_holding, total_demand = _pv["total_stockout"], _pv["total_holding"], _pv["total_demand"]
    end_backlog_total = _pv["end_backlog_total"]
    nonneg_failed, moq_failed, pack_failed, max_failed = _pv["nonneg_failed"], _pv["moq_failed"], _pv["pack_failed"], _pv["max_failed"]
    ss_violations, total_ss_violation_periods = _pv["ss_violations"], _pv["total_ss_violation_periods"]
    infeasible_reasons: List[str] = []
    infeasible_reasons_detailed: List[Dict[str, Any]] = []

    # Per-period budget verification
    budget_pp_usage_by_day: Dict[date, float] = {}
    budget_pp_failed = 0
    if budget_per_period_cap_s:
        budget_pp_usage_by_day, budget_pp_failed = _verify_budget_pp_single(
            budget_per_period_cap_s, budget_per_period_mode, ordered_keys,
            sku_var_maps, sku_meta, unit_cost_map, order_vars_by_day, solver)

    # Volume/weight verification
    def _verify_weighted_cap(cap_dict: Dict[date, int], per_unit_map: Dict[str, float]) -> Tuple[Dict[date, float], int]:
        usage: Dict[date, float] = {}
        failed = 0
        for day in sorted(cap_dict.keys()):
            used_s2 = sum(
                max(0, int(round(per_unit_map.get(k2[0], 0.0) * SCALE))) * int(solver.Value(sku_var_maps[k2]["inv"][t_idx]))
                for k2 in ordered_keys if k2 in sku_var_maps
                for t_idx, d in enumerate(sku_meta[k2]["days"]) if d == day and per_unit_map.get(k2[0], 0.0) > 0.0)
            usage[day] = used_s2 / (SCALE * SCALE) if SCALE else 0.0
            if used_s2 > cap_dict[day] + 1: failed += 1
        return usage, failed

    volume_usage_by_day, volume_failed = _verify_weighted_cap(volume_cap_by_day_s, sku_volume_map) if volume_cap_by_day_s else ({}, 0)
    weight_usage_by_day, weight_failed = _verify_weighted_cap(weight_cap_by_day_s, sku_weight_map) if weight_cap_by_day_s else ({}, 0)

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

    prod_min_slack, prod_binding, prod_nl = _compute_capacity_binding(
        production_cap_by_day_s, production_usage_s_by_day, "Production capacity")
    inv_min_slack, inv_binding, inv_nl = _compute_capacity_binding(
        inventory_cap_by_day_s, inventory_usage_s_by_day, "Inventory capacity")
    _pp_div = (SCALE * SCALE) if budget_per_period_mode == "spend" else 1
    budget_pp_min_slack, budget_pp_binding, budget_pp_nl = _compute_capacity_binding(
        budget_per_period_cap_s, budget_pp_usage_by_day, "Per-period budget",
        scale_divisor=_pp_div)
    vol_min_slack, vol_binding, vol_nl = _compute_capacity_binding(
        volume_cap_by_day_s, volume_usage_by_day, "Volume capacity",
        scale_divisor=SCALE * SCALE)
    wt_min_slack, wt_binding, wt_nl = _compute_capacity_binding(
        weight_cap_by_day_s, weight_usage_by_day, "Weight capacity",
        scale_divisor=SCALE * SCALE)

    # V2: Safety stock binding detection
    ss_binding = total_ss_violation_periods > 0
    ss_nl = f"Safety stock breached in {total_ss_violation_periods} SKU-periods." if ss_binding else None

    moq_binding = moq_failed > 0
    moq_nl = f"MOQ violations on {moq_failed} rows." if moq_binding else None

    constraints_checked = _build_base_constraint_checks(
        nonneg_failed, moq_failed, pack_failed, max_failed,
        budget_passed, budget_detail,
        budget_binding=budget_binding if budget_cap is not None else None,
        budget_slack=budget_slack, budget_slack_unit=budget_slack_unit, budget_nl=budget_nl,
        moq_binding=moq_binding, moq_nl=moq_nl,
    )
    # Capacity constraint checks (production, inventory, budget_pp, volume, weight)
    _cap_checks = [
        (production_cap_by_day_s, "shared_production_cap", "CAP_PROD", prod_failed,
         "Shared production/order capacity per period.", "units", prod_binding, prod_min_slack, prod_nl),
        (inventory_cap_by_day_s, "shared_inventory_cap", "CAP_INV", inv_failed,
         "Shared inventory capacity per period.", "units", inv_binding, inv_min_slack, inv_nl),
        (budget_per_period_cap_s, "budget_per_period", "BUDGET_PERIOD", budget_pp_failed,
         "Per-period budget cap.", "USD" if budget_per_period_mode == "spend" else "units",
         budget_pp_binding, budget_pp_min_slack, budget_pp_nl),
        (volume_cap_by_day_s, "volume_capacity", "CAP_VOL", volume_failed,
         "Volume-based inventory capacity per period.", "volume_units", vol_binding, vol_min_slack, vol_nl),
        (weight_cap_by_day_s, "weight_capacity", "CAP_WEIGHT", weight_failed,
         "Weight-based inventory capacity per period.", "weight_units", wt_binding, wt_min_slack, wt_nl),
    ]
    for cap_dict, cname, ctag, cfailed, cdesc, cunit, cbinding, cslack, cnl in _cap_checks:
        if cap_dict:
            ptags = [f"{ctag}[{day.isoformat()}]" for day in sorted(cap_dict.keys())]
            constraints_checked.append(_mk_constraint_check(
                name=cname, tag=ctag, passed=cfailed == 0,
                details=f"Periods violating {cname}: {cfailed}.",
                description=cdesc, scope="period", tags=ptags,
                binding=cbinding, slack=cslack, slack_unit=cunit, natural_language=cnl,
            ))
    if service_level_target is not None:
        constraints_checked.append(_mk_constraint_check(
            name="service_level_target", tag="SERVICE_LEVEL_GLOBAL",
            passed=service_target_passed, details=service_target_details,
            description="Hard end-of-horizon service-level target.",
        ))
    constraints_checked.append(_mk_constraint_check(
        name="safety_stock", tag="SAFETY_STOCK",
        passed=total_ss_violation_periods == 0,
        details=f"Safety stock violations across {total_ss_violation_periods} SKU-periods.",
        description="Soft safety stock floor on inventory.", severity="soft",
        scope="sku_period", binding=ss_binding, natural_language=ss_nl,
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

    status = _determine_final_status(status_info, constraints_checked)

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

    production_shared_kpi = _build_period_capacity_kpi(
        production_cap_by_day_s, production_usage_s_by_day)
    inventory_shared_kpi = _build_period_capacity_kpi(
        inventory_cap_by_day_s, inventory_usage_s_by_day)
    budget_pp_shared_kpi = _build_period_capacity_kpi(
        budget_per_period_cap_s, budget_pp_usage_by_day,
        scale_divisor=(SCALE * SCALE) if budget_per_period_mode == "spend" else 1,
        extra_fields={"mode": budget_per_period_mode or "quantity"})
    volume_shared_kpi = _build_period_capacity_kpi(
        volume_cap_by_day_s, volume_usage_by_day, scale_divisor=SCALE * SCALE)
    weight_shared_kpi = _build_period_capacity_kpi(
        weight_cap_by_day_s, weight_usage_by_day, scale_divisor=SCALE * SCALE)

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

    infeasibility_analysis, relaxation_analysis, relaxation_applied, diagnostics = \
        _build_proof_and_diagnostics(
            infeasible_reasons_detailed, diagnose_mode, internal_diagnose, payload)

    _obj_terms = [
        {"name": "ordered_units", "value": round(total_order_qty, 6),
         "note": "Total planned replenishment quantity.", "units": "units", "business_label": "Procurement volume"},
        {"name": "stockout_units", "value": round(total_stockout, 6),
         "note": "Projected unmet demand units (backlog).", "units": "units", "business_label": "Shortage exposure",
         "qty_driver": round(total_stockout, 6),
         "unit_cost_driver": round(stockout_penalty, 6) if stockout_penalty else None},
        {"name": "holding_units", "value": round(total_holding, 6),
         "note": "Projected positive inventory accumulation.", "units": "units", "business_label": "Inventory holding",
         "qty_driver": round(total_holding, 6),
         "unit_cost_driver": round(holding_cost, 6) if holding_cost else None},
        {"name": "estimated_total_cost", "value": round(est_cost, 6),
         "note": "ordering_qty + stockout_penalty * backlog + holding_cost * inventory.",
         "units": "cost_units", "business_label": "Total plan cost"},
    ]

    return finalize_planning_response({
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
                status=status, termination_reason=status_info.termination_reason,
                status_name=status_info.status_name,
                has_feasible_solution=True, time_limit_hit=status_info.time_limit_hit),
            settings=solver_settings, solve_time_ms=solve_time_ms,
            objective_value=obj_real, best_bound=bound_real, gap=gap,
            extra={
                "deterministic_mode": bool(solver_settings.deterministic_mode),
                "uncertainty_bridge": {
                    "safety_stock_alpha": round(safety_stock_alpha, 6),
                    "use_p90_for_safety_stock": bool(use_p90_for_safety_stock),
                    "use_p90_for_service_level": bool(use_p90_for_service_level),
                    "use_p90_demand_model": bool(use_p90_demand_model),
                    "use_p10_demand_model": bool(use_p10_demand_model),
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
            "objective_terms": _obj_terms,
            "constraints_checked": constraints_checked,
            "constraint_tags": constraint_tags,
            "infeasibility_analysis": infeasibility_analysis,
            "relaxation_analysis": relaxation_analysis,
            "diagnose_mode": bool(diagnose_mode),
        },
        "explain_summary": _build_explain_summary(
            status=status, constraints_checked=constraints_checked, objective_terms=[],
            total_stockout=total_stockout, stockout_penalty=stockout_penalty,
            total_spend=total_spend, budget_cap=budget_cap,
            budget_mode_effective=budget_mode_effective),
    }, default_engine="cp_sat", default_status=status)


# ── multi-echelon solver (extracted to solver_multi.py) ────────────────────────
from ml.api.solver_multi import solve_replenishment_multi_echelon  # noqa: E402
