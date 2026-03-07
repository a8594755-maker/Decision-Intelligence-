import sys
from pathlib import Path

# Ensure both import styles work:
# - `uvicorn ml.api.main:app` (needs /app/src on sys.path)
# - `uvicorn src.ml.api.main:app` (already has /app, but imports use `ml.*`)
_current_file = Path(__file__).resolve()
_src_dir = str(_current_file.parents[2])      # /app/src
_project_root = str(_current_file.parents[3]) # /app
for _path in (_src_dir, _project_root):
    if _path not in sys.path:
        sys.path.insert(0, _path)

# Configure structured logging BEFORE any getLogger() calls
from ml.api.logging_config import configure_logging
configure_logging()

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator, model_validator
from ml.demand_forecasting.prophet_trainer import ProphetTrainer
from ml.demand_forecasting.lightgbm_trainer import LightGBMTrainer
from ml.demand_forecasting.chronos_trainer import ChronosTrainer
from ml.demand_forecasting.forecaster_factory import ForecasterFactory, ModelType
from ml.demand_forecasting.erp_connector import ERPConnector
from ml.utils.supabase_rest_client import SupabaseRESTClient
import os
import json
import logging
import hashlib
import numpy as np
from datetime import datetime, timedelta, timezone
from typing import Optional, List, Dict, Any, Tuple

# Sentry error monitoring (optional — enabled when SENTRY_DSN is set)
_sentry_dsn = os.getenv("SENTRY_DSN")
if _sentry_dsn:
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        sentry_sdk.init(
            dsn=_sentry_dsn,
            environment=os.getenv("DI_ENV", "production"),
            traces_sample_rate=0.2,
            integrations=[FastApiIntegration()],
        )
    except ImportError:
        pass  # sentry-sdk not installed — skip silently
import math

from ml.api.planning_contract import (
    PLANNING_API_CONTRACT_VERSION,
    PlanningStatus,
    build_contract_error_response,
)
from ml.api.forecast_contract import (
    FORECAST_API_CONTRACT_VERSION,
    finalize_forecast_response,
    finalize_backtest_response,
)
from ml.api.solver_engines import select_solver_engine, solve_planning_contract

import asyncio

from ml.api.async_runs import (
    AsyncRunConfig,
    AsyncRunService,
    AsyncRunStatusResponse,
    AsyncRunSubmitRequest,
    AsyncRunSubmitResponse,
    InMemoryAsyncRunStore,
    PostgresAsyncRunStore,
    TERMINAL_JOB_STATUSES,
)
from ml.api.excel_export import excel_export_router
from ml.api.registry_router import router as registry_router
from ml.governance import (
    ActorContext,
    ApprovalError,
    GovernanceAction,
    GovernanceStore,
    canonical_payload_hash,
    ensure_role_allowed,
    normalize_role,
)
from ml.monitoring.solver_health import (
    SolverHealthThresholds,
    collect_solver_health,
)
from ml.api.solver_telemetry import (
    InMemorySolverTelemetryStore,
    PostgresSolverTelemetryStore,
    emit_solver_telemetry_event,
    extract_contract_version,
    extract_engine,
    extract_objective,
    extract_solve_time_ms,
    extract_status,
    extract_termination_reason,
    new_telemetry_run_id,
)

logger = logging.getLogger(__name__)

_governance_store: Optional[GovernanceStore] = None


def _get_governance_store() -> GovernanceStore:
    global _governance_store
    if _governance_store is None:
        _governance_store = GovernanceStore()
    return _governance_store


def _actor_from_request(request: Request) -> ActorContext:
    # Prefer JWT claims (set by jwt_auth_middleware) over headers
    jwt_claims = getattr(request.state, "jwt_claims", None)
    if jwt_claims and jwt_claims.sub:
        return ActorContext(
            actor_id=jwt_claims.sub,
            role=normalize_role(jwt_claims.role),
        )
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


def sanitize_numpy(obj):
    """Recursively normalize values to JSON-safe Python types."""
    if isinstance(obj, dict):
        return {k: sanitize_numpy(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [sanitize_numpy(v) for v in obj]
    elif isinstance(obj, (np.integer,)):
        return int(obj)
    elif isinstance(obj, (np.floating,)):
        value = float(obj)
        return value if math.isfinite(value) else None
    elif isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    elif isinstance(obj, (np.bool_,)):
        return bool(obj)
    elif isinstance(obj, np.ndarray):
        return sanitize_numpy(obj.tolist())
    return obj

app = FastAPI(
    title="Demand Forecast API",
    description="AI-driven demand forecasting service for Risk Dashboard",
    version="1.0.0"
)

def _parse_allowed_origins(raw_value: str) -> List[str]:
    return [origin.strip() for origin in raw_value.split(",") if origin.strip()]


ALLOWED_ORIGINS = _parse_allowed_origins(
    os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174")
)


def _resolve_cors_origin(request: Request) -> str:
    origin = request.headers.get("origin", "")
    if origin and origin in ALLOWED_ORIGINS:
        return origin
    return ALLOWED_ORIGINS[0] if ALLOWED_ORIGINS else "http://localhost:5173"


# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
)

app.include_router(excel_export_router)
app.include_router(registry_router)

# Health endpoints (liveness + readiness probes)
from ml.api.observability import health_router, request_id_middleware as _request_id_mw
app.include_router(health_router)

# Prometheus metrics (optional — installed via prometheus-fastapi-instrumentator)
try:
    from prometheus_fastapi_instrumentator import Instrumentator
    Instrumentator().instrument(app).expose(app, endpoint="/metrics")
except ImportError:
    pass  # prometheus-fastapi-instrumentator not installed — skip

# ── Middleware Stack (LIFO: last registered = first to run) ──
# Execution order: request_id → JWT → rate_limit → tenant_id → CORS

# 5. Tenant ID extraction (registered first, runs last among custom middleware)
@app.middleware("http")
async def tenant_id_middleware(request: Request, call_next):
    """Extract X-Tenant-ID header and attach to request state."""
    tenant_id = (request.headers.get("x-tenant-id") or "").strip()
    request.state.tenant_id = tenant_id
    response = await call_next(request)
    return response


def _tenant_id_from_request(request: Request) -> str:
    """Get tenant_id from request state (set by middleware)."""
    return getattr(request.state, "tenant_id", "") or ""


# 4. Rate Limiting (Redis-backed with in-process fallback)
from ml.api.rate_limiter import RateLimiter
_RATE_LIMIT_ENABLED = os.getenv("DI_RATE_LIMIT_ENABLED", "true").lower() == "true"
_rate_limiter = RateLimiter.from_env()


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    """Rate limiter for heavy endpoints. Uses Redis if available, else in-process."""
    if not _RATE_LIMIT_ENABLED:
        return await call_next(request)

    # Only rate-limit heavy endpoints
    path = request.url.path
    _heavy_paths = {"/demand-forecast", "/replenishment-plan", "/train-model", "/backtest"}
    if path not in _heavy_paths:
        return await call_next(request)

    # Use JWT user or IP as rate limit key
    jwt_claims = getattr(request.state, "jwt_claims", None)
    if jwt_claims and jwt_claims.sub:
        key = f"user:{jwt_claims.sub}"
    else:
        key = f"ip:{request.client.host if request.client else 'unknown'}"

    if not await _rate_limiter.is_allowed(key):
        return JSONResponse(
            status_code=429,
            content={"error": "Rate limit exceeded. Please retry after 60 seconds."},
        )

    return await call_next(request)


# 3. JWT Authentication
from ml.api.jwt_auth import configure_jwt, jwt_auth_middleware as _jwt_auth_mw
configure_jwt()


@app.middleware("http")
async def jwt_middleware(request: Request, call_next):
    return await _jwt_auth_mw(request, call_next)


# 2. Request ID + Structured Logging context (registered last, runs first)
@app.middleware("http")
async def request_id_mw(request: Request, call_next):
    return await _request_id_mw(request, call_next)


@app.on_event("shutdown")
async def _shutdown_rate_limiter():
    await _rate_limiter.close()


# ── Solver Concurrency Guard ──
_SOLVER_MAX_CONCURRENT = int(os.getenv("DI_SOLVER_MAX_CONCURRENT", "3"))
_solver_semaphore = asyncio.Semaphore(_SOLVER_MAX_CONCURRENT)


async def acquire_solver_slot(timeout: float = 30.0) -> bool:
    """Try to acquire a solver slot within timeout. Returns True if acquired."""
    try:
        return await asyncio.wait_for(_solver_semaphore.acquire(), timeout=timeout)
    except asyncio.TimeoutError:
        return False


def release_solver_slot():
    """Release a solver slot."""
    _solver_semaphore.release()


def _require_tenant_id(request: Request) -> str:
    """
    Enforce tenant_id on multi-tenant endpoints.
    Returns tenant_id or raises 400 if missing and enforcement is enabled.
    """
    tenant_id = _tenant_id_from_request(request)
    enforce = os.getenv("DI_ENFORCE_TENANT_ID", "false").lower() == "true"
    if enforce and not tenant_id:
        raise HTTPException(
            status_code=400,
            detail="X-Tenant-ID header is required for this endpoint.",
        )
    return tenant_id


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={"error": str(exc)},
        headers={"Access-Control-Allow-Origin": _resolve_cors_origin(request)},
    )

# Configuration
ERP_API_ENDPOINT = os.getenv("ERP_ENDPOINT", "https://erp-api.example.com")
USE_MOCK_ERP = os.getenv("USE_MOCK_ERP", "true").lower() == "true"
ERP_API_KEY = os.getenv("ERP_API_KEY", "")
if not USE_MOCK_ERP and not ERP_API_KEY:
    raise ValueError("ERP_API_KEY environment variable is required when USE_MOCK_ERP is not true")

# Initialize services - 根据环境变量选择真实或Mock ERP连接器
if USE_MOCK_ERP:
    from ml.demand_forecasting.mock_erp_connector import MockERPConnector
    erp_connector = MockERPConnector(ERP_API_ENDPOINT, ERP_API_KEY)
    print("🧪 使用Mock ERP连接器 (测试模式)")
else:
    from ml.demand_forecasting.erp_connector import ERPConnector
    erp_connector = ERPConnector(ERP_API_ENDPOINT, ERP_API_KEY)
    print("🔗 使用真实ERP连接器")
prophet_trainer = ProphetTrainer()
lightgbm_trainer = LightGBMTrainer()
chronos_trainer = ChronosTrainer()
forecaster_factory = ForecasterFactory()
supabase_client = SupabaseRESTClient()
_async_run_service: Optional[AsyncRunService] = None
_solver_telemetry_store: Optional[Any] = None


def get_async_run_service() -> AsyncRunService:
    global _async_run_service
    if _async_run_service is None:
        try:
            store = PostgresAsyncRunStore()
        except RuntimeError as exc:
            logger.info("Async run store fallback to in-memory: %s", exc)
            store = InMemoryAsyncRunStore()
        _async_run_service = AsyncRunService(store=store, config=AsyncRunConfig.from_env())
    return _async_run_service


def get_solver_telemetry_store() -> Any:
    global _solver_telemetry_store
    if _solver_telemetry_store is None:
        try:
            _solver_telemetry_store = PostgresSolverTelemetryStore()
        except Exception as exc:
            logger.info("Solver telemetry store fallback to in-memory: %s", exc)
            _solver_telemetry_store = InMemorySolverTelemetryStore()
    return _solver_telemetry_store

class ForecastRequest(BaseModel):
    model_config = {"populate_by_name": True}
    materialCode: str
    horizonDays: int = 30
    modelType: Optional[str] = None  # None = auto-recommend, "prophet", "lightgbm", "chronos", "AUTO"
    includeComparison: bool = True  # 是否包含模型比较
    userPreference: Optional[str] = None  # 用户偏好模型
    history: Optional[List[float]] = None  # 直接传入的历史数据序列（压力测试/离线模式）
    async_mode: bool = Field(default=False, alias="async")
    userId: Optional[str] = None
    datasetProfileId: Optional[int] = None
    datasetFingerprint: Optional[str] = None
    contractTemplateId: Optional[int] = None
    workflow: Optional[str] = None
    engineFlags: Dict[str, Any] = Field(default_factory=dict)
    settings: Dict[str, Any] = Field(default_factory=dict)
    maxAttempts: Optional[int] = None
    workload: Dict[str, Any] = Field(default_factory=dict)

class ModelAnalysisRequest(BaseModel):
    materialCode: str

class ModelStatusRequest(BaseModel):
    pass


def _request_async_enabled(model: BaseModel) -> bool:
    if bool(getattr(model, "async_mode", False)):
        return True
    extras = getattr(model, "model_extra", None) or {}
    return bool(extras.get("async"))


def _coerce_forecast_result(result: Any, *, source: str) -> Dict[str, Any]:
    """Normalize forecast pipeline outputs into a predictable dict payload."""
    if result is None:
        return {
            "success": False,
            "error": f"Forecast pipeline returned no result from {source}.",
            "attempted_models": [],
            "errors": [{"source": source, "error": "empty_result"}],
        }
    if not isinstance(result, dict):
        return {
            "success": False,
            "error": f"Forecast pipeline returned invalid payload type {type(result).__name__} from {source}.",
            "attempted_models": [],
            "errors": [{"source": source, "error": "invalid_result_type"}],
        }
    if "success" in result:
        return result
    normalized = dict(result)
    normalized["success"] = False
    normalized.setdefault("error", f"Forecast pipeline result missing 'success' flag from {source}.")
    normalized.setdefault("attempted_models", [])
    normalized.setdefault("errors", [])
    return normalized


@app.post("/jobs", response_model=AsyncRunSubmitResponse)
async def submit_async_job(request: AsyncRunSubmitRequest, raw_request: Request):
    try:
        service = get_async_run_service()
        return service.submit(request, base_url=str(raw_request.base_url))
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/runs", response_model=AsyncRunSubmitResponse)
async def submit_async_run(request: AsyncRunSubmitRequest, raw_request: Request):
    return await submit_async_job(request, raw_request)


