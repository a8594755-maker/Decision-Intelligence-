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

import math
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

try:
    from ortools.sat.python import cp_model as _cp_model

    _ORTOOLS_OK = True
except ImportError:
    _cp_model = None  # type: ignore[assignment]
    _ORTOOLS_OK = False

# ── scaling constants ──────────────────────────────────────────────────────────
# All float quantities are multiplied by SCALE and rounded to integers for CP-SAT.
# 1 real unit = SCALE integer units  →  precision = 1/SCALE = 0.001 real units.
SCALE: int = 1_000

# Objective coefficients are also scaled (penalties may be floats like 2.5).
# true_cost ≈ integer_objective / (OBJ_SCALE * SCALE)
OBJ_SCALE: int = 1_000

MAX_SOLVER_SECONDS: float = 30.0


# ── public API ─────────────────────────────────────────────────────────────────

def ortools_available() -> bool:
    """Return True if OR-Tools is importable."""
    return _ORTOOLS_OK


def solve_replenishment(payload: Any) -> Dict[str, Any]:
    """
    Solve a replenishment plan using OR-Tools CP-SAT.

    Parameters
    ----------
    payload : ReplenishmentPlanRequest  (pydantic model from main.py)

    Returns
    -------
    dict  – same schema as ``_deterministic_replenishment_plan`` in main.py:
        status, plan, kpis, solver_meta, infeasible_reasons, proof
    """
    if not _ORTOOLS_OK:
        raise RuntimeError("ortools is not installed; cannot use CP-SAT solver")

    t0 = datetime.utcnow()
    model = _cp_model.CpModel()

    # ── objective parameters ──────────────────────────────────────────────────
    stockout_penalty = max(0.0, _to_float(payload.objective.stockout_penalty, 1.0))
    holding_cost = max(0.0, _to_float(payload.objective.holding_cost, 0.0))

    # Integer objective coefficients (quantities are in SCALE units, costs in OBJ_SCALE)
    coeff_order = OBJ_SCALE                                    # cost = 1.0 per real unit
    coeff_stockout = int(round(stockout_penalty * OBJ_SCALE))  # stockout_penalty per unit
    coeff_holding = int(round(holding_cost * OBJ_SCALE))       # holding_cost per unit

    # ── constraint maps ───────────────────────────────────────────────────────
    moq_s: Dict[str, int] = _build_qty_map(payload.constraints.moq, "min_qty")
    pack_s: Dict[str, int] = _build_qty_map(payload.constraints.pack_size, "pack_qty")
    maxq_s: Dict[str, int] = _build_qty_map(payload.constraints.max_order_qty, "max_qty")
    budget_cap_s: Optional[int] = None
    if payload.constraints.budget_cap is not None:
        budget_cap_s = _s(max(0.0, _to_float(payload.constraints.budget_cap, 0.0)))

    # ── parse demand forecast ─────────────────────────────────────────────────
    forecast_by_key: Dict[Tuple[str, str], List[Tuple[date, int, Optional[int]]]] = {}
    for pt in payload.demand_forecast.series or []:
        sku = str(pt.sku or "").strip()
        if not sku:
            continue
        d = _parse_day(pt.date)
        if not d:
            continue
        key = _key(pt.sku, pt.plant_id)
        p50_s = _s(max(0.0, _to_float(pt.p50, 0.0)))
        p90_s = _s(max(0.0, _to_float(pt.p90, 0.0))) if pt.p90 is not None else None
        forecast_by_key.setdefault(key, []).append((d, p50_s, p90_s))

    if not forecast_by_key:
        return _empty_response(t0, "infeasible",
                               ["No valid demand_forecast.series rows with SKU/date/p50 were provided."])

    for k in forecast_by_key:
        forecast_by_key[k].sort(key=lambda r: r[0])

    # ── parse inventory seed ──────────────────────────────────────────────────
    inventory_seed: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for row in payload.inventory or []:
        key = _key(row.sku, row.plant_id)
        d = _parse_day(row.as_of_date)
        if not d:
            continue
        prev = inventory_seed.get(key)
        if not prev or d > prev["as_of_date"]:
            inventory_seed[key] = {
                "as_of_date": d,
                "on_hand_s": _s(max(0.0, _to_float(row.on_hand, 0.0))),
                "safety_stock_s": _s(max(0.0, _to_float(row.safety_stock, 0.0)))
                    if row.safety_stock is not None else 0,
                "lead_time_days": max(0, int(round(_to_float(row.lead_time_days, 0.0))))
                    if row.lead_time_days is not None else 0,
            }

    # ── parse open POs ────────────────────────────────────────────────────────
    open_po_by_key: Dict[Tuple[str, str], Dict[date, int]] = {}
    for po in payload.open_pos or []:
        d = _parse_day(po.eta_date)
        if not d:
            continue
        key = _key(po.sku, po.plant_id)
        qty_s = _s(max(0.0, _to_float(po.qty, 0.0)))
        cal = open_po_by_key.setdefault(key, {})
        cal[d] = cal.get(d, 0) + qty_s

    # ── build CP-SAT model ────────────────────────────────────────────────────
    horizon_days = max(1, int(payload.planning_horizon_days or 1))
    ordered_keys = sorted(forecast_by_key.keys())

    # Accumulate per-SKU variable references for post-solve extraction.
    sku_var_maps: Dict[Tuple[str, str], Dict[str, Any]] = {}
    sku_meta: Dict[Tuple[str, str], Dict[str, Any]] = {}

    # Lists for budget constraint and objective.
    all_order_vars: List[Any] = []
    obj_order_vars: List[Any] = []
    obj_back_vars: List[Any] = []
    obj_inv_vars: List[Any] = []

    for key in ordered_keys:
        sku, plant_id = key
        series = forecast_by_key[key]
        first_day = series[0][0]
        last_allowed = first_day + timedelta(days=horizon_days - 1)
        series = [(d, p50, p90) for d, p50, p90 in series if d <= last_allowed]
        if not series:
            continue

        seed = inventory_seed.get(key, {"on_hand_s": 0, "safety_stock_s": 0, "lead_time_days": 0})
        on_hand_s: int = seed["on_hand_s"]
        lead_time: int = seed["lead_time_days"]
        open_po_cal: Dict[date, int] = open_po_by_key.get(key, {})

        T = len(series)
        days_list: List[date] = [d for d, _, _ in series]
        demand_s_list: List[int] = [p50 for _, p50, _ in series]

        total_demand_s = sum(demand_s_list)
        sku_moq_s = moq_s.get(sku, 0)
        sku_pack_s = pack_s.get(sku, 0)
        sku_max_s = maxq_s.get(sku, 0)

        # Safe upper bounds for variable domains.
        # order[t]: at most enough to satisfy all remaining demand from t onwards.
        ub_order = max(total_demand_s, sku_moq_s if sku_moq_s else 1, on_hand_s + 1)
        if sku_max_s > 0:
            ub_order = min(ub_order, sku_max_s)
        ub_order = max(ub_order, SCALE)  # at least 1 real unit always possible

        # inv[t]: can't exceed initial stock + everything ever ordered.
        ub_inv = on_hand_s + ub_order * T + 1
        # back[t]: can't exceed total demand.
        ub_back = total_demand_s + 1

        # ── CP-SAT decision variables ─────────────────────────────────────────
        tag = f"{sku}_{plant_id}"
        order_vars = [model.NewIntVar(0, ub_order, f"ord_{tag}_{t}") for t in range(T)]
        inv_vars = [model.NewIntVar(0, ub_inv, f"inv_{tag}_{t}") for t in range(T)]
        back_vars = [model.NewIntVar(0, ub_back, f"back_{tag}_{t}") for t in range(T)]
        y_vars = [model.NewBoolVar(f"y_{tag}_{t}") for t in range(T)]

        # Pack-size multiple variables (only when pack_size > 1.0 real unit).
        k_vars: Optional[List[Any]] = None
        if sku_pack_s > SCALE:  # pack_size > 1.0 real unit
            max_k = ub_order // sku_pack_s + 2
            k_vars = [model.NewIntVar(0, int(max_k), f"k_{tag}_{t}") for t in range(T)]

        # ── per-period constraints ────────────────────────────────────────────
        for t in range(T):
            # Pack-size: order[t] = k[t] * pack_size_s  (linear, pack_size is constant)
            if k_vars is not None:
                model.Add(order_vars[t] == k_vars[t] * sku_pack_s)

            # MOQ / binary order indicator.
            if sku_moq_s > 0:
                # When y[t]=1 → order[t] ≥ moq.
                # When y[t]=0 → order[t] = 0.
                model.Add(order_vars[t] >= sku_moq_s).OnlyEnforceIf(y_vars[t])
                model.Add(order_vars[t] == 0).OnlyEnforceIf(y_vars[t].Not())
            else:
                # No MOQ: y[t] is a pure indicator (order[t] > 0 ↔ y[t] = 1).
                model.Add(order_vars[t] == 0).OnlyEnforceIf(y_vars[t].Not())
                model.Add(order_vars[t] >= 1).OnlyEnforceIf(y_vars[t])

            # Per-SKU maximum order quantity.
            if sku_max_s > 0:
                model.Add(order_vars[t] <= sku_max_s)

            # ── inventory balance ─────────────────────────────────────────────
            # Arriving from a new order placed lead_time periods ago (if within horizon).
            order_idx = t - lead_time

            # Open-PO arrivals on this day (constant).
            open_po_t: int = open_po_cal.get(days_list[t], 0)

            # Constant RHS of the balance equation.
            if t == 0:
                const_rhs = on_hand_s + open_po_t - demand_s_list[t]
            else:
                const_rhs = open_po_t - demand_s_list[t]

            # Build LHS: inv[t] - back[t] - arriving_from_new[t]
            #            - (inv[t-1] - back[t-1])  [when t > 0]
            # All rearranged so that variable terms are on the left, constants on right.
            lhs = inv_vars[t] - back_vars[t]

            if order_idx >= 0:
                lhs = lhs - order_vars[order_idx]  # arriving new order (constant coeff -1)

            if t > 0:
                lhs = lhs - inv_vars[t - 1] + back_vars[t - 1]

            model.Add(lhs == const_rhs)

        # Accumulate for objective and budget.
        all_order_vars.extend(order_vars)
        obj_order_vars.extend(order_vars)
        obj_back_vars.extend(back_vars)
        obj_inv_vars.extend(inv_vars)

        sku_var_maps[key] = {"order": order_vars, "inv": inv_vars, "back": back_vars, "y": y_vars, "k": k_vars}
        sku_meta[key] = {"series": series, "days": days_list, "demand_s": demand_s_list, "lead_time": lead_time}

    if not sku_var_maps:
        return _empty_response(t0, "infeasible", ["No valid SKU/plant data could be planned."])

    # ── global budget constraint ──────────────────────────────────────────────
    if budget_cap_s is not None and all_order_vars:
        model.Add(sum(all_order_vars) <= budget_cap_s)

    # ── objective ─────────────────────────────────────────────────────────────
    # Minimise: Σ [ coeff_order * order + coeff_stockout * back + coeff_holding * inv ]
    # All quantities already in SCALE units; dividing by OBJ_SCALE*SCALE recovers real cost.
    obj_terms: List[Any] = (
        [coeff_order * v for v in obj_order_vars]
        + [coeff_stockout * v for v in obj_back_vars]
        + [coeff_holding * v for v in obj_inv_vars]
    )
    if obj_terms:
        model.Minimize(sum(obj_terms))

    # ── solve ─────────────────────────────────────────────────────────────────
    solver = _cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = MAX_SOLVER_SECONDS
    solver.parameters.num_search_workers = 4

    cp_status = solver.Solve(model)
    solve_time_ms = int((datetime.utcnow() - t0).total_seconds() * 1000)
    status_name = solver.StatusName(cp_status)

    if cp_status not in (_cp_model.OPTIMAL, _cp_model.FEASIBLE):
        return _empty_response(
            t0, "infeasible",
            [f"CP-SAT solver returned status '{status_name}'. No feasible plan found within {MAX_SOLVER_SECONDS}s."],
            solve_time_ms=solve_time_ms,
        )

    # ── extract plan rows ─────────────────────────────────────────────────────
    plan_rows: List[Dict[str, Any]] = []
    total_order_qty = 0.0
    total_stockout = 0.0
    total_holding = 0.0
    total_demand = 0.0
    infeasible_reasons: List[str] = []

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

        for t in range(len(days_list)):
            order_val_s = solver.Value(vars_["order"][t])
            inv_val_s = solver.Value(vars_["inv"][t])
            back_val_s = solver.Value(vars_["back"][t])

            total_demand += _us(demand_s_list[t])
            total_stockout += _us(back_val_s)
            total_holding += _us(inv_val_s)

            if order_val_s > 0:
                order_qty = _us(order_val_s)
                # order placed on days_list[t], arrives lead_time days later
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

                # Proof checks (floating-point tolerance).
                if order_qty < -1e-9:
                    nonneg_failed += 1
                if sku_moq_s > 0 and order_val_s < sku_moq_s - 1:
                    moq_failed += 1
                if sku_pack_s_val > SCALE and order_val_s % sku_pack_s_val > 1:
                    pack_failed += 1
                if sku_max_s_val > 0 and order_val_s > sku_max_s_val + 1:
                    max_failed += 1

    # ── KPIs ──────────────────────────────────────────────────────────────────
    service_level: Optional[float] = None
    if total_demand > 0.0:
        service_level = max(0.0, min(1.0, 1.0 - total_stockout / total_demand))

    est_cost = total_order_qty + stockout_penalty * total_stockout + holding_cost * total_holding

    # ── constraint proof ──────────────────────────────────────────────────────
    budget_cap_float = (
        _to_float(payload.constraints.budget_cap, 0.0)
        if payload.constraints.budget_cap is not None
        else None
    )
    budget_passed = True
    budget_detail = "No budget cap provided."
    if budget_cap_float is not None:
        budget_passed = total_order_qty <= budget_cap_float + 1e-9
        budget_detail = (
            f"Total ordered qty {round(total_order_qty, 6)} vs cap {round(budget_cap_float, 6)}."
        )
        if not budget_passed:
            infeasible_reasons.append("Total planned quantity exceeds configured budget cap.")

    constraints_checked = [
        {"name": "order_qty_non_negative", "passed": nonneg_failed == 0,
         "details": f"Negative quantity rows: {nonneg_failed}."},
        {"name": "moq", "passed": moq_failed == 0,
         "details": f"Rows violating MOQ: {moq_failed}."},
        {"name": "pack_size_multiple", "passed": pack_failed == 0,
         "details": f"Rows violating pack-size multiple: {pack_failed}."},
        {"name": "budget_cap", "passed": budget_passed, "details": budget_detail},
        {"name": "max_order_qty", "passed": max_failed == 0,
         "details": f"Rows violating max_order_qty: {max_failed}."},
    ]
    all_passed = all(c["passed"] for c in constraints_checked)

    # Status: trust the CP-SAT solver (OPTIMAL/FEASIBLE were already verified above).
    # Zero orders with ample initial stock is a valid optimal plan — do NOT flag as infeasible.
    if not all_passed or infeasible_reasons:
        status = "feasible"
    elif cp_status == _cp_model.OPTIMAL:
        status = "optimal"
    else:
        status = "feasible"

    # Relative optimality gap (0.0 when OPTIMAL).
    obj_int = solver.ObjectiveValue()
    bound_int = solver.BestObjectiveBound()
    gap = abs(obj_int - bound_int) / max(abs(obj_int), 1.0) if cp_status == _cp_model.FEASIBLE else 0.0

    return {
        "status": status,
        "plan": plan_rows,
        "kpis": {
            "estimated_service_level": None if service_level is None else round(service_level, 6),
            "estimated_stockout_units": round(total_stockout, 6),
            "estimated_holding_units": round(total_holding, 6),
            "estimated_total_cost": round(est_cost, 6),
        },
        "solver_meta": {
            "solver": "cp_sat",
            "solve_time_ms": solve_time_ms,
            "objective_value": round(obj_int / (OBJ_SCALE * SCALE), 6),
            "gap": round(gap, 6),
        },
        "infeasible_reasons": sorted(set(infeasible_reasons)),
        "proof": {
            "objective_terms": [
                {"name": "ordered_units", "value": round(total_order_qty, 6),
                 "note": "Total planned replenishment quantity."},
                {"name": "stockout_units", "value": round(total_stockout, 6),
                 "note": "Projected unmet demand units (backlog)."},
                {"name": "holding_units", "value": round(total_holding, 6),
                 "note": "Projected positive inventory accumulation."},
                {"name": "estimated_total_cost", "value": round(est_cost, 6),
                 "note": "ordering_qty + stockout_penalty × backlog + holding_cost × inventory."},
            ],
            "constraints_checked": constraints_checked,
        },
    }


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
        sku = str(row.sku or "").strip()
        if not sku:
            continue
        v = getattr(row, attr, None)
        if v is None:
            continue
        out[sku] = _s(max(0.0, _to_float(v, 0.0)))
    return out


