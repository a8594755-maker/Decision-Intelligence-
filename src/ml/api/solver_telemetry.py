from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import threading
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except Exception:  # pragma: no cover - optional dependency in unit tests
    psycopg2 = None
    RealDictCursor = None


logger = logging.getLogger(__name__)

EVENT_TYPES = {"started", "finished", "summary"}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_now() -> str:
    return _utc_now().isoformat()


def _stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, default=_json_default)


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        if value % 1 == 0:
            return int(value)
        return float(value)
    return str(value)


def _clone(value: Any) -> Any:
    return json.loads(json.dumps(value, default=_json_default))


def _sha256_text(value: str) -> str:
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def _sha256_json(value: Any) -> str:
    return _sha256_text(_stable_json(value))


def _to_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        parsed = int(value)
    except Exception:
        return None
    return parsed


def _parse_dt(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except Exception:
            return None
    else:
        return None

    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def resolve_runtime_env() -> str:
    for key in ("DI_ENV", "APP_ENV", "ENV", "NODE_ENV", "PYTHON_ENV"):
        value = str(os.getenv(key, "")).strip()
        if value:
            return value
    return "unknown"


def resolve_git_sha() -> str:
    for key in ("DI_GIT_SHA", "GIT_SHA", "VERCEL_GIT_COMMIT_SHA", "COMMIT_SHA"):
        value = str(os.getenv(key, "")).strip()
        if value:
            return value[:40]

    try:
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
        head_path = os.path.join(root, ".git", "HEAD")
        with open(head_path, "r", encoding="utf-8") as f:
            head = f.read().strip()
        if head.startswith("ref:"):
            ref = head.split(":", 1)[1].strip()
            ref_path = os.path.join(root, ".git", ref.replace("/", os.sep))
            with open(ref_path, "r", encoding="utf-8") as rf:
                sha = rf.read().strip()
                if sha:
                    return sha[:40]
        if head:
            return head[:40]
    except Exception:
        return "unknown"
    return "unknown"


def new_telemetry_run_id(source: str) -> str:
    return f"{str(source or 'unknown').lower()}-{uuid.uuid4().hex}"


def compute_queue_wait_ms(created_at: Any, started_at: Any = None) -> Optional[int]:
    created_dt = _parse_dt(created_at)
    if created_dt is None:
        return None
    started_dt = _parse_dt(started_at) or _utc_now()
    return max(0, int((started_dt - created_dt).total_seconds() * 1000))


def extract_engine(
    planning_result: Optional[Dict[str, Any]] = None,
    planning_payload: Optional[Dict[str, Any]] = None,
    fallback: Optional[str] = None,
) -> Optional[str]:
    result_meta = (planning_result or {}).get("solver_meta")
    if isinstance(result_meta, dict):
        for key in ("engine", "solver"):
            value = result_meta.get(key)
            if value:
                return str(value)

    payload_solver = ((planning_payload or {}).get("settings") or {}).get("solver")
    if isinstance(payload_solver, dict):
        value = payload_solver.get("engine")
        if value:
            return str(value)

    if fallback:
        return str(fallback)
    return None


def extract_objective(
    planning_payload: Optional[Dict[str, Any]],
    planning_result: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    payload_objective = (planning_payload or {}).get("objective")
    if isinstance(payload_objective, dict):
        optimize_for = payload_objective.get("optimize_for")
        if optimize_for:
            return str(optimize_for)

    result_kpis = (planning_result or {}).get("kpis")
    if isinstance(result_kpis, dict):
        optimize_for = result_kpis.get("optimize_for")
        if optimize_for:
            return str(optimize_for)
    return None


def extract_contract_version(planning_payload: Optional[Dict[str, Any]], fallback: Optional[str] = None) -> Optional[str]:
    value = (planning_payload or {}).get("contract_version")
    if value:
        return str(value)
    if fallback:
        return str(fallback)
    return None


def extract_status(planning_result: Optional[Dict[str, Any]], fallback: Optional[str] = None) -> Optional[str]:
    value = (planning_result or {}).get("status")
    if value:
        return str(value).upper()
    if fallback:
        return str(fallback).upper()
    return None


def extract_termination_reason(planning_result: Optional[Dict[str, Any]], fallback: Optional[str] = None) -> Optional[str]:
    solver_meta = (planning_result or {}).get("solver_meta")
    if isinstance(solver_meta, dict):
        value = solver_meta.get("termination_reason")
        if value:
            return str(value)
    if fallback:
        return str(fallback)
    return None


def extract_solve_time_ms(planning_result: Optional[Dict[str, Any]], fallback: Optional[int] = None) -> Optional[int]:
    solver_meta = (planning_result or {}).get("solver_meta")
    if isinstance(solver_meta, dict):
        parsed = _to_int(solver_meta.get("solve_time_ms"))
        if parsed is not None:
            return max(0, parsed)
    if fallback is None:
        return None
    parsed_fallback = _to_int(fallback)
    if parsed_fallback is None:
        return None
    return max(0, parsed_fallback)


def build_safe_input_profile(planning_payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    payload = planning_payload if isinstance(planning_payload, dict) else {}
    demand_forecast = payload.get("demand_forecast")
    demand_series = (demand_forecast or {}).get("series") if isinstance(demand_forecast, dict) else []
    inventory_rows = payload.get("inventory")
    open_po_rows = payload.get("open_pos")
    items = payload.get("items")

    return {
        "payload_hash": _sha256_json(payload or {}),
        "dataset_profile_hash": (
            _sha256_text(str(payload.get("dataset_profile_id")))
            if payload.get("dataset_profile_id") is not None
            else None
        ),
        "planning_horizon_days": _to_int(payload.get("planning_horizon_days")),
        "demand_point_count": len(demand_series) if isinstance(demand_series, list) else 0,
        "inventory_row_count": len(inventory_rows) if isinstance(inventory_rows, list) else 0,
        "open_po_row_count": len(open_po_rows) if isinstance(open_po_rows, list) else 0,
        "item_count": len(items) if isinstance(items, list) else 0,
        "constraints_hash": _sha256_json(payload.get("constraints") if isinstance(payload.get("constraints"), dict) else {}),
        "shared_constraints_hash": _sha256_json(
            payload.get("shared_constraints") if isinstance(payload.get("shared_constraints"), dict) else {}
        ),
        "objective_hash": _sha256_json(payload.get("objective") if isinstance(payload.get("objective"), dict) else {}),
        "multi_echelon_mode": str(((payload.get("multi_echelon") or {}).get("mode") or "off")),
    }


def build_infeasible_summary(
    *,
    reasons: Optional[List[Any]] = None,
    details: Optional[List[Any]] = None,
) -> Dict[str, Any]:
    reason_items = [str(item) for item in (reasons or []) if item]
    reason_hashes = [_sha256_text(item) for item in reason_items]
    categories: List[str] = []
    for row in (details or []):
        if not isinstance(row, dict):
            continue
        category = row.get("category")
        if category:
            categories.append(str(category))
    deduped_hashes = list(dict.fromkeys(reason_hashes))[:50]
    return {
        "count": len(reason_items),
        "reason_hashes": deduped_hashes,
        "categories": sorted(set(categories)),
    }


def build_solver_telemetry_record(
    *,
    telemetry_run_id: str,
    event_type: str,
    source: str,
    run_id: Optional[int] = None,
    job_id: Optional[str] = None,
    planning_payload: Optional[Dict[str, Any]] = None,
    planning_result: Optional[Dict[str, Any]] = None,
    status: Optional[str] = None,
    termination_reason: Optional[str] = None,
    engine: Optional[str] = None,
    objective: Optional[str] = None,
    solve_time_ms: Optional[int] = None,
    queue_wait_ms: Optional[int] = None,
    infeasible_summary: Optional[Dict[str, Any]] = None,
    contract_version: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    env: Optional[str] = None,
    git_sha: Optional[str] = None,
    occurred_at: Optional[Any] = None,
) -> Dict[str, Any]:
    normalized_event_type = str(event_type or "").strip().lower()
    if normalized_event_type not in EVENT_TYPES:
        raise ValueError(f"Unsupported event_type={event_type}")

    result = planning_result if isinstance(planning_result, dict) else {}
    payload = planning_payload if isinstance(planning_payload, dict) else {}
    final_status = extract_status(result, fallback=status)
    final_reason = extract_termination_reason(result, fallback=termination_reason)
    final_engine = extract_engine(result, payload, fallback=engine)
    final_objective = objective or extract_objective(payload, result)
    final_solve_time_ms = extract_solve_time_ms(result, fallback=solve_time_ms)
    final_contract_version = extract_contract_version(payload, fallback=contract_version)

    reasons = result.get("infeasible_reasons") if isinstance(result.get("infeasible_reasons"), list) else []
    details = result.get("infeasible_reasons_detailed")
    if not isinstance(details, list):
        details = result.get("infeasible_reason_details")
    if not isinstance(details, list):
        details = []

    built_infeasible_summary = infeasible_summary or build_infeasible_summary(
        reasons=reasons,
        details=details,
    )
    profile = build_safe_input_profile(payload)
    input_fingerprint = str(profile.get("payload_hash") or "")

    occurred = _parse_dt(occurred_at) or _utc_now()

    return {
        "telemetry_run_id": str(telemetry_run_id),
        "event_type": normalized_event_type,
        "source": str(source or "unknown"),
        "run_id": int(run_id) if run_id is not None else None,
        "job_id": str(job_id) if job_id else None,
        "status": final_status,
        "termination_reason": final_reason,
        "engine": final_engine,
        "objective": str(final_objective) if final_objective is not None else None,
        "solve_time_ms": final_solve_time_ms,
        "queue_wait_ms": max(0, int(queue_wait_ms)) if queue_wait_ms is not None else None,
        "infeasible_summary": _clone(built_infeasible_summary),
        "input_fingerprint": input_fingerprint or None,
        "input_shape": _clone(profile),
        "env": str(env or resolve_runtime_env()),
        "git_sha": str(git_sha or resolve_git_sha()),
        "contract_version": str(final_contract_version) if final_contract_version else None,
        "metadata": _clone(metadata or {}),
        "occurred_at": occurred.isoformat(),
    }


def emit_solver_telemetry_event(
    store: Any,
    **kwargs: Any,
) -> Optional[Dict[str, Any]]:
    if store is None:
        return None
    try:
        record = build_solver_telemetry_record(**kwargs)
        return store.append_event(record)
    except Exception as exc:  # pragma: no cover - defensive; callers should not fail on telemetry
        logger.warning("solver telemetry emit failed: %s", exc)
        return None


def _percentile_nearest_rank(values: List[int], p: float) -> Optional[int]:
    clean = sorted(int(v) for v in values if v is not None)
    if not clean:
        return None
    p = max(0.0, min(1.0, float(p)))
    rank = max(1, int(math.ceil(p * len(clean))))
    return clean[rank - 1]


def compute_solver_metrics(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    summary_rows = [row for row in (records or []) if str(row.get("event_type") or "").lower() == "summary"]
    total = len(summary_rows)
    statuses = [str(row.get("status") or "").upper() for row in summary_rows]
    solve_times = [int(row["solve_time_ms"]) for row in summary_rows if _to_int(row.get("solve_time_ms")) is not None]

    infeasible_count = sum(1 for status in statuses if status == "INFEASIBLE")
    timeout_count = sum(1 for status in statuses if status == "TIMEOUT")

    return {
        "count": total,
        "solve_time_ms_p95": _percentile_nearest_rank(solve_times, 0.95),
        "infeasible_count": infeasible_count,
        "timeout_count": timeout_count,
        "infeasible_rate": round((infeasible_count / total), 6) if total > 0 else 0.0,
        "timeout_rate": round((timeout_count / total), 6) if total > 0 else 0.0,
    }


class NoopSolverTelemetryStore:
    def append_event(self, record: Dict[str, Any]) -> Dict[str, Any]:
        return _clone(record)

    def list_events(self, **_: Any) -> List[Dict[str, Any]]:
        return []

    def summary_metrics(self, **_: Any) -> Dict[str, Any]:
        return {
            "count": 0,
            "solve_time_ms_p95": None,
            "infeasible_count": 0,
            "timeout_count": 0,
            "infeasible_rate": 0.0,
            "timeout_rate": 0.0,
        }


class InMemorySolverTelemetryStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._rows: List[Dict[str, Any]] = []
        self._seq = 0

    def append_event(self, record: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            self._seq += 1
            row = _clone(record)
            row["id"] = self._seq
            row["created_at"] = row.get("occurred_at") or _iso_now()
            self._rows.append(row)
            return _clone(row)

    def list_events(
        self,
        *,
        start_time: Optional[Any] = None,
        end_time: Optional[Any] = None,
        engine: Optional[str] = None,
        status: Optional[str] = None,
        event_type: Optional[str] = None,
        limit: int = 200,
    ) -> List[Dict[str, Any]]:
        start_dt = _parse_dt(start_time)
        end_dt = _parse_dt(end_time)
        want_engine = str(engine).strip().lower() if engine else None
        want_status = str(status).strip().upper() if status else None
        want_event_type = str(event_type).strip().lower() if event_type else None

        with self._lock:
            filtered: List[Dict[str, Any]] = []
            for row in self._rows:
                row_dt = _parse_dt(row.get("occurred_at") or row.get("created_at"))
                if start_dt and (row_dt is None or row_dt < start_dt):
                    continue
                if end_dt and (row_dt is None or row_dt > end_dt):
                    continue
                if want_engine and str(row.get("engine") or "").strip().lower() != want_engine:
                    continue
                if want_status and str(row.get("status") or "").strip().upper() != want_status:
                    continue
                if want_event_type and str(row.get("event_type") or "").strip().lower() != want_event_type:
                    continue
                filtered.append(_clone(row))

            filtered.sort(
                key=lambda item: (
                    str(item.get("occurred_at") or item.get("created_at") or ""),
                    int(item.get("id") or 0),
                ),
                reverse=True,
            )
            return filtered[: max(0, int(limit))]

    def summary_metrics(
        self,
        *,
        start_time: Optional[Any] = None,
        end_time: Optional[Any] = None,
        engine: Optional[str] = None,
        status: Optional[str] = None,
    ) -> Dict[str, Any]:
        summaries = self.list_events(
            start_time=start_time,
            end_time=end_time,
            engine=engine,
            status=status,
            event_type="summary",
            limit=100_000,
        )
        return compute_solver_metrics(summaries)


class PostgresSolverTelemetryStore:
    def __init__(self, database_url: Optional[str] = None):
        self.database_url = (
            database_url
            or os.getenv("DI_DATABASE_URL")
            or os.getenv("DATABASE_URL")
            or os.getenv("SUPABASE_DB_URL")
        )
        if not self.database_url:
            raise RuntimeError("Database URL is required. Set DI_DATABASE_URL or DATABASE_URL.")
        if psycopg2 is None:
            raise RuntimeError("psycopg2 is required for PostgresSolverTelemetryStore.")

    def _connect(self):
        return psycopg2.connect(self.database_url, cursor_factory=RealDictCursor)

    def append_event(self, record: Dict[str, Any]) -> Dict[str, Any]:
        row = _clone(record)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO public.solver_runs_telemetry (
                        telemetry_run_id,
                        event_type,
                        source,
                        run_id,
                        job_id,
                        status,
                        termination_reason,
                        engine,
                        objective,
                        solve_time_ms,
                        queue_wait_ms,
                        infeasible_summary,
                        input_fingerprint,
                        input_shape,
                        env,
                        git_sha,
                        contract_version,
                        metadata,
                        occurred_at
                    )
                    VALUES (
                        %s, %s, %s, %s, %s::uuid, %s, %s, %s, %s, %s, %s, %s::jsonb,
                        %s, %s::jsonb, %s, %s, %s, %s::jsonb, %s
                    )
                    RETURNING *
                    """,
                    (
                        row.get("telemetry_run_id"),
                        row.get("event_type"),
                        row.get("source"),
                        row.get("run_id"),
                        row.get("job_id"),
                        row.get("status"),
                        row.get("termination_reason"),
                        row.get("engine"),
                        row.get("objective"),
                        row.get("solve_time_ms"),
                        row.get("queue_wait_ms"),
                        _stable_json(row.get("infeasible_summary") or {}),
                        row.get("input_fingerprint"),
                        _stable_json(row.get("input_shape") or {}),
                        row.get("env"),
                        row.get("git_sha"),
                        row.get("contract_version"),
                        _stable_json(row.get("metadata") or {}),
                        row.get("occurred_at"),
                    ),
                )
                saved = cur.fetchone()
                return _clone(saved) if saved else row

    def list_events(
        self,
        *,
        start_time: Optional[Any] = None,
        end_time: Optional[Any] = None,
        engine: Optional[str] = None,
        status: Optional[str] = None,
        event_type: Optional[str] = None,
        limit: int = 200,
    ) -> List[Dict[str, Any]]:
        clauses = ["1=1"]
        params: List[Any] = []

        start_dt = _parse_dt(start_time)
        end_dt = _parse_dt(end_time)

        if start_dt is not None:
            clauses.append("occurred_at >= %s")
            params.append(start_dt)
        if end_dt is not None:
            clauses.append("occurred_at <= %s")
            params.append(end_dt)
        if engine:
            clauses.append("engine = %s")
            params.append(str(engine))
        if status:
            clauses.append("status = %s")
            params.append(str(status).upper())
        if event_type:
            clauses.append("event_type = %s")
            params.append(str(event_type).lower())

        params.append(max(0, int(limit)))

        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT *
                    FROM public.solver_runs_telemetry
                    WHERE {' AND '.join(clauses)}
                    ORDER BY occurred_at DESC, id DESC
                    LIMIT %s
                    """,
                    params,
                )
                rows = cur.fetchall() or []
                return [_clone(row) for row in rows]

    def summary_metrics(
        self,
        *,
        start_time: Optional[Any] = None,
        end_time: Optional[Any] = None,
        engine: Optional[str] = None,
        status: Optional[str] = None,
    ) -> Dict[str, Any]:
        summaries = self.list_events(
            start_time=start_time,
            end_time=end_time,
            engine=engine,
            status=status,
            event_type="summary",
            limit=100_000,
        )
        return compute_solver_metrics(summaries)
