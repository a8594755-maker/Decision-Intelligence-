import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from ml.api.solver_telemetry import (  # noqa: E402
    InMemorySolverTelemetryStore,
    emit_solver_telemetry_event,
)


def _planning_payload() -> dict:
    return {
        "contract_version": "1.0",
        "dataset_profile_id": 101,
        "planning_horizon_days": 7,
        "demand_forecast": {
            "granularity": "day",
            "series": [
                {"sku": "SKU-001", "plant_id": "P1", "date": "2025-06-01", "p50": 12.0},
                {"sku": "SKU-001", "plant_id": "P1", "date": "2025-06-02", "p50": 10.0},
            ],
        },
        "inventory": [{"sku": "SKU-001", "plant_id": "P1", "on_hand": 5.0}],
        "open_pos": [],
        "constraints": {"moq": [{"sku": "SKU-001", "min_qty": 10.0}]},
        "objective": {"optimize_for": "balanced"},
        "multi_echelon": {"mode": "off"},
    }


def test_solver_telemetry_query_filters_and_metrics():
    store = InMemorySolverTelemetryStore()
    now = datetime.now(timezone.utc)
    payload = _planning_payload()

    cases = [
        ("run-opt", "OPTIMAL", "OPTIMAL", 120, []),
        ("run-inf", "INFEASIBLE", "INFEASIBLE", 30, ["No feasible plan found"]),
        ("run-tmo", "TIMEOUT", "TIME_LIMIT_NO_FEASIBLE", 250, ["Time limit reached"]),
    ]
    for idx, (run_key, status, reason, solve_time_ms, infeasible_reasons) in enumerate(cases):
        planning_result = {
            "status": status,
            "solver_meta": {
                "status": status,
                "termination_reason": reason,
                "solve_time_ms": solve_time_ms,
                "engine": "cp_sat",
            },
            "infeasible_reasons": list(infeasible_reasons),
        }
        emit_solver_telemetry_event(
            store,
            telemetry_run_id=run_key,
            event_type="summary",
            source="sync",
            planning_payload=payload,
            planning_result=planning_result,
            engine="cp_sat",
            objective="balanced",
            occurred_at=(now - timedelta(minutes=idx)).isoformat(),
        )

    rows = store.list_events(
        start_time=now - timedelta(days=1),
        end_time=now + timedelta(minutes=1),
        engine="cp_sat",
        event_type="summary",
        limit=20,
    )
    assert len(rows) == 3

    infeasible_rows = store.list_events(
        start_time=now - timedelta(days=1),
        end_time=now + timedelta(minutes=1),
        engine="cp_sat",
        status="INFEASIBLE",
        event_type="summary",
        limit=20,
    )
    assert len(infeasible_rows) == 1

    metrics = store.summary_metrics(
        start_time=now - timedelta(days=1),
        end_time=now + timedelta(minutes=1),
        engine="cp_sat",
    )
    assert metrics["count"] == 3
    assert metrics["solve_time_ms_p95"] == 250
    assert metrics["infeasible_count"] == 1
    assert metrics["timeout_count"] == 1
    assert metrics["infeasible_rate"] == round(1 / 3, 6)
    assert metrics["timeout_rate"] == round(1 / 3, 6)


def test_solver_telemetry_privacy_summary_hashes_infeasible_messages():
    store = InMemorySolverTelemetryStore()
    payload = _planning_payload()
    raw_reason = "Customer Alice at supplier SUP-42 cannot be satisfied."
    planning_result = {
        "status": "INFEASIBLE",
        "solver_meta": {
            "status": "INFEASIBLE",
            "termination_reason": "INFEASIBLE",
            "solve_time_ms": 44,
            "engine": "cp_sat",
        },
        "infeasible_reasons": [raw_reason],
        "infeasible_reasons_detailed": [
            {"category": "demand_infeasible", "message": raw_reason},
        ],
    }
    row = emit_solver_telemetry_event(
        store,
        telemetry_run_id="privacy-check",
        event_type="summary",
        source="sync",
        planning_payload=payload,
        planning_result=planning_result,
        engine="cp_sat",
        objective="balanced",
    )
    assert isinstance(row, dict)
    inf_summary = row.get("infeasible_summary") or {}
    assert inf_summary.get("count") == 1
    assert isinstance(inf_summary.get("reason_hashes"), list)
    assert len(inf_summary.get("reason_hashes")) == 1
    assert raw_reason not in str(inf_summary)
    assert "constraints_hash" in (row.get("input_shape") or {})