def _empty_response(
    t0: datetime,
    status: str,
    reasons: List[str],
    solve_time_ms: Optional[int] = None,
) -> Dict[str, Any]:
    if solve_time_ms is None:
        solve_time_ms = int((datetime.utcnow() - t0).total_seconds() * 1000)
    return {
        "status": status,
        "plan": [],
        "kpis": {
            "estimated_service_level": None,
            "estimated_stockout_units": None,
            "estimated_holding_units": None,
            "estimated_total_cost": None,
        },
        "solver_meta": {
            "solver": "cp_sat",
            "solve_time_ms": solve_time_ms,
            "objective_value": None,
            "gap": None,
        },
        "infeasible_reasons": reasons,
        "proof": {"objective_terms": [], "constraints_checked": []},
    }


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
        sku = str(getattr(row, "sku", None) or "").strip()
        if not sku:
            continue
        v = getattr(row, attr, None)
        if v is None:
            continue
        out[sku] = max(0.0, _to_float(v, 0.0))
    return out


def _build_unit_cost_map_me(rows: Any) -> Dict[str, float]:
    """Return {sku: unit_cost_float} from a list of unit-cost constraint rows."""
    out: Dict[str, float] = {}
    for row in rows or []:
        sku = str(getattr(row, "sku", None) or "").strip()
        if not sku:
            continue
        v = getattr(row, "unit_cost", None)
        if v is None:
            continue
        out[sku] = max(0.0, _to_float(v, 0.0))
    return out


