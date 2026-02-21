"""
PR-E Tests: Retrain Trigger Engine
====================================
Deterministic tests for:
  - Rule-based trigger decisions
  - Cooldown enforcement
  - Dedupe logic
  - Severity classification
  - RetainTriggerStore persistence
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest
from datetime import datetime, timedelta, timezone

from ml.monitoring.retrain_triggers import (
    RetainTriggerConfig,
    RetainTriggerContext,
    RetainTriggerStore,
    evaluate_retrain_trigger,
)


@pytest.fixture
def trigger_store(tmp_path):
    return RetainTriggerStore(root=str(tmp_path / "triggers"))


# ── Rule 1: Coverage degradation ──

class TestCoverageRule:
    def test_coverage_bad_consecutive_triggers(self):
        context = RetainTriggerContext(
            series_id="SKU-001",
            coverage_history=[0.85, 0.82, 0.60, 0.55],  # last 2 are bad
        )
        config = RetainTriggerConfig(
            coverage_min=0.65,
            coverage_consecutive_windows=2,
        )
        result = evaluate_retrain_trigger(context, config)
        assert result.should_retrain is True
        assert "coverage_degradation" in result.trigger_types

    def test_coverage_single_bad_no_trigger(self):
        context = RetainTriggerContext(
            series_id="SKU-001",
            coverage_history=[0.85, 0.82, 0.80, 0.60],  # only last 1 bad
        )
        config = RetainTriggerConfig(
            coverage_min=0.65,
            coverage_consecutive_windows=2,
        )
        result = evaluate_retrain_trigger(context, config)
        assert "coverage_degradation" not in result.trigger_types

    def test_empty_coverage_history_no_trigger(self):
        context = RetainTriggerContext(series_id="SKU-001")
        result = evaluate_retrain_trigger(context)
        assert result.should_retrain is False


# ── Rule 2: MAPE degradation ──

class TestMAPERule:
    def test_mape_degradation_triggers(self):
        context = RetainTriggerContext(
            series_id="SKU-001",
            baseline_mape=10.0,
            recent_mape=15.0,  # 50% increase
        )
        config = RetainTriggerConfig(mape_degradation_pct=15.0)
        result = evaluate_retrain_trigger(context, config)
        assert result.should_retrain is True
        assert "mape_degradation" in result.trigger_types

    def test_mape_stable_no_trigger(self):
        context = RetainTriggerContext(
            series_id="SKU-001",
            baseline_mape=10.0,
            recent_mape=11.0,  # 10% increase < 15%
        )
        config = RetainTriggerConfig(mape_degradation_pct=15.0)
        result = evaluate_retrain_trigger(context, config)
        assert "mape_degradation" not in result.trigger_types

    def test_mape_improvement_no_trigger(self):
        context = RetainTriggerContext(
            series_id="SKU-001",
            baseline_mape=15.0,
            recent_mape=10.0,  # improved
        )
        result = evaluate_retrain_trigger(context)
        assert "mape_degradation" not in result.trigger_types

    def test_zero_baseline_mape_no_trigger(self):
        context = RetainTriggerContext(
            series_id="SKU-001",
            baseline_mape=0.0,
            recent_mape=5.0,
        )
        result = evaluate_retrain_trigger(context)
        assert "mape_degradation" not in result.trigger_types


# ── Rule 3: Residual drift ──

class TestResidualDriftRule:
    def test_high_residual_drift_triggers(self):
        context = RetainTriggerContext(
            series_id="SKU-001",
            residual_drift_score=0.8,
        )
        config = RetainTriggerConfig(residual_drift_threshold=0.6)
        result = evaluate_retrain_trigger(context, config)
        assert result.should_retrain is True
        assert "residual_drift" in result.trigger_types

    def test_low_residual_drift_no_trigger(self):
        context = RetainTriggerContext(
            series_id="SKU-001",
            residual_drift_score=0.3,
        )
        result = evaluate_retrain_trigger(context)
        assert "residual_drift" not in result.trigger_types


# ── Rule 4: Data drift ──

class TestDataDriftRule:
    def test_high_data_drift_triggers(self):
        context = RetainTriggerContext(
            series_id="SKU-001",
            data_drift_score=0.8,
        )
        config = RetainTriggerConfig(data_drift_threshold=0.6)
        result = evaluate_retrain_trigger(context, config)
        assert result.should_retrain is True
        assert "data_drift" in result.trigger_types

    def test_low_data_drift_no_trigger(self):
        context = RetainTriggerContext(
            series_id="SKU-001",
            data_drift_score=0.2,
        )
        result = evaluate_retrain_trigger(context)
        assert "data_drift" not in result.trigger_types


# ── Severity ──

class TestSeverity:
    def test_high_severity(self):
        context = RetainTriggerContext(
            series_id="SKU-001",
            data_drift_score=0.9,
            residual_drift_score=0.8,
        )
        config = RetainTriggerConfig(
            data_drift_threshold=0.6,
            residual_drift_threshold=0.6,
        )
        result = evaluate_retrain_trigger(context, config)
        assert result.severity == "high"

    def test_no_triggers_no_severity(self):
        context = RetainTriggerContext(series_id="SKU-001")
        result = evaluate_retrain_trigger(context)
        assert result.severity == "none"


# ── Cooldown ──

class TestCooldown:
    def test_cooldown_blocks_retrain(self):
        # Trained 1 hour ago, cooldown is 24 hours
        recent_time = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        context = RetainTriggerContext(
            series_id="SKU-001",
            data_drift_score=0.9,
            last_trained_at=recent_time,
        )
        config = RetainTriggerConfig(
            data_drift_threshold=0.6,
            cooldown_hours=24.0,
        )
        result = evaluate_retrain_trigger(context, config)
        assert result.should_retrain is False
        assert result.blocked_by_cooldown is True
        assert result.cooldown_remaining_seconds > 0

    def test_expired_cooldown_allows_retrain(self):
        # Trained 48 hours ago, cooldown is 24 hours
        old_time = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
        context = RetainTriggerContext(
            series_id="SKU-001",
            data_drift_score=0.9,
            last_trained_at=old_time,
        )
        config = RetainTriggerConfig(
            data_drift_threshold=0.6,
            cooldown_hours=24.0,
        )
        result = evaluate_retrain_trigger(context, config)
        assert result.should_retrain is True
        assert result.blocked_by_cooldown is False

    def test_no_trained_at_allows_retrain(self):
        context = RetainTriggerContext(
            series_id="SKU-001",
            data_drift_score=0.9,
        )
        config = RetainTriggerConfig(data_drift_threshold=0.6)
        result = evaluate_retrain_trigger(context, config)
        assert result.should_retrain is True


# ── Dedupe ──

class TestDedupe:
    def test_dedupe_blocks_duplicate_trigger(self):
        context = RetainTriggerContext(
            series_id="SKU-001",
            data_drift_score=0.9,
            window_end="2025-06-15",
        )
        config = RetainTriggerConfig(data_drift_threshold=0.6)

        # First evaluation — should trigger
        result1 = evaluate_retrain_trigger(context, config)
        assert result1.should_retrain is True

        # Simulate trigger history
        history = [{
            "series_id": "SKU-001",
            "window_end": "2025-06-15",
            "trigger_types": ["data_drift"],
        }]

        # Second evaluation with same window — should be deduped
        result2 = evaluate_retrain_trigger(context, config, trigger_history=history)
        assert result2.should_retrain is False
        assert result2.blocked_by_dedupe is True

    def test_different_window_not_deduped(self):
        context = RetainTriggerContext(
            series_id="SKU-001",
            data_drift_score=0.9,
            window_end="2025-06-22",
        )
        config = RetainTriggerConfig(data_drift_threshold=0.6)

        history = [{
            "series_id": "SKU-001",
            "window_end": "2025-06-15",  # different window
            "trigger_types": ["data_drift"],
        }]

        result = evaluate_retrain_trigger(context, config, trigger_history=history)
        assert result.should_retrain is True
        assert result.blocked_by_dedupe is False


# ── Combined triggers ──

class TestCombinedTriggers:
    def test_multiple_triggers_all_reported(self):
        context = RetainTriggerContext(
            series_id="SKU-001",
            data_drift_score=0.8,
            residual_drift_score=0.7,
            baseline_mape=10.0,
            recent_mape=20.0,
        )
        config = RetainTriggerConfig(
            data_drift_threshold=0.6,
            residual_drift_threshold=0.6,
            mape_degradation_pct=15.0,
        )
        result = evaluate_retrain_trigger(context, config)
        assert result.should_retrain is True
        assert "data_drift" in result.trigger_types
        assert "residual_drift" in result.trigger_types
        assert "mape_degradation" in result.trigger_types
        assert len(result.reasons) == 3


# ── Store ──

class TestRetainTriggerStore:
    def test_record_and_retrieve(self, trigger_store):
        context = RetainTriggerContext(
            series_id="SKU-001",
            data_drift_score=0.9,
        )
        config = RetainTriggerConfig(data_drift_threshold=0.6)
        result = evaluate_retrain_trigger(context, config)

        event_id = trigger_store.record_trigger("SKU-001", result, "2025-06-15")
        assert event_id

        history = trigger_store.get_history(series_id="SKU-001")
        assert len(history) == 1
        assert history[0]["series_id"] == "SKU-001"

    def test_history_limit(self, trigger_store):
        context = RetainTriggerContext(
            series_id="SKU-001",
            data_drift_score=0.9,
        )
        config = RetainTriggerConfig(data_drift_threshold=0.6)
        result = evaluate_retrain_trigger(context, config)

        for i in range(5):
            trigger_store.record_trigger("SKU-001", result, f"2025-06-{15+i}")

        history = trigger_store.get_history(limit=3)
        assert len(history) == 3
