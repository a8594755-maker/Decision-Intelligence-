"""
mbr_eval.py — Automated Evaluation Framework for MBR Agent

Run after every code change:
    python -m ml.api.mbr_eval

Or specific test:
    python -m ml.api.mbr_eval --test kpi
    python -m ml.api.mbr_eval --test summarizer

Or full E2E (requires DeepSeek API):
    python -m ml.api.mbr_eval --e2e
"""

import json
import time
import sys
import os
import traceback
from dataclasses import dataclass, field
from typing import Optional

import pandas as pd
import numpy as np


# ================================================================
# Part 1: TEST RESULT TRACKING
# ================================================================

@dataclass
class TestResult:
    name: str
    passed: bool
    expected: str = ""
    actual: str = ""
    detail: str = ""
    duration_ms: int = 0


@dataclass
class EvalReport:
    results: list = field(default_factory=list)
    total_duration_ms: int = 0

    def add(self, result: TestResult):
        self.results.append(result)

    @property
    def passed(self):
        return sum(1 for r in self.results if r.passed)

    @property
    def failed(self):
        return sum(1 for r in self.results if not r.passed)

    @property
    def total(self):
        return len(self.results)

    def print_report(self):
        print(f"\n{'='*70}")
        print(f"MBR EVAL REPORT")
        print(f"{'='*70}")
        print(f"Total: {self.total} | Pass: {self.passed} | Fail: {self.failed} | "
              f"Duration: {self.total_duration_ms/1000:.1f}s")
        print(f"{'='*70}\n")

        for r in self.results:
            status = "\u2705" if r.passed else "\u274C"
            print(f"  {status} {r.name} ({r.duration_ms}ms)")
            if not r.passed:
                if r.expected:
                    print(f"     Expected: {r.expected}")
                if r.actual:
                    print(f"     Actual:   {r.actual}")
                if r.detail:
                    print(f"     Detail:   {r.detail}")

        print(f"\n{'='*70}")
        if self.failed == 0:
            print("ALL TESTS PASSED \u2705")
        else:
            print(f"{self.failed} TEST(S) FAILED \u274C")
        print(f"{'='*70}\n")

        return self.failed == 0


# ================================================================
# Part 2: GOLDEN DATASETS
# ================================================================

GOLDEN_SIMPLE = {
    "name": "simple_2row",
    "description": "Minimal 2-row sales data",
    "input": {
        "Sales": [
            {"month": "Jan", "region": "APAC", "revenue": 100000, "units": 50, "cogs": 40000},
            {"month": "Feb", "region": "APAC", "revenue": 120000, "units": 65, "cogs": 48000},
        ]
    },
    "expected_kpi": {
        "total_revenue": 220000,
        "tolerance": 0.01,
    },
    "expected_margin": {
        "total_cogs": 88000,
        "gross_margin": 132000,
        "margin_pct": 60.0,
        "tolerance": 0.01,
    },
}

GOLDEN_MULTI_SHEET = {
    "name": "multi_sheet",
    "description": "Sales + Budget + Inventory",
    "input": {
        "sales_data": [
            {"order_date": "2025-01-05", "period": "2025-01", "region": "Taiwan", "category": "Cleaning",
             "product_sku": "PB-CLN01", "qty_ordered": 100, "gross_revenue": 50000, "cogs": 20000, "currency": "TWD"},
            {"order_date": "2025-01-15", "period": "2025-01", "region": "Taiwan", "category": "Laundry",
             "product_sku": "PB-LAU01", "qty_ordered": 200, "gross_revenue": 80000, "cogs": 35000, "currency": "TWD"},
            {"order_date": "2025-02-10", "period": "2025-02", "region": "Taiwan", "category": "Cleaning",
             "product_sku": "PB-CLN01", "qty_ordered": 150, "gross_revenue": 75000, "cogs": 30000, "currency": "TWD"},
            {"order_date": "2025-02-20", "period": "2025-02", "region": "ASEAN", "category": "Laundry",
             "product_sku": "PB-LAU01", "qty_ordered": 80, "gross_revenue": 32000, "cogs": 14000, "currency": "USD"},
        ],
        "monthly_budget": [
            {"period": "2025-01", "region": "Taiwan", "category": "Cleaning", "revenue_target": 60000},
            {"period": "2025-01", "region": "Taiwan", "category": "Laundry", "revenue_target": 70000},
            {"period": "2025-02", "region": "Taiwan", "category": "Cleaning", "revenue_target": 80000},
            {"period": "2025-02", "region": "ASEAN", "category": "Laundry", "revenue_target": 40000},
        ],
        "inventory_snapshot": [
            {"product_sku": "PB-CLN01", "qty_on_hand": 500, "unit_cost": 200, "safety_stock": 100},
            {"product_sku": "PB-LAU01", "qty_on_hand": 300, "unit_cost": 175, "safety_stock": 50},
            {"product_sku": "PB-BAD01", "qty_on_hand": -10, "unit_cost": 50, "safety_stock": 20},
        ],
    },
    "expected_kpi": {
        "total_revenue": 237000,
        "tolerance": 0.01,
    },
    "expected_variance": {
        "total_actual": 237000,
        "total_target": 250000,
        "attainment_pct": 94.8,
        "tolerance": 1.0,
    },
    "expected_anomalies": {
        "has_negative_inventory": True,
    },
    "expected_currencies": ["TWD", "USD"],
}


