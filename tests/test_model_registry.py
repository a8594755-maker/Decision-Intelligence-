"""
P0-2.1: Unit tests for model_registry.py
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import pytest
import json
import tempfile
import shutil
from ml.demand_forecasting.model_registry import ModelRegistry


@pytest.fixture
def tmp_registry(tmp_path):
    """Create a temp registry for isolated tests"""
    return ModelRegistry(root=str(tmp_path / "models"))


class TestModelRegistrySave:
    def test_save_returns_version(self, tmp_registry):
        version = tmp_registry.save(
            model_type="lightgbm",
            sku="_global",
            model_obj={"fake": "model"},  # will pickle
            meta={"val_mape": 5.0}
        )
        assert version == "v001"

    def test_save_increments_version(self, tmp_registry):
        v1 = tmp_registry.save("lightgbm", "_global", {"v": 1}, {"val_mape": 10.0})
        v2 = tmp_registry.save("lightgbm", "_global", {"v": 2}, {"val_mape": 8.0})
        assert v1 == "v001"
        assert v2 == "v002"

    def test_save_creates_meta_json(self, tmp_registry):
        tmp_registry.save("lightgbm", "SKU-A", {"m": 1}, {"val_mape": 7.0, "train_samples": 300})
        meta_path = os.path.join(tmp_registry.root, "lightgbm", "SKU-A", "v001", "meta.json")
        assert os.path.exists(meta_path)
        with open(meta_path, 'r') as f:
            meta = json.load(f)
        assert meta["val_mape"] == 7.0
        assert meta["version"] == "v001"
        assert meta["sku"] == "SKU-A"
        assert "saved_at" in meta

    def test_save_creates_model_file(self, tmp_registry):
        tmp_registry.save("lightgbm", "_global", {"m": 1}, {})
        model_path = os.path.join(tmp_registry.root, "lightgbm", "_global", "v001", "model.pkl")
        assert os.path.exists(model_path)

    def test_save_prophet_json(self, tmp_registry):
        """Prophet saves as model.json with string content"""
        json_str = '{"fake_prophet": true}'
        tmp_registry.save("prophet", "_global", json_str, {"val_mape": 12.0})
        model_path = os.path.join(tmp_registry.root, "prophet", "_global", "v001", "model.json")
        assert os.path.exists(model_path)
        with open(model_path, 'r') as f:
            content = f.read()
        assert content == json_str


class TestModelRegistryLoad:
    def test_load_latest(self, tmp_registry):
        tmp_registry.save("lightgbm", "_global", {"version": 1}, {"val_mape": 10.0})
        tmp_registry.save("lightgbm", "_global", {"version": 2}, {"val_mape": 7.0})
        model, meta = tmp_registry.load("lightgbm", "_global", version="latest")
        assert model["version"] == 2
        assert meta["val_mape"] == 7.0

    def test_load_specific_version(self, tmp_registry):
        tmp_registry.save("lightgbm", "_global", {"version": 1}, {"val_mape": 10.0})
        tmp_registry.save("lightgbm", "_global", {"version": 2}, {"val_mape": 7.0})
        model, meta = tmp_registry.load("lightgbm", "_global", version="v001")
        assert model["version"] == 1
        assert meta["val_mape"] == 10.0

    def test_load_nonexistent_raises(self, tmp_registry):
        with pytest.raises(FileNotFoundError):
            tmp_registry.load("lightgbm", "NONEXISTENT")

    def test_load_nonexistent_version_raises(self, tmp_registry):
        tmp_registry.save("lightgbm", "_global", {"m": 1}, {})
        with pytest.raises(FileNotFoundError):
            tmp_registry.load("lightgbm", "_global", version="v999")


class TestModelRegistryListVersions:
    def test_list_empty(self, tmp_registry):
        versions = tmp_registry.list_versions("lightgbm", "_global")
        assert versions == []

    def test_list_versions(self, tmp_registry):
        tmp_registry.save("lightgbm", "SKU-X", {"m": 1}, {"val_mape": 10.0})
        tmp_registry.save("lightgbm", "SKU-X", {"m": 2}, {"val_mape": 8.0})
        tmp_registry.save("lightgbm", "SKU-X", {"m": 3}, {"val_mape": 6.0})
        versions = tmp_registry.list_versions("lightgbm", "SKU-X")
        assert len(versions) == 3
        assert versions[0]["version"] == "v001"
        assert versions[2]["version"] == "v003"
        assert versions[2]["is_latest"]
        assert not versions[0]["is_latest"]


class TestModelRegistryRollback:
    def test_rollback(self, tmp_registry):
        tmp_registry.save("lightgbm", "_global", {"version": 1}, {"val_mape": 10.0})
        tmp_registry.save("lightgbm", "_global", {"version": 2}, {"val_mape": 15.0})  # bad
        assert tmp_registry.get_latest_version("lightgbm", "_global") == "v002"

        tmp_registry.rollback("lightgbm", "_global", "v001")
        assert tmp_registry.get_latest_version("lightgbm", "_global") == "v001"

        model, meta = tmp_registry.load("lightgbm", "_global")
        assert model["version"] == 1

    def test_rollback_nonexistent_raises(self, tmp_registry):
        with pytest.raises(FileNotFoundError):
            tmp_registry.rollback("lightgbm", "_global", "v999")


class TestModelRegistryIsolation:
    def test_different_skus_isolated(self, tmp_registry):
        tmp_registry.save("lightgbm", "SKU-A", {"sku": "A"}, {})
        tmp_registry.save("lightgbm", "SKU-B", {"sku": "B"}, {})
        model_a, _ = tmp_registry.load("lightgbm", "SKU-A")
        model_b, _ = tmp_registry.load("lightgbm", "SKU-B")
        assert model_a["sku"] == "A"
        assert model_b["sku"] == "B"

    def test_different_model_types_isolated(self, tmp_registry):
        tmp_registry.save("lightgbm", "_global", {"type": "lgb"}, {})
        tmp_registry.save("prophet", "_global", '{"type": "prophet"}', {})
        lgb_model, _ = tmp_registry.load("lightgbm", "_global")
        assert lgb_model["type"] == "lgb"
