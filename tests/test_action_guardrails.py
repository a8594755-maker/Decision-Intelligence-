import os
import sys
from datetime import datetime, timedelta

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from ml.registry.action_guardrails import ProductionActionGuardrails


def test_guardrails_disabled_is_pass_through(tmp_path):
    guardrails = ProductionActionGuardrails(
        root=str(tmp_path / "audit"),
        enabled=False,
        cooldown_seconds={"promote": 300},
        dedupe_window_seconds=600,
    )

    decision = guardrails.evaluate(
        action="promote",
        dedupe_key="promote|SKU-001|art_1",
        cooldown_key="promote|SKU-001",
        now=datetime(2025, 1, 1, 0, 0, 0),
    )

    assert decision.enabled is False
    assert decision.allowed is True
    assert decision.blocked_by_cooldown is False
    assert decision.blocked_by_dedupe is False


def test_cooldown_blocks_when_recent_effect_applied_event_exists(tmp_path):
    guardrails = ProductionActionGuardrails(
        root=str(tmp_path / "audit"),
        enabled=True,
        cooldown_seconds={"promote": 300},
        dedupe_window_seconds=3600,
    )
    t0 = datetime(2025, 1, 1, 12, 0, 0)
    key = "promote|SKU-001|art_1"
    scope = "promote|SKU-001"

    first = guardrails.evaluate(
        action="promote",
        dedupe_key=key,
        cooldown_key=scope,
        now=t0,
    )
    assert first.allowed is True

    guardrails.write_audit_event(
        action="promote",
        dedupe_key=key,
        cooldown_key=scope,
        decision=first,
        effect_applied=True,
        result_status="succeeded",
        payload={"series_id": "SKU-001"},
        now=t0,
    )

    second = guardrails.evaluate(
        action="promote",
        dedupe_key=key,
        cooldown_key=scope,
        now=t0 + timedelta(seconds=120),
    )
    assert second.allowed is False
    assert second.blocked_by_cooldown is True
    assert second.cooldown_remaining_seconds == pytest.approx(180.0, abs=1.0)


def test_dedupe_blocks_same_key_within_window(tmp_path):
    guardrails = ProductionActionGuardrails(
        root=str(tmp_path / "audit"),
        enabled=True,
        cooldown_seconds={"retrain_run": 0},
        dedupe_window_seconds=900,
    )
    t0 = datetime(2025, 1, 2, 9, 0, 0)
    key = "retrain_run|SKU-100|lightgbm|drift_high|0"
    scope = "retrain_run|SKU-100"

    d1 = guardrails.evaluate(
        action="retrain_run",
        dedupe_key=key,
        cooldown_key=scope,
        now=t0,
    )
    guardrails.write_audit_event(
        action="retrain_run",
        dedupe_key=key,
        cooldown_key=scope,
        decision=d1,
        effect_applied=True,
        result_status="accepted",
        payload={"series_id": "SKU-100"},
        now=t0,
    )

    d2 = guardrails.evaluate(
        action="retrain_run",
        dedupe_key=key,
        cooldown_key=scope,
        now=t0 + timedelta(seconds=60),
    )
    assert d2.allowed is False
    assert d2.blocked_by_dedupe is True
    assert d2.blocked_by_cooldown is False


def test_audit_events_are_append_only_with_hash_chain(tmp_path):
    guardrails = ProductionActionGuardrails(
        root=str(tmp_path / "audit"),
        enabled=True,
        cooldown_seconds={"rollback": 0},
        dedupe_window_seconds=60,
    )

    t0 = datetime(2025, 1, 3, 8, 0, 0)
    d = guardrails.evaluate(
        action="rollback",
        dedupe_key="rollback|SKU-3|1",
        cooldown_key="rollback|SKU-3",
        now=t0,
    )
    id1 = guardrails.write_audit_event(
        action="rollback",
        dedupe_key="rollback|SKU-3|1",
        cooldown_key="rollback|SKU-3",
        decision=d,
        effect_applied=True,
        result_status="succeeded",
        payload={"steps": 1},
        now=t0,
    )
    id2 = guardrails.write_audit_event(
        action="rollback",
        dedupe_key="rollback|SKU-3|2",
        cooldown_key="rollback|SKU-3",
        decision=d,
        effect_applied=False,
        result_status="blocked",
        payload={"steps": 2},
        now=t0 + timedelta(seconds=1),
    )

    events = guardrails.get_history(limit=10)
    assert len(events) == 2
    newest = events[0]
    older = events[1]
    assert newest["event_id"] == id2
    assert older["event_id"] == id1
    assert newest["prev_event_hash"] == older["event_hash"]
    assert isinstance(newest.get("event_hash"), str) and len(newest["event_hash"]) == 64
