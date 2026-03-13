"""
Tests: Negotiation Policy Registry

Verifies the lifecycle (CANDIDATE -> STAGED -> PROD -> DEPRECATED),
promotion gates, rollback, and filesystem persistence.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import json
import pytest
from ml.registry.negotiation_policy_registry import (
    NegotiationPolicyRegistry,
    PolicyLifecycleState,
    NegotiationPolicyGateConfig,
    evaluate_negotiation_policy_gates,
)


@pytest.fixture
def tmp_registry(tmp_path):
    """Create a temp registry for isolated tests."""
    return NegotiationPolicyRegistry(root=str(tmp_path / "neg_policies"))


@pytest.fixture
def good_metadata():
    """Metadata that passes all promotion gates."""
    return {
        "scenario_id": "cooperative_normal",
        "iterations": 50000,
        "exploitability": 0.01,
        "info_set_count": 120,
        "game_config": {"rounds": 3, "actions": ["accept", "reject", "counter"]},
        "metrics_summary": {"info_set_coverage": 0.98},
    }


@pytest.fixture
def bad_metadata():
    """Metadata that fails promotion gates."""
    return {
        "scenario_id": "aggressive_volatile",
        "iterations": 500,
        "exploitability": 0.20,
        "info_set_count": 40,
        "metrics_summary": {"info_set_coverage": 0.60},
    }


class TestRegisterArtifact:
    def test_register_returns_id(self, tmp_registry, good_metadata):
        aid = tmp_registry.register_artifact("/tmp/strategy.cfr2.gz", good_metadata)
        assert aid.startswith("neg_")
        assert len(aid) == 16  # "neg_" + 12 hex chars

    def test_register_creates_candidate(self, tmp_registry, good_metadata):
        aid = tmp_registry.register_artifact("/tmp/strategy.cfr2.gz", good_metadata)
        record = tmp_registry.get_artifact(aid)
        assert record is not None
        assert record["lifecycle_state"] == PolicyLifecycleState.CANDIDATE
        assert record["scenario_id"] == "cooperative_normal"
        assert record["iterations"] == 50000
        assert record["exploitability"] == 0.01

    def test_register_persists_to_filesystem(self, tmp_registry, good_metadata):
        aid = tmp_registry.register_artifact("/tmp/strategy.cfr2.gz", good_metadata)
        artifacts_path = os.path.join(tmp_registry.root, "artifacts.json")
        assert os.path.exists(artifacts_path)
        with open(artifacts_path) as f:
            data = json.load(f)
        assert aid in data

    def test_register_multiple_artifacts(self, tmp_registry, good_metadata):
        aid1 = tmp_registry.register_artifact("/tmp/s1.cfr2.gz", good_metadata)
        meta2 = {**good_metadata, "scenario_id": "aggressive_volatile"}
        aid2 = tmp_registry.register_artifact("/tmp/s2.cfr2.gz", meta2)
        assert aid1 != aid2
        assert len(tmp_registry.list_artifacts()) == 2


class TestListArtifacts:
    def test_list_with_scenario_filter(self, tmp_registry, good_metadata):
        tmp_registry.register_artifact("/tmp/s1.cfr2.gz", good_metadata)
        meta2 = {**good_metadata, "scenario_id": "desperate_declining"}
        tmp_registry.register_artifact("/tmp/s2.cfr2.gz", meta2)

        results = tmp_registry.list_artifacts({"scenario_id": "cooperative_normal"})
        assert len(results) == 1
        assert results[0]["scenario_id"] == "cooperative_normal"

    def test_list_with_lifecycle_filter(self, tmp_registry, good_metadata):
        tmp_registry.register_artifact("/tmp/s1.cfr2.gz", good_metadata)
        results = tmp_registry.list_artifacts({"lifecycle_state": "CANDIDATE"})
        assert len(results) == 1
        results = tmp_registry.list_artifacts({"lifecycle_state": "PROD"})
        assert len(results) == 0


class TestPromoteToProduction:
    def test_promote_passes_gates(self, tmp_registry, good_metadata):
        aid = tmp_registry.register_artifact("/tmp/strategy.cfr2.gz", good_metadata)
        result = tmp_registry.promote_to_prod(
            scenario_id="cooperative_normal",
            artifact_id=aid,
            approved_by="admin",
            note="Initial deployment",
        )
        assert result["lifecycle_state"] == PolicyLifecycleState.PROD

    def test_promote_sets_prod_pointer(self, tmp_registry, good_metadata):
        aid = tmp_registry.register_artifact("/tmp/strategy.cfr2.gz", good_metadata)
        tmp_registry.promote_to_prod("cooperative_normal", aid)
        pointer = tmp_registry.get_prod_pointer("cooperative_normal")
        assert pointer == aid

    def test_promote_fails_gates(self, tmp_registry, bad_metadata):
        aid = tmp_registry.register_artifact("/tmp/bad.cfr2.gz", bad_metadata)
        with pytest.raises(ValueError, match="Policy gates failed"):
            tmp_registry.promote_to_prod("aggressive_volatile", aid)

    def test_promote_with_override(self, tmp_registry, bad_metadata):
        aid = tmp_registry.register_artifact("/tmp/bad.cfr2.gz", bad_metadata)
        result = tmp_registry.promote_to_prod(
            "aggressive_volatile", aid, override=True
        )
        assert result["lifecycle_state"] == PolicyLifecycleState.PROD

    def test_promote_deprecates_old_prod(self, tmp_registry, good_metadata):
        aid1 = tmp_registry.register_artifact("/tmp/s1.cfr2.gz", good_metadata)
        tmp_registry.promote_to_prod("cooperative_normal", aid1)

        aid2 = tmp_registry.register_artifact("/tmp/s2.cfr2.gz", good_metadata)
        tmp_registry.promote_to_prod("cooperative_normal", aid2)

        old = tmp_registry.get_artifact(aid1)
        assert old["lifecycle_state"] == PolicyLifecycleState.DEPRECATED

        pointer = tmp_registry.get_prod_pointer("cooperative_normal")
        assert pointer == aid2

    def test_promote_wrong_scenario_raises(self, tmp_registry, good_metadata):
        aid = tmp_registry.register_artifact("/tmp/strategy.cfr2.gz", good_metadata)
        with pytest.raises(ValueError, match="not wrong_scenario"):
            tmp_registry.promote_to_prod("wrong_scenario", aid)

    def test_promote_nonexistent_raises(self, tmp_registry):
        with pytest.raises(ValueError, match="not found"):
            tmp_registry.promote_to_prod("cooperative_normal", "neg_doesnotexist")

    def test_promote_logs_event(self, tmp_registry, good_metadata):
        aid = tmp_registry.register_artifact("/tmp/strategy.cfr2.gz", good_metadata)
        tmp_registry.promote_to_prod("cooperative_normal", aid, note="test deploy")
        log = tmp_registry.get_promotion_log(scenario_id="cooperative_normal")
        assert len(log) >= 1
        assert log[-1]["artifact_id"] == aid
        assert log[-1]["to_state"] == PolicyLifecycleState.PROD


class TestRollback:
    def test_rollback_restores_previous_prod(self, tmp_registry, good_metadata):
        aid1 = tmp_registry.register_artifact("/tmp/s1.cfr2.gz", good_metadata)
        tmp_registry.promote_to_prod("cooperative_normal", aid1)

        aid2 = tmp_registry.register_artifact("/tmp/s2.cfr2.gz", good_metadata)
        tmp_registry.promote_to_prod("cooperative_normal", aid2)

        result = tmp_registry.rollback_prod("cooperative_normal")
        assert result is not None
        assert result["artifact_id"] == aid1
        assert result["lifecycle_state"] == PolicyLifecycleState.PROD

        pointer = tmp_registry.get_prod_pointer("cooperative_normal")
        assert pointer == aid1

    def test_rollback_with_insufficient_history(self, tmp_registry, good_metadata):
        aid = tmp_registry.register_artifact("/tmp/s1.cfr2.gz", good_metadata)
        tmp_registry.promote_to_prod("cooperative_normal", aid)
        result = tmp_registry.rollback_prod("cooperative_normal")
        assert result is None

    def test_rollback_deprecates_current(self, tmp_registry, good_metadata):
        aid1 = tmp_registry.register_artifact("/tmp/s1.cfr2.gz", good_metadata)
        tmp_registry.promote_to_prod("cooperative_normal", aid1)

        aid2 = tmp_registry.register_artifact("/tmp/s2.cfr2.gz", good_metadata)
        tmp_registry.promote_to_prod("cooperative_normal", aid2)

        tmp_registry.rollback_prod("cooperative_normal")
        rolled_back = tmp_registry.get_artifact(aid2)
        assert rolled_back["lifecycle_state"] == PolicyLifecycleState.DEPRECATED


class TestPromotionGates:
    def test_good_record_passes(self):
        record = {
            "exploitability": 0.01,
            "iterations": 50000,
            "metrics_summary": {"info_set_coverage": 0.98},
        }
        result = evaluate_negotiation_policy_gates(record)
        assert result.can_promote is True

    def test_high_exploitability_fails(self):
        record = {
            "exploitability": 0.10,
            "iterations": 50000,
            "metrics_summary": {"info_set_coverage": 0.98},
        }
        result = evaluate_negotiation_policy_gates(record)
        assert result.can_promote is False
        assert any("exploitability" in r for r in result.reasons)

    def test_low_iterations_fails(self):
        record = {
            "exploitability": 0.01,
            "iterations": 500,
            "metrics_summary": {"info_set_coverage": 0.98},
        }
        result = evaluate_negotiation_policy_gates(record)
        assert result.can_promote is False
        assert any("iterations" in r for r in result.reasons)

    def test_low_coverage_fails(self):
        record = {
            "exploitability": 0.01,
            "iterations": 50000,
            "metrics_summary": {"info_set_coverage": 0.50},
        }
        result = evaluate_negotiation_policy_gates(record)
        assert result.can_promote is False
        assert any("info_set_coverage" in r for r in result.reasons)

    def test_multiple_failures(self):
        record = {
            "exploitability": 0.20,
            "iterations": 100,
            "metrics_summary": {"info_set_coverage": 0.30},
        }
        result = evaluate_negotiation_policy_gates(record)
        assert result.can_promote is False
        assert len(result.reasons) == 3

    def test_custom_gate_config(self):
        config = NegotiationPolicyGateConfig(
            max_exploitability=0.10,
            min_iterations=1000,
            min_info_set_coverage=0.80,
        )
        record = {
            "exploitability": 0.08,
            "iterations": 5000,
            "metrics_summary": {"info_set_coverage": 0.85},
        }
        result = evaluate_negotiation_policy_gates(record, config)
        assert result.can_promote is True


class TestGetProdArtifact:
    def test_returns_none_when_no_prod(self, tmp_registry):
        assert tmp_registry.get_prod_artifact("cooperative_normal") is None

    def test_returns_prod_record(self, tmp_registry, good_metadata):
        aid = tmp_registry.register_artifact("/tmp/strategy.cfr2.gz", good_metadata)
        tmp_registry.promote_to_prod("cooperative_normal", aid)
        prod = tmp_registry.get_prod_artifact("cooperative_normal")
        assert prod is not None
        assert prod["artifact_id"] == aid
        assert prod["lifecycle_state"] == PolicyLifecycleState.PROD


class TestPromotionLog:
    def test_log_empty_initially(self, tmp_registry):
        log = tmp_registry.get_promotion_log()
        assert log == []

    def test_log_records_promotions_and_deprecations(self, tmp_registry, good_metadata):
        aid1 = tmp_registry.register_artifact("/tmp/s1.cfr2.gz", good_metadata)
        tmp_registry.promote_to_prod("cooperative_normal", aid1)

        aid2 = tmp_registry.register_artifact("/tmp/s2.cfr2.gz", good_metadata)
        tmp_registry.promote_to_prod("cooperative_normal", aid2)

        log = tmp_registry.get_promotion_log()
        # Expect: promote aid1, deprecate aid1, promote aid2 = 3 entries
        assert len(log) == 3

    def test_log_filters_by_scenario(self, tmp_registry, good_metadata):
        aid1 = tmp_registry.register_artifact("/tmp/s1.cfr2.gz", good_metadata)
        tmp_registry.promote_to_prod("cooperative_normal", aid1)

        meta2 = {**good_metadata, "scenario_id": "aggressive_volatile"}
        aid2 = tmp_registry.register_artifact("/tmp/s2.cfr2.gz", meta2)
        tmp_registry.promote_to_prod("aggressive_volatile", aid2)

        log_coop = tmp_registry.get_promotion_log(scenario_id="cooperative_normal")
        assert len(log_coop) == 1
        assert log_coop[0]["scenario_id"] == "cooperative_normal"
