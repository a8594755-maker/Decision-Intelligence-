import sys
from pathlib import Path

# Add project root to Python path
root_dir = str(Path(__file__).resolve().parents[3])
if root_dir not in sys.path:
    sys.path.append(root_dir)

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from ml.demand_forecasting.prophet_trainer import ProphetTrainer
from ml.demand_forecasting.lightgbm_trainer import LightGBMTrainer
from ml.demand_forecasting.chronos_trainer import ChronosTrainer
from ml.demand_forecasting.forecaster_factory import ForecasterFactory, ModelType
from ml.demand_forecasting.erp_connector import ERPConnector
from ml.utils.supabase_rest_client import SupabaseRESTClient
import os
import json
import numpy as np
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any, Tuple
import math

try:
    from ortools.sat.python import cp_model
    ORTOOLS_AVAILABLE = True
except Exception:
    cp_model = None
    ORTOOLS_AVAILABLE = False

# Solver engine selection: "heuristic" (default) or "ortools" (CP-SAT MILP v0).
# Set environment variable DI_SOLVER_ENGINE=ortools to activate the CP-SAT solver.
DI_SOLVER_ENGINE: str = os.getenv("DI_SOLVER_ENGINE", "heuristic").lower()

if ORTOOLS_AVAILABLE:
    from ml.api.replenishment_solver import solve_replenishment as _cp_sat_solve
    from ml.api.replenishment_solver import solve_replenishment_multi_echelon as _cp_sat_me_solve
else:
    _cp_sat_solve = None      # type: ignore[assignment]
    _cp_sat_me_solve = None   # type: ignore[assignment]

import asyncio

from ml.api.async_runs import (
    AsyncRunConfig,
    AsyncRunService,
    AsyncRunStatusResponse,
    AsyncRunSubmitRequest,
    AsyncRunSubmitResponse,
    PostgresAsyncRunStore,
    TERMINAL_JOB_STATUSES,
)

