"""
Production action guardrails (Phase 4 hardening).

Provides:
  - Feature-flagged cooldown and dedupe checks for production-impacting actions.
  - Immutable append-only audit events with atomic writes.

Design goals:
  - No external dependencies (filesystem JSON only).
  - Backward compatible integration (additive fields only).
  - Deterministic behavior in tests via injectable `now`.
"""

import hashlib
import json
import os
import tempfile
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional


ENABLE_PROD_ACTION_GUARDRAILS = (
    os.getenv("ENABLE_PROD_ACTION_GUARDRAILS", "false").lower() == "true"
)

DEFAULT_GUARDRAIL_ROOT = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "registry_store", "prod_action_audit"
)

DEFAULT_DEDUPE_WINDOW_SECONDS = int(
    os.getenv("PROD_GUARDRAIL_DEDUPE_WINDOW_SECONDS", "86400")
)

DEFAULT_COOLDOWN_SECONDS = {
    "promote": int(os.getenv("PROD_GUARDRAIL_PROMOTE_COOLDOWN_SECONDS", "300")),
    "rollback": int(os.getenv("PROD_GUARDRAIL_ROLLBACK_COOLDOWN_SECONDS", "300")),
    "retrain_run": int(os.getenv("PROD_GUARDRAIL_RETRAIN_COOLDOWN_SECONDS", "1800")),
    "deploy": int(os.getenv("PROD_GUARDRAIL_DEPLOY_COOLDOWN_SECONDS", "900")),
    "rerun": int(os.getenv("PROD_GUARDRAIL_RERUN_COOLDOWN_SECONDS", "300")),
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_utc(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


def _as_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _safe_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)
        if parsed < 0:
            return fallback
        return parsed
    except Exception:
        return fallback


@dataclass
class GuardrailDecision:
    enabled: bool
    allowed: bool
    blocked_by_dedupe: bool = False
    blocked_by_cooldown: bool = False
    cooldown_remaining_seconds: float = 0.0
    dedupe_key: str = ""
    cooldown_key: str = ""
    cooldown_seconds: int = 0
    dedupe_window_seconds: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class ProductionActionGuardrails:
    """
    Filesystem-backed guardrails and immutable audit event store.
    """

    def __init__(
        self,
        root: Optional[str] = None,
        enabled: Optional[bool] = None,
        cooldown_seconds: Optional[Dict[str, int]] = None,
        dedupe_window_seconds: Optional[int] = None,
    ):
        self.root = os.path.abspath(root or DEFAULT_GUARDRAIL_ROOT)
        os.makedirs(self.root, exist_ok=True)
        self.enabled = ENABLE_PROD_ACTION_GUARDRAILS if enabled is None else bool(enabled)
        merged = dict(DEFAULT_COOLDOWN_SECONDS)
        if cooldown_seconds:
            merged.update(cooldown_seconds)
        self.cooldown_seconds = {
            key: _safe_int(value, DEFAULT_COOLDOWN_SECONDS.get(key, 0))
            for key, value in merged.items()
        }
        self.dedupe_window_seconds = _safe_int(
            dedupe_window_seconds if dedupe_window_seconds is not None else DEFAULT_DEDUPE_WINDOW_SECONDS,
            DEFAULT_DEDUPE_WINDOW_SECONDS,
        )

    def _event_file_path(self, event_id: str) -> str:
        return os.path.join(self.root, f"{event_id}.json")

    def _list_event_files(self) -> List[str]:
        if not os.path.isdir(self.root):
            return []
        return sorted(
            [f for f in os.listdir(self.root) if f.endswith(".json")],
            reverse=True,
        )

    def _read_event(self, file_name: str) -> Optional[Dict[str, Any]]:
        path = os.path.join(self.root, file_name)
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    def _atomic_write_event(self, path: str, payload: Dict[str, Any]) -> None:
        directory = os.path.dirname(path)
        os.makedirs(directory, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(dir=directory, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2, ensure_ascii=False, default=str)
            os.replace(tmp_path, path)
        except Exception:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            raise

    def _latest_event_hash(self) -> str:
        for file_name in self._list_event_files():
            event = self._read_event(file_name)
            if event and event.get("event_hash"):
                return str(event["event_hash"])
        return ""

    def _iter_recent_effective_events(
        self,
        action: str,
        now: datetime,
        search_window_seconds: int,
        limit: int = 200,
    ) -> List[Dict[str, Any]]:
        """
        Return recent events with effect_applied=True for the given action.
        """
        results: List[Dict[str, Any]] = []
        cutoff = _as_utc(now) - timedelta(seconds=max(search_window_seconds, 0))
        for file_name in self._list_event_files():
            event = self._read_event(file_name)
            if not event:
                continue
            if event.get("action") != action:
                continue
            if not bool(event.get("effect_applied", False)):
                continue
            timestamp_raw = str(event.get("timestamp", ""))
            try:
                ts = _as_utc(datetime.fromisoformat(timestamp_raw.replace("Z", "+00:00")))
            except Exception:
                continue
            if ts < cutoff:
                continue
            results.append(event)
            if len(results) >= limit:
                break
        return results

    def evaluate(
        self,
        *,
        action: str,
        dedupe_key: str,
        cooldown_key: str,
        now: Optional[datetime] = None,
    ) -> GuardrailDecision:
        ts_now = _as_utc(now or _utc_now())
        cooldown_seconds = _safe_int(self.cooldown_seconds.get(action, 0), 0)
        dedupe_window_seconds = _safe_int(self.dedupe_window_seconds, 0)

        if not self.enabled:
            return GuardrailDecision(
                enabled=False,
                allowed=True,
                dedupe_key=dedupe_key,
                cooldown_key=cooldown_key,
                cooldown_seconds=cooldown_seconds,
                dedupe_window_seconds=dedupe_window_seconds,
            )

        search_window = max(cooldown_seconds, dedupe_window_seconds)
        recent = self._iter_recent_effective_events(
            action=action,
            now=ts_now,
            search_window_seconds=search_window,
            limit=300,
        )

        blocked_by_dedupe = False
        blocked_by_cooldown = False
        cooldown_remaining = 0.0

        if dedupe_key:
            dedupe_cutoff = ts_now - timedelta(seconds=dedupe_window_seconds)
            for event in recent:
                if event.get("dedupe_key") != dedupe_key:
                    continue
                timestamp_raw = str(event.get("timestamp", ""))
                try:
                    ts = _as_utc(datetime.fromisoformat(timestamp_raw.replace("Z", "+00:00")))
                except Exception:
                    continue
                if ts >= dedupe_cutoff:
                    blocked_by_dedupe = True
                    break

        if cooldown_key and cooldown_seconds > 0:
            latest_ts: Optional[datetime] = None
            for event in recent:
                if event.get("cooldown_key") != cooldown_key:
                    continue
                timestamp_raw = str(event.get("timestamp", ""))
                try:
                    ts = _as_utc(datetime.fromisoformat(timestamp_raw.replace("Z", "+00:00")))
                except Exception:
                    continue
                if latest_ts is None or ts > latest_ts:
                    latest_ts = ts
            if latest_ts:
                cooldown_end = latest_ts + timedelta(seconds=cooldown_seconds)
                if ts_now < cooldown_end:
                    blocked_by_cooldown = True
                    cooldown_remaining = max(0.0, (cooldown_end - ts_now).total_seconds())

        allowed = not (blocked_by_dedupe or blocked_by_cooldown)
        return GuardrailDecision(
            enabled=True,
            allowed=allowed,
            blocked_by_dedupe=blocked_by_dedupe,
            blocked_by_cooldown=blocked_by_cooldown,
            cooldown_remaining_seconds=cooldown_remaining,
            dedupe_key=dedupe_key,
            cooldown_key=cooldown_key,
            cooldown_seconds=cooldown_seconds,
            dedupe_window_seconds=dedupe_window_seconds,
        )

    def write_audit_event(
        self,
        *,
        action: str,
        dedupe_key: str,
        cooldown_key: str,
        decision: GuardrailDecision,
        effect_applied: bool,
        result_status: str,
        payload: Optional[Dict[str, Any]] = None,
        now: Optional[datetime] = None,
    ) -> str:
        ts_now = _as_utc(now or _utc_now())
        event_id = f"act_{ts_now.strftime('%Y%m%d_%H%M%S_%f')}_{uuid.uuid4().hex[:8]}"
        event = {
            "event_id": event_id,
            "event_version": "v1",
            "timestamp": _iso_utc(ts_now),
            "action": action,
            "dedupe_key": dedupe_key,
            "cooldown_key": cooldown_key,
            "result_status": result_status,
            "effect_applied": bool(effect_applied),
            "guardrails": decision.to_dict(),
            "payload": payload or {},
            "prev_event_hash": self._latest_event_hash(),
        }
        canonical = json.dumps(event, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        event["event_hash"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        self._atomic_write_event(self._event_file_path(event_id), event)
        return event_id

    def get_history(
        self,
        *,
        action: Optional[str] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        events: List[Dict[str, Any]] = []
        for file_name in self._list_event_files():
            event = self._read_event(file_name)
            if not event:
                continue
            if action and event.get("action") != action:
                continue
            events.append(event)
            if len(events) >= limit:
                break
        return events
