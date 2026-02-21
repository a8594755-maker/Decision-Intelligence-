#!/usr/bin/env python3
"""
Convert pytest --json-report output to the format expected by evaluate_release_gate.py.

Usage:
    pytest tests/regression --json-report --json-report-file=pytest_report.json
    python scripts/generate_regression_json.py \
        --input pytest_report.json \
        --output regression_result.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    data = json.loads(Path(args.input).read_text())
    summary = data.get("summary", {})

    total = summary.get("total", 0)
    failed = summary.get("failed", 0) + summary.get("error", 0)
    passed = summary.get("passed", 0)

    result = {
        "passed": failed == 0 and total > 0,
        "total": total,
        "passed_count": passed,
        "failed": failed,
        "source": "pytest-json-report",
    }

    Path(args.output).write_text(json.dumps(result, indent=2))
    print(f"[regression] {passed}/{total} passed → {result['passed']}")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
