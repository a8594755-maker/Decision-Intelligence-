"""
Tests for scripts/automl_retrain_pipeline.py.
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from ml.registry.model_registry import ModelLifecycleRegistry
from scripts.automl_retrain_pipeline import (
    run_pipeline,
    step_drift,
    step_evaluate,
    step_promote,
    step_train,
)


def _has_lightgbm() -> bool:
    return importlib.util.find_spec("lightgbm") is not None


def test_step_drift_returns_report_structure(tmp_path):
    result = step_drift("SYNTHETIC", str(tmp_path))
    assert "data_drift_score" in result
    assert "residual_drift_score" in result
    assert "drift_score" in result
    assert "drift_flags" in result
    assert "data_source" in result


def test_step_evaluate_low_drift_no_retrain(tmp_path):
    drift_report = {
        "data_drift_score": 0.1,
        "residual_drift_score": 0.1,
        "drift_flags": [],
        "baseline_mape": 10.0,
        "recent_mape": 10.2,
        "recent_coverage": 0.82,
        "recent_bias": 0.2,
    }
    result = step_evaluate(
        "SYNTHETIC",
        drift_report,
        registry_root=str(tmp_path / "registry"),
        trigger_root=str(tmp_path / "triggers"),
        auto_retrain_enabled=False,
        record_events=True,
    )
    assert result["should_retrain"] is False
    assert result["severity"] in {"none", "low"}


def test_step_evaluate_high_drift_triggers_retrain(tmp_path):
    drift_report = {
        "data_drift_score": 0.9,
        "residual_drift_score": 0.8,
        "drift_flags": ["data_drift_high", "residual_drift_high"],
        "baseline_mape": 10.0,
        "recent_mape": 40.0,
    }
    result = step_evaluate(
        "SYNTHETIC",
        drift_report,
        registry_root=str(tmp_path / "registry"),
        trigger_root=str(tmp_path / "triggers"),
        auto_retrain_enabled=True,
        record_events=True,
    )
    assert result["should_retrain"] is True
    assert len(result["reasons"]) > 0


def test_step_train_dry_run_skips_training(tmp_path):
    result = step_train(
        "SYNTHETIC",
        artifact_dir=str(tmp_path / "artifacts"),
        champion_dir=str(tmp_path / "_champions"),
        dry_run=True,
        candidate_models=["lightgbm"],
        horizon=7,
    )
    assert result["skipped"] is True
    assert result["reason"] == "dry_run"


def test_step_train_real_produces_champion_if_lightgbm_available(tmp_path):
    if not _has_lightgbm():
        pytest.skip("lightgbm not installed in current environment")

    result = step_train(
        "SYNTHETIC",
        artifact_dir=str(tmp_path / "artifacts"),
        champion_dir=str(tmp_path / "_champions"),
        dry_run=False,
        candidate_models=["lightgbm"],
        horizon=7,
    )
    champion = result.get("champion") or {}
    assert champion.get("model_name") == "lightgbm"
    assert isinstance(champion.get("val_mape"), float)
    assert champion.get("artifact_dir")


def test_step_promote_quality_gate_blocks_bad_model(tmp_path):
    artifact_dir = tmp_path / "artifact_bad"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    result = step_promote(
        "SYNTHETIC",
        {
            "run_id": "run_1",
            "champion": {
                "model_name": "lightgbm",
                "val_mape": 99.0,
                "artifact_dir": str(artifact_dir),
            },
        },
        registry_root=str(tmp_path / "registry"),
        dry_run=False,
        max_promote_mape=20.0,
    )
    assert result["skipped"] is True
    assert result["reason"] == "quality_gate_failed"


def test_step_promote_success_updates_prod_pointer(tmp_path):
    artifact_dir = tmp_path / "artifact_good"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    result = step_promote(
        "SYNTHETIC",
        {
            "run_id": "run_1",
            "champion": {
                "model_name": "lightgbm",
                "val_mape": 5.5,
                "artifact_dir": str(artifact_dir),
                "dataset_fingerprint": "fp_123",
            },
        },
        registry_root=str(tmp_path / "registry"),
        dry_run=False,
        max_promote_mape=20.0,
    )
    assert result["lifecycle_state"] == "PROD"
    assert result["artifact_id"].startswith("art_")

    registry = ModelLifecycleRegistry(root=str(tmp_path / "registry"))
    assert registry.get_prod_pointer("SYNTHETIC") == result["artifact_id"]


def test_run_pipeline_dry_run_completes_and_writes_report(tmp_path):
    report_path = tmp_path / "report.json"
    report = run_pipeline(
        series_ids=["SYNTHETIC"],
        artifact_dir=str(tmp_path / "artifacts"),
        champion_dir=str(tmp_path / "_champions"),
        registry_root=str(tmp_path / "registry"),
        trigger_root=str(tmp_path / "triggers"),
        report_path=str(report_path),
        dry_run=True,
    )
    assert report["pipeline_id"].startswith("pipeline_")
    assert report["series_count"] == 1
    assert report["dry_run"] is True
    assert "SYNTHETIC" in report["series_results"]

    series_result = report["series_results"]["SYNTHETIC"]
    assert series_result["outcome"] == "success"
    assert series_result["drift"] is not None
    assert series_result["evaluate"] is not None

    assert report_path.exists()
    saved = json.loads(report_path.read_text(encoding="utf-8"))
    assert saved["pipeline_id"] == report["pipeline_id"]


def test_run_pipeline_drift_only_step(tmp_path):
    report = run_pipeline(
        series_ids=["SYNTHETIC"],
        artifact_dir=str(tmp_path / "artifacts"),
        champion_dir=str(tmp_path / "_champions"),
        registry_root=str(tmp_path / "registry"),
        trigger_root=str(tmp_path / "triggers"),
        report_path=str(tmp_path / "report.json"),
        dry_run=True,
        step_only="drift",
    )
    result = report["series_results"]["SYNTHETIC"]
    assert result["drift"] is not None
    assert result["evaluate"] is None
    assert result["train"] is None
    assert result["promote"] is None


def test_run_pipeline_multiple_series(tmp_path):
    report = run_pipeline(
        series_ids=["SYNTHETIC", "global"],
        artifact_dir=str(tmp_path / "artifacts"),
        champion_dir=str(tmp_path / "_champions"),
        registry_root=str(tmp_path / "registry"),
        trigger_root=str(tmp_path / "triggers"),
        report_path=str(tmp_path / "report.json"),
        dry_run=True,
    )
    assert report["series_count"] == 2
    assert "SYNTHETIC" in report["series_results"]
    assert "global" in report["series_results"]
