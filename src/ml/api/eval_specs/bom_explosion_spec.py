"""
bom_explosion_spec.py — Eval specs for BOM explosion

NOTE: JS service. Tests simulate the core domain logic:
  component_qty = parent_qty * qty_per * (1 + scrap_rate) / yield_rate
  Shared components summed via Map.
  Circular references detected via path tracking.
"""

from ml.api.tool_eval import ToolTestSpec, custom


def _explode_bom(input_data):
    """Simulate BOM explosion domain logic."""
    fg_demands = input_data.get("fg_demands", [])
    bom_edges = input_data.get("bom_edges", [])
    max_depth = input_data.get("max_depth", 50)

    # Build BOM index: parent → [children]
    bom_index = {}
    for edge in bom_edges:
        parent = edge["parent_material"]
        bom_index.setdefault(parent, []).append(edge)

    # Component demand accumulator
    component_map = {}  # key → total_qty
    trace = []
    errors = []

    def _explode(material, qty, path, level):
        if level > max_depth:
            errors.append({"type": "MAX_DEPTH_EXCEEDED", "material": material})
            return
        if material in path:
            errors.append({"type": "BOM_CYCLE", "material": material, "path": list(path)})
            return

        children = bom_index.get(material, [])
        for edge in children:
            child = edge["child_material"]
            qty_per = edge.get("qty_per", 1)
            scrap = edge.get("scrap_rate", 0)
            yield_rate = edge.get("yield_rate", 1)
            yield_rate = max(yield_rate, 0.01)  # floor

            child_qty = round(qty * qty_per * (1 + scrap) / yield_rate, 4)

            key = child
            component_map[key] = round(component_map.get(key, 0) + child_qty, 4)

            trace.append({
                "parent": material,
                "child": child,
                "parent_qty": qty,
                "child_qty": child_qty,
                "level": level,
                "path": list(path) + [material],
            })

            _explode(child, child_qty, path | {material}, level + 1)

    for fg in fg_demands:
        _explode(fg["material_code"], fg["demand_qty"], set(), 0)

    return {
        "success": True,
        "components": [{"material": k, "total_qty": v} for k, v in sorted(component_map.items())],
        "trace": trace,
        "errors": errors,
    }


SPECS = [
    ToolTestSpec(
        tool_id="run_bom_explosion",
        scenario="single_level_3_components",
        description="1 FG → 3 components, qty_per = 2/3/1 → correct quantities",
        run_fn=_explode_bom,
        input_data={
            "fg_demands": [{"material_code": "FG-001", "demand_qty": 100}],
            "bom_edges": [
                {"parent_material": "FG-001", "child_material": "RM-A", "qty_per": 2},
                {"parent_material": "FG-001", "child_material": "RM-B", "qty_per": 3},
                {"parent_material": "FG-001", "child_material": "RM-C", "qty_per": 1},
            ],
        },
        tags=["core"],
        assertions=[
            custom("rm_a_200", lambda r: (
                next(c["total_qty"] for c in r["components"] if c["material"] == "RM-A") == 200,
                f"RM-A: {next((c['total_qty'] for c in r['components'] if c['material'] == 'RM-A'), 'NOT FOUND')}"
            )),
            custom("rm_b_300", lambda r: (
                next(c["total_qty"] for c in r["components"] if c["material"] == "RM-B") == 300,
                f"RM-B: {next((c['total_qty'] for c in r['components'] if c['material'] == 'RM-B'), 'NOT FOUND')}"
            )),
            custom("rm_c_100", lambda r: (
                next(c["total_qty"] for c in r["components"] if c["material"] == "RM-C") == 100,
                f"RM-C: {next((c['total_qty'] for c in r['components'] if c['material'] == 'RM-C'), 'NOT FOUND')}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_bom_explosion",
        scenario="multi_level_multiplication",
        description="FG → Sub-assy (×2) → RM (×3) = 100 × 2 × 3 = 600",
        run_fn=_explode_bom,
        input_data={
            "fg_demands": [{"material_code": "FG-001", "demand_qty": 100}],
            "bom_edges": [
                {"parent_material": "FG-001", "child_material": "SUB-001", "qty_per": 2},
                {"parent_material": "SUB-001", "child_material": "RM-X", "qty_per": 3},
            ],
        },
        tags=["core"],
        assertions=[
            custom("sub_200", lambda r: (
                next(c["total_qty"] for c in r["components"] if c["material"] == "SUB-001") == 200,
                f"SUB-001: {next((c['total_qty'] for c in r['components'] if c['material'] == 'SUB-001'), '?')}"
            )),
            custom("rm_600", lambda r: (
                next(c["total_qty"] for c in r["components"] if c["material"] == "RM-X") == 600,
                f"RM-X: {next((c['total_qty'] for c in r['components'] if c['material'] == 'RM-X'), '?')}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_bom_explosion",
        scenario="shared_component_summed",
        description="2 FGs share RM-SHARED → quantities summed: 100×2 + 50×3 = 350",
        run_fn=_explode_bom,
        input_data={
            "fg_demands": [
                {"material_code": "FG-A", "demand_qty": 100},
                {"material_code": "FG-B", "demand_qty": 50},
            ],
            "bom_edges": [
                {"parent_material": "FG-A", "child_material": "RM-SHARED", "qty_per": 2},
                {"parent_material": "FG-B", "child_material": "RM-SHARED", "qty_per": 3},
            ],
        },
        tags=["core"],
        assertions=[
            custom("shared_350", lambda r: (
                next(c["total_qty"] for c in r["components"] if c["material"] == "RM-SHARED") == 350,
                f"RM-SHARED: {next((c['total_qty'] for c in r['components'] if c['material'] == 'RM-SHARED'), '?')}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_bom_explosion",
        scenario="circular_ref_detected",
        description="A→B→A cycle detected without infinite loop",
        run_fn=_explode_bom,
        input_data={
            "fg_demands": [{"material_code": "A", "demand_qty": 10}],
            "bom_edges": [
                {"parent_material": "A", "child_material": "B", "qty_per": 1},
                {"parent_material": "B", "child_material": "A", "qty_per": 1},
            ],
        },
        tags=["edge"],
        assertions=[
            custom("cycle_error", lambda r: (
                any(e["type"] == "BOM_CYCLE" for e in r["errors"]),
                f"Errors: {r['errors']}"
            )),
            custom("no_crash", lambda r: (r["success"], "Did not crash")),
        ],
    ),

    ToolTestSpec(
        tool_id="run_bom_explosion",
        scenario="scrap_and_yield",
        description="100 units × qty_per=2 × (1+10% scrap) / 90% yield = 244.44",
        run_fn=_explode_bom,
        input_data={
            "fg_demands": [{"material_code": "FG-001", "demand_qty": 100}],
            "bom_edges": [
                {"parent_material": "FG-001", "child_material": "RM-001",
                 "qty_per": 2, "scrap_rate": 0.1, "yield_rate": 0.9},
            ],
        },
        tags=["core"],
        assertions=[
            custom("scrap_yield_qty", lambda r: (
                abs(next(c["total_qty"] for c in r["components"] if c["material"] == "RM-001") - 244.4444) < 0.01,
                f"RM-001: {next((c['total_qty'] for c in r['components'] if c['material'] == 'RM-001'), '?')} (expected ~244.44)"
            )),
        ],
    ),
]
