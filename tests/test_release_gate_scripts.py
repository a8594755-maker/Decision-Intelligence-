"""Deterministic script exit-code tests for release gate pipeline hooks."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EVAL_SCRIPT = ROOT / "scripts" / "evaluate_release_gate.py"
ROLLBACK_SCRIPT = ROOT / "scripts" / "rollback_prod_pointer.py"

sys.path.insert(0, os.path.join(ROOT, "src"))
from ml.registry.model_registry import ModelLifecycleRegistry  # noqa: E402


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=False)


class TestEvaluateReleaseGateScript:
    def test_exit_zero_when_release_gate_passes(self, tmp_path: Path):
        artifact_path = tmp_path / "artifact.json"
        regression_path = tmp_path / "regression.json"
        canary_path = tmp_path / "canary.json"

        _write_json(
            artifact_path,
            {
                "metrics_summary": {
                    "mape": 10.0,
                    "coverage_10_90": 0.85,
                    "pinball": 12.0,
                    "bias": 1.0,
                    "n_eval_points": 14,
                },
                "calibration_passed": True,
            },
        )
        _write_json(regression_path, {"passed": True, "total": 12, "failed": 0})
        _write_json(
            canary_path,
            {
                "fixture_results": [
                    {"id": "f1", "status": "OPTIMAL", "solve_time_ms": 50, "schema_valid": True},
                    {"id": "f2", "status": "FEASIBLE", "solve_time_ms": 75, "schema_valid": True},
                ],
                "endpoint_checks": [
                    {"path": "/health", "status_code": 200, "responded": True, "schema_valid": True},
                    {
                        "path": "/replenishment-plan",
                        "status_code": 200,
                        "responded": True,
                        "schema_valid": True,
                    },
                ],
            },
        )

        proc = _run(
            [
                sys.executable,
                str(EVAL_SCRIPT),
                "--artifact-json",
                str(artifact_path),
                "--regression-json",
                str(regression_path),
                "--canary-json",
                str(canary_path),
            ]
        )

        assert proc.returncode == 0, proc.stderr
        payload = json.loads(proc.stdout)
        assert payload["can_promote"] is True

    def test_exit_nonzero_when_release_gate_fails(self, tmp_path: Path):
        artifact_path = tmp_path / "artifact.json"
        regression_path = tmp_path / "regression.json"
        canary_path = tmp_path / "canary.json"

        _write_json(
            artifact_path,
            {
                "metrics_summary": {
                    "mape": 10.0,
                    "coverage_10_90": 0.85,
                    "pinball": 12.0,
                    "bias": 1.0,
                    "n_eval_points": 14,
                },
                "calibration_passed": True,
            },
        )
        _write_json(regression_path, {"passed": False, "total": 12, "failed": 2})
        _write_json(
            canary_path,
            {
                "fixture_results": [
                    {"id": "f1", "status": "OPTIMAL", "solve_time_ms": 50, "schema_valid": True}
                ],
                "endpoint_checks": [
                    {"path": "/health", "status_code": 200, "responded": True, "schema_valid": True},
                    {
                        "path": "/replenishment-plan",
                        "status_code": 200,
                        "responded": True,
                        "schema_valid": True,
                    },
                ],
            },
        )

        proc = _run(
            [
                sys.executable,
                str(EVAL_SCRIPT),
                "--artifact-json",
                str(artifact_path),
                "--regression-json",
                str(regression_path),
                "--canary-json",
                str(canary_path),
            ]
        )

        assert proc.returncode == 2
        payload = json.loads(proc.stdout)
        assert payload["can_promote"] is False


class TestRollbackScript:
    def test_rollback_script_success(self, tmp_path: Path):
        registry_root = tmp_path / "registry"
        registry = ModelLifecycleRegistry(root=str(registry_root))

        metadata = {
            "series_id": "SKU-001",
            "model_name": "lightgbm",
            "metrics_summary": {
                "mape": 10.0,
                "coverage_10_90": 0.8,
                "pinball": 12.0,
                "bias": 1.0,
            },
            "calibration_passed": True,
        }

        art_v1 = registry.register_artifact("/fake/v1", metadata)
        registry.promote_to_prod("SKU-001", art_v1, note="v1")

        art_v2 = registry.register_artifact("/fake/v2", metadata)
        registry.promote_to_prod("SKU-001", art_v2, note="v2")

        proc = _run(
            [
                sys.executable,
                str(ROLLBACK_SCRIPT),
                "--series-id",
                "SKU-001",
                "--steps",
                "1",
                "--registry-root",
                str(registry_root),
            ]
        )

        assert proc.returncode == 0, proc.stderr
        payload = json.loads(proc.stdout)
        assert payload["rolled_back"] is True
        assert payload["artifact_id"] == art_v1

    def test_rollback_script_fails_without_history(self, tmp_path: Path):
        registry_root = tmp_path / "registry"
        registry = ModelLifecycleRegistry(root=str(registry_root))

        metadata = {
            "series_id": "SKU-001",
            "model_name": "lightgbm",
            "metrics_summary": {"mape": 10.0},
            "calibration_passed": True,
        }

        art_v1 = registry.register_artifact("/fake/v1", metadata)
        registry.promote_to_prod("SKU-001", art_v1, note="v1")

        proc = _run(
            [
                sys.executable,
                str(ROLLBACK_SCRIPT),
                "--series-id",
                "SKU-001",
                "--steps",
                "1",
                "--registry-root",
                str(registry_root),
            ]
        )

        assert proc.returncode == 1
        payload = json.loads(proc.stdout)
        assert payload["rolled_back"] is False