@app.get("/jobs/{job_id}", response_model=AsyncRunStatusResponse)
async def get_async_job_status(job_id: str):
    service = get_async_run_service()
    try:
        return service.get_job_status(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/jobs/{job_id}/cancel")
async def cancel_async_job(job_id: str):
    service = get_async_run_service()
    try:
        return service.cancel_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/runs/{run_id}/steps")
async def get_run_steps(run_id: int):
    service = get_async_run_service()
    return {
        "run_id": run_id,
        "steps": service.get_run_steps(run_id),
    }


@app.get("/runs/{run_id}/artifacts")
async def get_run_artifacts(run_id: int):
    service = get_async_run_service()
    return {
        "run_id": run_id,
        "artifacts": service.get_run_artifacts(run_id),
    }


@app.get("/ops/solver-health")
async def get_solver_health(
    last: str = Query("24h,7d", description="Comma-separated lookback windows (e.g., 24h,7d)."),
    timeout_rate_threshold: Optional[float] = Query(None, ge=0.0, le=1.0),
    infeasible_rate_threshold: Optional[float] = Query(None, ge=0.0, le=1.0),
    backlog_jobs_threshold: Optional[int] = Query(None, ge=0),
    queue_wait_p95_ms_threshold: Optional[float] = Query(None, ge=0.0),
    emit_alert_logs: bool = Query(True, description="When true, emitted alerts are also logged as ALERT events."),
):
    thresholds = SolverHealthThresholds.from_env().with_overrides(
        timeout_rate=timeout_rate_threshold,
        infeasible_rate=infeasible_rate_threshold,
        backlog_jobs=backlog_jobs_threshold,
        queue_wait_p95_ms=queue_wait_p95_ms_threshold,
    )
    try:
        return collect_solver_health(
            last=last,
            thresholds=thresholds,
            emit_alert_logs=emit_alert_logs,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/ops/solver-telemetry")
async def get_solver_telemetry(
    days: int = Query(7, ge=1, le=365),
    engine: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    event_type: str = Query("summary", pattern="^(started|finished|summary)$"),
    limit: int = Query(200, ge=1, le=5000),
):
    store = get_solver_telemetry_store()
    end_time = datetime.now(timezone.utc)
    start_time = end_time - timedelta(days=int(days))
    rows = store.list_events(
        start_time=start_time,
        end_time=end_time,
        engine=engine,
        status=status,
        event_type=event_type,
        limit=limit,
    )
    metrics = store.summary_metrics(
        start_time=start_time,
        end_time=end_time,
        engine=engine,
        status=status,
    )
    return {
        "window": {
            "days": int(days),
            "start": start_time.isoformat(),
            "end": end_time.isoformat(),
        },
        "filters": {
            "engine": engine,
            "status": status,
            "event_type": event_type,
        },
        "metrics": metrics,
        "rows": rows,
    }


@app.get("/jobs/{job_id}/events")
async def stream_job_events(
    job_id: str,
    interval_seconds: float = Query(2.0, ge=0.5, le=10.0),
):
    service = get_async_run_service()

    async def event_stream():
        previous_payload = None
        emitted_event_count = 0
        legacy_to_contract_event = {
            "job_started": "started",
            "result_persisted": "persisted",
            "job_completed": "completed",
        }
        while True:
            try:
                status = service.get_job_status(job_id)
            except KeyError:
                yield "event: error\\ndata: {\"error\":\"job_not_found\"}\\n\\n"
                break

            run_events = status.events if isinstance(status.events, list) else []
            if emitted_event_count < len(run_events):
                for event_payload in run_events[emitted_event_count:]:
                    event_name = str(event_payload.get("event") or "status")
                    mapped_event = legacy_to_contract_event.get(event_name)
                    if mapped_event:
                        mapped_payload = dict(event_payload)
                        mapped_payload["event"] = mapped_event
                        mapped_json = json.dumps(mapped_payload, ensure_ascii=False)
                        yield f"event: {mapped_event}\\ndata: {mapped_json}\\n\\n"
                    event_json = json.dumps(event_payload, ensure_ascii=False)
                    yield f"event: {event_name}\\ndata: {event_json}\\n\\n"
                emitted_event_count = len(run_events)

            payload = status.model_dump(mode="json")
            payload_json = json.dumps(payload, ensure_ascii=False)
            if payload_json != previous_payload:
                yield f"event: status\\ndata: {payload_json}\\n\\n"
                previous_payload = payload_json

            if str(status.status).lower() in TERMINAL_JOB_STATUSES:
                break
            await asyncio.sleep(interval_seconds)

        yield "event: end\\ndata: {\"done\":true}\\n\\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")

@app.post("/demand-forecast")
async def demand_forecast(request: ForecastRequest, raw_request: Request = None):
    """
    双模型需求预测端点
    :param request: 预测请求参数
    :return: 预测结果
    """
    # Tenant enforcement: extract tenant_id for downstream filtering
    if raw_request:
        _require_tenant_id(raw_request)
    try:
        # Phase 1 – P1.5: Import boundary gate (schema validation)
        from ml.demand_forecasting.dataset_schema import validate_forecast_payload
        schema_errors = validate_forecast_payload({
            "materialCode": request.materialCode,
            "horizonDays": request.horizonDays,
            "modelType": request.modelType,
            "history": request.history,
        })
        if schema_errors:
            return JSONResponse(
                status_code=422,
                content={"errors": schema_errors, "message": "Schema validation failed"},
            )

        if _request_async_enabled(request):
            if not request.userId:
                raise HTTPException(status_code=400, detail="userId is required when async mode is enabled")
            if not request.datasetProfileId:
                raise HTTPException(status_code=400, detail="datasetProfileId is required when async mode is enabled")
            dataset_fingerprint = request.datasetFingerprint or f"material:{request.materialCode}"
            service = get_async_run_service()
            submit_response = service.submit(
                AsyncRunSubmitRequest(
                    user_id=request.userId,
                    dataset_profile_id=request.datasetProfileId,
                    dataset_fingerprint=dataset_fingerprint,
                    contract_template_id=request.contractTemplateId,
                    workflow=request.workflow or "forecast_only",
                    engine_flags=request.engineFlags or {},
                    settings=request.settings or {
                        "forecast": {
                            "horizon_days": request.horizonDays,
                            "model_type": request.modelType,
                        }
                    },
                    horizon=request.horizonDays,
                    granularity="day",
                    max_attempts=request.maxAttempts,
                    workload={
                        "forecast_series": len(request.history or []),
                        **(request.workload or {}),
                    },
                ),
            )
            return submit_response.model_dump(mode="json")

        inline_history = request.history
        
        # 1. 检查缓存（仅当无 inline 数据时）
        if inline_history is None:
            primary_model = request.modelType or forecaster_factory.recommend_model(
                request.materialCode, erp_connector, request.userPreference
            ).value
            
            cached_result = await supabase_client.get_cached_prediction(
                request.materialCode, request.horizonDays, primary_model
            )
            
            if cached_result and not request.includeComparison:
                return {
                    "materialCode": request.materialCode,
                    "forecast": {
                        "model": primary_model.upper(),
                        "median": cached_result["prediction"]["predictedDemand"],
                        "confidence_interval": cached_result["prediction"]["confidenceInterval"],
                        "risk_score": cached_result["prediction"].get("riskScore", 50.0)
                    },
                    "cached": True,
                    "cacheTime": cached_result["created_at"],
                    "forecast_contract_version": FORECAST_API_CONTRACT_VERSION,
                }
        
        # 2. PR-E: Try PROD pointer first, then PR-B champion, then fallback
        result = forecaster_factory.predict_with_prod_pointer(
            request.materialCode,
            erp_connector if inline_history is None else None,
            request.horizonDays,
            inline_history=inline_history,
        )

        if result is None:
            result = forecaster_factory.predict_with_champion(
                request.materialCode,
                erp_connector if inline_history is None else None,
                request.horizonDays,
                inline_history=inline_history,
            )

        if result is None:
            result = forecaster_factory.predict_with_fallback(
                request.materialCode,
                erp_connector if inline_history is None else None,
                request.horizonDays,
                request.modelType or request.userPreference,
                inline_history=inline_history
            )

        result = _coerce_forecast_result(
            result,
            source="prod_pointer -> champion -> fallback",
        )

        if not result.get("success", False):
            return {
                "error": result.get("error", "Forecast inference failed."),
                "attempted_models": result.get("attempted_models", []),
                "errors": result.get("errors", [])
            }
        
        # 3. 格式化响应
        prediction_data = result["prediction"]
        point_predictions = prediction_data["predictions"]

        # PR-C: Generate p10/p50/p90 via QuantileEngine
        quantile_result = forecaster_factory.generate_quantiles_for_inference(
            point_forecasts=point_predictions,
            series_id=request.materialCode,
        )

        forecast = {
            "model": result["model_type"].upper(),
            "median": float(np.mean(point_predictions)),
            "confidence_interval": [
                float(np.mean([ci[0] for ci in prediction_data["confidence_interval"]])),
                float(np.mean([ci[1] for ci in prediction_data["confidence_interval"]]))
            ],
            "risk_score": float(prediction_data.get("risk_score", 50.0)),
            "model_version": prediction_data.get("model_version", "unknown"),
            "predictions": point_predictions,
            # PR-C: probabilistic quantiles
            "p10": quantile_result.p10,
            "p50": quantile_result.p50,
            "p90": quantile_result.p90,
        }

        # PR-C: uncertainty metadata (additive, non-breaking)
        uncertainty_metadata = {
            "uncertainty_method": quantile_result.uncertainty_method,
            "calibration_scope_used": quantile_result.calibration_scope,
            "calibration_passed": True,  # default; updated when gates are evaluated
            "monotonicity_fixes_applied": quantile_result.monotonicity_fixes,
        }

        base_metadata = result.get("metadata", {})
        base_metadata["uncertainty"] = uncertainty_metadata

        # PR-E: Add registry state metadata (additive, non-breaking)
        if "registry_state" in result:
            base_metadata["registry_state"] = result["registry_state"]
        else:
            inference_mode = base_metadata.get("inference_mode", "")
            if "champion" in inference_mode:
                base_metadata["registry_state"] = {"source": "champion"}
            else:
                base_metadata["registry_state"] = {"source": "fallback"}
        if "model_version_id" in result:
            base_metadata["model_version_id"] = result["model_version_id"]
        if "promotion_note" in result:
            base_metadata["promotion_note"] = result["promotion_note"]

        response = {
            "materialCode": request.materialCode,
            "forecast": forecast,
            "metadata": base_metadata,
            "cached": False
        }

        # Phase 1 – P1.3: Surface data quality report when inline history is provided
        if inline_history is not None and len(inline_history) >= 3:
            try:
                from ml.demand_forecasting.data_contract import SalesSeries, DataQualityReport
                from ml.demand_forecasting.data_validation import validate_and_clean_series
                import pandas as pd
                dates = pd.date_range(end=datetime.now().date(), periods=len(inline_history), freq="D")
                series = SalesSeries(
                    sku=request.materialCode,
                    dates=[str(d.date()) for d in dates],
                    values=list(inline_history),
                )
                _, quality_report = validate_and_clean_series(series)
                response["data_quality"] = quality_report.to_dict()
            except Exception:
                pass  # non-critical; don't block forecast

        # 4. 添加模型比较信息
        if request.includeComparison and "comparison" in result:
            comparison = result["comparison"]
            response["comparison"] = {
                "secondary_model": comparison["secondary_model"].upper() if isinstance(comparison["secondary_model"], str) else comparison["secondary_model"],
                "secondary_prediction": float(comparison["secondary_mean"]),
                "deviation_pct": float(comparison["deviation_percentage"]),
                "agreement_level": comparison["agreement_level"]
            }
        
        # 5. 添加共识警告
        if "consensus_warning" in result and result["consensus_warning"]["warning"]:
            response["consensus_warning"] = result["consensus_warning"]
        
        # 6. 缓存主要结果（仅当非 inline 数据时）
        if inline_history is None:
            cache_prediction = {
                "predictedDemand": forecast["median"],
                "confidenceInterval": forecast["confidence_interval"],
                "riskScore": forecast["risk_score"],
                "modelVersion": forecast["model_version"]
            }
            
            await supabase_client.cache_prediction(
                request.materialCode, request.horizonDays, result["model_type"], cache_prediction
            )
            
            # 7. 保存模型历史
            await supabase_client.save_model_history(
                result["model_type"], request.materialCode, forecast["model_version"],
                {"mape": 0.12, "rmse": 25.5},
                f"models/{result['model_type']}/{request.materialCode}/v{forecast['model_version']}.pkl"
            )
        
        # 8. Wrap in forecast contract v1.0 envelope
        response["_prediction_data"] = prediction_data
        response = finalize_forecast_response(
            response,
            material_code=request.materialCode,
            horizon=request.horizonDays,
        )

        return sanitize_numpy(response)

    except Exception as e:
        return {"error": str(e)}

@app.post("/analyze-sku")
async def analyze_sku(request: ModelAnalysisRequest):
    """
    分析SKU数据特征并推荐模型
    :param request: 分析请求参数
    :return: 分析结果
    """
    try:
        analysis = forecaster_factory.analyze_data_characteristics(
            request.materialCode, erp_connector
        )
        
        if "error" in analysis:
            return {"error": analysis["error"]}
        
        # 推荐模型
        recommended_model = forecaster_factory.recommend_model(
            request.materialCode, erp_connector
        )
        
        # Chronos 适合性评估
        sales_data = erp_connector.fetch_sales_data(request.materialCode)
        chronos_suitability = chronos_trainer.validate_data_suitability(sales_data)
        
        return {
            "materialCode": request.materialCode,
            "analysis": analysis,
            "recommended_model": recommended_model.value,
            "chronos_suitability": chronos_suitability,
            "supported_models": forecaster_factory.get_supported_models()
        }
        
    except Exception as e:
        return {"error": str(e)}

@app.post("/model-status")
async def model_status(request: ModelStatusRequest):
    """
    获取所有模型的状态
    :return: 模型状态信息
    """
    try:
        status = forecaster_factory.get_model_status()
        
        # 添加模型详细信息
        model_details = {}
        for model_name, model_state in status.items():
            if model_state["available"]:
                if model_name.lower() == "chronos":
                    model_details[model_name] = chronos_trainer.get_model_info()
                elif model_name.lower() == "lightgbm":
                    model_details[model_name] = {"type": "LightGBM", "features": ["rolling_mean", "rolling_std", "is_holiday", "price_index"]}
                elif model_name.lower() == "prophet":
                    model_details[model_name] = {"type": "Prophet", "seasonality": True, "holidays": True}
        
        return {
            "models": status,
            "details": model_details,
            "factory_info": {
                "supported_models": forecaster_factory.get_supported_models(),
                "strategy_pattern": True,
                "fallback_mechanism": True
            }
        }
        
    except Exception as e:
        return {"error": str(e)}

@app.get("/health")
async def health_check():
    """
    健康检查端点
    """
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "version": "1.0.0",
        "models_available": forecaster_factory.get_supported_models()
    }


