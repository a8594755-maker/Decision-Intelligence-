"""
anomaly_spec.py — Test specs for Anomaly Detector
"""

from ml.api.tool_eval import ToolTestSpec, exists, custom


SPECS = [
    ToolTestSpec(
        tool_id="anomaly_detector",
        scenario="obvious_outlier",
        description="One value 100x larger than others must be flagged critical",
        run_fn="ml.api.anomaly_engine.execute_anomaly_pipeline",
        input_data={
            "sales": [
                {"product": "A", "revenue": 1000},
                {"product": "B", "revenue": 1200},
                {"product": "C", "revenue": 900},
                {"product": "D", "revenue": 1100},
                {"product": "E", "revenue": 100000},
            ]
        },
        tags=["fast", "core"],
        assertions=[
            exists("has_result", "result"),
            custom("finds_outlier", lambda r: _check_outlier_detected(r, "revenue", 100000)),
        ],
    ),

    ToolTestSpec(
        tool_id="anomaly_detector",
        scenario="negative_inventory",
        description="Negative qty_on_hand must be flagged",
        run_fn="ml.api.anomaly_engine.execute_anomaly_pipeline",
        input_data={
            "inventory": [
                {"sku": "A", "qty_on_hand": 500},
                {"sku": "B", "qty_on_hand": 300},
                {"sku": "C", "qty_on_hand": -200},
            ]
        },
        tags=["fast", "core"],
        assertions=[
            custom("finds_negative", lambda r: _check_negative_detected(r, "qty_on_hand", -200)),
        ],
    ),

    ToolTestSpec(
        tool_id="anomaly_detector",
        scenario="clean_data_no_critical",
        description="Uniform data should NOT produce critical anomalies",
        run_fn="ml.api.anomaly_engine.execute_anomaly_pipeline",
        input_data={
            "sales": [
                {"product": chr(65+i), "revenue": 1000 + i*10}
                for i in range(20)
            ]
        },
        tags=["fast", "regression"],
        assertions=[
            custom("no_critical", lambda r: _check_no_critical(r)),
        ],
    ),
]


def _check_outlier_detected(result, column, value):
    for art in result.get("artifacts", []):
        for row in art.get("data", []):
            if isinstance(row, dict):
                if row.get("column") == column and row.get("value") == value:
                    return True, f"Outlier {column}={value} detected"
    return False, f"Outlier {column}={value} not found"


def _check_negative_detected(result, column, value):
    for art in result.get("artifacts", []):
        label = (art.get("label") or "").lower()
        if "negative" in label:
            for row in art.get("data", []):
                if isinstance(row, dict) and row.get("column") == column:
                    return True, f"Negative {column}={value} detected"
    return False, f"Negative {column}={value} not found"


def _check_no_critical(result):
    for art in result.get("artifacts", []):
        for row in art.get("data", []):
            if isinstance(row, dict) and row.get("severity") == "critical":
                return False, f"Unexpected critical: {row.get('column')}={row.get('value')}"
    return True, "No critical anomalies (correct for clean data)"
