"""
PR-E Deliverable 6: Registry & Retrain API Router
===================================================
FastAPI router for model registry, drift monitoring, and retrain operations.

Endpoints:
  GET  /ml/registry/prod          → current prod pointer(s)
  GET  /ml/registry/artifacts     → list artifacts with filters
  POST /ml/registry/promote       → promote staged artifact to prod
  POST /ml/registry/rollback      → rollback prod to previous artifact
  POST /ml/drift/analyze          → run drift analysis
  GET  /ml/drift/reports          → list drift reports
  POST /ml/retrain/evaluate       → evaluate retrain triggers
  POST /ml/retrain/run            → kick off a retrain job
"""
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from ml.registry.model_registry import (
    LifecycleState,
    ModelLifecycleRegistry,
)
from ml.registry.promotion_gates import (
    PromotionGateConfig,
    evaluate_promotion_gates,
    check_post_promotion_rollback,
)
from ml.registry.release_gate import (
    ReleaseGateConfig,
    evaluate_release_gate,
)
from ml.monitoring.drift_monitor import (
    DriftConfig,
    DriftReport,
    DriftReportStore,
    run_drift_analysis,
)
from ml.monitoring.retrain_triggers import (
    ENABLE_AUTO_RETRAIN,
    RetainTriggerConfig,
    RetainTriggerContext,
    RetainTriggerStore,
    evaluate_retrain_trigger,
)
from ml.registry.action_guardrails import (
    GuardrailDecision,
    ProductionActionGuardrails,
)
from ml.governance import (
    ActorContext,
    ApprovalError,
    ApprovalStatus,
    GovernanceAction,
    GovernanceStore,
    canonical_payload_hash,
    ensure_role_allowed,
    normalize_role,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["mlops"])

# ── Singletons (lazy init) ──

_registry: Optional[ModelLifecycleRegistry] = None
_drift_store: Optional[DriftReportStore] = None
_trigger_store: Optional[RetainTriggerStore] = None
_prod_guardrails: Optional[ProductionActionGuardrails] = None
_gov_store: Optional[GovernanceStore] = None


def _get_registry() -> ModelLifecycleRegistry:
    global _registry
    if _registry is None:
        _registry = ModelLifecycleRegistry()
    return _registry


def _get_drift_store() -> DriftReportStore:
    global _drift_store
    if _drift_store is None:
        _drift_store = DriftReportStore()
    return _drift_store


def _get_trigger_store() -> RetainTriggerStore:
    global _trigger_store
    if _trigger_store is None:
        _trigger_store = RetainTriggerStore()
    return _trigger_store


def _get_prod_guardrails() -> ProductionActionGuardrails:
    global _prod_guardrails
    if _prod_guardrails is None:
        _prod_guardrails = ProductionActionGuardrails()
    return _prod_guardrails


def _get_governance_store() -> GovernanceStore:
    global _gov_store
    if _gov_store is None:
        _gov_store = GovernanceStore()
    return _gov_store


def _guardrail_response(decision: GuardrailDecision) -> Dict[str, Any]:
    return decision.to_dict()


def _actor_from_request(request: Request) -> ActorContext:
    actor_id = (
        request.headers.get("x-actor-id")
        or request.headers.get("x-user-id")
        or request.headers.get("x-user")
        or "anonymous"
    )
    role = normalize_role(request.headers.get("x-role"))
    return ActorContext(actor_id=str(actor_id), role=role)


def _require_action_role(request: Request, action: GovernanceAction) -> ActorContext:
    actor = _actor_from_request(request)
    try:
        ensure_role_allowed(actor.role, action)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return actor


APPROVAL_ACTION_TYPES = {
    "APPROVE_PLAN",
    "PROMOTE_MODEL",
    "SWITCH_SOLVER_ENGINE",
    "ENABLE_AUTO_RERUN",
    "ENABLE_AUTO_RETRAIN",
    "ENABLE_AUTOMATION_FLAGS",
}


def _require_approved_request(
    *,
    store: GovernanceStore,
    approval_id: Optional[str],
    action_type: str,
    payload_hash: str,
) -> Dict[str, Any]:
    if not approval_id:
        raise HTTPException(
            status_code=400,
            detail=f"approval_id is required for action {action_type}.",
        )
    try:
        return store.assert_approved(
            approval_id=approval_id,
            action_type=action_type,
            payload_hash=payload_hash,
        )
    except ApprovalError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ═══════════════════════════════════════
# Request / Response Models
# ═══════════════════════════════════════

class RegisterArtifactRequest(BaseModel):
    artifact_path: str
    series_id: str
    model_name: str
    dataset_fingerprint: str = ""
    feature_spec_hash: str = ""
    training_window_start: str = ""
    training_window_end: str = ""
    metrics_summary: Dict[str, Any] = {}
    calibration_passed: Optional[bool] = None
    calibration_scope_used: str = ""
    git_sha: str = ""


