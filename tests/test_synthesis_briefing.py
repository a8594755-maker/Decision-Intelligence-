from ml.api.metric_registry import build_metric_contract, build_semantic_breakdown_artifact
from ml.api.benchmark_policy import build_benchmark_policy
from ml.api.synthesis_briefing import (
    compute_priority_scores,
    build_causal_context,
    build_role_briefing,
    build_key_metrics_table,
    sanitize_output,
)


def _make_test_artifacts():
    scalar = {
        "type": "table", "label": "Overall KPIs",
        "data": [{"total_revenue": 2296635.0, "total_profit": 286397.0,
                  "gross_margin_pct": 12.47, "avg_lead_time_days": 3.97}],
    }
    margin = build_semantic_breakdown_artifact(
        "profit_margin_by_category",
        {"Furniture": 2.49, "Technology": 17.40, "Office Supplies": 17.03},
    )
    revenue = build_semantic_breakdown_artifact(
        "total_revenue_by_category",
        {"Furniture": 741999.8, "Technology": 836154.0, "Office Supplies": 718481.2},
    )
    return [scalar, margin, revenue]


def _make_contracts(arts):
    mc = build_metric_contract(arts)
    bp = build_benchmark_policy(mc)
    return mc, bp


def test_priority_ranking_puts_bad_outliers_first():
    mc, bp = _make_contracts(_make_test_artifacts())
    scored = compute_priority_scores(mc, bp)
    top = scored[0]
    assert top["ref_id"] == "margin_pct:Furniture"
    assert top["is_bad"] is True
    assert top["priority_score"] > 0


def test_causal_context_links_outlier_to_supporting_metrics():
    mc, bp = _make_contracts(_make_test_artifacts())
    scored = compute_priority_scores(mc, bp)
    causal = build_causal_context(scored, mc)
    furniture_causal = [c for c in causal if c["dimension_value"] == "Furniture"]
    assert len(furniture_causal) >= 1
    # Furniture margin should have revenue as explanation candidate
    has_revenue = any("revenue" in mid for c in furniture_causal for mid in c["explanation_candidates"])
    assert has_revenue


def test_role_briefing_shows_real_numbers_not_placeholders():
    mc, bp = _make_contracts(_make_test_artifacts())
    scored = compute_priority_scores(mc, bp)
    causal = build_causal_context(scored, mc)
    fc = [{"label": "Forecast", "measure_name": "demand_units", "value_unit": "count", "series_granularity": "daily"}]

    fin = build_role_briefing("financial", scored, causal, fc, [])
    ops = build_role_briefing("operational", scored, causal, fc, [])

    # Financial should have real numbers, not [[placeholders]]
    assert "[[" not in fin
    assert "12.47" in fin  # gross_margin_pct value
    assert "$2,296,635" in fin  # total_revenue value

    # Operational should have lead time and forecast
    assert "3.97" in ops  # avg_lead_time_days
    assert "demand_units" in ops
    assert "granularity=daily" in ops

    # Financial should NOT have forecast contract section
    assert "Forecast Contract" not in fin


def test_sanitize_output_strips_stray_brackets():
    dirty = "Revenue is [[total_revenue]] and [UNRESOLVED: something] happened."
    clean = sanitize_output(dirty)
    assert "[[" not in clean
    assert "[UNRESOLVED" not in clean
    assert "total_revenue" in clean
    assert "something" in clean


def test_key_metrics_table_includes_outliers():
    mc, bp = _make_contracts(_make_test_artifacts())
    scored = compute_priority_scores(mc, bp)
    table = build_key_metrics_table(scored, mc)

    assert "Furniture" in table
    assert "margin" in table.lower()
    assert "-14.72" in table or "-14.73" in table  # delta
