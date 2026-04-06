"""
data_cleaning_spec.py — Eval specs for generic data cleaning tool

NOTE: JS service (dataCleaningService.js). Tests simulate core cleaning operations.
10 ops: fill_missing, drop_missing, deduplicate, type_convert, rename_column,
        outlier_cap, standardize, normalize, trim_whitespace, filter_rows.
"""

from ml.api.tool_eval import ToolTestSpec, custom
import math


def _run_cleaning(input_data):
    """Simulate data cleaning operations."""
    rows = [dict(r) for r in input_data.get("rows", [])]  # deep copy
    ops = input_data.get("operations", [])
    audit = []

    for op in ops:
        op_type = op.get("type")
        col = op.get("column")

        try:
            if op_type == "fill_missing":
                strategy = op.get("strategy", "zero")
                filled = 0
                if strategy == "zero":
                    for r in rows:
                        if r.get(col) is None:
                            r[col] = 0
                            filled += 1
                elif strategy == "mean":
                    vals = [r[col] for r in rows if r.get(col) is not None and isinstance(r[col], (int, float))]
                    mean_val = sum(vals) / max(len(vals), 1)
                    for r in rows:
                        if r.get(col) is None:
                            r[col] = round(mean_val, 2)
                            filled += 1
                elif strategy == "constant":
                    const = op.get("constant_value", 0)
                    for r in rows:
                        if r.get(col) is None:
                            r[col] = const
                            filled += 1
                audit.append({"op": op_type, "column": col, "status": "applied", "details": f"filled {filled}"})

            elif op_type == "drop_missing":
                before = len(rows)
                if col:
                    rows = [r for r in rows if r.get(col) is not None]
                else:
                    rows = [r for r in rows if all(v is not None for v in r.values())]
                audit.append({"op": op_type, "status": "applied", "details": f"dropped {before - len(rows)}"})

            elif op_type == "deduplicate":
                cols_key = op.get("columns")
                before = len(rows)
                seen = set()
                deduped = []
                for r in rows:
                    key = tuple(r.get(c) for c in (cols_key or r.keys()))
                    if key not in seen:
                        seen.add(key)
                        deduped.append(r)
                rows = deduped
                audit.append({"op": op_type, "status": "applied", "details": f"removed {before - len(rows)}"})

            elif op_type == "trim_whitespace":
                trimmed = 0
                for r in rows:
                    targets = [col] if col else list(r.keys())
                    for c in targets:
                        if isinstance(r.get(c), str) and r[c] != r[c].strip():
                            r[c] = r[c].strip()
                            trimmed += 1
                audit.append({"op": op_type, "status": "applied", "details": f"trimmed {trimmed}"})

            elif op_type == "outlier_cap":
                method = op.get("method", "iqr")
                mult = op.get("multiplier", 1.5 if method == "iqr" else 3)
                vals = sorted([r[col] for r in rows if isinstance(r.get(col), (int, float))])
                if len(vals) >= 4:
                    q1 = vals[len(vals) // 4]
                    q3 = vals[3 * len(vals) // 4]
                    iqr = q3 - q1
                    lower = q1 - mult * iqr
                    upper = q3 + mult * iqr
                    capped = 0
                    for r in rows:
                        if isinstance(r.get(col), (int, float)):
                            if r[col] < lower:
                                r[col] = lower
                                capped += 1
                            elif r[col] > upper:
                                r[col] = upper
                                capped += 1
                    audit.append({"op": op_type, "status": "applied", "details": f"capped {capped}"})
                else:
                    audit.append({"op": op_type, "status": "skipped", "details": "insufficient data"})

            else:
                audit.append({"op": op_type, "status": "skipped", "details": "unknown op"})

        except Exception as e:
            audit.append({"op": op_type, "status": "error", "error": str(e)})

    return {
        "success": True,
        "cleaned_rows": rows,
        "row_count": len(rows),
        "audit": audit,
    }


SPECS = [
    ToolTestSpec(
        tool_id="run_data_cleaning",
        scenario="fill_missing_zero",
        description="Fill nulls with zero",
        run_fn=_run_cleaning,
        input_data={
            "rows": [
                {"a": 10, "b": None},
                {"a": 20, "b": 30},
                {"a": None, "b": 40},
            ],
            "operations": [
                {"type": "fill_missing", "column": "a", "strategy": "zero"},
                {"type": "fill_missing", "column": "b", "strategy": "zero"},
            ],
        },
        tags=["core"],
        assertions=[
            custom("no_nulls", lambda r: (
                all(row["a"] is not None and row["b"] is not None for row in r["cleaned_rows"]),
                f"Nulls remaining: {sum(1 for row in r['cleaned_rows'] for v in row.values() if v is None)}"
            )),
            custom("a_filled_zero", lambda r: (
                r["cleaned_rows"][2]["a"] == 0,
                f"Row 3 a: {r['cleaned_rows'][2]['a']}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_data_cleaning",
        scenario="deduplicate",
        description="Remove duplicate rows",
        run_fn=_run_cleaning,
        input_data={
            "rows": [
                {"sku": "A", "qty": 10},
                {"sku": "B", "qty": 20},
                {"sku": "A", "qty": 10},  # duplicate
                {"sku": "C", "qty": 30},
            ],
            "operations": [{"type": "deduplicate"}],
        },
        tags=["core"],
        assertions=[
            custom("3_rows", lambda r: (
                r["row_count"] == 3,
                f"Row count: {r['row_count']} (expected 3)"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_data_cleaning",
        scenario="trim_whitespace",
        description="Trim leading/trailing whitespace from all string columns",
        run_fn=_run_cleaning,
        input_data={
            "rows": [
                {"name": "  Alice ", "city": "Taipei "},
                {"name": "Bob", "city": " NYC"},
            ],
            "operations": [{"type": "trim_whitespace"}],
        },
        tags=["core"],
        assertions=[
            custom("trimmed", lambda r: (
                r["cleaned_rows"][0]["name"] == "Alice" and r["cleaned_rows"][1]["city"] == "NYC",
                f"Values: {r['cleaned_rows'][0]['name']!r}, {r['cleaned_rows'][1]['city']!r}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_data_cleaning",
        scenario="outlier_cap_iqr",
        description="Cap outlier using IQR method",
        run_fn=_run_cleaning,
        input_data={
            "rows": [{"val": v} for v in [10, 12, 11, 13, 12, 11, 100]],  # 100 is outlier
            "operations": [{"type": "outlier_cap", "column": "val", "method": "iqr", "multiplier": 1.5}],
        },
        tags=["core"],
        assertions=[
            custom("outlier_capped", lambda r: (
                r["cleaned_rows"][-1]["val"] < 50,
                f"Last value: {r['cleaned_rows'][-1]['val']} (was 100, should be capped)"
            )),
            custom("normal_untouched", lambda r: (
                r["cleaned_rows"][0]["val"] == 10,
                f"First value: {r['cleaned_rows'][0]['val']} (should remain 10)"
            )),
        ],
    ),
]