@app.post("/stress-test")
async def stress_test(request: ForecastRequest):
    """
    压力测试专用端点：返回更详细的诊断信息
    """
    try:
        if not request.history or len(request.history) < 3:
            return {"error": "压力测试需要至少 3 个数据点的 history 字段"}
        
        inline_history = request.history
        
        # 1. 数据特征分析
        analysis = forecaster_factory.analyze_data_characteristics(
            request.materialCode, inline_history=inline_history
        )
        
        # 2. 模型推荐
        recommended = forecaster_factory.recommend_model(
            request.materialCode, inline_history=inline_history
        )
        
        # 3. 执行预测
        result = forecaster_factory.predict_with_fallback(
            request.materialCode,
            erp_connector=None,
            horizon_days=request.horizonDays,
            preferred_model=request.modelType,
            inline_history=inline_history
        )

        result = _coerce_forecast_result(result, source="stress_test:fallback")

        if not result.get("success", False):
            return {
                "error": result.get("error", "Forecast inference failed."),
                "analysis": analysis,
                "recommended_model": recommended.value
            }
        
        # 4. 格式化响应
        prediction_data = result["prediction"]
        forecast = {
            "model": result["model_type"].upper() if isinstance(result["model_type"], str) else result["model_type"],
            "median": float(np.mean(prediction_data["predictions"])),
            "predictions": [float(p) for p in prediction_data["predictions"]],
            "confidence_interval": prediction_data.get("confidence_interval", []),
            "risk_score": float(prediction_data.get("risk_score", 50.0)),
            "model_version": prediction_data.get("model_version", "unknown"),
            "anomaly_detected": prediction_data.get("anomaly_detected", False)
        }
        
        response = {
            "materialCode": request.materialCode,
            "forecast": forecast,
            "data_analysis": analysis,
            "recommended_model": recommended.value,
            "metadata": result.get("metadata", {}),
            "attempted_models": result.get("attempted_models", []),
            "fallback_used": result.get("fallback_used", False)
        }
        
        if "comparison" in result:
            response["comparison"] = result["comparison"]
        
        if "consensus_warning" in result:
            response["consensus_warning"] = result["consensus_warning"]
        
        return response
        
    except Exception as e:
        return {"error": str(e)}


@app.post("/backtest")
async def backtest(request: ForecastRequest):
    """
    回測驗證端點：盲測模式驗證模型準確度
    保留最後 N 天數據不給模型看，計算預測與實際的 MAPE
    PR-C: Now also returns calibration metrics (coverage, pinball, bias) and quality gates.
    """
    try:
        if not request.history or len(request.history) < 17:
            return {"error": "回測需要至少 17 個數據點 (10 訓練 + 7 測試)"}

        test_days = request.horizonDays if request.horizonDays <= 14 else 7

        # PR-C: Use enhanced backtest with calibration metrics
        result = forecaster_factory.backtest_with_calibration(
            sku=request.materialCode,
            full_history=request.history,
            test_days=test_days,
            models=None,
        )

        # Wrap in forecast contract v1.0 envelope
        result = finalize_backtest_response(result)

        return sanitize_numpy(result)

    except Exception as e:
        return {"error": str(e)}


class ForecastSeriesPoint(BaseModel):
    sku: str
    plant_id: Optional[str] = None
    date: str
    p50: float
    p90: Optional[float] = None


class DemandForecastInput(BaseModel):
    series: List[ForecastSeriesPoint] = Field(default_factory=list)
    granularity: str = "daily"


class InventoryPoint(BaseModel):
    sku: str
    plant_id: Optional[str] = None
    as_of_date: str
    on_hand: float
    safety_stock: Optional[float] = None
    lead_time_days: Optional[float] = None


class OpenPOPoint(BaseModel):
    sku: str
    plant_id: Optional[str] = None
    eta_date: str
    qty: float


class SkuQtyConstraint(BaseModel):
    sku: str
    min_qty: Optional[float] = None
    pack_qty: Optional[float] = None
    max_qty: Optional[float] = None


class SkuUnitCostConstraint(BaseModel):
    sku: str
    unit_cost: Optional[float] = None


class BomUsagePoint(BaseModel):
    fg_sku: str
    component_sku: str
    plant_id: Optional[str] = None
    usage_qty: float
    level: Optional[int] = None
    path_count: Optional[int] = None


class PeriodCapacityPoint(BaseModel):
    date: str
    capacity: float


class MultiEchelonInput(BaseModel):
    mode: str = "off"
    max_bom_depth: Optional[int] = None
    fg_to_components_scope: Dict[str, Any] = Field(default_factory=dict)
    lot_sizing_mode: Optional[str] = None
    mapping_rules: Dict[str, Any] = Field(default_factory=dict)
    bom_explosion_used: Optional[bool] = None
    bom_explosion_reused: Optional[bool] = None
    production_capacity_per_period: Optional[float | List[PeriodCapacityPoint]] = None
    inventory_capacity_per_period: Optional[float | List[PeriodCapacityPoint]] = None
    component_stockout_penalty: Optional[float] = None


class ConstraintsInput(BaseModel):
    moq: List[SkuQtyConstraint] = Field(default_factory=list)
    pack_size: List[SkuQtyConstraint] = Field(default_factory=list)
    budget_cap: Optional[float] = None
    max_order_qty: List[SkuQtyConstraint] = Field(default_factory=list)
    unit_costs: List[SkuUnitCostConstraint] = Field(default_factory=list)
    inventory_capacity_per_period: Optional[float | List[PeriodCapacityPoint]] = None
    production_capacity_per_period: Optional[float | List[PeriodCapacityPoint]] = None


class SharedConstraintsInput(BaseModel):
    budget_cap: Optional[float] = None
    budget_mode: Optional[str] = None
    production_capacity_per_period: Optional[float | List[PeriodCapacityPoint] | Dict[str, float]] = None
    inventory_capacity_per_period: Optional[float | List[PeriodCapacityPoint] | Dict[str, float]] = None
    priority_weights: Dict[str, float] = Field(default_factory=dict)


class ItemDemandPoint(BaseModel):
    date: str
    p10: Optional[float] = None
    p50: float
    p90: Optional[float] = None


class PlanningItemInput(BaseModel):
    sku: str
    plant_id: Optional[str] = None
    priority_weight: Optional[float] = None
    service_level_weight: Optional[float] = None
    on_hand: Optional[float] = None
    safety_stock: Optional[float] = None
    lead_time_days: Optional[float] = None
    as_of_date: Optional[str] = None
    unit_cost: Optional[float] = None
    moq: Optional[float] = None
    pack_size: Optional[float] = None
    pack_qty: Optional[float] = None
    max_order_qty: Optional[float] = None
    constraints: Optional[Dict[str, Any]] = None
    costs: Optional[Dict[str, Any]] = None
    demand: List[ItemDemandPoint] = Field(default_factory=list)
    demand_series: List[ItemDemandPoint] = Field(default_factory=list)

    @model_validator(mode="after")
    def _sync_demand_aliases(self):
        # Keep both legacy keys in sync so downstream solvers can read either one.
        if self.demand and not self.demand_series:
            self.demand_series = list(self.demand)
        elif self.demand_series and not self.demand:
            self.demand = list(self.demand_series)
        return self


class SolverSettingsInput(BaseModel):
    time_limit: Optional[float] = None
    time_limit_seconds: Optional[float] = None
    seed: Optional[int] = None
    random_seed: Optional[int] = None
    workers: Optional[int] = None
    num_search_workers: Optional[int] = None
    deterministic_mode: Optional[bool] = None
    force_timeout: Optional[bool] = None
    stop_after_first_solution: Optional[bool] = None


class ObjectiveInput(BaseModel):
    optimize_for: str = "balanced"
    stockout_penalty: Optional[float] = None
    holding_cost: Optional[float] = None
    service_level_target: Optional[float] = None
    safety_stock_violation_penalty: Optional[float] = None


class RiskSignalsInput(BaseModel):
    """Risk-driven solver signals (Gap E1). All fields have no-op defaults."""
    ss_penalty_by_key: Dict[str, float] = Field(default_factory=dict)
    dual_source_keys: List[str] = Field(default_factory=list)
    dual_source_min_split_fraction: float = 0.2
    expedite_keys: List[str] = Field(default_factory=list)
    expedite_lead_time_reduction_days: int = 0
    expedite_cost_multiplier: float = 1.0


class ReplenishmentPlanRequest(BaseModel):
    model_config = {"populate_by_name": True}
    contract_version: str = PLANNING_API_CONTRACT_VERSION
    dataset_profile_id: int
    planning_horizon_days: int = 30
    demand_forecast: DemandForecastInput
    inventory: List[InventoryPoint] = Field(default_factory=list)
    open_pos: List[OpenPOPoint] = Field(default_factory=list)
    constraints: ConstraintsInput = Field(default_factory=ConstraintsInput)
    shared_constraints: SharedConstraintsInput = Field(default_factory=SharedConstraintsInput)
    objective: ObjectiveInput = Field(default_factory=ObjectiveInput)
    solver: SolverSettingsInput = Field(default_factory=SolverSettingsInput)
    multi_echelon: MultiEchelonInput = Field(default_factory=MultiEchelonInput)
    items: List[PlanningItemInput] = Field(default_factory=list)
    diagnose_mode: bool = False
    bom_usage: List[BomUsagePoint] = Field(default_factory=list)
    bom_explosion: Optional[Dict[str, Any]] = None
    async_mode: bool = Field(default=False, alias="async")
    user_id: Optional[str] = None
    dataset_fingerprint: Optional[str] = None
    contract_template_id: Optional[int] = None
    workflow: Optional[str] = None
    engine_flags: Dict[str, Any] = Field(default_factory=dict)
    settings: Dict[str, Any] = Field(default_factory=dict)
    max_attempts: Optional[int] = None
    workload: Dict[str, Any] = Field(default_factory=dict)
    risk_signals: RiskSignalsInput = Field(default_factory=RiskSignalsInput)

    @field_validator("contract_version")
    @classmethod
    def _validate_contract_version(cls, value: str) -> str:
        text = str(value or "").strip() or PLANNING_API_CONTRACT_VERSION
        if not text.startswith("1."):
            raise ValueError(
                f"Unsupported planning contract version '{text}'. Expected 1.x."
            )
        return text


class PlanCommitRequest(BaseModel):
    entity_id: str
    request_payload: Dict[str, Any] = Field(default_factory=dict)
    approval_id: str
    note: str = ""


def _parse_iso_day(value: str):
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        return datetime.strptime(raw[:10], "%Y-%m-%d").date()
    except Exception:
        return None


def _key_of(sku, plant_id):
    return (str(sku or "").strip(), str(plant_id or "").strip())


def _to_float(value, default=0.0):
    try:
        num = float(value)
    except Exception:
        return default
    if np.isnan(num) or np.isinf(num):
        return default
    return float(num)


def _build_sku_lookup(rows: List[SkuQtyConstraint], value_key: str) -> Dict[str, float]:
    lookup = {}
    for row in rows or []:
        sku = str(row.sku or "").strip()
        if not sku:
            continue
        value = getattr(row, value_key, None)
        if value is None:
            continue
        lookup[sku] = max(0.0, _to_float(value, 0.0))
    return lookup


def _parse_env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    text = str(raw).strip().lower()
    if text in {"1", "true", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "no", "n", "off"}:
        return False
    return default

def _format_plan_row(sku: str, plant_id: str, order_date, arrival_date, order_qty: float):
    return {
        "sku": sku,
        "plant_id": plant_id or None,
        "order_date": order_date.isoformat(),
        "arrival_date": arrival_date.isoformat(),
        "order_qty": float(round(max(0.0, order_qty), 6))
    }


