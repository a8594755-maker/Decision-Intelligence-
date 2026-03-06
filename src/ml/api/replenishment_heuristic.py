"""Deterministic heuristic replenishment planner normalized to Planning API contract v1."""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from ml.api.planning_contract import PlanningStatus, finalize_planning_response


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


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except Exception:
        return default
    if math.isnan(number) or math.isinf(number):
        return default
    return number


def _to_int(value: Any, default: int) -> int:
    try:
        parsed = int(round(float(value)))
    except Exception:
        return default
    return parsed


def _parse_iso_day(value: Any) -> Optional[date]:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        return datetime.strptime(raw[:10], "%Y-%m-%d").date()
    except Exception:
        return None


def _key_of(sku: Any, plant_id: Any) -> Tuple[str, str]:
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


def _lookup_keyed_value(mapping: Dict[Tuple[str, str], Any], key: Tuple[str, str]) -> Optional[Any]:
    if key in mapping:
        return mapping[key]
    sku, plant = key
    if plant and (sku, "") in mapping:
        return mapping[(sku, "")]
    return None


def _build_sku_lookup(rows: Any, value_key: str) -> Dict[str, float]:
    lookup: Dict[str, float] = {}
    for row in rows or []:
        sku = str(_read_attr(row, "sku", "") or "").strip()
        if not sku:
            continue
        value = _read_attr(row, value_key, None)
        if value is None:
            continue
        lookup[sku] = max(0.0, _to_float(value, 0.0))
    return lookup


def _format_plan_row(sku: str, plant_id: str, order_date: date, arrival_date: date, order_qty: float) -> Dict[str, Any]:
    return {
        "sku": sku,
        "plant_id": plant_id or None,
        "order_date": order_date.isoformat(),
        "arrival_date": arrival_date.isoformat(),
        "order_qty": float(round(max(0.0, order_qty), 6)),
    }


def _solver_runtime_options(payload: Any) -> Dict[str, Any]:
    settings = _read_attr(payload, "settings", {})
    solver_settings = _read_attr(settings, "solver", {})

    deterministic_mode = _to_bool(
        _first_non_none(
            _read_attr(payload, "_solver_deterministic_mode", None),
            _read_attr(solver_settings, "deterministic_mode", None),
            _read_attr(settings, "deterministic_mode", None),
        ),
        True,
    )

    num_workers_raw = _first_non_none(
        _read_attr(payload, "_solver_num_search_workers", None),
        _read_attr(solver_settings, "num_search_workers", None),
    )
    random_seed_raw = _first_non_none(
        _read_attr(payload, "_solver_random_seed", None),
        _read_attr(solver_settings, "random_seed", None),
    )
    time_limit_raw = _first_non_none(
        _read_attr(payload, "_solver_time_limit_seconds", None),
        _read_attr(solver_settings, "time_limit_seconds", None),
    )

    force_timeout = _to_bool(
        _first_non_none(
            _read_attr(payload, "_solver_force_timeout", None),
            _read_attr(solver_settings, "force_timeout", None),
        ),
        False,
    )
    enforce_no_stockout = _to_bool(
        _first_non_none(
            _read_attr(payload, "_solver_enforce_no_stockout", None),
            _read_attr(solver_settings, "enforce_no_stockout", None),
        ),
        False,
    )

    num_workers = _to_int(num_workers_raw, 1 if deterministic_mode else 1)
    if num_workers < 1:
        num_workers = 1

    random_seed: Optional[int] = None
    if random_seed_raw is not None:
        random_seed = _to_int(random_seed_raw, 0)
    elif deterministic_mode:
        random_seed = 0

    time_limit_seconds = _to_float(time_limit_raw, 5.0)
    if time_limit_seconds <= 0.0:
        time_limit_seconds = 5.0

    return {
        "deterministic_mode": deterministic_mode,
        "num_search_workers": int(num_workers),
        "random_seed": random_seed,
        "time_limit_seconds": float(round(time_limit_seconds, 6)),
        "force_timeout": force_timeout,
        "enforce_no_stockout": enforce_no_stockout,
    }


def _resolve_budget_cap(payload: Any) -> Optional[float]:
    raw = _first_non_none(
        _read_path(payload, "shared_constraints.budget_cap", None),
        _read_path(payload, "constraints.budget_cap", None),
    )
    if raw is None:
        return None
    return max(0.0, _to_float(raw, 0.0))


