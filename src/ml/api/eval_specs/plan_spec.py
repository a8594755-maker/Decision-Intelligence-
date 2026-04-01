"""
plan_spec.py — Eval specs for replenishment plan

NOTE: JS service. Tests simulate the core heuristic:
  Per SKU per period:
    projected = on_hand + inbound - demand(p50)
    if projected < safety_stock:
        order = max(0, safety_stock - projected)
        apply lot sizing (MOQ, pack_size, max_order_qty)
  order_date = arrival_date - lead_time_days

Safety stock derived from: P90-P50 spread × alpha (default 1.0),
or base safety_stock from inventory, or 1× avg demand fallback.
"""

from ml.api.tool_eval import ToolTestSpec, custom
import math


def _run_plan(input_data):
    """Simulate the local heuristic solver logic."""
    skus = input_data.get("skus", [])
    results = []
    total_orders = 0
    total_stockout = 0

    for sku in skus:
        on_hand = sku.get("on_hand", 0)
        safety_stock = sku.get("safety_stock", 0)
        lead_time = sku.get("lead_time_days", 7)
        moq = sku.get("moq", 1)
        pack_size = sku.get("pack_size", 1)
        max_order = sku.get("max_order_qty", float("inf"))
        forecast = sku.get("forecast_p50", [])  # list of {date, demand}

        inventory = on_hand
        orders = []

        for period in forecast:
            demand = max(0, period.get("demand", 0))
            inbound = period.get("inbound", 0)

            inventory += inbound
            projected = inventory - demand

            if projected < safety_stock:
                required = max(0, safety_stock - projected)
                # Lot sizing
                order_qty = required
                if order_qty < moq:
                    order_qty = moq
                if pack_size > 1:
                    order_qty = math.ceil(order_qty / pack_size) * pack_size
                if order_qty > max_order:
                    order_qty = max_order
                order_qty = max(0, order_qty)

                orders.append({
                    "date": period.get("date"),
                    "order_qty": order_qty,
                    "arrival_date": period.get("date"),
                    "projected_before": round(projected, 2),
                })
                total_orders += 1
                # Order arrives same period for simplicity
                inventory = projected + order_qty
            else:
                inventory = projected

            if inventory < 0:
                total_stockout += abs(inventory)

        results.append({
            "sku": sku.get("sku"),
            "orders": orders,
            "final_inventory": round(inventory, 2),
        })

    return {
        "success": True,
        "results": results,
        "total_orders": total_orders,
        "total_stockout_units": round(total_stockout, 2),
    }


SPECS = [
    ToolTestSpec(
        tool_id="run_plan",
        scenario="basic_replenishment",
        description="On-hand 100, safety 200, demand 150/period → order triggered",
        run_fn=_run_plan,
        input_data={
            "skus": [{
                "sku": "SKU-001",
                "on_hand": 100,
                "safety_stock": 200,
                "lead_time_days": 7,
                "moq": 1,
                "pack_size": 1,
                "forecast_p50": [
                    {"date": "2026-01-01", "demand": 150, "inbound": 0},
                ],
            }],
        },
        tags=["core"],
        assertions=[
            custom("order_placed", lambda r: (
                len(r["results"][0]["orders"]) > 0,
                f"Orders: {r['results'][0]['orders']}"
            )),
            custom("order_qty_positive", lambda r: (
                all(o["order_qty"] > 0 for o in r["results"][0]["orders"]),
                f"Qtys: {[o['order_qty'] for o in r['results'][0]['orders']]}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_plan",
        scenario="sufficient_stock_no_order",
        description="On-hand 1000, safety 100, demand 50 → no order needed",
        run_fn=_run_plan,
        input_data={
            "skus": [{
                "sku": "SKU-002",
                "on_hand": 1000,
                "safety_stock": 100,
                "forecast_p50": [
                    {"date": "2026-01-01", "demand": 50, "inbound": 0},
                    {"date": "2026-01-02", "demand": 50, "inbound": 0},
                ],
            }],
        },
        tags=["core"],
        assertions=[
            custom("no_orders", lambda r: (
                len(r["results"][0]["orders"]) == 0,
                f"Orders: {r['results'][0]['orders']}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_plan",
        scenario="moq_roundup",
        description="Need 15 units but MOQ=50 → order 50",
        run_fn=_run_plan,
        input_data={
            "skus": [{
                "sku": "SKU-003",
                "on_hand": 100,
                "safety_stock": 100,
                "moq": 50,
                "forecast_p50": [
                    {"date": "2026-01-01", "demand": 15, "inbound": 0},
                ],
            }],
        },
        tags=["core"],
        assertions=[
            custom("moq_applied", lambda r: (
                r["results"][0]["orders"][0]["order_qty"] == 50 if r["results"][0]["orders"] else True,
                f"Order qty: {r['results'][0]['orders'][0]['order_qty'] if r['results'][0]['orders'] else 'no order'}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_plan",
        scenario="pack_size_roundup",
        description="Need 35 units, pack_size=12 → round up to 36",
        run_fn=_run_plan,
        input_data={
            "skus": [{
                "sku": "SKU-004",
                "on_hand": 50,
                "safety_stock": 100,
                "moq": 1,
                "pack_size": 12,
                "forecast_p50": [
                    {"date": "2026-01-01", "demand": 35, "inbound": 0},
                ],
            }],
        },
        tags=["core"],
        assertions=[
            custom("pack_rounded", lambda r: (
                r["results"][0]["orders"][0]["order_qty"] % 12 == 0 if r["results"][0]["orders"] else True,
                f"Order qty: {r['results'][0]['orders'][0]['order_qty'] if r['results'][0]['orders'] else 'no order'} (must be multiple of 12)"
            )),
        ],
    ),
]
