#!/usr/bin/env python3
"""
Generate a minimal artifact_record.json from backtest_report.json
for use with evaluate_release_gate.py.

Usage:
    python scripts/generate_artifact_record.py \
        --input backtest_report.json \
        --output artifact_record.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="backtest_report.json")
    parser.add_argument("--output", default="artifact_record.json")
    args = parser.parse_args()

    backtest = json.loads(Path(args.input).read_text())

    # backtest_report.json 的格式對應 metrics_summary
    metrics = backtest.get("metrics", backtest.get("metrics_summary", {}))
    record = {
        "metrics_summary": {
            "mape": float(metrics.get("mape", 999.0)),
            "coverage_10_90": float(
                metrics.get("coverage_10_90", metrics.get("coverage", 0.0))
            ),
            "bias": float(metrics.get("bias", metrics.get("bias_abs", 999.0))),
            "pinball": float(
                metrics.get("pinball_loss", metrics.get("pinball", 999.0))
            ),
            "n_eval_points": int(
                metrics.get("n_eval_points", metrics.get("n_points", 0))
            ),
        },
        "calibration_passed": bool(backtest.get("calibration_passed", True)),
    }

    Path(args.output).write_text(json.dumps(record, indent=2))
    print(
        f"[artifact] MAPE={record['metrics_summary']['mape']:.2f}"
        f" → written to {args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
