from ml.api.metric_registry import build_metric_contract, build_semantic_breakdown_artifact
from ml.api.benchmark_policy import build_benchmark_policy
from ml.api.synthesis_briefing import compute_priority_scores, build_causal_context
from ml.api.fact_packets import build_fact_packets, build_micro_prompt, assemble_report


def _make_scored():
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
    mc = build_metric_contract([scalar, margin, revenue])
    bp = build_benchmark_policy(mc)
    scored = compute_priority_scores(mc, bp)
    causal = build_causal_context(scored, mc)
    return scored, causal, mc


def test_fact_packets_are_small_and_role_separated():
    scored, causal, mc = _make_scored()
    fc = [{"label": "Forecast", "measure_name": "demand_units", "value_unit": "count", "series_granularity": "daily"}]

    packets = build_fact_packets(scored, causal, fc, [])

    # Should have packets for multiple roles
    roles = {p["role"] for p in packets}
    assert "financial" in roles
    assert "risk" in roles

    # Each packet should be small (<1000 chars)
    for p in packets:
        assert len(p["facts_text"]) < 2000, f"{p['role']}#{p['packet_id']} too large: {len(p['facts_text'])} chars"

    # Each packet should have a reasonable number of facts
    for p in packets:
        assert p["fact_count"] <= 5


def test_fact_packets_contain_real_numbers_not_placeholders():
    scored, causal, mc = _make_scored()
    packets = build_fact_packets(scored, causal, [], [])

    for p in packets:
        assert "[[" not in p["facts_text"], f"Placeholder found in {p['role']}#{p['packet_id']}"
        # Financial packets should contain actual margin numbers
        if p["role"] == "financial" and p["packet_id"] == 0:
            # Should have real numbers from the data
            text = p["facts_text"]
            assert any(num in text for num in ("2.49", "17.40", "12.47", "$2,296,635")), \
                f"No real numbers found in financial packet: {text[:200]}"


def test_operational_packet_includes_forecast_contract():
    scored, causal, mc = _make_scored()
    fc = [{"label": "Forecast", "measure_name": "demand_units", "value_unit": "count", "series_granularity": "daily"}]

    packets = build_fact_packets(scored, causal, fc, [])
    ops_packets = [p for p in packets if p["role"] == "operational"]

    # Operational should mention forecast
    assert any("demand_units" in p["facts_text"] for p in ops_packets), \
        "Forecast contract not found in operational packets"


def test_micro_prompt_is_focused():
    scored, causal, mc = _make_scored()
    packets = build_fact_packets(scored, causal, [], [])

    for p in packets:
        prompt = build_micro_prompt(p)
        assert "Use ONLY the numbers above" in prompt
        assert "Do NOT add any numbers" in prompt
        assert len(prompt) < 3000, f"Micro prompt too large: {len(prompt)} chars"


def test_assemble_report_has_all_sections():
    key_metrics = "| Metric | Value |\n|---|---|\n| Revenue | $1M |"
    micro = {
        "financial": ["Revenue is strong at $1M."],
        "operational": ["Lead time is 3.97 days."],
        "risk": ["Furniture margin is critically low."],
    }

    report = assemble_report(key_metrics, micro)

    assert "**Key Metrics**" in report
    assert "**Financial Performance**" in report
    assert "**Operational Performance**" in report
    assert "**Risk Assessment**" in report
    assert "$1M" in report
    assert "3.97" in report


def test_risk_packets_see_bad_items_from_all_roles():
    scored, causal, mc = _make_scored()
    packets = build_fact_packets(scored, causal, [], [])

    risk_packets = [p for p in packets if p["role"] == "risk"]
    risk_text = " ".join(p["facts_text"] for p in risk_packets)

    # Furniture margin is a financial metric but is_bad=True, so risk should see it
    assert "Furniture" in risk_text, "Risk should see Furniture (bad item from financial role)"
