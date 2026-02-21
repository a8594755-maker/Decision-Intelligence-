from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from ml.monitoring.solver_health import SolverHealthThresholds, collect_solver_health


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Solver health summary and threshold alerts.")
    parser.add_argument("--last", default="24h,7d", help="Window list, e.g. 24h,7d or 7d.")
    parser.add_argument("--timeout-rate-threshold", type=float, default=None)
    parser.add_argument("--infeasible-rate-threshold", type=float, default=None)
    parser.add_argument("--backlog-jobs-threshold", type=int, default=None)
    parser.add_argument("--queue-wait-p95-ms-threshold", type=float, default=None)
    parser.add_argument(
        "--no-alert-logs",
        action="store_true",
        help="Do not emit ALERT log lines while collecting health.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        thresholds = SolverHealthThresholds.from_env().with_overrides(
            timeout_rate=args.timeout_rate_threshold,
            infeasible_rate=args.infeasible_rate_threshold,
            backlog_jobs=args.backlog_jobs_threshold,
            queue_wait_p95_ms=args.queue_wait_p95_ms_threshold,
        )
        payload = collect_solver_health(
            last=args.last,
            thresholds=thresholds,
            emit_alert_logs=not bool(args.no_alert_logs),
        )
    except (RuntimeError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    print(json.dumps(payload, indent=2, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
