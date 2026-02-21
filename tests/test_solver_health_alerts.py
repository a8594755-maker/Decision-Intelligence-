import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from ml.monitoring.solver_health import (  # noqa: E402
    SolverHealthThresholds,
    evaluate_solver_health_alerts,
    summarize_solver_health,
)


FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "solver_health"


def _load_fixture(name: str):
    with open(FIXTURE_DIR / name, "r", encoding="utf-8") as f:
        return json.load(f)


def _fixed_now() -> datetime:
    return datetime(2026, 2, 21, 0, 0, 0, tzinfo=timezone.utc)


def test_healthy_fixture_has_no_alerts():
    fixture = _load_fixture("healthy_window.json")
    summary = summarize_solver_health(
        fixture["rows"],
        now=_fixed_now(),
        window_label="24h",
        queue_snapshot=fixture["queue_snapshot"],
    )
    thresholds = SolverHealthThresholds(
        timeout_rate=0.25,
        infeasible_rate=0.15,
        backlog_jobs=10,
        queue_wait_p95_ms=60_000,
    )
    alerts = evaluate_solver_health_alerts(summary, thresholds)

    assert alerts == []
    assert summary["rates"]["success_rate"] == 0.8
    assert summary["rates"]["timeout_rate"] == 0.1
    assert summary["rates"]["infeasible_rate"] == 0.1
    assert summary["solve_time_ms"]["p50"] == 210.0
    assert summary["solve_time_ms"]["p95"] == 373.0
    assert summary["queue"]["current_backlog_jobs"] == 2


def test_spiky_fixture_triggers_expected_alerts_deterministically():
    fixture = _load_fixture("spiky_window.json")
    summary = summarize_solver_health(
        fixture["rows"],
        now=_fixed_now(),
        window_label="7d",
        queue_snapshot=fixture["queue_snapshot"],
    )
    thresholds = SolverHealthThresholds(
        timeout_rate=0.25,
        infeasible_rate=0.15,
        backlog_jobs=10,
        queue_wait_p95_ms=60_000,
    )

    alerts_first = evaluate_solver_health_alerts(summary, thresholds)
    alerts_second = evaluate_solver_health_alerts(summary, thresholds)

    assert alerts_first == alerts_second
    assert [row["code"] for row in alerts_first] == [
        "timeout_rate_spike",
        "infeasible_rate_spike",
        "backlog_jobs_spike",
        "queue_wait_p95_ms_spike",
    ]
    assert summary["rates"]["timeout_rate"] == 0.4
    assert summary["rates"]["infeasible_rate"] == 0.2
    assert summary["queue"]["current_backlog_jobs"] == 12

