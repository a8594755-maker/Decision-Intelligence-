import asyncio
import os
import sys
from collections import Counter
from types import SimpleNamespace

import pytest
from starlette.requests import Request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import ml.api.registry_router as registry_router
from ml.governance import GovernanceStore
from ml.registry.action_guardrails import ProductionActionGuardrails
from ml.registry.model_registry import ModelLifecycleRegistry


def _good_metadata(series_id: str) -> dict:
    return {
        "series_id": series_id,
        "model_name": "lightgbm",
        "metrics_summary": {
            "mape": 11.0,
            "coverage_10_90": 0.82,
            "pinball": 12.0,
            "bias": 1.0,
            "n_eval_points": 12,
        },
        "calibration_passed": True,
    }


@pytest.fixture
def isolated_router(tmp_path, monkeypatch):
    registry_router._registry = ModelLifecycleRegistry(root=str(tmp_path / "registry"))
    registry_router._drift_store = None
    registry_router._trigger_store = None
    registry_router._gov_store = GovernanceStore(root=str(tmp_path / "gov"))
    registry_router._prod_guardrails = ProductionActionGuardrails(
        root=str(tmp_path / "audit"),
        enabled=True,
        cooldown_seconds={
            "promote": 3600,
            "rollback": 3600,
            "retrain_run": 3600,
        },
        dedupe_window_seconds=3600,
    )
    monkeypatch.setattr(
        registry_router,
        "_require_action_role",
        lambda _raw_request, _action: SimpleNamespace(actor_id="test-actor", role="admin"),
    )
    monkeypatch.setattr(
        registry_router,
        "_require_approved_request",
        lambda **_kwargs: {"status": "approved"},
    )
    yield registry_router
    registry_router._registry = None
    registry_router._drift_store = None
    registry_router._trigger_store = None
    registry_router._gov_store = None
    registry_router._prod_guardrails = None


def _fake_request() -> Request:
    return Request({"type": "http", "headers": []})


def test_promote_adds_guardrail_and_audit_fields(isolated_router):
    registry = isolated_router._registry
    art_id = registry.register_artifact("/tmp/model_a", _good_metadata("SKU-001"))
    registry.set_stage("SKU-001", art_id)

    response = asyncio.run(
        isolated_router.promote_artifact(
            isolated_router.PromoteRequest(
                series_id="SKU-001",
                artifact_id=art_id,
                approved_by="qa",
                note="ship",
                enforce_release_gate=False,
            ),
            _fake_request(),
        )
    )

    assert response["promoted"] is True
    assert response["artifact_id"] == art_id
    assert response["guardrails"]["enabled"] is True
    assert response["guardrails"]["allowed"] is True
    assert response["audit_event_id"].startswith("act_")

    history = isolated_router._prod_guardrails.get_history(action="promote", limit=5)
    assert len(history) == 1
    assert history[0]["effect_applied"] is True
    assert history[0]["result_status"] == "succeeded"


def test_promote_second_attempt_blocked_by_guardrails(isolated_router):
    registry = isolated_router._registry
    art_id = registry.register_artifact("/tmp/model_b", _good_metadata("SKU-002"))
    registry.set_stage("SKU-002", art_id)
    req = isolated_router.PromoteRequest(
        series_id="SKU-002",
        artifact_id=art_id,
        approved_by="qa",
        enforce_release_gate=False,
    )

    first = asyncio.run(isolated_router.promote_artifact(req, _fake_request()))
    second = asyncio.run(isolated_router.promote_artifact(req, _fake_request()))

    assert first["promoted"] is True
    assert second["promoted"] is False
    assert second["guardrails"]["enabled"] is True
    assert second["guardrails"]["allowed"] is False
    assert second["guardrails"]["blocked_by_dedupe"] or second["guardrails"]["blocked_by_cooldown"]
    assert second["audit_event_id"].startswith("act_")

    history = isolated_router._prod_guardrails.get_history(action="promote", limit=10)
    assert len(history) == 2
    assert history[0]["effect_applied"] is False
    assert history[1]["effect_applied"] is True


def test_retrain_run_blocked_then_force_override(isolated_router):
    req = isolated_router.RetrainRunRequest(
        series_id="SKU-TR-1",
        model_name="lightgbm",
        reason="drift spike",
        force=False,
    )
    first = asyncio.run(isolated_router.run_retrain(req))
    second = asyncio.run(isolated_router.run_retrain(req))

    force_req = isolated_router.RetrainRunRequest(
        series_id="SKU-TR-1",
        model_name="lightgbm",
        reason="drift spike",
        force=True,
    )
    third = asyncio.run(isolated_router.run_retrain(force_req))

    assert first["status"] == "accepted"
    assert second["status"] == "blocked"
    assert second["guardrails"]["allowed"] is False
    assert third["status"] == "accepted"
    assert third["guardrails_overridden_by_force"] is True

    history = isolated_router._prod_guardrails.get_history(action="retrain_run", limit=10)
    assert len(history) == 3
    counts = Counter(event["result_status"] for event in history)
    assert counts["accepted"] == 2
    assert counts["blocked"] == 1


