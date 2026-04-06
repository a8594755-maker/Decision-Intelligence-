"""
eda_spec.py — Eval specs for Exploratory Data Analysis

NOTE: JS service (edaService.js). Tests simulate core EDA statistics.
Stats: mean, median, std, min, max, q1, q3, IQR, skewness, kurtosis,
null counts, unique counts, correlation matrix, data quality score.
"""

from ml.api.tool_eval import ToolTestSpec, custom
import math


def _run_eda(input_data):
    """Simulate EDA statistics computation."""
    rows = input_data.get("rows", [])
    columns_filter = input_data.get("columns")
    sample_size = input_data.get("sampleSize", 10000)

    if not rows:
        return {"success": False, "error": "Dataset has no rows"}

    # Sample
    sampled = len(rows) > sample_size
    rows = rows[:sample_size]

    # Detect columns
    all_cols = list(rows[0].keys()) if rows else []
    cols_to_analyze = columns_filter or all_cols

    column_stats = {}
    numeric_cols = []

    for col in cols_to_analyze:
        vals = [r.get(col) for r in rows]
        non_null = [v for v in vals if v is not None]
        null_count = len(vals) - len(non_null)

        stat = {
            "name": col,
            "count": len(non_null),
            "null_count": null_count,
            "null_pct": round(null_count / max(len(vals), 1) * 100, 1),
            "unique_count": len(set(str(v) for v in non_null)),
        }

        # Try numeric
        nums = []
        for v in non_null:
            try:
                nums.append(float(v))
            except (ValueError, TypeError):
                pass

        if len(nums) > len(non_null) * 0.8:
            stat["inferred_type"] = "numeric"
            numeric_cols.append(col)
            nums.sort()
            n = len(nums)
            stat["mean"] = round(sum(nums) / n, 4)
            stat["min"] = nums[0]
            stat["max"] = nums[-1]
            stat["median"] = nums[n // 2]
            stat["q1"] = nums[n // 4]
            stat["q3"] = nums[3 * n // 4]
            stat["iqr"] = round(stat["q3"] - stat["q1"], 4)
            stat["std"] = round((sum((x - stat["mean"]) ** 2 for x in nums) / max(n - 1, 1)) ** 0.5, 4)
        else:
            stat["inferred_type"] = "text"

        column_stats[col] = stat

    # Missing values summary
    missing = {}
    total_missing = 0
    for col in cols_to_analyze:
        null_ct = column_stats[col]["null_count"]
        total_missing += null_ct
        missing[col] = {"missing": null_ct, "missing_pct": column_stats[col]["null_pct"]}

    # Quality score
    total_cells = len(rows) * len(cols_to_analyze)
    completeness = (1 - total_missing / max(total_cells, 1)) * 100

    # Dedup check
    seen = set()
    dupes = 0
    for r in rows:
        key = tuple(sorted(r.items()))
        if key in seen:
            dupes += 1
        seen.add(key)

    uniqueness = ((len(rows) - dupes) / max(len(rows), 1)) * 100
    quality_score = min(100, completeness * 0.5 + uniqueness * 0.3 + (20 if numeric_cols else 10))

    return {
        "success": True,
        "row_count": len(rows),
        "sampled": sampled,
        "column_count": len(cols_to_analyze),
        "columns": column_stats,
        "numeric_cols": numeric_cols,
        "missing_values": missing,
        "data_quality": {
            "completeness": round(completeness, 1),
            "uniqueness": round(uniqueness, 1),
            "duplicates": dupes,
            "quality_score": round(quality_score, 1),
        },
    }


SPECS = [
    ToolTestSpec(
        tool_id="run_eda",
        scenario="basic_numeric_stats",
        description="Compute mean, median, std for numeric column",
        run_fn=_run_eda,
        input_data={
            "rows": [{"val": v} for v in [10, 20, 30, 40, 50]],
        },
        tags=["core"],
        assertions=[
            custom("mean_30", lambda r: (
                abs(r["columns"]["val"]["mean"] - 30) < 0.1,
                f"Mean: {r['columns']['val']['mean']}"
            )),
            custom("min_10", lambda r: (
                r["columns"]["val"]["min"] == 10,
                f"Min: {r['columns']['val']['min']}"
            )),
            custom("max_50", lambda r: (
                r["columns"]["val"]["max"] == 50,
                f"Max: {r['columns']['val']['max']}"
            )),
            custom("detected_numeric", lambda r: (
                r["columns"]["val"]["inferred_type"] == "numeric",
                f"Type: {r['columns']['val']['inferred_type']}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_eda",
        scenario="missing_value_analysis",
        description="Detect and report null percentages",
        run_fn=_run_eda,
        input_data={
            "rows": [
                {"a": 1, "b": None},
                {"a": 2, "b": None},
                {"a": None, "b": 3},
                {"a": 4, "b": 4},
            ],
        },
        tags=["core"],
        assertions=[
            custom("a_25pct_missing", lambda r: (
                abs(r["missing_values"]["a"]["missing_pct"] - 25) < 1,
                f"a missing: {r['missing_values']['a']['missing_pct']}%"
            )),
            custom("b_50pct_missing", lambda r: (
                abs(r["missing_values"]["b"]["missing_pct"] - 50) < 1,
                f"b missing: {r['missing_values']['b']['missing_pct']}%"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_eda",
        scenario="quality_score_clean_data",
        description="Perfect data → high quality score",
        run_fn=_run_eda,
        input_data={
            "rows": [
                {"id": 1, "name": "A", "value": 100},
                {"id": 2, "name": "B", "value": 200},
                {"id": 3, "name": "C", "value": 300},
            ],
        },
        tags=["core"],
        assertions=[
            custom("high_quality", lambda r: (
                r["data_quality"]["quality_score"] >= 90,
                f"Score: {r['data_quality']['quality_score']} (expected >= 90)"
            )),
            custom("zero_dupes", lambda r: (
                r["data_quality"]["duplicates"] == 0,
                f"Dupes: {r['data_quality']['duplicates']}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_eda",
        scenario="empty_dataset_error",
        description="Empty dataset should return error",
        run_fn=_run_eda,
        input_data={"rows": []},
        tags=["edge"],
        assertions=[
            custom("error", lambda r: (
                r.get("success") is False,
                f"Success: {r.get('success')}"
            )),
        ],
    ),
]
