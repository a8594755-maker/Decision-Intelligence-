"""
variance_spec.py — Test specs for Variance Analyzer
"""

from ml.api.tool_eval import ToolTestSpec, exists, custom


SPECS = [
    ToolTestSpec(
        tool_id="variance_analyzer",
        scenario="basic_variance",
        description="Simple actual vs target with known variance",
        run_fn="ml.api.variance_analyzer.execute_variance_pipeline",
        input_data={
            "sales": [
                {"period": "2025-01", "region": "Taiwan", "category": "Cleaning", "revenue": 70000},
                {"period": "2025-01", "region": "Taiwan", "category": "Laundry", "revenue": 120000},
            ],
            "budget": [
                {"period": "2025-01", "region": "Taiwan", "category": "Cleaning", "revenue_target": 100000},
                {"period": "2025-01", "region": "Taiwan", "category": "Laundry", "revenue_target": 100000},
            ],
        },
        tags=["fast", "core"],
        assertions=[
            exists("has_artifacts", "artifacts"),
            custom("has_analysis_table", lambda r: _has_artifact_with(r, "contribution")),
        ],
    ),
]


def _has_artifact_with(result, keyword):
    for art in result.get("artifacts", []):
        if keyword.lower() in (art.get("label") or "").lower():
            return True, f"Found artifact with '{keyword}'"
    return False, f"No artifact with '{keyword}' found"