def _empty_response_me(
    t0: datetime,
    status: str,
    reasons: List[str],
    solve_time_ms: Optional[int] = None,
) -> Dict[str, Any]:
    """Empty multi-echelon response (superset of single-echelon shape)."""
    if solve_time_ms is None:
        solve_time_ms = int((datetime.utcnow() - t0).total_seconds() * 1000)
    return {
        "status": status,
        "plan": [],
        "component_plan": [],
        "component_inventory_projection": {"total_rows": 0, "rows": [], "truncated": False},
        "bottlenecks": {
            "generated_at": datetime.utcnow().isoformat(),
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
        "solver_meta": {
            "solver": "cp_sat",
            "solve_time_ms": solve_time_ms,
            "objective_value": None,
            "gap": None,
            "multi_echelon_mode": "bom_v0",
        },
        "infeasible_reasons": reasons,
        "proof": {"objective_terms": [], "constraints_checked": []},
    }


# ── public multi-echelon API ───────────────────────────────────────────────────

def solve_replenishment_multi_echelon(payload: Any) -> Dict[str, Any]:
    """
    Solve a BOM-coupled multi-echelon replenishment plan using OR-Tools CP-SAT.

    Decision variables per (item i, period t):
      order[i,t]  – int ≥ 0 : units ordered/produced at period t
      inv[i,t]    – int ≥ 0 : on-hand inventory at end of period t
      back[i,t]   – int ≥ 0 : backlog at end of period t
      y[i,t]      – bool    : 1 when an order is placed (MOQ enforcement)

    FG balance:
      inv[fg,t] - back[fg,t] = inv[fg,t-1] - back[fg,t-1]
                               + arriving_fg[t] + open_po_fg[t]
                               - customer_demand[fg,t]

    Component balance (BOM coupling):
      qty_scale * (inv[c,t] - back[c,t]) =
          qty_scale * (inv[c,t-1] - back[c,t-1] + arriving_c[t] + open_po_c[t])
          - Σ_fg (usage[fg,c] * qty_scale) * prod_fg[t]

    Hard feasibility constraint (prevents over-consuming components):
      Σ_fg usage_scaled[fg,c] * prod_fg[t] <= qty_scale * (inv[c,t-1] + arriving_c[t])

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

    t0 = datetime.utcnow()
    qty_scale: int = 1_000   # quantities: 1 real unit = qty_scale integer units
    cost_scale: int = 100    # cost coefficients (different from OBJ_SCALE in single-echelon)

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
        return _empty_response_me(t0, "infeasible",
                                  ["No valid demand_forecast.series rows within horizon."])

    fg_keys = sorted(demand_rows_by_fg.keys(), key=lambda k: (k[0], k[1]))
    horizon_dates = sorted({d for rows in demand_rows_by_fg.values() for d, _ in rows})
    if not horizon_dates:
        return _empty_response_me(t0, "infeasible",
                                  ["No horizon dates could be derived from demand series."])

    period_days = _infer_period_days_me(horizon_dates)
    day_to_idx = {d: i for i, d in enumerate(horizon_dates)}
    n_periods = len(horizon_dates)

    # ── 2. parse BOM usage → (fg_key, comp_key) usage float map ──────────────
    usage_float: Dict[Tuple[Tuple[str, str], Tuple[str, str]], float] = {}
    component_to_fgs: Dict[Tuple[str, str], set] = {}

    for usage in payload.bom_usage or []:
        fg_sku = str(getattr(usage, "fg_sku", None) or "").strip()
        comp_sku = str(getattr(usage, "component_sku", None) or "").strip()
        usage_qty = max(0.0, _to_float(getattr(usage, "usage_qty", 0.0), 0.0))
        usage_plant = str(getattr(usage, "plant_id", None) or "").strip()
        if not fg_sku or not comp_sku or usage_qty <= 0.0:
            continue

        if usage_plant:
            cand_fg_keys = [_key(fg_sku, usage_plant)] if _key(fg_sku, usage_plant) in demand_rows_by_fg else []
        else:
            cand_fg_keys = [k for k in fg_keys if k[0] == fg_sku]

        for fg_key in cand_fg_keys:
            comp_plant = usage_plant or fg_key[1]
            comp_key = _key(comp_sku, comp_plant)
            pair = (fg_key, comp_key)
            usage_float[pair] = usage_float.get(pair, 0.0) + usage_qty
            component_to_fgs.setdefault(comp_key, set()).add(fg_key[0])

    component_keys = sorted(component_to_fgs.keys(), key=lambda k: (k[0], k[1]))
    if not component_keys:
        return _empty_response_me(
            t0, "infeasible",
            ["No valid BOM usage rows were provided; multi-echelon requires bom_usage."],
        )

    usage_scaled: Dict[Tuple[Tuple[str, str], Tuple[str, str]], int] = {
        pair: max(0, int(round(v * qty_scale))) for pair, v in usage_float.items()
    }

    item_keys = sorted(set(fg_keys + component_keys), key=lambda k: (k[0], k[1]))
    item_index = {k: i for i, k in enumerate(item_keys)}

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

    # ── 5. FG demand scaled ───────────────────────────────────────────────────
    demand_by_fg_idx_scaled: Dict[Tuple[str, str], Dict[int, int]] = {}
    for fg_key in fg_keys:
        demand_by_fg_idx_scaled[fg_key] = {}
        for d, qty in demand_rows_by_fg.get(fg_key, []):
            idx = day_to_idx[d]
            ds = int(round(max(0.0, qty) * qty_scale))
            demand_by_fg_idx_scaled[fg_key][idx] = demand_by_fg_idx_scaled[fg_key].get(idx, 0) + ds

    # ── 6. expected component demand (for upper-bound sizing) ─────────────────
    expected_comp_demand_scaled: Dict[Tuple[str, str], int] = {k: 0 for k in component_keys}
    for comp_key in component_keys:
        total = 0.0
        for fg_key in fg_keys:
            uq = usage_float.get((fg_key, comp_key), 0.0)
            if uq <= 0.0:
                continue
            total += uq * sum(q for _, q in demand_rows_by_fg.get(fg_key, []))
        expected_comp_demand_scaled[comp_key] = max(0, int(round(total * qty_scale)))

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
        comp_demand_s = expected_comp_demand_scaled.get(key, 0)
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

            # Pack-size multiple: order = pack * z.
            if use_lot and pack_s > qty_scale:
                z_ub = max(0, order_ub_by_key[key] // max(1, pack_s))
                z_var = model.NewIntVar(0, z_ub, f"pack_{item_idx}_{t}")
                model.Add(o_var == pack_s * z_var)

            # MOQ: o ≥ moq when ordered (y=1), o = 0 when not ordered (y=0).
            if use_lot and moq_s > 0:
                y_var = model.NewBoolVar(f"y_{item_idx}_{t}")
                model.Add(o_var <= order_ub_by_key[key] * y_var)
                model.Add(o_var >= moq_s * y_var)

    # ── 11. arrival helpers ───────────────────────────────────────────────────
    def _arrival(key: Tuple[str, str], t: int) -> Any:
        """Inbound at period t: open-PO constant + new order placed (t - lead_offset) periods ago."""
        open_s = int(round((open_pos_by_key_idx.get(key, {}).get(t, 0.0)) * qty_scale))
        src = t - lead_offsets.get(key, 0)
        if src >= 0:
            return open_s + order_vars[(key, src)]
        return open_s

    def _prod_fg(fg_key: Tuple[str, str], t: int) -> Any:
        """FG 'production' at period t: the FG order that arrives at t (placed t−lead ago)."""
        src = t - lead_offsets.get(fg_key, 0)
        if src >= 0:
            return order_vars[(fg_key, src)]
        return 0

    # ── 12. inventory balance constraints ─────────────────────────────────────
    for key in item_keys:
        for t in range(n_periods):
            prev_inv = inv_vars[(key, t - 1)] if t > 0 else initial_on_hand_scaled.get(key, 0)
            prev_back = back_vars[(key, t - 1)] if t > 0 else 0
            arrival = _arrival(key, t)

            if key in fg_keys:
                # FG balance: inv - back = prev_inv - prev_back + arrival - customer_demand
                demand_s = demand_by_fg_idx_scaled.get(key, {}).get(t, 0)
                model.Add(
                    inv_vars[(key, t)] - back_vars[(key, t)]
                    == prev_inv - prev_back + arrival - demand_s
                )
            else:
                # Component balance: scaled by qty_scale on both sides.
                # consumption = Σ_fg usage_scaled[fg,c] * prod_fg[t]
                consumption_terms = []
                for fg_key in fg_keys:
                    coeff = usage_scaled.get((fg_key, key), 0)
                    if coeff <= 0:
                        continue
                    pe = _prod_fg(fg_key, t)
                    if isinstance(pe, int) and pe == 0:
                        continue
                    consumption_terms.append(coeff * pe)

                consumption = sum(consumption_terms) if consumption_terms else 0

                # Balance (all terms multiplied by qty_scale to keep integer arithmetic exact).
                model.Add(
                    qty_scale * inv_vars[(key, t)] - qty_scale * back_vars[(key, t)]
                    == qty_scale * prev_inv - qty_scale * prev_back
                       + qty_scale * arrival - consumption
                )

                # Hard feasibility: cannot consume more than available.
                model.Add(consumption <= qty_scale * (prev_inv + arrival))

    # ── 13. global budget constraint ──────────────────────────────────────────
    if budget_cap_scaled is not None:
        model.Add(sum(order_vars.values()) <= budget_cap_scaled)

    # ── 14. optional capacity constraints ─────────────────────────────────────
    prod_cap_raw = getattr(payload.multi_echelon, "production_capacity_per_period", None)
    production_capacity = _to_float(prod_cap_raw, 0.0) if prod_cap_raw is not None else 0.0
    if production_capacity > 0.0:
        prod_cap_s = int(round(production_capacity * qty_scale))
        for t in range(n_periods):
            model.Add(sum(_prod_fg(fg_key, t) for fg_key in fg_keys) <= prod_cap_s)

    inv_cap_raw = getattr(payload.multi_echelon, "inventory_capacity_per_period", None)
    inventory_capacity = _to_float(inv_cap_raw, 0.0) if inv_cap_raw is not None else 0.0
    if inventory_capacity > 0.0:
        inv_cap_s = int(round(inventory_capacity * qty_scale))
        for t in range(n_periods):
            model.Add(sum(inv_vars[(key, t)] for key in item_keys) <= inv_cap_s)

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
    solver.parameters.num_search_workers = 1   # deterministic
    solver.parameters.random_seed = 0           # deterministic
    solver.parameters.max_time_in_seconds = 25.0
    solver.parameters.log_search_progress = False

    cp_status = solver.Solve(model)
    solve_time_ms = int((datetime.utcnow() - t0).total_seconds() * 1000)

    if cp_status not in (_cp_model.OPTIMAL, _cp_model.FEASIBLE):
        return {
            **_empty_response_me(t0, "infeasible",
                                 ["CP-SAT did not find a feasible BOM-aware plan "
                                  "under current constraints."],
                                 solve_time_ms=solve_time_ms),
            "proof": {
                "objective_terms": [],
                "constraints_checked": [
                    {"name": "bom_coupling", "passed": False,
                     "details": "No feasible solution found with hard BOM coupling constraints."},
                ],
            },
        }

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
            dep_demand = 0.0
            for fg_key in fg_keys:
                uq = usage_float.get((fg_key, comp_key), 0.0)
                if uq <= 0.0:
                    continue
                fg_src = t - lead_offsets.get(fg_key, 0)
                if fg_src < 0:
                    continue
                dep_demand += uq * (int(round(solver.Value(order_vars[(fg_key, fg_src)]))) / qty_scale)
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
    est_cost = obj_val / (qty_scale * cost_scale)

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
            for fg_key in fg_keys:
                coeff = usage_scaled.get((fg_key, comp_key), 0)
                if coeff <= 0:
                    continue
                pe = _prod_fg(fg_key, t)
                prod_s = int(round(solver.Value(pe))) if not isinstance(pe, int) else pe
                cons_s += coeff * prod_s
            if cons_s > qty_scale * (prev_inv_s + arrival_s) + 1:
                bom_coupling_failed += 1

    # ── 21. bottleneck diagnostics ────────────────────────────────────────────
    bottleneck_items: List[Dict[str, Any]] = []
    for comp_key in component_keys:
        comp_sku, comp_plant = comp_key
        required_cum = 0.0
        available_cum = initial_on_hand_scaled.get(comp_key, 0) / qty_scale
        max_deficit = 0.0
        periods_impacted: List[str] = []

        for t, day in enumerate(horizon_dates):
            req_today = sum(
                usage_float.get((fg_key, comp_key), 0.0)
                * (demand_by_fg_idx_scaled.get(fg_key, {}).get(t, 0) / qty_scale)
                for fg_key in fg_keys
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
        "generated_at": datetime.utcnow().isoformat(),
        "total_rows": len(bottleneck_items),
        "rows": bottleneck_items,
        "items": bottleneck_items,
    }

    # ── 22. infeasible_reasons ────────────────────────────────────────────────
    infeasible_reasons: List[str] = []
    if end_fg_backlog > 1e-9:
        infeasible_reasons.append(
            f"Unmet FG backlog remains at horizon end: {round(end_fg_backlog, 6)} units."
        )
    if bottleneck_items:
        infeasible_reasons.append(
            f"BOM bottlenecks detected: {len(bottleneck_items)} components constrained FG output."
        )

    constraints_checked = [
        {"name": "order_qty_non_negative", "passed": nonneg_failed == 0,
         "details": f"Negative quantity rows: {nonneg_failed}."},
        {"name": "moq", "passed": moq_failed == 0,
         "details": f"Rows violating MOQ: {moq_failed}."},
        {"name": "pack_size_multiple", "passed": pack_failed == 0,
         "details": f"Rows violating pack-size multiple: {pack_failed}."},
        {"name": "budget_cap", "passed": budget_passed, "details": budget_detail},
        {"name": "max_order_qty", "passed": max_failed == 0,
         "details": f"Rows violating max_order_qty: {max_failed}."},
        {"name": "bom_coupling", "passed": bom_coupling_failed == 0,
         "details": f"BOM coupling violations: {bom_coupling_failed}."},
        {"name": "component_feasibility", "passed": len(bottleneck_items) == 0,
         "details": f"Detected component bottlenecks: {len(bottleneck_items)}."},
    ]

    solve_status = "optimal" if cp_status == _cp_model.OPTIMAL else "feasible"

    me_meta = {
        "multi_echelon_mode": "bom_v0",
        "max_bom_depth": getattr(payload.multi_echelon, "max_bom_depth", None) or 50,
        "bom_explosion_used": bool(getattr(payload.multi_echelon, "bom_explosion_used", False)),
        "bom_explosion_reused": bool(getattr(payload.multi_echelon, "bom_explosion_reused", False)),
        "period_days": period_days,
        "qty_scale": qty_scale,
        "fg_count": len(fg_keys),
        "component_count": len(component_keys),
        "bom_shortages_impacted_fg": bool(bottleneck_items),
    }

    return {
        "status": solve_status,
        "plan": plan_rows,
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
        "solver_meta": {
            "solver": "cp_sat",
            "solve_time_ms": solve_time_ms,
            "objective_value": round(est_cost, 6),
            "gap": 0.0 if cp_status == _cp_model.OPTIMAL else None,
            **me_meta,
        },
        "infeasible_reasons": sorted(set(infeasible_reasons)),
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
        },
    }
