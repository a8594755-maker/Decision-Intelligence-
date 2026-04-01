"""
inventory_projection_spec.py — Eval specs for inventory projection

NOTE: JS service. Tests simulate the core domain logic:
  end = begin + inbound - demand
  available = end - safetyStock
  shortageFlag = available < 0
"""

from ml.api.tool_eval import ToolTestSpec, custom


def _run_projection(input_data):
    """Simulate inventory projection domain logic."""
    items = input_data.get("items", [])
    safety_stock = input_data.get("safety_stock", 0)
    results = []
    stockout_bucket = None

    begin = input_data.get("initial_on_hand", 0)
    for item in items:
        inbound = item.get("inbound", 0)
        demand = item.get("demand", 0)
        end = begin + inbound - demand
        available = end - safety_stock
        shortage = available < 0
        if shortage and stockout_bucket is None:
            stockout_bucket = item.get("bucket", "?")
        results.append({
            "bucket": item.get("bucket"),
            "begin": round(begin, 2),
            "inbound": inbound,
            "demand": demand,
            "end": round(end, 2),
            "available": round(available, 2),
            "shortage": shortage,
        })
        begin = end

    min_available = min(r["available"] for r in results) if results else 0
    return {
        "success": True,
        "results": results,
        "stockout_bucket": stockout_bucket,
        "shortage_qty": abs(min_available) if min_available < 0 else 0,
        "min_available": round(min_available, 2),
    }


SPECS = [
    ToolTestSpec(
        tool_id="run_inventory_projection",
        scenario="normal_drawdown_stockout_day10",
        description="1000 units, 100/day demand, no inbound → stockout at bucket 10",
        run_fn=_run_projection,
        input_data={
            "initial_on_hand": 1000,
            "safety_stock": 0,
            "items": [{"bucket": f"day_{i+1}", "demand": 100, "inbound": 0} for i in range(15)],
        },
        tags=["core"],
        assertions=[
            custom("stockout_at_11", lambda r: (
                r["stockout_bucket"] == "day_11",
                f"Stockout at {r['stockout_bucket']} (expected day_11, 1000/100=10 full days)"
            )),
            custom("end_negative", lambda r: (
                r["results"][10]["end"] == -100,
                f"Day 11 end: {r['results'][10]['end']} (expected -100)"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_inventory_projection",
        scenario="no_demand_stable",
        description="1000 units, 0 demand → inventory stays at 1000",
        run_fn=_run_projection,
        input_data={
            "initial_on_hand": 1000,
            "safety_stock": 0,
            "items": [{"bucket": f"day_{i+1}", "demand": 0, "inbound": 0} for i in range(5)],
        },
        tags=["edge"],
        assertions=[
            custom("stable", lambda r: (
                all(row["end"] == 1000 for row in r["results"]),
                f"All end values: {[row['end'] for row in r['results']]}"
            )),
            custom("no_stockout", lambda r: (
                r["stockout_bucket"] is None,
                f"Stockout: {r['stockout_bucket']}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_inventory_projection",
        scenario="already_stockout",
        description="0 units on hand, positive demand → immediate stockout",
        run_fn=_run_projection,
        input_data={
            "initial_on_hand": 0,
            "safety_stock": 50,
            "items": [{"bucket": "day_1", "demand": 100, "inbound": 0}],
        },
        tags=["edge"],
        assertions=[
            custom("immediate_stockout", lambda r: (
                r["stockout_bucket"] == "day_1",
                f"Stockout: {r['stockout_bucket']}"
            )),
            custom("shortage_150", lambda r: (
                r["shortage_qty"] == 150,  # end=-100, available=-100-50=-150
                f"Shortage: {r['shortage_qty']} (expected 150)"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_inventory_projection",
        scenario="inbound_prevents_stockout",
        description="500 units, 200/day demand, 150/day inbound → stockout delayed",
        run_fn=_run_projection,
        input_data={
            "initial_on_hand": 500,
            "safety_stock": 0,
            "items": [{"bucket": f"day_{i+1}", "demand": 200, "inbound": 150} for i in range(15)],
        },
        tags=["core"],
        assertions=[
            custom("net_drawdown_50_per_day", lambda r: (
                r["results"][0]["end"] == 450,  # 500 + 150 - 200
                f"Day 1 end: {r['results'][0]['end']} (expected 450)"
            )),
            custom("stockout_at_day_11", lambda r: (
                r["stockout_bucket"] == "day_11",  # 500 / 50 = 10 full days
                f"Stockout: {r['stockout_bucket']}"
            )),
        ],
    ),
]
