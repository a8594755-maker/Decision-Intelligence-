"""
Phase 4 – Deliverable 4.1: AUTO_RETRAIN End-to-End Validation
=============================================================
Tests the full retrain trigger pipeline: evaluation → decision → guards.
"""
import pytest
from datetime import datetime, timedelta, timezone


class TestRetainTriggerConfig:
    """Verify default configuration and thresholds."""

    def test_default_config_values(self):
        from ml.monitoring.retrain_triggers import RetainTriggerConfig
        cfg = RetainTriggerConfig()
        assert cfg.coverage_min == 0.65
        assert cfg.coverage_max == 0.95
        assert cfg.coverage_consecutive_windows == 2
        assert cfg.mape_degradation_pct == 15.0
        assert cfg.residual_drift_threshold == 0.6
        assert cfg.data_drift_threshold == 0.6
        assert cfg.cooldown_hours == 24.0
        assert cfg.auto_retrain_enabled is False

    def test_config_to_dict(self):
        from ml.monitoring.retrain_triggers import RetainTriggerConfig
        d = RetainTriggerConfig().to_dict()
        assert "coverage_min" in d
        assert "cooldown_hours" in d


class TestRetainTriggerRules:
    """Test all 4 trigger rules independently."""

    def test_rule1_coverage_drift(self):
        """Coverage outside band for N consecutive windows should trigger."""
        from ml.monitoring.retrain_triggers import (
            evaluate_retrain_trigger, RetainTriggerContext, RetainTriggerConfig,
        )
        ctx = RetainTriggerContext(
            series_id="S1",
            coverage_history=[0.85, 0.60, 0.55],  # last 2 below 0.65
        )
        result = evaluate_retrain_trigger(ctx)
        assert result.should_retrain is True
        assert "coverage_degradation" in result.trigger_types

    def test_rule1_coverage_ok(self):
        """Coverage within band should not trigger."""
        from ml.monitoring.retrain_triggers import (
            evaluate_retrain_trigger, RetainTriggerContext,
        )
        ctx = RetainTriggerContext(coverage_history=[0.80, 0.82, 0.78])
        result = evaluate_retrain_trigger(ctx)
        assert "coverage_degradation" not in result.trigger_types

    def test_rule2_mape_degradation(self):
        """MAPE degrading > threshold should trigger."""
        from ml.monitoring.retrain_triggers import (
            evaluate_retrain_trigger, RetainTriggerContext,
        )
        ctx = RetainTriggerContext(
            series_id="S1",
            recent_mape=25.0,
            baseline_mape=10.0,  # 150% degradation > 15% threshold
        )
        result = evaluate_retrain_trigger(ctx)
        assert result.should_retrain is True
        assert "mape_degradation" in result.trigger_types

    def test_rule2_mape_within_threshold(self):
        """MAPE degrading < threshold should not trigger."""
        from ml.monitoring.retrain_triggers import (
            evaluate_retrain_trigger, RetainTriggerContext,
        )
        ctx = RetainTriggerContext(
            recent_mape=11.0,
            baseline_mape=10.0,  # 10% < 15% threshold
        )
        result = evaluate_retrain_trigger(ctx)
        assert "mape_degradation" not in result.trigger_types

    def test_rule3_residual_drift(self):
        """High residual drift score should trigger."""
        from ml.monitoring.retrain_triggers import (
            evaluate_retrain_trigger, RetainTriggerContext,
        )
        ctx = RetainTriggerContext(residual_drift_score=0.8)
        result = evaluate_retrain_trigger(ctx)
        assert result.should_retrain is True
        assert "residual_drift" in result.trigger_types

    def test_rule4_data_drift(self):
        """High data drift score should trigger."""
        from ml.monitoring.retrain_triggers import (
            evaluate_retrain_trigger, RetainTriggerContext,
        )
        ctx = RetainTriggerContext(data_drift_score=0.9)
        result = evaluate_retrain_trigger(ctx)
        assert result.should_retrain is True
        assert "data_drift" in result.trigger_types

    def test_no_triggers_clean_context(self):
        """Clean context should not trigger."""
        from ml.monitoring.retrain_triggers import (
            evaluate_retrain_trigger, RetainTriggerContext,
        )
        ctx = RetainTriggerContext(
            coverage_history=[0.80, 0.82],
            recent_mape=10.0,
            baseline_mape=10.0,
            residual_drift_score=0.1,
            data_drift_score=0.1,
        )
        result = evaluate_retrain_trigger(ctx)
        assert result.should_retrain is False
        assert result.severity == "none"