def test_rollback_repeat_is_blocked_by_guardrails(tmp_path):
    original_require_action_role = registry_router._require_action_role
    original_require_approved_request = registry_router._require_approved_request
    registry_router._registry = ModelLifecycleRegistry(root=str(tmp_path / "registry_rb"))
    registry_router._drift_store = None
    registry_router._trigger_store = None
    registry_router._prod_guardrails = ProductionActionGuardrails(
        root=str(tmp_path / "audit_rb"),
        enabled=True,
        cooldown_seconds={
            "promote": 0,
            "rollback": 3600,
            "retrain_run": 0,
        },
        dedupe_window_seconds=3600,
    )
    registry_router._gov_store = GovernanceStore(root=str(tmp_path / "gov_rb"))
    registry_router._require_action_role = (
        lambda _raw_request, _action: SimpleNamespace(actor_id="test-actor", role="admin")
    )
    registry_router._require_approved_request = lambda **_kwargs: {"status": "approved"}
    try:
        registry = registry_router._registry
        id1 = registry.register_artifact("/tmp/model_r1", _good_metadata("SKU-RB-1"))
        id2 = registry.register_artifact("/tmp/model_r2", _good_metadata("SKU-RB-1"))
        asyncio.run(
            registry_router.promote_artifact(
                registry_router.PromoteRequest(
                    series_id="SKU-RB-1",
                    artifact_id=id1,
                    enforce_release_gate=False,
                ),
                _fake_request(),
            )
        )
        asyncio.run(
            registry_router.promote_artifact(
                registry_router.PromoteRequest(
                    series_id="SKU-RB-1",
                    artifact_id=id2,
                    enforce_release_gate=False,
                ),
                _fake_request(),
            )
        )

        req = registry_router.RollbackRequest(series_id="SKU-RB-1", steps=1)
        first = asyncio.run(registry_router.rollback_prod(req))
        second = asyncio.run(registry_router.rollback_prod(req))

        assert first["rolled_back"] is True
        assert second["rolled_back"] is False
        assert second["guardrails"]["allowed"] is False
        assert second["audit_event_id"].startswith("act_")

        history = registry_router._prod_guardrails.get_history(action="rollback", limit=5)
        assert len(history) == 2
        counts = Counter(event["result_status"] for event in history)
        assert counts["blocked"] == 1
        assert counts["succeeded"] == 1
    finally:
        registry_router._require_action_role = original_require_action_role
        registry_router._require_approved_request = original_require_approved_request
        registry_router._registry = None
        registry_router._drift_store = None
        registry_router._trigger_store = None
        registry_router._gov_store = None
        registry_router._prod_guardrails = None


def test_promote_guardrails_flag_off_is_backward_compatible(tmp_path):
    original_require_action_role = registry_router._require_action_role
    original_require_approved_request = registry_router._require_approved_request
    registry_router._registry = ModelLifecycleRegistry(root=str(tmp_path / "registry_off"))
    registry_router._drift_store = None
    registry_router._trigger_store = None
    registry_router._gov_store = GovernanceStore(root=str(tmp_path / "gov_off"))
    registry_router._prod_guardrails = ProductionActionGuardrails(
        root=str(tmp_path / "audit_off"),
        enabled=False,
        cooldown_seconds={"promote": 3600, "rollback": 3600, "retrain_run": 3600},
        dedupe_window_seconds=3600,
    )
    registry_router._require_action_role = (
        lambda _raw_request, _action: SimpleNamespace(actor_id="test-actor", role="admin")
    )
    registry_router._require_approved_request = lambda **_kwargs: {"status": "approved"}
    try:
        registry = registry_router._registry
        art_id = registry.register_artifact("/tmp/model_off", _good_metadata("SKU-OFF-1"))
        registry.set_stage("SKU-OFF-1", art_id)
        req = registry_router.PromoteRequest(
            series_id="SKU-OFF-1",
            artifact_id=art_id,
            enforce_release_gate=False,
        )
        first = asyncio.run(registry_router.promote_artifact(req, _fake_request()))
        second = asyncio.run(registry_router.promote_artifact(req, _fake_request()))
        assert first["promoted"] is True
        assert second["promoted"] is True
        assert first["guardrails"]["enabled"] is False
        assert second["guardrails"]["enabled"] is False
    finally:
        registry_router._require_action_role = original_require_action_role
        registry_router._require_approved_request = original_require_approved_request
        registry_router._registry = None
        registry_router._drift_store = None
        registry_router._trigger_store = None
        registry_router._gov_store = None
        registry_router._prod_guardrails = None