class PromoteRequest(BaseModel):
    series_id: str
    artifact_id: str
    approval_id: Optional[str] = None
    approved_by: str = ""
    note: str = ""
    override: bool = False
    enforce_release_gate: bool = True
    regression_result: Dict[str, Any] = Field(default_factory=dict)
    canary_result: Dict[str, Any] = Field(default_factory=dict)


class RollbackRequest(BaseModel):
    series_id: str
    steps: int = 1


class DriftAnalyzeRequest(BaseModel):
    series_id: str
    baseline_values: List[float]
    recent_values: List[float]
    baseline_actuals: Optional[List[float]] = None
    baseline_predictions: Optional[List[float]] = None
    recent_actuals: Optional[List[float]] = None
    recent_predictions: Optional[List[float]] = None
    baseline_p10: Optional[List[float]] = None
    baseline_p90: Optional[List[float]] = None
    recent_p10: Optional[List[float]] = None
    recent_p90: Optional[List[float]] = None
    baseline_window: Optional[Dict[str, str]] = None
    recent_window: Optional[Dict[str, str]] = None


class RetrainEvaluateRequest(BaseModel):
    series_id: str
    data_drift_score: float = 0.0
    residual_drift_score: float = 0.0
    drift_flags: List[str] = []
    recent_mape: Optional[float] = None
    baseline_mape: Optional[float] = None
    recent_coverage: Optional[float] = None
    recent_bias: Optional[float] = None
    coverage_history: List[float] = []
    last_trained_at: Optional[str] = None
    last_promoted_at: Optional[str] = None
    n_data_points: int = 0
    missingness_ratio: float = 0.0
    window_end: str = ""


class RetrainRunRequest(BaseModel):
    series_id: str
    model_name: str = "lightgbm"
    reason: str = ""
    force: bool = False


class ApprovalRequestCreate(BaseModel):
    action_type: str
    entity_id: str
    payload: Dict[str, Any] = Field(default_factory=dict)
    payload_hash: Optional[str] = None
    reason: str = ""
    note: str = ""


class ApprovalDecisionRequest(BaseModel):
    note: str = ""


class SolverSwitchRequest(BaseModel):
    solver_engine: str
    approval_id: str
    note: str = ""


class AutomationFlagsRequest(BaseModel):
    approval_id: str
    auto_rerun: Optional[bool] = None
    auto_retrain: Optional[bool] = None
    note: str = ""


# ═══════════════════════════════════════
# Governance Endpoints
# ═══════════════════════════════════════

@router.post("/governance/approvals/request")
async def create_approval_request(payload: ApprovalRequestCreate, raw_request: Request):
    actor = _require_action_role(raw_request, GovernanceAction.REQUEST_APPROVAL)
    action_type = str(payload.action_type or "").strip().upper()
    if action_type not in APPROVAL_ACTION_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported action_type '{action_type}'.",
        )

    store = _get_governance_store()
    payload_hash = payload.payload_hash or canonical_payload_hash(payload.payload or {})
    record = store.create_approval(
        action_type=action_type,
        entity_id=payload.entity_id,
        payload_hash=payload_hash,
        requested_by=actor.actor_id,
        reason=payload.reason,
        note=payload.note,
    )
    store.append_audit_event(
        action_type=action_type,
        actor=actor.actor_id,
        entity_id=payload.entity_id,
        before_pointer={"status": None},
        after_pointer={"status": ApprovalStatus.PENDING.value},
        note=payload.note or payload.reason,
        metadata={
            "stage": "request",
            "approval_id": record["approval_id"],
            "payload_hash": payload_hash,
        },
    )
    return {"approval": record}


@router.post("/governance/approvals/{approval_id}/approve")
async def approve_approval_request(
    approval_id: str,
    payload: ApprovalDecisionRequest,
    raw_request: Request,
):
    actor = _require_action_role(raw_request, GovernanceAction.APPROVE_PLAN)
    store = _get_governance_store()
    try:
        record = store.decide_approval(
            approval_id=approval_id,
            decision=ApprovalStatus.APPROVED,
            actor_id=actor.actor_id,
            note=payload.note,
        )
    except ApprovalError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    store.append_audit_event(
        action_type=str(record.get("action_type") or "APPROVE_PLAN"),
        actor=actor.actor_id,
        entity_id=str(record.get("entity_id") or ""),
        before_pointer={"status": ApprovalStatus.PENDING.value},
        after_pointer={"status": ApprovalStatus.APPROVED.value},
        note=payload.note,
        metadata={"stage": "decision", "approval_id": approval_id},
    )
    return {"approval": record}


