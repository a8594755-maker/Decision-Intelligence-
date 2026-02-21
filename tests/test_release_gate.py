"""Deterministic unit tests for staging->production release gate evaluation."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from ml.registry.release_gate import (  # noqa: E402
    CanaryGateConfig,
    evaluate_canary_gate,
    evaluate_release_gate,
)


def _good_artifact():
    return {
        "artifact_id": "art_good",
        "series_id": "SKU-001",
        "model_name": "lightgbm",
        "metrics_summary": {
            "mape": 15.0,
            "coverage_10_90": 0.82,
            "pinball": 20.0,
            "bias": 2.0,
            "n_eval_points": 14,
        },
        "calibration_passed": True,
    }


def _good_regression():
    return {"passed": True, "total": 48, "failed": 0}


def _good_canary():
    return {
        "fixture_results": [
            {
                "id": "feasible_basic_single",
                "status": "OPTIMAL",
                "solve_time_ms": 120,
                "schema_valid": True,
            },
            {
                "id": "feasible_tight_capacity",
                "status": "FEASIBLE",
                "solve_time_ms": 250,
                "schema_valid": True,
            },
        ],
        "endpoint_checks": [
            {
                "path": "/health",
                "status_code": 200,
                "responded": True,
                "schema_valid": True,
            },
            {
                "path": "/replenishment-plan",
                "status_code": 200,
                "responded": True,
                "schema_valid": True,
            },
        ],
    }


class TestReleaseGateEvaluation:
    def test_release_gate_passes_when_all_inputs_pass(self):
        result = evaluate_release_gate(
            artifact_record=_good_artifact(),
            regression_result=_good_regression(),
            canary_result=_good_canary(),
        )
        assert result.can_promote is True
        assert result.artifact_quality_passed is True
        assert result.regression_passed is True
        assert result.canary_passed is True

    def test_release_gate_fails_when_regression_fails(self):
        regression = {"passed": False, "total": 48, "failed": 1}
        result = evaluate_release_gate(
            artifact_record=_good_artifact(),
            regression_result=regression,
            canary_result=_good_canary(),
        )
        assert result.can_promote is False
        assert result.regression_passed is False
        assert any("regression:" in reason for reason in result.reasons)

    def test_release_gate_fails_when_canary_missing_endpoint(self):
        canary = _good_canary()
        canary["endpoint_checks"] = [
            {
                "path": "/health",
                "status_code": 200,
                "responded": True,
                "schema_valid": True,
            }
        ]
        result = evaluate_release_gate(
            artifact_record=_good_artifact(),
            regression_result=_good_regression(),
            canary_result=canary,
        )
        assert result.can_promote is False
        assert result.canary_passed is False
        assert any("/replenishment-plan" in reason for reason in result.reasons)


class TestCanaryGateEvaluation:
    def test_canary_timeout_rate_threshold(self):
        canary = _good_canary()
        canary["fixture_results"][0]["status"] = "TIMEOUT"

        result = evaluate_canary_gate(
            canary,
            config=CanaryGateConfig(max_timeout_rate=0.0),
        )
        assert result.passed is False
        assert result.timeout_count == 1
        assert any("timeout_rate" in reason for reason in result.reasons)

    def test_canary_solve_time_threshold(self):
        canary = _good_canary()
        canary["fixture_results"][1]["solve_time_ms"] = 15_001

        result = evaluate_canary_gate(
            canary,
            config=CanaryGateConfig(max_solve_time_ms=10_000),
        )
        assert result.passed is False
        assert any("max_solve_time_ms" in reason for reason in result.reasons)
