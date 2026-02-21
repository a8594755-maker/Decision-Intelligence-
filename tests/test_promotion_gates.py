"""
PR-E Tests: Promotion Gates
==============================
Deterministic tests for:
  - Quality gate evaluation (coverage, bias, pinball, MAPE)
  - Data requirement checks
  - Override mechanism
  - Post-promotion rollback detection
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest
from ml.registry.promotion_gates import (
    PromotionGateConfig,
    evaluate_promotion_gates,
    check_post_promotion_rollback,
)


@pytest.fixture
def good_artifact():
    """Artifact that passes all gates."""
    return {
        "artifact_id": "art_good",
        "series_id": "SKU-001",
        "model_name": "lightgbm",
        "metrics_summary": {
            "mape": 15.0,
            "coverage_10_90": 0.82,
            "pinball": 20.0,
            "bias": -3.0,
            "n_eval_points": 14,
        },
        "calibration_passed": True,
    }


@pytest.fixture
def bad_artifact():
    """Artifact that fails quality gates."""
    return {
        "artifact_id": "art_bad",
        "series_id": "SKU-001",
        "model_name": "lightgbm",
        "metrics_summary": {
            "mape": 65.0,       # > 50
            "coverage_10_90": 0.55,  # < 0.70
            "pinball": 120.0,   # > 100
            "bias": -60.0,      # > 50
            "n_eval_points": 14,
        },
        "calibration_passed": False,
    }


class TestPromotionGates:
    def test_good_artifact_passes(self, good_artifact):
        result = evaluate_promotion_gates(good_artifact)
        assert result.can_promote is True
        assert result.quality_passed is True
        assert result.data_requirements_met is True

    def test_bad_artifact_fails(self, bad_artifact):
        result = evaluate_promotion_gates(bad_artifact)
        assert result.can_promote is False
        assert result.quality_passed is False
        assert len(result.reasons) > 0

    def test_mape_gate(self):
        artifact = {
            "metrics_summary": {"mape": 55.0},
            "calibration_passed": True,
        }
        result = evaluate_promotion_gates(artifact)
        assert result.can_promote is False
        assert any("MAPE" in r for r in result.reasons)

    def test_coverage_gate(self):
        artifact = {
            "metrics_summary": {"coverage_10_90": 0.60},
            "calibration_passed": True,
        }
        result = evaluate_promotion_gates(artifact)
        assert result.can_promote is False
        assert any("coverage" in r for r in result.reasons)

    def test_bias_gate(self):
        artifact = {
            "metrics_summary": {"bias": 55.0},
            "calibration_passed": True,
        }
        result = evaluate_promotion_gates(artifact)
        assert result.can_promote is False
        assert any("bias" in r for r in result.reasons)

    def test_pinball_gate(self):
        artifact = {
            "metrics_summary": {"pinball": 110.0},
            "calibration_passed": True,
        }
        result = evaluate_promotion_gates(artifact)
        assert result.can_promote is False
        assert any("pinball" in r for r in result.reasons)

    def test_calibration_gate(self):
        artifact = {
            "metrics_summary": {"mape": 10.0},
            "calibration_passed": False,
        }
        result = evaluate_promotion_gates(artifact)
        assert result.can_promote is False
        assert any("calibration" in r for r in result.reasons)

    def test_data_requirement_gate(self):
        artifact = {
            "metrics_summary": {"n_eval_points": 3},
            "calibration_passed": True,
        }
        config = PromotionGateConfig(min_val_points=7)
        result = evaluate_promotion_gates(artifact, config)
        assert result.data_requirements_met is False

    def test_custom_thresholds(self):
        artifact = {
            "metrics_summary": {"mape": 25.0},
            "calibration_passed": True,
        }
        # Strict config
        strict = PromotionGateConfig(max_mape=20.0)
        result = evaluate_promotion_gates(artifact, strict)
        assert result.can_promote is False

        # Lenient config
        lenient = PromotionGateConfig(max_mape=30.0)
        result = evaluate_promotion_gates(artifact, lenient)
        assert result.can_promote is True

    def test_missing_metrics_still_passes(self):
        artifact = {
            "metrics_summary": {},
            "calibration_passed": True,
        }
        result = evaluate_promotion_gates(artifact)
        assert result.can_promote is True

    def test_to_dict(self, good_artifact):
        result = evaluate_promotion_gates(good_artifact)
        d = result.to_dict()
        assert "can_promote" in d
        assert "reasons" in d
        assert "config_used" in d


class TestPostPromotionRollback:
    def test_no_rollback_when_stable(self):
        prod_metrics = {"mape": 15.0, "coverage_10_90": 0.82}
        baseline_metrics = {"mape": 14.0, "coverage_10_90": 0.80}
        result = check_post_promotion_rollback(prod_metrics, baseline_metrics)
        assert result["should_rollback"] is False

    def test_rollback_on_mape_degradation(self):
        prod_metrics = {"mape": 50.0}
        baseline_metrics = {"mape": 15.0}
        config = PromotionGateConfig(rollback_mape_degradation_pct=20.0)
        result = check_post_promotion_rollback(prod_metrics, baseline_metrics, config)
        assert result["should_rollback"] is True
        assert result["mape_increase_pct"] > 20.0

    def test_rollback_on_coverage_drop(self):
        prod_metrics = {"mape": 15.0, "coverage_10_90": 0.60}
        baseline_metrics = {"mape": 14.0, "coverage_10_90": 0.82}
        result = check_post_promotion_rollback(prod_metrics, baseline_metrics)
        assert result["should_rollback"] is True
        assert any("Coverage" in r for r in result["reasons"])

    def test_no_rollback_when_baseline_zero_mape(self):
        prod_metrics = {"mape": 10.0}
        baseline_metrics = {"mape": 0.0}
        result = check_post_promotion_rollback(prod_metrics, baseline_metrics)
        assert result["should_rollback"] is False