def _deterministic_replenishment_plan(payload: ReplenishmentPlanRequest) -> Dict[str, Any]:
    t0 = datetime.now(timezone.utc)
    infeasible_reasons: List[str] = []

    # 1) Group forecast demand by SKU/plant with stable ordering.
    forecast_by_key: Dict[Tuple[str, str], List[Tuple[Any, float, Optional[float]]]] = {}
    for point in payload.demand_forecast.series or []:
        sku = str(point.sku or "").strip()
        if not sku:
            continue
        date_val = _parse_iso_day(point.date)
        if not date_val:
            continue
        key = _key_of(point.sku, point.plant_id)
        if key not in forecast_by_key:
            forecast_by_key[key] = []
        forecast_by_key[key].append((
            date_val,
            max(0.0, _to_float(point.p50, 0.0)),
            None if point.p90 is None else max(0.0, _to_float(point.p90, 0.0))
        ))

    if not forecast_by_key:
        return {
            "status": "infeasible",
            "plan": [],
            "kpis": {
                "estimated_service_level": None,
                "estimated_stockout_units": None,
                "estimated_holding_units": None,
                "estimated_total_cost": None
            },
            "solver_meta": {
                "solver": "heuristic",
                "solve_time_ms": int((datetime.now(timezone.utc) - t0).total_seconds() * 1000),
                "objective_value": None,
                "gap": None
            },
            "infeasible_reasons": ["No valid demand_forecast.series rows with SKU/date/p50 were provided."],
            "proof": {
                "objective_terms": [],
                "constraints_checked": []
            }
        }

    for key in list(forecast_by_key.keys()):
        forecast_by_key[key] = sorted(forecast_by_key[key], key=lambda row: row[0])

    # 2) Build inventory seed state (latest snapshot per SKU/plant).
    inventory_state: Dict[Tuple[str, str], Dict[str, float]] = {}
    for row in payload.inventory or []:
        key = _key_of(row.sku, row.plant_id)
        snapshot_date = _parse_iso_day(row.as_of_date)
        if not snapshot_date:
            continue
        prev = inventory_state.get(key)
        if (not prev) or (snapshot_date > prev["as_of_date"]):
            inventory_state[key] = {
                "as_of_date": snapshot_date,
                "on_hand": _to_float(row.on_hand, 0.0),
                "safety_stock": max(0.0, _to_float(row.safety_stock, 0.0)) if row.safety_stock is not None else 0.0,
                "lead_time_days": max(0.0, _to_float(row.lead_time_days, 0.0)) if row.lead_time_days is not None else 0.0
            }

    # 3) Inbound map from open POs.
    inbound_by_key_day: Dict[Tuple[str, str], Dict[Any, float]] = {}
    for po in payload.open_pos or []:
        eta_date = _parse_iso_day(po.eta_date)
        if not eta_date:
            continue
        key = _key_of(po.sku, po.plant_id)
        if key not in inbound_by_key_day:
            inbound_by_key_day[key] = {}
        inbound_by_key_day[key][eta_date] = inbound_by_key_day[key].get(eta_date, 0.0) + max(0.0, _to_float(po.qty, 0.0))

    # 4) Constraint lookup maps.
    moq_map = _build_sku_lookup(payload.constraints.moq, "min_qty")
    pack_map = _build_sku_lookup(payload.constraints.pack_size, "pack_qty")
    max_map = _build_sku_lookup(payload.constraints.max_order_qty, "max_qty")
    budget_cap = None if payload.constraints.budget_cap is None else max(0.0, _to_float(payload.constraints.budget_cap, 0.0))

    # 5) Main deterministic heuristic loop.
    horizon_days = max(1, int(payload.planning_horizon_days or 1))
    ordered_keys = sorted(forecast_by_key.keys(), key=lambda item: (item[0], item[1]))
    plan_rows: List[Dict[str, Any]] = []
    rounding_events: List[str] = []

    total_order_qty = 0.0
    total_demand = 0.0
    stockout_units = 0.0
    holding_units = 0.0

    for key in ordered_keys:
        sku, plant_id = key
        series_rows = forecast_by_key[key]
        if not series_rows:
            continue

        first_day = series_rows[0][0]
        last_day_allowed = first_day + timedelta(days=horizon_days - 1)
        filtered_rows = [row for row in series_rows if row[0] <= last_day_allowed]
        if not filtered_rows:
            continue

        inv = inventory_state.get(key, {
            "on_hand": 0.0,
            "safety_stock": 0.0,
            "lead_time_days": 0.0
        })
        on_hand = _to_float(inv.get("on_hand"), 0.0)
        safety_stock = max(0.0, _to_float(inv.get("safety_stock"), 0.0))
        lead_time_days = int(round(max(0.0, _to_float(inv.get("lead_time_days"), 0.0))))
        inbound_calendar = inbound_by_key_day.get(key, {})

        sku_moq = moq_map.get(sku, 0.0)
        sku_pack = pack_map.get(sku, 0.0)
        sku_max = max_map.get(sku, 0.0)

        for demand_day, demand_p50, _demand_p90 in filtered_rows:
            inbound_today = _to_float(inbound_calendar.get(demand_day, 0.0), 0.0)
            on_hand += inbound_today
            demand = max(0.0, _to_float(demand_p50, 0.0))
            total_demand += demand

            projected_after_demand = on_hand - demand
            needed_qty = max(0.0, safety_stock - projected_after_demand)
            raw_order_qty = needed_qty
            order_qty = raw_order_qty
            row_rounding_notes = []

            if order_qty > 0.0:
                if sku_max > 0.0 and order_qty > sku_max:
                    order_qty = sku_max
                    row_rounding_notes.append("max_order_qty_cap")

                if sku_moq > 0.0 and order_qty > 0.0 and order_qty < sku_moq:
                    order_qty = sku_moq
                    row_rounding_notes.append("moq_floor")

                if sku_pack > 1.0 and order_qty > 0.0:
                    rounded = math.ceil(order_qty / sku_pack) * sku_pack
                    if abs(rounded - order_qty) > 1e-9:
                        row_rounding_notes.append("pack_round_up")
                    order_qty = rounded

                if budget_cap is not None and order_qty > 0.0:
                    remaining_budget = budget_cap - total_order_qty
                    if remaining_budget <= 0.0:
                        order_qty = 0.0
                        infeasible_reasons.append(f"Budget cap exhausted before covering demand for {sku} ({demand_day.isoformat()}).")
                    elif order_qty > remaining_budget:
                        clipped = remaining_budget
                        if sku_pack > 1.0:
                            clipped = math.floor(clipped / sku_pack) * sku_pack
                        if sku_moq > 0.0 and 0.0 < clipped < sku_moq:
                            clipped = 0.0
                        if clipped < order_qty:
                            row_rounding_notes.append("budget_cap_clipped")
                        order_qty = max(0.0, clipped)
                        if order_qty == 0.0:
                            infeasible_reasons.append(f"Budget cap prevented ordering MOQ/pack for {sku} ({demand_day.isoformat()}).")

            if order_qty > 0.0:
                order_date = demand_day - timedelta(days=lead_time_days)
                arrival_date = demand_day
                plan_rows.append(_format_plan_row(
                    sku=sku,
                    plant_id=plant_id,
                    order_date=order_date,
                    arrival_date=arrival_date,
                    order_qty=order_qty
                ))
                total_order_qty += order_qty
                projected_after_demand += order_qty

                if row_rounding_notes:
                    rounding_events.append(
                        f"{sku}@{plant_id or 'NA'} {demand_day.isoformat()}: {', '.join(sorted(set(row_rounding_notes)))}"
                    )

            on_hand = projected_after_demand
            if on_hand < 0:
                stockout_units += abs(on_hand)
            holding_units += max(0.0, on_hand)

    stockout_penalty = _to_float(payload.objective.stockout_penalty, 1.0) if payload.objective.stockout_penalty is not None else 1.0
    holding_cost = _to_float(payload.objective.holding_cost, 0.0) if payload.objective.holding_cost is not None else 0.0
    estimated_total_cost = (total_order_qty + (stockout_penalty * stockout_units) + (holding_cost * holding_units))

    service_level = None
    if total_demand > 0.0:
        service_level = max(0.0, min(1.0, 1.0 - (stockout_units / total_demand)))

    # 6) Deterministic proof + constraint checks.
    moq_failed = 0
    pack_failed = 0
    max_failed = 0
    non_negative_failed = 0
    for row in plan_rows:
        sku = row["sku"]
        qty = _to_float(row["order_qty"], 0.0)
        if qty < -1e-9:
            non_negative_failed += 1
        sku_moq = moq_map.get(sku, 0.0)
        if sku_moq > 0.0 and qty > 0.0 and qty + 1e-9 < sku_moq:
            moq_failed += 1
        sku_pack = pack_map.get(sku, 0.0)
        if sku_pack > 1.0 and qty > 0.0:
            ratio = qty / sku_pack
            if abs(ratio - round(ratio)) > 1e-6:
                pack_failed += 1
        sku_max = max_map.get(sku, 0.0)
        if sku_max > 0.0 and qty - sku_max > 1e-9:
            max_failed += 1

    budget_passed = True
    budget_details = "No budget cap provided."
    if budget_cap is not None:
        budget_passed = total_order_qty <= budget_cap + 1e-9
        budget_details = f"Total ordered qty {round(total_order_qty, 6)} vs cap {round(budget_cap, 6)}."
        if not budget_passed:
            infeasible_reasons.append("Total planned quantity exceeds configured budget cap.")

    constraints_checked = [
        {
            "name": "order_qty_non_negative",
            "passed": non_negative_failed == 0,
            "details": f"Negative quantity rows: {non_negative_failed}."
        },
        {
            "name": "moq",
            "passed": moq_failed == 0,
            "details": f"Rows violating MOQ: {moq_failed}."
        },
        {
            "name": "pack_size_multiple",
            "passed": pack_failed == 0,
            "details": f"Rows violating pack-size multiple: {pack_failed}."
        },
        {
            "name": "budget_cap",
            "passed": budget_passed,
            "details": budget_details
        },
        {
            "name": "max_order_qty",
            "passed": max_failed == 0,
            "details": f"Rows violating max_order_qty: {max_failed}."
        }
    ]

    if not plan_rows and total_demand > 0.0:
        infeasible_reasons.append("No replenishment orders were generated for non-zero demand horizon.")

    if rounding_events:
        infeasible_reasons.append(f"Rounding adjustments applied: {len(rounding_events)} events.")

    unique_reasons = sorted(set(reason for reason in infeasible_reasons if reason))
    all_constraints_passed = all(item["passed"] for item in constraints_checked)
    if not plan_rows and total_demand > 0.0:
        status = "infeasible"
    elif all_constraints_passed and len(unique_reasons) == 0:
        status = "optimal"
    else:
        status = "feasible"

    solve_time_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)

    response = {
        "status": status,
        "plan": plan_rows,
        "kpis": {
            "estimated_service_level": None if service_level is None else float(round(service_level, 6)),
            "estimated_stockout_units": float(round(stockout_units, 6)),
            "estimated_holding_units": float(round(holding_units, 6)),
            "estimated_total_cost": float(round(estimated_total_cost, 6))
        },
        "solver_meta": {
            "solver": "heuristic",
            "solve_time_ms": solve_time_ms,
            "objective_value": float(round(estimated_total_cost, 6)),
            "gap": 0.0
        },
        "infeasible_reasons": unique_reasons,
        "proof": {
            "objective_terms": [
                {"name": "ordered_units", "value": float(round(total_order_qty, 6)), "note": "Total planned replenishment quantity."},
                {"name": "stockout_units", "value": float(round(stockout_units, 6)), "note": "Projected unmet demand units."},
                {"name": "holding_units", "value": float(round(holding_units, 6)), "note": "Projected positive inventory accumulation."},
                {"name": "estimated_total_cost", "value": float(round(estimated_total_cost, 6)), "note": "Heuristic cost proxy from order + penalties."}
            ],
            "constraints_checked": constraints_checked
        }
    }
    if rounding_events:
        response["proof"]["constraints_checked"].append({
            "name": "rounding_adjustments",
            "passed": True,
            "details": "; ".join(rounding_events[:25])
        })
    return response

@app.post("/replenishment-plan")
async def replenishment_plan(request: ReplenishmentPlanRequest, raw_request: Request = None):
    """
    Deterministic replenishment planner (heuristic baseline).
    Returns a stable response schema for chat workflow integration.
    """
    # Tenant enforcement
    if raw_request:
        _require_tenant_id(raw_request)

    # Concurrency guard: limit simultaneous solver requests
    acquired = await acquire_solver_slot(timeout=30.0)
    if not acquired:
        raise HTTPException(
            status_code=503,
            detail=f"Server busy: {_SOLVER_MAX_CONCURRENT} concurrent solver requests already running. Please retry.",
        )
    try:
        return await _replenishment_plan_inner(request)
    finally:
        release_solver_slot()


async def _replenishment_plan_inner(request: ReplenishmentPlanRequest):
    telemetry_run_id: Optional[str] = None
    planning_payload: Dict[str, Any] = {}
    try:
        if _request_async_enabled(request):
            if not request.user_id:
                raise HTTPException(status_code=400, detail="user_id is required when async mode is enabled")
            dataset_fingerprint = request.dataset_fingerprint or f"profile:{request.dataset_profile_id}"
            planning_request_payload = request.model_dump(mode="json", by_alias=True)
            planning_request_payload["async"] = False
            planning_request_payload["async_mode"] = False
            merged_settings = dict(request.settings or {})
            merged_settings.setdefault("solver", request.objective.model_dump(mode="json"))
            merged_settings.setdefault("constraints", request.constraints.model_dump(mode="json"))
            merged_settings["planning_request"] = planning_request_payload
            item_skus = {
                str(item.sku)
                for item in (request.items or [])
                if getattr(item, "sku", None)
            }
            demand_skus = {
                str(point.sku)
                for point in (request.demand_forecast.series or [])
                if point.sku
            }
            forecast_series_count = len(request.demand_forecast.series or []) + sum(
                len(item.demand_series or [])
                for item in (request.items or [])
            )
            service = get_async_run_service()
            submit_response = service.submit(
                AsyncRunSubmitRequest(
                    user_id=request.user_id,
                    dataset_profile_id=request.dataset_profile_id,
                    dataset_fingerprint=dataset_fingerprint,
                    contract_template_id=request.contract_template_id,
                    workflow=request.workflow or "workflow_A_replenishment",
                    engine_flags={
                        **(request.engine_flags or {}),
                        "planning_async": True,
                    },
                    settings=merged_settings,
                    horizon=request.planning_horizon_days,
                    granularity=request.demand_forecast.granularity,
                    max_attempts=request.max_attempts,
                    workload={
                        "forecast_series": forecast_series_count,
                        "skus": len(demand_skus | item_skus),
                        **(request.workload or {}),
                    },
                ),
            )
            return submit_response.model_dump(mode="json")

        planning_payload = request.model_dump(mode="json", by_alias=True)
        request_payload_hash = canonical_payload_hash(planning_payload)
        telemetry_store = get_solver_telemetry_store()
        telemetry_run_id = new_telemetry_run_id("sync")
        engine_hint = select_solver_engine(request).selected_engine
        objective_hint = extract_objective(planning_payload) or str(request.objective.optimize_for or "balanced")
        contract_version = extract_contract_version(planning_payload, fallback=request.contract_version)

        emit_solver_telemetry_event(
            telemetry_store,
            telemetry_run_id=telemetry_run_id,
            event_type="started",
            source="sync",
            planning_payload=planning_payload,
            status=None,
            termination_reason=None,
            engine=engine_hint,
            objective=objective_hint,
            solve_time_ms=None,
            queue_wait_ms=0,
            contract_version=contract_version,
            metadata={},
        )

        result = solve_planning_contract(request)
        normalized_result = sanitize_numpy(result)
        if isinstance(normalized_result, dict):
            normalized_result["governance"] = {
                "plan_request_hash": request_payload_hash,
                "commit_requires_approved_plan": True,
                "approval_action_type": "APPROVE_PLAN",
            }
        status_value = extract_status(normalized_result, fallback="ERROR")
        termination_reason = extract_termination_reason(normalized_result, fallback="UNKNOWN")
        final_engine = extract_engine(normalized_result, planning_payload, fallback=engine_hint)
        final_objective = extract_objective(planning_payload, normalized_result) or objective_hint
        solve_time_ms = extract_solve_time_ms(normalized_result, fallback=None)

        emit_solver_telemetry_event(
            telemetry_store,
            telemetry_run_id=telemetry_run_id,
            event_type="finished",
            source="sync",
            planning_payload=planning_payload,
            planning_result=normalized_result if isinstance(normalized_result, dict) else {},
            status=status_value,
            termination_reason=termination_reason,
            engine=final_engine,
            objective=final_objective,
            solve_time_ms=solve_time_ms,
            queue_wait_ms=0,
            contract_version=contract_version,
            metadata={},
        )
        emit_solver_telemetry_event(
            telemetry_store,
            telemetry_run_id=telemetry_run_id,
            event_type="summary",
            source="sync",
            planning_payload=planning_payload,
            planning_result=normalized_result if isinstance(normalized_result, dict) else {},
            status=status_value,
            termination_reason=termination_reason,
            engine=final_engine,
            objective=final_objective,
            solve_time_ms=solve_time_ms,
            queue_wait_ms=0,
            contract_version=contract_version,
            metadata={},
        )
        return normalized_result
    except Exception as e:
        fallback_engine = select_solver_engine(request).selected_engine
        safe_hash = hashlib.sha256(str(e).encode("utf-8")).hexdigest()
        if telemetry_run_id is not None:
            telemetry_store = get_solver_telemetry_store()
            emit_solver_telemetry_event(
                telemetry_store,
                telemetry_run_id=telemetry_run_id,
                event_type="finished",
                source="sync",
                planning_payload=planning_payload,
                status="ERROR",
                termination_reason="EXCEPTION",
                engine=fallback_engine,
                objective=extract_objective(planning_payload) if isinstance(planning_payload, dict) else None,
                solve_time_ms=0,
                queue_wait_ms=0,
                contract_version=extract_contract_version(planning_payload, fallback=None)
                if isinstance(planning_payload, dict)
                else None,
                metadata={"error_hash": safe_hash},
            )
            emit_solver_telemetry_event(
                telemetry_store,
                telemetry_run_id=telemetry_run_id,
                event_type="summary",
                source="sync",
                planning_payload=planning_payload,
                status="ERROR",
                termination_reason="EXCEPTION",
                engine=fallback_engine,
                objective=extract_objective(planning_payload) if isinstance(planning_payload, dict) else None,
                solve_time_ms=0,
                queue_wait_ms=0,
                contract_version=extract_contract_version(planning_payload, fallback=None)
                if isinstance(planning_payload, dict)
                else None,
                metadata={"error_hash": safe_hash},
            )
        return build_contract_error_response(
            engine=fallback_engine,
            reason=str(e),
            solve_time_ms=0,
        )


