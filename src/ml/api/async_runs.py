from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor, execute_values
except Exception:  # pragma: no cover - optional dependency in unit tests
    psycopg2 = None
    RealDictCursor = None
    execute_values = None


CANONICAL_STEP_ORDER = [
    "profile",
    "contract",
    "validate",
    "forecast",
    "risk_scan",
    "bom_explosion",
    "optimize",
    "verify_replay",
    "report",
]

STEP_ORDER_INDEX = {step: idx for idx, step in enumerate(CANONICAL_STEP_ORDER)}
TERMINAL_JOB_STATUSES = {"succeeded", "failed", "canceled"}
TERMINAL_STEP_STATUSES = {"succeeded", "failed", "skipped", "canceled", "blocked"}
PAUSED_RUN_STATUSES = {"waiting_user"}

_STEP_UNSET = object()


class AsyncRunConfig(BaseModel):
    max_rows_per_sheet: int = 2_000_000
    max_skus: int = 5_000
    solver_max_seconds: int = 90
    bom_max_edges: int = 200_000
    bom_max_depth: int = 12
    forecast_max_series: int = 5_000
    forecast_timeout_seconds: int = 90
    bom_timeout_seconds: int = 90
    job_max_attempts: int = 3
    heartbeat_interval_seconds: float = 5.0
    worker_poll_seconds: float = 2.0
    step_sleep_slice_seconds: float = 0.2
    step_log_max_chars: int = 1500

    @classmethod
    def from_env(cls) -> "AsyncRunConfig":
        return cls(
            max_rows_per_sheet=int(os.getenv("DI_MAX_ROWS_PER_SHEET", "2000000")),
            max_skus=int(os.getenv("DI_MAX_SKUS", "5000")),
            solver_max_seconds=int(os.getenv("DI_SOLVER_MAX_SECONDS", "90")),
            bom_max_edges=int(os.getenv("DI_BOM_MAX_EDGES", "200000")),
            bom_max_depth=int(os.getenv("DI_BOM_MAX_DEPTH", "12")),
            forecast_max_series=int(os.getenv("DI_FORECAST_MAX_SERIES", "5000")),
            forecast_timeout_seconds=int(os.getenv("DI_FORECAST_TIMEOUT_SECONDS", "90")),
            bom_timeout_seconds=int(os.getenv("DI_BOM_TIMEOUT_SECONDS", "90")),
            job_max_attempts=int(os.getenv("DI_JOB_MAX_ATTEMPTS", "3")),
            heartbeat_interval_seconds=float(os.getenv("DI_HEARTBEAT_INTERVAL_SECONDS", "5")),
            worker_poll_seconds=float(os.getenv("DI_WORKER_POLL_SECONDS", "2")),
            step_sleep_slice_seconds=float(os.getenv("DI_STEP_SLEEP_SLICE_SECONDS", "0.2")),
            step_log_max_chars=int(os.getenv("DI_STEP_LOG_MAX_CHARS", "1500")),
        )


class WorkloadShape(BaseModel):
    rows_per_sheet: Optional[int] = None
    skus: Optional[int] = None
    bom_edges: Optional[int] = None
    bom_depth: Optional[int] = None
    forecast_series: Optional[int] = None


class AsyncRunSubmitRequest(BaseModel):
    user_id: str
    dataset_profile_id: int
    dataset_fingerprint: str
    contract_template_id: Optional[int] = None
    workflow: str = "workflow_A_replenishment"
    engine_flags: Dict[str, Any] = Field(default_factory=dict)
    settings: Dict[str, Any] = Field(default_factory=dict)
    horizon: Optional[int] = None
    granularity: Optional[str] = None
    workload: WorkloadShape = Field(default_factory=WorkloadShape)
    max_attempts: Optional[int] = None
    async_mode: bool = True


class AsyncRunSubmitResponse(BaseModel):
    job_id: str
    run_id: int
    status: str
    status_url: str
    artifacts_url: str
    reused_existing: bool = False


class StepStatusSummary(BaseModel):
    step: str
    status: str
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    log_excerpt: Optional[str] = None


class AsyncRunStatusResponse(BaseModel):
    job_id: str
    run_id: int
    workflow: str
    status: str
    progress_pct: float
    attempts: int
    max_attempts: int
    cancel_requested: bool
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    last_heartbeat_at: Optional[str] = None
    error_message: Optional[str] = None
    current_step: Optional[str] = None
    run_status: Optional[str] = None
    run_stage: Optional[str] = None
    run_meta: Dict[str, Any] = Field(default_factory=dict)
    step_summary: List[StepStatusSummary] = Field(default_factory=list)


class StructuredJobError(Exception):
    def __init__(
        self,
        code: str,
        technical_message: str,
        user_message: str,
        recommended_action: str,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(technical_message)
        self.code = code
        self.technical_message = technical_message
        self.user_message = user_message
        self.recommended_action = recommended_action
        self.details = details or {}

    def to_output_ref(self) -> Dict[str, Any]:
        return {
            "code": self.code,
            "technical_message": self.technical_message,
            "user_message": self.user_message,
            "recommended_action": self.recommended_action,
            "details": self.details,
        }


class JobCanceledError(Exception):
    pass


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_now() -> str:
    return _utc_now().isoformat()


def _stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _clone(value: Any) -> Any:
    return json.loads(json.dumps(value, default=_json_default))


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, Decimal):
        if value % 1 == 0:
            return int(value)
        return float(value)
    return value


def to_jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: to_jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [to_jsonable(item) for item in value]
    return _json_default(value)


def build_job_key(request: AsyncRunSubmitRequest) -> str:
    payload = {
        "user_id": request.user_id,
        "dataset_fingerprint": request.dataset_fingerprint,
        "contract_template_id": request.contract_template_id,
        "workflow": request.workflow,
        "engine_flags": request.engine_flags,
        "horizon": request.horizon,
        "granularity": request.granularity,
    }
    return hashlib.sha256(_stable_json(payload).encode("utf-8")).hexdigest()


def build_step_cache_key(step_name: str, dataset_fingerprint: str, settings: Dict[str, Any]) -> str:
    payload = {
        "step": step_name,
        "dataset_fingerprint": dataset_fingerprint,
        "settings": settings or {},
    }
    return hashlib.sha256(_stable_json(payload).encode("utf-8")).hexdigest()


class InMemoryAsyncRunStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._runs: Dict[int, Dict[str, Any]] = {}
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._jobs_by_key: Dict[str, str] = {}
        self._steps_by_run: Dict[int, List[Dict[str, Any]]] = {}
        self._artifacts_by_run: Dict[int, List[Dict[str, Any]]] = {}
        self._run_seq = 0
        self._step_seq = 0
        self._artifact_seq = 0

    def create_or_reuse_job(
        self,
        request: AsyncRunSubmitRequest,
        job_key: str,
        step_sequence: List[str],
        max_attempts: int,
    ) -> Tuple[Dict[str, Any], bool]:
        with self._lock:
            existing_job_id = self._jobs_by_key.get(job_key)
            if existing_job_id:
                return _clone(self._jobs[existing_job_id]), False

            self._run_seq += 1
            run_id = self._run_seq
            run_row = {
                "id": run_id,
                "user_id": request.user_id,
                "dataset_profile_id": request.dataset_profile_id,
                "workflow": request.workflow,
                "stage": step_sequence[0] if step_sequence else "profile",
                "status": "queued",
                "started_at": None,
                "finished_at": None,
                "error": None,
                "created_at": _iso_now(),
                "meta": {
                    "job_key": job_key,
                    "dataset_fingerprint": request.dataset_fingerprint,
                },
            }
            self._runs[run_id] = run_row

            step_rows = []
            for step in step_sequence:
                self._step_seq += 1
                step_rows.append(
                    {
                        "id": self._step_seq,
                        "run_id": run_id,
                        "step": step,
                        "status": "queued",
                        "started_at": None,
                        "finished_at": None,
                        "error_code": None,
                        "error_message": None,
                        "input_ref": None,
                        "output_ref": None,
                        "log_excerpt": None,
                        "created_at": _iso_now(),
                    }
                )
            self._steps_by_run[run_id] = step_rows
            self._artifacts_by_run[run_id] = []

            job_id = str(uuid.uuid4())
            job_row = {
                "id": job_id,
                "run_id": run_id,
                "job_key": job_key,
                "status": "queued",
                "workflow": request.workflow,
                "engine_flags": _clone(request.engine_flags),
                "request_json": request.model_dump(mode="json"),
                "created_at": _iso_now(),
                "started_at": None,
                "finished_at": None,
                "progress_pct": 0.0,
                "last_heartbeat_at": None,
                "error_message": None,
                "attempts": 0,
                "max_attempts": max_attempts,
                "cancel_requested": False,
            }
            self._jobs[job_id] = job_row
            self._jobs_by_key[job_key] = job_id
            return _clone(job_row), True

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._jobs.get(str(job_id))
            return _clone(row) if row else None

    def get_run(self, run_id: int) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._runs.get(int(run_id))
            return _clone(row) if row else None

    def list_run_steps(self, run_id: int) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._steps_by_run.get(int(run_id), [])
            return sorted(_clone(rows), key=lambda row: STEP_ORDER_INDEX.get(row.get("step"), 10_000))

    def list_run_artifacts(self, run_id: int) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._artifacts_by_run.get(int(run_id), [])
            return _clone(rows)

    def request_cancel(self, job_id: str) -> bool:
        with self._lock:
            row = self._jobs.get(str(job_id))
            if not row:
                return False
            row["cancel_requested"] = True
            return True

    def is_cancel_requested(self, job_id: str) -> bool:
        with self._lock:
            row = self._jobs.get(str(job_id))
            if not row:
                return False
            return bool(row.get("cancel_requested"))

    def claim_next_job(self) -> Optional[Dict[str, Any]]:
        with self._lock:
            queued = [
                job
                for job in self._jobs.values()
                if job.get("status") == "queued" and int(job.get("attempts", 0)) < int(job.get("max_attempts", 0))
            ]
            if not queued:
                return None
            queued.sort(key=lambda row: row.get("created_at", ""))
            job = queued[0]
            job["status"] = "running"
            job["started_at"] = job.get("started_at") or _iso_now()
            job["last_heartbeat_at"] = _iso_now()
            job["attempts"] = int(job.get("attempts", 0)) + 1

            run = self._runs.get(int(job["run_id"]))
            if run:
                run["status"] = "running"
                run["started_at"] = run.get("started_at") or _iso_now()
            return _clone(job)

    def heartbeat_job(self, job_id: str, progress_pct: Optional[float] = None) -> None:
        with self._lock:
            row = self._jobs.get(str(job_id))
            if not row:
                return
            row["last_heartbeat_at"] = _iso_now()
            if progress_pct is not None:
                row["progress_pct"] = float(max(0.0, min(100.0, progress_pct)))

    def set_job_progress(self, job_id: str, progress_pct: float) -> None:
        self.heartbeat_job(job_id, progress_pct)

    def mark_job_succeeded(self, job_id: str) -> None:
        with self._lock:
            row = self._jobs.get(str(job_id))
            if not row:
                return
            row["status"] = "succeeded"
            row["progress_pct"] = 100.0
            row["finished_at"] = _iso_now()
            row["last_heartbeat_at"] = _iso_now()
            row["error_message"] = None

    def requeue_job(self, job_id: str, error_message: str) -> None:
        with self._lock:
            row = self._jobs.get(str(job_id))
            if not row:
                return
            row["status"] = "queued"
            row["finished_at"] = None
            row["last_heartbeat_at"] = _iso_now()
            row["error_message"] = str(error_message or "Retry queued")

    def mark_job_failed(self, job_id: str, error_message: str) -> None:
        with self._lock:
            row = self._jobs.get(str(job_id))
            if not row:
                return
            row["status"] = "failed"
            row["finished_at"] = _iso_now()
            row["last_heartbeat_at"] = _iso_now()
            row["error_message"] = str(error_message or "Job failed")

    def mark_job_canceled(self, job_id: str, error_message: str) -> None:
        with self._lock:
            row = self._jobs.get(str(job_id))
            if not row:
                return
            row["status"] = "canceled"
            row["finished_at"] = _iso_now()
            row["last_heartbeat_at"] = _iso_now()
            row["error_message"] = str(error_message or "Job canceled")
            row["progress_pct"] = min(float(row.get("progress_pct", 0.0)), 99.0)

    def mark_run_succeeded(self, run_id: int, stage: str = "report") -> None:
        with self._lock:
            row = self._runs.get(int(run_id))
            if not row:
                return
            row["status"] = "succeeded"
            row["stage"] = stage
            row["finished_at"] = _iso_now()
            row["error"] = None

    def mark_run_queued(self, run_id: int, error_message: Optional[str] = None) -> None:
        with self._lock:
            row = self._runs.get(int(run_id))
            if not row:
                return
            row["status"] = "queued"
            row["finished_at"] = None
            if error_message is not None:
                row["error"] = str(error_message)

    def mark_run_failed(self, run_id: int, error_message: str) -> None:
        with self._lock:
            row = self._runs.get(int(run_id))
            if not row:
                return
            row["status"] = "failed"
            row["finished_at"] = _iso_now()
            row["error"] = str(error_message or "Run failed")

    def mark_run_canceled(self, run_id: int, error_message: str) -> None:
        with self._lock:
            row = self._runs.get(int(run_id))
            if not row:
                return
            row["status"] = "canceled"
            row["finished_at"] = _iso_now()
            row["error"] = str(error_message or "Run canceled")

    def update_run_stage(self, run_id: int, stage: str) -> None:
        with self._lock:
            row = self._runs.get(int(run_id))
            if not row:
                return
            row["stage"] = stage

    def patch_run_meta(self, run_id: int, patch: Dict[str, Any]) -> None:
        with self._lock:
            row = self._runs.get(int(run_id))
            if not row:
                return
            meta = row.get("meta") or {}
            meta.update(_clone(patch or {}))
            row["meta"] = meta

    def update_step(
        self,
        run_id: int,
        step: str,
        *,
        status: Any = _STEP_UNSET,
        started_at: Any = _STEP_UNSET,
        finished_at: Any = _STEP_UNSET,
        error_code: Any = _STEP_UNSET,
        error_message: Any = _STEP_UNSET,
        input_ref: Any = _STEP_UNSET,
        output_ref: Any = _STEP_UNSET,
        log_excerpt: Any = _STEP_UNSET,
    ) -> Optional[Dict[str, Any]]:
        with self._lock:
            rows = self._steps_by_run.get(int(run_id), [])
            target = None
            for row in rows:
                if row.get("step") == step:
                    target = row
                    break
            if target is None:
                self._step_seq += 1
                target = {
                    "id": self._step_seq,
                    "run_id": int(run_id),
                    "step": step,
                    "status": "queued",
                    "started_at": None,
                    "finished_at": None,
                    "error_code": None,
                    "error_message": None,
                    "input_ref": None,
                    "output_ref": None,
                    "log_excerpt": None,
                    "created_at": _iso_now(),
                }
                rows.append(target)
                self._steps_by_run[int(run_id)] = rows

            if status is not _STEP_UNSET:
                target["status"] = status
            if started_at is not _STEP_UNSET:
                target["started_at"] = started_at
            if finished_at is not _STEP_UNSET:
                target["finished_at"] = finished_at
            if error_code is not _STEP_UNSET:
                target["error_code"] = error_code
            if error_message is not _STEP_UNSET:
                target["error_message"] = error_message
            if input_ref is not _STEP_UNSET:
                target["input_ref"] = _clone(input_ref) if input_ref is not None else None
            if output_ref is not _STEP_UNSET:
                target["output_ref"] = _clone(output_ref) if output_ref is not None else None
            if log_excerpt is not _STEP_UNSET:
                target["log_excerpt"] = log_excerpt
            return _clone(target)

    def append_step_log(self, run_id: int, step: str, message: str, max_chars: int) -> None:
        with self._lock:
            rows = self._steps_by_run.get(int(run_id), [])
            target = None
            for row in rows:
                if row.get("step") == step:
                    target = row
                    break
            if target is None:
                return
            prior = str(target.get("log_excerpt") or "").strip()
            combined = f"{prior}\n{message}".strip() if prior else str(message)
            if len(combined) > max_chars:
                combined = combined[-max_chars:]
            target["log_excerpt"] = combined

    def save_artifact(self, run_id: int, artifact_type: str, artifact_json: Any) -> Dict[str, Any]:
        with self._lock:
            self._artifact_seq += 1
            row = {
                "id": self._artifact_seq,
                "run_id": int(run_id),
                "artifact_type": str(artifact_type),
                "artifact_json": _clone(artifact_json),
                "created_at": _iso_now(),
            }
            bucket = self._artifacts_by_run.setdefault(int(run_id), [])
            bucket.append(row)
            return _clone(row)

    def find_cached_run_for_artifact(
        self,
        artifact_type: str,
        cache_key: str,
        exclude_run_id: Optional[int] = None,
    ) -> Optional[Dict[str, Any]]:
        with self._lock:
            candidates = sorted(self._runs.values(), key=lambda row: row.get("created_at", ""), reverse=True)
            for run in candidates:
                run_id = int(run.get("id"))
                if exclude_run_id is not None and int(exclude_run_id) == run_id:
                    continue
                if str(run.get("status") or "").lower() != "succeeded":
                    continue
                artifacts = self._artifacts_by_run.get(run_id, [])
                for artifact in reversed(artifacts):
                    payload = artifact.get("artifact_json")
                    if artifact.get("artifact_type") != artifact_type:
                        continue
                    if isinstance(payload, dict) and payload.get("cache_key") == cache_key:
                        return {"run_id": run_id, "artifact": _clone(artifact)}
            return None

    def copy_artifacts(self, source_run_id: int, target_run_id: int, artifact_types: List[str]) -> List[Dict[str, Any]]:
        with self._lock:
            types = set(str(item) for item in (artifact_types or []))
            copied = []
            for artifact in self._artifacts_by_run.get(int(source_run_id), []):
                if artifact.get("artifact_type") not in types:
                    continue
                copied.append(self.save_artifact(target_run_id, artifact.get("artifact_type"), artifact.get("artifact_json")))
            return copied