@router.post("/governance/approvals/{approval_id}/reject")
async def reject_approval_request(
    approval_id: str,
    payload: ApprovalDecisionRequest,
    raw_request: Request,
):
    actor = _require_action_role(raw_request, GovernanceAction.APPROVE_PLAN)
    store = _get_governance_store()
    try:
        record = store.decide_approval(
            approval_id=approval_id,
            decision=ApprovalStatus.REJECTED,
            actor_id=actor.actor_id,
            note=payload.note,
        )
    except ApprovalError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    store.append_audit_event(
        action_type=str(record.get("action_type") or "APPROVE_PLAN"),
        actor=actor.actor_id,
        entity_id=str(record.get("entity_id") or ""),
        before_pointer={"status": ApprovalStatus.PENDING.value},
        after_pointer={"status": ApprovalStatus.REJECTED.value},
        note=payload.note,
        metadata={"stage": "decision", "approval_id": approval_id},
    )
    return {"approval": record}


@router.get("/governance/approvals")
async def list_governance_approvals(
    raw_request: Request,
    status: Optional[str] = Query(None),
    action_type: Optional[str] = Query(None),
    entity_id: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
):
    _require_action_role(raw_request, GovernanceAction.VIEW_AUDIT)
    store = _get_governance_store()
    approvals = store.list_approvals(
        status=status,
        action_type=action_type,
        entity_id=entity_id,
        limit=limit,
    )
    return {"approvals": approvals, "count": len(approvals)}


@router.get("/audit")
async def query_audit_events(
    raw_request: Request,
    entity_id: Optional[str] = Query(None),
    action_type: Optional[str] = Query(None),
    actor: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
):
    _require_action_role(raw_request, GovernanceAction.VIEW_AUDIT)
    store = _get_governance_store()
    events = store.query_audit(
        entity_id=entity_id,
        action_type=action_type,
        actor=actor,
        limit=limit,
    )
    return {"events": events, "count": len(events)}


@router.get("/ml/governance/runtime-state")
async def get_runtime_governance_state(raw_request: Request):
    _require_action_role(raw_request, GovernanceAction.VIEW_AUDIT)
    store = _get_governance_store()
    return store.get_runtime_state()


@router.post("/ml/governance/solver-engine/switch")
async def switch_solver_engine(payload: SolverSwitchRequest, raw_request: Request):
    actor = _require_action_role(raw_request, GovernanceAction.SWITCH_SOLVER_ENGINE)
    store = _get_governance_store()
    approval_payload = {"solver_engine": str(payload.solver_engine).strip().lower()}
    payload_hash = canonical_payload_hash(approval_payload)
    _require_approved_request(
        store=store,
        approval_id=payload.approval_id,
        action_type="SWITCH_SOLVER_ENGINE",
        payload_hash=payload_hash,
    )

    try:
        transition = store.set_solver_engine(payload.solver_engine)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    event = store.append_audit_event(
        action_type="SWITCH_SOLVER_ENGINE",
        actor=actor.actor_id,
        entity_id="solver_engine",
        before_pointer=(transition.get("before") or {}).get("solver_engine"),
        after_pointer=(transition.get("after") or {}).get("solver_engine"),
        note=payload.note,
        metadata={"approval_id": payload.approval_id},
    )
    return {
        "solver_engine": (transition.get("after") or {}).get("solver_engine"),
        "runtime_state": transition.get("after"),
        "audit_event_id": event.get("event_id"),
    }


