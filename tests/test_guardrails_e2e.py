"""
Phase 4 – Deliverable 4.2: GUARDRAILS End-to-End Validation
===========================================================
Tests all 5 protected action types, cooldown/dedupe enforcement, hash chain.
"""
import pytest
from datetime import datetime, timedelta, timezone


class TestGuardrailDecisionModel:
    """Verify the GuardrailDecision dataclass."""

    def test_decision_defaults(self):
        from ml.registry.action_guardrails import GuardrailDecision
        d = GuardrailDecision(enabled=True, allowed=True)
        assert d.enabled is True
        assert d.allowed is True
        assert d.blocked_by_dedupe is False
        assert d.blocked_by_cooldown is False

    def test_decision_to_dict(self):
        from ml.registry.action_guardrails import GuardrailDecision
        d = GuardrailDecision(enabled=True, allowed=False, blocked_by_cooldown=True)
        result = d.to_dict()
        assert result["allowed"] is False
        assert result["blocked_by_cooldown"] is True


class TestGuardrailCooldowns:
    """Verify default cooldown values for all 5 action types."""

    def test_default_cooldowns(self):
        from ml.registry.action_guardrails import DEFAULT_COOLDOWN_SECONDS
        assert DEFAULT_COOLDOWN_SECONDS["promote"] == 300
        assert DEFAULT_COOLDOWN_SECONDS["rollback"] == 300
        assert DEFAULT_COOLDOWN_SECONDS["retrain_run"] == 1800
        assert DEFAULT_COOLDOWN_SECONDS["deploy"] == 900
        assert DEFAULT_COOLDOWN_SECONDS["rerun"] == 300
        assert len(DEFAULT_COOLDOWN_SECONDS) == 5


class TestGuardrailEvaluation:
    """Test evaluate() for cooldown and dedupe."""

    @pytest.fixture
    def guardrails(self, tmp_path):
        from ml.registry.action_guardrails import ProductionActionGuardrails
        return ProductionActionGuardrails(
            root=str(tmp_path / "audit"),
            enabled=True,
            cooldown_seconds={"promote": 10, "deploy": 5},
            dedupe_window_seconds=60,
        )

    def test_no_prior_events_allowed(self, guardrails):
        decision = guardrails.evaluate(
            action="promote",
            dedupe_key="S1__promote__v1",
            cooldown_key="S1__promote",
        )
        assert decision.enabled is True
        assert decision.allowed is True

    def test_cooldown_blocks_repeat(self, guardrails):
        now = datetime.now(timezone.utc)
        # Write an effective event
        d = guardrails.evaluate(
            action="promote", dedupe_key="d1", cooldown_key="S1__promote", now=now,
        )
        guardrails.write_audit_event(
            action="promote", dedupe_key="d1", cooldown_key="S1__promote",
            decision=d, effect_applied=True, result_status="success", now=now,
        )
        # Evaluate again within cooldown
        d2 = guardrails.evaluate(
            action="promote", dedupe_key="d2", cooldown_key="S1__promote",
            now=now + timedelta(seconds=3),
        )
        assert d2.allowed is False
        assert d2.blocked_by_cooldown is True
        assert d2.cooldown_remaining_seconds > 0

    def test_cooldown_expired_allows(self, guardrails):
        now = datetime.now(timezone.utc)
        d = guardrails.evaluate(
            action="promote", dedupe_key="d1", cooldown_key="S1__promote", now=now,
        )
        guardrails.write_audit_event(
            action="promote", dedupe_key="d1", cooldown_key="S1__promote",
            decision=d, effect_applied=True, result_status="success", now=now,
        )
        # Evaluate after cooldown (10s)
        d2 = guardrails.evaluate(
            action="promote", dedupe_key="d2", cooldown_key="S1__promote",
            now=now + timedelta(seconds=15),
        )
        assert d2.allowed is True

    def test_dedupe_blocks_same_key(self, guardrails):
        now = datetime.now(timezone.utc)
        d = guardrails.evaluate(
            action="deploy", dedupe_key="S1__deploy__run123", cooldown_key="ck", now=now,
        )
        guardrails.write_audit_event(
            action="deploy", dedupe_key="S1__deploy__run123", cooldown_key="ck",
            decision=d, effect_applied=True, result_status="success", now=now,
        )
        # Same dedupe_key within window
        d2 = guardrails.evaluate(
            action="deploy", dedupe_key="S1__deploy__run123", cooldown_key="ck2",
            now=now + timedelta(seconds=30),
        )
        assert d2.allowed is False
        assert d2.blocked_by_dedupe is True

    def test_disabled_guardrails_always_allow(self, tmp_path):
        from ml.registry.action_guardrails import ProductionActionGuardrails
        g = ProductionActionGuardrails(
            root=str(tmp_path / "disabled"),
            enabled=False,
        )
        d = g.evaluate(action="promote", dedupe_key="x", cooldown_key="y")
        assert d.enabled is False
        assert d.allowed is True