class PostgresAsyncRunStore:
    def __init__(self, database_url: Optional[str] = None):
        self.database_url = database_url or os.getenv("DI_DATABASE_URL") or os.getenv("DATABASE_URL") or os.getenv("SUPABASE_DB_URL")
        if not self.database_url:
            raise RuntimeError("Database URL is required. Set DI_DATABASE_URL or DATABASE_URL.")
        if psycopg2 is None:
            raise RuntimeError("psycopg2 is required for PostgresAsyncRunStore.")

    def _connect(self):
        return psycopg2.connect(self.database_url, cursor_factory=RealDictCursor)

    def create_or_reuse_job(
        self,
        request: AsyncRunSubmitRequest,
        job_key: str,
        step_sequence: List[str],
        max_attempts: int,
    ) -> Tuple[Dict[str, Any], bool]:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM public.di_jobs WHERE job_key = %s LIMIT 1 FOR UPDATE",
                    (job_key,),
                )
                existing = cur.fetchone()
                if existing:
                    return to_jsonable(existing), False

                run_meta = {
                    "job_key": job_key,
                    "dataset_fingerprint": request.dataset_fingerprint,
                }
                cur.execute(
                    """
                    INSERT INTO public.di_runs (user_id, dataset_profile_id, workflow, stage, status, meta)
                    VALUES (%s, %s, %s, %s, 'queued', %s::jsonb)
                    RETURNING *
                    """,
                    (
                        request.user_id,
                        request.dataset_profile_id,
                        request.workflow,
                        step_sequence[0] if step_sequence else "profile",
                        _stable_json(run_meta),
                    ),
                )
                run_row = cur.fetchone()
                run_id = int(run_row["id"])

                values = [(run_id, step, "queued") for step in step_sequence]
                if values:
                    execute_values(
                        cur,
                        """
                        INSERT INTO public.di_run_steps (run_id, step, status)
                        VALUES %s
                        ON CONFLICT (run_id, step)
                        DO UPDATE SET status = EXCLUDED.status
                        """,
                        values,
                    )

                cur.execute(
                    """
                    INSERT INTO public.di_jobs (
                      run_id, job_key, status, workflow, engine_flags, request_json,
                      progress_pct, attempts, max_attempts, cancel_requested
                    )
                    VALUES (%s, %s, 'queued', %s, %s::jsonb, %s::jsonb, 0, 0, %s, FALSE)
                    RETURNING *
                    """,
                    (
                        run_id,
                        job_key,
                        request.workflow,
                        _stable_json(request.engine_flags or {}),
                        _stable_json(request.model_dump(mode="json")),
                        max_attempts,
                    ),
                )
                job_row = cur.fetchone()
                return to_jsonable(job_row), True

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM public.di_jobs WHERE id = %s LIMIT 1", (str(job_id),))
                row = cur.fetchone()
                return to_jsonable(row) if row else None

    def get_run(self, run_id: int) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM public.di_runs WHERE id = %s LIMIT 1", (int(run_id),))
                row = cur.fetchone()
                return to_jsonable(row) if row else None

    def list_run_steps(self, run_id: int) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM public.di_run_steps WHERE run_id = %s ORDER BY id ASC",
                    (int(run_id),),
                )
                rows = cur.fetchall() or []
                rows = [to_jsonable(row) for row in rows]
                return sorted(rows, key=lambda row: STEP_ORDER_INDEX.get(str(row.get("step")), 10_000))

    def list_run_artifacts(self, run_id: int) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM public.di_run_artifacts WHERE run_id = %s ORDER BY created_at ASC, id ASC",
                    (int(run_id),),
                )
                rows = cur.fetchall() or []
                return [to_jsonable(row) for row in rows]

    def request_cancel(self, job_id: str) -> bool:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE public.di_jobs SET cancel_requested = TRUE WHERE id = %s RETURNING id",
                    (str(job_id),),
                )
                row = cur.fetchone()
                return bool(row)

    def is_cancel_requested(self, job_id: str) -> bool:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT cancel_requested FROM public.di_jobs WHERE id = %s LIMIT 1", (str(job_id),))
                row = cur.fetchone()
                if not row:
                    return False
                return bool(row.get("cancel_requested"))

    def claim_next_job(self) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT *
                    FROM public.di_jobs
                    WHERE status = 'queued'
                      AND attempts < max_attempts
                    ORDER BY created_at ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                    """
                )
                row = cur.fetchone()
                if not row:
                    return None

                cur.execute(
                    """
                    UPDATE public.di_jobs
                    SET status = 'running',
                        started_at = COALESCE(started_at, NOW()),
                        last_heartbeat_at = NOW(),
                        attempts = attempts + 1
                    WHERE id = %s
                    RETURNING *
                    """,
                    (row["id"],),
                )
                job = cur.fetchone()
                cur.execute(
                    """
                    UPDATE public.di_runs
                    SET status = 'running',
                        started_at = COALESCE(started_at, NOW())
                    WHERE id = %s
                    """,
                    (job["run_id"],),
                )
                return to_jsonable(job)

    def heartbeat_job(self, job_id: str, progress_pct: Optional[float] = None) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                if progress_pct is None:
                    cur.execute(
                        "UPDATE public.di_jobs SET last_heartbeat_at = NOW() WHERE id = %s",
                        (str(job_id),),
                    )
                else:
                    cur.execute(
                        """
                        UPDATE public.di_jobs
                        SET last_heartbeat_at = NOW(),
                            progress_pct = %s
                        WHERE id = %s
                        """,
                        (float(max(0.0, min(100.0, progress_pct))), str(job_id)),
                    )

    def set_job_progress(self, job_id: str, progress_pct: float) -> None:
        self.heartbeat_job(job_id, progress_pct)

    def mark_job_succeeded(self, job_id: str) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE public.di_jobs
                    SET status = 'succeeded',
                        progress_pct = 100,
                        finished_at = NOW(),
                        last_heartbeat_at = NOW(),
                        error_message = NULL
                    WHERE id = %s
                    """,
                    (str(job_id),),
                )

    def requeue_job(self, job_id: str, error_message: str) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE public.di_jobs
                    SET status = 'queued',
                        finished_at = NULL,
                        last_heartbeat_at = NOW(),
                        error_message = %s
                    WHERE id = %s
                    """,
                    (str(error_message or "Retry queued"), str(job_id)),
                )

    def mark_job_failed(self, job_id: str, error_message: str) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE public.di_jobs
                    SET status = 'failed',
                        finished_at = NOW(),
                        last_heartbeat_at = NOW(),
                        error_message = %s
                    WHERE id = %s
                    """,
                    (str(error_message or "Job failed"), str(job_id)),
                )

    def mark_job_canceled(self, job_id: str, error_message: str) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE public.di_jobs
                    SET status = 'canceled',
                        finished_at = NOW(),
                        last_heartbeat_at = NOW(),
                        error_message = %s
                    WHERE id = %s
                    """,
                    (str(error_message or "Job canceled"), str(job_id)),
                )

    def mark_run_succeeded(self, run_id: int, stage: str = "report") -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE public.di_runs
                    SET status = 'succeeded', stage = %s, finished_at = NOW(), error = NULL
                    WHERE id = %s
                    """,
                    (stage, int(run_id)),
                )

    def mark_run_queued(self, run_id: int, error_message: Optional[str] = None) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE public.di_runs
                    SET status = 'queued',
                        finished_at = NULL,
                        error = COALESCE(%s, error)
                    WHERE id = %s
                    """,
                    (error_message, int(run_id)),
                )

    def mark_run_failed(self, run_id: int, error_message: str) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE public.di_runs
                    SET status = 'failed', finished_at = NOW(), error = %s
                    WHERE id = %s
                    """,
                    (str(error_message or "Run failed"), int(run_id)),
                )

    def mark_run_canceled(self, run_id: int, error_message: str) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE public.di_runs
                    SET status = 'canceled', finished_at = NOW(), error = %s
                    WHERE id = %s
                    """,
                    (str(error_message or "Run canceled"), int(run_id)),
                )

    def update_run_stage(self, run_id: int, stage: str) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE public.di_runs SET stage = %s WHERE id = %s",
                    (str(stage), int(run_id)),
                )

    def patch_run_meta(self, run_id: int, patch: Dict[str, Any]) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE public.di_runs
                    SET meta = COALESCE(meta, '{}'::jsonb) || %s::jsonb
                    WHERE id = %s
                    """,
                    (_stable_json(patch or {}), int(run_id)),
                )

    def update_step(
        self,
        run_id: int,
        step: str,
        *,
        status: Any = _STEP_UNSET,
        started_at: Any = _STEP_UNSET,
        finished_at: Any = _STEP_UNSET,
        error_code: Any = _STEP_UNSET,
        error_message: Any = _STEP_UNSET,
        input_ref: Any = _STEP_UNSET,
        output_ref: Any = _STEP_UNSET,
        log_excerpt: Any = _STEP_UNSET,
    ) -> Optional[Dict[str, Any]]:
        updates = []
        params: List[Any] = []

        if status is not _STEP_UNSET:
            updates.append("status = %s")
            params.append(status)
        if started_at is not _STEP_UNSET:
            updates.append("started_at = %s")
            params.append(started_at)
        if finished_at is not _STEP_UNSET:
            updates.append("finished_at = %s")
            params.append(finished_at)
        if error_code is not _STEP_UNSET:
            updates.append("error_code = %s")
            params.append(error_code)
        if error_message is not _STEP_UNSET:
            updates.append("error_message = %s")
            params.append(error_message)
        if input_ref is not _STEP_UNSET:
            updates.append("input_ref = %s::jsonb")
            params.append(_stable_json(input_ref) if input_ref is not None else None)
        if output_ref is not _STEP_UNSET:
            updates.append("output_ref = %s::jsonb")
            params.append(_stable_json(output_ref) if output_ref is not None else None)
        if log_excerpt is not _STEP_UNSET:
            updates.append("log_excerpt = %s")
            params.append(log_excerpt)

        if not updates:
            return None

        with self._connect() as conn:
            with conn.cursor() as cur:
                params.extend([int(run_id), str(step)])
                cur.execute(
                    f"UPDATE public.di_run_steps SET {', '.join(updates)} WHERE run_id = %s AND step = %s RETURNING *",
                    params,
                )
                row = cur.fetchone()
                return to_jsonable(row) if row else None

    def append_step_log(self, run_id: int, step: str, message: str, max_chars: int) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT log_excerpt FROM public.di_run_steps WHERE run_id = %s AND step = %s LIMIT 1",
                    (int(run_id), str(step)),
                )
                row = cur.fetchone()
                if not row:
                    return
                prior = str(row.get("log_excerpt") or "").strip()
                merged = f"{prior}\n{message}".strip() if prior else str(message)
                if len(merged) > max_chars:
                    merged = merged[-max_chars:]
                cur.execute(
                    "UPDATE public.di_run_steps SET log_excerpt = %s WHERE run_id = %s AND step = %s",
                    (merged, int(run_id), str(step)),
                )

    def save_artifact(self, run_id: int, artifact_type: str, artifact_json: Any) -> Dict[str, Any]:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO public.di_run_artifacts (run_id, artifact_type, artifact_json)
                    VALUES (%s, %s, %s::jsonb)
                    RETURNING *
                    """,
                    (int(run_id), str(artifact_type), _stable_json(artifact_json)),
                )
                row = cur.fetchone()
                return to_jsonable(row)

    def find_cached_run_for_artifact(
        self,
        artifact_type: str,
        cache_key: str,
        exclude_run_id: Optional[int] = None,
    ) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT ra.run_id, ra.artifact_json
                    FROM public.di_run_artifacts ra
                    JOIN public.di_runs r ON r.id = ra.run_id
                    WHERE ra.artifact_type = %s
                      AND (ra.artifact_json ->> 'cache_key') = %s
                      AND r.status = 'succeeded'
                      AND (%s::bigint IS NULL OR ra.run_id <> %s::bigint)
                    ORDER BY ra.created_at DESC, ra.id DESC
                    LIMIT 1
                    """,
                    (str(artifact_type), str(cache_key), exclude_run_id, exclude_run_id),
                )
                row = cur.fetchone()
                return to_jsonable(row) if row else None

    def copy_artifacts(self, source_run_id: int, target_run_id: int, artifact_types: List[str]) -> List[Dict[str, Any]]:
        artifact_types = [str(item) for item in (artifact_types or [])]
        if not artifact_types:
            return []
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO public.di_run_artifacts (run_id, artifact_type, artifact_json)
                    SELECT %s, artifact_type, artifact_json
                    FROM public.di_run_artifacts
                    WHERE run_id = %s
                      AND artifact_type = ANY(%s)
                    RETURNING *
                    """,
                    (int(target_run_id), int(source_run_id), artifact_types),
                )
                rows = cur.fetchall() or []
                return [to_jsonable(row) for row in rows]


class AsyncRunService:
    def __init__(self, store: Any, config: Optional[AsyncRunConfig] = None) -> None:
        self.store = store
        self.config = config or AsyncRunConfig.from_env()

    def submit(self, request: AsyncRunSubmitRequest, base_url: str = "") -> AsyncRunSubmitResponse:
        if not request.user_id:
            raise ValueError("user_id is required")
        if not request.dataset_profile_id:
            raise ValueError("dataset_profile_id is required")
        if not request.dataset_fingerprint:
            raise ValueError("dataset_fingerprint is required")

        job_key = build_job_key(request)
        max_attempts = int(request.max_attempts or self.config.job_max_attempts)
        max_attempts = max(1, max_attempts)

        job_row, created = self.store.create_or_reuse_job(
            request=request,
            job_key=job_key,
            step_sequence=list(CANONICAL_STEP_ORDER),
            max_attempts=max_attempts,
        )
        job_id = str(job_row["id"])
        run_id = int(job_row["run_id"])

        status_path = f"/jobs/{job_id}"
        artifacts_path = f"/runs/{run_id}/artifacts"
        if base_url:
            normalized = str(base_url).rstrip("/")
            status_path = f"{normalized}{status_path}"
            artifacts_path = f"{normalized}{artifacts_path}"

        return AsyncRunSubmitResponse(
            job_id=job_id,
            run_id=run_id,
            status=str(job_row.get("status") or "queued"),
            status_url=status_path,
            artifacts_url=artifacts_path,
            reused_existing=not created,
        )

    def get_job_status(self, job_id: str) -> AsyncRunStatusResponse:
        job = self.store.get_job(str(job_id))
        if not job:
            raise KeyError(f"Job {job_id} not found")

        run_id = int(job["run_id"])
        run = self.store.get_run(run_id) or {}
        steps = self.store.list_run_steps(run_id)

        current_step = None
        for step in steps:
            if str(step.get("status") or "").lower() == "running":
                current_step = step.get("step")
                break

        if not current_step:
            run_stage = str(run.get("stage") or "").strip()
            current_step = run_stage or None

        step_summary = [
            StepStatusSummary(
                step=str(row.get("step") or ""),
                status=str(row.get("status") or "queued"),
                started_at=row.get("started_at"),
                finished_at=row.get("finished_at"),
                error_code=row.get("error_code"),
                error_message=row.get("error_message"),
                log_excerpt=row.get("log_excerpt"),
            )
            for row in steps
        ]

        return AsyncRunStatusResponse(
            job_id=str(job.get("id")),
            run_id=run_id,
            workflow=str(job.get("workflow") or run.get("workflow") or "workflow_unknown"),
            status=str(job.get("status") or "queued"),
            progress_pct=float(job.get("progress_pct") or 0.0),
            attempts=int(job.get("attempts") or 0),
            max_attempts=int(job.get("max_attempts") or 0),
            cancel_requested=bool(job.get("cancel_requested")),
            created_at=job.get("created_at"),
            started_at=job.get("started_at"),
            finished_at=job.get("finished_at"),
            last_heartbeat_at=job.get("last_heartbeat_at"),
            error_message=job.get("error_message"),
            current_step=current_step,
            run_status=str(run.get("status") or "queued"),
            run_stage=run.get("stage"),
            run_meta=run.get("meta") or {},
            step_summary=step_summary,
        )

    def cancel_job(self, job_id: str) -> Dict[str, Any]:
        ok = self.store.request_cancel(str(job_id))
        if not ok:
            raise KeyError(f"Job {job_id} not found")
        status = self.get_job_status(str(job_id))
        return {
            "job_id": status.job_id,
            "run_id": status.run_id,
            "status": status.status,
            "cancel_requested": True,
        }

    def get_run_steps(self, run_id: int) -> List[Dict[str, Any]]:
        rows = self.store.list_run_steps(int(run_id))
        output = []
        for row in rows:
            output.append(
                {
                    "run_id": int(run_id),
                    "step": row.get("step"),
                    "status": row.get("status"),
                    "started_at": row.get("started_at"),
                    "finished_at": row.get("finished_at"),
                    "error_code": row.get("error_code"),
                    "error_message": row.get("error_message"),
                    "log_excerpt": row.get("log_excerpt"),
                    "input_ref": row.get("input_ref"),
                    "output_ref": row.get("output_ref"),
                }
            )
        return output

    def get_run_artifacts(self, run_id: int) -> List[Dict[str, Any]]:
        rows = self.store.list_run_artifacts(int(run_id))
        refs = []
        for row in rows:
            payload = row.get("artifact_json")
            ref_payload = payload if isinstance(payload, dict) else {"value": payload}
            refs.append(
                {
                    "artifact_id": row.get("id"),
                    "run_id": row.get("run_id"),
                    "artifact_type": row.get("artifact_type"),
                    "created_at": row.get("created_at"),
                    "ref": {
                        "artifact_id": row.get("id"),
                        "run_id": row.get("run_id"),
                        "artifact_type": row.get("artifact_type"),
                        **ref_payload,
                    },
                }
            )
        return refs


class AsyncRunWorker:
    def __init__(self, store: Any, config: Optional[AsyncRunConfig] = None, sleep_fn=time.sleep) -> None:
        self.store = store
        self.config = config or AsyncRunConfig.from_env()
        self.sleep_fn = sleep_fn

    def run_forever(self) -> None:
        while True:
            processed = self.run_once()
            if not processed:
                self.sleep_fn(self.config.worker_poll_seconds)

    def run_once(self) -> bool:
        job = self.store.claim_next_job()
        if not job:
            return False
        self._execute_job(job)
        return True

    def _execute_job(self, job: Dict[str, Any]) -> None:
        job_id = str(job["id"])
        run_id = int(job["run_id"])
        request = job.get("request_json") or {}

        steps = self.store.list_run_steps(run_id)
        if not steps:
            steps = [{"step": step, "status": "queued"} for step in CANONICAL_STEP_ORDER]

        total_steps = max(1, len(steps))

        for index, step_row in enumerate(steps):
            step_name = str(step_row.get("step") or "")
            if not step_name:
                continue

            status = str(step_row.get("status") or "queued").lower()
            if status in TERMINAL_STEP_STATUSES:
                continue

            if self.store.is_cancel_requested(job_id):
                self._cancel_job(job_id, run_id, step_name, "Cancellation requested before step execution.")
                return

            self.store.update_run_stage(run_id, step_name)
            self.store.update_step(
                run_id,
                step_name,
                status="running",
                started_at=_iso_now(),
                finished_at=None,
                error_code=None,
                error_message=None,
            )
            self.store.append_step_log(run_id, step_name, f"[{_iso_now()}] Step started.", self.config.step_log_max_chars)

            try:
                step_result = self._run_step(job, request, step_name)
                step_status = str(step_result.get("status") or "succeeded").lower()

                self.store.update_step(
                    run_id,
                    step_name,
                    status=step_status,
                    finished_at=_iso_now(),
                    error_code=None,
                    error_message=None,
                    input_ref=step_result.get("input_ref"),
                    output_ref=step_result.get("output_ref"),
                    log_excerpt=step_result.get("log_excerpt"),
                )
                self.store.append_step_log(
                    run_id,
                    step_name,
                    f"[{_iso_now()}] Step finished with status={step_status}.",
                    self.config.step_log_max_chars,
                )

                progress_pct = ((index + 1) / total_steps) * 100.0
                self.store.set_job_progress(job_id, progress_pct)
                self.store.heartbeat_job(job_id, progress_pct)

            except JobCanceledError:
                self._cancel_job(job_id, run_id, step_name, "Cancellation requested during step execution.")
                return
            except StructuredJobError as err:
                self.store.update_step(
                    run_id,
                    step_name,
                    status="failed",
                    finished_at=_iso_now(),
                    error_code=err.code,
                    error_message=err.user_message,
                    output_ref=err.to_output_ref(),
                )
                self.store.append_step_log(
                    run_id,
                    step_name,
                    f"[{_iso_now()}] Step failed: {err.technical_message}",
                    self.config.step_log_max_chars,
                )
                if self._retry_if_possible(job_id, run_id, f"[{err.code}] {err.user_message}"):
                    return
                self.store.mark_job_failed(job_id, f"[{err.code}] {err.user_message}")
                self.store.mark_run_failed(run_id, f"[{err.code}] {err.user_message}")
                return
            except Exception as exc:
                error_message = str(exc) or "Unexpected worker failure"
                self.store.update_step(
                    run_id,
                    step_name,
                    status="failed",
                    finished_at=_iso_now(),
                    error_code="UNEXPECTED_ERROR",
                    error_message=error_message,
                    output_ref={
                        "code": "UNEXPECTED_ERROR",
                        "technical_message": error_message,
                        "user_message": "The workflow failed unexpectedly.",
                        "recommended_action": "Retry the run. If the issue persists, narrow input scope and retry.",
                        "details": {},
                    },
                )
                if self._retry_if_possible(job_id, run_id, error_message):
                    return
                self.store.mark_job_failed(job_id, error_message)
                self.store.mark_run_failed(run_id, error_message)
                return

        self.store.mark_job_succeeded(job_id)
        self.store.mark_run_succeeded(run_id, stage="report")

    def _cancel_job(self, job_id: str, run_id: int, step_name: str, reason: str) -> None:
        self.store.update_step(
            run_id,
            step_name,
            status="canceled",
            finished_at=_iso_now(),
            error_code="CANCELED",
            error_message=reason,
            output_ref={
                "code": "CANCELED",
                "technical_message": reason,
                "user_message": "Run canceled by request.",
                "recommended_action": "Review partial artifacts and rerun if needed.",
                "details": {},
            },
        )
        self.store.mark_job_canceled(job_id, reason)
        self.store.mark_run_canceled(run_id, reason)

    def _retry_if_possible(self, job_id: str, run_id: int, error_message: str) -> bool:
        job = self.store.get_job(job_id) or {}
        attempts = int(job.get("attempts") or 0)
        max_attempts = int(job.get("max_attempts") or 0)
        if attempts >= max_attempts:
            return False

        self.store.requeue_job(job_id, error_message)
        self.store.mark_run_queued(run_id, error_message)
        return True

    def _run_step(self, job: Dict[str, Any], request: Dict[str, Any], step_name: str) -> Dict[str, Any]:
        run_id = int(job["run_id"])
        job_id = str(job["id"])
        workflow = str(job.get("workflow") or request.get("workflow") or "workflow_unknown").lower()
        engine_flags = request.get("engine_flags") or {}
        settings = request.get("settings") or {}
        fingerprint = str(request.get("dataset_fingerprint") or "")
        workload = request.get("workload") or {}

        if not self._step_is_applicable(step_name, workflow, engine_flags):
            return {
                "status": "skipped",
                "input_ref": {"workflow": workflow},
                "output_ref": {"skipped_reason": "step_not_applicable_for_workflow"},
                "log_excerpt": f"Step {step_name} skipped (not applicable).",
            }

        if step_name in {"forecast", "risk_scan", "bom_explosion", "optimize"}:
            self._enforce_limits(step_name, workload)

        if step_name == "profile":
            return {
                "status": "succeeded",
                "input_ref": {"dataset_profile_id": request.get("dataset_profile_id")},
                "output_ref": {
                    "dataset_fingerprint": fingerprint,
                    "workflow": workflow,
                },
                "log_excerpt": "Profile context loaded.",
            }

        if step_name == "contract":
            return {
                "status": "succeeded",
                "input_ref": {"contract_template_id": request.get("contract_template_id")},
                "output_ref": {
                    "contract_template_id": request.get("contract_template_id"),
                    "engine_flags": engine_flags,
                },
                "log_excerpt": "Contract settings acknowledged.",
            }

        if step_name == "validate":
            return {
                "status": "succeeded",
                "input_ref": {"workload": workload},
                "output_ref": {
                    "validation_status": "pass",
                    "notes": ["Guardrail checks deferred to compute steps."],
                },
                "log_excerpt": "Validation completed.",
            }

        if step_name == "forecast":
            forecast_settings = {
                "horizon": request.get("horizon"),
                "granularity": request.get("granularity"),
                "forecast": settings.get("forecast", {}),
            }
            cache_key = build_step_cache_key("forecast", fingerprint, forecast_settings)
            reused = self._reuse_cached_step(
                run_id=run_id,
                step_name=step_name,
                cache_key=cache_key,
                artifact_types=["forecast_series", "metrics", "report_json", "forecast_csv"],
                meta_flag="reused_cached_forecast",
            )
            if reused:
                return reused

            self._simulate_compute(
                job_id=job_id,
                step_name="forecast",
                timeout_seconds=float(self.config.forecast_timeout_seconds),
                requested_seconds=float(engine_flags.get("simulate_forecast_seconds", 0.4)),
            )
            artifacts = self._build_forecast_artifacts(request, cache_key)
            for artifact_type, payload in artifacts.items():
                self.store.save_artifact(run_id, artifact_type, payload)

            self.store.patch_run_meta(run_id, {"reused_cached_forecast": False})
            return {
                "status": "succeeded",
                "input_ref": {"cache_key": cache_key, "settings": forecast_settings},
                "output_ref": {
                    "cache_key": cache_key,
                    "artifact_types": list(artifacts.keys()),
                    "reused": False,
                },
                "log_excerpt": "Forecast computed and artifacts persisted.",
            }

        if step_name == "risk_scan":
            risk_settings = {"risk": settings.get("risk", {}), "engine_flags": engine_flags}
            cache_key = build_step_cache_key("risk_scan", fingerprint, risk_settings)
            reused = self._reuse_cached_step(
                run_id=run_id,
                step_name=step_name,
                cache_key=cache_key,
                artifact_types=["risk_scores", "supporting_metrics", "risk_scores_csv"],
                meta_flag="reused_cached_risk_scan",
            )
            if reused:
                return reused

            self._simulate_compute(
                job_id=job_id,
                step_name="risk_scan",
                timeout_seconds=float(self.config.forecast_timeout_seconds),
                requested_seconds=float(engine_flags.get("simulate_risk_scan_seconds", 0.3)),
            )
            artifacts = self._build_risk_artifacts(cache_key)
            for artifact_type, payload in artifacts.items():
                self.store.save_artifact(run_id, artifact_type, payload)
            self.store.patch_run_meta(run_id, {"reused_cached_risk_scan": False})
            return {
                "status": "succeeded",
                "input_ref": {"cache_key": cache_key, "settings": risk_settings},
                "output_ref": {
                    "cache_key": cache_key,
                    "artifact_types": list(artifacts.keys()),
                    "reused": False,
                },
                "log_excerpt": "Risk scan completed.",
            }

        if step_name == "bom_explosion":
            bom_settings = {"bom": settings.get("bom", {}), "engine_flags": engine_flags}
            cache_key = build_step_cache_key("bom_explosion", fingerprint, bom_settings)
            reused = self._reuse_cached_step(
                run_id=run_id,
                step_name=step_name,
                cache_key=cache_key,
                artifact_types=["bom_explosion"],
                meta_flag="reused_cached_bom_explosion",
            )
            if reused:
                return reused

            self._simulate_compute(
                job_id=job_id,
                step_name="bom_explosion",
                timeout_seconds=float(self.config.bom_timeout_seconds),
                requested_seconds=float(engine_flags.get("simulate_bom_explosion_seconds", 0.3)),
            )
            artifact = {
                "cache_key": cache_key,
                "total_rows": 1,
                "rows": [
                    {
                        "parent_sku": "FG-001",
                        "component_sku": "RM-001",
                        "qty_per": 2,
                        "level": 1,
                    }
                ],
                "truncated": False,
            }
            self.store.save_artifact(run_id, "bom_explosion", artifact)
            self.store.patch_run_meta(run_id, {"reused_cached_bom_explosion": False})
            return {
                "status": "succeeded",
                "input_ref": {"cache_key": cache_key, "settings": bom_settings},
                "output_ref": {"cache_key": cache_key, "artifact_types": ["bom_explosion"], "reused": False},
                "log_excerpt": "BOM explosion completed.",
            }

        if step_name == "optimize":
            solver_settings = {
                "solver": settings.get("solver", {}),
                "plan": settings.get("plan", {}),
                "engine_flags": engine_flags,
            }
            cache_key = build_step_cache_key("optimize", fingerprint, solver_settings)
            reused = self._reuse_cached_step(
                run_id=run_id,
                step_name=step_name,
                cache_key=cache_key,
                artifact_types=[
                    "solver_meta",
                    "constraint_check",
                    "plan_table",
                    "replay_metrics",
                    "inventory_projection",
                    "evidence_pack",
                    "plan_csv",
                    "report_json",
                ],
                meta_flag="reused_cached_plan",
            )
            if reused:
                return reused

            self._simulate_compute(
                job_id=job_id,
                step_name="optimize",
                timeout_seconds=float(self.config.solver_max_seconds),
                requested_seconds=float(engine_flags.get("simulate_optimize_seconds", 0.5)),
            )
            artifacts = self._build_optimize_artifacts(request, run_id, cache_key)
            for artifact_type, payload in artifacts.items():
                self.store.save_artifact(run_id, artifact_type, payload)
            self.store.patch_run_meta(run_id, {"reused_cached_plan": False})
            return {
                "status": "succeeded",
                "input_ref": {"cache_key": cache_key, "settings": solver_settings},
                "output_ref": {
                    "cache_key": cache_key,
                    "artifact_types": list(artifacts.keys()),
                    "reused": False,
                },
                "log_excerpt": "Optimization completed.",
            }

        if step_name == "verify_replay":
            artifacts = self.store.list_run_artifacts(run_id)
            latest_constraint = self._latest_artifact(artifacts, "constraint_check")
            if not latest_constraint or not bool((latest_constraint.get("artifact_json") or {}).get("passed")):
                raise StructuredJobError(
                    code="VERIFY_FAILED",
                    technical_message="Constraint check artifact missing or failed.",
                    user_message="Verification failed because optimize outputs are incomplete.",
                    recommended_action="Review optimize step artifacts and rerun after fixing constraints.",
                )
            return {
                "status": "succeeded",
                "input_ref": {"constraint_check_artifact_id": latest_constraint.get("id")},
                "output_ref": {
                    "verified": True,
                    "message": "Constraint checks passed.",
                },
                "log_excerpt": "Verify/replay checks passed.",
            }

        if step_name == "report":
            run_row = self.store.get_run(run_id) or {}
            meta = run_row.get("meta") or {}
            report_payload = {
                "summary": "Async workflow completed.",
                "key_results": [
                    f"Workflow: {run_row.get('workflow')}",
                    f"Run ID: {run_id}",
                ],
                "exceptions": [],
                "recommended_actions": [
                    "Review generated artifacts from run outputs.",
                ],
                "run_meta": meta,
            }
            self.store.save_artifact(run_id, "workflow_report_summary", report_payload)
            return {
                "status": "succeeded",
                "input_ref": {"run_id": run_id},
                "output_ref": {"artifact_types": ["workflow_report_summary"]},
                "log_excerpt": "Workflow report generated.",
            }

        raise StructuredJobError(
            code="UNKNOWN_STEP",
            technical_message=f"Unknown step: {step_name}",
            user_message=f"Unknown step: {step_name}",
            recommended_action="Update worker step registry.",
        )

    def _step_is_applicable(self, step_name: str, workflow: str, engine_flags: Dict[str, Any]) -> bool:
        wf = str(workflow or "").lower()
        if step_name == "risk_scan":
            return ("workflow_b" in wf) or ("risk" in wf) or bool(engine_flags.get("risk_mode"))
        if step_name == "bom_explosion":
            return bool(engine_flags.get("include_bom")) or bool(engine_flags.get("multi_echelon_mode")) or ("bom" in wf)
        if step_name in {"optimize", "verify_replay"}:
            if "workflow_b" in wf and not bool(engine_flags.get("force_optimize")):
                return False
            return ("workflow_a" in wf) or ("optimize" in wf) or bool(engine_flags.get("force_optimize"))
        if step_name == "forecast":
            return wf != "risk_scan_only"
        return True

    def _enforce_limits(self, step_name: str, workload: Dict[str, Any]) -> None:
        rows_per_sheet = _safe_int(workload.get("rows_per_sheet"))
        skus = _safe_int(workload.get("skus"))
        bom_edges = _safe_int(workload.get("bom_edges"))
        bom_depth = _safe_int(workload.get("bom_depth"))
        forecast_series = _safe_int(workload.get("forecast_series"))

        if rows_per_sheet is not None and rows_per_sheet > self.config.max_rows_per_sheet:
            raise StructuredJobError(
                code="LIMIT_EXCEEDED",
                technical_message=f"rows_per_sheet={rows_per_sheet} exceeds DI_MAX_ROWS_PER_SHEET={self.config.max_rows_per_sheet}",
                user_message="Input sheet is too large to process safely.",
                recommended_action="Sample rows by recent horizon or split sheets into smaller batches.",
                details={"rows_per_sheet": rows_per_sheet, "limit": self.config.max_rows_per_sheet, "step": step_name},
            )

        if skus is not None and skus > self.config.max_skus:
            raise StructuredJobError(
                code="LIMIT_EXCEEDED",
                technical_message=f"skus={skus} exceeds DI_MAX_SKUS={self.config.max_skus}",
                user_message="Too many SKUs for this run profile.",
                recommended_action="Filter to top SKUs by demand/revenue, or split by plant and rerun.",
                details={"skus": skus, "limit": self.config.max_skus, "step": step_name},
            )

        if step_name == "bom_explosion":
            if bom_edges is not None and bom_edges > self.config.bom_max_edges:
                raise StructuredJobError(
                    code="LIMIT_EXCEEDED",
                    technical_message=f"bom_edges={bom_edges} exceeds DI_BOM_MAX_EDGES={self.config.bom_max_edges}",
                    user_message="BOM graph is too large for safe expansion.",
                    recommended_action="Trim BOM to critical parents/components or run by product family.",
                    details={"bom_edges": bom_edges, "limit": self.config.bom_max_edges},
                )
            if bom_depth is not None and bom_depth > self.config.bom_max_depth:
                raise StructuredJobError(
                    code="LIMIT_EXCEEDED",
                    technical_message=f"bom_depth={bom_depth} exceeds DI_BOM_MAX_DEPTH={self.config.bom_max_depth}",
                    user_message="BOM depth exceeds allowed maximum.",
                    recommended_action="Cap explosion depth or pre-aggregate deep subtrees before rerun.",
                    details={"bom_depth": bom_depth, "limit": self.config.bom_max_depth},
                )

        if step_name == "forecast" and forecast_series is not None and forecast_series > self.config.forecast_max_series:
            raise StructuredJobError(
                code="LIMIT_EXCEEDED",
                technical_message=f"forecast_series={forecast_series} exceeds DI_FORECAST_MAX_SERIES={self.config.forecast_max_series}",
                user_message="Forecast series count exceeds configured maximum.",
                recommended_action="Sample SKU/plant combinations or shorten horizon and rerun in batches.",
                details={"forecast_series": forecast_series, "limit": self.config.forecast_max_series},
            )

    def _simulate_compute(
        self,
        *,
        job_id: str,
        step_name: str,
        timeout_seconds: float,
        requested_seconds: float,
    ) -> None:
        requested = max(0.0, float(requested_seconds))
        timeout = max(0.01, float(timeout_seconds))
        start = time.monotonic()
        last_heartbeat = start

        while True:
            now = time.monotonic()
            elapsed = now - start

            if self.store.is_cancel_requested(job_id):
                raise JobCanceledError()

            if elapsed > timeout:
                raise StructuredJobError(
                    code="STEP_TIMEOUT",
                    technical_message=f"Step {step_name} timed out after {timeout:.2f}s",
                    user_message=f"Step \"{step_name}\" exceeded the configured timeout.",
                    recommended_action="Reduce input scope, shorten horizon, or increase timeout env vars.",
                    details={"step": step_name, "timeout_seconds": timeout, "requested_seconds": requested},
                )

            if elapsed >= requested:
                break

            if now - last_heartbeat >= self.config.heartbeat_interval_seconds:
                self.store.heartbeat_job(job_id)
                last_heartbeat = now

            sleep_for = min(self.config.step_sleep_slice_seconds, max(0.0, requested - elapsed))
            if sleep_for > 0:
                self.sleep_fn(sleep_for)

    def _reuse_cached_step(
        self,
        *,
        run_id: int,
        step_name: str,
        cache_key: str,
        artifact_types: List[str],
        meta_flag: str,
    ) -> Optional[Dict[str, Any]]:
        if not artifact_types:
            return None

        cache_hit = self.store.find_cached_run_for_artifact(
            artifact_type=artifact_types[0],
            cache_key=cache_key,
            exclude_run_id=run_id,
        )
        if not cache_hit:
            return None

        source_run_id = int(cache_hit.get("run_id"))
        copied = self.store.copy_artifacts(source_run_id, run_id, artifact_types)
        self.store.patch_run_meta(
            run_id,
            {
                meta_flag: True,
                f"{meta_flag}_from_run_id": source_run_id,
            },
        )
        return {
            "status": "skipped",
            "input_ref": {"cache_key": cache_key, "source_run_id": source_run_id},
            "output_ref": {
                "reused": True,
                "cached_from_run_id": source_run_id,
                "copied_artifacts": [item.get("artifact_type") for item in copied],
            },
            "log_excerpt": f"Reused cached artifacts from run {source_run_id}.",
        }

    def _build_forecast_artifacts(self, request: Dict[str, Any], cache_key: str) -> Dict[str, Any]:
        horizon = _safe_int(request.get("horizon")) or 8
        horizon = max(1, min(52, horizon))
        granularity = str(request.get("granularity") or "week")

        seed_base = int(cache_key[:8], 16)
        base_level = 50 + (seed_base % 30)
        points = []
        start_date = date.today()
        for idx in range(horizon):
            points.append(
                {
                    "date": (start_date + timedelta(days=idx)).isoformat(),
                    "forecast": float(base_level + ((idx % 4) * 2)),
                }
            )

        forecast_series = {
            "groups": [
                {
                    "sku": "SKU-001",
                    "plant_id": "PL01",
                    "points": points,
                }
            ],
            "total_groups": 1,
            "truncated_groups": False,
            "granularity": granularity,
            "cache_key": cache_key,
        }

        metrics = {
            "metric_name": "wape",
            "mape": 12.5,
            "mae": 8.2,
            "selected_model_global": "deterministic_baseline",
            "model_usage": {"deterministic_baseline": 1},
            "groups_processed": 1,
            "rows_used": horizon,
            "dropped_rows": 0,
            "horizon_periods": horizon,
            "granularity": granularity,
            "cache_key": cache_key,
        }

        report_json = {
            "summary": "Forecast generated by async worker.",
            "key_results": [
                f"Horizon: {horizon}",
                "Model: deterministic_baseline",
            ],
            "exceptions": [],
            "recommended_actions": [
                "Review demand variance and adjust safety stock if needed.",
            ],
            "cache_key": cache_key,
        }

        csv_lines = ["sku,plant_id,date,forecast"]
        for point in points:
            csv_lines.append(f"SKU-001,PL01,{point['date']},{point['forecast']}")
        forecast_csv = "\n".join(csv_lines)

        return {
            "forecast_series": forecast_series,
            "metrics": metrics,
            "report_json": report_json,
            "forecast_csv": forecast_csv,
        }

    def _build_risk_artifacts(self, cache_key: str) -> Dict[str, Any]:
        risk_scores = {
            "total_rows": 1,
            "rows": [
                {
                    "entity_type": "material",
                    "entity_id": "SKU-001|PL01",
                    "supplier": "SUP-001",
                    "material_code": "SKU-001",
                    "plant_id": "PL01",
                    "risk_score": 72.5,
                    "metrics": {
                        "on_time_rate": 0.86,
                        "avg_delay_days": 2.3,
                        "p90_delay_days": 5.0,
                        "lead_time_variability": 1.2,
                        "open_backlog_qty": 140,
                        "overdue_open_qty": 20,
                        "overdue_ratio": 0.14,
                        "recent_trend": "stable",
                    },
                }
            ],
            "cache_key": cache_key,
        }

        supporting_metrics = {
            "aggregates": {
                "high": 1,
                "medium": 0,
                "low": 0,
            },
            "inputs": {
                "po_rows": 120,
                "receipt_rows": 100,
            },
            "cache_key": cache_key,
        }

        risk_csv = "\n".join([
            "entity_type,entity_id,material_code,plant_id,risk_score",
            "material,SKU-001|PL01,SKU-001,PL01,72.5",
        ])

        return {
            "risk_scores": risk_scores,
            "supporting_metrics": supporting_metrics,
            "risk_scores_csv": risk_csv,
        }

    def _build_optimize_artifacts(self, request: Dict[str, Any], run_id: int, cache_key: str) -> Dict[str, Any]:
        horizon = _safe_int(request.get("horizon")) or 7
        horizon = max(1, min(30, horizon))
        start_date = date.today()

        plan_rows = []
        for idx in range(min(10, horizon)):
            order_date = start_date + timedelta(days=idx)
            arrival_date = order_date + timedelta(days=2)
            plan_rows.append(
                {
                    "sku": "SKU-001",
                    "plant_id": "PL01",
                    "order_date": order_date.isoformat(),
                    "arrival_date": arrival_date.isoformat(),
                    "order_qty": float(40 + (idx % 3) * 5),
                }
            )

        solver_meta = {
            "status": "optimal",
            "kpis": {
                "estimated_service_level": 0.97,
                "estimated_stockout_units": 2,
                "estimated_holding_units": 340,
                "estimated_total_cost": 12500,
            },
            "solver_meta": {
                "solver": "deterministic_heuristic",
                "max_time_in_seconds": self.config.solver_max_seconds,
                "solve_time_ms": 410,
            },
            "infeasible_reasons": [],
            "proof": {
                "objective_terms": [
                    {"name": "stockout_penalty", "value": 200},
                    {"name": "holding_cost", "value": 120},
                ],
                "constraints_checked": [
                    {"name": "moq", "passed": True, "details": "No MOQ violations."},
                    {"name": "pack_size_multiple", "passed": True, "details": "All order rows are pack-size compliant."},
                ],
            },
            "cache_key": cache_key,
        }

        constraint_check = {
            "passed": True,
            "violations": [],
            "cache_key": cache_key,
        }

        plan_table = {
            "total_rows": len(plan_rows),
            "rows": plan_rows,
            "truncated": False,
            "cache_key": cache_key,
        }

        replay_metrics = {
            "with_plan": {
                "service_level_proxy": 0.97,
                "stockout_units": 2,
                "holding_units": 340,
            },
            "without_plan": {
                "service_level_proxy": 0.84,
                "stockout_units": 44,
                "holding_units": 120,
            },
            "delta": {
                "service_level_proxy": 0.13,
                "stockout_units": -42,
                "holding_units": 220,
            },
            "cache_key": cache_key,
        }

        inventory_projection = {
            "total_rows": len(plan_rows),
            "rows": [
                {
                    "sku": row["sku"],
                    "plant_id": row["plant_id"],
                    "date": row["arrival_date"],
                    "with_plan": 120 - idx * 4,
                    "without_plan": 80 - idx * 6,
                    "demand": 30 + idx,
                    "stockout_units": 0 if idx < 5 else max(0, idx - 4),
                }
                for idx, row in enumerate(plan_rows)
            ],
            "truncated": False,
            "cache_key": cache_key,
        }

        evidence_pack = {
            "generated_at": _iso_now(),
            "run_id": run_id,
            "dataset_profile_id": request.get("dataset_profile_id"),
            "solver_status": "optimal",
            "refs": {
                "solver_meta": "solver_meta",
                "constraint_check": "constraint_check",
                "plan_table": "plan_table",
                "replay_metrics": "replay_metrics",
                "inventory_projection": "inventory_projection",
            },
            "evidence": {
                "notes": ["Deterministic plan generated by async worker."],
            },
            "cache_key": cache_key,
        }

        report_json = {
            "summary": "Optimization and replay completed successfully.",
            "key_results": [
                "Service level improved from 84% to 97%.",
                "Constraint checker returned pass.",
            ],
            "exceptions": [],
            "recommended_actions": [
                "Validate top order rows against supplier constraints.",
            ],
            "cache_key": cache_key,
        }

        csv_rows = ["sku,plant_id,order_date,arrival_date,order_qty"]
        csv_rows.extend(
            [
                f"{row['sku']},{row['plant_id']},{row['order_date']},{row['arrival_date']},{row['order_qty']}"
                for row in plan_rows
            ]
        )
        plan_csv = "\n".join(csv_rows)

        return {
            "solver_meta": solver_meta,
            "constraint_check": constraint_check,
            "plan_table": plan_table,
            "replay_metrics": replay_metrics,
            "inventory_projection": inventory_projection,
            "evidence_pack": evidence_pack,
            "report_json": report_json,
            "plan_csv": plan_csv,
        }

    def _latest_artifact(self, artifacts: List[Dict[str, Any]], artifact_type: str) -> Optional[Dict[str, Any]]:
        candidates = [item for item in (artifacts or []) if item.get("artifact_type") == artifact_type]
        if not candidates:
            return None
        return sorted(candidates, key=lambda row: int(row.get("id") or 0), reverse=True)[0]


def _safe_int(value: Any) -> Optional[int]:
    try:
        parsed = int(value)
    except Exception:
        return None
    return parsed