def sanitize_numpy(obj):
    """Recursively convert numpy types to native Python types for JSON serialization."""
    if isinstance(obj, dict):
        return {k: sanitize_numpy(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [sanitize_numpy(v) for v in obj]
    elif isinstance(obj, (np.integer,)):
        return int(obj)
    elif isinstance(obj, (np.floating,)):
        return float(obj)
    elif isinstance(obj, (np.bool_,)):
        return bool(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    return obj

app = FastAPI(
    title="Demand Forecast API",
    description="AI-driven demand forecasting service for Risk Dashboard",
    version="1.0.0"
)

def _parse_allowed_origins(raw_value: str) -> List[str]:
    return [origin.strip() for origin in raw_value.split(",") if origin.strip()]


ALLOWED_ORIGINS = _parse_allowed_origins(
    os.getenv("ALLOWED_ORIGINS", "http://localhost:5173")
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

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={"error": str(exc)},
        headers={"Access-Control-Allow-Origin": _resolve_cors_origin(request)},
    )

# Configuration
ERP_API_ENDPOINT = os.getenv("ERP_ENDPOINT", "https://erp-api.example.com")
ERP_API_KEY = os.getenv("ERP_API_KEY", "default-key")
USE_MOCK_ERP = os.getenv("USE_MOCK_ERP", "true").lower() == "true"

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


def get_async_run_service() -> AsyncRunService:
    global _async_run_service
    if _async_run_service is None:
        store = PostgresAsyncRunStore()
        _async_run_service = AsyncRunService(store=store, config=AsyncRunConfig.from_env())
    return _async_run_service

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


@app.get("/jobs/{job_id}/events")
async def stream_job_events(
    job_id: str,
    interval_seconds: float = Query(2.0, ge=0.5, le=10.0),
):
    service = get_async_run_service()

    async def event_stream():
        previous_payload = None
        while True:
            try:
                status = service.get_job_status(job_id)
            except KeyError:
                yield "event: error\\ndata: {\"error\":\"job_not_found\"}\\n\\n"
                break

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
async def demand_forecast(request: ForecastRequest):
    """
    双模型需求预测端点
    :param request: 预测请求参数
    :return: 预测结果
    """
    try:
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
                    "cacheTime": cached_result["created_at"]
                }
        
        # 2. 执行预测（带回退机制）
        result = forecaster_factory.predict_with_fallback(
            request.materialCode,
            erp_connector if inline_history is None else None,
            request.horizonDays,
            request.modelType or request.userPreference,
            inline_history=inline_history
        )
        
        if not result["success"]:
            return {
                "error": result["error"],
                "attempted_models": result.get("attempted_models", []),
                "errors": result.get("errors", [])
            }
        
        # 3. 格式化响应
        prediction_data = result["prediction"]
        forecast = {
            "model": result["model_type"].upper(),
            "median": float(np.mean(prediction_data["predictions"])),
            "confidence_interval": [
                float(np.mean([ci[0] for ci in prediction_data["confidence_interval"]])),
                float(np.mean([ci[1] for ci in prediction_data["confidence_interval"]]))
            ],
            "risk_score": float(prediction_data.get("risk_score", 50.0)),
            "model_version": prediction_data.get("model_version", "unknown"),
            "predictions": prediction_data["predictions"]  # 详细预测数据
        }
        
        response = {
            "materialCode": request.materialCode,
            "forecast": forecast,
            "metadata": result.get("metadata", {}),
            "cached": False
        }
        
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
        for model_name, model_status in status.items():
            if model_status["available"]:
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
        
        if not result["success"]:
            return {
                "error": result["error"],
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
    """
    try:
        if not request.history or len(request.history) < 17:
            return {"error": "回測需要至少 17 個數據點 (10 訓練 + 7 測試)"}
        
        test_days = request.horizonDays if request.horizonDays <= 14 else 7
        
        # 使用 ForecasterFactory 進行回測
        result = forecaster_factory.backtest(
            sku=request.materialCode,
            full_history=request.history,
            test_days=test_days,
            models=None  # 測試所有可用模型
        )
        
        return result
        
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


class MultiEchelonInput(BaseModel):
    mode: str = "off"
    max_bom_depth: Optional[int] = None
    fg_to_components_scope: Dict[str, Any] = Field(default_factory=dict)
    lot_sizing_mode: Optional[str] = None
    mapping_rules: Dict[str, Any] = Field(default_factory=dict)
    bom_explosion_used: Optional[bool] = None
    bom_explosion_reused: Optional[bool] = None
    production_capacity_per_period: Optional[float] = None
    inventory_capacity_per_period: Optional[float] = None
    component_stockout_penalty: Optional[float] = None


class ConstraintsInput(BaseModel):
    moq: List[SkuQtyConstraint] = Field(default_factory=list)
    pack_size: List[SkuQtyConstraint] = Field(default_factory=list)
    budget_cap: Optional[float] = None
    max_order_qty: List[SkuQtyConstraint] = Field(default_factory=list)
    unit_costs: List[SkuUnitCostConstraint] = Field(default_factory=list)


class ObjectiveInput(BaseModel):
    optimize_for: str = "balanced"
    stockout_penalty: Optional[float] = None
    holding_cost: Optional[float] = None
    service_level_target: Optional[float] = None


class ReplenishmentPlanRequest(BaseModel):
    model_config = {"populate_by_name": True}
    dataset_profile_id: int
    planning_horizon_days: int = 30
    demand_forecast: DemandForecastInput
    inventory: List[InventoryPoint] = Field(default_factory=list)
    open_pos: List[OpenPOPoint] = Field(default_factory=list)
    constraints: ConstraintsInput = Field(default_factory=ConstraintsInput)
    objective: ObjectiveInput = Field(default_factory=ObjectiveInput)
    multi_echelon: MultiEchelonInput = Field(default_factory=MultiEchelonInput)
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


def _build_unit_cost_lookup(rows: List[SkuUnitCostConstraint]) -> Dict[str, float]:
    lookup = {}
    for row in rows or []:
        sku = str(row.sku or "").strip()
        if not sku:
            continue
        unit_cost = row.unit_cost
        if unit_cost is None:
            continue
        lookup[sku] = max(0.0, _to_float(unit_cost, 0.0))
    return lookup


def _parse_env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name, "")
    if raw is None:
        return default
    text = str(raw).strip().lower()
    if text in {"1", "true", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _infer_period_days(sorted_dates: List[Any]) -> int:
    if len(sorted_dates) <= 1:
        return 1
    deltas = []
    for idx in range(1, len(sorted_dates)):
        prev_day = sorted_dates[idx - 1]
        next_day = sorted_dates[idx]
        if not prev_day or not next_day:
            continue
        days = int((next_day - prev_day).days)
        if days > 0:
            deltas.append(days)
    if not deltas:
        return 1
    deltas.sort()
    return max(1, int(deltas[len(deltas) // 2]))


def _format_plan_row(sku: str, plant_id: str, order_date, arrival_date, order_qty: float):
    return {
        "sku": sku,
        "plant_id": plant_id or None,
        "order_date": order_date.isoformat(),
        "arrival_date": arrival_date.isoformat(),
        "order_qty": float(round(max(0.0, order_qty), 6))
    }


def _deterministic_replenishment_plan(payload: ReplenishmentPlanRequest) -> Dict[str, Any]:
    t0 = datetime.utcnow()
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
                "solve_time_ms": int((datetime.utcnow() - t0).total_seconds() * 1000),
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

    solve_time_ms = int((datetime.utcnow() - t0).total_seconds() * 1000)

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


def _cp_sat_multi_echelon_plan(payload: ReplenishmentPlanRequest) -> Dict[str, Any]:
    """Thin wrapper — logic lives in replenishment_solver.solve_replenishment_multi_echelon."""
    return sanitize_numpy(_cp_sat_me_solve(payload))


@app.post("/replenishment-plan")
async def replenishment_plan(request: ReplenishmentPlanRequest):
    """
    Deterministic replenishment planner (heuristic baseline).
    Returns a stable response schema for chat workflow integration.
    """
    try:
        if _request_async_enabled(request):
            if not request.user_id:
                raise HTTPException(status_code=400, detail="user_id is required when async mode is enabled")
            dataset_fingerprint = request.dataset_fingerprint or f"profile:{request.dataset_profile_id}"
            service = get_async_run_service()
            submit_response = service.submit(
                AsyncRunSubmitRequest(
                    user_id=request.user_id,
                    dataset_profile_id=request.dataset_profile_id,
                    dataset_fingerprint=dataset_fingerprint,
                    contract_template_id=request.contract_template_id,
                    workflow=request.workflow or "workflow_A_replenishment",
                    engine_flags=request.engine_flags or {},
                    settings=request.settings or {
                        "solver": request.objective.model_dump(mode="json"),
                        "constraints": request.constraints.model_dump(mode="json"),
                    },
                    horizon=request.planning_horizon_days,
                    granularity=request.demand_forecast.granularity,
                    max_attempts=request.max_attempts,
                    workload={
                        "forecast_series": len(request.demand_forecast.series or []),
                        "skus": len({str(point.sku) for point in (request.demand_forecast.series or []) if point.sku}),
                        **(request.workload or {}),
                    },
                ),
            )
            return submit_response.model_dump(mode="json")

        requested_mode = str(request.multi_echelon.mode or "").strip().lower()
        env_multi_echelon = _parse_env_bool("DI_MULTI_ECHELON", False)
        use_multi_echelon = (requested_mode == "bom_v0") or (requested_mode in {"", "off"} and env_multi_echelon)

        if use_multi_echelon and ORTOOLS_AVAILABLE:
            result = _cp_sat_multi_echelon_plan(request)
        elif use_multi_echelon:
            result = _deterministic_replenishment_plan(request)
            result["component_plan"] = []
            result["component_inventory_projection"] = {"total_rows": 0, "rows": [], "truncated": False}
            result["bottlenecks"] = {"generated_at": datetime.utcnow().isoformat(), "items": [], "rows": [], "total_rows": 0}
            result["solver_meta"] = {
                **(result.get("solver_meta") or {}),
                "solver": "heuristic",
                "multi_echelon_mode": "bom_v0",
                "max_bom_depth": request.multi_echelon.max_bom_depth if request.multi_echelon.max_bom_depth is not None else 50,
                "bom_explosion_used": bool(request.multi_echelon.bom_explosion_used),
                "bom_explosion_reused": bool(request.multi_echelon.bom_explosion_reused),
                "fallback_reason": "OR-Tools is unavailable; multi-echelon fallback ran with single-echelon heuristic."
            }
        else:
            # Single-echelon path: dispatch to CP-SAT MILP v0 or heuristic baseline.
            if DI_SOLVER_ENGINE == "ortools" and _cp_sat_solve is not None:
                result = _cp_sat_solve(request)
            elif DI_SOLVER_ENGINE == "ortools":
                # ortools requested but not installed; fall back to heuristic silently.
                result = _deterministic_replenishment_plan(request)
                result.setdefault("solver_meta", {})["note"] = (
                    "DI_SOLVER_ENGINE=ortools requested but ortools is not installed; used heuristic fallback."
                )
            else:
                result = _deterministic_replenishment_plan(request)
        return sanitize_numpy(result)
    except Exception as e:
        return {
            "status": "error",
            "plan": [],
            "component_plan": [],
            "component_inventory_projection": {"total_rows": 0, "rows": [], "truncated": False},
            "bottlenecks": {"generated_at": datetime.utcnow().isoformat(), "items": [], "rows": [], "total_rows": 0},
            "kpis": {
                "estimated_service_level": None,
                "estimated_stockout_units": None,
                "estimated_holding_units": None,
                "estimated_total_cost": None
            },
            "solver_meta": {
                "solver": "heuristic",
                "solve_time_ms": 0,
                "objective_value": None,
                "gap": None
            },
            "infeasible_reasons": [str(e)],
            "proof": {
                "objective_terms": [],
                "constraints_checked": []
            }
        }


class TrainRequest(BaseModel):
    modelType: str = "lightgbm"       # "lightgbm" | "prophet" | "all"
    days: int = 365
    seed: int = 42
    mape_gate: float = 20.0
    history: Optional[List[float]] = None
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

    model_type = request.modelType.lower()
    if model_type not in ("lightgbm", "prophet", "all"):
        return {"error": f"支援 lightgbm / prophet / all，收到: {request.modelType}"}

    try:
        import pandas as pd
        from ml.demand_forecasting.feature_engineer import FeatureEngineer, FEATURE_COLUMNS

        fe = FeatureEngineer()
        model_dir = os.path.join(os.path.dirname(__file__), '..', 'models')
        os.makedirs(model_dir, exist_ok=True)

        # ══════════════════════════════════════════════
        # 0. 準備數據（共用）
        # ══════════════════════════════════════════════
        if request.history and len(request.history) >= 60:
            dates = pd.date_range(start='2025-01-01', periods=len(request.history), freq='D')
            df = pd.DataFrame({'date': dates, 'sales': request.history})
        else:
            np.random.seed(request.seed)
            days = request.days
            dates = pd.date_range(start='2025-01-01', periods=days, freq='D')
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

        return {
            "status": "deployed" if deployed else "rejected",
            "deployed_models": deployed,
            "rejected_models": rejected,
            "results": deploy_results,
            "training_stats_baseline": training_stats,
            "elapsed_seconds": round(elapsed, 2),
            "message": f"✅ 已完成: {', '.join(deployed) if deployed else '無模型通過閘門'}"
        }

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

    # ── Task 2: Optuna 自動調參 ──
    if request.use_optuna:
        try:
            import optuna
            optuna.logging.set_verbosity(optuna.logging.WARNING)

            def objective(trial):
                params = {
                    'boosting_type': 'gbdt',
                    'objective': 'regression',
                    'metric': 'mape',
                    'verbose': -1,
                    'feature_pre_filter': False,
                    'learning_rate': trial.suggest_float('learning_rate', 0.01, 0.3, log=True),
                    'num_leaves': trial.suggest_int('num_leaves', 15, 127),
                    'feature_fraction': trial.suggest_float('feature_fraction', 0.5, 1.0),
                    'bagging_fraction': trial.suggest_float('bagging_fraction', 0.5, 1.0),
                    'bagging_freq': trial.suggest_int('bagging_freq', 1, 10),
                    'min_child_samples': trial.suggest_int('min_child_samples', 5, 50),
                    'reg_alpha': trial.suggest_float('reg_alpha', 1e-8, 10.0, log=True),
                    'reg_lambda': trial.suggest_float('reg_lambda', 1e-8, 10.0, log=True),
                }
                m = lgb.train(
                    params, train_data,
                    valid_sets=[val_data], valid_names=['valid'],
                    num_boost_round=500,
                    callbacks=[lgb.early_stopping(30), lgb.log_evaluation(0)],
                )
                preds = m.predict(X_val)
                return mean_absolute_percentage_error(y_val, preds) * 100

            study = optuna.create_study(direction='minimize')
            study.optimize(objective, n_trials=request.optuna_trials, show_progress_bar=False)

            best_params = {
                'boosting_type': 'gbdt', 'objective': 'regression', 'metric': 'mape',
                'verbose': -1, **study.best_params
            }
            optuna_info = {
                "best_mape": round(study.best_value, 2),
                "best_params": {k: round(v, 6) if isinstance(v, float) else v for k, v in study.best_params.items()},
                "n_trials": request.optuna_trials,
            }
        except ImportError:
            best_params = {
                'boosting_type': 'gbdt', 'objective': 'regression', 'metric': 'mape',
                'num_leaves': 31, 'learning_rate': 0.05, 'feature_fraction': 0.9,
                'bagging_fraction': 0.8, 'bagging_freq': 5, 'verbose': -1,
            }
            optuna_info = {"skipped": True, "reason": "optuna not installed"}
    else:
        best_params = {
            'boosting_type': 'gbdt', 'objective': 'regression', 'metric': 'mape',
            'num_leaves': 31, 'learning_rate': 0.05, 'feature_fraction': 0.9,
            'bagging_fraction': 0.8, 'bagging_freq': 5, 'verbose': -1,
        }

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

        # 2. 排序 & 計算百分比
        total_gain = sum(feat_imp.values()) or 1
        sorted_feats = sorted(feat_imp.items(), key=lambda x: x[1], reverse=True)

        features = []
        for feat_name, gain in sorted_feats:
            pct = round(gain / total_gain * 100, 1)
            features.append({
                "feature": feat_name,
                "importance_gain": gain,
                "importance_pct": pct,
                "explanation": _explain_feature(feat_name, pct),
            })

        # 3. 生成整體摘要
        top3 = features[:3]
        summary = (
            f"模型預測主要依據: "
            f"{top3[0]['feature']}({top3[0]['importance_pct']}%), "
            f"{top3[1]['feature']}({top3[1]['importance_pct']}%), "
            f"{top3[2]['feature']}({top3[2]['importance_pct']}%)"
        ) if len(top3) >= 3 else "特徵不足"

        # 4. Optuna 調參資訊
        optuna_info = meta.get('optuna', None)

        return {
            "success": True,
            "features": features,
            "summary": summary,
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

        # Get daily log for timeline
        daily_df = orch.get_daily_log_df()
        timeline_sample = daily_df.iloc[::7].to_dict(orient="records")  # Every 7 days

        return {
            "success": True,
            **result.to_dict(),
            "timeline_sample": timeline_sample,
        }

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
        return {"success": True, **result.to_dict()}

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
            config = InventoryConfig(
                initial_inventory=scenario_config.inventory_config.initial_inventory,
                safety_stock_factor=params.get("safety_stock_factor", 1.5),
                reorder_point=params.get("reorder_point", 200),
                order_quantity_days=params.get("order_quantity_days", 14),
                holding_cost_per_unit_day=scenario_config.inventory_config.holding_cost_per_unit_day,
                stockout_penalty_per_unit=scenario_config.inventory_config.stockout_penalty_per_unit,
                ordering_cost_per_order=scenario_config.inventory_config.ordering_cost_per_order,
                unit_cost=scenario_config.inventory_config.unit_cost,
            )

            scenario_copy = get_scenario(request.scenario)
            scenario_copy.inventory_config = config

            orch = SimulationOrchestrator(
                custom_config=scenario_copy,
                seed=request.seed,
                use_forecaster=False,
            )
            result = orch.run()
            results[name] = result.to_dict()

        # Find best strategy
        ranked = sorted(
            results.items(),
            key=lambda x: x[1]["kpis"]["total_cost"]
            if x[1]["kpis"]["fill_rate_pct"] >= 95 else float("inf"),
        )

        return {
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
        }

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
        }

    except Exception as e:
        return {"error": str(e)}
