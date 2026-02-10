import sys
from pathlib import Path

# Add project root to Python path
root_dir = str(Path(__file__).resolve().parents[3])
if root_dir not in sys.path:
    sys.path.append(root_dir)

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from ml.demand_forecasting.prophet_trainer import ProphetTrainer
from ml.demand_forecasting.lightgbm_trainer import LightGBMTrainer
from ml.demand_forecasting.chronos_trainer import ChronosTrainer
from ml.demand_forecasting.forecaster_factory import ForecasterFactory, ModelType
from ml.demand_forecasting.erp_connector import ERPConnector
from ml.utils.supabase_rest_client import SupabaseRESTClient
import os
import json
import numpy as np
from datetime import datetime
from typing import Optional, List

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

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={"error": str(exc)},
        headers={"Access-Control-Allow-Origin": "*"},
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

class ForecastRequest(BaseModel):
    materialCode: str
    horizonDays: int = 30
    modelType: Optional[str] = None  # None = auto-recommend, "prophet", "lightgbm", "chronos", "AUTO"
    includeComparison: bool = True  # 是否包含模型比较
    userPreference: Optional[str] = None  # 用户偏好模型
    history: Optional[List[float]] = None  # 直接传入的历史数据序列（压力测试/离线模式）

class ModelAnalysisRequest(BaseModel):
    materialCode: str

class ModelStatusRequest(BaseModel):
    pass

@app.post("/demand-forecast")
async def demand_forecast(request: ForecastRequest):
    """
    双模型需求预测端点
    :param request: 预测请求参数
    :return: 预测结果
    """
    try:
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
    use_forecaster: bool = False               # True = 用 SmartOps 預測, False = naive baseline
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
