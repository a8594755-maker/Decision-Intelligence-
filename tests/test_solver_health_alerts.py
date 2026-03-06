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


# ── Phase 4.6: SLO / Cost Tracking ──────────────────────────────────────────


def test_solve_time_slo_breach_alert():
    """When solve_time_ms p95 exceeds SLO threshold, alert is emitted."""
    summary = {
        "window": "24h",
        "rates": {"timeout_rate": 0.0, "infeasible_rate": 0.0},
        "queue": {"current_backlog_jobs": 0, "queue_wait_ms_p95_for_alert": 0.0},
        "solve_time_ms": {"count": 10, "p50": 15000.0, "p95": 45000.0},
    }
    thresholds = SolverHealthThresholds(solve_time_slo_ms=30000.0)
    alerts = evaluate_solver_health_alerts(summary, thresholds)
    codes = [a["code"] for a in alerts]
    assert "solve_time_slo_breach" in codes
    slo_alert = [a for a in alerts if a["code"] == "solve_time_slo_breach"][0]
    assert slo_alert["value"] == 45000.0
    assert slo_alert["threshold"] == 30000.0


def test_solve_time_slo_no_breach_below_threshold():
    """When solve_time_ms p95 is under SLO threshold, no alert."""
    summary = {
        "window": "24h",
        "rates": {"timeout_rate": 0.0, "infeasible_rate": 0.0},
        "queue": {"current_backlog_jobs": 0, "queue_wait_ms_p95_for_alert": 0.0},
        "solve_time_ms": {"count": 10, "p50": 5000.0, "p95": 20000.0},
    }
    thresholds = SolverHealthThresholds(solve_time_slo_ms=30000.0)
    alerts = evaluate_solver_health_alerts(summary, thresholds)
    codes = [a["code"] for a in alerts]
    assert "solve_time_slo_breach" not in codes


def test_solve_time_slo_no_breach_when_zero():
    """When no solve time data, no SLO alert."""
    summary = {
        "window": "24h",
        "rates": {"timeout_rate": 0.0, "infeasible_rate": 0.0},
        "queue": {"current_backlog_jobs": 0, "queue_wait_ms_p95_for_alert": 0.0},
        "solve_time_ms": {"count": 0, "p50": None, "p95": None},
    }
    thresholds = SolverHealthThresholds(solve_time_slo_ms=30000.0)
    alerts = evaluate_solver_health_alerts(summary, thresholds)
    codes = [a["code"] for a in alerts]
    assert "solve_time_slo_breach" not in codes


def test_thresholds_from_env_includes_slo_and_cost(monkeypatch):
    """SolverHealthThresholds.from_env() picks up SLO and cost env vars."""
    monkeypatch.setenv("DI_SOLVER_ALERT_SOLVE_TIME_SLO_MS_THRESHOLD", "60000")
    monkeypatch.setenv("DI_SOLVER_COST_PER_MS", "0.001")
    th = SolverHealthThresholds.from_env()
    assert th.solve_time_slo_ms == 60000.0
    assert th.cost_per_ms == 0.001


def test_thresholds_with_overrides_slo_and_cost():
    """with_overrides() supports solve_time_slo_ms and cost_per_ms."""
    base = SolverHealthThresholds()
    updated = base.with_overrides(solve_time_slo_ms=50000.0, cost_per_ms=0.005)
    assert updated.solve_time_slo_ms == 50000.0
    assert updated.cost_per_ms == 0.005
    assert base.solve_time_slo_ms == 30000.0  # original unchanged


def test_thresholds_to_dict_includes_new_fields():
    """to_dict() output includes solve_time_slo_ms and cost_per_ms."""
    th = SolverHealthThresholds(solve_time_slo_ms=25000.0, cost_per_ms=0.01)
    d = th.to_dict()
    assert d["solve_time_slo_ms"] == 25000.0
    assert d["cost_per_ms"] == 0.01