@app.post("/replenishment-plan/commit")
async def commit_replenishment_plan(payload: PlanCommitRequest, raw_request: Request):
    actor = _require_action_role(raw_request, GovernanceAction.COMMIT_PLAN)
    store = _get_governance_store()
    request_payload_hash = canonical_payload_hash(payload.request_payload or {})

    try:
        store.assert_approved(
            approval_id=payload.approval_id,
            action_type="APPROVE_PLAN",
            payload_hash=request_payload_hash,
        )
    except ApprovalError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    commit_record = store.record_plan_commit(
        entity_id=payload.entity_id,
        payload_hash=request_payload_hash,
        committed_by=actor.actor_id,
        approval_id=payload.approval_id,
        note=payload.note,
    )

    audit_event = store.append_audit_event(
        action_type="APPROVE_PLAN",
        actor=actor.actor_id,
        entity_id=payload.entity_id,
        before_pointer={"commit": None},
        after_pointer={"commit_id": commit_record.get("commit_id")},
        note=payload.note,
        metadata={
            "stage": "commit",
            "approval_id": payload.approval_id,
            "payload_hash": request_payload_hash,
        },
    )

    return {
        "committed": True,
        "commit": commit_record,
        "audit_event_id": audit_event.get("event_id"),
    }


class TrainRequest(BaseModel):
    modelType: str = "lightgbm"       # "lightgbm" | "prophet" | "all"
    days: int = 365
    seed: int = 42
    mape_gate: float = 20.0
    history: Optional[List[float]] = None
    historyStartDate: Optional[str] = None
    historyEndDate: Optional[str] = None
    use_optuna: bool = True            # Task 2: 是否啟用 Optuna 自動調參
    optuna_trials: int = 30            # Optuna 試驗次數


@app.post("/train-model")
async def train_model(request: TrainRequest):
    """
    統一訓練管道 — 支援 LightGBM / Prophet / All
    ─────────────────────────────────────────────
    Task 1: Prophet 真實訓練 (model_to_json)
    Task 2: Optuna 自動調參 (LightGBM)
    Task 4: 數據漂移檢測 (μ±3σ)
    """
    import time
    t0 = time.time()

    # Phase 1 – P1.5: Import boundary gate (schema validation)
    from ml.demand_forecasting.dataset_schema import validate_train_payload
    schema_errors = validate_train_payload({
        "modelType": request.modelType,
        "days": request.days,
        "seed": request.seed,
        "mape_gate": request.mape_gate,
        "history": request.history,
        "historyStartDate": request.historyStartDate,
        "historyEndDate": request.historyEndDate,
    })
    if schema_errors:
        return JSONResponse(
            status_code=422,
            content={"errors": schema_errors, "message": "Schema validation failed"},
        )

    model_type = request.modelType.lower()
    if model_type not in ("lightgbm", "prophet", "all"):
        return {"error": f"支援 lightgbm / prophet / all，收到: {request.modelType}"}

    try:
        import pandas as pd
        from ml.demand_forecasting.feature_engineer import FeatureEngineer, FEATURE_COLUMNS

        fe = FeatureEngineer()
        model_dir = os.path.join(os.path.dirname(__file__), '..', 'models')
        os.makedirs(model_dir, exist_ok=True)

        history_start = _parse_iso_day(request.historyStartDate) if request.historyStartDate else None
        history_end = _parse_iso_day(request.historyEndDate) if request.historyEndDate else None
        if request.historyStartDate and history_start is None:
            return {"error": f"historyStartDate must be YYYY-MM-DD, got: {request.historyStartDate}"}
        if request.historyEndDate and history_end is None:
            return {"error": f"historyEndDate must be YYYY-MM-DD, got: {request.historyEndDate}"}
        if history_start and history_end and history_end < history_start:
            return {"error": "historyEndDate must be on or after historyStartDate"}

        def _build_training_dates(periods: int):
            if history_start is not None:
                return pd.date_range(start=history_start.isoformat(), periods=periods, freq='D')
            anchor_end = history_end or datetime.now(timezone.utc).date()
            return pd.date_range(end=anchor_end.isoformat(), periods=periods, freq='D')

        # ══════════════════════════════════════════════
        # 0. 準備數據（共用）
        # ══════════════════════════════════════════════
        if request.history and len(request.history) >= 60:
            dates = _build_training_dates(len(request.history))
            df = pd.DataFrame({'date': dates, 'sales': request.history})
        else:
            np.random.seed(request.seed)
            days = request.days
            dates = _build_training_dates(days)
            base = 50
            trend = np.arange(days) * 0.02
            weekly = 5 * np.sin(2 * np.pi * np.arange(days) / 7)
            monthly = 8 * np.sin(2 * np.pi * np.arange(days) / 30)
            yearly = 12 * np.sin(2 * np.pi * (np.arange(days) - 90) / 365)
            noise = np.random.normal(0, 4, days)
            promos = np.zeros(days)
            for i in range(0, days, 60):
                if i + 3 < days:
                    promos[i:i + 3] = 20
            sales = np.maximum(base + trend + weekly + monthly + yearly + noise + promos, 0).round(1)
            df = pd.DataFrame({'date': dates, 'sales': sales})

        # ── Task 4: 計算訓練數據統計基線 (用於 Drift Detection) ──
        training_stats = {
            "mean": float(df['sales'].mean()),
            "std": float(df['sales'].std()),
            "n": len(df),
            "computed_at": datetime.now().isoformat()
        }

        # Phase 1 – P1.3: Compute data quality report for training data
        _data_quality = None
        try:
            from ml.demand_forecasting.data_contract import SalesSeries
            from ml.demand_forecasting.data_validation import validate_and_clean_series
            _train_series = SalesSeries(
                sku="train",
                dates=[str(d.date()) for d in df['date']],
                values=df['sales'].tolist(),
            )
            _, _train_quality = validate_and_clean_series(_train_series)
            _data_quality = _train_quality.to_dict()
        except Exception:
            pass  # non-critical

        deploy_results = {}

        # ══════════════════════════════════════════════
        # A. LightGBM 訓練 + Optuna
        # ══════════════════════════════════════════════
        if model_type in ("lightgbm", "all"):
            lgbm_result = _train_lightgbm(
                df, fe, model_dir, request, training_stats
            )
            deploy_results["lightgbm"] = lgbm_result

        # ══════════════════════════════════════════════
        # B. Prophet 訓練
        # ══════════════════════════════════════════════
        if model_type in ("prophet", "all"):
            prophet_result = _train_prophet(df, model_dir, request, training_stats)
            deploy_results["prophet"] = prophet_result

        elapsed = time.time() - t0

        # 統一回應
        deployed = [k for k, v in deploy_results.items() if v.get("status") == "deployed"]
        rejected = [k for k, v in deploy_results.items() if v.get("status") == "rejected"]

        train_response = {
            "status": "deployed" if deployed else "rejected",
            "deployed_models": deployed,
            "rejected_models": rejected,
            "results": deploy_results,
            "training_stats_baseline": training_stats,
            "training_window": {
                "start_date": str(df['date'].min().date()),
                "end_date": str(df['date'].max().date()),
            },
            "elapsed_seconds": round(elapsed, 2),
            "message": f"✅ 已完成: {', '.join(deployed) if deployed else '無模型通過閘門'}"
        }
        if _data_quality is not None:
            train_response["data_quality"] = _data_quality
        return train_response

    except Exception as e:
        import traceback
        return {"error": str(e), "traceback": traceback.format_exc()}


