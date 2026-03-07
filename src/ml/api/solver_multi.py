"""
Multi-echelon (BOM-coupled) replenishment solver using OR-Tools CP-SAT.

Extracted from replenishment_solver.py. Contains:
  - solve_replenishment_multi_echelon()   (public API)
  - _infer_period_days_me()               (private helper)
  - _build_qty_map_me()                   (private helper)
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from ml.api.planning_contract import (
    PlanningStatus,
    finalize_planning_response,
)

try:
    from ortools.sat.python import cp_model as _cp_model
    _ORTOOLS_OK = True
except ImportError:
    _cp_model = None  # type: ignore[assignment]
    _ORTOOLS_OK = False

from ml.api.solver_utils import (
    SolverRunSettings, SolverStatusInfo,
    _read_attr, _to_bool, _to_float,
    _first_non_none, _read_path,
    _s, _parse_day, _key,
    DEFAULT_SOLVER_MULTI_TIME_LIMIT_SECONDS,
)
from ml.api.solver_capacity import (
    _resolve_capacity_for_multi, _capacity_for_day,
    _resolve_solver_run_settings, _apply_solver_run_settings,
    _solve_with_cancel_support, _did_time_limit_hit, _status_from_cp,
    _build_solver_meta,
)
from ml.api.solver_analysis import (
    _mk_constraint_check, _suggestions_for_categories,
    _summarize_infeasibility, _build_unit_cost_map_me,
)
from ml.api.solver_helpers import (
    _make_tag_collector, _determine_final_status,
    _build_proof_and_diagnostics, _build_base_constraint_checks,
    _propagate_bom_demand, _propagate_bom_demand_by_period,
    _empty_response,
)


# ── multi-echelon private helpers ──────────────────────────────────────────────

def _infer_period_days_me(sorted_dates: List[Any]) -> int:
    """Return the median gap (in days) between consecutive planning-horizon dates."""
    if len(sorted_dates) <= 1:
        return 1
    deltas = [int((sorted_dates[i] - sorted_dates[i - 1]).days)
              for i in range(1, len(sorted_dates))
              if int((sorted_dates[i] - sorted_dates[i - 1]).days) > 0]
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
        return _empty_response(
            t0,
            "TIMEOUT",
            ["Forced timeout via settings.solver.force_timeout=true."],
            settings=solver_settings,
            termination_reason="FORCED_TIMEOUT",
            status_name="FORCED_TIMEOUT",
            multi_echelon=True,
        )
    qty_scale: int = 1_000   # quantities: 1 real unit = qty_scale integer units
    cost_scale: int = 100    # cost coefficients (different from OBJ_SCALE in single-echelon)
    constraint_tags, _tag = _make_tag_collector("multi")

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
        return _empty_response(
            t0,
            "INFEASIBLE",
            ["No valid demand_forecast.series rows within horizon."],
            settings=solver_settings,
            termination_reason="INVALID_INPUT",
            multi_echelon=True,
        )

    fg_keys = sorted(demand_rows_by_fg.keys(), key=lambda k: (k[0], k[1]))
    horizon_dates = sorted({d for rows in demand_rows_by_fg.values() for d, _ in rows})
    if not horizon_dates:
        return _empty_response(
            t0,
            "INFEASIBLE",
            ["No horizon dates could be derived from demand series."],
            settings=solver_settings,
            termination_reason="INVALID_INPUT",
            multi_echelon=True,
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
        return _empty_response(
            t0,
            "INFEASIBLE",
            ["No valid BOM usage rows were provided; multi-echelon requires bom_usage."],
            settings=solver_settings,
            termination_reason="INVALID_INPUT",
            multi_echelon=True,
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
        return _empty_response(
            t0,
            "INFEASIBLE",
            [message],
            settings=solver_settings,
            termination_reason="INVALID_INPUT",
            multi_echelon=True,
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
    seed_need = {key: external_demand_float.get(key, 0.0) for key in item_keys}
    expected_total_need_float, demand_frontier, _ = _propagate_bom_demand(
        seed_need, children_by_parent, max_bom_depth)
    expected_internal_demand_scaled: Dict[Tuple[str, str], int] = {
        key: max(0, int(round(max(0.0, expected_total_need_float.get(key, 0.0) - external_demand_float.get(key, 0.0)) * qty_scale)))
        for key in item_keys
    }

    # Demand-by-period propagation for diagnostics/projection visibility.
    period_seed: Dict[Tuple[str, str], Dict[int, float]] = {}
    for fg_key in fg_keys:
        bucket: Dict[int, float] = {}
        for t, ds in demand_by_fg_idx_scaled.get(fg_key, {}).items():
            qty = max(0.0, ds / qty_scale)
            if qty > 0.0:
                bucket[t] = bucket.get(t, 0.0) + qty
        if bucket:
            period_seed[fg_key] = bucket
    # ensure all item_keys have entries
    for k in item_keys:
        period_seed.setdefault(k, {})
    expected_need_by_key_idx, period_frontier_trunc = _propagate_bom_demand_by_period(
        period_seed, children_by_parent, max_bom_depth)
    period_frontier = period_frontier_trunc  # for me_meta flag

    expected_dependent_need_by_key_idx: Dict[Tuple[str, str], Dict[int, float]] = {}
    for key in component_keys:
        tb = expected_need_by_key_idx.get(key, {})
        eb = demand_by_fg_idx_scaled.get(key, {})
        expected_dependent_need_by_key_idx[key] = {
            t: dep for t, total in tb.items()
            if (dep := max(0.0, total - (eb.get(t, 0) / qty_scale))) > 1e-12
        }

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
        checks: List[Dict[str, Any]] = [_mk_constraint_check(
            name="bom_coupling", tag="BOM_LINK", passed=False,
            details="No feasible solution found with hard BOM coupling constraints.",
            description="BOM-coupled flow feasibility.", echelon="multi")]
        for refs, cname, ctag in [
            (prod_capacity_refs, "production_capacity", "CAP_PROD"),
            (inv_capacity_refs_me, "inventory_capacity", "CAP_INV"),
        ]:
            if refs:
                reasons.append(f"{ctag}[*] constraints were active in this run.")
                suspected_tags.append(ctag)
                checks.append(_mk_constraint_check(
                    name=cname, tag=ctag, passed=False,
                    details=f"No feasible solution found with {ctag}[*] constraints enabled.",
                    description=f"Shared {cname.replace('_', ' ')} per period.",
                    scope="period", echelon="multi",
                    tags=sorted({f"{ctag}[{r['day'].isoformat()}]" for r in refs})))
        if service_level_target is not None:
            suspected_tags.append("SERVICE_LEVEL_GLOBAL")
            checks.append(_mk_constraint_check(
                name="service_level_target", tag="SERVICE_LEVEL_GLOBAL", passed=False,
                details="Hard service-level target may conflict with supply/capacity constraints.",
                description="Hard FG service-level target.", echelon="multi"))
        infeasibility_analysis = _summarize_infeasibility(suspected_tags)
        relaxation_analysis: List[Dict[str, Any]] = (
            [{"relaxed_tags": [t], "feasible_after_relaxation": None, "delta_cost_proxy": None}
             for t in sorted(set(suspected_tags))]
            if diagnose_mode and not internal_diagnose else [])
        base = _empty_response(
            t0, status_info.status.value, reasons, solve_time_ms=solve_time_ms,
            settings=solver_settings, termination_reason=status_info.termination_reason,
            status_name=status_info.status_name, multi_echelon=True)
        base["proof"] = {
            "objective_terms": [], "constraints_checked": checks,
            "constraint_tags": constraint_tags,
            "infeasibility_analysis": infeasibility_analysis,
            "relaxation_analysis": relaxation_analysis, "diagnose_mode": bool(diagnose_mode)}
        return finalize_planning_response(base, default_engine="cp_sat", default_status=status_info.status)

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

    def _check_me_cap(refs, tag_prefix, usage_fn):
        failed = binding = 0
        for ref in refs:
            used_s = usage_fn(ref)
            cap_s = int(ref["cap_s"])
            if used_s > cap_s + 1:
                failed += 1
            elif abs(used_s - cap_s) <= 1:
                binding += 1
        return failed, binding

    prod_cap_failed, prod_cap_binding = _check_me_cap(
        prod_capacity_refs, "CAP_PROD",
        lambda ref: sum(int(round(solver.Value(t))) if not isinstance(t, int) else int(t) for t in ref["expr_terms"]))
    inv_cap_failed, inv_cap_binding = _check_me_cap(
        inv_capacity_refs_me, "CAP_INV",
        lambda ref: sum(int(round(solver.Value(inv_vars[(k, int(ref["t"]))]))) for k in ref["keys"]))

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
    if end_fg_backlog > 1e-9 or bottleneck_items:
        for refs, ctag, clabel in [(inv_capacity_refs_me, "CAP_INV", "inventory"), (prod_capacity_refs, "CAP_PROD", "production")]:
            if refs:
                infeasible_reasons.append(f"{ctag}[*] constraints contributed to infeasibility.")
                infeasible_reasons_detailed.append({
                    "category": "capacity", "top_offending_tags": [ctag],
                    "suggested_actions": _suggestions_for_categories({"capacity"}),
                    "message": f"Shared {clabel} capacity is binding under current demand."})

    constraints_checked = _build_base_constraint_checks(
        nonneg_failed, moq_failed, pack_failed, max_failed,
        budget_passed, budget_detail, echelon="multi", item_label="item-period",
    )
    constraints_checked.extend([
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
    ])
    _me_cap_checks = [
        (prod_capacity_refs, "production_capacity", "CAP_PROD", prod_cap_failed,
         f"CAP_PROD checks={len(prod_capacity_refs)}, violations={prod_cap_failed}, binding={prod_cap_binding}."),
        (inv_capacity_refs_me, "inventory_capacity", "CAP_INV", inv_cap_failed,
         f"CAP_INV checks={len(inv_capacity_refs_me)}, violations={inv_cap_failed}, binding={inv_cap_binding}."),
    ]
    for refs, cname, ctag, cfailed, cdetails in _me_cap_checks:
        if refs:
            ptags = sorted({f"{ctag}[{ref['day'].isoformat()}]" for ref in refs})
            constraints_checked.append(_mk_constraint_check(
                name=cname, tag=ctag, passed=cfailed == 0, details=cdetails,
                description=f"Shared {cname.replace('_', ' ')} per period.",
                scope="period", echelon="multi", tags=ptags,
            ))
    if service_level_target is not None:
        allowed_backlog_f = (service_level_allowed_fg_backlog_s or 0) / qty_scale
        constraints_checked.append(_mk_constraint_check(
            name="service_level_target", tag="SERVICE_LEVEL_GLOBAL",
            passed=end_fg_backlog <= allowed_backlog_f + 1e-9,
            details=f"End FG backlog {round(end_fg_backlog, 6)} vs allowed {round(allowed_backlog_f, 6)}.",
            description="Hard FG service-level target.", echelon="multi",
        ))
    solve_status = _determine_final_status(status_info, constraints_checked)

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

    me_infeas_analysis, me_relax_analysis, _, _ = _build_proof_and_diagnostics(
        infeasible_reasons_detailed, diagnose_mode, internal_diagnose, payload,
        multi_echelon=True, infeasible_reasons=infeasible_reasons)
    _me_proof_block = {
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
        "infeasibility_analysis": me_infeas_analysis,
        "relaxation_analysis": me_relax_analysis,
        "diagnose_mode": bool(diagnose_mode),
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
            "proof": _me_proof_block,
        },
        default_engine="cp_sat",
        default_status=solve_status,

    )
