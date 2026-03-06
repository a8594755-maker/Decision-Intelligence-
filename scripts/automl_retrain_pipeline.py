"""
AutoML retrain pipeline.

Flow:
  1) Drift detection
  2) Retrain trigger evaluation
  3) AutoML training (optional)
  4) Registry promotion (optional)

Designed for CI usage:
  - Writes a machine-readable JSON report
  - Exits non-zero when any series fails
  - Supports dry-run mode (evaluate only)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parent.parent
SRC_ROOT = ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from ml.demand_forecasting.data_contract import SalesSeries
from ml.monitoring.drift_monitor import DriftConfig, run_drift_analysis
from ml.monitoring.retrain_triggers import (
    RetainTriggerConfig,
    RetainTriggerContext,
    RetainTriggerStore,
    evaluate_retrain_trigger,
)
from ml.registry.model_registry import ModelLifecycleRegistry
from ml.training.orchestrator import run_orchestrator


logger = logging.getLogger(__name__)

PIPELINE_VERSION = "1.0.0"
DEFAULT_ARTIFACT_DIR = str(ROOT / "artifacts" / "forecast")
DEFAULT_CHAMPION_DIR = str(ROOT / "artifacts" / "forecast" / "_champions")
DEFAULT_REGISTRY_ROOT = str(ROOT / "registry_store" / "model_lifecycle")
DEFAULT_TRIGGER_ROOT = str(ROOT / "registry_store" / "retrain_triggers")
DEFAULT_REPORT_PATH = str(ROOT / "pipeline_report.json")
DEFAULT_MONITORED_SERIES = os.environ.get("AUTOML_MONITORED_SERIES", "SYNTHETIC")
DEFAULT_CANDIDATE_MODELS = os.environ.get("AUTOML_CANDIDATE_MODELS", "lightgbm")
DEFAULT_PROMOTION_MAPE_THRESHOLD = float(
    os.environ.get("AUTOML_PROMOTION_MAPE_THRESHOLD", "20.0")
)
DEFAULT_HORIZON = int(os.environ.get("AUTOML_HORIZON", "30"))
DEFAULT_HPO_ENABLED = os.environ.get("AUTOML_HPO_ENABLED", "").strip().lower() in {
    "1", "true", "yes", "on",
}
DEFAULT_HPO_TRIALS = int(os.environ.get("AUTOML_HPO_TRIALS", "30"))
_hpo_timeout_raw = os.environ.get("AUTOML_HPO_TIMEOUT")
DEFAULT_HPO_TIMEOUT: Optional[int] = int(_hpo_timeout_raw) if _hpo_timeout_raw else None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _env_flag(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _should_run_step(step: str, step_only: Optional[str]) -> bool:
    if step_only in (None, "all"):
        return True
    order = ["drift", "evaluate", "train", "promote"]
    try:
        return order.index(step) <= order.index(step_only)
    except ValueError:
        return False


def _extract_float_list(payload: Dict[str, Any], key: str) -> Optional[List[float]]:
    raw = payload.get(key)
    if not isinstance(raw, list):
        return None
    values: List[float] = []
    for item in raw:
        try:
            values.append(float(item))
        except (TypeError, ValueError):
            return None
    return values


def _load_series_data(series_id: str, artifact_dir: str) -> Dict[str, Any]:
    """
    Try to load backtest data from artifacts. Falls back to synthetic data.
    """
    artifact_root = Path(artifact_dir)
    candidate_files = [
        artifact_root / "backtest_report.json",
        ROOT / "backtest_report.json",
    ]

    for file_path in candidate_files:
        if not file_path.exists():
            continue
        try:
            with open(file_path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)

            history = _extract_float_list(payload, "series")
            if history and len(history) >= 20:
                split_idx = max(10, int(len(history) * 0.7))
                split_idx = min(split_idx, len(history) - 5)
                return {
                    "source": str(file_path),
                    "baseline_values": history[:split_idx],
                    "recent_values": history[split_idx:],
                    "baseline_actuals": _extract_float_list(payload, "baseline_actuals"),
                    "baseline_predictions": _extract_float_list(
                        payload, "baseline_predictions"
                    ),
                    "recent_actuals": _extract_float_list(payload, "recent_actuals"),
                    "recent_predictions": _extract_float_list(payload, "recent_predictions"),
                }
        except Exception as exc:  # pragma: no cover - defensive log
            logger.warning("Failed to parse %s: %s", file_path, exc)

    # Stable synthetic fallback for CI/smoke.
    rng = np.random.default_rng(42)
    baseline = rng.normal(100.0, 10.0, 80).tolist()
    recent = list(baseline)
    return {
        "source": "synthetic_fallback",
        "baseline_values": baseline,
        "recent_values": recent,
        "baseline_actuals": None,
        "baseline_predictions": None,
        "recent_actuals": None,
        "recent_predictions": None,
    }


def _build_series_for_training(series_id: str, artifact_dir: str) -> SalesSeries:
    data = _load_series_data(series_id, artifact_dir)
    values = [float(v) for v in data["baseline_values"] + data["recent_values"]]
    dates = pd.date_range(end=pd.Timestamp.now().normalize(), periods=len(values), freq="D")
    return SalesSeries(sku=series_id, dates=dates.tolist(), values=values)


def _latest_training_timestamp(series_id: str, registry_root: str) -> Optional[str]:
    registry = ModelLifecycleRegistry(root=registry_root)
    prod_record = registry.get_prod_artifact(series_id)
    if not prod_record:
        return None
    return prod_record.get("created_at")


def step_drift(series_id: str, artifact_dir: str) -> Dict[str, Any]:
    logger.info("[Step 1/4] drift analysis for series=%s", series_id)
    data = _load_series_data(series_id, artifact_dir)
    report = run_drift_analysis(
        series_id=series_id,
        baseline_values=data["baseline_values"],
        recent_values=data["recent_values"],
        baseline_actuals=data.get("baseline_actuals"),
        baseline_predictions=data.get("baseline_predictions"),
        recent_actuals=data.get("recent_actuals"),
        recent_predictions=data.get("recent_predictions"),
        config=DriftConfig(),
    )
    result = report.to_dict()
    result["data_source"] = data["source"]
    return result


def step_evaluate(
    series_id: str,
    drift_report: Dict[str, Any],
    *,
    registry_root: str,
    trigger_root: str,
    auto_retrain_enabled: bool,
    record_events: bool,
) -> Dict[str, Any]:
    logger.info("[Step 2/4] trigger evaluation for series=%s", series_id)
    trigger_store = RetainTriggerStore(root=trigger_root)
    history = trigger_store.get_history(series_id=series_id, limit=50)

    context = RetainTriggerContext(
        series_id=series_id,
        data_drift_score=float(drift_report.get("data_drift_score") or 0.0),
        residual_drift_score=float(drift_report.get("residual_drift_score") or 0.0),
        drift_flags=list(drift_report.get("drift_flags") or []),
        recent_mape=drift_report.get("recent_mape"),
        baseline_mape=drift_report.get("baseline_mape"),
        recent_coverage=drift_report.get("recent_coverage"),
        recent_bias=drift_report.get("recent_bias"),
        coverage_history=[],
        last_trained_at=_latest_training_timestamp(series_id, registry_root),
        window_end=_now_iso(),
    )
    config = RetainTriggerConfig(auto_retrain_enabled=auto_retrain_enabled)
    result = evaluate_retrain_trigger(context, config=config, trigger_history=history)
    result_dict = result.to_dict()
    if record_events and (result.should_retrain or result.reasons):
        trigger_store.record_trigger(
            series_id=series_id,
            result=result,
            window_end=context.window_end,
        )
    return result_dict


def step_train(
    series_id: str,
    *,
    artifact_dir: str,
    champion_dir: str,
    dry_run: bool,
    candidate_models: List[str],
    horizon: int,
    hpo_enabled: bool = False,
    hpo_n_trials: int = 30,
    hpo_timeout_seconds: Optional[int] = None,
) -> Dict[str, Any]:
    if dry_run:
        logger.info("[Step 3/4] dry-run skip training for series=%s", series_id)
        return {"skipped": True, "reason": "dry_run"}

    logger.info("[Step 3/4] training for series=%s models=%s hpo=%s", series_id, candidate_models, hpo_enabled)
    series = _build_series_for_training(series_id, artifact_dir)
    run_id = f"ci_retrain_{uuid.uuid4().hex[:8]}"
    result = run_orchestrator(
        series=series,
        candidate_models=candidate_models,
        horizon=horizon,
        val_ratio=0.15,
        seed=42,
        run_id=run_id,
        artifact_root=artifact_dir,
        champion_dir=champion_dir,
        hpo_enabled=hpo_enabled,
        hpo_n_trials=hpo_n_trials,
        hpo_timeout_seconds=hpo_timeout_seconds,
    )
    payload = result.to_dict()
    champion = payload.get("champion")
    errors = payload.get("errors", [])
    if champion is None:
        raise RuntimeError(
            f"No champion produced for series={series_id}. "
            f"Candidate model failures: {errors}"
        )
    return {
        "run_id": run_id,
        "champion": champion,
        "leaderboard": payload.get("leaderboard", []),
        "errors": errors,
    }


def step_promote(
    series_id: str,
    train_result: Dict[str, Any],
    *,
    registry_root: str,
    dry_run: bool,
    max_promote_mape: float,
) -> Dict[str, Any]:
    if dry_run or train_result.get("skipped"):
        logger.info("[Step 4/4] dry-run/train-skip promote skipped for series=%s", series_id)
        return {"skipped": True, "reason": "dry_run_or_training_skipped"}

    champion = train_result.get("champion") or {}
    artifact_dir = champion.get("artifact_dir")
    if not artifact_dir:
        return {"skipped": True, "reason": "missing_artifact_dir"}

    val_mape = float(champion.get("val_mape", 999.0))
    if val_mape >= max_promote_mape:
        return {
            "skipped": True,
            "reason": "quality_gate_failed",
            "val_mape": val_mape,
            "threshold": max_promote_mape,
        }

    registry = ModelLifecycleRegistry(root=registry_root)
    artifact_id = registry.register_artifact(
        artifact_path=artifact_dir,
        metadata={
            "series_id": series_id,
            "model_name": champion.get("model_name", "unknown"),
            "metrics_summary": {"mape": val_mape},
            "dataset_fingerprint": champion.get("dataset_fingerprint", ""),
            "git_sha": "",
        },
    )
    record = registry.promote_to_prod(
        series_id=series_id,
        artifact_id=artifact_id,
        approved_by="ci/automl_retrain_pipeline",
        note=(
            f"Auto-promoted by CI pipeline "
            f"(model={champion.get('model_name')}, val_mape={val_mape:.4f})"
        ),
    )
    return {
        "artifact_id": artifact_id,
        "lifecycle_state": record.get("lifecycle_state"),
        "model_name": champion.get("model_name"),
        "val_mape": val_mape,
    }


def run_pipeline(
    *,
    series_ids: List[str],
    artifact_dir: str = DEFAULT_ARTIFACT_DIR,
    champion_dir: str = DEFAULT_CHAMPION_DIR,
    registry_root: str = DEFAULT_REGISTRY_ROOT,
    trigger_root: str = DEFAULT_TRIGGER_ROOT,
    report_path: str = DEFAULT_REPORT_PATH,
    dry_run: bool = False,
    step_only: Optional[str] = None,
    candidate_models: Optional[List[str]] = None,
    horizon: int = DEFAULT_HORIZON,
    max_promote_mape: float = DEFAULT_PROMOTION_MAPE_THRESHOLD,
    hpo_enabled: bool = DEFAULT_HPO_ENABLED,
    hpo_n_trials: int = DEFAULT_HPO_TRIALS,
    hpo_timeout_seconds: Optional[int] = DEFAULT_HPO_TIMEOUT,
) -> Dict[str, Any]:
    """
    Run the retrain pipeline over one or more series IDs.
    """
    candidate_models = candidate_models or [
        x.strip() for x in DEFAULT_CANDIDATE_MODELS.split(",") if x.strip()
    ]
    pipeline_id = f"pipeline_{uuid.uuid4().hex[:8]}"
    started_at = _now_iso()
    auto_retrain_enabled = _env_flag("ENABLE_AUTO_RETRAIN", default=False)

    logger.info(
        "Pipeline start id=%s series=%s step=%s dry_run=%s auto_retrain=%s",
        pipeline_id,
        series_ids,
        step_only or "all",
        dry_run,
        auto_retrain_enabled,
    )

    series_results: Dict[str, Dict[str, Any]] = {}
    for raw_series in series_ids:
        series_id = raw_series.strip()
        if not series_id:
            continue

        result: Dict[str, Any] = {
            "series_id": series_id,
            "drift": None,
            "evaluate": None,
            "train": None,
            "promote": None,
            "outcome": "pending",
            "error": None,
        }
        try:
            if _should_run_step("drift", step_only):
                result["drift"] = step_drift(series_id, artifact_dir)
            if _should_run_step("evaluate", step_only):
                result["evaluate"] = step_evaluate(
                    series_id,
                    result["drift"] or {},
                    registry_root=registry_root,
                    trigger_root=trigger_root,
                    auto_retrain_enabled=auto_retrain_enabled,
                    record_events=(not dry_run),
                )
            if _should_run_step("train", step_only):
                should_retrain = bool((result.get("evaluate") or {}).get("should_retrain"))
                force_train = step_only in {"train", "promote"}
                if should_retrain or force_train:
                    result["train"] = step_train(
                        series_id,
                        artifact_dir=artifact_dir,
                        champion_dir=champion_dir,
                        dry_run=dry_run,
                        candidate_models=candidate_models,
                        horizon=horizon,
                        hpo_enabled=hpo_enabled,
                        hpo_n_trials=hpo_n_trials,
                        hpo_timeout_seconds=hpo_timeout_seconds,
                    )
                else:
                    result["train"] = {"skipped": True, "reason": "trigger_not_fired"}
            if _should_run_step("promote", step_only):
                result["promote"] = step_promote(
                    series_id,
                    result.get("train") or {"skipped": True, "reason": "missing_train"},
                    registry_root=registry_root,
                    dry_run=dry_run,
                    max_promote_mape=max_promote_mape,
                )
            result["outcome"] = "success"
        except Exception as exc:
            logger.exception("Pipeline failed for series=%s", series_id)
            result["outcome"] = "error"
            result["error"] = str(exc)

        series_results[series_id] = result

    retrain_triggered = [
        sid
        for sid, item in series_results.items()
        if bool((item.get("evaluate") or {}).get("should_retrain"))
    ]
    retrain_completed = [
        sid
        for sid, item in series_results.items()
        if item.get("outcome") == "success"
        and not bool((item.get("train") or {}).get("skipped", True))
    ]
    promoted = [
        sid
        for sid, item in series_results.items()
        if item.get("outcome") == "success"
        and not bool((item.get("promote") or {}).get("skipped", True))
    ]

    report = {
        "pipeline_id": pipeline_id,
        "pipeline_version": PIPELINE_VERSION,
        "started_at": started_at,
        "finished_at": _now_iso(),
        "dry_run": dry_run,
        "step_only": step_only or "all",
        "series_count": len(series_results),
        "retrain_triggered_count": len(retrain_triggered),
        "retrain_triggered": retrain_triggered,
        "retrain_completed_count": len(retrain_completed),
        "retrain_completed": retrain_completed,
        "promoted_count": len(promoted),
        "promoted": promoted,
        "enable_auto_retrain": auto_retrain_enabled,
        "candidate_models": candidate_models,
        "series_results": series_results,
    }

    report_file = Path(report_path)
    report_file.parent.mkdir(parents=True, exist_ok=True)
    with open(report_file, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, ensure_ascii=False, default=str)
    logger.info("Pipeline report saved: %s", report_file)

    print(
        json.dumps(
            {
                "pipeline_id": report["pipeline_id"],
                "series_count": report["series_count"],
                "retrain_triggered": report["retrain_triggered"],
                "retrain_completed": report["retrain_completed"],
                "promoted": report["promoted"],
                "dry_run": report["dry_run"],
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(
        description="AutoML Retrain Pipeline: drift -> evaluate -> train -> promote",
    )
    parser.add_argument(
        "--series",
        type=str,
        default=DEFAULT_MONITORED_SERIES,
        help="Comma-separated series IDs to process.",
    )
    parser.add_argument(
        "--artifact-dir",
        type=str,
        default=DEFAULT_ARTIFACT_DIR,
        help="Forecast artifact root.",
    )
    parser.add_argument(
        "--champion-dir",
        type=str,
        default=DEFAULT_CHAMPION_DIR,
        help="Champion artifact root.",
    )
    parser.add_argument(
        "--registry-root",
        type=str,
        default=DEFAULT_REGISTRY_ROOT,
        help="Model lifecycle registry root.",
    )
    parser.add_argument(
        "--trigger-root",
        type=str,
        default=DEFAULT_TRIGGER_ROOT,
        help="Retrain trigger event root.",
    )
    parser.add_argument(
        "--report",
        type=str,
        default=DEFAULT_REPORT_PATH,
        help="Pipeline report output JSON path.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip training and promotion steps.",
    )
    parser.add_argument(
        "--step",
        choices=["drift", "evaluate", "train", "promote", "all"],
        default=None,
        help="Run up to a specific step.",
    )
    parser.add_argument(
        "--candidates",
        type=str,
        default=DEFAULT_CANDIDATE_MODELS,
        help="Comma-separated candidate models for training step.",
    )
    parser.add_argument(
        "--horizon",
        type=int,
        default=DEFAULT_HORIZON,
        help="Forecast horizon for training step.",
    )
    parser.add_argument(
        "--max-promote-mape",
        type=float,
        default=DEFAULT_PROMOTION_MAPE_THRESHOLD,
        help="Promotion quality gate: val_mape must be below this threshold.",
    )
    parser.add_argument(
        "--hpo",
        action="store_true",
        default=DEFAULT_HPO_ENABLED,
        help="Enable Optuna HPO for LightGBM training.",
    )
    parser.add_argument(
        "--hpo-trials",
        type=int,
        default=DEFAULT_HPO_TRIALS,
        help="Number of Optuna HPO trials (default: 30).",
    )
    parser.add_argument(
        "--hpo-timeout",
        type=int,
        default=DEFAULT_HPO_TIMEOUT,
        help="HPO wall-clock timeout in seconds (default: unlimited).",
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    series_ids = [x.strip() for x in args.series.split(",") if x.strip()]
    candidate_models = [x.strip() for x in args.candidates.split(",") if x.strip()]

    report = run_pipeline(
        series_ids=series_ids,
        artifact_dir=args.artifact_dir,
        champion_dir=args.champion_dir,
        registry_root=args.registry_root,
        trigger_root=args.trigger_root,
        report_path=args.report,
        dry_run=args.dry_run,
        step_only=args.step,
        candidate_models=candidate_models,
        horizon=args.horizon,
        max_promote_mape=args.max_promote_mape,
        hpo_enabled=args.hpo,
        hpo_n_trials=args.hpo_trials,
        hpo_timeout_seconds=args.hpo_timeout,
    )
    failed_series = [
        sid for sid, item in report.get("series_results", {}).items() if item.get("outcome") == "error"
    ]
    if failed_series:
        logger.error("Pipeline completed with failures: %s", failed_series)
        raise SystemExit(1)
    raise SystemExit(0)


if __name__ == "__main__":
    main()