# ================================================================
# Part 3: ASSERTION HELPERS
# ================================================================

def assert_close(name, actual, expected, tolerance_pct, report):
    if actual is None:
        report.add(TestResult(name=name, passed=False, expected=str(expected), actual="None", detail="Value is None"))
        return False
    diff_pct = abs(actual - expected) / max(abs(expected), 0.01) * 100
    passed = diff_pct <= tolerance_pct
    report.add(TestResult(name=name, passed=passed, expected=f"{expected:,.2f} (\u00B1{tolerance_pct}%)", actual=f"{actual:,.2f} (diff: {diff_pct:.2f}%)"))
    return passed


def assert_true(name, condition, detail="", report=None):
    report.add(TestResult(name=name, passed=condition, detail=detail))
    return condition


def assert_contains(name, text, substring, report):
    passed = substring.lower() in text.lower()
    report.add(TestResult(name=name, passed=passed, expected=f"contains '{substring}'", actual=text[:100] if not passed else "OK"))
    return passed


def assert_not_contains(name, text, substring, report):
    passed = substring.lower() not in text.lower()
    report.add(TestResult(name=name, passed=passed, expected=f"does NOT contain '{substring}'", actual=f"Found '{substring}' in text" if not passed else "OK"))
    return passed


# ================================================================
# Part 4: KPI CALCULATOR TESTS
# ================================================================

def test_kpi_calculation(report):
    from ml.api.kpi_calculator import profile_for_kpi, build_kpi_config_from_profile, KpiCalculator

    for golden in [GOLDEN_SIMPLE, GOLDEN_MULTI_SHEET]:
        prefix = f"kpi/{golden['name']}"
        t0 = time.time()

        try:
            profile = profile_for_kpi(golden["input"])
            assert_true(f"{prefix}/profile_not_empty", len(profile.get("sheets", {})) > 0,
                        detail=f"Got {len(profile.get('sheets', {}))} sheets", report=report)

            config = build_kpi_config_from_profile(profile)
            assert_true(f"{prefix}/config_generated", config is not None and len(config.get("calculations", [])) > 0,
                        detail=f"Got {len(config.get('calculations', [])) if config else 0} calculations", report=report)

            if not config:
                continue

            dfs = {name: pd.DataFrame(data) for name, data in golden["input"].items() if data}
            calc = KpiCalculator(dfs)
            result = calc.calculate(config)

            if "expected_kpi" in golden:
                exp = golden["expected_kpi"]
                actual_rev = result.get("result", {}).get("total_revenue")
                if actual_rev is None:
                    for art in result.get("artifacts", []):
                        if "overall revenue" in art.get("label", "").lower():
                            data = art.get("data", [])
                            if data and isinstance(data[0], dict):
                                actual_rev = data[0].get("value") or data[0].get("Total Revenue")
                assert_close(f"{prefix}/total_revenue", actual_rev, exp["total_revenue"], exp.get("tolerance", 1.0), report)

            if "expected_margin" in golden:
                exp = golden["expected_margin"]
                margin_art = None
                for art in result.get("artifacts", []):
                    if "overall" in art.get("label", "").lower() and "margin" in art.get("label", "").lower():
                        margin_art = art
                        break
                if margin_art and margin_art.get("data"):
                    row = margin_art["data"][0]
                    assert_close(f"{prefix}/margin_pct", row.get("margin_pct"), exp["margin_pct"], exp.get("tolerance", 1.0), report)
                    assert_close(f"{prefix}/total_cogs", row.get("total_cogs"), exp["total_cogs"], exp.get("tolerance", 1.0), report)
                else:
                    report.add(TestResult(name=f"{prefix}/margin_artifact", passed=False, detail="No Overall Gross Margin artifact found"))

        except Exception as e:
            report.add(TestResult(name=f"{prefix}/exception", passed=False, detail=f"{type(e).__name__}: {str(e)[:200]}"))

        duration = int((time.time() - t0) * 1000)
        for r in report.results:
            if r.name.startswith(prefix) and r.duration_ms == 0:
                r.duration_ms = duration


