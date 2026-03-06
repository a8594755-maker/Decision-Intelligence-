"""
PR4-C: Solver health monitoring and threshold alerting.

This module provides:
  1) Telemetry collection from async run tables/artifacts.
  2) Windowed health summary computation (p50/p95/rates/backlog).
  3) Deterministic threshold alert evaluation and log emission.
"""
from __future__ import annotations

import logging
import os
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except Exception:  # pragma: no cover - optional in pure unit tests
    psycopg2 = None
    RealDictCursor = None

logger = logging.getLogger(__name__)

_DEFAULT_WINDOWS = ("24h", "7d")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _to_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _parse_datetime(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        try:
            dt = datetime.fromisoformat(text)
        except Exception:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _safe_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        parsed = float(value)
    except Exception:
        return None
    if parsed != parsed:  # NaN
        return None
    if parsed in {float("inf"), float("-inf")}:
        return None
    return parsed


def _parse_window_token(token: str) -> Tuple[str, timedelta]:
    raw = str(token or "").strip().lower()
    if not raw:
        raise ValueError("Window token is empty. Use values like 24h or 7d.")

    unit = raw[-1]
    if unit not in {"h", "d"}:
        raise ValueError(f"Invalid window token '{token}'. Use values like 24h or 7d.")
    amount_text = raw[:-1].strip()
    try:
        amount = float(amount_text)
    except Exception as exc:
        raise ValueError(f"Invalid window amount in '{token}'.") from exc
    if amount <= 0:
        raise ValueError(f"Window must be positive in '{token}'.")

    if unit == "h":
        delta = timedelta(hours=amount)
    else:
        delta = timedelta(days=amount)

    normalized_amount = int(amount) if float(amount).is_integer() else amount
    normalized = f"{normalized_amount}{unit}"
    return normalized, delta


def parse_windows(last: str) -> List[Tuple[str, timedelta]]:
    text = str(last or "").strip()
    if not text:
        text = ",".join(_DEFAULT_WINDOWS)

    parsed: List[Tuple[str, timedelta]] = []
    seen = set()
    for token in text.split(","):
        label, delta = _parse_window_token(token)
        if label in seen:
            continue
        seen.add(label)
        parsed.append((label, delta))

    if not parsed:
        raise ValueError("No valid windows were provided.")
    return parsed


def _percentile(values: Sequence[float], quantile: float) -> Optional[float]:
    if not values:
        return None
    numbers = sorted(float(v) for v in values)
    if len(numbers) == 1:
        return round(numbers[0], 3)
    q = max(0.0, min(1.0, float(quantile)))
    pos = (len(numbers) - 1) * q
    lower = int(pos)
    upper = min(lower + 1, len(numbers) - 1)
    frac = pos - lower
    value = numbers[lower] + (numbers[upper] - numbers[lower]) * frac
    return round(value, 3)


def _classify_outcome(planning_status: Any, termination_reason: Any) -> Optional[str]:
    status = str(planning_status or "").strip().upper()
    reason = str(termination_reason or "").strip().upper()

    if status == "TIMEOUT" or "TIME_LIMIT" in reason or "TIMEOUT" in reason:
        return "timeout"
    if status == "INFEASIBLE" or "INFEASIBLE" in reason:
        return "infeasible"
    if status in {"OPTIMAL", "FEASIBLE", "SUCCESS"}:
        return "success"
    if status:
        return "other"
    if reason:
        if "TIME_LIMIT" in reason or "TIMEOUT" in reason:
            return "timeout"
        if "INFEASIBLE" in reason:
            return "infeasible"
        return "other"
    return None


@dataclass
class SolverHealthThresholds:
    timeout_rate: float = 0.25
    infeasible_rate: float = 0.20
    backlog_jobs: int = 10
    queue_wait_p95_ms: float = 120_000.0
    solve_time_slo_ms: float = 30_000.0
    cost_per_ms: float = 0.0

    @classmethod
    def from_env(cls) -> "SolverHealthThresholds":
        return cls(
            timeout_rate=float(os.getenv("DI_SOLVER_ALERT_TIMEOUT_RATE_THRESHOLD", "0.25")),
            infeasible_rate=float(os.getenv("DI_SOLVER_ALERT_INFEASIBLE_RATE_THRESHOLD", "0.20")),
            backlog_jobs=int(os.getenv("DI_SOLVER_ALERT_BACKLOG_JOBS_THRESHOLD", "10")),
            queue_wait_p95_ms=float(os.getenv("DI_SOLVER_ALERT_QUEUE_WAIT_P95_MS_THRESHOLD", "120000")),
            solve_time_slo_ms=float(os.getenv("DI_SOLVER_ALERT_SOLVE_TIME_SLO_MS_THRESHOLD", "30000")),
            cost_per_ms=float(os.getenv("DI_SOLVER_COST_PER_MS", "0")),
        )

    def with_overrides(
        self,
        *,
        timeout_rate: Optional[float] = None,
        infeasible_rate: Optional[float] = None,
        backlog_jobs: Optional[int] = None,
        queue_wait_p95_ms: Optional[float] = None,
        solve_time_slo_ms: Optional[float] = None,
        cost_per_ms: Optional[float] = None,
    ) -> "SolverHealthThresholds":
        return SolverHealthThresholds(
            timeout_rate=self.timeout_rate if timeout_rate is None else float(timeout_rate),
            infeasible_rate=self.infeasible_rate if infeasible_rate is None else float(infeasible_rate),
            backlog_jobs=self.backlog_jobs if backlog_jobs is None else int(backlog_jobs),
            queue_wait_p95_ms=self.queue_wait_p95_ms if queue_wait_p95_ms is None else float(queue_wait_p95_ms),
            solve_time_slo_ms=self.solve_time_slo_ms if solve_time_slo_ms is None else float(solve_time_slo_ms),
            cost_per_ms=self.cost_per_ms if cost_per_ms is None else float(cost_per_ms),
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def summarize_solver_health(
    rows: List[Dict[str, Any]],
    *,
    now: Optional[datetime] = None,
    window_label: str = "24h",
    window_start: Optional[datetime] = None,
    queue_snapshot: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    now_dt = now or _utc_now()
    if now_dt.tzinfo is None:
        now_dt = now_dt.replace(tzinfo=timezone.utc)
    now_dt = now_dt.astimezone(timezone.utc)
    if window_start is None:
        window_start = now_dt - timedelta(hours=24)
    if window_start.tzinfo is None:
        window_start = window_start.replace(tzinfo=timezone.utc)
    window_start = window_start.astimezone(timezone.utc)

    solve_times: List[float] = []
    wait_samples: List[float] = []
    current_queued_waits: List[float] = []
    outcome_counts = {"success": 0, "timeout": 0, "infeasible": 0, "other": 0}
    current_backlog_jobs = 0
    current_running_jobs = 0

    for row in rows or []:
        outcome = _classify_outcome(row.get("planning_status"), row.get("termination_reason"))
        if outcome in outcome_counts:
            outcome_counts[outcome] += 1

        solve_time = _safe_float(row.get("solve_time_ms"))
        if solve_time is not None and solve_time >= 0:
            solve_times.append(solve_time)

        created_at = _parse_datetime(row.get("created_at"))
        started_at = _parse_datetime(row.get("started_at"))
        if created_at and started_at:
            wait_ms = (started_at - created_at).total_seconds() * 1000.0
            if wait_ms >= 0:
                wait_samples.append(wait_ms)

        job_status = str(row.get("job_status") or "").strip().lower()
        if job_status == "queued":
            current_backlog_jobs += 1
            if created_at:
                queued_wait_ms = (now_dt - created_at).total_seconds() * 1000.0
                if queued_wait_ms >= 0:
                    current_queued_waits.append(queued_wait_ms)
        elif job_status == "running":
            current_running_jobs += 1

    total_outcomes = sum(outcome_counts.values())
    if total_outcomes > 0:
        success_rate = outcome_counts["success"] / total_outcomes
        timeout_rate = outcome_counts["timeout"] / total_outcomes
        infeasible_rate = outcome_counts["infeasible"] / total_outcomes
        other_rate = outcome_counts["other"] / total_outcomes
    else:
        success_rate = timeout_rate = infeasible_rate = other_rate = 0.0

    queue_snapshot = queue_snapshot or {}
    snapshot_backlog = int(_safe_float(queue_snapshot.get("current_backlog_jobs")) or 0)
    snapshot_running = int(_safe_float(queue_snapshot.get("current_running_jobs")) or 0)
    snapshot_current_p50 = _safe_float(queue_snapshot.get("current_queue_wait_ms_p50"))
    snapshot_current_p95 = _safe_float(queue_snapshot.get("current_queue_wait_ms_p95"))
    snapshot_oldest = _safe_float(queue_snapshot.get("oldest_queued_job_wait_ms"))

    current_backlog_jobs = max(current_backlog_jobs, snapshot_backlog)
    current_running_jobs = max(current_running_jobs, snapshot_running)
    if snapshot_current_p50 is None:
        snapshot_current_p50 = _percentile(current_queued_waits, 0.50)
    if snapshot_current_p95 is None:
        snapshot_current_p95 = _percentile(current_queued_waits, 0.95)
    if snapshot_oldest is None and current_queued_waits:
        snapshot_oldest = round(max(current_queued_waits), 3)

    historical_wait_p95 = _percentile(wait_samples, 0.95)
    queue_wait_for_alert = snapshot_current_p95
    if queue_wait_for_alert is None:
        queue_wait_for_alert = historical_wait_p95
    if queue_wait_for_alert is None:
        queue_wait_for_alert = 0.0

    solve_time_p50 = _percentile(solve_times, 0.50)
    solve_time_p95 = _percentile(solve_times, 0.95)

    return {
        "window": str(window_label),
        "window_start": _to_iso(window_start),
        "window_end": _to_iso(now_dt),
        "sample_size": int(len(rows or [])),
        "outcomes": {
            "total": int(total_outcomes),
            **outcome_counts,
        },
        "rates": {
            "success_rate": round(success_rate, 6),
            "timeout_rate": round(timeout_rate, 6),
            "infeasible_rate": round(infeasible_rate, 6),
            "other_rate": round(other_rate, 6),
        },
        "solve_time_ms": {
            "count": int(len(solve_times)),
            "p50": solve_time_p50,
            "p95": solve_time_p95,
        },
        "queue": {
            "observed_queue_wait_samples": int(len(wait_samples)),
            "queue_wait_ms_p50": _percentile(wait_samples, 0.50),
            "queue_wait_ms_p95": historical_wait_p95,
            "current_backlog_jobs": int(current_backlog_jobs),
            "current_running_jobs": int(current_running_jobs),
            "current_queue_wait_ms_p50": round(snapshot_current_p50, 3) if snapshot_current_p50 is not None else None,
            "current_queue_wait_ms_p95": round(snapshot_current_p95, 3) if snapshot_current_p95 is not None else None,
            "oldest_queued_job_wait_ms": round(snapshot_oldest, 3) if snapshot_oldest is not None else None,
            "queue_wait_ms_p95_for_alert": round(float(queue_wait_for_alert), 3),
        },
    }


def evaluate_solver_health_alerts(
    summary: Dict[str, Any],
    thresholds: Optional[SolverHealthThresholds] = None,
) -> List[Dict[str, Any]]:
    threshold_cfg = thresholds or SolverHealthThresholds.from_env()
    rates = summary.get("rates") or {}
    queue = summary.get("queue") or {}

    timeout_rate = float(rates.get("timeout_rate") or 0.0)
    infeasible_rate = float(rates.get("infeasible_rate") or 0.0)
    backlog_jobs = int(float(queue.get("current_backlog_jobs") or 0))
    queue_wait_p95_ms = float(queue.get("queue_wait_ms_p95_for_alert") or 0.0)

    alerts: List[Dict[str, Any]] = []
    window = summary.get("window")

    if timeout_rate > threshold_cfg.timeout_rate:
        alerts.append(
            {
                "code": "timeout_rate_spike",
                "metric": "timeout_rate",
                "value": round(timeout_rate, 6),
                "threshold": threshold_cfg.timeout_rate,
                "window": window,
                "message": (
                    f"timeout_rate={timeout_rate:.3f} exceeded "
                    f"threshold={threshold_cfg.timeout_rate:.3f}"
                ),
            }
        )

    if infeasible_rate > threshold_cfg.infeasible_rate:
        alerts.append(
            {
                "code": "infeasible_rate_spike",
                "metric": "infeasible_rate",
                "value": round(infeasible_rate, 6),
                "threshold": threshold_cfg.infeasible_rate,
                "window": window,
                "message": (
                    f"infeasible_rate={infeasible_rate:.3f} exceeded "
                    f"threshold={threshold_cfg.infeasible_rate:.3f}"
                ),
            }
        )

    if backlog_jobs > threshold_cfg.backlog_jobs:
        alerts.append(
            {
                "code": "backlog_jobs_spike",
                "metric": "current_backlog_jobs",
                "value": backlog_jobs,
                "threshold": threshold_cfg.backlog_jobs,
                "window": window,
                "message": (
                    f"current_backlog_jobs={backlog_jobs} exceeded "
                    f"threshold={threshold_cfg.backlog_jobs}"
                ),
            }
        )

    if queue_wait_p95_ms > threshold_cfg.queue_wait_p95_ms:
        alerts.append(
            {
                "code": "queue_wait_p95_ms_spike",
                "metric": "queue_wait_ms_p95_for_alert",
                "value": round(queue_wait_p95_ms, 3),
                "threshold": threshold_cfg.queue_wait_p95_ms,
                "window": window,
                "message": (
                    f"queue_wait_ms_p95={queue_wait_p95_ms:.1f} exceeded "
                    f"threshold={threshold_cfg.queue_wait_p95_ms:.1f}"
                ),
            }
        )

    # Phase 4.6: Solve-time SLO breach
    solve_time_p95 = float((summary.get("solve_time_ms") or {}).get("p95") or 0.0)
    if solve_time_p95 > 0 and solve_time_p95 > threshold_cfg.solve_time_slo_ms:
        alerts.append(
            {
                "code": "solve_time_slo_breach",
                "metric": "solve_time_ms_p95",
                "value": round(solve_time_p95, 3),
                "threshold": threshold_cfg.solve_time_slo_ms,
                "window": window,
                "message": (
                    f"solve_time_ms_p95={solve_time_p95:.1f} exceeded "
                    f"SLO threshold={threshold_cfg.solve_time_slo_ms:.1f}"
                ),
            }
        )

    return alerts


def emit_solver_health_alert_logs(
    alerts: List[Dict[str, Any]],
    *,
    log: Optional[logging.Logger] = None,
) -> None:
    active_log = log or logger
    for alert in alerts:
        active_log.warning(
            "ALERT: solver_health code=%s metric=%s value=%s threshold=%s window=%s",
            alert.get("code"),
            alert.get("metric"),
            alert.get("value"),
            alert.get("threshold"),
            alert.get("window"),
        )


def _resolve_database_url(database_url: Optional[str] = None) -> str:
    resolved = (
        database_url
        or os.getenv("DI_DATABASE_URL")
        or os.getenv("DATABASE_URL")
        or os.getenv("SUPABASE_DB_URL")
    )
    if not resolved:
        raise RuntimeError("Database URL is required (DI_DATABASE_URL or DATABASE_URL).")
    return resolved


def _connect(database_url: str):
    if psycopg2 is None:
        raise RuntimeError("psycopg2 is required to query solver health telemetry.")
    return psycopg2.connect(database_url, cursor_factory=RealDictCursor)


def fetch_solver_health_rows(
    *,
    database_url: Optional[str] = None,
    since: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    db_url = _resolve_database_url(database_url)
    since_ts = since or (_utc_now() - timedelta(hours=24))
    if since_ts.tzinfo is None:
        since_ts = since_ts.replace(tzinfo=timezone.utc)
    since_ts = since_ts.astimezone(timezone.utc)

    query = """
    WITH latest_solver AS (
      SELECT DISTINCT ON (run_id) run_id, artifact_json
      FROM public.di_run_artifacts
      WHERE artifact_type = 'solver_meta'
      ORDER BY run_id, created_at DESC, id DESC
    ),
    latest_planning AS (
      SELECT DISTINCT ON (run_id) run_id, artifact_json
      FROM public.di_run_artifacts
      WHERE artifact_type = 'planning_result'
      ORDER BY run_id, created_at DESC, id DESC
    ),
    latest_exec AS (
      SELECT DISTINCT ON (run_id) run_id, artifact_json
      FROM public.di_run_artifacts
      WHERE artifact_type = 'execution_summary'
      ORDER BY run_id, created_at DESC, id DESC
    )
    SELECT
      j.id::text AS job_id,
      j.run_id,
      j.status AS job_status,
      j.created_at,
      j.started_at,
      j.finished_at,
      COALESCE(
        latest_exec.artifact_json ->> 'planning_status',
        latest_solver.artifact_json ->> 'status',
        latest_planning.artifact_json ->> 'status'
      ) AS planning_status,
      COALESCE(
        latest_exec.artifact_json ->> 'termination_reason',
        latest_solver.artifact_json -> 'solver_meta' ->> 'termination_reason',
        latest_planning.artifact_json -> 'solver_meta' ->> 'termination_reason'
      ) AS termination_reason,
      COALESCE(
        latest_solver.artifact_json -> 'solver_meta' ->> 'solve_time_ms',
        latest_planning.artifact_json -> 'solver_meta' ->> 'solve_time_ms'
      ) AS solve_time_ms
    FROM public.di_jobs j
    LEFT JOIN latest_solver ON latest_solver.run_id = j.run_id
    LEFT JOIN latest_planning ON latest_planning.run_id = j.run_id
    LEFT JOIN latest_exec ON latest_exec.run_id = j.run_id
    WHERE j.created_at >= %s
    ORDER BY j.created_at DESC
    """

    with _connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(query, (since_ts,))
            rows = cur.fetchall() or []
            return [dict(row) for row in rows]


def fetch_queue_snapshot(
    *,
    database_url: Optional[str] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    db_url = _resolve_database_url(database_url)
    now_ts = now or _utc_now()
    if now_ts.tzinfo is None:
        now_ts = now_ts.replace(tzinfo=timezone.utc)
    now_ts = now_ts.astimezone(timezone.utc)

    query = """
    SELECT
      COUNT(*) FILTER (WHERE status = 'queued') AS current_backlog_jobs,
      COUNT(*) FILTER (WHERE status = 'running') AS current_running_jobs,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (%s::timestamptz - created_at)) * 1000.0
      ) FILTER (WHERE status = 'queued') AS current_queue_wait_ms_p50,
      percentile_cont(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (%s::timestamptz - created_at)) * 1000.0
      ) FILTER (WHERE status = 'queued') AS current_queue_wait_ms_p95,
      MAX(EXTRACT(EPOCH FROM (%s::timestamptz - created_at)) * 1000.0)
        FILTER (WHERE status = 'queued') AS oldest_queued_job_wait_ms
    FROM public.di_jobs
    WHERE status IN ('queued', 'running')
    """

    with _connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(query, (now_ts, now_ts, now_ts))
            row = cur.fetchone() or {}
            return dict(row)


def collect_solver_health(
    *,
    last: str = "24h,7d",
    thresholds: Optional[SolverHealthThresholds] = None,
    database_url: Optional[str] = None,
    now: Optional[datetime] = None,
    emit_alert_logs: bool = True,
) -> Dict[str, Any]:
    now_dt = now or _utc_now()
    if now_dt.tzinfo is None:
        now_dt = now_dt.replace(tzinfo=timezone.utc)
    now_dt = now_dt.astimezone(timezone.utc)

    threshold_cfg = thresholds or SolverHealthThresholds.from_env()
    windows = parse_windows(last)

    queue_snapshot = fetch_queue_snapshot(database_url=database_url, now=now_dt)
    summary_by_window: Dict[str, Any] = {}
    alerts_by_window: Dict[str, List[Dict[str, Any]]] = {}
    total_alerts = 0

    for label, delta in windows:
        since = now_dt - delta
        rows = fetch_solver_health_rows(database_url=database_url, since=since)
        summary = summarize_solver_health(
            rows,
            now=now_dt,
            window_label=label,
            window_start=since,
            queue_snapshot=queue_snapshot,
        )
        alerts = evaluate_solver_health_alerts(summary, threshold_cfg)
        if emit_alert_logs and alerts:
            emit_solver_health_alert_logs(alerts)
        # Phase 4.6: Compute cost_per_solve if cost_per_ms is configured
        if threshold_cfg.cost_per_ms > 0:
            solve_p50 = (summary.get("solve_time_ms") or {}).get("p50")
            summary["cost_per_solve"] = round(solve_p50 * threshold_cfg.cost_per_ms, 6) if solve_p50 else None
        else:
            summary["cost_per_solve"] = None

        summary_by_window[label] = summary
        alerts_by_window[label] = alerts
        total_alerts += len(alerts)

    return {
        "generated_at": _to_iso(now_dt),
        "requested_windows": [label for label, _ in windows],
        "thresholds": threshold_cfg.to_dict(),
        "windows": summary_by_window,
        "alerts": alerts_by_window,
        "alert_count": int(total_alerts),
    }

