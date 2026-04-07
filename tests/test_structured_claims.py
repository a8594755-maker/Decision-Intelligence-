from ml.api.metric_registry import build_metric_contract, build_semantic_breakdown_artifact
from ml.api.benchmark_policy import build_benchmark_policy
from ml.api.synthesis_briefing import compute_priority_scores
from ml.api.structured_claims import (
    build_valid_metric_ids,
    build_claims_schema,
    validate_claims,
    build_ref_values,
    parse_claims_response,
)


def _make_scored():
    scalar = {
        "type": "table", "label": "Overall KPIs",
        "data": [{"total_revenue": 2296635.0, "gross_margin_pct": 12.47}],
    }
    margin = build_semantic_breakdown_artifact(
        "profit_margin_by_category",
        {"Furniture": 2.49, "Technology": 17.40, "Office Supplies": 17.03},
    )
    mc = build_metric_contract([scalar, margin])
    bp = build_benchmark_policy(mc)
    scored = compute_priority_scores(mc, bp)
    return scored, mc


def test_valid_metric_ids_includes_scalars_and_breakdowns():
    scored, mc = _make_scored()
    ids = build_valid_metric_ids(scored)

    assert "total_revenue" in ids
    assert "gross_margin_pct" in ids
    assert "margin_pct:Furniture" in ids
    assert "margin_pct:Technology" in ids


def test_claims_schema_has_enum_constraint():
    scored, mc = _make_scored()
    ids = build_valid_metric_ids(scored)
    schema = build_claims_schema(ids, "financial")

    # The metric_ref field should be an enum
    metric_ref_schema = schema["properties"]["claims"]["items"]["properties"]["metric_ref"]
    assert "enum" in metric_ref_schema
    assert "margin_pct:Furniture" in metric_ref_schema["enum"]
    assert "total_revenue" in metric_ref_schema["enum"]

    # Made-up IDs should NOT be in enum
    assert "total_profit:Copiers" not in metric_ref_schema["enum"]
    assert "total_revenue:California" not in metric_ref_schema["enum"]


def test_validate_claims_accepts_valid_and_rejects_invalid():
    scored, mc = _make_scored()
    ids = set(build_valid_metric_ids(scored))

    claims_data = {
        "claims": [
            {"metric_ref": "margin_pct:Furniture", "assessment": "critically_low",
             "confidence": "data_proven", "insight": "Very low margin"},
            {"metric_ref": "total_profit:Copiers", "assessment": "strong",
             "confidence": "data_proven", "insight": "This ref does not exist"},
        ],
        "top_risk": "margin_pct:Furniture",
        "data_gaps": [],
    }

    valid, errors = validate_claims(claims_data, ids)
    assert len(valid) == 1
    assert valid[0]["metric_ref"] == "margin_pct:Furniture"
    assert len(errors) == 1
    assert "total_profit:Copiers" in errors[0]


def test_ref_values_maps_all_metrics():
    scored, mc = _make_scored()
    ref_vals = build_ref_values(scored, mc)

    assert "total_revenue" in ref_vals
    assert "margin_pct:Furniture" in ref_vals
    assert ref_vals["margin_pct:Furniture"] == "2.49"


def test_parse_claims_handles_markdown_fences():
    raw = '```json\n{"claims": [], "top_risk": null, "data_gaps": []}\n```'
    result = parse_claims_response(raw)
    assert result is not None
    assert result["claims"] == []

    raw2 = '{"claims": [{"metric_ref": "x"}], "top_risk": "x", "data_gaps": []}'
    result2 = parse_claims_response(raw2)
    assert result2 is not None
    assert len(result2["claims"]) == 1