@router.post("/ml/governance/automation-flags")
async def enable_automation_flags(payload: AutomationFlagsRequest, raw_request: Request):
    actor = _require_action_role(raw_request, GovernanceAction.ENABLE_AUTOMATION_FLAGS)
    if payload.auto_rerun is None and payload.auto_retrain is None:
        raise HTTPException(
            status_code=400,
            detail="At least one of auto_rerun or auto_retrain must be provided.",
        )
    if payload.auto_rerun is False or payload.auto_retrain is False:
        raise HTTPException(
            status_code=400,
            detail="This endpoint only supports enabling flags (set value to true).",
        )

    store = _get_governance_store()
    approval_payload: Dict[str, Any] = {}
    if payload.auto_rerun is not None:
        approval_payload["auto_rerun"] = True
    if payload.auto_retrain is not None:
        approval_payload["auto_retrain"] = True

    if len(approval_payload) == 2:
        approval_action = "ENABLE_AUTOMATION_FLAGS"
    elif "auto_rerun" in approval_payload:
        approval_action = "ENABLE_AUTO_RERUN"
    else:
        approval_action = "ENABLE_AUTO_RETRAIN"

    payload_hash = canonical_payload_hash(approval_payload)
    _require_approved_request(
        store=store,
        approval_id=payload.approval_id,
        action_type=approval_action,
        payload_hash=payload_hash,
    )

    transition = store.set_automation_flags(
        auto_rerun=payload.auto_rerun,
        auto_retrain=payload.auto_retrain,
    )

    audit_event_ids: List[str] = []
    before_flags = (transition.get("before") or {}).get("automation_flags") or {}
    after_flags = (transition.get("after") or {}).get("automation_flags") or {}

    if payload.auto_rerun is not None:
        event = store.append_audit_event(
            action_type="ENABLE_AUTO_RERUN",
            actor=actor.actor_id,
            entity_id="automation_flags",
            before_pointer={"auto_rerun": bool(before_flags.get("auto_rerun"))},
            after_pointer={"auto_rerun": bool(after_flags.get("auto_rerun"))},
            note=payload.note,
            metadata={"approval_id": payload.approval_id},
        )
        audit_event_ids.append(str(event.get("event_id")))

    if payload.auto_retrain is not None:
        event = store.append_audit_event(
            action_type="ENABLE_AUTO_RETRAIN",
            actor=actor.actor_id,
            entity_id="automation_flags",
            before_pointer={"auto_retrain": bool(before_flags.get("auto_retrain"))},
            after_pointer={"auto_retrain": bool(after_flags.get("auto_retrain"))},
            note=payload.note,
            metadata={"approval_id": payload.approval_id},
        )
        audit_event_ids.append(str(event.get("event_id")))

    return {
        "automation_flags": after_flags,
        "runtime_state": transition.get("after"),
        "audit_event_ids": audit_event_ids,
    }


# ═══════════════════════════════════════
# Registry Endpoints
# ═══════════════════════════════════════

@router.post("/ml/registry/register")
async def register_artifact(request: RegisterArtifactRequest):
    """Register a new model artifact as CANDIDATE."""
    registry = _get_registry()
    metadata = request.model_dump()
    artifact_path = metadata.pop("artifact_path")
    artifact_id = registry.register_artifact(artifact_path, metadata)
    return {"artifact_id": artifact_id, "lifecycle_state": "CANDIDATE"}


@router.get("/ml/registry/prod")
async def get_prod_pointers(
    series_id: Optional[str] = Query(None, description="Filter by series ID"),
):
    """Get current PROD pointer(s)."""
    registry = _get_registry()
    if series_id:
        artifact = registry.get_prod_artifact(series_id)
        if not artifact:
            return {"series_id": series_id, "prod_artifact": None}
        return {"series_id": series_id, "prod_artifact": artifact}
    return {"prod_pointers": registry.get_all_prod_pointers()}


@router.get("/ml/registry/artifacts")
async def list_artifacts(
    series_id: Optional[str] = Query(None),
    model_name: Optional[str] = Query(None),
    lifecycle_state: Optional[str] = Query(None),
):
    """List artifacts with optional filters."""
    registry = _get_registry()
    filters = {}
    if series_id:
        filters["series_id"] = series_id
    if model_name:
        filters["model_name"] = model_name
    if lifecycle_state:
        filters["lifecycle_state"] = lifecycle_state
    artifacts = registry.list_artifacts(filters if filters else None)
    return {"artifacts": artifacts, "count": len(artifacts)}


@router.post("/ml/registry/stage")
async def stage_artifact(request: PromoteRequest):
    """Stage an artifact for a series."""
    registry = _get_registry()
    try:
        record = registry.set_stage(
            request.series_id,
            request.artifact_id,
            note=request.note,
        )
        return {"artifact_id": request.artifact_id, "lifecycle_state": "STAGED", "record": record}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/ml/registry/promote")
