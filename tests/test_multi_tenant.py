"""
Phase 4.7 – Multi-Tenant Readiness Prototype Tests
===================================================
Tests for: tenant_id in ArtifactRecord, tenant-scoped storage,
           X-Tenant-ID middleware extraction.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest
from ml.registry.model_registry import (
    ArtifactRecord,
    ModelLifecycleRegistry,
)


class TestArtifactRecordTenantId:
    """ArtifactRecord includes tenant_id field."""

    def test_default_tenant_id_empty(self):
        rec = ArtifactRecord(
            artifact_id="art_test",
            series_id="SKU-A",
            model_name="lgbm",
            artifact_path="/tmp/model",
        )
        assert rec.tenant_id == ""

    def test_tenant_id_set(self):
        rec = ArtifactRecord(
            artifact_id="art_test",
            series_id="SKU-A",
            model_name="lgbm",
            artifact_path="/tmp/model",
            tenant_id="tenant_acme",
        )
        assert rec.tenant_id == "tenant_acme"

    def test_tenant_id_in_dict(self):
        rec = ArtifactRecord(
            artifact_id="art_test",
            series_id="SKU-A",
            model_name="lgbm",
            artifact_path="/tmp/model",
            tenant_id="t1",
        )
        d = rec.to_dict()
        assert "tenant_id" in d
        assert d["tenant_id"] == "t1"

    def test_from_dict_with_tenant_id(self):
        d = {
            "artifact_id": "art_1",
            "series_id": "S",
            "model_name": "m",
            "artifact_path": "/p",
            "tenant_id": "t2",
        }
        rec = ArtifactRecord.from_dict(d)
        assert rec.tenant_id == "t2"


class TestTenantScopedRegistry:
    """ModelLifecycleRegistry with tenant_id uses isolated storage."""

    def test_default_no_tenant_uses_root(self, tmp_path):
        reg = ModelLifecycleRegistry(root=str(tmp_path / "reg"))
        assert reg._tenant_root == str(tmp_path / "reg")

    def test_tenant_uses_scoped_path(self, tmp_path):
        reg = ModelLifecycleRegistry(root=str(tmp_path / "reg"), tenant_id="acme")
        assert "tenants" in reg._tenant_root
        assert reg._tenant_root.endswith("acme")

    def test_tenant_isolation_artifacts(self, tmp_path):
        """Two tenants see isolated artifacts."""
        reg_a = ModelLifecycleRegistry(root=str(tmp_path / "reg"), tenant_id="tenant_a")
        reg_b = ModelLifecycleRegistry(root=str(tmp_path / "reg"), tenant_id="tenant_b")
        reg_default = ModelLifecycleRegistry(root=str(tmp_path / "reg"))

        aid_a = reg_a.register_artifact("/model/a", {"series_id": "SKU-1", "model_name": "lgbm"})
        aid_b = reg_b.register_artifact("/model/b", {"series_id": "SKU-1", "model_name": "lgbm"})

        # Each tenant only sees its own
        assert len(reg_a.list_artifacts()) == 1
        assert len(reg_b.list_artifacts()) == 1
        assert reg_a.list_artifacts()[0]["artifact_id"] == aid_a
        assert reg_b.list_artifacts()[0]["artifact_id"] == aid_b

        # Default (no tenant) sees nothing from tenant registries
        assert len(reg_default.list_artifacts()) == 0

    def test_tenant_id_stored_in_artifact(self, tmp_path):
        reg = ModelLifecycleRegistry(root=str(tmp_path / "reg"), tenant_id="t1")
        aid = reg.register_artifact("/model/x", {"series_id": "S", "model_name": "m"})
        record = reg.get_artifact(aid)
        assert record["tenant_id"] == "t1"

    def test_list_artifacts_filter_by_tenant_id(self, tmp_path):
        """list_artifacts supports tenant_id filter."""
        reg = ModelLifecycleRegistry(root=str(tmp_path / "reg"), tenant_id="t1")
        reg.register_artifact("/model/a", {"series_id": "S1", "model_name": "m"})
        reg.register_artifact("/model/b", {"series_id": "S2", "model_name": "m"})

        all_arts = reg.list_artifacts()
        assert len(all_arts) == 2

        filtered = reg.list_artifacts(filters={"tenant_id": "t1"})
        assert len(filtered) == 2

        filtered_wrong = reg.list_artifacts(filters={"tenant_id": "t999"})
        assert len(filtered_wrong) == 0

    def test_tenant_promotion_isolation(self, tmp_path):
        """Promotion events are tenant-scoped."""
        reg_a = ModelLifecycleRegistry(root=str(tmp_path / "reg"), tenant_id="ta")
        reg_b = ModelLifecycleRegistry(root=str(tmp_path / "reg"), tenant_id="tb")

        aid_a = reg_a.register_artifact("/m/a", {"series_id": "S", "model_name": "m"})
        reg_a.promote_to_prod("S", aid_a, enforce_gates=False)

        aid_b = reg_b.register_artifact("/m/b", {"series_id": "S", "model_name": "m"})
        reg_b.promote_to_prod("S", aid_b, enforce_gates=False)

        # Each tenant has its own prod pointer
        assert reg_a.get_prod_pointer("S") == aid_a
        assert reg_b.get_prod_pointer("S") == aid_b

        # Promotion logs are isolated
        log_a = reg_a.get_promotion_log("S")
        log_b = reg_b.get_promotion_log("S")
        assert len(log_a) == 1
        assert len(log_b) == 1
        assert log_a[0]["artifact_id"] == aid_a
        assert log_b[0]["artifact_id"] == aid_b


class TestTenantIdMiddleware:
    """Verify X-Tenant-ID middleware helper."""

    def test_tenant_id_helper_from_main(self):
        from ml.api.main import _tenant_id_from_request

        class MockState:
            tenant_id = "acme_corp"

        class MockRequest:
            state = MockState()

        assert _tenant_id_from_request(MockRequest()) == "acme_corp"

    def test_tenant_id_helper_empty(self):
        from ml.api.main import _tenant_id_from_request

        class MockState:
            pass

        class MockRequest:
            state = MockState()

        assert _tenant_id_from_request(MockRequest()) == ""