class TestCooldownAndDedupe:
    """Test operational guards: cooldown and deduplication."""

    def test_cooldown_blocks_retrain(self):
        """Retrain within 24h of last training should be blocked."""
        from ml.monitoring.retrain_triggers import (
            evaluate_retrain_trigger, RetainTriggerContext,
        )
        recent = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        ctx = RetainTriggerContext(
            series_id="S1",
            data_drift_score=0.9,  # would normally trigger
            last_trained_at=recent,
        )
        result = evaluate_retrain_trigger(ctx)
        assert result.should_retrain is False
        assert result.blocked_by_cooldown is True
        assert result.cooldown_remaining_seconds > 0

    def test_cooldown_expired_allows_retrain(self):
        """Retrain after cooldown expired should proceed."""
        from ml.monitoring.retrain_triggers import (
            evaluate_retrain_trigger, RetainTriggerContext,
        )
        old = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
        ctx = RetainTriggerContext(
            series_id="S1",
            data_drift_score=0.9,
            last_trained_at=old,
        )
        result = evaluate_retrain_trigger(ctx)
        assert result.should_retrain is True
        assert result.blocked_by_cooldown is False

    def test_dedupe_blocks_duplicate_trigger(self):
        """Same (series_id, trigger_type, window_end) should be deduped."""
        from ml.monitoring.retrain_triggers import (
            evaluate_retrain_trigger, RetainTriggerContext,
        )
        ctx = RetainTriggerContext(
            series_id="S1",
            data_drift_score=0.9,
            window_end="2024-W10",
        )
        history = [
            {"series_id": "S1", "trigger_types": ["data_drift"], "window_end": "2024-W10"},
        ]
        result = evaluate_retrain_trigger(ctx, trigger_history=history)
        assert result.should_retrain is False
        assert result.blocked_by_dedupe is True

    def test_dedupe_allows_different_window(self):
        """Different window_end should not be deduped."""
        from ml.monitoring.retrain_triggers import (
            evaluate_retrain_trigger, RetainTriggerContext,
        )
        ctx = RetainTriggerContext(
            series_id="S1",
            data_drift_score=0.9,
            window_end="2024-W11",
        )
        history = [
            {"series_id": "S1", "trigger_types": ["data_drift"], "window_end": "2024-W10"},
        ]
        result = evaluate_retrain_trigger(ctx, trigger_history=history)
        assert result.should_retrain is True
        assert result.blocked_by_dedupe is False


class TestSeverityGrading:
    """Test severity classification."""

    def test_high_severity(self):
        from ml.monitoring.retrain_triggers import (
            evaluate_retrain_trigger, RetainTriggerContext,
        )
        ctx = RetainTriggerContext(
            coverage_history=[0.50, 0.45, 0.40],  # 3 bad windows → high
        )
        result = evaluate_retrain_trigger(ctx)
        assert result.severity == "high"

    def test_medium_severity(self):
        from ml.monitoring.retrain_triggers import (
            evaluate_retrain_trigger, RetainTriggerContext,
        )
        ctx = RetainTriggerContext(
            coverage_history=[0.80, 0.55, 0.55],  # 2 bad windows → medium
        )
        result = evaluate_retrain_trigger(ctx)
        assert result.severity == "medium"

    def test_auto_retrain_flag_propagated(self):
        from ml.monitoring.retrain_triggers import (
            evaluate_retrain_trigger, RetainTriggerContext, RetainTriggerConfig,
        )
        cfg = RetainTriggerConfig(auto_retrain_enabled=True)
        ctx = RetainTriggerContext()
        result = evaluate_retrain_trigger(ctx, config=cfg)
        assert result.auto_retrain_enabled is True


class TestRetainTriggerStore:
    """Test trigger event persistence."""

    def test_store_record_and_history(self, tmp_path):
        from ml.monitoring.retrain_triggers import (
            RetainTriggerStore, RetainTriggerResult,
        )
        store = RetainTriggerStore(root=str(tmp_path / "triggers"))
        result = RetainTriggerResult(
            should_retrain=True,
            reasons=["Data drift"],
            severity="high",
            trigger_types=["data_drift"],
        )
        eid = store.record_trigger("S1", result, window_end="2024-W10")
        assert "S1" in eid
        events = store.get_history(series_id="S1")
        assert len(events) >= 1
        assert events[0]["series_id"] == "S1"
        assert events[0]["should_retrain"] is True
