import os
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import ml.api.registry_router as registry_router  # noqa: E402
from ml.governance import (  # noqa: E402
    ApprovalError,
    ApprovalStatus,
    GovernanceStore,
    canonical_payload_hash,
)


@pytest.fixture
def client(tmp_path: Path):
    registry_router._gov_store = GovernanceStore(root=str(tmp_path / "governance"))  # type: ignore[attr-defined]
    registry_router._registry = None  # type: ignore[attr-defined]
    registry_router._prod_guardrails = None  # type: ignore[attr-defined]
    registry_router._trigger_store = None  # type: ignore[attr-defined]
    registry_router._drift_store = None  # type: ignore[attr-defined]

    app = FastAPI()
    app.include_router(registry_router.router)
    return TestClient(app)


def test_rbac_blocks_unauthorized_model_promotion(client: TestClient):
    response = client.post(
        "/ml/registry/promote",
        json={
            "series_id": "SKU-001",
            "artifact_id": "art_123",
        },
        headers={
            "x-actor-id": "planner-user",
            "x-role": "planner",
        },
    )
    assert response.status_code == 403
    assert "not authorized" in response.json().get("detail", "").lower()


def test_approval_transition_allows_pending_to_approved_only(client: TestClient):
    create_resp = client.post(
        "/governance/approvals/request",
        json={
            "action_type": "PROMOTE_MODEL",
            "entity_id": "SKU-001",
            "payload": {
                "series_id": "SKU-001",
                "artifact_id": "art_abc",
                "override": False,
                "enforce_release_gate": True,
            },
            "reason": "ready for production",
        },
        headers={
            "x-actor-id": "planner-user",
            "x-role": "planner",
        },
    )
    assert create_resp.status_code == 200
    approval_id = create_resp.json()["approval"]["approval_id"]

    approve_resp = client.post(
        f"/governance/approvals/{approval_id}/approve",
        json={"note": "approved"},
        headers={
            "x-actor-id": "approver-user",
            "x-role": "approver",
        },
    )
    assert approve_resp.status_code == 200
    assert approve_resp.json()["approval"]["status"] == ApprovalStatus.APPROVED.value

    reject_resp = client.post(
        f"/governance/approvals/{approval_id}/reject",
        json={"note": "late reject"},
        headers={
            "x-actor-id": "approver-user",
            "x-role": "approver",
        },
    )
    assert reject_resp.status_code == 400
    assert "invalid state transition" in reject_resp.json().get("detail", "").lower()


def test_audit_event_written_for_protected_automation_action(client: TestClient):
    request_resp = client.post(
        "/governance/approvals/request",
        json={
            "action_type": "ENABLE_AUTO_RETRAIN",
            "entity_id": "automation_flags",
            "payload": {
                "auto_retrain": True,
            },
            "reason": "enable retrain automation",
        },
        headers={
            "x-actor-id": "planner-user",
            "x-role": "planner",
        },
    )
    assert request_resp.status_code == 200
    approval_id = request_resp.json()["approval"]["approval_id"]

    approve_resp = client.post(
        f"/governance/approvals/{approval_id}/approve",
        json={"note": "approved for rollout"},
        headers={
            "x-actor-id": "approver-user",
            "x-role": "approver",
        },
    )
    assert approve_resp.status_code == 200

    enable_resp = client.post(
        "/ml/governance/automation-flags",
        json={
            "approval_id": approval_id,
            "auto_retrain": True,
        },
        headers={
            "x-actor-id": "approver-user",
            "x-role": "approver",
        },
    )
    assert enable_resp.status_code == 200

    audit_resp = client.get(
        "/audit",
        params={"entity_id": "automation_flags"},
        headers={
            "x-actor-id": "viewer-user",
            "x-role": "viewer",
        },
    )
    assert audit_resp.status_code == 200
    events = audit_resp.json().get("events", [])
    assert any(e.get("action_type") == "ENABLE_AUTO_RETRAIN" for e in events)


def test_plan_commit_requires_approved_hash_match(tmp_path: Path):
    store = GovernanceStore(root=str(tmp_path / "governance"))
    payload = {
        "dataset_profile_id": 42,
        "planning_horizon_days": 14,
        "objective": {"optimize_for": "balanced"},
    }
    payload_hash = canonical_payload_hash(payload)
    approval = store.create_approval(
        action_type="APPROVE_PLAN",
        entity_id="plan-entity-1",
        payload_hash=payload_hash,
        requested_by="planner-user",
        reason="ready to commit",
    )

    with pytest.raises(ApprovalError):
        store.assert_approved(
            approval_id=approval["approval_id"],
            action_type="APPROVE_PLAN",
            payload_hash=payload_hash,
        )

    store.decide_approval(
        approval_id=approval["approval_id"],
        decision=ApprovalStatus.APPROVED,
        actor_id="approver-user",
    )

    approved_record = store.assert_approved(
        approval_id=approval["approval_id"],
        action_type="APPROVE_PLAN",
        payload_hash=payload_hash,
    )
    assert approved_record["status"] == ApprovalStatus.APPROVED.value

    with pytest.raises(ApprovalError):
        store.assert_approved(
            approval_id=approval["approval_id"],
            action_type="APPROVE_PLAN",
            payload_hash=canonical_payload_hash({"different": True}),
        )

    commit = store.record_plan_commit(
        entity_id="plan-entity-1",
        payload_hash=payload_hash,
        committed_by="planner-user",
        approval_id=approval["approval_id"],
    )
    assert commit["payload_hash"] == payload_hash
    assert commit["approval_id"] == approval["approval_id"]


def test_audit_log_is_append_only_and_queryable(tmp_path: Path):
    store = GovernanceStore(root=str(tmp_path / "governance"))
    store.append_audit_event(
        action_type="PROMOTE_MODEL",
        actor="approver-user",
        entity_id="SKU-001",
        before_pointer={"prod_artifact_id": "art_old"},
        after_pointer={"prod_artifact_id": "art_new"},
        note="promotion",
    )
    store.append_audit_event(
        action_type="SWITCH_SOLVER_ENGINE",
        actor="admin-user",
        entity_id="solver_engine",
        before_pointer="heuristic",
        after_pointer="ortools",
        note="switch",
    )

    sku_events = store.query_audit(entity_id="SKU-001")
    assert len(sku_events) == 1
    assert sku_events[0]["action_type"] == "PROMOTE_MODEL"

    log_path = Path(store._audit_log_path)  # noqa: SLF001
    raw_lines = [line for line in log_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(raw_lines) == 2
