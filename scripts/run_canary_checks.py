#!/usr/bin/env python3
"""Run staging canary checks and emit deterministic JSON evidence."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from ml.registry.release_gate import (  # noqa: E402
    CanaryGateConfig,
    evaluate_canary_gate,
    run_staging_canary,
)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="", help="Staging base URL for endpoint probes")
    parser.add_argument(
        "--engine",
        default="heuristic",
        choices=["heuristic", "ortools"],
        help="Planning engine for fixture smoke checks",
    )
    parser.add_argument(
        "--fixture",
        action="append",
        default=[],
        help="Fixture filename under tests/fixtures/planning (repeatable)",
    )
    parser.add_argument(
        "--skip-endpoints",
        action="store_true",
        help="Skip HTTP endpoint probes (fixtures still run)",
    )
    parser.add_argument(
        "--http-timeout-seconds",
        type=float,
        default=10.0,
        help="HTTP timeout for endpoint probes",
    )
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


def main() -> int:
    args = _build_parser().parse_args()

    required_endpoints = args.required_endpoint or ["/health", "/replenishment-plan"]
    canary_cfg = CanaryGateConfig(
        max_solve_time_ms=max(0, int(args.max_solve_time_ms)),
        max_timeout_rate=max(0.0, float(args.max_timeout_rate)),
        max_infeasible_rate=max(0.0, float(args.max_infeasible_rate)),
        min_endpoint_success_rate=max(0.0, min(1.0, float(args.min_endpoint_success_rate))),
        required_endpoints=required_endpoints,
    )

    report = run_staging_canary(
        base_url=str(args.base_url or "").strip() or None,
        fixture_files=args.fixture or None,
        engine=args.engine,
        include_endpoints=not args.skip_endpoints,
        timeout_seconds=max(0.1, float(args.http_timeout_seconds)),
    )
    gate_result = evaluate_canary_gate(report, config=canary_cfg)

    payload = {
        "generated_at": report.get("generated_at"),
        "engine": report.get("engine"),
        "fixture_results": report.get("fixture_results") or [],
        "endpoint_checks": report.get("endpoint_checks") or [],
        "gate_result": gate_result.to_dict(),
    }

    rendered = json.dumps(payload, indent=2, sort_keys=True)
    print(rendered)

    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(rendered + "\n", encoding="utf-8")

    return 0 if gate_result.passed else int(args.fail_exit_code)


if __name__ == "__main__":
    raise SystemExit(main())