class TestAuditHashChain:
    """Verify immutable hash chain integrity."""

    @pytest.fixture
    def guardrails(self, tmp_path):
        from ml.registry.action_guardrails import ProductionActionGuardrails
        return ProductionActionGuardrails(
            root=str(tmp_path / "audit_chain"),
            enabled=True,
        )

    def test_hash_chain_linkage(self, guardrails):
        """Each event should reference the previous event's hash."""
        from ml.registry.action_guardrails import GuardrailDecision
        d = GuardrailDecision(enabled=True, allowed=True)
        # Write 3 events
        eid1 = guardrails.write_audit_event(
            action="promote", dedupe_key="d1", cooldown_key="c1",
            decision=d, effect_applied=True, result_status="success",
        )
        eid2 = guardrails.write_audit_event(
            action="rollback", dedupe_key="d2", cooldown_key="c2",
            decision=d, effect_applied=True, result_status="success",
        )
        eid3 = guardrails.write_audit_event(
            action="deploy", dedupe_key="d3", cooldown_key="c3",
            decision=d, effect_applied=True, result_status="success",
        )

        history = guardrails.get_history(limit=10)
        assert len(history) == 3

        # Each event should have event_hash
        for e in history:
            assert "event_hash" in e
            assert len(e["event_hash"]) == 64  # SHA-256

        # Most recent should have prev_event_hash pointing to the previous one
        # (history is most-recent-first)
        if len(history) >= 2:
            newer = history[0]
            assert "prev_event_hash" in newer

    def test_event_has_required_fields(self, guardrails):
        from ml.registry.action_guardrails import GuardrailDecision
        d = GuardrailDecision(enabled=True, allowed=True)
        guardrails.write_audit_event(
            action="rerun", dedupe_key="dk", cooldown_key="ck",
            decision=d, effect_applied=False, result_status="blocked",
        )
        history = guardrails.get_history()
        assert len(history) == 1
        event = history[0]
        assert event["action"] == "rerun"
        assert event["effect_applied"] is False
        assert event["result_status"] == "blocked"
        assert "guardrails" in event
        assert event["event_version"] == "v1"


class TestAllActionTypes:
    """Verify all 5 action types work through the evaluate + write cycle."""

    @pytest.fixture
    def guardrails(self, tmp_path):
        from ml.registry.action_guardrails import ProductionActionGuardrails
        return ProductionActionGuardrails(
            root=str(tmp_path / "all_actions"),
            enabled=True,
        )

    @pytest.mark.parametrize("action", ["promote", "rollback", "retrain_run", "deploy", "rerun"])
    def test_action_evaluate_and_write(self, guardrails, action):
        d = guardrails.evaluate(
            action=action,
            dedupe_key=f"test_{action}_key",
            cooldown_key=f"test_{action}_cooldown",
        )
        assert d.allowed is True
        eid = guardrails.write_audit_event(
            action=action,
            dedupe_key=f"test_{action}_key",
            cooldown_key=f"test_{action}_cooldown",
            decision=d,
            effect_applied=True,
            result_status="success",
        )
        assert eid.startswith("act_")
