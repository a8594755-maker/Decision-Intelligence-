from ml.api.metric_registry import (
    build_metric_contract,
    build_semantic_breakdown_artifact,
)


def test_metric_contract_distinguishes_discount_aggregation_modes():
    discount_breakdown = build_semantic_breakdown_artifact(
        "avg_discount_by_category",
        {
            "Furniture": 0.17,
            "Technology": 0.13,
        },
    )
    artifacts = [
        {
            "type": "table",
            "label": "Overall KPIs",
            "data": [{
                "total_revenue": 2296635.0,
                "gross_margin_pct": 12.46,
                "effective_discount_rate": 0.07,
            }],
        },
        discount_breakdown,
    ]

    contract = build_metric_contract(artifacts)

    scalar_ids = {metric["metric_id"] for metric in contract["scalar_metrics"]}
    breakdown_ids = {breakdown["metric_id"] for breakdown in contract["breakdowns"]}
    warning_codes = {warning["code"] for warning in contract["warnings"]}

    assert "effective_discount_rate_weighted" in scalar_ids
    assert "avg_discount_rate_unweighted" in breakdown_ids
    assert "ambiguous_metric_family" in warning_codes


def test_metric_contract_extracts_margin_breakdown_dimension_and_definition():
    artifacts = [
        {
            "type": "table",
            "label": "Margin by Category",
            "data": [
                {"name": "Furniture", "revenue": 741999.8, "profit": 51891.0, "margin_pct": 6.99},
                {"name": "Technology", "revenue": 836154.0, "profit": 145454.9, "margin_pct": 17.40},
            ],
        },
    ]

    contract = build_metric_contract(artifacts)

    assert len(contract["breakdowns"]) == 1
    breakdown = contract["breakdowns"][0]
    assert breakdown["dimension"] == "category"
    assert breakdown["metric_id"] == "margin_pct"
    assert breakdown["aggregation"] == "ratio_of_sums"


def test_metric_contract_resolves_conflicting_scalar_metrics_to_canonical_source():
    artifacts = [
        {
            "type": "table",
            "label": "Revenue Summary",
            "data": [{
                "gross_margin": 290001.0,
                "total_revenue": 2296635.0,
            }],
        },
        {
            "type": "table",
            "label": "Overall KPIs",
            "data": [{
                "gross_margin": 286300.0,
                "total_revenue": 2296635.0,
            }],
        },
    ]

    contract = build_metric_contract(artifacts)

    gross_margin = next(metric for metric in contract["scalar_metrics"] if metric["metric_id"] == "gross_margin")
    warning_codes = {warning["code"] for warning in contract["warnings"]}

    assert gross_margin["value"] == 286300.0
    assert gross_margin["source_artifact"] == "Overall KPIs"
    assert "conflicting_metric_values" in warning_codes
    assert contract["scalar_metric_conflicts"][0]["metric_id"] == "gross_margin"


def test_quarantine_excludes_date_sums_and_id_sums_but_keeps_derived_metrics():
    artifacts = [
        {
            "type": "table",
            "label": "Overall KPIs",
            "data": [{
                "total_revenue": 2296635.0,
                "avg_lead_time_days": 3.97,
                "days_of_supply": 42.5,
                "order_date": 47829163,
                "ship_date": 48291432,
                "row_id": 999945000,
                "postal_code": 3981723456,
            }],
        },
    ]

    contract = build_metric_contract(artifacts)
    canonical_ids = {m["metric_id"] for m in contract["scalar_metrics"]}
    quarantined_ids = {m["metric_id"] for m in contract["quarantined_metrics"]}

    # Real KPIs should survive
    assert "total_revenue" in canonical_ids
    assert "avg_lead_time_days" in canonical_ids
    assert "days_of_supply" in canonical_ids

    # Garbage should be quarantined
    assert "order_date" in quarantined_ids
    assert "ship_date" in quarantined_ids
    assert "row_id" in quarantined_ids
    assert "postal_code" in quarantined_ids

    # Quarantined metrics should NOT appear in canonical
    assert not canonical_ids & quarantined_ids

    # Should have quarantine warnings
    warning_codes = {w["code"] for w in contract["warnings"]}
    assert "quarantined_metric" in warning_codes


def test_semantic_breakdown_artifact_avoids_generic_value_column():
    artifact = build_semantic_breakdown_artifact(
        "profit_margin_by_category",
        {"Furniture": 6.99, "Technology": 17.4},
    )

    assert artifact is not None
    assert artifact["metric_id"] == "margin_pct"
    assert artifact["dimension"] == "category"
    assert "value" not in artifact["data"][0]
    assert set(artifact["data"][0].keys()) == {"category", "margin_pct"}