def _resolve_priority_weights(payload: Any) -> Dict[str, float]:
    out: Dict[str, float] = {}
    raw = _read_path(payload, "shared_constraints.priority_weights", {}) or {}
    if isinstance(raw, dict):
        for sku, value in raw.items():
            sku_key = str(sku or "").strip()
            if not sku_key:
                continue
            out[sku_key] = max(0.01, _to_float(value, 1.0))
    for item in _read_attr(payload, "items", []) or []:
        sku = str(_read_attr(item, "sku", "")).strip()
        if not sku:
            continue
        priority_weight = _read_attr(item, "priority_weight", None)
        if priority_weight is None:
            continue
        out[sku] = max(0.01, _to_float(priority_weight, 1.0))
    return out


def _iter_forecast_points(payload: Any) -> List[Any]:
    points = list(_read_path(payload, "demand_forecast.series", []) or [])
    for item in _read_attr(payload, "items", []) or []:
        sku = str(_read_attr(item, "sku", "")).strip()
        if not sku:
            continue
        plant_id = _read_attr(item, "plant_id", None)
        for row in _read_attr(item, "demand_series", []) or []:
            day = _read_attr(row, "date", None)
            p50 = _read_attr(row, "p50", None)
            if day is None or p50 is None:
                continue
            points.append(
                {
                    "sku": sku,
                    "plant_id": plant_id,
                    "date": day,
                    "p50": p50,
                    "p90": _read_attr(row, "p90", None),
                }
            )
    return points


def _empty_response(
    *,
    status: PlanningStatus,
    reasons: List[str],
    started_at: datetime,
    options: Dict[str, Any],
) -> Dict[str, Any]:
    solve_time_ms = int((datetime.now(timezone.utc) - started_at).total_seconds() * 1000)
    return finalize_planning_response(
        {
            "status": status.value,
            "plan_lines": [],
            "kpis": {
                "estimated_service_level": None,
                "estimated_stockout_units": None,
                "estimated_holding_units": None,
                "estimated_total_cost": None,
            },
            "solver_meta": {
                "engine": "heuristic",
                "solver": "heuristic",
                "status": status.value,
                "termination_reason": "FORCED_TIMEOUT" if status == PlanningStatus.TIMEOUT else "PRECHECK_FAILURE",
                "cp_status_name": "HEURISTIC",
                "solve_time_ms": solve_time_ms,
                "objective_value": None,
                "best_bound": None,
                "gap": None,
                "deterministic_mode": options.get("deterministic_mode", True),
                "log_search_progress": False,
                "workers": options.get("num_search_workers", 1),
                "num_search_workers": options.get("num_search_workers", 1),
                "seed": options.get("random_seed", 0),
                "random_seed": options.get("random_seed", 0),
                "time_limit": options.get("time_limit_seconds", 5.0),
                "time_limit_seconds": options.get("time_limit_seconds", 5.0),
                "max_time_in_seconds": options.get("time_limit_seconds", 5.0),
                "force_timeout_requested": bool(options.get("force_timeout", False)),
                "time_limit_hit": bool(status == PlanningStatus.TIMEOUT),
            },
            "infeasible_reasons": reasons,
            "infeasible_reasons_detailed": [],
            "proof": {
                "objective_terms": [],
                "constraints_checked": [],
            },
        },
        default_engine="heuristic",
        default_status=status,
    )


