"""
_template_spec.py — Copy this to create tests for a new tool

1. Copy: cp _template_spec.py my_tool_spec.py
2. Fill in the blanks
3. Run: python -m ml.api.tool_eval --tool my_tool
"""

from ml.api.tool_eval import (
    ToolTestSpec, close, equals, contains, not_contains,
    exists, truthy, count, in_range, custom,
)

SPECS = [
    ToolTestSpec(
        tool_id="my_tool",
        scenario="basic",
        description="Describe what this test checks",
        run_fn="ml.api.my_module.my_function",
        input_data={
            "sheet_name": [
                {"col1": "val1", "col2": 100},
            ]
        },
        tags=["fast"],
        requires_llm=False,
        assertions=[
            exists("has_artifacts", "artifacts"),
            count("artifact_count", "artifacts", 1, 50),
            # close("revenue_is_300", "result.total_revenue", 300, tolerance_pct=1.0),
            # contains("has_keyword", "summary_for_narrative", "revenue"),
            # custom("check", lambda r: (True, "ok")),
        ],
    ),
]
