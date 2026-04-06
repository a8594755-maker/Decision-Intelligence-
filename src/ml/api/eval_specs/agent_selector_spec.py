"""
agent_selector_spec.py — Eval specs for the General Agent tool selector.

Tests:
1. Dependency resolver (deterministic, no LLM)
2. Fallback selection (deterministic)
3. Tool index completeness
"""


# ── Test 1: Dependency Resolver ──────────────────────────────────────────

def test_dependency_resolver():
    """Verify resolve_dependencies produces correct topological order."""
    from ml.api.agent_tool_selector import resolve_dependencies

    results = []

    # Case 1: Single tool — should auto-include cleaning dependency
    order = resolve_dependencies(["run_eda"])
    results.append({
        "case": "single_tool_with_cleaning_dep",
        "pass": "run_mbr_cleaning" in order and order.index("run_mbr_cleaning") < order.index("run_eda"),
        "detail": f"order={order}",
    })

    # Case 2: Tool with one dependency
    order = resolve_dependencies(["run_mbr_kpi"])
    results.append({
        "case": "tool_with_dep",
        "pass": "run_mbr_cleaning" in order and order.index("run_mbr_cleaning") < order.index("run_mbr_kpi"),
        "detail": f"order={order}",
    })

    # Case 3: Chain of 3 dependencies
    order = resolve_dependencies(["run_mbr_variance"])
    results.append({
        "case": "chain_of_3",
        "pass": (
            "run_mbr_cleaning" in order and
            "run_mbr_kpi" in order and
            "run_mbr_variance" in order and
            order.index("run_mbr_cleaning") < order.index("run_mbr_kpi") < order.index("run_mbr_variance")
        ),
        "detail": f"order={order}",
    })

    # Case 4: Multiple tools with shared dep
    order = resolve_dependencies(["run_mbr_kpi", "run_mbr_anomaly"])
    results.append({
        "case": "shared_dep",
        "pass": (
            order.count("run_mbr_cleaning") == 1 and  # not duplicated
            order.index("run_mbr_cleaning") < order.index("run_mbr_kpi") and
            order.index("run_mbr_cleaning") < order.index("run_mbr_anomaly")
        ),
        "detail": f"order={order}",
    })

    # Case 5: Deep chain (forecast → plan → scenario)
    order = resolve_dependencies(["run_scenario"])
    results.append({
        "case": "deep_chain",
        "pass": (
            "run_forecast" in order and
            "run_plan" in order and
            "run_scenario" in order and
            order.index("run_forecast") < order.index("run_plan") < order.index("run_scenario")
        ),
        "detail": f"order={order}",
    })

    # Case 6: Cap at 10
    many_tools = ["run_mbr_cleaning", "run_mbr_kpi", "run_mbr_variance", "run_mbr_anomaly",
                  "run_eda", "run_auto_insights", "run_anomaly_detection", "run_regression",
                  "run_ab_test", "run_data_cleaning", "run_dataset_join", "run_python_analysis"]
    order = resolve_dependencies(many_tools)
    results.append({
        "case": "many_tools",
        "pass": len(order) >= 10,  # should include all + deps
        "detail": f"count={len(order)}",
    })

    passed = sum(1 for r in results if r["pass"])
    return {
        "test": "dependency_resolver",
        "passed": passed,
        "total": len(results),
        "results": results,
    }


# ── Test 2: Tool Index Completeness ──────────────────────────────────────

def test_tool_index_completeness():
    """Verify TOOL_INDEX has all 63 tools and VALID_TOOL_IDS is correct."""
    from ml.api.agent_tool_selector import TOOL_INDEX, VALID_TOOL_IDS, TOOL_DEPS

    results = []

    # Check count
    results.append({
        "case": "tool_count",
        "pass": len(VALID_TOOL_IDS) == 63,
        "detail": f"found {len(VALID_TOOL_IDS)} tools (expected 63)",
    })

    # Check specific tools exist
    required = ["run_forecast", "run_plan", "run_mbr_cleaning", "run_mbr_kpi",
                 "run_eda", "run_anomaly_detection", "run_regression", "run_python_analysis"]
    for tid in required:
        results.append({
            "case": f"has_{tid}",
            "pass": tid in VALID_TOOL_IDS,
            "detail": f"{'found' if tid in VALID_TOOL_IDS else 'MISSING'}",
        })

    # Check all dep targets exist in VALID_TOOL_IDS
    broken_deps = []
    for tool_id, deps in TOOL_DEPS.items():
        for dep in deps:
            if dep not in VALID_TOOL_IDS:
                broken_deps.append(f"{tool_id} → {dep}")
    results.append({
        "case": "deps_valid",
        "pass": len(broken_deps) == 0,
        "detail": f"broken: {broken_deps}" if broken_deps else "all deps valid",
    })

    passed = sum(1 for r in results if r["pass"])
    return {
        "test": "tool_index_completeness",
        "passed": passed,
        "total": len(results),
        "results": results,
    }


# ── Test 3: Fallback Selection ───────────────────────────────────────────

def test_fallback_selection():
    """Verify fallback uses deterministic planner when LLM fails."""
    from ml.api.agent_tool_selector import _fallback_selection
    from ml.api.kpi_calculator import _detect_role
    import pandas as pd

    # Build a profile with sales data
    profile = {"sheets": {
        "sales_transactions": {
            "row_count": 100,
            "columns": {
                "order_date": {"role": "date"},
                "gross_revenue": {"role": "revenue"},
                "cogs": {"role": "cost"},
                "product_code": {"role": "text"},
            },
        }
    }}

    results = []
    fallback = _fallback_selection(profile)

    results.append({
        "case": "fallback_non_empty",
        "pass": len(fallback) > 0,
        "detail": f"fallback={fallback}",
    })

    results.append({
        "case": "fallback_has_cleaning",
        "pass": "run_mbr_cleaning" in fallback,
        "detail": f"{'found' if 'run_mbr_cleaning' in fallback else 'MISSING'}",
    })

    passed = sum(1 for r in results if r["pass"])
    return {
        "test": "fallback_selection",
        "passed": passed,
        "total": len(results),
        "results": results,
    }


# ── Run All ──────────────────────────────────────────────────────────────

def run_all():
    """Run all deterministic eval specs (no LLM needed)."""
    tests = [
        test_dependency_resolver(),
        test_tool_index_completeness(),
        test_fallback_selection(),
    ]
    total_passed = sum(t["passed"] for t in tests)
    total = sum(t["total"] for t in tests)
    return {
        "suite": "agent_selector",
        "passed": total_passed,
        "total": total,
        "tests": tests,
    }