def deterministic_replenishment_plan(payload: Any) -> Dict[str, Any]:
    """Run deterministic single-echelon heuristic planner with contract-stable output."""
    started_at = datetime.now(timezone.utc)
    options = _solver_runtime_options(payload)

    if options["force_timeout"]:
        return _empty_response(
            status=PlanningStatus.TIMEOUT,
            reasons=["Forced timeout via settings.solver.force_timeout=true."],
            started_at=started_at,
            options=options,
        )

    infeasible_reasons: List[str] = []

    forecast_by_key: Dict[Tuple[str, str], List[Tuple[date, float, Optional[float]]]] = {}
    priority_weights = _resolve_priority_weights(payload)
    objective = _read_attr(payload, "objective", None)
    forecast_uncertainty_cfg_raw = _read_path(payload, "settings.forecast_uncertainty", {}) or {}
    forecast_uncertainty_cfg = (
        forecast_uncertainty_cfg_raw if isinstance(forecast_uncertainty_cfg_raw, dict) else {}
    )
    closed_loop_patch_raw = _read_path(payload, "settings.closed_loop_meta.param_patch.patch", {}) or {}
    closed_loop_patch = closed_loop_patch_raw if isinstance(closed_loop_patch_raw, dict) else {}
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
    closed_loop_safety_stock_by_key: Dict[Tuple[str, str], float] = {}
    raw_ss_map = closed_loop_patch.get("safety_stock_by_key")
    if isinstance(raw_ss_map, dict):
        for raw_key, raw_value in raw_ss_map.items():
            parsed_key = _parse_sku_plant_key(raw_key)
            if parsed_key is None:
                continue
            closed_loop_safety_stock_by_key[parsed_key] = max(0.0, _to_float(raw_value, 0.0))
    for point in _iter_forecast_points(payload):
        sku = str(_read_attr(point, "sku", "") or "").strip()
        if not sku:
            continue
        date_val = _parse_iso_day(_read_attr(point, "date", None))
        if not date_val:
            continue
        key = _key_of(_read_attr(point, "sku", None), _read_attr(point, "plant_id", None))
        p50 = max(0.0, _to_float(_read_attr(point, "p50", 0.0), 0.0))
        p90_raw = _read_attr(point, "p90", None)
        p90 = max(0.0, _to_float(p90_raw, p50)) if p90_raw is not None else None
        forecast_by_key.setdefault(key, []).append((date_val, p50, p90))

    if not forecast_by_key:
        return _empty_response(
            status=PlanningStatus.INFEASIBLE,
            reasons=["No valid demand_forecast.series rows with SKU/date/p50 were provided."],
            started_at=started_at,
            options=options,
        )

    for key in list(forecast_by_key.keys()):
        forecast_by_key[key] = sorted(forecast_by_key[key], key=lambda row: row[0])

    inventory_state: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for row in _read_attr(payload, "inventory", []) or []:
        key = _key_of(_read_attr(row, "sku", None), _read_attr(row, "plant_id", None))
        snapshot_date = _parse_iso_day(_read_attr(row, "as_of_date", None))
        if not snapshot_date:
            continue
        prev = inventory_state.get(key)
        if not prev or snapshot_date > prev["as_of_date"]:
            inventory_state[key] = {
                "as_of_date": snapshot_date,
                "on_hand": _to_float(_read_attr(row, "on_hand", 0.0), 0.0),
                "safety_stock": max(0.0, _to_float(_read_attr(row, "safety_stock", 0.0), 0.0)),
                "lead_time_days": max(0.0, _to_float(_read_attr(row, "lead_time_days", 0.0), 0.0)),
            }

    inbound_by_key_day: Dict[Tuple[str, str], Dict[date, float]] = {}
    for po in _read_attr(payload, "open_pos", []) or []:
        eta_date = _parse_iso_day(_read_attr(po, "eta_date", None))
        if not eta_date:
            continue
        key = _key_of(_read_attr(po, "sku", None), _read_attr(po, "plant_id", None))
        inbound_by_key_day.setdefault(key, {})
        inbound_by_key_day[key][eta_date] = inbound_by_key_day[key].get(eta_date, 0.0) + max(
            0.0,
            _to_float(_read_attr(po, "qty", 0.0), 0.0),
        )

    constraints = _read_attr(payload, "constraints", None)
    moq_map = _build_sku_lookup(_read_attr(constraints, "moq", []), "min_qty")
    pack_map = _build_sku_lookup(_read_attr(constraints, "pack_size", []), "pack_qty")
    max_map = _build_sku_lookup(_read_attr(constraints, "max_order_qty", []), "max_qty")

    budget_cap = _resolve_budget_cap(payload)

    horizon_days = max(1, _to_int(_read_attr(payload, "planning_horizon_days", 1), 1))
    ordered_keys = sorted(
        forecast_by_key.keys(),
        key=lambda item: (-priority_weights.get(item[0], 1.0), item[0], item[1]),
    )

    plan_rows: List[Dict[str, Any]] = []
    rounding_events: List[str] = []

    total_order_qty = 0.0
    total_demand = 0.0
    stockout_units = 0.0
    holding_units = 0.0
    keys_with_p90 = 0
    keys_with_derived_safety_stock = 0
    keys_with_closed_loop_safety_stock = 0

    # Phase 4.3 – explain parity tracking
    binding_constraints: List[Dict[str, Any]] = []
    sku_stockout_flag: Dict[str, bool] = {}   # sku -> had stockouts?
    sku_excess_flag: Dict[str, bool] = {}     # sku -> had excess inventory?
    first_unfunded_sku: Optional[str] = None  # first SKU clipped/denied by budget
    budget_was_binding = False
    unique_skus_ordered: set = set()

    for key in ordered_keys:
        sku, plant_id = key
        series_rows = forecast_by_key[key]
        if not series_rows:
            continue

        first_day = series_rows[0][0]
        last_day_allowed = first_day + timedelta(days=horizon_days - 1)
        filtered_rows = [row for row in series_rows if row[0] <= last_day_allowed]
        if not filtered_rows:
            continue

        inv = inventory_state.get(key, {
            "on_hand": 0.0,
            "safety_stock": 0.0,
            "lead_time_days": 0.0,
        })

        on_hand = _to_float(inv.get("on_hand"), 0.0)
        base_safety_stock = max(0.0, _to_float(inv.get("safety_stock"), 0.0))
        p90_values = [p90 for _, _, p90 in filtered_rows if p90 is not None]
        if p90_values:
            keys_with_p90 += 1
        derived_safety_stock: Optional[float] = None
        if use_p90_for_safety_stock and p90_values:
            avg_p50 = sum(p50 for _, p50, _ in filtered_rows) / len(filtered_rows)
            avg_p90 = sum((p90 if p90 is not None else p50) for _, p50, p90 in filtered_rows) / len(filtered_rows)
            spread = max(0.0, avg_p90 - avg_p50)
            derived_safety_stock = max(0.0, avg_p50 + safety_stock_alpha * spread)
        closed_loop_override = _lookup_keyed_value(closed_loop_safety_stock_by_key, key)
        if closed_loop_override is not None:
            safety_stock = max(0.0, _to_float(closed_loop_override, 0.0))
            keys_with_closed_loop_safety_stock += 1
        elif derived_safety_stock is not None:
            safety_stock = max(base_safety_stock, derived_safety_stock)
            if safety_stock > base_safety_stock + 1e-9:
                keys_with_derived_safety_stock += 1
        else:
            safety_stock = base_safety_stock
        lead_time_days = max(0, _to_int(inv.get("lead_time_days"), 0))
        inbound_calendar = inbound_by_key_day.get(key, {})

        sku_moq = moq_map.get(sku, 0.0)
        sku_pack = pack_map.get(sku, 0.0)
        sku_max = max_map.get(sku, 0.0)

        for demand_day, demand_p50, _demand_p90 in filtered_rows:
            inbound_today = _to_float(inbound_calendar.get(demand_day, 0.0), 0.0)
            on_hand += inbound_today

            demand = max(0.0, _to_float(demand_p50, 0.0))
            total_demand += demand

            projected_after_demand = on_hand - demand
            needed_qty = max(0.0, safety_stock - projected_after_demand)
            order_qty = needed_qty
            row_rounding_notes: List[str] = []

            if order_qty > 0.0:
                period_str = demand_day.isoformat()

                if sku_max > 0.0 and order_qty > sku_max:
                    order_qty = sku_max
                    row_rounding_notes.append("max_order_qty_cap")
                    binding_constraints.append({"tag": "max_order_qty_cap", "sku": sku, "period": period_str, "binding": True})

                if sku_moq > 0.0 and 0.0 < order_qty < sku_moq:
                    order_qty = sku_moq
                    row_rounding_notes.append("moq_floor")
                    binding_constraints.append({"tag": "moq_floor", "sku": sku, "period": period_str, "binding": True})

                if sku_pack > 1.0 and order_qty > 0.0:
                    rounded = math.ceil(order_qty / sku_pack) * sku_pack
                    if abs(rounded - order_qty) > 1e-9:
                        row_rounding_notes.append("pack_round_up")
                        binding_constraints.append({"tag": "pack_round_up", "sku": sku, "period": period_str, "binding": True})
                    order_qty = rounded

                if budget_cap is not None and order_qty > 0.0:
                    remaining_budget = budget_cap - total_order_qty
                    if remaining_budget <= 0.0:
                        order_qty = 0.0
                        budget_was_binding = True
                        if first_unfunded_sku is None:
                            first_unfunded_sku = sku
                        binding_constraints.append({"tag": "budget_cap_clipped", "sku": sku, "period": period_str, "binding": True})
                        infeasible_reasons.append(
                            f"Budget cap exhausted before covering demand for {sku} ({demand_day.isoformat()})."
                        )
                    elif order_qty > remaining_budget:
                        clipped = remaining_budget
                        if sku_pack > 1.0:
                            clipped = math.floor(clipped / sku_pack) * sku_pack
                        if sku_moq > 0.0 and 0.0 < clipped < sku_moq:
                            clipped = 0.0
                        if clipped < order_qty:
                            row_rounding_notes.append("budget_cap_clipped")
                            budget_was_binding = True
                            if first_unfunded_sku is None:
                                first_unfunded_sku = sku
                            binding_constraints.append({"tag": "budget_cap_clipped", "sku": sku, "period": period_str, "binding": True})
                        order_qty = max(0.0, clipped)
                        if order_qty == 0.0:
                            infeasible_reasons.append(
                                f"Budget cap prevented ordering MOQ/pack for {sku} ({demand_day.isoformat()})."
                            )

            if order_qty > 0.0:
                order_date = demand_day - timedelta(days=lead_time_days)
                arrival_date = demand_day
                plan_rows.append(
                    _format_plan_row(
                        sku=sku,
                        plant_id=plant_id,
                        order_date=order_date,
                        arrival_date=arrival_date,
                        order_qty=order_qty,
                    )
                )
                total_order_qty += order_qty
                projected_after_demand += order_qty
                unique_skus_ordered.add(sku)

                if row_rounding_notes:
                    rounding_events.append(
                        f"{sku}@{plant_id or 'NA'} {demand_day.isoformat()}: {', '.join(sorted(set(row_rounding_notes)))}"
                    )

            on_hand = projected_after_demand
            if on_hand < 0:
                stockout_units += abs(on_hand)
                sku_stockout_flag[sku] = True
            if on_hand > 0:
                sku_excess_flag[sku] = True
            holding_units += max(0.0, on_hand)

    stockout_penalty = _to_float(_read_attr(objective, "stockout_penalty", 1.0), 1.0)
    holding_cost = _to_float(_read_attr(objective, "holding_cost", 0.0), 0.0)
    estimated_total_cost = total_order_qty + (stockout_penalty * stockout_units) + (holding_cost * holding_units)

    # ── Phase 4.3: shadow_prices ──────────────────────────────────────────
    shadow_prices: List[Dict[str, Any]] = []
    all_skus = sorted({k[0] for k in ordered_keys})
    for sp_sku in all_skus:
        had_stockout = sku_stockout_flag.get(sp_sku, False)
        had_excess = sku_excess_flag.get(sp_sku, False)
        if had_stockout:
            sp_value = stockout_penalty
            sp_binding = True
            sp_slack = 0.0
        elif had_excess:
            sp_value = -holding_cost
            sp_binding = holding_cost > 0.0
            sp_slack = 0.0 if holding_cost > 0.0 else 1.0
        else:
            sp_value = 0.0
            sp_binding = False
            sp_slack = 1.0
        shadow_prices.append({
            "constraint": f"demand_coverage[{sp_sku}]",
            "shadow_price_approx": float(round(sp_value, 6)),
            "binding": sp_binding,
            "slack": float(round(sp_slack, 6)),
        })
    # Budget constraint shadow price
    if budget_cap is not None:
        budget_slack = max(0.0, budget_cap - total_order_qty)
        budget_sp = 0.0
        if budget_was_binding and first_unfunded_sku is not None:
            # Shadow price = stockout penalty of the first SKU that could not be funded
            budget_sp = stockout_penalty
        shadow_prices.append({
            "constraint": "budget_cap",
            "shadow_price_approx": float(round(budget_sp, 6)),
            "binding": budget_was_binding,
            "slack": float(round(budget_slack, 6)),
        })

    # ── Phase 4.3: explain_summary ────────────────────────────────────────
    num_binding = len([bc for bc in binding_constraints if bc.get("binding")])
    num_periods = len({row["arrival_date"] for row in plan_rows}) if plan_rows else 0
    num_skus = len(unique_skus_ordered)
    budget_utilization_pct = 0.0
    if budget_cap is not None and budget_cap > 0.0:
        budget_utilization_pct = round(min(100.0, (total_order_qty / budget_cap) * 100.0), 1)
    budget_str = f" Budget utilization: {budget_utilization_pct}%." if budget_cap is not None else ""
    explain_summary = (
        f"Heuristic plan: ordered {int(round(total_order_qty))} units across "
        f"{num_skus} SKUs over {num_periods} periods. "
        f"{num_binding} constraints were binding.{budget_str}"
    )

    service_level: Optional[float] = None
    if total_demand > 0.0:
        service_level = max(0.0, min(1.0, 1.0 - (stockout_units / total_demand)))

    moq_failed = 0
    pack_failed = 0
    max_failed = 0
    non_negative_failed = 0

    for row in plan_rows:
        sku = row["sku"]
        qty = _to_float(row["order_qty"], 0.0)
        if qty < -1e-9:
            non_negative_failed += 1
        sku_moq = moq_map.get(sku, 0.0)
        if sku_moq > 0.0 and qty > 0.0 and qty + 1e-9 < sku_moq:
            moq_failed += 1
        sku_pack = pack_map.get(sku, 0.0)
        if sku_pack > 1.0 and qty > 0.0:
            ratio = qty / sku_pack
            if abs(ratio - round(ratio)) > 1e-6:
                pack_failed += 1
        sku_max = max_map.get(sku, 0.0)
        if sku_max > 0.0 and qty - sku_max > 1e-9:
            max_failed += 1

    budget_passed = True
    budget_details = "No budget cap provided."
    if budget_cap is not None:
        budget_passed = total_order_qty <= budget_cap + 1e-9
        budget_details = f"Total ordered qty {round(total_order_qty, 6)} vs cap {round(budget_cap, 6)}."
        if not budget_passed:
            infeasible_reasons.append("Total planned quantity exceeds configured budget cap.")

    constraints_checked: List[Dict[str, Any]] = [
        {
            "name": "order_qty_non_negative",
            "passed": non_negative_failed == 0,
            "details": f"Negative quantity rows: {non_negative_failed}.",
        },
        {
            "name": "moq",
            "passed": moq_failed == 0,
            "details": f"Rows violating MOQ: {moq_failed}.",
        },
        {
            "name": "pack_size_multiple",
            "passed": pack_failed == 0,
            "details": f"Rows violating pack-size multiple: {pack_failed}.",
        },
        {
            "name": "budget_cap",
            "passed": budget_passed,
            "details": budget_details,
        },
        {
            "name": "max_order_qty",
            "passed": max_failed == 0,
            "details": f"Rows violating max_order_qty: {max_failed}.",
        },
    ]

    if rounding_events:
        constraints_checked.append(
            {
                "name": "rounding_adjustments",
                "passed": True,
                "details": "; ".join(rounding_events[:25]),
            }
        )

    if not plan_rows and total_demand > 0.0:
        infeasible_reasons.append("No replenishment orders were generated for non-zero demand horizon.")

    if stockout_units > 1e-9:
        infeasible_reasons.append(
            f"Unmet demand backlog remains across horizon: {round(stockout_units, 6)} units."
        )

    if options["enforce_no_stockout"] and stockout_units > 1e-9:
        infeasible_reasons.append("Service-level hard gate failed: settings.solver.enforce_no_stockout=true.")

    if rounding_events:
        infeasible_reasons.append(f"Rounding adjustments applied: {len(rounding_events)} events.")

    unique_reasons = sorted(set(reason for reason in infeasible_reasons if reason))
    all_constraints_passed = all(item["passed"] for item in constraints_checked)
    reason_details = []
    if unique_reasons:
        reason_details.append(
            {
                "category": "capacity" if any("CAP_" in msg for msg in unique_reasons) else "demand_infeasible",
                "top_offending_tags": [
                    "CAP_INV[*]" if any("CAP_INV" in msg for msg in unique_reasons) else None,
                    "CAP_PROD[*]" if any("CAP_PROD" in msg for msg in unique_reasons) else None,
                ],
                "suggested_actions": [
                    "Increase constrained capacity or relax hard lot-sizing constraints.",
                    "Lower service target or extend horizon and rerun.",
                ],
            }
        )
        reason_details[0]["top_offending_tags"] = [
            tag for tag in reason_details[0]["top_offending_tags"] if tag
        ]

    if not plan_rows and total_demand > 0.0:
        status = PlanningStatus.INFEASIBLE
    elif stockout_units > 1e-9:
        status = PlanningStatus.INFEASIBLE
    elif all_constraints_passed and len(unique_reasons) == 0:
        status = PlanningStatus.OPTIMAL
    else:
        status = PlanningStatus.FEASIBLE

    solve_time_ms = int((datetime.now(timezone.utc) - started_at).total_seconds() * 1000)

    return finalize_planning_response(
        {
            "status": status.value,
            "plan_lines": plan_rows,
            "kpis": {
                "estimated_service_level": None if service_level is None else float(round(service_level, 6)),
                "estimated_stockout_units": float(round(stockout_units, 6)),
                "estimated_holding_units": float(round(holding_units, 6)),
                "estimated_total_cost": float(round(estimated_total_cost, 6)),
            },
            "solver_meta": {
                "engine": "heuristic",
                "solver": "heuristic",
                "status": status.value,
                "termination_reason": "HEURISTIC_COMPLETE",
                "cp_status_name": "HEURISTIC",
                "solve_time_ms": solve_time_ms,
                "objective_value": float(round(estimated_total_cost, 6)),
                "best_bound": float(round(estimated_total_cost, 6)),
                "gap": 0.0,
                "deterministic_mode": options["deterministic_mode"],
                "log_search_progress": False,
                "workers": options["num_search_workers"],
                "num_search_workers": options["num_search_workers"],
                "seed": options["random_seed"],
                "random_seed": options["random_seed"],
                "time_limit": options["time_limit_seconds"],
                "time_limit_seconds": options["time_limit_seconds"],
                "max_time_in_seconds": options["time_limit_seconds"],
                "force_timeout_requested": bool(options.get("force_timeout", False)),
                "time_limit_hit": False,
                "uncertainty_bridge": {
                    "safety_stock_alpha": round(safety_stock_alpha, 6),
                    "use_p90_for_safety_stock": bool(use_p90_for_safety_stock),
                    "keys_with_p90": int(keys_with_p90),
                    "keys_with_derived_safety_stock": int(keys_with_derived_safety_stock),
                    "keys_with_closed_loop_safety_stock": int(keys_with_closed_loop_safety_stock),
                },
            },
            "infeasible_reasons": unique_reasons,
            "infeasible_reason_details": reason_details,
            "infeasible_reasons_detailed": reason_details,
            "binding_constraints": binding_constraints,
            "shadow_prices": shadow_prices if shadow_prices else None,
            "relaxation_applied": None,
            "proof": {
                "objective_terms": [
                    {
                        "name": "ordered_units",
                        "value": float(round(total_order_qty, 6)),
                        "note": "Total planned replenishment quantity.",
                    },
                    {
                        "name": "stockout_units",
                        "value": float(round(stockout_units, 6)),
                        "note": "Projected unmet demand units.",
                    },
                    {
                        "name": "holding_units",
                        "value": float(round(holding_units, 6)),
                        "note": "Projected positive inventory accumulation.",
                    },
                    {
                        "name": "estimated_total_cost",
                        "value": float(round(estimated_total_cost, 6)),
                        "note": "Heuristic cost proxy from order + penalties.",
                    },
                ],
                "constraints_checked": constraints_checked,
                "shadow_prices": shadow_prices,
                "binding_constraints": binding_constraints,
                "explain_summary": explain_summary,
            },
        },
        default_engine="heuristic",
        default_status=status,
    )


def solve_replenishment_heuristic(payload: Any) -> Dict[str, Any]:
    """Backward-compatible entrypoint used by the FastAPI planner endpoint."""
    return deterministic_replenishment_plan(payload)
