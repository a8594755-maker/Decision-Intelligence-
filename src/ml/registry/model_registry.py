"""
PR-E Deliverable 1: Model Lifecycle Registry
=============================================
Filesystem-based JSON registry that tracks model artifacts through
lifecycle states: CANDIDATE -> STAGED -> PROD -> DEPRECATED.

Design choice: filesystem JSON with atomic writes.
Rationale:
  - Consistent with existing ModelRegistry (demand_forecasting/model_registry.py)
    and ArtifactManager (training/artifact_manager.py) patterns.
  - No external DB dependency required; works offline / in CI.
  - Atomic writes via write-to-temp + os.replace prevent corruption.

Storage layout:
  <registry_root>/
    artifacts.json        # {artifact_id: ArtifactRecord}
    prod_pointers.json    # {series_id: artifact_id}
    promotion_log.json    # [PromotionEvent, ...]
"""
import json
import logging
import os
import platform
import subprocess
import tempfile
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

DEFAULT_REGISTRY_ROOT = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "registry_store"
)


class LifecycleState(str, Enum):
    CANDIDATE = "CANDIDATE"
    STAGED = "STAGED"
    PROD = "PROD"
    DEPRECATED = "DEPRECATED"


@dataclass
class MetricsSummary:
    mape: Optional[float] = None
    coverage_10_90: Optional[float] = None
    pinball: Optional[float] = None
    bias: Optional[float] = None

    def to_dict(self) -> Dict:
        return {k: v for k, v in asdict(self).items() if v is not None}


@dataclass
class ArtifactRecord:
    artifact_id: str
    series_id: str
    model_name: str
    artifact_path: str
    dataset_fingerprint: str = ""
    feature_spec_hash: str = ""
    training_window_start: str = ""
    training_window_end: str = ""
    metrics_summary: Dict = field(default_factory=dict)
    calibration_passed: Optional[bool] = None
    calibration_scope_used: str = ""
    created_at: str = ""
    git_sha: str = ""
    lifecycle_state: str = LifecycleState.CANDIDATE.value
    promotion_history: List[Dict] = field(default_factory=list)
    tenant_id: str = ""

    def to_dict(self) -> Dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: Dict) -> "ArtifactRecord":
        return ArtifactRecord(**{
            k: v for k, v in d.items()
            if k in ArtifactRecord.__dataclass_fields__
        })


@dataclass
class PromotionEvent:
    artifact_id: str
    series_id: str
    from_state: str
    to_state: str
    approved_by: str = ""
    note: str = ""
    timestamp: str = ""
    override: bool = False

    def to_dict(self) -> Dict:
        return asdict(self)


def _get_git_sha() -> str:
    try:
        return (
            subprocess.check_output(
                ["git", "rev-parse", "HEAD"], stderr=subprocess.DEVNULL
            )
            .decode()
            .strip()[:12]
        )
    except Exception:
        return "unknown"


def _atomic_write_json(path: str, data: Any):
    """Write JSON atomically: write to temp file, then os.replace."""
    dir_name = os.path.dirname(path)
    os.makedirs(dir_name, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False, default=str)
        os.replace(tmp_path, path)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise


def _read_json(path: str, default=None):
    if not os.path.exists(path):
        return default if default is not None else {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


class ModelLifecycleRegistry:
    """
    Filesystem-based model lifecycle registry.

    Tracks artifact records, production pointers, and promotion events
    with atomic writes for crash safety.
    """

    def __init__(self, root: str = None, tenant_id: str = ""):
        self.root = os.path.abspath(root or DEFAULT_REGISTRY_ROOT)
        self.tenant_id = str(tenant_id or "").strip()
        os.makedirs(self._tenant_root, exist_ok=True)

    # ── File paths ──

    @property
    def _tenant_root(self) -> str:
        if self.tenant_id:
            return os.path.join(self.root, "tenants", self.tenant_id)
        return self.root

    @property
    def _artifacts_path(self) -> str:
        return os.path.join(self._tenant_root, "artifacts.json")

    @property
    def _pointers_path(self) -> str:
        return os.path.join(self._tenant_root, "prod_pointers.json")

    @property
    def _promotion_log_path(self) -> str:
        return os.path.join(self._tenant_root, "promotion_log.json")

    # ── Core API ──

    def register_artifact(
        self,
        artifact_path: str,
        metadata: Dict,
    ) -> str:
        """
        Register a new model artifact as CANDIDATE.

        Args:
            artifact_path: Path to model artifact directory.
            metadata: Must include series_id, model_name. May include
                      metrics_summary, dataset_fingerprint, etc.

        Returns:
            artifact_id (stable UUID-based identifier).
        """
        artifact_id = f"art_{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).isoformat()

        record = ArtifactRecord(
            artifact_id=artifact_id,
            series_id=metadata.get("series_id", ""),
            model_name=metadata.get("model_name", ""),
            artifact_path=artifact_path,
            dataset_fingerprint=metadata.get("dataset_fingerprint", ""),
            feature_spec_hash=metadata.get("feature_spec_hash", ""),
            training_window_start=metadata.get("training_window_start", ""),
            training_window_end=metadata.get("training_window_end", ""),
            metrics_summary=metadata.get("metrics_summary", {}),
            calibration_passed=metadata.get("calibration_passed"),
            calibration_scope_used=metadata.get("calibration_scope_used", ""),
            created_at=now,
            git_sha=metadata.get("git_sha", _get_git_sha()),
            lifecycle_state=LifecycleState.CANDIDATE.value,
            promotion_history=[],
            tenant_id=self.tenant_id,
        )

        artifacts = _read_json(self._artifacts_path, {})
        artifacts[artifact_id] = record.to_dict()
        _atomic_write_json(self._artifacts_path, artifacts)

        logger.info(
            "Registered artifact %s for series=%s model=%s",
            artifact_id, record.series_id, record.model_name,
        )
        return artifact_id

    def list_artifacts(self, filters: Optional[Dict] = None) -> List[Dict]:
        """
        List artifacts with optional filters.

        Supported filter keys: series_id, model_name, lifecycle_state.
        """
        artifacts = _read_json(self._artifacts_path, {})
        results = list(artifacts.values())

        if filters:
            for key in ("series_id", "model_name", "lifecycle_state", "tenant_id"):
                if key in filters and filters[key]:
                    results = [r for r in results if r.get(key) == filters[key]]

        return results

    def get_artifact(self, artifact_id: str) -> Optional[Dict]:
        """Get a single artifact record by ID."""
        artifacts = _read_json(self._artifacts_path, {})
        return artifacts.get(artifact_id)

    def set_stage(
        self,
        series_id: str,
        artifact_id: str,
        note: str = "",
    ) -> Dict:
        """
        Mark an artifact as STAGED for a series.

        Returns the updated artifact record.
        """
        artifacts = _read_json(self._artifacts_path, {})
        record = artifacts.get(artifact_id)
        if not record:
            raise ValueError(f"Artifact {artifact_id} not found")

        if record["series_id"] != series_id:
            raise ValueError(
                f"Artifact {artifact_id} belongs to series {record['series_id']}, "
                f"not {series_id}"
            )

        old_state = record["lifecycle_state"]
        record["lifecycle_state"] = LifecycleState.STAGED.value

        event = PromotionEvent(
            artifact_id=artifact_id,
            series_id=series_id,
            from_state=old_state,
            to_state=LifecycleState.STAGED.value,
            note=note,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
        record.setdefault("promotion_history", []).append(event.to_dict())

        artifacts[artifact_id] = record
        _atomic_write_json(self._artifacts_path, artifacts)
        self._append_promotion_log(event)

        logger.info("Staged artifact %s for series %s", artifact_id, series_id)
        return record

    def promote_to_prod(
        self,
        series_id: str,
        artifact_id: str,
        approved_by: str = "",
        note: str = "",
        override: bool = False,
        enforce_gates: bool = True,
    ) -> Dict:
        """
        Promote an artifact to PROD for a series.

        If enforce_gates=True (default), runs promotion quality gates.
        If override=True, skips gate enforcement (but records the override).
        Any previous PROD artifact for the series is set to DEPRECATED.

        Returns the updated artifact record.

        Raises:
            ValueError: If artifact not found or gates fail without override.
        """
        artifacts = _read_json(self._artifacts_path, {})
        record = artifacts.get(artifact_id)
        if not record:
            raise ValueError(f"Artifact {artifact_id} not found")

        if record["series_id"] != series_id:
            raise ValueError(
                f"Artifact {artifact_id} belongs to series {record['series_id']}, "
                f"not {series_id}"
            )

        # --- Gate enforcement (defense in depth) ---
        if enforce_gates and not override:
            try:
                from .promotion_gates import evaluate_promotion_gates

                gate_result = evaluate_promotion_gates(record)
                if not gate_result.can_promote:
                    raise ValueError(
                        f"Promotion gates failed for {artifact_id}: "
                        + "; ".join(gate_result.reasons)
                    )
            except ImportError:
                logger.warning(
                    "promotion_gates module not available, skipping gate check"
                )

        # Deprecate current PROD (if any)
        pointers = _read_json(self._pointers_path, {})
        old_prod_id = pointers.get(series_id)
        if old_prod_id and old_prod_id != artifact_id:
            old_record = artifacts.get(old_prod_id)
            if old_record:
                old_record["lifecycle_state"] = LifecycleState.DEPRECATED.value
                dep_event = PromotionEvent(
                    artifact_id=old_prod_id,
                    series_id=series_id,
                    from_state=LifecycleState.PROD.value,
                    to_state=LifecycleState.DEPRECATED.value,
                    note=f"Superseded by {artifact_id}",
                    timestamp=datetime.now(timezone.utc).isoformat(),
                )
                old_record.setdefault("promotion_history", []).append(dep_event.to_dict())
                artifacts[old_prod_id] = old_record
                self._append_promotion_log(dep_event)

        # Promote new artifact
        old_state = record["lifecycle_state"]
        record["lifecycle_state"] = LifecycleState.PROD.value

        event = PromotionEvent(
            artifact_id=artifact_id,
            series_id=series_id,
            from_state=old_state,
            to_state=LifecycleState.PROD.value,
            approved_by=approved_by,
            note=note,
            timestamp=datetime.now(timezone.utc).isoformat(),
            override=override,
        )
        record.setdefault("promotion_history", []).append(event.to_dict())

        artifacts[artifact_id] = record
        _atomic_write_json(self._artifacts_path, artifacts)

        # Update prod pointer
        pointers[series_id] = artifact_id
        _atomic_write_json(self._pointers_path, pointers)

        self._append_promotion_log(event)

        logger.info(
            "Promoted artifact %s to PROD for series %s (override=%s)",
            artifact_id, series_id, override,
        )
        return record

    def rollback_prod(self, series_id: str, steps: int = 1) -> Optional[Dict]:
        """
        Rollback to a previous PROD artifact for a series.

        Looks through promotion history to find the Nth previous PROD artifact.

        Returns the restored artifact record, or None if no previous PROD found.
        """
        log = _read_json(self._promotion_log_path, [])

        # Find promotion events for this series that promoted TO prod
        prod_promotions = [
            e for e in log
            if e.get("series_id") == series_id
            and e.get("to_state") == LifecycleState.PROD.value
        ]

        if len(prod_promotions) < 2:
            logger.warning(
                "Cannot rollback series %s: not enough PROD history (found %d)",
                series_id, len(prod_promotions),
            )
            return None

        # The target is `steps` back from the most recent
        target_idx = max(0, len(prod_promotions) - 1 - steps)
        target_event = prod_promotions[target_idx]
        target_artifact_id = target_event["artifact_id"]

        artifacts = _read_json(self._artifacts_path, {})
        target_record = artifacts.get(target_artifact_id)
        if not target_record:
            logger.error("Rollback target artifact %s not found", target_artifact_id)
            return None

        # Deprecate current prod
        pointers = _read_json(self._pointers_path, {})
        current_prod_id = pointers.get(series_id)
        if current_prod_id and current_prod_id != target_artifact_id:
            current_record = artifacts.get(current_prod_id)
            if current_record:
                current_record["lifecycle_state"] = LifecycleState.DEPRECATED.value
                dep_event = PromotionEvent(
                    artifact_id=current_prod_id,
                    series_id=series_id,
                    from_state=LifecycleState.PROD.value,
                    to_state=LifecycleState.DEPRECATED.value,
                    note=f"Rolled back in favor of {target_artifact_id}",
                    timestamp=datetime.now(timezone.utc).isoformat(),
                )
                current_record.setdefault("promotion_history", []).append(dep_event.to_dict())
                artifacts[current_prod_id] = current_record
                self._append_promotion_log(dep_event)

        # Restore target to PROD
        old_state = target_record["lifecycle_state"]
        target_record["lifecycle_state"] = LifecycleState.PROD.value

        restore_event = PromotionEvent(
            artifact_id=target_artifact_id,
            series_id=series_id,
            from_state=old_state,
            to_state=LifecycleState.PROD.value,
            note=f"Rollback (steps={steps})",
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
        target_record.setdefault("promotion_history", []).append(restore_event.to_dict())

        artifacts[target_artifact_id] = target_record
        _atomic_write_json(self._artifacts_path, artifacts)

        pointers[series_id] = target_artifact_id
        _atomic_write_json(self._pointers_path, pointers)

        self._append_promotion_log(restore_event)

        logger.info(
            "Rolled back series %s to artifact %s (steps=%d)",
            series_id, target_artifact_id, steps,
        )
        return target_record

    # ── Query helpers ──

    def get_prod_pointer(self, series_id: str) -> Optional[str]:
        """Get the current PROD artifact_id for a series."""
        pointers = _read_json(self._pointers_path, {})
        return pointers.get(series_id)

    def get_prod_artifact(self, series_id: str) -> Optional[Dict]:
        """Get the full PROD artifact record for a series."""
        artifact_id = self.get_prod_pointer(series_id)
        if not artifact_id:
            return None
        return self.get_artifact(artifact_id)

    def get_all_prod_pointers(self) -> Dict[str, str]:
        """Get all current PROD pointers: {series_id: artifact_id}."""
        return _read_json(self._pointers_path, {})

    def get_promotion_log(
        self,
        series_id: Optional[str] = None,
        limit: int = 100,
    ) -> List[Dict]:
        """Get promotion event log, optionally filtered by series."""
        log = _read_json(self._promotion_log_path, [])
        if series_id:
            log = [e for e in log if e.get("series_id") == series_id]
        return log[-limit:]

    # ── Internal helpers ──

    def _append_promotion_log(self, event: PromotionEvent):
        log = _read_json(self._promotion_log_path, [])
        log.append(event.to_dict())
        _atomic_write_json(self._promotion_log_path, log)