# ================================================================
# Part 5: ROLE DETECTION TESTS
# ================================================================

def test_role_detection(report):
    from ml.api.kpi_calculator import _detect_role

    test_cases = [
        ("gross_revenue", "revenue"),
        ("net_revenue", "revenue"),
        ("revenue", "revenue"),
        ("cogs", "cost"),
        ("unit_cost", "cost"),
        ("order_date", "date"),
        ("invoice_date", "date"),
        ("period", "date"),
        ("region", "category"),
        ("channel", "category"),
        ("department", "category"),
        ("product_sku", "id"),
        ("order_id", "id"),
        ("revenue_target", "target"),
        ("qty_ordered", "quantity"),
        ("qty_on_hand", "quantity"),
        ("discount_pct", "percentage"),
    ]

    dummy_series = pd.Series(["a", "b", "c"])
    for col_name, expected_role in test_cases:
        actual = _detect_role(col_name, dummy_series)
        report.add(TestResult(name=f"role/{col_name}", passed=actual == expected_role, expected=expected_role, actual=actual))


# ================================================================
# Part 6: SUMMARIZER TESTS
# ================================================================

def test_summarizer_output(report):
    from ml.api.mbr_agent import summarize_tool_output

    # Variance: should prioritize target variance over waterfall
    mock_variance = {
        "artifacts": [
            {"type": "table", "label": "Waterfall Summary (2025-02 to 2025-03)", "data": [
                {"component": "Total Delta", "value": 907151.51},
                {"component": "Volume Effect", "value": -128114.43},
            ]},
            {"type": "table", "label": "Actual vs Target Variance", "data": [
                {"period": "2025-01", "region": "Taiwan", "category": "Cleaning",
                 "actual": 696887, "target": 1984078, "variance": -1287191, "variance_pct": -64.88},
                {"period": "2025-01", "region": "Taiwan", "category": "Laundry",
                 "actual": 1207543, "target": 1147790, "variance": 59753, "variance_pct": 5.21},
            ]},
        ],
    }

    summary = summarize_tool_output("variance_analysis", mock_variance)
    assert_contains("summarizer/variance_has_attainment", summary, "attainment", report)
    assert_contains("summarizer/variance_has_actual", summary, "actual=", report)
    assert_true("summarizer/variance_not_waterfall_first", not summary.lower().startswith("mom waterfall"),
                detail=f"Starts with: {summary[:50]}", report=report)

    # Margin: should extract numbers from artifacts
    mock_margin = {
        "summary_for_narrative": "",
        "artifacts": [{"type": "table", "label": "Overall Gross Margin", "data": [
            {"total_revenue": 12155895, "total_cogs": 5306877, "gross_margin": 6849018, "margin_pct": 56.34}
        ]}],
    }
    margin_summary = summarize_tool_output("margin_analysis", mock_margin)
    assert_contains("summarizer/margin_has_numbers", margin_summary, "56.3", report)
    assert_not_contains("summarizer/margin_not_generic", margin_summary, "Margin analysis complete", report)

    # Inventory: should show critical items
    mock_inv = {
        "artifacts": [{"type": "table", "label": "Inventory Health", "data": [
            {"product_sku": "PB-CLN01", "qty_on_hand": 500, "status": "healthy"},
            {"product_sku": "PB-BAD01", "qty_on_hand": -200, "status": "critical"},
        ]}],
    }
    inv_summary = summarize_tool_output("inventory_health", mock_inv)
    assert_contains("summarizer/inventory_has_critical", inv_summary, "critical", report)
    assert_contains("summarizer/inventory_has_sku", inv_summary, "PB-BAD01", report)


# ================================================================
# Part 7: INSIGHT GENERATION TESTS
# ================================================================

