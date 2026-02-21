#!/usr/bin/env python3
"""Evaluate staged artifact promotion gate using regression + canary evidence."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from ml.registry.promotion_gates import PromotionGateConfig  # noqa: E402
from ml.registry.release_gate import (  # noqa: E402
    CanaryGateConfig,
    ReleaseGateConfig,
    evaluate_release_gate,
)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-json", required=True, help="Path to artifact record JSON")
    parser.add_argument("--regression-json", required=True, help="Path to regression evidence JSON")
    parser.add_argument("--canary-json", required=True, help="Path to canary evidence JSON")

    parser.add_argument("--max-mape", type=float, default=50.0)
    parser.add_argument("--min-coverage-10-90", type=float, default=0.70)
    parser.add_argument("--max-bias-abs", type=float, default=50.0)
    parser.add_argument("--max-pinball-loss", type=float, default=100.0)
    parser.add_argument("--min-val-points", type=int, default=7)

    parser.add_argument("--max-solve-time-ms", type=int, default=10_000)
    parser.add_argument("--max-timeout-rate", type=float, default=0.0)
    parser.add_argument("--max-infeasible-rate", type=float, default=0.25)
    parser.add_argument("--min-endpoint-success-rate", type=float, default=1.0)
    parser.add_argument(
        "--required-endpoint",
        action="append",
        default=[],
        help="Required endpoint path (repeatable). Defaults to /health and /replenishment-plan",
    )

    parser.add_argument("--output", default="", help="Optional output file path")
    parser.add_argument("--fail-exit-code", type=int, default=2)
    return parser


def _load_json(path_str: str):
    path = Path(path_str)
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    args = _build_parser().parse_args()

    artifact = _load_json(args.artifact_json)
    regression = _load_json(args.regression_json)
    canary_payload = _load_json(args.canary_json)
    canary = canary_payload.get("canary_report", canary_payload)

    required_endpoints = args.required_endpoint or ["/health", "/replenishment-plan"]
    config = ReleaseGateConfig(
        promotion=PromotionGateConfig(
            max_mape=float(args.max_mape),
            min_coverage_10_90=float(args.min_coverage_10_90),
            max_bias_abs=float(args.max_bias_abs),
            max_pinball_loss=float(args.max_pinball_loss),
            min_val_points=max(0, int(args.min_val_points)),
        ),
        canary=CanaryGateConfig(
            max_solve_time_ms=max(0, int(args.max_solve_time_ms)),
            max_timeout_rate=max(0.0, float(args.max_timeout_rate)),
            max_infeasible_rate=max(0.0, float(args.max_infeasible_rate)),
            min_endpoint_success_rate=max(0.0, min(1.0, float(args.min_endpoint_success_rate))),
            required_endpoints=required_endpoints,
        ),
    )

    result = evaluate_release_gate(
        artifact_record=artifact,
        regression_result=regression,
        canary_result=canary,
        config=config,
    )
    payload = result.to_dict()

    rendered = json.dumps(payload, indent=2, sort_keys=True)
    print(rendered)

    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(rendered + "\n", encoding="utf-8")

    return 0 if result.can_promote else int(args.fail_exit_code)


if __name__ == "__main__":
    raise SystemExit(main())
