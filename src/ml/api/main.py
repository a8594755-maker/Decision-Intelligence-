import sys
from pathlib import Path

# Add project root to Python path
root_dir = str(Path(__file__).resolve().parents[3])
if root_dir not in sys.path:
    sys.path.append(root_dir)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
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

app = FastAPI(
    title="Demand Forecast API",
    description="AI-driven demand forecasting service for Risk Dashboard",
    version="1.0.0"
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
ERP_API_ENDPOINT = os.getenv("ERP_ENDPOINT", "https://erp-api.example.com")
ERP_API_KEY = os.getenv("ERP_API_KEY", "default-key")

# Initialize services
erp_connector = ERPConnector(ERP_API_ENDPOINT, ERP_API_KEY)
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
        
        return response
        
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
    modelType: str = "lightgbm"
    days: int = 365
    seed: int = 42
    mape_gate: float = 20.0
    history: Optional[List[float]] = None


@app.post("/train-model")
async def train_model(request: TrainRequest):
    """
    Phase 3: 自動化訓練管道
    訓練模型 → 回測驗證 → 超過 MAPE 閘門則拒絕部署
    """
    import time
    t0 = time.time()

    if request.modelType.lower() != "lightgbm":
        return {"error": f"目前僅支援 lightgbm 訓練，收到: {request.modelType}"}

    try:
        import pandas as pd
        from ml.demand_forecasting.feature_engineer import FeatureEngineer, FEATURE_COLUMNS

        fe = FeatureEngineer()

        # ── 1. 準備數據 ──
        if request.history and len(request.history) >= 60:
            dates = pd.date_range(start='2025-01-01', periods=len(request.history), freq='D')
            df = pd.DataFrame({'date': dates, 'sales': request.history})
        else:
            # 生成模擬數據
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
                    promos[i:i+3] = 20
            sales = np.maximum(base + trend + weekly + monthly + yearly + noise + promos, 0).round(1)
            df = pd.DataFrame({'date': dates, 'sales': sales})

        # ── 2. 特徵工程 ──
        X, y = fe.create_training_data(df, min_rows=30)

        # ── 3. 時序分割 ──
        split_idx = int(len(X) * 0.85)
        X_train, X_val = X.iloc[:split_idx], X.iloc[split_idx:]
        y_train, y_val = y.iloc[:split_idx], y.iloc[split_idx:]

        # ── 4. 訓練 LightGBM ──
        try:
            import lightgbm as lgb
            import joblib as jl
            from sklearn.metrics import mean_absolute_percentage_error
        except ImportError as ie:
            return {"error": f"缺少必要套件: {ie}"}

        train_data = lgb.Dataset(X_train, label=y_train, feature_name=FEATURE_COLUMNS)
        val_data = lgb.Dataset(X_val, label=y_val, reference=train_data)

        params = {
            'boosting_type': 'gbdt', 'objective': 'regression', 'metric': 'mape',
            'num_leaves': 31, 'learning_rate': 0.05, 'feature_fraction': 0.9,
            'bagging_fraction': 0.8, 'bagging_freq': 5, 'verbose': -1,
        }

        model = lgb.train(
            params, train_data,
            valid_sets=[train_data, val_data], valid_names=['train', 'valid'],
            num_boost_round=1000,
            callbacks=[lgb.early_stopping(50), lgb.log_evaluation(0)],
        )

        # ── 5. 評估 ──
        y_pred_val = model.predict(X_val)
        val_mape = mean_absolute_percentage_error(y_val, y_pred_val) * 100

        # ── 6. Drift Monitor 質量閘門 ──
        if val_mape > request.mape_gate:
            return {
                "status": "rejected",
                "reason": f"MAPE {val_mape:.2f}% 超過閘門 {request.mape_gate}%，拒絕部署",
                "val_mape": round(val_mape, 2),
                "mape_gate": request.mape_gate,
                "recommendation": "請檢查數據品質或增加訓練數據量"
            }

        # ── 7. 保存模型 ──
        model_dir = os.path.join(os.path.dirname(__file__), '..', 'models')
        os.makedirs(model_dir, exist_ok=True)
        model_path = os.path.join(model_dir, 'lgbm_model.pkl')
        meta_path = os.path.join(model_dir, 'lgbm_meta.json')

        jl.dump(model, model_path)

        # 特徵重要性
        feat_imp = dict(zip(FEATURE_COLUMNS, [int(x) for x in model.feature_importance(importance_type='gain')]))

        meta = {
            'val_mape': round(val_mape, 2),
            'best_iteration': model.best_iteration,
            'train_samples': len(X_train),
            'val_samples': len(X_val),
            'num_features': len(FEATURE_COLUMNS),
            'feature_importance': feat_imp,
            'trained_at': datetime.now().isoformat(),
        }
        with open(meta_path, 'w', encoding='utf-8') as f:
            json.dump(meta, f, indent=2, ensure_ascii=False)

        # ── 8. Hot-reload 模型 ──
        lgbm_strategy = forecaster_factory.get_strategy(ModelType.LIGHTGBM)
        if hasattr(lgbm_strategy, 'reload_model'):
            lgbm_strategy.reload_model()

        elapsed = time.time() - t0
        grade = "A+" if val_mape < 10 else "A" if val_mape < 20 else "B"

        return {
            "status": "deployed",
            "model_type": "lightgbm",
            "val_mape": round(val_mape, 2),
            "grade": grade,
            "best_iteration": model.best_iteration,
            "train_samples": len(X_train),
            "val_samples": len(X_val),
            "feature_importance_top5": dict(sorted(feat_imp.items(), key=lambda x: x[1], reverse=True)[:5]),
            "model_path": model_path,
            "elapsed_seconds": round(elapsed, 2),
            "message": f"✅ LightGBM 模型已更新並部署 (MAPE: {val_mape:.2f}%, 評級: {grade})"
        }

    except Exception as e:
        return {"error": str(e)}
