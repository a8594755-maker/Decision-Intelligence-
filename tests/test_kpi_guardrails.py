"""Tests for KPI guardrails: minimum spec, sanity check, deviation classification."""
import pandas as pd
from ml.api.kpi_guardrails import (
    ensure_required_breakdowns,
    sanity_check_contract,
    classify_deviation,
    find_columns,
    find_dimensions,
)


def _make_superstore_df():
    """Minimal Superstore-like DataFrame."""
    return pd.DataFrame([
        {"Category": "Furniture", "Segment": "Consumer", "Region": "East",
         "Sales": 100, "Profit": 5, "Discount": 0.2},
        {"Category": "Technology", "Segment": "Corporate", "Region": "West",
         "Sales": 200, "Profit": 40, "Discount": 0.1},
        {"Category": "Office Supplies", "Segment": "Home Office", "Region": "Central",
         "Sales": 150, "Profit": 25, "Discount": 0.15},
        {"Category": "Furniture", "Segment": "Consumer", "Region": "South",
         "Sales": 80, "Profit": -5, "Discount": 0.3},
    ])


def test_find_columns_detects_revenue_and_profit():
    df = _make_superstore_df()
    roles = find_columns(df)
    assert roles["revenue"] == "Sales"
    assert roles["profit"] == "Profit"
    assert roles["discount"] == "Discount"


def test_find_dimensions_detects_categorical_columns():
    df = _make_superstore_df()
    dims = find_dimensions(df)
    assert "Category" in dims
    assert "Segment" in dims
    assert "Region" in dims


def test_ensure_required_breakdowns_fills_missing_scalars():
    df = _make_superstore_df()
    # Simulate: LLM produced empty results
    extra_results, extra_arts = ensure_required_breakdowns(df, {}, [])

    assert "total_revenue" in extra_results
    assert extra_results["total_revenue"] == 530.0  # 100+200+150+80
    assert "total_profit" in extra_results
    assert extra_results["total_profit"] == 65.0  # 5+40+25+(-5)
    assert "gross_margin_pct" in extra_results
    assert abs(extra_results["gross_margin_pct"] - 12.26) < 0.1

    # Should have margin breakdowns for Category, Segment, Region
    art_labels = [a.get("label", "") for a in extra_arts]
    assert any("Category" in l for l in art_labels)
    assert any("Segment" in l for l in art_labels)


def test_ensure_required_breakdowns_doesnt_duplicate():
    df = _make_superstore_df()
    # Simulate: LLM already produced total_revenue and category margin
    existing_results = {"total_revenue": 530.0, "total_profit": 65.0, "gross_margin_pct": 12.26}
    existing_arts = [{"metric_id": "margin_pct", "dimension": "category", "label": "Margin by Category"}]

    extra_results, extra_arts = ensure_required_breakdowns(df, existing_results, existing_arts)

    # Should NOT re-add total_revenue (already exists and non-zero)
    assert "total_revenue" not in extra_results

    # Should NOT re-add category margin (already exists)
    category_arts = [a for a in extra_arts if "Category" in a.get("label", "")]
    assert len(category_arts) == 0

    # Should still add Segment and Region breakdowns (missing)
    assert any("Segment" in a.get("label", "") for a in extra_arts)
    assert any("Region" in a.get("label", "") for a in extra_arts)


def test_sanity_check_catches_gross_margin_equals_revenue():
    contract = {
        "scalar_metrics": [
            {"metric_id": "total_revenue", "value": 2296635.0},
            {"metric_id": "gross_margin", "value": 2296635.0},  # BUG: same as revenue
            {"metric_id": "gross_margin_pct", "value": 12.46},
        ],
        "scalar_metric_conflicts": [],
    }
    issues = sanity_check_contract(contract)
    codes = {i["code"] for i in issues}
    assert "gross_margin_equals_revenue" in codes


def test_sanity_check_catches_revenue_zero():
    contract = {
        "scalar_metrics": [
            {"metric_id": "total_revenue", "value": 0.0},
        ],
        "scalar_metric_conflicts": [],
    }
    issues = sanity_check_contract(contract)
    codes = {i["code"] for i in issues}
    assert "revenue_zero_or_negative" in codes


def test_sanity_check_passes_clean_data():
    contract = {
        "scalar_metrics": [
            {"metric_id": "total_revenue", "value": 2296635.0},
            {"metric_id": "total_profit", "value": 286262.0},
            {"metric_id": "gross_margin_pct", "value": 12.46},
            {"metric_id": "gross_margin", "value": 286262.0},
        ],
        "scalar_metric_conflicts": [],
    }
    issues = sanity_check_contract(contract)
    assert len(issues) == 0


def test_classify_deviation_structural_vs_problematic():
    # Share metric: big segment being big is structural
    structural = classify_deviation({
        "type": "breakdown_row", "metric_id": "share_pct",
        "delta": 44.3, "direction": "unknown", "is_bad": False,
    })
    assert structural == "structural"

    # Margin metric: being below benchmark is problematic
    problematic = classify_deviation({
        "type": "breakdown_row", "metric_id": "margin_pct",
        "delta": -14.7, "direction": "higher_better", "is_bad": True,
    })
    assert problematic == "problematic"

    # Revenue total: being above benchmark is structural
    structural2 = classify_deviation({
        "type": "breakdown_row", "metric_id": "total_revenue",
        "delta": 105000, "direction": "higher_better", "is_bad": False,
    })
    assert structural2 == "structural"