def _train_lightgbm(df, fe, model_dir, request, training_stats):
    """LightGBM 訓練 (含 Optuna 自動調參)"""
    from ml.demand_forecasting.feature_engineer import FEATURE_COLUMNS
    try:
        import lightgbm as lgb
        import joblib as jl
        from sklearn.metrics import mean_absolute_percentage_error
    except ImportError as ie:
        return {"status": "error", "error": f"缺少套件: {ie}"}

    X, y = fe.create_training_data(df, min_rows=30)
    split_idx = int(len(X) * 0.85)
    X_train, X_val = X.iloc[:split_idx], X.iloc[split_idx:]
    y_train, y_val = y.iloc[:split_idx], y.iloc[split_idx:]

    train_data = lgb.Dataset(X_train, label=y_train, feature_name=FEATURE_COLUMNS)
    val_data = lgb.Dataset(X_val, label=y_val, reference=train_data)

    optuna_info = None

    # ── Optuna HPO via shared module ──
    best_params = {
        'boosting_type': 'gbdt', 'objective': 'regression', 'metric': 'mape',
        'num_leaves': 31, 'learning_rate': 0.05, 'feature_fraction': 0.9,
        'bagging_fraction': 0.8, 'bagging_freq': 5, 'verbose': -1,
    }

    if request.use_optuna:
        try:
            from ml.training.hpo import HPOConfig, run_hpo
            from ml.training.dataset_builder import DatasetBundle

            mini_bundle = DatasetBundle(
                series_id="legacy_train",
                frequency="D",
                horizon=30,
                train_df=X_train,
                val_df=X_val,
                test_df=None,
                X_train=X_train,
                y_train=y_train,
                X_val=X_val,
                y_val=y_val,
                feature_columns=list(FEATURE_COLUMNS),
            )

            hpo_cfg = HPOConfig(
                enabled=True,
                n_trials=request.optuna_trials,
                cv_mode="holdout",
                seed=request.seed,
            )

            hpo_result = run_hpo(mini_bundle, hpo_cfg)
            best_params = {
                'boosting_type': 'gbdt', 'objective': 'regression', 'metric': 'mape',
                'verbose': -1, **hpo_result.best_params,
            }
            optuna_info = {
                "best_mape": round(hpo_result.best_score, 2),
                "best_params": hpo_result.to_dict()["best_params"],
                "n_trials": hpo_result.n_trials_completed,
            }
        except ImportError:
            optuna_info = {"skipped": True, "reason": "optuna not installed"}
        except Exception as e:
            optuna_info = {"skipped": True, "reason": str(e)}

    # 用最佳參數正式訓練
    model = lgb.train(
        best_params, train_data,
        valid_sets=[train_data, val_data], valid_names=['train', 'valid'],
        num_boost_round=1000,
        callbacks=[lgb.early_stopping(50), lgb.log_evaluation(0)],
    )

    y_pred_val = model.predict(X_val)
    val_mape = mean_absolute_percentage_error(y_val, y_pred_val) * 100

    # MAPE 閘門
    if val_mape > request.mape_gate:
        return {
            "status": "rejected",
            "reason": f"MAPE {val_mape:.2f}% > 閘門 {request.mape_gate}%",
            "val_mape": round(val_mape, 2),
            "optuna": optuna_info,
        }

    # 保存模型
    model_path = os.path.join(model_dir, 'lgbm_model.pkl')
    meta_path = os.path.join(model_dir, 'lgbm_meta.json')
    jl.dump(model, model_path)

    feat_imp = dict(zip(FEATURE_COLUMNS, [int(x) for x in model.feature_importance(importance_type='gain')]))
    meta = {
        'val_mape': round(val_mape, 2),
        'best_iteration': model.best_iteration,
        'train_samples': len(X_train),
        'val_samples': len(X_val),
        'num_features': len(FEATURE_COLUMNS),
        'feature_importance': feat_imp,
        'training_stats': training_stats,
        'optuna': optuna_info,
        'params_used': {k: round(v, 6) if isinstance(v, float) else v for k, v in best_params.items() if k != 'verbose'},
        'trained_at': datetime.now().isoformat(),
    }
    with open(meta_path, 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    # Hot-reload
    lgbm_strategy = forecaster_factory.get_strategy(ModelType.LIGHTGBM)
    if hasattr(lgbm_strategy, 'reload_model'):
        lgbm_strategy.reload_model()

    grade = "A+" if val_mape < 10 else "A" if val_mape < 20 else "B"
    return {
        "status": "deployed",
        "val_mape": round(val_mape, 2),
        "grade": grade,
        "best_iteration": model.best_iteration,
        "train_samples": len(X_train),
        "val_samples": len(X_val),
        "feature_importance_top5": dict(sorted(feat_imp.items(), key=lambda x: x[1], reverse=True)[:5]),
        "optuna": optuna_info,
        "model_path": model_path,
    }


def _train_prophet(df, model_dir, request, training_stats):
    """Task 1: Prophet 真實訓練 + model_to_json 序列化"""
    import pandas as pd
    try:
        from prophet import Prophet
        from prophet.serialize import model_to_json
    except ImportError as ie:
        return {"status": "error", "error": f"缺少套件: {ie}"}

    # Prophet 需要 ds, y 格式
    prophet_df = df.rename(columns={'date': 'ds', 'sales': 'y'}).copy()
    prophet_df['ds'] = pd.to_datetime(prophet_df['ds'])

    # 時序分割
    split_idx = int(len(prophet_df) * 0.85)
    train_df = prophet_df.iloc[:split_idx]
    val_df = prophet_df.iloc[split_idx:]

    # 訓練 Prophet
    m = Prophet(
        yearly_seasonality=True,
        weekly_seasonality=True,
        daily_seasonality=False,
        changepoint_prior_scale=0.05,
    )
    try:
        m.fit(train_df)
    except RuntimeError as e:
        return {
            "status": "error",
            "error": f"Prophet Stan 後端執行失敗 (常見於 Windows): {str(e)[:200]}",
            "hint": "建議在 Linux/Docker 環境中訓練 Prophet，或安裝 cmdstan: python -m cmdstanpy.install_cmdstan"
        }

    # 驗證
    future = m.make_future_dataframe(periods=len(val_df))
    forecast = m.predict(future)
    val_forecast = forecast.tail(len(val_df))
    y_pred = val_forecast['yhat'].values
    y_true = val_df['y'].values

    mask = y_true != 0
    if mask.any():
        val_mape = float(np.mean(np.abs((y_true[mask] - y_pred[mask]) / y_true[mask])) * 100)
    else:
        val_mape = 999.0

    # MAPE 閘門
    if val_mape > request.mape_gate:
        return {
            "status": "rejected",
            "reason": f"MAPE {val_mape:.2f}% > 閘門 {request.mape_gate}%",
            "val_mape": round(val_mape, 2),
        }

    # 用全量數據重新訓練（通過閘門後）
    m_full = Prophet(
        yearly_seasonality=True,
        weekly_seasonality=True,
        daily_seasonality=False,
        changepoint_prior_scale=0.05,
    )
    m_full.fit(prophet_df)

    # 保存為 JSON
    model_path = os.path.join(model_dir, 'prophet_model.json')
    meta_path = os.path.join(model_dir, 'prophet_meta.json')

    with open(model_path, 'w', encoding='utf-8') as f:
        f.write(model_to_json(m_full))

    meta = {
        'val_mape': round(val_mape, 2),
        'train_samples': len(train_df),
        'val_samples': len(val_df),
        'full_retrain_samples': len(prophet_df),
        'training_stats': training_stats,
        'trained_at': datetime.now().isoformat(),
    }
    with open(meta_path, 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    # Hot-reload
    prophet_strategy = forecaster_factory.get_strategy(ModelType.PROPHET)
    if hasattr(prophet_strategy, 'reload_model'):
        prophet_strategy.reload_model()

    grade = "A+" if val_mape < 10 else "A" if val_mape < 20 else "B"
    return {
        "status": "deployed",
        "val_mape": round(val_mape, 2),
        "grade": grade,
        "train_samples": len(train_df),
        "val_samples": len(val_df),
        "model_path": model_path,
    }


# ══════════════════════════════════════════════════
# Task 3: 模型可解釋性 API (Feature Importance)
# ══════════════════════════════════════════════════

class ExplainRequest(BaseModel):
    materialCode: str = "EXPLAIN"
    history: Optional[List[float]] = None
    horizonDays: int = 7


@app.post("/feature-importance")
async def feature_importance(request: ExplainRequest):
    """
    Task 3: AI 說人話 — 模型可解釋性
    回傳 LightGBM 特徵重要性 + 自然語言解釋
    """
    try:
        # 1. 讀取模型元數據
        meta_path = os.path.join(os.path.dirname(__file__), '..', 'models', 'lgbm_meta.json')
        if not os.path.exists(meta_path):
            return {"error": "尚未訓練 LightGBM 模型，請先呼叫 /train-model"}

        with open(meta_path, 'r', encoding='utf-8') as f:
            meta = json.load(f)

        feat_imp = meta.get('feature_importance', {})
        if not feat_imp:
            return {"error": "模型元數據中無特徵重要性資訊"}

        # 2. Check for SHAP values (prefer SHAP over gain-based importance)
        shap_imp = meta.get('shap_importance', {})
        importance_method = "shap" if shap_imp else "gain"
        active_imp = shap_imp if shap_imp else feat_imp

        # 3. 排序 & 計算百分比
        total_value = sum(active_imp.values()) or 1
        sorted_feats = sorted(active_imp.items(), key=lambda x: x[1], reverse=True)

        features = []
        for feat_name, value in sorted_feats:
            pct = round(value / total_value * 100, 1)
            features.append({
                "feature": feat_name,
                "importance_value": value,
                "importance_pct": pct,
                "importance_method": importance_method,
                "explanation": _explain_feature(feat_name, pct),
            })

        # 4. 生成整體摘要
        top3 = features[:3]
        method_label = "SHAP" if importance_method == "shap" else "Gain"
        summary = (
            f"模型預測主要依據 ({method_label}): "
            f"{top3[0]['feature']}({top3[0]['importance_pct']}%), "
            f"{top3[1]['feature']}({top3[1]['importance_pct']}%), "
            f"{top3[2]['feature']}({top3[2]['importance_pct']}%)"
        ) if len(top3) >= 3 else "特徵不足"

        # 5. Optuna 調參資訊
        optuna_info = meta.get('optuna', None)

        return {
            "success": True,
            "features": features,
            "summary": summary,
            "importance_method": importance_method,
            "shap_sample_size": meta.get('shap_sample_size'),
            "model_mape": meta.get('val_mape'),
            "trained_at": meta.get('trained_at'),
            "optuna": optuna_info,
            "params_used": meta.get('params_used'),
            "total_features": len(features),
        }

    except Exception as e:
        return {"error": str(e)}


def _explain_feature(feat_name: str, pct: float) -> str:
    """將特徵名轉成人類可讀的解釋"""
    explanations = {
        'ewm_7': f"近 7 天指數加權均值貢獻了 {pct}% — 模型非常重視近期銷售趨勢",
        'lag_1': f"昨日銷量貢獻了 {pct}% — 短期自回歸效應顯著",
        'lag_7': f"上週同日銷量貢獻了 {pct}% — 週循環模式明確",
        'lag_14': f"兩週前銷量貢獻了 {pct}% — 中期趨勢參考",
        'lag_30': f"月前銷量貢獻了 {pct}% — 月度季節性參考",
        'rolling_mean_7': f"7天移動均值貢獻了 {pct}% — 短期平滑趨勢重要",
        'rolling_std_7': f"7天波動率貢獻了 {pct}% — 近期不確定性指標",
        'rolling_mean_14': f"14天移動均值貢獻了 {pct}% — 中期趨勢",
        'rolling_std_14': f"14天波動率貢獻了 {pct}%",
        'rolling_mean_30': f"30天移動均值貢獻了 {pct}% — 長期基線水準",
        'day_of_week': f"星期幾貢獻了 {pct}% — 週循環效應",
        'day_of_month': f"每月第幾天貢獻了 {pct}% — 月內節奏",
        'month': f"月份貢獻了 {pct}% — 年度季節性",
        'week_of_year': f"年內第幾週貢獻了 {pct}%",
        'month_sin': f"月份正弦編碼貢獻了 {pct}% — 年度週期性",
        'month_cos': f"月份餘弦編碼貢獻了 {pct}%",
        'dow_sin': f"星期正弦編碼貢獻了 {pct}% — 週期性",
        'dow_cos': f"星期餘弦編碼貢獻了 {pct}%",
        'is_holiday': f"節假日標記貢獻了 {pct}% — 節假日效應",
    }
    return explanations.get(feat_name, f"{feat_name} 貢獻了 {pct}%")


# ══════════════════════════════════════════════════
# Task 4: 數據漂移檢測 (Drift Detection μ±3σ)
# ══════════════════════════════════════════════════

class DriftCheckRequest(BaseModel):
    history: List[float]
    window: int = 30     # 用最近 N 天檢測


@app.post("/drift-check")
async def drift_check(request: DriftCheckRequest):
    """
    Task 4: MLOps 數據漂移檢測
    比較當前數據分佈 vs 訓練時基線 (μ±3σ)
    """
    try:
        # 1. 載入訓練基線
        meta_path = os.path.join(os.path.dirname(__file__), '..', 'models', 'lgbm_meta.json')
        if not os.path.exists(meta_path):
            return {"error": "尚未訓練模型，無法檢測漂移"}

        with open(meta_path, 'r', encoding='utf-8') as f:
            meta = json.load(f)

        baseline = meta.get('training_stats', {})
        train_mean = baseline.get('mean')
        train_std = baseline.get('std')

        if train_mean is None or train_std is None:
            return {"error": "訓練元數據中無統計基線（請重新訓練）"}

        # 2. 計算當前窗口統計
        recent = request.history[-request.window:] if len(request.history) >= request.window else request.history
        current_mean = float(np.mean(recent))
        current_std = float(np.std(recent))

        # 3. μ±3σ 漂移檢測
        drift_threshold = 3 * train_std
        upper_bound = train_mean + drift_threshold
        lower_bound = train_mean - drift_threshold
        z_score = abs(current_mean - train_mean) / (train_std + 1e-8)

        is_drifted = current_mean > upper_bound or current_mean < lower_bound

        # 4. 額外指標：標準差漂移
        std_ratio = current_std / (train_std + 1e-8)
        std_drifted = std_ratio > 2.0 or std_ratio < 0.3

        # 5. 綜合判定
        drift_level = "none"
        if is_drifted and std_drifted:
            drift_level = "critical"
        elif is_drifted:
            drift_level = "warning"
        elif std_drifted:
            drift_level = "notice"

        return {
            "success": True,
            "drift_detected": is_drifted,
            "drift_level": drift_level,
            "details": {
                "training_baseline": {
                    "mean": round(train_mean, 2),
                    "std": round(train_std, 2),
                    "upper_3sigma": round(upper_bound, 2),
                    "lower_3sigma": round(lower_bound, 2),
                },
                "current_window": {
                    "mean": round(current_mean, 2),
                    "std": round(current_std, 2),
                    "window_days": len(recent),
                },
                "z_score": round(z_score, 2),
                "std_ratio": round(std_ratio, 2),
            },
            "message": _drift_message(drift_level, current_mean, train_mean, z_score),
            "recommendation": _drift_recommendation(drift_level),
        }

    except Exception as e:
        return {"error": str(e)}


def _drift_message(level: str, current: float, baseline: float, z: float) -> str:
    if level == "critical":
        return f"⛔ 嚴重漂移: 當前均值 {current:.1f} 偏離訓練基線 {baseline:.1f} 達 {z:.1f}σ，且波動率異常"
    elif level == "warning":
        return f"⚠️ 數據漂移: 當前均值 {current:.1f} 偏離訓練基線 {baseline:.1f} 達 {z:.1f}σ (>3σ)"
    elif level == "notice":
        return f"📝 波動率變化: 均值正常但數據波動率顯著改變"
    return f"✅ 數據分佈穩定: 當前均值 {current:.1f} 在訓練基線 {baseline:.1f} ± 3σ 範圍內"


def _drift_recommendation(level: str) -> str:
    if level == "critical":
        return "建議立即重新訓練模型並檢查數據源是否異常"
    elif level == "warning":
        return "建議排程重新訓練，並持續監控。可能是市場結構性變化"
    elif level == "notice":
        return "暫不需要重訓，但建議加入安全庫存緩衝"
    return "模型運作正常，無需操作"


# ══════════════════════════════════════════════════════════════
# Digital Twin — Supply Chain Simulation Sandbox
# ══════════════════════════════════════════════════════════════

from ml.simulation.scenarios import list_scenarios, get_scenario
from ml.simulation.orchestrator import SimulationOrchestrator, SimulationResult
from ml.simulation.optimizer import ParameterOptimizer
from ml.simulation.data_generator import DataGenerator, DemandProfile
from ml.simulation.inventory_sim import InventoryConfig


class SimulationRequest(BaseModel):
    scenario: str = "normal"                   # normal | volatile | disaster | seasonal
    seed: int = 42
    duration_days: Optional[int] = None        # 覆寫情境預設天數
    use_forecaster: bool = False               # True = 用 Decision-Intelligence 預測, False = naive baseline
    forecast_interval: int = 7                 # 每 N 天跑一次預測
    chaos_intensity: Optional[str] = None      # 覆寫混沌強度


class OptimizeRequest(BaseModel):
    scenario: str = "normal"
    seed: int = 42
    n_trials: int = 30
    method: str = "random"                     # random | grid
    min_fill_rate: float = 0.95
    use_forecaster: bool = False


class GenerateDataRequest(BaseModel):
    days: int = 365
    start_date: str = "2024-01-01"
    seed: int = 42
    base_demand: float = 100.0
    trend_per_day: float = 0.05
    weekly_amplitude: float = 15.0
    noise_std: float = 8.0
    shock_probability: float = 0.02


class ComparisonRequest(BaseModel):
    scenario: str = "normal"
    seed: int = 42
    strategies: Optional[dict] = None          # {"conservative": {...}, "aggressive": {...}}


@app.get("/scenarios")
async def get_scenarios():
    """列出所有可用的模擬情境"""
    return {
        "scenarios": list_scenarios(),
        "total": len(list_scenarios()),
    }


@app.post("/run-simulation")
async def run_simulation(request: SimulationRequest):
    """
    Digital Twin 模擬端點
    ─────────────────────
    選擇情境 → 混沌引擎 + 庫存模擬 → 完整 KPI 報告
    """
    try:
        scenario_config = get_scenario(request.scenario)

        # Allow overrides
        if request.duration_days:
            scenario_config.duration_days = request.duration_days
        if request.chaos_intensity:
            scenario_config.chaos_intensity = request.chaos_intensity

        orch = SimulationOrchestrator(
            custom_config=scenario_config,
            seed=request.seed,
            use_forecaster=request.use_forecaster,
            forecast_interval=request.forecast_interval,
        )

        result = orch.run()

        # Get daily log for timeline.
        # Pandas will coerce missing numeric cells (e.g. early forecast=None) to NaN,
        # so normalize non-finite values to None before JSON serialization.
        daily_df = orch.get_daily_log_df()
        timeline_sample = (
            daily_df.iloc[::7]
            .replace([np.nan, np.inf, -np.inf], None)
            .to_dict(orient="records")
        )  # Every 7 days

        return sanitize_numpy({
            "success": True,
            **result.to_dict(),
            "timeline_sample": timeline_sample,
        })

    except Exception as e:
        import traceback
        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


@app.post("/optimize")
async def optimize_params(request: OptimizeRequest):
    """
    參數優化端點
    ─────────────
    Grid/Random search 找出最佳庫存策略 (安全庫存係數、訂購點、訂購量)
    目標: 最小化 Total Cost，約束 fill_rate >= 95%
    """
    try:
        opt = ParameterOptimizer(
            scenario=request.scenario,
            seed=request.seed,
            min_fill_rate=request.min_fill_rate,
            use_forecaster=request.use_forecaster,
        )

        result = opt.optimize(n_trials=request.n_trials, method=request.method)
        return sanitize_numpy({"success": True, **result.to_dict()})

    except Exception as e:
        import traceback
        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


@app.post("/generate-data")
async def generate_synthetic_data(request: GenerateDataRequest):
    """
    合成數據生成端點
    ─────────────────
    產生具備統計特徵的需求數據，供訓練/測試/展示使用
    """
    try:
        gen = DataGenerator(seed=request.seed)
        profile = DemandProfile(
            base_demand=request.base_demand,
            trend_per_day=request.trend_per_day,
            weekly_amplitude=request.weekly_amplitude,
            noise_std=request.noise_std,
            shock_probability=request.shock_probability,
        )

        df = gen.generate(profile, days=request.days, start_date=request.start_date)

        demand_list = df["demand"].tolist()
        shock_events = df.attrs.get("shock_events", [])

        return {
            "success": True,
            "data": {
                "dates": [str(d.date()) for d in df["date"]],
                "demand": demand_list,
            },
            "stats": {
                "mean": round(float(np.mean(demand_list)), 2),
                "std": round(float(np.std(demand_list)), 2),
                "min": int(min(demand_list)),
                "max": int(max(demand_list)),
                "total": int(sum(demand_list)),
                "days": request.days,
            },
            "shock_events": shock_events,
            "profile": {
                "base_demand": request.base_demand,
                "trend_per_day": request.trend_per_day,
                "weekly_amplitude": request.weekly_amplitude,
                "noise_std": request.noise_std,
                "shock_probability": request.shock_probability,
            },
        }

    except Exception as e:
        return {"success": False, "error": str(e)}


@app.post("/simulation-comparison")
async def simulation_comparison(request: ComparisonRequest):
    """
    策略比較端點
    ─────────────
    同一情境下，比較不同庫存策略的表現
    """
    try:
        scenario_config = get_scenario(request.scenario)

        # Default strategies if none provided
        strategies = request.strategies or {
            "conservative": {
                "safety_stock_factor": 2.5,
                "reorder_point": 400,
                "order_quantity_days": 21,
            },
            "balanced": {
                "safety_stock_factor": 1.5,
                "reorder_point": 250,
                "order_quantity_days": 14,
            },
            "aggressive": {
                "safety_stock_factor": 0.8,
                "reorder_point": 150,
                "order_quantity_days": 7,
            },
        }

        results = {}
        for name, params in strategies.items():
            sc_inv = scenario_config.inventory_config
            config = InventoryConfig(
                initial_inventory=sc_inv.initial_inventory,
                safety_stock_factor=params.get("safety_stock_factor", 1.5),
                reorder_point=params.get("reorder_point", 200),
                order_quantity_days=params.get("order_quantity_days", 14),
                holding_cost_per_unit_day=params.get("holding_cost_per_unit_day", sc_inv.holding_cost_per_unit_day),
                stockout_penalty_per_unit=params.get("stockout_penalty_per_unit", sc_inv.stockout_penalty_per_unit),
                ordering_cost_per_order=params.get("ordering_cost_per_order", sc_inv.ordering_cost_per_order),
                unit_cost=params.get("unit_cost", sc_inv.unit_cost),
            )

            scenario_copy = get_scenario(request.scenario)
            scenario_copy.inventory_config = config

            orch = SimulationOrchestrator(
                custom_config=scenario_copy,
                seed=request.seed,
                use_forecaster=False,
            )
            result = orch.run()
            strategy_result = result.to_dict()
            daily_df = orch.get_daily_log_df()
            strategy_result["timeline_sample"] = (
                daily_df.iloc[::7]
                .replace([np.nan, np.inf, -np.inf], None)
                .to_dict(orient="records")
            )
            results[name] = strategy_result

        # Find best strategy
        ranked = sorted(
            results.items(),
            key=lambda x: x[1]["kpis"]["total_cost"]
            if x[1]["kpis"]["fill_rate_pct"] >= 95 else float("inf"),
        )

        return sanitize_numpy({
            "success": True,
            "scenario": request.scenario,
            "strategies": results,
            "ranking": [
                {
                    "rank": i + 1,
                    "strategy": name,
                    "total_cost": r["kpis"]["total_cost"],
                    "fill_rate": r["kpis"]["fill_rate_pct"],
                    "stockout_days": r["kpis"]["stockout_days"],
                }
                for i, (name, r) in enumerate(ranked)
            ],
            "recommendation": ranked[0][0] if ranked else None,
        })

    except Exception as e:
        import traceback
        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


# ── Phase 3 – P3.3: Simulation → Re-Optimization Feedback ────────────────────


class SimulationReoptimizeRequest(BaseModel):
    """Request to derive re-optimization inputs from simulation results."""
    sim_result: dict = Field(..., description="Output from /run-simulation")
    original_plan: Optional[dict] = Field(default=None, description="Original planning payload for diffing")
    config: Optional[dict] = Field(default=None, description="Override thresholds")


@app.post("/simulation/reoptimize")
async def simulation_reoptimize(request: SimulationReoptimizeRequest):
    """
    Phase 3 – Simulation → Re-Optimization Feedback Loop
    ─────────────────────────────────────────────────────
    Takes simulation KPIs and derives constraint tightening inputs
    for the replenishment solver (safety stock uplift, penalty increase, etc.).
    """
    try:
        from ml.simulation.feedback_loop import derive_reoptimization_inputs

        reopt = derive_reoptimization_inputs(
            sim_result=request.sim_result,
            original_plan=request.original_plan,
            config=request.config,
        )
        return sanitize_numpy({"success": True, **reopt})
    except Exception as e:
        import traceback
        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


@app.post("/auto-model-switch")
async def auto_model_switch(request: ForecastRequest):
    """
    Week 3: 自動模型切換
    ─────────────────────
    根據近期數據波動率自動選擇最佳預測模型：
    - 高波動 → LightGBM (擅長非線性)
    - 低波動 → Prophet (擅長趨勢+季節性)
    - 極短數據 → Chronos (零樣本)
    """
    try:
        if not request.history or len(request.history) < 14:
            return {"error": "需要至少 14 天歷史數據"}

        history = request.history
        n = len(history)

        # 計算波動率指標
        recent_14 = history[-14:]
        recent_30 = history[-30:] if n >= 30 else history
        cv_14 = float(np.std(recent_14)) / max(float(np.mean(recent_14)), 1)
        cv_30 = float(np.std(recent_30)) / max(float(np.mean(recent_30)), 1)

        # 趨勢強度 (線性回歸斜率)
        x = np.arange(len(recent_30))
        slope = float(np.polyfit(x, recent_30, 1)[0]) if len(recent_30) > 2 else 0

        # 決策邏輯
        if n < 30:
            chosen_model = "chronos"
            reason = f"數據僅 {n} 天，使用零樣本模型 Chronos"
        elif cv_14 > 0.4:
            chosen_model = "lightgbm"
            reason = f"近期波動率高 (CV={cv_14:.2f}>0.4)，LightGBM 擅長捕捉非線性模式"
        elif abs(slope) > 0.5 and cv_14 < 0.2:
            chosen_model = "prophet"
            reason = f"趨勢明確 (slope={slope:.2f}) 且波動低 (CV={cv_14:.2f})，Prophet 最適合"
        elif cv_14 < 0.15:
            chosen_model = "prophet"
            reason = f"數據穩定 (CV={cv_14:.2f}<0.15)，Prophet 的趨勢分解最有效"
        else:
            chosen_model = "lightgbm"
            reason = f"中等波動 (CV={cv_14:.2f})，LightGBM 通用性較佳"

        # 執行預測
        result = forecaster_factory.predict_with_fallback(
            sku=request.materialCode,
            inline_history=history,
            horizon_days=request.horizonDays,
            preferred_model=chosen_model,
        )
        result = _coerce_forecast_result(result, source="auto_model_switch:fallback")

        return {
            "success": result.get("success", False),
            "auto_selected_model": chosen_model,
            "selection_reason": reason,
            "volatility_analysis": {
                "cv_14d": round(cv_14, 3),
                "cv_30d": round(cv_30, 3),
                "trend_slope": round(slope, 3),
                "data_points": n,
            },
            "prediction": result.get("prediction", {}),
            "metadata": result.get("metadata", {}),
            "error": None if result.get("success", False) else result.get("error"),
            "errors": result.get("errors", []),
        }

    except Exception as e:
        return {"error": str(e)}


# ═══════════════════════════════════════════════════════════════════════════════
# Closed-Loop Forecast → Planning Re-Parameterization (PR-D)
# ═══════════════════════════════════════════════════════════════════════════════

class ClosedLoopEvaluateRequest(BaseModel):
    """Request for closed-loop trigger evaluation."""
    dataset_id: int
    forecast_run_id: int
    forecast_series: List[Dict[str, Any]] = Field(default_factory=list)
    forecast_metrics: Dict[str, Any] = Field(default_factory=dict)
    calibration_meta: Optional[Dict[str, Any]] = None
    previous_forecast_series: Optional[List[Dict[str, Any]]] = None
    risk_scores: List[Dict[str, Any]] = Field(default_factory=list)
    config_overrides: Dict[str, Any] = Field(default_factory=dict)


class ClosedLoopRunRequest(BaseModel):
    """Request for closed-loop run (evaluate + optionally execute)."""
    user_id: str
    dataset_profile_id: int
    forecast_run_id: int
    forecast_series: List[Dict[str, Any]] = Field(default_factory=list)
    forecast_metrics: Dict[str, Any] = Field(default_factory=dict)
    calibration_meta: Optional[Dict[str, Any]] = None
    previous_forecast_series: Optional[List[Dict[str, Any]]] = None
    risk_scores: List[Dict[str, Any]] = Field(default_factory=list)
    mode: str = "dry_run"
    config_overrides: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("mode")
    @classmethod
    def _validate_mode(cls, value: str) -> str:
        mode = str(value or "dry_run").strip().lower()
        if mode not in {"dry_run", "auto_run"}:
            raise ValueError("mode must be 'dry_run' or 'auto_run'")
        return mode


# ── Closed-loop pure functions (Python-side, stateless) ──────────────────────

def _cl_safe_float(v, fallback=float("nan")):
    try:
        f = float(v)
        return f if math.isfinite(f) else fallback
    except (TypeError, ValueError):
        return fallback


def _cl_aggregate_width(series: List[Dict]) -> float:
    return sum(
        max(0, _cl_safe_float(p.get("p90", p.get("p50", 0)))
            - _cl_safe_float(p.get("p10", p.get("p50", 0))))
        for p in series
    )


def _cl_aggregate_p50(series: List[Dict]) -> float:
    return sum(_cl_safe_float(p.get("p50", 0)) for p in series)


# Default config (mirrors CLOSED_LOOP_CONFIG in closedLoopConfig.js)
_CL_DEFAULTS: Dict[str, Any] = {
    "coverage_lower_band": 0.70,
    "coverage_upper_band": 0.95,
    "uncertainty_width_change_pct": 0.20,
    "p50_shift_pct": 0.15,
    "risk_severity_trigger": 60,
    "safety_stock_alpha_calibrated": 0.5,
    "safety_stock_alpha_uncalibrated": 0.8,
    "safety_stock_alpha_wide_uncertainty": 1.0,
    "stockout_penalty_base": 10.0,
    "stockout_penalty_uncertainty_uplift": 0.3,
    "lead_time_buffer_high_risk_days": 3,
    # Phase 3 expansions
    "service_level_target_default": 0.95,
    "expedite_risk_threshold": 80,
}


def _cl_evaluate_triggers(
    dataset_id: int,
    forecast_run_id: int,
    series: List[Dict],
    calibration_meta: Optional[Dict],
    previous_series: Optional[List[Dict]],
    risk_scores: List[Dict],
    cfg: Dict,
) -> Dict:
    """Evaluate trigger rules. Returns trigger decision dict."""
    reasons: List[Dict] = []

    # T-COVER
    coverage = _cl_safe_float((calibration_meta or {}).get("coverage_10_90"))
    if math.isfinite(coverage):
        if coverage < cfg["coverage_lower_band"]:
            reasons.append({
                "trigger_type": "coverage_outside_band", "severity": "high",
                "detail": f"coverage_10_90={coverage:.4f} < lower_band={cfg['coverage_lower_band']}",
                "evidence": {"coverage_10_90": coverage, "threshold": cfg["coverage_lower_band"], "direction": "below"},
            })
        elif coverage > cfg["coverage_upper_band"]:
            reasons.append({
                "trigger_type": "coverage_outside_band", "severity": "medium",
                "detail": f"coverage_10_90={coverage:.4f} > upper_band={cfg['coverage_upper_band']}",
                "evidence": {"coverage_10_90": coverage, "threshold": cfg["coverage_upper_band"], "direction": "above"},
            })

    # T-UNCERT
    if previous_series and len(previous_series) > 0 and len(series) > 0:
        cur_w = _cl_aggregate_width(series)
        prev_w = _cl_aggregate_width(previous_series)
        if prev_w > 0:
            delta = (cur_w - prev_w) / prev_w
            if abs(delta) > cfg["uncertainty_width_change_pct"]:
                reasons.append({
                    "trigger_type": "uncertainty_widens",
                    "severity": "high" if abs(delta) > 2 * cfg["uncertainty_width_change_pct"] else "medium",
                    "detail": f"Uncertainty width changed {delta * 100:.1f}% (threshold: {cfg['uncertainty_width_change_pct'] * 100:.1f}%)",
                    "evidence": {"delta_pct": round(delta, 6), "threshold": cfg["uncertainty_width_change_pct"]},
                })

    # T-P50
    if previous_series and len(previous_series) > 0 and len(series) > 0:
        cur_p50 = _cl_aggregate_p50(series)
        prev_p50 = _cl_aggregate_p50(previous_series)
        if prev_p50 > 0:
            shift = (cur_p50 - prev_p50) / prev_p50
            if abs(shift) > cfg["p50_shift_pct"]:
                reasons.append({
                    "trigger_type": "p50_shift",
                    "severity": "high" if abs(shift) > 2 * cfg["p50_shift_pct"] else "medium",
                    "detail": f"P50 shifted {shift * 100:.1f}% (threshold: {cfg['p50_shift_pct'] * 100:.1f}%)",
                    "evidence": {"shift_pct": round(shift, 6), "threshold": cfg["p50_shift_pct"]},
                })

    # T-RISK
    above = [r for r in risk_scores if _cl_safe_float(r.get("risk_score", 0)) > cfg["risk_severity_trigger"]]
    if above:
        max_score = max(_cl_safe_float(r.get("risk_score", 0)) for r in above)
        reasons.append({
            "trigger_type": "risk_severity_crossed",
            "severity": "high" if max_score > 2 * cfg["risk_severity_trigger"] else "medium",
            "detail": f"{len(above)} entity(ies) with risk_score > {cfg['risk_severity_trigger']} (max: {max_score:.2f})",
            "evidence": {"entities_above_threshold": len(above), "max_risk_score": max_score, "threshold": cfg["risk_severity_trigger"]},
        })

    return {
        "should_trigger": len(reasons) > 0,
        "reasons": reasons,
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
    }


def _cl_derive_params(
    series: List[Dict],
    calibration_meta: Optional[Dict],
    previous_series: Optional[List[Dict]],
    risk_scores: List[Dict],
    cfg: Dict,
) -> Dict:
    """Derive planning parameter patch from forecast data."""
    explanation: List[str] = []
    cal = calibration_meta or {}
    cal_passed = cal.get("calibration_passed")
    coverage = _cl_safe_float(cal.get("coverage_10_90"))

    # R-CL1: alpha selection
    if math.isfinite(coverage) and coverage > cfg["coverage_upper_band"]:
        alpha = cfg["safety_stock_alpha_wide_uncertainty"]
        explanation.append(f"R-CL1: coverage_10_90={coverage:.4f} > upper_band; alpha={alpha}")
    elif cal_passed is True and math.isfinite(coverage) and coverage >= cfg["coverage_lower_band"]:
        alpha = cfg["safety_stock_alpha_calibrated"]
        explanation.append(f"R-CL1: Calibration passed, coverage in band; alpha={alpha}")
    else:
        alpha = cfg["safety_stock_alpha_uncalibrated"]
        explanation.append(f"R-CL1: Calibration not passed or absent; alpha={alpha}")

    # R-CL2: stockout penalty
    penalty = cfg["stockout_penalty_base"]
    uw_delta = None
    if previous_series and len(previous_series) > 0 and len(series) > 0:
        cur_w = _cl_aggregate_width(series)
        prev_w = _cl_aggregate_width(previous_series)
        if prev_w > 0:
            uw_delta = (cur_w - prev_w) / prev_w
            if uw_delta > cfg["uncertainty_width_change_pct"]:
                penalty = round(penalty * (1 + cfg["stockout_penalty_uncertainty_uplift"]), 6)
                explanation.append(f"R-CL2: Uncertainty widened {uw_delta * 100:.1f}%; penalty raised to {penalty}")

    # R-CL3: lead time buffer from risk
    lt_buffer: Dict[str, int] = {}
    risk_above = 0
    for r in risk_scores:
        if _cl_safe_float(r.get("risk_score", 0)) > cfg["risk_severity_trigger"]:
            key = f"{r.get('material_code', r.get('entity_id', ''))}|{r.get('plant_id', '')}"
            lt_buffer[key] = cfg["lead_time_buffer_high_risk_days"]
            risk_above += 1
    if risk_above > 0:
        explanation.append(f"R-CL3: {risk_above} high-risk entities; added {cfg['lead_time_buffer_high_risk_days']}-day buffer")

    # R-CL4: per-SKU safety stock
    agg: Dict[str, Dict] = {}
    for pt in series:
        key = f"{pt.get('sku', pt.get('material_code', ''))}|{pt.get('plant_id', '')}"
        e = agg.setdefault(key, {"sum_p50": 0.0, "sum_p90": 0.0, "sum_p10": 0.0, "n": 0})
        e["sum_p50"] += _cl_safe_float(pt.get("p50", 0))
        e["sum_p90"] += _cl_safe_float(pt.get("p90", _cl_safe_float(pt.get("p50", 0))))
        e["sum_p10"] += _cl_safe_float(pt.get("p10", _cl_safe_float(pt.get("p50", 0))))
        e["n"] += 1
    ss: Dict[str, float] = {}
    for key in sorted(agg):
        e = agg[key]
        avg_p50 = e["sum_p50"] / e["n"] if e["n"] > 0 else 0
        avg_p90 = e["sum_p90"] / e["n"] if e["n"] > 0 else 0
        ss[key] = round(avg_p50 + alpha * max(0, avg_p90 - avg_p50), 6)

    # R-CL5: service_level_target (Phase 3 expansion)
    service_level_target = cfg.get("service_level_target_default", 0.95)
    if risk_above >= 3:
        service_level_target = min(0.99, service_level_target + 0.02)
        explanation.append(f"R-CL5: {risk_above} high-risk entities; service_level raised to {service_level_target:.2f}")
    elif math.isfinite(coverage) and coverage > cfg.get("coverage_upper_band", 0.95):
        service_level_target = max(0.90, service_level_target - 0.02)
        explanation.append(f"R-CL5: Wide uncertainty coverage; service_level relaxed to {service_level_target:.2f}")

    # R-CL6: moq_multiplier for high-demand SKUs (Phase 3 expansion)
    moq_multiplier: Dict[str, float] = {}
    for key in sorted(agg):
        e = agg[key]
        avg_p50 = e["sum_p50"] / e["n"] if e["n"] > 0 else 0
        avg_p90 = e["sum_p90"] / e["n"] if e["n"] > 0 else 0
        demand_spread = max(0, avg_p90 - avg_p50)
        if avg_p50 > 0 and demand_spread / avg_p50 > 0.5:
            moq_multiplier[key] = 1.5
    if moq_multiplier:
        explanation.append(f"R-CL6: {len(moq_multiplier)} SKUs with high demand spread; MOQ multiplier=1.5")

    # R-CL7: expedite_flag for critical risk entities (Phase 3 expansion)
    expedite_keys: Dict[str, bool] = {}
    for r in risk_scores:
        score = _cl_safe_float(r.get("risk_score", 0))
        if score > cfg.get("expedite_risk_threshold", 80):
            key = f"{r.get('material_code', r.get('entity_id', ''))}|{r.get('plant_id', '')}"
            expedite_keys[key] = True
    if expedite_keys:
        explanation.append(f"R-CL7: {len(expedite_keys)} critical-risk entities flagged for expedite")

    return {
        "version": "v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "patch": {
            "safety_stock_by_key": ss,
            "objective": {
                "stockout_penalty": penalty,
                "stockout_penalty_base": cfg["stockout_penalty_base"],
                "service_level_target": service_level_target,
            },
            "lead_time_buffer_by_key": dict(sorted(lt_buffer.items())),
            "safety_stock_alpha": alpha,
            "moq_multiplier_by_key": moq_multiplier,
            "expedite_keys": list(expedite_keys.keys()),
        },
        "explanation": explanation,
        "derived_values": {
            "calibration_passed": cal_passed,
            "coverage_10_90": round(coverage, 6) if math.isfinite(coverage) else None,
            "effective_alpha": alpha,
            "uncertainty_width_delta_pct": round(uw_delta, 6) if uw_delta is not None else None,
            "risk_entities_above_threshold": risk_above,
            "service_level_target": service_level_target,
            "moq_multiplier_count": len(moq_multiplier),
            "expedite_count": len(expedite_keys),
        },
    }


@app.post("/closed-loop/evaluate")
async def closed_loop_evaluate(request: ClosedLoopEvaluateRequest):
    """
    Evaluate closed-loop triggers and derive a recommended parameter patch.
    Stateless — no side effects, no re-run submitted.
    """
    cfg = {**_CL_DEFAULTS, **request.config_overrides}
    trigger = _cl_evaluate_triggers(
        dataset_id=request.dataset_id,
        forecast_run_id=request.forecast_run_id,
        series=request.forecast_series,
        calibration_meta=request.calibration_meta,
        previous_series=request.previous_forecast_series,
        risk_scores=request.risk_scores,
        cfg=cfg,
    )
    param_patch = None
    if trigger["should_trigger"]:
        param_patch = _cl_derive_params(
            series=request.forecast_series,
            calibration_meta=request.calibration_meta,
            previous_series=request.previous_forecast_series,
            risk_scores=request.risk_scores,
            cfg=cfg,
        )
    status = "TRIGGERED_DRY_RUN" if trigger["should_trigger"] else "NO_TRIGGER"
    return {
        "closed_loop_status": status,
        "trigger_decision": trigger,
        "param_patch": param_patch,
        "explanation": param_patch["explanation"] if param_patch else ["No trigger conditions met."],
        "planning_run_id": None,
    }


@app.post("/closed-loop/run")
async def closed_loop_run(request: ClosedLoopRunRequest):
    """
    Evaluate closed-loop triggers and optionally submit a planning re-run.
    For dry_run mode, returns what would happen without executing.
    For auto_run mode, server-side execution is delegated to the JS orchestration
    layer and reported transparently via execution_state.
    """
    cfg = {**_CL_DEFAULTS, **request.config_overrides}
    trigger = _cl_evaluate_triggers(
        dataset_id=request.dataset_profile_id,
        forecast_run_id=request.forecast_run_id,
        series=request.forecast_series,
        calibration_meta=request.calibration_meta,
        previous_series=request.previous_forecast_series,
        risk_scores=request.risk_scores,
        cfg=cfg,
    )
    if not trigger["should_trigger"]:
        return {
            "closed_loop_status": "NO_TRIGGER",
            "trigger_decision": trigger,
            "param_patch": None,
            "explanation": ["No trigger conditions met."],
            "planning_run_id": None,
        }

    param_patch = _cl_derive_params(
        series=request.forecast_series,
        calibration_meta=request.calibration_meta,
        previous_series=request.previous_forecast_series,
        risk_scores=request.risk_scores,
        cfg=cfg,
    )

    requested_mode = str(request.mode or "dry_run").strip().lower()
    execution_state = "DRY_RUN_COMPLETED"
    explanation = list(param_patch["explanation"])
    if requested_mode == "auto_run":
        execution_state = "AUTO_RUN_DELEGATED"
        explanation.append(
            "auto_run requested; server-side execution is delegated to JS orchestration."
        )

    # Server-side auto_run remains delegated to JS orchestration.
    return {
        "closed_loop_status": "TRIGGERED_DRY_RUN",
        "trigger_decision": trigger,
        "param_patch": param_patch,
        "explanation": explanation,
        "planning_run_id": None,
        "mode": requested_mode,
        "execution_state": execution_state,
        "auto_run_executed": False,
    }


# ===========================================================================
# Supplier Event Connector — Sense Layer Endpoints
# ===========================================================================

VALID_SUPPLIER_EVENT_TYPES = {
    "delivery_delay", "quality_alert", "capacity_change",
    "force_majeure", "shipment_status", "price_change",
}
VALID_SEVERITY_LEVELS = {"low", "medium", "high", "critical"}


class SupplierEventPayload(BaseModel):
    """Single supplier event from an external system."""
    model_config = {"populate_by_name": True}

    event_id: str
    event_type: str
    supplier_id: str
    supplier_name: Optional[str] = None
    material_code: Optional[str] = None
    plant_id: Optional[str] = None
    severity: str = "medium"
    occurred_at: str
    source_system: str = "external"
    description: str = ""
    metadata: Dict[str, Any] = Field(default_factory=dict)
    details: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("event_type")
    @classmethod
    def validate_event_type(cls, v):
        if v not in VALID_SUPPLIER_EVENT_TYPES:
            raise ValueError(f"event_type must be one of {VALID_SUPPLIER_EVENT_TYPES}, got '{v}'")
        return v

    @field_validator("severity")
    @classmethod
    def validate_severity(cls, v):
        if v not in VALID_SEVERITY_LEVELS:
            raise ValueError(f"severity must be one of {VALID_SEVERITY_LEVELS}, got '{v}'")
        return v


class SupplierEventRequest(BaseModel):
    """Single event request wrapper."""
    event: SupplierEventPayload


class SupplierEventBatchRequest(BaseModel):
    """Batch event request (up to 100)."""
    events: List[SupplierEventPayload] = Field(..., min_length=1, max_length=100)
    source_system: str = "external"
    batch_id: Optional[str] = None


def _persist_supplier_events(rows: list) -> int:
    """Best-effort persist to supplier_events table via Supabase REST API."""
    try:
        url = supabase_client.url
        headers = supabase_client.headers
        if not url or not headers.get("apikey"):
            return 0
        import requests as _req
        resp = _req.post(
            f"{url}/rest/v1/supplier_events",
            headers={**headers, "Prefer": "return=minimal"},
            json=rows,
        )
        if resp.status_code < 300:
            return len(rows)
        logger.warning("[supplier-events] Persist returned %s: %s", resp.status_code, resp.text[:200])
        return 0
    except Exception as e:
        logger.warning("[supplier-events] Persist failed: %s", e)
        return 0


@app.post("/supplier-events")
async def receive_supplier_event(request: SupplierEventRequest):
    """
    Receive a single real-time supplier event.
    Validates, persists for audit, and returns acknowledgement.
    Risk recalculation and alert triggering happens on the JS frontend side.
    """
    ev = request.event
    now = datetime.now(timezone.utc).isoformat()

    row = {
        "event_id": ev.event_id,
        "event_type": ev.event_type,
        "supplier_id": ev.supplier_id,
        "supplier_name": ev.supplier_name,
        "material_code": (ev.material_code or "").upper() or None,
        "plant_id": (ev.plant_id or "").upper() or None,
        "severity": ev.severity,
        "occurred_at": ev.occurred_at,
        "source_system": ev.source_system,
        "description": ev.description,
        "details_json": ev.details,
        "metadata_json": ev.metadata,
        "received_at": now,
    }
    persisted = _persist_supplier_events([row])

    return {
        "status": "accepted",
        "event_id": ev.event_id,
        "event_type": ev.event_type,
        "persisted": persisted > 0,
        "received_at": now,
    }


@app.post("/supplier-events/batch")
async def receive_supplier_event_batch(request: SupplierEventBatchRequest):
    """
    Receive a batch of supplier events (up to 100).
    Validates each, persists for audit, returns per-event status.
    """
    now = datetime.now(timezone.utc).isoformat()
    batch_id = request.batch_id or f"batch_{now}"

    rows = []
    results = []
    for ev in request.events:
        rows.append({
            "event_id": ev.event_id,
            "event_type": ev.event_type,
            "supplier_id": ev.supplier_id,
            "supplier_name": ev.supplier_name,
            "material_code": (ev.material_code or "").upper() or None,
            "plant_id": (ev.plant_id or "").upper() or None,
            "severity": ev.severity,
            "occurred_at": ev.occurred_at,
            "source_system": request.source_system,
            "description": ev.description,
            "details_json": ev.details,
            "metadata_json": ev.metadata,
            "received_at": now,
            "batch_id": batch_id,
        })
        results.append({"event_id": ev.event_id, "status": "accepted"})

    persist_count = _persist_supplier_events(rows) if rows else 0

    return {
        "status": "accepted",
        "batch_id": batch_id,
        "total_events": len(request.events),
        "persisted_count": persist_count,
        "results": results,
        "received_at": now,
    }
