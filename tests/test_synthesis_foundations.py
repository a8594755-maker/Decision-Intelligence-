from ml.api.benchmark_policy import build_benchmark_policy
from ml.api.forecast_artifact_contract import build_forecast_artifact
from ml.api.metric_registry import build_metric_contract
from ml.api.pre_synthesis_validator import (
    validate_agent_output_text,
    validate_analysis_inputs,
)


def test_benchmark_policy_uses_single_peer_rule_for_breakdown():
    artifacts = [
        {
            "type": "table",
            "label": "Margin by Region",
            "data": [
                {"name": "Central", "margin_pct": 8.5},
                {"name": "East", "margin_pct": 15.4},
                {"name": "South", "margin_pct": 13.2},
                {"name": "West", "margin_pct": 14.1},
            ],
        },
    ]

    contract = build_metric_contract(artifacts)
    policy = build_benchmark_policy(contract)

    assert len(policy["comparisons"]) == 1
    comparison = policy["comparisons"][0]
    assert comparison["policy"] == "peer_median_excluding_self"
    assert all(row["benchmark_type"] == "peer_median_excluding_self" for row in comparison["rows"])


def test_validator_flags_empty_lead_time_artifact_and_truncated_output():
    artifacts = [
        {
            "type": "table",
            "label": "Lead Time By Ship Mode",
            "data": [
                {"ship_mode": "Standard Class", "avg_lead_time_days": None},
                {"ship_mode": "First Class", "avg_lead_time_days": None},
            ],
        },
    ]

    contract = build_metric_contract(artifacts)
    report = validate_analysis_inputs(artifacts, contract, {"comparisons": []})
    codes = {issue["code"] for issue in report["issues"]}

    assert "missing_lead_time_values" in codes

    issues = validate_agent_output_text(
        "operations_analysis",
        "Shipping is highly concentrated in Standard Class at",
    )
    assert any(issue["code"] == "truncated_output" for issue in issues)


def test_validator_flags_ambiguous_forecast_contract_and_accepts_explicit_contract():
    ambiguous_artifact = {
        "type": "table",
        "label": "7-Step Forecast",
        "data": [{"day": 1, "p50": 44.0}],
    }
    ambiguous_report = validate_analysis_inputs([ambiguous_artifact], {"warnings": []}, {"comparisons": []})
    ambiguous_codes = {issue["code"] for issue in ambiguous_report["issues"]}

    assert "ambiguous_forecast_unit" in ambiguous_codes
    assert "ambiguous_forecast_measure" in ambiguous_codes
    assert "unknown_forecast_granularity" in ambiguous_codes

    explicit_artifact = build_forecast_artifact(
        predictions=[44.0, 45.0],
        model="naive",
        source_measure_col="Revenue",
        source_date_col="Order Date",
        history_index=["2026-01-01", "2026-01-02"],
    )
    explicit_report = validate_analysis_inputs([explicit_artifact], {"warnings": []}, {"comparisons": []})
    explicit_codes = {issue["code"] for issue in explicit_report["issues"]}

    assert "ambiguous_forecast_unit" not in explicit_codes
    assert "ambiguous_forecast_measure" not in explicit_codes
    assert "unknown_forecast_granularity" not in explicit_codes
