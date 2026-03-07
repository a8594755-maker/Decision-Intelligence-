"""
Sensitivity analysis, shadow prices, relaxation analysis, and constraint
checking helpers for the replenishment solver.

Extracted from replenishment_solver.py to keep modules under ~2 000 lines.
"""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Set, Tuple

from ml.api.solver_utils import (
    SCALE, OBJ_SCALE, DIAGNOSE_SOLVER_SECONDS,
    SolverRunSettings, SupplierInfo,
    _read_attr, _as_list, _read_path, _to_bool, _to_float,
    _payload_to_plain, _plain_to_ns, _clone_payload, _set_path,
    _first_non_none, _as_dict,
    _s, _us, _parse_day, _key, _build_qty_map,
)
from ml.api.planning_contract import PlanningStatus, normalize_status

try:
    from ortools.linear_solver import pywraplp as _pywraplp

    _ORTOOLS_LINEAR_OK = True
except ImportError:
    _pywraplp = None  # type: ignore[assignment]
    _ORTOOLS_LINEAR_OK = False


# ── constraint check builder ──────────────────────────────────────────────────

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


# ── infeasibility categorisation ──────────────────────────────────────────────

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


# ── shadow price helpers ──────────────────────────────────────────────────────

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


# ── LP dual shadow prices ────────────────────────────────────────────────────

def _compute_shadow_prices_lp_dual(
    payload: Any,
    constraints_checked_list: List[Dict[str, Any]],
) -> Dict[str, Dict[str, Any]]:
    """
    Compute exact shadow prices from LP relaxation duals.

    We rebuild a continuous relaxation of the single-echelon model and read
    dual values from GLOP, then map them back to business constraints.
    """
    # Import here to avoid pulling heavy helpers into the top-level namespace.
    from ml.api.solver_capacity import _capacity_for_period, _capacity_input_is_scalar

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


# ── parametric perturbation fallback ──────────────────────────────────────────

def _compute_shadow_prices_parametric(
    payload: Any,
    constraints_checked_list: List[Dict[str, Any]],
) -> Dict[str, Dict[str, Any]]:
    """
    Fallback: approximate shadow prices via parametric perturbation.
    Kept for environments where LP dual extraction is unavailable.
    """
    # Lazy import to avoid circular dependency.
    from ml.api.replenishment_solver import solve_replenishment

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


# ── combined shadow price computation ─────────────────────────────────────────

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


# ── relaxation analysis ──────────────────────────────────────────────────────

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
    # Lazy import to avoid circular dependency.
    from ml.api.replenishment_solver import solve_replenishment

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


# ── explain summary builder ──────────────────────────────────────────────────

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


# ── local helper (duplicated from replenishment_solver to avoid circular import) ──

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