async def promote_artifact(request: PromoteRequest, raw_request: Request = None):
    """
    Promote a staged artifact to PROD.

    Runs promotion gates unless override=True.
    """
    if raw_request is not None:
        actor = _require_action_role(raw_request, GovernanceAction.PROMOTE_MODEL)
    else:
        actor = ActorContext(
            actor_id=request.approved_by or "system",
            role=normalize_role("admin"),
        )
    registry = _get_registry()
    gov_store = _get_governance_store()
    approval_payload = {
        "series_id": request.series_id,
        "artifact_id": request.artifact_id,
        "override": bool(request.override),
        "enforce_release_gate": bool(request.enforce_release_gate),
    }
    payload_hash = canonical_payload_hash(approval_payload)
    if raw_request is not None:
        _require_approved_request(
            store=gov_store,
            approval_id=request.approval_id,
            action_type="PROMOTE_MODEL",
            payload_hash=payload_hash,
        )

    previous_prod = registry.get_prod_pointer(request.series_id)
    guardrails = _get_prod_guardrails()
    dedupe_key = f"promote|{request.series_id}|{request.artifact_id}"
    cooldown_key = f"promote|{request.series_id}"
    decision = guardrails.evaluate(
        action="promote",
        dedupe_key=dedupe_key,
        cooldown_key=cooldown_key,
    )

    if not decision.allowed:
        audit_event_id = guardrails.write_audit_event(
            action="promote",
            dedupe_key=dedupe_key,
            cooldown_key=cooldown_key,
            decision=decision,
            effect_applied=False,
            result_status="blocked",
            payload={"request": request.model_dump()},
        )
        gov_store.append_audit_event(
            action_type="PROMOTE_MODEL",
            actor=actor.actor_id,
            entity_id=request.series_id,
            before_pointer={"prod_artifact_id": previous_prod},
            after_pointer={"prod_artifact_id": previous_prod},
            note="Guardrails blocked promotion attempt.",
            metadata={"result": "blocked"},
        )
        return {
            "promoted": False,
            "guardrails": _guardrail_response(decision),
            "audit_event_id": audit_event_id,
            "hint": "Guardrails blocked this promotion attempt (cooldown/dedupe).",
        }

    # Get the artifact record
    artifact = registry.get_artifact(request.artifact_id)
    if not artifact:
        guardrails.write_audit_event(
            action="promote",
            dedupe_key=dedupe_key,
            cooldown_key=cooldown_key,
            decision=decision,
            effect_applied=False,
            result_status="not_found",
            payload={"request": request.model_dump()},
        )
        gov_store.append_audit_event(
            action_type="PROMOTE_MODEL",
            actor=actor.actor_id,
            entity_id=request.series_id,
            before_pointer={"prod_artifact_id": previous_prod},
            after_pointer={"prod_artifact_id": previous_prod},
            note=f"Artifact not found: {request.artifact_id}",
            metadata={"result": "not_found"},
        )
        raise HTTPException(status_code=404, detail=f"Artifact {request.artifact_id} not found")

    release_gate_result = None

    # Run promotion gates (unless override)
    if not request.override:
        if request.enforce_release_gate:
            release_gate_result = evaluate_release_gate(
                artifact_record=artifact,
                regression_result=request.regression_result,
                canary_result=request.canary_result,
                config=ReleaseGateConfig(),
            )
            if not release_gate_result.can_promote:
                audit_event_id = guardrails.write_audit_event(
                    action="promote",
                    dedupe_key=dedupe_key,
                    cooldown_key=cooldown_key,
                    decision=decision,
                    effect_applied=False,
                    result_status="rejected_by_release_gate",
                    payload={
                        "request": request.model_dump(),
                        "release_gate_result": release_gate_result.to_dict(),
                    },
                )
                gov_store.append_audit_event(
                    action_type="PROMOTE_MODEL",
                    actor=actor.actor_id,
                    entity_id=request.series_id,
                    before_pointer={"prod_artifact_id": previous_prod},
                    after_pointer={"prod_artifact_id": previous_prod},
                    note="Release gate rejected promotion.",
                    metadata={"result": "rejected_by_release_gate"},
                )
                return {
                    "promoted": False,
                    "release_gate_result": release_gate_result.to_dict(),
                    "hint": "Set override=true with a note to force promotion",
                    "guardrails": _guardrail_response(decision),
                    "audit_event_id": audit_event_id,
                }
        else:
            gate_result = evaluate_promotion_gates(artifact)
            if not gate_result.can_promote:
                audit_event_id = guardrails.write_audit_event(
                    action="promote",
                    dedupe_key=dedupe_key,
                    cooldown_key=cooldown_key,
                    decision=decision,
                    effect_applied=False,
                    result_status="rejected_by_gate",
                    payload={
                        "request": request.model_dump(),
                        "gate_result": gate_result.to_dict(),
                    },
                )
                gov_store.append_audit_event(
                    action_type="PROMOTE_MODEL",
                    actor=actor.actor_id,
                    entity_id=request.series_id,
                    before_pointer={"prod_artifact_id": previous_prod},
                    after_pointer={"prod_artifact_id": previous_prod},
                    note="Promotion gate rejected promotion.",
                    metadata={"result": "rejected_by_gate"},
                )
                return {
                    "promoted": False,
                    "gate_result": gate_result.to_dict(),
                    "hint": "Set override=true with a note to force promotion",
                    "guardrails": _guardrail_response(decision),
                    "audit_event_id": audit_event_id,
                }

    try:
        record = registry.promote_to_prod(
            request.series_id,
            request.artifact_id,
            approved_by=request.approved_by or actor.actor_id,
            note=request.note,
            override=request.override,
        )
        audit_event_id = guardrails.write_audit_event(
            action="promote",
            dedupe_key=dedupe_key,
            cooldown_key=cooldown_key,
            decision=decision,
            effect_applied=True,
            result_status="succeeded",
            payload={"request": request.model_dump(), "artifact_id": request.artifact_id},
        )
        governance_event = gov_store.append_audit_event(
            action_type="PROMOTE_MODEL",
            actor=actor.actor_id,
            entity_id=request.series_id,
            before_pointer={"prod_artifact_id": previous_prod},
            after_pointer={"prod_artifact_id": request.artifact_id},
            note=request.note,
            metadata={"approval_id": request.approval_id, "override": bool(request.override)},
        )

        return {
            "promoted": True,
            "artifact_id": request.artifact_id,
            "lifecycle_state": "PROD",
            "record": record,
            "release_gate_result": (
                release_gate_result.to_dict() if release_gate_result is not None else None
            ),
            "guardrails": _guardrail_response(decision),
            "audit_event_id": audit_event_id,
            "governance_audit_event_id": governance_event.get("event_id"),
        }
    except ValueError as e:
        guardrails.write_audit_event(
            action="promote",
            dedupe_key=dedupe_key,
            cooldown_key=cooldown_key,
            decision=decision,
            effect_applied=False,
            result_status="invalid_request",
            payload={"request": request.model_dump(), "error": str(e)},
        )
        gov_store.append_audit_event(
            action_type="PROMOTE_MODEL",
            actor=actor.actor_id,
            entity_id=request.series_id,
            before_pointer={"prod_artifact_id": previous_prod},
            after_pointer={"prod_artifact_id": previous_prod},
            note=str(e),
            metadata={"result": "invalid_request"},
        )
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/ml/registry/rollback")
async def rollback_prod(request: RollbackRequest):
    """Rollback PROD to a previous artifact."""
    registry = _get_registry()
    guardrails = _get_prod_guardrails()
    dedupe_key = f"rollback|{request.series_id}|{request.steps}"
    cooldown_key = f"rollback|{request.series_id}"
    decision = guardrails.evaluate(
        action="rollback",
        dedupe_key=dedupe_key,
        cooldown_key=cooldown_key,
    )

    if not decision.allowed:
        audit_event_id = guardrails.write_audit_event(
            action="rollback",
            dedupe_key=dedupe_key,
            cooldown_key=cooldown_key,
            decision=decision,
            effect_applied=False,
            result_status="blocked",
            payload={"request": request.model_dump()},
        )
        return {
            "rolled_back": False,
            "guardrails": _guardrail_response(decision),
            "audit_event_id": audit_event_id,
            "hint": "Guardrails blocked this rollback attempt (cooldown/dedupe).",
        }

    record = registry.rollback_prod(request.series_id, steps=request.steps)
    if not record:
        guardrails.write_audit_event(
            action="rollback",
            dedupe_key=dedupe_key,
            cooldown_key=cooldown_key,
            decision=decision,
            effect_applied=False,
            result_status="no_history",
            payload={"request": request.model_dump()},
        )
        raise HTTPException(
            status_code=404,
            detail=f"No previous PROD artifact found for series {request.series_id}",
        )
    audit_event_id = guardrails.write_audit_event(
        action="rollback",
        dedupe_key=dedupe_key,
        cooldown_key=cooldown_key,
        decision=decision,
        effect_applied=True,
        result_status="succeeded",
        payload={"request": request.model_dump(), "artifact_id": record.get("artifact_id")},
    )
    return {
        "rolled_back": True,
        "artifact_id": record["artifact_id"],
        "lifecycle_state": record["lifecycle_state"],
        "record": record,
        "guardrails": _guardrail_response(decision),
        "audit_event_id": audit_event_id,
    }