def test_insight_generation(report):
    try:
        from ml.api.mbr_report_builder import generate_insight_from_artifact
    except ImportError:
        report.add(TestResult(name="insight/import", passed=False, detail="generate_insight_from_artifact not found"))
        return

    expense_art = {
        "label": "Expense by Department",
        "data": [
            {"department": "Marketing", "amount": 644288},
            {"department": "R&D", "amount": 457801},
            {"department": "HR", "amount": 360716},
            {"department": "Sales", "amount": 250745},
        ],
    }

    insight = generate_insight_from_artifact(expense_art)
    assert_true("insight/expense_not_none", insight is not None, detail="Should generate insight", report=report)
    if insight:
        assert_contains("insight/expense_highest_is_marketing", insight, "Marketing", report)
        assert_contains("insight/expense_has_number", insight, "644", report)


# ================================================================
# Part 8: CURRENCY DETECTION TESTS
# ================================================================

def test_currency_detection(report):
    test_artifacts = [
        {"data": [{"currency": "TWD", "revenue": 100}, {"currency": "USD", "revenue": 200}]},
        {"data": [{"currency": "TWD", "revenue": 300}]},
    ]

    detected = set()
    for art in test_artifacts:
        for row in art.get("data", []):
            cur = row.get("currency")
            if cur and isinstance(cur, str) and len(cur) <= 5:
                detected.add(cur.upper())

    assert_true("currency/detects_multiple", len(detected) > 1, detail=f"Found: {detected}", report=report)
    assert_true("currency/has_TWD", "TWD" in detected, report=report)
    assert_true("currency/has_USD", "USD" in detected, report=report)


# ================================================================
# Part 9: E2E TEST (requires LLM)
# ================================================================

async def test_e2e(report):
    from ml.api.mbr_agent import run_mbr_agent

    golden = GOLDEN_MULTI_SHEET
    t0 = time.time()

    try:
        result = await run_mbr_agent(sheets_data=golden["input"], filename="eval_test.xlsx")
        duration = int((time.time() - t0) * 1000)

        assert_true("e2e/completed", result.get("narrative") is not None,
                     detail=f"Duration: {duration}ms", report=report)

        n_artifacts = len(result.get("all_artifacts", []))
        assert_true("e2e/has_artifacts", n_artifacts > 0, detail=f"Got {n_artifacts} artifacts", report=report)

        narrative = result.get("narrative", "")
        assert_true("e2e/narrative_not_empty", len(narrative) > 100,
                     detail=f"Narrative length: {len(narrative)}", report=report)

        if golden.get("expected_variance"):
            assert_not_contains("e2e/narrative_has_variance", narrative, "variance data were not provided", report)

        if len(golden.get("expected_currencies", [])) > 1:
            assert_not_contains("e2e/no_false_thb", narrative, "THB", report)

        assert_not_contains("e2e/no_placeholder_x", narrative, "X THB", report)

    except Exception as e:
        report.add(TestResult(name="e2e/exception", passed=False,
                              detail=f"{type(e).__name__}: {str(e)[:300]}\n{traceback.format_exc()[-200:]}"))


# ================================================================
# Part 10: TEST RUNNER
# ================================================================

def run_fast_tests():
    report = EvalReport()
    t0 = time.time()
    print("Running fast tests (no LLM)...\n")
    test_role_detection(report)
    test_kpi_calculation(report)
    test_summarizer_output(report)
    test_insight_generation(report)
    test_currency_detection(report)
    report.total_duration_ms = int((time.time() - t0) * 1000)
    return report


async def run_all_tests():
    report = EvalReport()
    t0 = time.time()
    print("Running all tests (including E2E with LLM)...\n")
    test_role_detection(report)
    test_kpi_calculation(report)
    test_summarizer_output(report)
    test_insight_generation(report)
    test_currency_detection(report)
    await test_e2e(report)
    report.total_duration_ms = int((time.time() - t0) * 1000)
    return report


def main():
    import asyncio

    args = sys.argv[1:]
    test_filter = None
    run_e2e = False

    for i, arg in enumerate(args):
        if arg == "--test" and i + 1 < len(args):
            test_filter = args[i + 1]
        if arg == "--e2e":
            run_e2e = True

    if test_filter == "e2e" or run_e2e:
        report = asyncio.run(run_all_tests())
    elif test_filter:
        report = EvalReport()
        t0 = time.time()
        test_map = {
            "kpi": test_kpi_calculation,
            "role": test_role_detection,
            "summarizer": test_summarizer_output,
            "insight": test_insight_generation,
            "currency": test_currency_detection,
        }
        fn = test_map.get(test_filter)
        if fn:
            fn(report)
        else:
            print(f"Unknown test: {test_filter}. Available: {', '.join(test_map.keys())}, e2e")
            sys.exit(1)
        report.total_duration_ms = int((time.time() - t0) * 1000)
    else:
        report = run_fast_tests()

    success = report.print_report()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
