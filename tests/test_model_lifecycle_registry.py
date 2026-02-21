"""
PR-E Tests: Model Lifecycle Registry
======================================
Deterministic tests for:
  - register → stage → promote → rollback lifecycle
  - promotion history recording
  - prod pointer management
  - concurrent series management
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest
from ml.registry.model_registry import (
    LifecycleState,
    ModelLifecycleRegistry,
)


@pytest.fixture
def registry(tmp_path):
    """Create a fresh registry in a temp directory."""
    return ModelLifecycleRegistry(root=str(tmp_path / "registry"))


@pytest.fixture
def sample_metadata():
    return {
        "series_id": "SKU-001",
        "model_name": "lightgbm",
        "dataset_fingerprint": "fp_abc123",
        "feature_spec_hash": "hash_v1",
        "training_window_start": "2025-01-01",
        "training_window_end": "2025-06-01",
        "metrics_summary": {
            "mape": 12.5,
            "coverage_10_90": 0.82,
            "pinball": 15.0,
            "bias": -2.3,
        },
        "calibration_passed": True,
        "calibration_scope_used": "per_series",
    }


class TestRegisterArtifact:
    def test_register_returns_artifact_id(self, registry, sample_metadata):
        art_id = registry.register_artifact("/fake/path/model", sample_metadata)
        assert art_id.startswith("art_")
        assert len(art_id) > 4

    def test_registered_artifact_is_candidate(self, registry, sample_metadata):
        art_id = registry.register_artifact("/fake/path/model", sample_metadata)
        record = registry.get_artifact(art_id)
        assert record is not None
        assert record["lifecycle_state"] == LifecycleState.CANDIDATE.value

    def test_register_preserves_metadata(self, registry, sample_metadata):
        art_id = registry.register_artifact("/fake/path/model", sample_metadata)
        record = registry.get_artifact(art_id)
        assert record["series_id"] == "SKU-001"
        assert record["model_name"] == "lightgbm"
        assert record["dataset_fingerprint"] == "fp_abc123"
        assert record["metrics_summary"]["mape"] == 12.5
        assert record["calibration_passed"] is True

    def test_register_multiple_artifacts(self, registry, sample_metadata):
        id1 = registry.register_artifact("/fake/path/m1", sample_metadata)
        id2 = registry.register_artifact("/fake/path/m2", sample_metadata)
        assert id1 != id2
        assert len(registry.list_artifacts()) == 2


class TestListAndFilter:
    def test_list_all(self, registry, sample_metadata):
        registry.register_artifact("/fake/m1", sample_metadata)
        meta2 = {**sample_metadata, "series_id": "SKU-002"}
        registry.register_artifact("/fake/m2", meta2)
        assert len(registry.list_artifacts()) == 2

    def test_filter_by_series_id(self, registry, sample_metadata):
        registry.register_artifact("/fake/m1", sample_metadata)
        meta2 = {**sample_metadata, "series_id": "SKU-002"}
        registry.register_artifact("/fake/m2", meta2)
        filtered = registry.list_artifacts({"series_id": "SKU-001"})
        assert len(filtered) == 1
        assert filtered[0]["series_id"] == "SKU-001"

    def test_filter_by_lifecycle_state(self, registry, sample_metadata):
        art_id = registry.register_artifact("/fake/m1", sample_metadata)
        registry.set_stage("SKU-001", art_id)
        candidates = registry.list_artifacts({"lifecycle_state": "CANDIDATE"})
        staged = registry.list_artifacts({"lifecycle_state": "STAGED"})
        assert len(candidates) == 0
        assert len(staged) == 1


class TestStageAndPromote:
    def test_set_stage(self, registry, sample_metadata):
        art_id = registry.register_artifact("/fake/m1", sample_metadata)
        record = registry.set_stage("SKU-001", art_id)
        assert record["lifecycle_state"] == LifecycleState.STAGED.value

    def test_stage_wrong_series_raises(self, registry, sample_metadata):
        art_id = registry.register_artifact("/fake/m1", sample_metadata)
        with pytest.raises(ValueError, match="belongs to series"):
            registry.set_stage("WRONG-SERIES", art_id)

    def test_promote_to_prod(self, registry, sample_metadata):
        art_id = registry.register_artifact("/fake/m1", sample_metadata)
        registry.set_stage("SKU-001", art_id)
        record = registry.promote_to_prod(
            "SKU-001", art_id,
            approved_by="test-user",
            note="Initial production deployment",
        )
        assert record["lifecycle_state"] == LifecycleState.PROD.value

    def test_prod_pointer_set_after_promote(self, registry, sample_metadata):
        art_id = registry.register_artifact("/fake/m1", sample_metadata)
        registry.promote_to_prod("SKU-001", art_id)
        assert registry.get_prod_pointer("SKU-001") == art_id

    def test_promote_deprecates_previous_prod(self, registry, sample_metadata):
        id1 = registry.register_artifact("/fake/m1", sample_metadata)
        registry.promote_to_prod("SKU-001", id1)

        id2 = registry.register_artifact("/fake/m2", sample_metadata)
        registry.promote_to_prod("SKU-001", id2)

        old_record = registry.get_artifact(id1)
        assert old_record["lifecycle_state"] == LifecycleState.DEPRECATED.value
        assert registry.get_prod_pointer("SKU-001") == id2


class TestPromotionHistory:
    def test_promotion_history_recorded(self, registry, sample_metadata):
        art_id = registry.register_artifact("/fake/m1", sample_metadata)
        registry.set_stage("SKU-001", art_id)
        registry.promote_to_prod("SKU-001", art_id, note="Go live")

        record = registry.get_artifact(art_id)
        history = record["promotion_history"]
        assert len(history) == 2  # stage + promote
        assert history[0]["to_state"] == "STAGED"
        assert history[1]["to_state"] == "PROD"
        assert history[1]["note"] == "Go live"

    def test_promotion_log(self, registry, sample_metadata):
        art_id = registry.register_artifact("/fake/m1", sample_metadata)
        registry.promote_to_prod("SKU-001", art_id, note="v1")
        log = registry.get_promotion_log()
        assert len(log) >= 1
        assert log[-1]["to_state"] == "PROD"

    def test_promotion_log_filter_by_series(self, registry, sample_metadata):
        art_id = registry.register_artifact("/fake/m1", sample_metadata)
        registry.promote_to_prod("SKU-001", art_id)

        meta2 = {**sample_metadata, "series_id": "SKU-002"}
        id2 = registry.register_artifact("/fake/m2", meta2)
        registry.promote_to_prod("SKU-002", id2)

        log = registry.get_promotion_log(series_id="SKU-001")
        assert all(e["series_id"] == "SKU-001" for e in log)


class TestRollback:
    def test_rollback_restores_previous_prod(self, registry, sample_metadata):
        id1 = registry.register_artifact("/fake/m1", sample_metadata)
        registry.promote_to_prod("SKU-001", id1, note="v1")

        id2 = registry.register_artifact("/fake/m2", sample_metadata)
        registry.promote_to_prod("SKU-001", id2, note="v2")

        assert registry.get_prod_pointer("SKU-001") == id2

        restored = registry.rollback_prod("SKU-001", steps=1)
        assert restored is not None
        assert restored["artifact_id"] == id1
        assert restored["lifecycle_state"] == LifecycleState.PROD.value
        assert registry.get_prod_pointer("SKU-001") == id1

    def test_rollback_deprecates_current(self, registry, sample_metadata):
        id1 = registry.register_artifact("/fake/m1", sample_metadata)
        registry.promote_to_prod("SKU-001", id1)

        id2 = registry.register_artifact("/fake/m2", sample_metadata)
        registry.promote_to_prod("SKU-001", id2)

        registry.rollback_prod("SKU-001", steps=1)
        record2 = registry.get_artifact(id2)
        assert record2["lifecycle_state"] == LifecycleState.DEPRECATED.value

    def test_rollback_returns_none_with_no_history(self, registry, sample_metadata):
        id1 = registry.register_artifact("/fake/m1", sample_metadata)
        registry.promote_to_prod("SKU-001", id1)
        # Only one PROD ever, so rollback should return None
        result = registry.rollback_prod("SKU-001", steps=1)
        assert result is None

    def test_rollback_history_recorded(self, registry, sample_metadata):
        id1 = registry.register_artifact("/fake/m1", sample_metadata)
        registry.promote_to_prod("SKU-001", id1)

        id2 = registry.register_artifact("/fake/m2", sample_metadata)
        registry.promote_to_prod("SKU-001", id2)

        registry.rollback_prod("SKU-001", steps=1)
        record1 = registry.get_artifact(id1)
        history = record1["promotion_history"]
        last_event = history[-1]
        assert last_event["to_state"] == "PROD"
        assert "Rollback" in last_event["note"]


class TestMultiSeries:
    def test_independent_prod_pointers(self, registry, sample_metadata):
        id1 = registry.register_artifact("/fake/m1", sample_metadata)
        registry.promote_to_prod("SKU-001", id1)

        meta2 = {**sample_metadata, "series_id": "SKU-002"}
        id2 = registry.register_artifact("/fake/m2", meta2)
        registry.promote_to_prod("SKU-002", id2)

        pointers = registry.get_all_prod_pointers()
        assert pointers["SKU-001"] == id1
        assert pointers["SKU-002"] == id2

    def test_promote_one_does_not_affect_other(self, registry, sample_metadata):
        id1 = registry.register_artifact("/fake/m1", sample_metadata)
        registry.promote_to_prod("SKU-001", id1)

        meta2 = {**sample_metadata, "series_id": "SKU-002"}
        id2 = registry.register_artifact("/fake/m2", meta2)
        registry.promote_to_prod("SKU-002", id2)

        # Promote new one for SKU-001
        id3 = registry.register_artifact("/fake/m3", sample_metadata)
        registry.promote_to_prod("SKU-001", id3)

        # SKU-002 should be unaffected
        assert registry.get_prod_pointer("SKU-002") == id2
        assert registry.get_prod_pointer("SKU-001") == id3