@router.get("/ml/registry/promotion-log")
async def get_promotion_log(
    series_id: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
):
    """Get promotion event history."""
    registry = _get_registry()
    log = registry.get_promotion_log(series_id=series_id, limit=limit)
    return {"events": log, "count": len(log)}


# ═══════════════════════════════════════
# Drift Monitoring Endpoints
# ═══════════════════════════════════════

@router.post("/ml/drift/analyze")
async def analyze_drift(request: DriftAnalyzeRequest):
    """Run drift analysis and persist the report."""
    report = run_drift_analysis(
        series_id=request.series_id,
        baseline_values=request.baseline_values,
        recent_values=request.recent_values,
        baseline_actuals=request.baseline_actuals,
        baseline_predictions=request.baseline_predictions,
        recent_actuals=request.recent_actuals,
        recent_predictions=request.recent_predictions,
        baseline_p10=request.baseline_p10,
        baseline_p90=request.baseline_p90,
        recent_p10=request.recent_p10,
        recent_p90=request.recent_p90,
        baseline_window=request.baseline_window,
        recent_window=request.recent_window,
    )

    store = _get_drift_store()
    store.save(report)

    return report.to_dict()


@router.get("/ml/drift/reports")
async def list_drift_reports(
    series_id: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    """List drift reports."""
    store = _get_drift_store()
    reports = store.list_reports(series_id=series_id, limit=limit)
    return {"reports": [r.to_dict() for r in reports], "count": len(reports)}


# ═══════════════════════════════════════
# Retrain Trigger Endpoints
# ═══════════════════════════════════════

@router.post("/ml/retrain/evaluate")
async def evaluate_retrain(request: RetrainEvaluateRequest):
    """
    Evaluate retrain triggers for a series.

    Returns the trigger decision, reasons, and severity.
    """
    trigger_store = _get_trigger_store()
    history = trigger_store.get_history(series_id=request.series_id, limit=20)

    context = RetainTriggerContext(
        series_id=request.series_id,
        data_drift_score=request.data_drift_score,
        residual_drift_score=request.residual_drift_score,
        drift_flags=request.drift_flags,
        recent_mape=request.recent_mape,
        baseline_mape=request.baseline_mape,
        recent_coverage=request.recent_coverage,
        recent_bias=request.recent_bias,
        coverage_history=request.coverage_history,
        last_trained_at=request.last_trained_at,
        last_promoted_at=request.last_promoted_at,
        n_data_points=request.n_data_points,
        missingness_ratio=request.missingness_ratio,
        window_end=request.window_end,
    )

    runtime_state = _get_governance_store().get_runtime_state()
    automation_flags = runtime_state.get("automation_flags") or {}
    auto_retrain_enabled = bool(automation_flags.get("auto_retrain")) or bool(ENABLE_AUTO_RETRAIN)

    result = evaluate_retrain_trigger(
        context,
        config=RetainTriggerConfig(auto_retrain_enabled=auto_retrain_enabled),
        trigger_history=history,
    )

    # Record the trigger event
    if result.should_retrain or result.reasons:
        trigger_store.record_trigger(
            series_id=request.series_id,
            result=result,
            window_end=request.window_end,
        )

    return result.to_dict()


@router.post("/ml/retrain/run")
async def run_retrain(request: RetrainRunRequest):
    """
    Kick off a retrain job for a series.

    This is the manual retrain path. Returns a job_id that can be polled.
    Automated retrain is behind the ENABLE_AUTO_RETRAIN feature flag.
    """
    guardrails = _get_prod_guardrails()
    runtime_state = _get_governance_store().get_runtime_state()
    automation_flags = runtime_state.get("automation_flags") or {}
    auto_retrain_enabled = bool(automation_flags.get("auto_retrain")) or bool(ENABLE_AUTO_RETRAIN)
    dedupe_key = (
        f"retrain_run|{request.series_id}|{request.model_name}|"
        f"{str(request.reason).strip().lower()}|{int(bool(request.force))}"
    )
    cooldown_key = f"retrain_run|{request.series_id}"
    decision = guardrails.evaluate(
        action="retrain_run",
        dedupe_key=dedupe_key,
        cooldown_key=cooldown_key,
    )

    if not decision.allowed and not request.force:
        audit_event_id = guardrails.write_audit_event(
            action="retrain_run",
            dedupe_key=dedupe_key,
            cooldown_key=cooldown_key,
            decision=decision,
            effect_applied=False,
            result_status="blocked",
            payload={"request": request.model_dump()},
        )
        return {
            "job_id": None,
            "series_id": request.series_id,
            "model_name": request.model_name,
            "status": "blocked",
            "reason": request.reason,
            "auto_retrain_enabled": auto_retrain_enabled,
            "guardrails": _guardrail_response(decision),
            "audit_event_id": audit_event_id,
            "note": "Retrain request blocked by cooldown/dedupe guardrails.",
        }

    # For now, return a structured response indicating the retrain request
    # was accepted. Integration with the actual training pipeline (PR-B)
    # happens through the existing /train-model endpoint or async job system.
    job_id = f"retrain_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}_{request.series_id}"

    logger.info(
        "Retrain requested: series=%s model=%s reason=%s force=%s",
        request.series_id, request.model_name, request.reason, request.force,
    )

    audit_event_id = guardrails.write_audit_event(
        action="retrain_run",
        dedupe_key=dedupe_key,
        cooldown_key=cooldown_key,
        decision=decision,
        effect_applied=True,
        result_status="accepted",
        payload={
            "request": request.model_dump(),
            "job_id": job_id,
            "guardrails_overridden_by_force": bool(request.force and not decision.allowed),
        },
    )

    return {
        "job_id": job_id,
        "series_id": request.series_id,
        "model_name": request.model_name,
        "status": "accepted",
        "reason": request.reason,
        "auto_retrain_enabled": auto_retrain_enabled,
        "guardrails": _guardrail_response(decision),
        "audit_event_id": audit_event_id,
        "guardrails_overridden_by_force": bool(request.force and not decision.allowed),
        "note": (
            "Retrain job accepted. Use POST /train-model or the async job system "
            "to execute the training. Register the resulting artifact via "
            "POST /ml/registry/register, then promote via POST /ml/registry/promote."
        ),
    }


# =============================================================================
# Negotiation Policy Registry Endpoints
# =============================================================================

try:
    from ml.registry.negotiation_policy_registry import (
        NegotiationPolicyRegistry,
        evaluate_negotiation_policy_gates,
    )
    _neg_registry = NegotiationPolicyRegistry()
except ImportError:
    _neg_registry = None


class RegisterPolicyRequest(BaseModel):
    scenario_id: str
    strategy_path: str
    iterations: int = 0
    exploitability: float = 0.0
    info_set_count: int = 0
    game_config: Dict[str, Any] = Field(default_factory=dict)
    metrics_summary: Dict[str, Any] = Field(default_factory=dict)


class PromotePolicyRequest(BaseModel):
    scenario_id: str
    artifact_id: str
    approved_by: str = ""
    note: str = ""
    override: bool = False


class RollbackPolicyRequest(BaseModel):
    scenario_id: str
    steps: int = 1


@router.post("/ml/negotiation-policy/register")
async def register_negotiation_policy(request: RegisterPolicyRequest):
    """Register a new CFR negotiation strategy as CANDIDATE."""
    if not _neg_registry:
        raise HTTPException(500, "Negotiation policy registry not available")

    artifact_id = _neg_registry.register_artifact(
        strategy_path=request.strategy_path,
        metadata=request.model_dump(),
    )
    record = _neg_registry.get_artifact(artifact_id)
    return {"artifact_id": artifact_id, "record": record}


@router.post("/ml/negotiation-policy/promote")
async def promote_negotiation_policy(request: PromotePolicyRequest):
    """Promote a negotiation policy to PROD with gate enforcement."""
    if not _neg_registry:
        raise HTTPException(500, "Negotiation policy registry not available")

    try:
        record = _neg_registry.promote_to_prod(
            scenario_id=request.scenario_id,
            artifact_id=request.artifact_id,
            approved_by=request.approved_by,
            note=request.note,
            override=request.override,
        )
        return {"status": "promoted", "record": record}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/ml/negotiation-policy/rollback")
async def rollback_negotiation_policy(request: RollbackPolicyRequest):
    """Rollback to a previous PROD negotiation policy."""
    if not _neg_registry:
        raise HTTPException(500, "Negotiation policy registry not available")

    record = _neg_registry.rollback_prod(
        scenario_id=request.scenario_id,
        steps=request.steps,
    )
    if not record:
        raise HTTPException(404, f"No previous PROD found for scenario {request.scenario_id}")
    return {"status": "rolled_back", "record": record}


@router.get("/ml/negotiation-policy/active")
async def get_active_negotiation_policy(
    scenario_id: Optional[str] = Query(None),
):
    """Get current PROD negotiation policy for a scenario (or all)."""
    if not _neg_registry:
        raise HTTPException(500, "Negotiation policy registry not available")

    if scenario_id:
        record = _neg_registry.get_prod_artifact(scenario_id)
        return {"scenario_id": scenario_id, "record": record}

    pointers = _neg_registry.get_all_prod_pointers()
    return {"prod_pointers": pointers}


@router.get("/ml/negotiation-policy/artifacts")
async def list_negotiation_policies(
    scenario_id: Optional[str] = Query(None),
    lifecycle_state: Optional[str] = Query(None),
):
    """List negotiation policy artifacts with optional filters."""
    if not _neg_registry:
        raise HTTPException(500, "Negotiation policy registry not available")

    filters = {}
    if scenario_id:
        filters["scenario_id"] = scenario_id
    if lifecycle_state:
        filters["lifecycle_state"] = lifecycle_state

    artifacts = _neg_registry.list_artifacts(filters or None)
    return {"artifacts": artifacts, "count": len(artifacts)}


@router.get("/ml/negotiation-policy/promotion-log")
async def get_negotiation_policy_promotion_log(
    scenario_id: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
):
    """Get negotiation policy promotion history."""
    if not _neg_registry:
        raise HTTPException(500, "Negotiation policy registry not available")

    log = _neg_registry.get_promotion_log(scenario_id=scenario_id, limit=limit)
    return {"events": log, "count": len(log)}
