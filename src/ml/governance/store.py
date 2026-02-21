import hashlib
import json
import os
import tempfile
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional


DEFAULT_GOVERNANCE_ROOT = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "registry_store", "governance"
)


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    return str(value)


def _atomic_write_json(path: str, data: Any) -> None:
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False, default=_json_default)
        os.replace(tmp_path, path)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise


def _read_json(path: str, default: Any) -> Any:
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def canonical_payload_hash(payload: Any) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=_json_default)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class ApprovalStatus(str, Enum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class ApprovalError(ValueError):
    pass


class GovernanceStore:
    def __init__(self, root: Optional[str] = None):
        self.root = os.path.abspath(root or DEFAULT_GOVERNANCE_ROOT)
        os.makedirs(self.root, exist_ok=True)

    @property
    def _approvals_path(self) -> str:
        return os.path.join(self.root, "approvals.json")

    @property
    def _audit_log_path(self) -> str:
        return os.path.join(self.root, "audit_log.jsonl")

    @property
    def _runtime_state_path(self) -> str:
        return os.path.join(self.root, "runtime_state.json")

    @property
    def _plan_commits_path(self) -> str:
        return os.path.join(self.root, "plan_commits.json")

    def create_approval(
        self,
        *,
        action_type: str,
        entity_id: str,
        payload_hash: str,
        requested_by: str,
        reason: str = "",
        note: str = "",
    ) -> Dict[str, Any]:
        if not payload_hash:
            raise ApprovalError("payload_hash is required.")

        approvals = _read_json(self._approvals_path, {})
        approval_id = f"apr_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:8]}"
        now = datetime.now(timezone.utc).isoformat()
        record = {
            "approval_id": approval_id,
            "action_type": str(action_type),
            "entity_id": str(entity_id or ""),
            "payload_hash": str(payload_hash),
            "status": ApprovalStatus.PENDING.value,
            "requested_by": str(requested_by or "unknown"),
            "requested_at": now,
            "approved_by": None,
            "approved_at": None,
            "rejected_by": None,
            "rejected_at": None,
            "reason": str(reason or ""),
            "note": str(note or ""),
        }
        approvals[approval_id] = record
        _atomic_write_json(self._approvals_path, approvals)
        return dict(record)

    def get_approval(self, approval_id: str) -> Optional[Dict[str, Any]]:
        approvals = _read_json(self._approvals_path, {})
        record = approvals.get(approval_id)
        return dict(record) if isinstance(record, dict) else None

    def list_approvals(
        self,
        *,
        status: Optional[str] = None,
        action_type: Optional[str] = None,
        entity_id: Optional[str] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        approvals = _read_json(self._approvals_path, {})
        rows = [dict(item) for item in approvals.values() if isinstance(item, dict)]
        rows.sort(key=lambda item: str(item.get("requested_at") or ""), reverse=True)

        filtered: List[Dict[str, Any]] = []
        for item in rows:
            if status and str(item.get("status")) != str(status):
                continue
            if action_type and str(item.get("action_type")) != str(action_type):
                continue
            if entity_id and str(item.get("entity_id")) != str(entity_id):
                continue
            filtered.append(item)
            if len(filtered) >= max(1, int(limit)):
                break
        return filtered

    def decide_approval(
        self,
        *,
        approval_id: str,
        decision: ApprovalStatus,
        actor_id: str,
        note: str = "",
    ) -> Dict[str, Any]:
        approvals = _read_json(self._approvals_path, {})
        record = approvals.get(approval_id)
        if not record:
            raise ApprovalError(f"Approval request {approval_id} not found.")

        current = str(record.get("status") or "")
        if current != ApprovalStatus.PENDING.value:
            raise ApprovalError(
                f"Invalid state transition: {current} -> {decision.value}. "
                "Only PENDING requests can be decided."
            )

        now = datetime.now(timezone.utc).isoformat()
        record["status"] = decision.value
        record["note"] = str(note or record.get("note") or "")
        if decision == ApprovalStatus.APPROVED:
            record["approved_by"] = str(actor_id or "unknown")
            record["approved_at"] = now
            record["rejected_by"] = None
            record["rejected_at"] = None
        elif decision == ApprovalStatus.REJECTED:
            record["rejected_by"] = str(actor_id or "unknown")
            record["rejected_at"] = now
            record["approved_by"] = None
            record["approved_at"] = None
        else:
            raise ApprovalError(f"Unsupported decision {decision}.")

        approvals[approval_id] = record
        _atomic_write_json(self._approvals_path, approvals)
        return dict(record)

    def assert_approved(
        self,
        *,
        approval_id: str,
        action_type: str,
        payload_hash: Optional[str] = None,
    ) -> Dict[str, Any]:
        record = self.get_approval(approval_id)
        if not record:
            raise ApprovalError(f"Approval request {approval_id} not found.")

        if str(record.get("status")) != ApprovalStatus.APPROVED.value:
            raise ApprovalError(
                f"Approval request {approval_id} is {record.get('status')}; expected APPROVED."
            )

        if str(record.get("action_type")) != str(action_type):
            raise ApprovalError(
                f"Approval request {approval_id} is for action {record.get('action_type')}, "
                f"not {action_type}."
            )

        if payload_hash and str(record.get("payload_hash")) != str(payload_hash):
            raise ApprovalError(
                f"Approval request {approval_id} payload hash mismatch."
            )

        return record

    def append_audit_event(
        self,
        *,
        action_type: str,
        actor: str,
        entity_id: str,
        before_pointer: Optional[Any] = None,
        after_pointer: Optional[Any] = None,
        note: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        event = {
            "event_id": f"audit_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:8]}",
            "action_type": str(action_type),
            "actor": str(actor or "unknown"),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "entity_id": str(entity_id or ""),
            "before_pointer": before_pointer,
            "after_pointer": after_pointer,
            "note": str(note or ""),
            "metadata": metadata or {},
        }
        os.makedirs(self.root, exist_ok=True)
        with open(self._audit_log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, default=_json_default))
            handle.write("\n")
        return dict(event)

    def query_audit(
        self,
        *,
        entity_id: Optional[str] = None,
        action_type: Optional[str] = None,
        actor: Optional[str] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        if not os.path.exists(self._audit_log_path):
            return []

        rows: List[Dict[str, Any]] = []
        with open(self._audit_log_path, "r", encoding="utf-8") as handle:
            for line in handle:
                text = line.strip()
                if not text:
                    continue
                try:
                    item = json.loads(text)
                except json.JSONDecodeError:
                    continue
                rows.append(item)

        rows.reverse()  # newest first
        filtered: List[Dict[str, Any]] = []
        for item in rows:
            if entity_id and str(item.get("entity_id")) != str(entity_id):
                continue
            if action_type and str(item.get("action_type")) != str(action_type):
                continue
            if actor and str(item.get("actor")) != str(actor):
                continue
            filtered.append(item)
            if len(filtered) >= max(1, int(limit)):
                break
        return filtered

    def get_runtime_state(self) -> Dict[str, Any]:
        default_engine = str(os.getenv("DI_SOLVER_ENGINE", "heuristic")).strip().lower() or "heuristic"
        state = {
            "solver_engine": default_engine,
            "automation_flags": {
                "auto_rerun": False,
                "auto_retrain": False,
            },
        }
        stored = _read_json(self._runtime_state_path, {})
        if isinstance(stored, dict):
            state.update({k: v for k, v in stored.items() if k in {"solver_engine", "automation_flags"}})
        if not isinstance(state.get("automation_flags"), dict):
            state["automation_flags"] = {"auto_rerun": False, "auto_retrain": False}
        state["automation_flags"]["auto_rerun"] = bool(state["automation_flags"].get("auto_rerun", False))
        state["automation_flags"]["auto_retrain"] = bool(state["automation_flags"].get("auto_retrain", False))
        state["solver_engine"] = str(state.get("solver_engine") or default_engine).lower()
        return state

    def set_solver_engine(self, solver_engine: str) -> Dict[str, Any]:
        text = str(solver_engine or "").strip().lower()
        if text in {"cp_sat", "ortools"}:
            text = "ortools"
        if text not in {"heuristic", "ortools"}:
            raise ValueError("solver_engine must be 'heuristic' or 'ortools'.")

        state = self.get_runtime_state()
        before = dict(state)
        state["solver_engine"] = text
        _atomic_write_json(self._runtime_state_path, state)
        return {"before": before, "after": state}

    def set_automation_flags(
        self,
        *,
        auto_rerun: Optional[bool] = None,
        auto_retrain: Optional[bool] = None,
    ) -> Dict[str, Any]:
        state = self.get_runtime_state()
        before = dict(state)
        flags = dict(state.get("automation_flags") or {})
        if auto_rerun is not None:
            flags["auto_rerun"] = bool(auto_rerun)
        if auto_retrain is not None:
            flags["auto_retrain"] = bool(auto_retrain)
        state["automation_flags"] = flags
        _atomic_write_json(self._runtime_state_path, state)
        return {"before": before, "after": state}

    def record_plan_commit(
        self,
        *,
        entity_id: str,
        payload_hash: str,
        committed_by: str,
        approval_id: Optional[str] = None,
        note: str = "",
    ) -> Dict[str, Any]:
        if not payload_hash:
            raise ValueError("payload_hash is required.")
        commits = _read_json(self._plan_commits_path, [])
        if not isinstance(commits, list):
            commits = []
        record = {
            "commit_id": f"plan_commit_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:8]}",
            "entity_id": str(entity_id or ""),
            "payload_hash": str(payload_hash),
            "committed_by": str(committed_by or "unknown"),
            "committed_at": datetime.now(timezone.utc).isoformat(),
            "approval_id": approval_id,
            "note": str(note or ""),
        }
        commits.append(record)
        _atomic_write_json(self._plan_commits_path, commits)
        return dict(record)

