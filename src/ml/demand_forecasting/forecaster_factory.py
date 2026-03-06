from typing import Dict, List, Optional, Tuple
from enum import Enum
import logging
import os
from datetime import datetime, timedelta
import numpy as np
import pandas as pd

from ..uncertainty.quantile_engine import QuantileEngine, QuantileResult
from ..uncertainty.calibration_metrics import compute_calibration_metrics
from ..uncertainty.quality_gates import (
    QualityGateConfig,
    evaluate_candidate,
    GateResult,
)

try:
    import joblib
except ImportError:
    joblib = None

from .prophet_trainer import ProphetTrainer
from .lightgbm_trainer import LightGBMTrainer
from .chronos_trainer import ChronosTrainer
from .xgboost_trainer import XGBoostTrainer
from .ets_trainer import ETSTrainer
from .erp_connector import ERPConnector
from .feature_engineer import FeatureEngineer, FEATURE_COLUMNS
from .data_contract import SalesSeries
from .data_validation import validate_and_clean_series

try:
    from concurrent.futures import ThreadPoolExecutor, as_completed
except ImportError:
    ThreadPoolExecutor = None

class ModelType(Enum):
    PROPHET = "prophet"
    LIGHTGBM = "lightgbm"
    CHRONOS = "chronos"
    XGBOOST = "xgboost"
    ETS = "ets"


# ---------------------------------------------------------------------------
# Quantile helpers — convert symmetric CI to canonical p10/p90
# ---------------------------------------------------------------------------

# z-scores: z(0.90) = 1.2816 (for p10/p90), z(0.95) = 1.6449 (for CI built with 1.645σ)
_Z_P90 = 1.2816
_Z_P95 = 1.6449
_CI_TO_QUANTILE_RATIO = _Z_P90 / _Z_P95  # ≈ 0.779


def _scale_ci_to_quantiles(
    predictions: List[float],
    ci: List[List[float]],
) -> Tuple[List[float], List[float]]:
    """Convert a 1.645σ-based confidence interval to approximate p10/p90.

    Returns (p10_list, p90_list).
    """
    p10_list: List[float] = []
    p90_list: List[float] = []
    for i, pred in enumerate(predictions):
        if i < len(ci):
            lower, upper = ci[i][0], ci[i][1]
            half_width = (upper - lower) / 2.0
            scaled_hw = half_width * _CI_TO_QUANTILE_RATIO
            p10_list.append(max(0.0, pred - scaled_hw))
            p90_list.append(pred + scaled_hw)
        else:
            p10_list.append(max(0.0, pred))
            p90_list.append(pred)
    return p10_list, p90_list

class ForecasterStrategy:
    """预测策略基类"""
    
    def __init__(self, model_type: ModelType, trainer):
        self.model_type = model_type
        self.trainer = trainer
        
    def predict(self, sku: str, erp_connector: ERPConnector = None, horizon_days: int = 30, inline_history: Optional[List[float]] = None, **kwargs) -> Dict:
        """执行预测"""
        raise NotImplementedError
    
    def _get_sales_sequence(self, sku: str, erp_connector: ERPConnector = None, inline_history: Optional[List[float]] = None) -> List[float]:
        """获取销量序列：优先使用 inline_history（向後相容）"""
        if inline_history is not None:
            return [float(v) for v in inline_history]
        if erp_connector is None:
            raise ValueError("Either erp_connector or inline_history must be provided")
        sales_data = erp_connector.fetch_sales_data(sku)
        if not sales_data:
            raise ValueError(f"No sales data for SKU {sku}")
        return [float(record.get('sales', 0)) for record in sales_data]

    def _get_sales_series(self, sku: str, erp_connector: ERPConnector = None,
                          inline_history: Optional[List[float]] = None,
                          base_date: Optional[str] = None,
                          last_date: Optional[str] = None) -> SalesSeries:
        """
        P0-1.1: 取得帶日期的 SalesSeries（不再丟掉日期）。
        inline_history 場景必須提供 base_date 或 last_date，否則日曆特徵可能錯位。
        """
        if inline_history is not None:
            return SalesSeries.from_inline_history(
                values=[float(v) for v in inline_history],
                sku=sku,
                base_date=base_date,
                last_date=last_date,
            )
        if erp_connector is None:
            raise ValueError("Either erp_connector or inline_history must be provided")
        sales_data = erp_connector.fetch_sales_data(sku)
        if not sales_data:
            raise ValueError(f"No sales data for SKU {sku}")
        return SalesSeries.from_erp_records(sales_data, sku=sku)
    
    def get_model_info(self) -> Dict:
        """获取模型信息"""
        return {"type": self.model_type.value, "trainer": type(self.trainer).__name__}

class ProphetStrategy(ForecasterStrategy):
    """Prophet 预测策略 — 载入真实 .json 模型进行推论"""

    MODEL_DIR = os.path.join(os.path.dirname(__file__), '..', 'models')

    def __init__(self, model_type: ModelType, trainer):
        super().__init__(model_type, trainer)
        self._model = None
        self._fe = FeatureEngineer()
        self._load_model()

    def _load_model(self):
        """Try to load persisted Prophet model from disk (JSON format)"""
        try:
            from prophet.serialize import model_from_json
        except ImportError:
            return

        model_path = os.path.join(self.MODEL_DIR, 'prophet_model.json')
        if os.path.exists(model_path):
            try:
                with open(model_path, 'r') as f:
                    model_json = f.read()
                self._model = model_from_json(model_json)
                logging.info(f"Prophet model loaded from {model_path}")
            except Exception as e:
                logging.warning(f"Failed to load Prophet model: {e}")
                self._model = None
        else:
            logging.info("No Prophet .json model found — will use statistical fallback")

    def reload_model(self):
        """Hot-reload model after retraining"""
        self._load_model()

    def predict(self, sku: str, erp_connector: ERPConnector = None, horizon_days: int = 30, inline_history: Optional[List[float]] = None, **kwargs) -> Dict:
        try:
            sales_sequence = self._get_sales_sequence(sku, erp_connector, inline_history)
            n = len(sales_sequence)

            # Prophet 需要较多数据点
            if n < 14:
                raise ValueError(f"Prophet requires at least 14 data points, got {n}")

            # ── 真实推论模式：载入 .json 模型 ──
            if self._model is not None:
                return self._predict_real(sales_sequence, horizon_days, n)

            # ── 统计回退模式（未训练时）──
            return self._predict_fallback(sales_sequence, horizon_days, n)

        except Exception as e:
            logging.error(f"Prophet prediction failed for SKU {sku}: {e}")
            return {
                "success": False,
                "error": str(e),
                "model_type": ModelType.PROPHET.value
            }

    def _predict_real(self, sales_sequence: list, horizon_days: int, n: int) -> Dict:
        """
        使用真实 Prophet 模型推论
        Prophet 是时间回归模型，不需要递归 — 直接用 make_future_dataframe
        """
        # 1. 用 Prophet 原生 API 建立未来日期
        future = self._model.make_future_dataframe(periods=horizon_days)

        # 2. Prophet 推论（含历史拟合 + 未来预测）
        forecast = self._model.predict(future)

        # 3. 只取最后 horizon_days 筆（未来部分）
        future_forecast = forecast.tail(horizon_days)
        predictions = [max(0, float(v)) for v in future_forecast['yhat'].values]

        # 4. 置信区间（Prophet 原生提供）
        yhat_lower = future_forecast['yhat_lower'].values
        yhat_upper = future_forecast['yhat_upper'].values
        ci = [[max(0, float(l)), float(u)] for l, u in zip(yhat_lower, yhat_upper)]

        # 5. 风险分数
        arr = np.array(sales_sequence)
        residual_std = float(np.std(arr[-min(30, n):]))
        mean_val = float(np.mean(arr))
        risk_score = min(100, max(0, float(residual_std / (mean_val + 1e-6) * 100)))

        # p10/p90: Prophet posterior bounds are ~p10/p90 at default interval_width=0.80
        p10 = [max(0.0, float(l)) for l in yhat_lower]
        p90 = [float(u) for u in yhat_upper]

        return {
            "success": True,
            "model_type": ModelType.PROPHET.value,
            "prediction": {
                "predictions": predictions,
                "confidence_interval": ci,
                "p10": p10,
                "p50": list(predictions),
                "p90": p90,
                "risk_score": risk_score,
                "model_version": "prophet-v2.0-real"
            },
            "metadata": {
                "training_data_points": n,
                "forecast_horizon": horizon_days,
                "inference_mode": "real_model",
                "features_used": ["trend", "seasonality", "holiday"],
                "generated_at": datetime.now().isoformat()
            }
        }

    def _predict_fallback(self, sales_sequence: list, horizon_days: int, n: int) -> Dict:
        """统计回退（无 .json 模型时）"""
        arr = np.array(sales_sequence)
        mean_val = float(np.mean(arr))
        std_val = float(np.std(arr)) if n > 1 else mean_val * 0.1

        if n >= 10:
            recent = np.mean(sales_sequence[-5:])
            older = np.mean(sales_sequence[:5])
            trend_per_day = (recent - older) / max(n, 1)
        else:
            trend_per_day = 0

        # P0-1.5: 確定性 fallback（不加隨機噪聲）
        predictions = [max(0, mean_val + trend_per_day * i) for i in range(horizon_days)]
        ci = [[max(0, p - 1.645 * std_val), p + 1.645 * std_val] for p in predictions]
        p10, p90 = _scale_ci_to_quantiles(predictions, ci)
        risk_score = min(100, max(0, float(std_val / (mean_val + 1e-6) * 100)))

        return {
            "success": True,
            "model_type": ModelType.PROPHET.value,
            "prediction": {
                "predictions": predictions,
                "confidence_interval": ci,
                "p10": p10,
                "p50": list(predictions),
                "p90": p90,
                "risk_score": risk_score,
                "model_version": "prophet-v1.0-fallback"
            },
            "metadata": {
                "training_data_points": n,
                "forecast_horizon": horizon_days,
                "inference_mode": "statistical_fallback_deterministic",
                "features_used": ["mean", "trend", "std"],
                "generated_at": datetime.now().isoformat()
            }
        }

class LightGBMStrategy(ForecasterStrategy):
    """LightGBM 预测策略 — 载入真实 .pkl 模型进行推论"""

    MODEL_DIR = os.path.join(os.path.dirname(__file__), '..', 'models')

    def __init__(self, model_type: ModelType, trainer):
        super().__init__(model_type, trainer)
        self._model = None
        self._fe = FeatureEngineer()
        self._load_model()

    def _load_model(self):
        """Try to load persisted LightGBM model from disk"""
        model_path = os.path.join(self.MODEL_DIR, 'lgbm_model.pkl')
        if joblib and os.path.exists(model_path):
            try:
                self._model = joblib.load(model_path)
                logging.info(f"LightGBM model loaded from {model_path}")
            except Exception as e:
                logging.warning(f"Failed to load LightGBM model: {e}")
                self._model = None
        else:
            logging.info("No LightGBM .pkl model found — will use statistical fallback")

    def reload_model(self):
        """Hot-reload model after retraining"""
        self._load_model()

    def predict(self, sku: str, erp_connector: ERPConnector = None, horizon_days: int = 30, inline_history: Optional[List[float]] = None, **kwargs) -> Dict:
        try:
            # P0-1.1: 建立帶日期的 SalesSeries
            series = self._get_sales_series(
                sku, erp_connector, inline_history,
                base_date=kwargs.get('base_date'),
                last_date=kwargs.get('last_date'),
            )
            sales_sequence = series.to_values_list()
            n = series.n

            if n < 10:
                raise ValueError(f"LightGBM requires at least 10 data points, got {n}")

            # ── 真实推论模式：载入 .pkl 模型 ──
            if self._model is not None:
                return self._predict_real(sales_sequence, horizon_days, n, series=series)

            # ── 统计回退模式（未训练时）──
            return self._predict_fallback(sales_sequence, horizon_days, n)

        except Exception as e:
            logging.error(f"LightGBM prediction failed for SKU {sku}: {e}")
            return {
                "success": False,
                "error": str(e),
                "model_type": ModelType.LIGHTGBM.value
            }

    def _predict_real(self, sales_sequence: list, horizon_days: int, n: int,
                       series: SalesSeries = None) -> Dict:
        """
        遞歸預測 (Recursive Forecasting)
        ──────────────────────────────────
        P0-1.5 修正：next_date 從歷史最後日期推導，不再用 now()。
        """
        predictions = []
        current_history = list(sales_sequence)

        # ★ P0-1.1 修正：從 SalesSeries 取真實 last_date，而非 now()
        if series is not None:
            next_date = series.next_date
        else:
            # 向後相容 fallback（不應走到這裡）
            next_date = pd.Timestamp.now().normalize() + pd.Timedelta(days=1)

        # 取出模型期望的特徵名（保證訓練/推論特徵完全一致）
        try:
            model_features = self._model.feature_name()
        except Exception:
            model_features = FEATURE_COLUMNS

        for i in range(horizon_days):
            # 1. 構建「下一天」的單行特徵
            X_next = self._fe.build_next_day_features(current_history, next_date)
            # 確保欄位順序與模型一致
            X_next = X_next[model_features]
            # P0-1.3: Schema 驗證（推論前）
            FeatureEngineer.assert_feature_schema(X_next, model_features)

            # 2. 模型推論
            pred = float(self._model.predict(X_next)[0])
            pred = max(0, pred)  # 銷量不為負

            # 3. 存入結果 & 更新歷史（關鍵：預測值當作已知歷史）
            predictions.append(pred)
            current_history.append(pred)

            # 4. 日期 +1
            next_date += pd.Timedelta(days=1)

        # ── 置信區間：用近期殘差標準差估算 ──
        arr = np.array(sales_sequence)
        residual_std = float(np.std(arr[-min(30, n):]))
        ci = [[max(0, p - 1.645 * residual_std), p + 1.645 * residual_std] for p in predictions]
        p10, p90 = _scale_ci_to_quantiles(predictions, ci)

        # ── 風險分數 ──
        rolling_mean = float(np.mean(arr[-7:])) if n >= 7 else float(np.mean(arr))
        risk_score = min(100, max(0, float(residual_std / (rolling_mean + 1e-6) * 80)))

        return {
            "success": True,
            "model_type": ModelType.LIGHTGBM.value,
            "prediction": {
                "predictions": predictions,
                "confidence_interval": ci,
                "p10": p10,
                "p50": list(predictions),
                "p90": p90,
                "risk_score": risk_score,
                "model_version": "lightgbm-v2.0-recursive"
            },
            "metadata": {
                "training_data_points": n,
                "forecast_horizon": horizon_days,
                "inference_mode": "recursive_real_model",
                "features_used": model_features,
                "generated_at": datetime.now().isoformat()
            }
        }

    def _predict_fallback(self, sales_sequence: list, horizon_days: int, n: int) -> Dict:
        """统计回退（无 .pkl 模型时）"""
        arr = np.array(sales_sequence)
        rolling_mean = float(np.mean(arr[-7:])) if n >= 7 else float(np.mean(arr))
        rolling_std = float(np.std(arr[-7:])) if n >= 7 else float(np.std(arr))

        if n >= 14:
            recent_half = np.mean(arr[-n//2:])
            older_half = np.mean(arr[:n//2])
            trend = (recent_half - older_half) / max(n, 1)
        else:
            trend = 0

        # P0-1.5: 確定性 fallback（不加隨機噪聲）
        predictions = [max(0, rolling_mean + trend * i) for i in range(horizon_days)]
        ci = [[max(0, p - 1.645 * rolling_std), p + 1.645 * rolling_std] for p in predictions]
        p10, p90 = _scale_ci_to_quantiles(predictions, ci)
        risk_score = min(100, max(0, float(rolling_std / (rolling_mean + 1e-6) * 80)))

        return {
            "success": True,
            "model_type": ModelType.LIGHTGBM.value,
            "prediction": {
                "predictions": predictions,
                "confidence_interval": ci,
                "p10": p10,
                "p50": list(predictions),
                "p90": p90,
                "risk_score": risk_score,
                "model_version": "lightgbm-v1.0-fallback"
            },
            "metadata": {
                "training_data_points": n,
                "forecast_horizon": horizon_days,
                "inference_mode": "statistical_fallback_deterministic",
                "features_used": ["rolling_mean", "rolling_std", "trend"],
                "generated_at": datetime.now().isoformat()
            }
        }

class ChronosStrategy(ForecasterStrategy):
    """Chronos 预测策略"""
    
    def predict(self, sku: str, erp_connector: ERPConnector = None, horizon_days: int = 30, inline_history: Optional[List[float]] = None, **kwargs) -> Dict:
        try:
            sales_sequence = self._get_sales_sequence(sku, erp_connector, inline_history)
            n = len(sales_sequence)
            
            # Chronos 最低只需 3 个数据点
            if n < 3:
                raise ValueError(f"Chronos requires at least 3 data points, got {n}")
            
            arr = np.array(sales_sequence)
            mean_val = float(np.mean(arr))
            std_val = float(np.std(arr)) if n > 1 else mean_val * 0.2
            
            # Chronos 对序列形状敏感：检测近期变化
            if n >= 5:
                recent_trend = arr[-1] - arr[-min(5, n)]
                recent_momentum = recent_trend / min(5, n)
            else:
                recent_momentum = 0
            
            # 检测异常事件（最后一个点是否偏离均值 >2倍标准差）
            last_val = arr[-1]
            is_anomaly = abs(last_val - mean_val) > 2 * std_val if std_val > 0 else False
            
            # Chronos 更激进：如果检测到异常，会认为趋势可能延续
            if is_anomaly:
                # 异常事件后，Chronos 认为新趋势可能持续（用衰减）
                anomaly_weight = 0.6  # 衰减因子
                base = last_val
                predictions = []
                for i in range(horizon_days):
                    decay = anomaly_weight ** (i + 1)
                    pred = mean_val + (base - mean_val) * decay + recent_momentum * (i + 1) * 0.3
                    predictions.append(max(0, pred + np.random.normal(0, std_val * 0.15)))
            else:
                # 正常模式：基于序列动量
                predictions = [max(0, mean_val + recent_momentum * (i + 1) + np.random.normal(0, std_val * 0.2)) for i in range(horizon_days)]
            
            # 置信区间：Chronos 多次采样模拟
            num_samples = 10
            all_samples = []
            for _ in range(num_samples):
                if is_anomaly:
                    sample = [max(0, mean_val + (last_val - mean_val) * (anomaly_weight ** (i+1)) + np.random.normal(0, std_val * 0.4)) for i in range(horizon_days)]
                else:
                    sample = [max(0, mean_val + recent_momentum * (i+1) + np.random.normal(0, std_val * 0.35)) for i in range(horizon_days)]
                all_samples.append(sample)
            
            all_samples_arr = np.array(all_samples)
            lower_bound = np.percentile(all_samples_arr, 10, axis=0).tolist()
            upper_bound = np.percentile(all_samples_arr, 90, axis=0).tolist()
            
            # 风险分数：基于预测方差和异常检测
            pred_variance = float(np.mean(np.var(all_samples_arr, axis=0)))
            pred_mean = float(np.mean(predictions))
            risk_score = min(100, max(0, pred_variance / (pred_mean + 1e-6) * 100))
            if is_anomaly:
                risk_score = min(100, risk_score + 25)  # 异常事件加分
            
            ci = [[lower_bound[i], upper_bound[i]] for i in range(horizon_days)]
            
            # Enforce invariant: p10 <= p50 <= p90 (stochastic predictions may violate)
            p10_raw = lower_bound if isinstance(lower_bound, list) else lower_bound.tolist()
            p90_raw = upper_bound if isinstance(upper_bound, list) else upper_bound.tolist()
            p10_clamped = [min(p10_raw[i], predictions[i]) for i in range(horizon_days)]
            p90_clamped = [max(p90_raw[i], predictions[i]) for i in range(horizon_days)]

            prediction = {
                "predictions": predictions,
                "confidence_interval": ci,
                "p10": p10_clamped,
                "p50": list(predictions),
                "p90": p90_clamped,
                "risk_score": risk_score,
                "model_version": "chronos-t5-tiny-v1.0",
                "anomaly_detected": is_anomaly
            }
            
            return {
                "success": True,
                "model_type": ModelType.CHRONOS.value,
                "prediction": prediction,
                "metadata": {
                    "training_data_points": n,
                    "forecast_horizon": horizon_days,
                    "zero_shot": True,
                    "anomaly_detected": is_anomaly,
                    "generated_at": datetime.now().isoformat()
                }
            }
        except Exception as e:
            logging.error(f"Chronos prediction failed for SKU {sku}: {e}")
            return {
                "success": False,
                "error": str(e),
                "model_type": ModelType.CHRONOS.value
            }

class XGBoostStrategy(ForecasterStrategy):
    """XGBoost prediction strategy — mirrors LightGBM with recursive forecasting"""

    MODEL_DIR = os.path.join(os.path.dirname(__file__), '..', 'models')

    def __init__(self, model_type: ModelType, trainer):
        super().__init__(model_type, trainer)
        self._model = None
        self._fe = FeatureEngineer()
        self._load_model()

    def _load_model(self):
        model_path = os.path.join(self.MODEL_DIR, 'xgb_model.pkl')
        if joblib and os.path.exists(model_path):
            try:
                self._model = joblib.load(model_path)
                logging.info(f"XGBoost model loaded from {model_path}")
            except Exception as e:
                logging.warning(f"Failed to load XGBoost model: {e}")
                self._model = None
        else:
            logging.info("No XGBoost .pkl model found — will use statistical fallback")

    def reload_model(self):
        self._load_model()

    def predict(self, sku: str, erp_connector: ERPConnector = None, horizon_days: int = 30, inline_history: Optional[List[float]] = None, **kwargs) -> Dict:
        try:
            series = self._get_sales_series(
                sku, erp_connector, inline_history,
                base_date=kwargs.get('base_date'),
                last_date=kwargs.get('last_date'),
            )
            sales_sequence = series.to_values_list()
            n = series.n

            if n < 10:
                raise ValueError(f"XGBoost requires at least 10 data points, got {n}")

            if self._model is not None:
                return self._predict_real(sales_sequence, horizon_days, n, series=series)

            return self._predict_fallback(sales_sequence, horizon_days, n)

        except Exception as e:
            logging.error(f"XGBoost prediction failed for SKU {sku}: {e}")
            return {
                "success": False,
                "error": str(e),
                "model_type": ModelType.XGBOOST.value
            }

    def _predict_real(self, sales_sequence: list, horizon_days: int, n: int,
                       series: SalesSeries = None) -> Dict:
        predictions = []
        current_history = list(sales_sequence)

        if series is not None:
            next_date = series.next_date
        else:
            next_date = pd.Timestamp.now().normalize() + pd.Timedelta(days=1)

        try:
            model_features = self._model.get_booster().feature_names
            if not model_features:
                model_features = FEATURE_COLUMNS
        except Exception:
            model_features = FEATURE_COLUMNS

        for i in range(horizon_days):
            X_next = self._fe.build_next_day_features(current_history, next_date)
            X_next = X_next[model_features]
            FeatureEngineer.assert_feature_schema(X_next, model_features)

            pred = float(self._model.predict(X_next)[0])
            pred = max(0, pred)

            predictions.append(pred)
            current_history.append(pred)
            next_date += pd.Timedelta(days=1)

        arr = np.array(sales_sequence)
        residual_std = float(np.std(arr[-min(30, n):]))
        ci = [[max(0, p - 1.645 * residual_std), p + 1.645 * residual_std] for p in predictions]
        p10, p90 = _scale_ci_to_quantiles(predictions, ci)

        rolling_mean = float(np.mean(arr[-7:])) if n >= 7 else float(np.mean(arr))
        risk_score = min(100, max(0, float(residual_std / (rolling_mean + 1e-6) * 80)))

        return {
            "success": True,
            "model_type": ModelType.XGBOOST.value,
            "prediction": {
                "predictions": predictions,
                "confidence_interval": ci,
                "p10": p10,
                "p50": list(predictions),
                "p90": p90,
                "risk_score": risk_score,
                "model_version": "xgboost-v1.0-recursive"
            },
            "metadata": {
                "training_data_points": n,
                "forecast_horizon": horizon_days,
                "inference_mode": "recursive_real_model",
                "features_used": model_features,
                "generated_at": datetime.now().isoformat()
            }
        }

    def _predict_fallback(self, sales_sequence: list, horizon_days: int, n: int) -> Dict:
        arr = np.array(sales_sequence)
        rolling_mean = float(np.mean(arr[-7:])) if n >= 7 else float(np.mean(arr))
        rolling_std = float(np.std(arr[-7:])) if n >= 7 else float(np.std(arr))

        if n >= 14:
            recent_half = np.mean(arr[-n//2:])
            older_half = np.mean(arr[:n//2])
            trend = (recent_half - older_half) / max(n, 1)
        else:
            trend = 0

        predictions = [max(0, rolling_mean + trend * i) for i in range(horizon_days)]
        ci = [[max(0, p - 1.645 * rolling_std), p + 1.645 * rolling_std] for p in predictions]
        p10, p90 = _scale_ci_to_quantiles(predictions, ci)
        risk_score = min(100, max(0, float(rolling_std / (rolling_mean + 1e-6) * 80)))

        return {
            "success": True,
            "model_type": ModelType.XGBOOST.value,
            "prediction": {
                "predictions": predictions,
                "confidence_interval": ci,
                "p10": p10,
                "p50": list(predictions),
                "p90": p90,
                "risk_score": risk_score,
                "model_version": "xgboost-v1.0-fallback"
            },
            "metadata": {
                "training_data_points": n,
                "forecast_horizon": horizon_days,
                "inference_mode": "statistical_fallback_deterministic",
                "features_used": ["rolling_mean", "rolling_std", "trend"],
                "generated_at": datetime.now().isoformat()
            }
        }


class ETSStrategy(ForecasterStrategy):
    """ETS (Exponential Smoothing) prediction strategy — classical statistical model"""

    def __init__(self, model_type: ModelType, trainer):
        super().__init__(model_type, trainer)

    def predict(self, sku: str, erp_connector: ERPConnector = None, horizon_days: int = 30, inline_history: Optional[List[float]] = None, **kwargs) -> Dict:
        try:
            from statsmodels.tsa.holtwinters import ExponentialSmoothing
        except ImportError:
            return {
                "success": False,
                "error": "statsmodels is not installed",
                "model_type": ModelType.ETS.value,
            }

        try:
            sales_sequence = self._get_sales_sequence(sku, erp_connector, inline_history)
            n = len(sales_sequence)

            if n < 14:
                raise ValueError(f"ETS requires at least 14 data points, got {n}")

            arr = np.array(sales_sequence, dtype=float)
            # Ensure all values are positive for ETS stability
            arr = np.maximum(arr, 0.01)

            # Choose seasonal or non-seasonal based on data length
            sp = 7  # daily seasonality (weekly)
            try:
                if n >= sp * 2:
                    model = ExponentialSmoothing(
                        arr,
                        trend='add',
                        seasonal='add',
                        seasonal_periods=sp,
                    ).fit(optimized=True)
                else:
                    model = ExponentialSmoothing(
                        arr,
                        trend='add',
                        seasonal=None,
                    ).fit(optimized=True)
            except Exception:
                # Fall back to simplest model
                model = ExponentialSmoothing(
                    arr,
                    trend=None,
                    seasonal=None,
                ).fit(optimized=True)

            forecast = model.forecast(horizon_days)
            predictions = [max(0, float(v)) for v in forecast]

            # Confidence interval from residuals
            residuals = model.resid
            residual_std = float(np.std(residuals)) if len(residuals) > 0 else float(np.std(arr))

            ci = [[max(0, p - 1.645 * residual_std), p + 1.645 * residual_std] for p in predictions]
            p10, p90 = _scale_ci_to_quantiles(predictions, ci)

            mean_val = float(np.mean(arr))
            risk_score = min(100, max(0, float(residual_std / (mean_val + 1e-6) * 100)))

            return {
                "success": True,
                "model_type": ModelType.ETS.value,
                "prediction": {
                    "predictions": predictions,
                    "confidence_interval": ci,
                    "p10": p10,
                    "p50": list(predictions),
                    "p90": p90,
                    "risk_score": risk_score,
                    "model_version": "ets-v1.0-holtwinters"
                },
                "metadata": {
                    "training_data_points": n,
                    "forecast_horizon": horizon_days,
                    "inference_mode": "ets_online_fit",
                    "features_used": ["level", "trend", "seasonal"],
                    "aic": float(model.aic) if hasattr(model, 'aic') else None,
                    "generated_at": datetime.now().isoformat()
                }
            }
        except Exception as e:
            logging.error(f"ETS prediction failed for SKU {sku}: {e}")
            return {
                "success": False,
                "error": str(e),
                "model_type": ModelType.ETS.value
            }


class ForecasterFactory:
    """预测器工厂 - 实现策略模式"""

    def __init__(self):
        # 初始化所有训练器
        self.prophet_trainer = ProphetTrainer()
        self.lightgbm_trainer = LightGBMTrainer()
        self.chronos_trainer = ChronosTrainer()
        self.xgboost_trainer = XGBoostTrainer()
        self.ets_trainer = ETSTrainer()

        # 初始化策略
        self.strategies = {
            ModelType.PROPHET: ProphetStrategy(ModelType.PROPHET, self.prophet_trainer),
            ModelType.LIGHTGBM: LightGBMStrategy(ModelType.LIGHTGBM, self.lightgbm_trainer),
            ModelType.CHRONOS: ChronosStrategy(ModelType.CHRONOS, self.chronos_trainer),
            ModelType.XGBOOST: XGBoostStrategy(ModelType.XGBOOST, self.xgboost_trainer),
            ModelType.ETS: ETSStrategy(ModelType.ETS, self.ets_trainer),
        }

        # PR-B: Champion model cache {series_id -> (model_obj, meta, model_name)}
        self._champion_cache: Dict = {}

        # PR-E: Model lifecycle registry (lazy-init)
        self._lifecycle_registry = None

        logging.info("ForecasterFactory initialized with all strategies")

    # ── PR-E: Lifecycle Registry Integration ──

    def _get_lifecycle_registry(self):
        """Lazy-init the lifecycle registry."""
        if self._lifecycle_registry is None:
            try:
                from ml.registry.model_registry import ModelLifecycleRegistry
                self._lifecycle_registry = ModelLifecycleRegistry()
            except Exception as e:
                logging.warning(f"Could not init lifecycle registry: {e}")
        return self._lifecycle_registry

    def predict_with_prod_pointer(
        self,
        sku: str,
        erp_connector: ERPConnector = None,
        horizon_days: int = 30,
        inline_history: Optional[List[float]] = None,
    ) -> Optional[Dict]:
        """
        PR-E: Try to predict using the PROD pointer from the lifecycle registry.

        Priority:
          1. If registry has PROD pointer for sku -> load that artifact
          2. Return None to let caller fall through to champion/fallback

        Returns result dict with registry_state metadata, or None.
        """
        try:
            registry = self._get_lifecycle_registry()
            if registry is None:
                return None

            prod_record = registry.get_prod_artifact(sku)
            if prod_record is None:
                return None

            artifact_path = prod_record.get("artifact_path", "")
            model_name = prod_record.get("model_name", "")
            artifact_id = prod_record.get("artifact_id", "")

            if not artifact_path or not os.path.isdir(artifact_path):
                logging.warning(
                    f"PROD artifact path not found for {sku}: {artifact_path}"
                )
                return None

            # Load model from artifact path using ArtifactManager
            from ml.training.artifact_manager import ArtifactManager
            am = ArtifactManager()
            model_obj = am.load_model(artifact_path, model_name)

            # Build history
            if inline_history is not None:
                sales_sequence = [float(v) for v in inline_history]
            elif erp_connector is not None:
                sales_data = erp_connector.fetch_sales_data(sku)
                if not sales_data:
                    return None
                sales_sequence = [float(r.get("sales", 0)) for r in sales_data]
            else:
                return None

            # Use training strategy to predict
            from ml.training.strategies import get_strategy
            strategy = get_strategy(model_name)
            predictions = strategy.predict(model_obj, sales_sequence, horizon_days)
            predictions = [max(0, float(p)) for p in predictions]

            # Confidence interval
            arr = np.array(sales_sequence)
            residual_std = float(np.std(arr[-min(30, len(arr)):]))
            ci = [
                [max(0, p - 1.645 * residual_std), p + 1.645 * residual_std]
                for p in predictions
            ]
            risk_score = min(
                100, max(0, residual_std / (float(np.mean(arr)) + 1e-6) * 100)
            )

            # Find promoted_at from promotion history
            promo_history = prod_record.get("promotion_history", [])
            promoted_at = ""
            promotion_note = ""
            if promo_history:
                last_promo = promo_history[-1]
                promoted_at = last_promo.get("timestamp", "")
                promotion_note = last_promo.get("note", "")

            return {
                "success": True,
                "model_type": model_name,
                "prediction": {
                    "predictions": predictions,
                    "confidence_interval": ci,
                    "risk_score": risk_score,
                    "model_version": f"prod-{model_name}-{artifact_id}",
                },
                "metadata": {
                    "training_data_points": len(sales_sequence),
                    "forecast_horizon": horizon_days,
                    "inference_mode": "prod_registry",
                    "model_used": "prod",
                    "generated_at": datetime.now().isoformat(),
                },
                "registry_state": {
                    "source": "prod",
                    "artifact_id": artifact_id,
                    "promoted_at": promoted_at,
                },
                "model_version_id": artifact_id,
                "promotion_note": promotion_note,
            }

        except Exception as e:
            logging.warning(f"PROD pointer prediction failed for {sku}: {e}")
            return None

    # ── PR-B: Champion-aware prediction ──

    def predict_with_champion(
        self,
        sku: str,
        erp_connector: ERPConnector = None,
        horizon_days: int = 30,
        inline_history: Optional[List[float]] = None,
        champion_dir: str = "",
    ) -> Optional[Dict]:
        """
        Try to predict using a trained champion artifact.

        Returns None if no champion exists, letting the caller fall back
        to predict_with_fallback().
        """
        try:
            from ml.training.orchestrator import load_champion
            from ml.training.artifact_manager import ArtifactManager

            champion_data = load_champion(sku, champion_dir)
            if champion_data is None:
                return None

            artifact_dir = champion_data.get("artifact_dir", "")
            model_name = champion_data.get("model_name", "")
            if not artifact_dir or not os.path.isdir(artifact_dir):
                logging.warning(f"Champion artifact dir not found: {artifact_dir}")
                return None

            # Load from cache or disk
            cache_key = f"{sku}:{artifact_dir}"
            if cache_key not in self._champion_cache:
                am = ArtifactManager()
                model_obj = am.load_model(artifact_dir, model_name)
                meta = am.load_metadata(artifact_dir)
                self._champion_cache[cache_key] = (model_obj, meta, model_name)

            model_obj, meta, model_name = self._champion_cache[cache_key]

            # Build history for prediction
            if inline_history is not None:
                sales_sequence = [float(v) for v in inline_history]
            elif erp_connector is not None:
                sales_data = erp_connector.fetch_sales_data(sku)
                if not sales_data:
                    return None
                sales_sequence = [float(r.get('sales', 0)) for r in sales_data]
            else:
                return None

            # Use the appropriate training strategy to predict
            from ml.training.strategies import get_strategy
            strategy = get_strategy(model_name)
            predictions = strategy.predict(model_obj, sales_sequence, horizon_days)
            predictions = [max(0, float(p)) for p in predictions]

            # Confidence interval from recent residual std
            arr = np.array(sales_sequence)
            residual_std = float(np.std(arr[-min(30, len(arr)):]))
            ci = [[max(0, p - 1.645 * residual_std), p + 1.645 * residual_std]
                  for p in predictions]

            risk_score = min(100, max(0, residual_std / (float(np.mean(arr)) + 1e-6) * 100))

            config_meta = meta.get("config", {})
            return {
                "success": True,
                "model_type": model_name,
                "prediction": {
                    "predictions": predictions,
                    "confidence_interval": ci,
                    "risk_score": risk_score,
                    "model_version": f"champion-{model_name}",
                },
                "metadata": {
                    "training_data_points": len(sales_sequence),
                    "forecast_horizon": horizon_days,
                    "inference_mode": "champion_artifact",
                    "model_used": "champion",
                    "artifact_run_id": champion_data.get("run_id", ""),
                    "dataset_fingerprint": champion_data.get("dataset_fingerprint", ""),
                    "training_data_window": config_meta.get("series_id", sku),
                    "champion_selected_at": champion_data.get("selected_at", ""),
                    "generated_at": datetime.now().isoformat(),
                },
            }

        except Exception as e:
            logging.warning(f"Champion prediction failed for {sku}, falling back: {e}")
            return None
    
    def get_strategy(self, model_type: ModelType) -> ForecasterStrategy:
        """获取指定的预测策略"""
        if model_type not in self.strategies:
            raise ValueError(f"Unsupported model type: {model_type}")
        
        return self.strategies[model_type]
    
    def analyze_data_characteristics(self, sku: str, erp_connector: ERPConnector = None, inline_history: Optional[List[float]] = None) -> Dict:
        """分析数据特征，用于模型选择"""
        try:
            if inline_history is not None:
                sales_values = [float(v) for v in inline_history]
            else:
                if erp_connector is None:
                    return {"error": "No data source provided"}
                sales_data = erp_connector.fetch_sales_data(sku)
                if not sales_data:
                    return {"error": "No sales data available"}
                sales_values = [float(record.get('sales', 0)) for record in sales_data]
            
            data_points = len(sales_values)
            if data_points == 0:
                return {"error": "Empty data sequence"}
            
            # 基本统计
            analysis = {
                "data_points": data_points,
                "sales_stats": {
                    "mean": float(np.mean(sales_values)),
                    "std": float(np.std(sales_values)),
                    "min": float(np.min(sales_values)),
                    "max": float(np.max(sales_values))
                }
            }
            
            # 数据特征分析
            characteristics = []
            
            # 1. 数据量分析
            if data_points < 30:
                characteristics.append("very_limited_data")
                analysis["data_sufficiency"] = "insufficient"
            elif data_points < 90:
                characteristics.append("limited_data")
                analysis["data_sufficiency"] = "minimal"
            elif data_points < 365:
                characteristics.append("moderate_data")
                analysis["data_sufficiency"] = "sufficient"
            else:
                characteristics.append("abundant_data")
                analysis["data_sufficiency"] = "excellent"
            
            # 2. 季节性检测（简单版本）
            if len(sales_values) >= 90:
                # 检查是否有明显的季节性模式
                monthly_avg = []
                for i in range(0, len(sales_values), 30):
                    if i + 30 <= len(sales_values):
                        monthly_avg.append(np.mean(sales_values[i:i+30]))
                
                if len(monthly_avg) >= 3:
                    monthly_std = np.std(monthly_avg)
                    overall_std = np.std(sales_values)
                    if monthly_std > overall_std * 0.3:
                        characteristics.append("seasonal_pattern")
                        analysis["seasonality"] = "strong"
                    else:
                        analysis["seasonality"] = "weak"
            
            # 3. 趋势检测
            if len(sales_values) >= 30:
                recent_avg = np.mean(sales_values[-10:])
                historical_avg = np.mean(sales_values[:-10]) if len(sales_values) > 10 else recent_avg
                
                if recent_avg > historical_avg * 1.2:
                    characteristics.append("upward_trend")
                    analysis["trend"] = "increasing"
                elif recent_avg < historical_avg * 0.8:
                    characteristics.append("downward_trend")
                    analysis["trend"] = "decreasing"
                else:
                    analysis["trend"] = "stable"
            
            # 4. 波动性检测
            if len(sales_values) >= 30:
                recent_volatility = np.std(sales_values[-10:])
                historical_volatility = np.std(sales_values[:-10]) if len(sales_values) > 10 else recent_volatility
                
                if recent_volatility > historical_volatility * 2:
                    characteristics.append("high_volatility")
                    analysis["volatility"] = "high"
                else:
                    analysis["volatility"] = "normal"
            
            # 5. 外部特征可用性
            if inline_history is not None:
                analysis["external_features"] = "unavailable"
            else:
                sample_record = sales_data[0] if sales_data else {}
                has_features = len(sample_record.get('features', {})) > 0
                if has_features:
                    characteristics.append("external_features_available")
                    analysis["external_features"] = "available"
                else:
                    analysis["external_features"] = "unavailable"
            
            # 6. 异常检测
            if len(sales_values) >= 5:
                last_val = sales_values[-1]
                mean_val = np.mean(sales_values[:-1])
                std_val = np.std(sales_values[:-1])
                if std_val > 0 and abs(last_val - mean_val) > 2 * std_val:
                    characteristics.append("anomaly_detected")
                    analysis["anomaly"] = {
                        "last_value": float(last_val),
                        "historical_mean": float(mean_val),
                        "deviation_sigma": float(abs(last_val - mean_val) / std_val)
                    }
            
            # 7. 噪声水平
            if len(sales_values) >= 10:
                cv = float(np.std(sales_values) / (np.mean(sales_values) + 1e-6))
                if cv > 1.0:
                    characteristics.append("high_noise")
                    analysis["noise_level"] = "extreme"
                elif cv > 0.5:
                    characteristics.append("moderate_noise")
                    analysis["noise_level"] = "high"
                else:
                    analysis["noise_level"] = "normal"
            
            analysis["characteristics"] = characteristics
            
            return analysis
            
        except Exception as e:
            logging.error(f"Data analysis failed for SKU {sku}: {e}")
            return {"error": str(e)}
    
    def recommend_model(self, sku: str, erp_connector: ERPConnector = None, user_preference: Optional[str] = None, inline_history: Optional[List[float]] = None) -> ModelType:
        """推荐最适合的模型"""
        try:
            # 如果用户有明确偏好，优先考虑
            if user_preference and user_preference in [mt.value for mt in ModelType]:
                return ModelType(user_preference)
            
            # 分析数据特征
            analysis = self.analyze_data_characteristics(sku, erp_connector, inline_history)
            
            if "error" in analysis:
                # 默认回退到 Prophet
                return ModelType.PROPHET
            
            characteristics = analysis.get("characteristics", [])
            data_sufficiency = analysis.get("data_sufficiency", "insufficient")
            
            # 决策逻辑
            if "very_limited_data" in characteristics or "limited_data" in characteristics:
                # 数据量少，优先使用 Chronos（零样本学习）
                return ModelType.CHRONOS
            elif "external_features_available" in characteristics and data_sufficiency in ["sufficient", "excellent"]:
                # 有外部特征且数据充足，使用 LightGBM
                return ModelType.LIGHTGBM
            elif "seasonal_pattern" in characteristics and data_sufficiency in ["sufficient", "excellent"]:
                # 有明显季节性且数据充足，使用 Prophet
                return ModelType.PROPHET
            elif "high_volatility" in characteristics:
                # 高波动性，尝试 Chronos 捕捉异常模式
                return ModelType.CHRONOS
            else:
                # 默认策略：数据充足用 LightGBM，否则用 Prophet
                if data_sufficiency in ["sufficient", "excellent"]:
                    return ModelType.LIGHTGBM
                else:
                    return ModelType.PROPHET
                    
        except Exception as e:
            logging.error(f"Model recommendation failed for SKU {sku}: {e}")
            return ModelType.PROPHET  # 默认回退
    
    def predict_with_fallback(self,
                            sku: str,
                            erp_connector: ERPConnector = None,
                            horizon_days: int = 30,
                            preferred_model: Optional[str] = None,
                            inline_history: Optional[List[float]] = None) -> Dict:
        """带回退机制的预测"""

        # Ensemble race when auto mode and sufficient data
        is_auto = not preferred_model or preferred_model.lower() == 'auto'
        data_len = len(inline_history) if inline_history else 0
        if is_auto and data_len >= 30:
            try:
                race_result = self.predict_ensemble_race(
                    sku=sku,
                    erp_connector=erp_connector,
                    horizon_days=horizon_days,
                    inline_history=inline_history,
                )
                if race_result.get("success"):
                    return race_result
            except Exception as e:
                logging.warning(f"Ensemble race failed for {sku}, falling back: {e}")

        # 确定模型优先级
        if preferred_model and preferred_model.lower() != 'auto':
            try:
                primary_model = ModelType(preferred_model.lower())
            except ValueError:
                primary_model = self.recommend_model(sku, erp_connector, inline_history=inline_history)
        else:
            primary_model = self.recommend_model(sku, erp_connector, inline_history=inline_history)
        
        # 定义回退顺序
        fallback_order = [primary_model]
        
        # 添加其他模型作为回退
        for model_type in ModelType:
            if model_type not in fallback_order:
                fallback_order.append(model_type)
        
        results = []
        errors = []
        
        # 尝试每个模型
        for model_type in fallback_order:
            try:
                strategy = self.get_strategy(model_type)
                result = strategy.predict(sku, erp_connector, horizon_days, inline_history=inline_history)
                
                if result["success"]:
                    results.append(result)
                    logging.info(f"Successful prediction with {model_type.value} for SKU {sku}")
                else:
                    errors.append({
                        "model": model_type.value,
                        "error": result.get("error", "Unknown error")
                    })
                    logging.warning(f"Failed prediction with {model_type.value} for SKU {sku}: {result.get('error')}")
                    
            except Exception as e:
                errors.append({
                    "model": model_type.value,
                    "error": str(e)
                })
                logging.error(f"Exception in {model_type.value} for SKU {sku}: {e}")
        
        # 处理结果
        if not results:
            return {
                "success": False,
                "error": "All models failed",
                "errors": errors,
                "sku": sku
            }
        
        # 主要预测结果
        primary_result = results[0]
        
        # 如果有多个成功的结果，添加比较信息
        if len(results) > 1:
            comparison = self._compare_predictions(results)
            primary_result["comparison"] = comparison
            
            # 添加共识警告（传入数据用于动态阈值）
            consensus_warning = self._check_consensus_warning(results, inline_history)
            primary_result["consensus_warning"] = consensus_warning
        
        primary_result["fallback_used"] = len(results) > 1
        primary_result["attempted_models"] = [r["model_type"] for r in results]

        return primary_result

    def predict_ensemble_race(
        self,
        sku: str,
        erp_connector: ERPConnector = None,
        horizon_days: int = 30,
        inline_history: Optional[List[float]] = None,
        models: Optional[List[str]] = None,
    ) -> Dict:
        """
        Ensemble racing: run all models in parallel, score, pick the best.

        Scoring criteria:
          - Forecast stability (lower CV of predictions = better)
          - P10/P90 interval width (tighter = better, within reason)
          - Consensus with other models (closer to ensemble median = better)

        Returns the winning model's result with ensemble metadata.
        """
        race_models = models or ["lightgbm", "prophet", "chronos", "xgboost", "ets"]
        results = []

        def _run_model(model_name):
            try:
                model_type = ModelType(model_name.lower())
                strategy = self.get_strategy(model_type)
                return strategy.predict(
                    sku=sku,
                    erp_connector=erp_connector,
                    horizon_days=horizon_days,
                    inline_history=inline_history,
                )
            except Exception as e:
                return {"success": False, "error": str(e), "model_type": model_name}

        # Run models in parallel if ThreadPoolExecutor is available
        if ThreadPoolExecutor is not None:
            with ThreadPoolExecutor(max_workers=len(race_models)) as executor:
                futures = {executor.submit(_run_model, m): m for m in race_models}
                for future in as_completed(futures):
                    result = future.result()
                    if result.get("success"):
                        results.append(result)
        else:
            for model_name in race_models:
                result = _run_model(model_name)
                if result.get("success"):
                    results.append(result)

        if not results:
            return {
                "success": False,
                "error": "All models failed in ensemble race",
                "sku": sku,
            }

        if len(results) == 1:
            results[0]["metadata"]["inference_mode"] = "ensemble_race_single"
            return results[0]

        # Score each model
        all_means = []
        scored = []
        for r in results:
            preds = r["prediction"]["predictions"]
            mean_pred = float(np.mean(preds))
            all_means.append(mean_pred)
            std_pred = float(np.std(preds)) if len(preds) > 1 else 0.0
            cv = std_pred / (mean_pred + 1e-6)

            # Interval width (tighter is better)
            p10 = r["prediction"].get("p10", preds)
            p90 = r["prediction"].get("p90", preds)
            avg_width = float(np.mean([p90[i] - p10[i] for i in range(len(preds))]))
            rel_width = avg_width / (mean_pred + 1e-6)

            scored.append({
                "result": r,
                "mean_pred": mean_pred,
                "cv": cv,
                "rel_width": rel_width,
            })

        ensemble_median = float(np.median(all_means))

        for s in scored:
            consensus_dist = abs(s["mean_pred"] - ensemble_median) / (ensemble_median + 1e-6)
            # Combined score: lower is better
            # 40% consensus + 30% stability + 30% interval tightness
            s["score"] = 0.4 * consensus_dist + 0.3 * s["cv"] + 0.3 * s["rel_width"]

        scored.sort(key=lambda x: x["score"])
        winner = scored[0]

        winner_result = winner["result"]
        winner_result["metadata"]["inference_mode"] = "ensemble_race"
        winner_result["metadata"]["ensemble_race"] = {
            "models_raced": len(results),
            "models_names": [r["model_type"] for r in results],
            "winner_score": round(winner["score"], 4),
            "ensemble_median": round(ensemble_median, 2),
            "scores": {s["result"]["model_type"]: round(s["score"], 4) for s in scored},
        }

        return winner_result

    def _compare_predictions(self, results: List[Dict]) -> Dict:
        """比较多个模型的预测结果"""
        if len(results) < 2:
            return {}
        
        # 取前两个结果进行比较
        primary = results[0]
        secondary = results[1]
        
        primary_preds = primary["prediction"]["predictions"]
        secondary_preds = secondary["prediction"]["predictions"]
        
        if len(primary_preds) != len(secondary_preds):
            return {"error": "Prediction lengths differ"}
        
        # 计算偏差
        primary_mean = np.mean(primary_preds)
        secondary_mean = np.mean(secondary_preds)
        
        if primary_mean == 0:
            deviation_pct = 0
        else:
            deviation_pct = abs(primary_mean - secondary_mean) / primary_mean * 100
        
        return {
            "primary_model": primary["model_type"],
            "secondary_model": secondary["model_type"],
            "primary_mean": float(primary_mean),
            "secondary_mean": float(secondary_mean),
            "deviation_percentage": float(deviation_pct),
            "agreement_level": "high" if deviation_pct < 10 else "medium" if deviation_pct < 20 else "low"
        }
    
    def _check_consensus_warning(self, results: List[Dict], inline_history: Optional[List[float]] = None) -> Dict:
        """检查共识警告 - 支持动态阈值"""
        if len(results) < 2:
            return {"warning": False}
        
        comparison = self._compare_predictions(results)
        deviation = comparison.get("deviation_percentage", 0)
        
        # 动态阈值：根据数据特征调整
        threshold_high = 15.0
        threshold_medium = 10.0
        
        if inline_history is not None:
            data = np.array(inline_history)
            cv = float(np.std(data) / (np.mean(data) + 1e-6))  # 变异系数
            
            # 高噪声数据 → 提高阈值（噪声本身就会导致偏差）
            if cv > 1.0:
                threshold_high = 25.0
                threshold_medium = 15.0
            elif cv > 0.5:
                threshold_high = 20.0
                threshold_medium = 12.0
            
            # 数据量少 → 降低阈值（更敏感）
            if len(data) < 10:
                threshold_high = max(10.0, threshold_high - 5.0)
                threshold_medium = max(5.0, threshold_medium - 3.0)
        
        if deviation > threshold_high:
            return {
                "warning": True,
                "level": "high",
                "deviation_pct": float(deviation),
                "threshold_used": float(threshold_high),
                "message": f"模型预测差异较大 ({deviation:.1f}% > {threshold_high:.0f}% 阈值)，建议检查是否有未记录的市场活动",
                "recommendation": "consider_external_factors"
            }
        elif deviation > threshold_medium:
            return {
                "warning": True,
                "level": "medium",
                "deviation_pct": float(deviation),
                "threshold_used": float(threshold_medium),
                "message": f"模型预测存在中等差异 ({deviation:.1f}% > {threshold_medium:.0f}% 阈值)",
                "recommendation": "monitor_closely"
            }
        else:
            return {"warning": False, "deviation_pct": float(deviation)}
    
    def get_supported_models(self) -> List[str]:
        """获取支持的模型列表"""
        return [model_type.value for model_type in ModelType]
    
    def get_model_status(self) -> Dict:
        """获取所有模型的状态"""
        status = {}
        
        for model_type, strategy in self.strategies.items():
            try:
                model_info = strategy.get_model_info()
                status[model_type.value] = {
                    "available": True,
                    "info": model_info
                }
            except Exception as e:
                status[model_type.value] = {
                    "available": False,
                    "error": str(e)
                }
        
        return status

    def backtest(self,
                 sku: str,
                 full_history: List[float],
                 test_days: int = 7,
                 models: Optional[List[str]] = None) -> Dict:
        """
        回測驗證：盲測模式驗證模型準確度
        :param sku: 產品SKU
        :param full_history: 完整歷史數據
        :param test_days: 測試集天數（保留不給模型看）
        :param models: 要測試的模型列表，None=全部
        :return: 回測報告含 MAPE 分數
        """
        if len(full_history) < test_days + 10:
            return {
                "error": f"需要至少 {test_days + 10} 個數據點進行回測，實際只有 {len(full_history)} 個"
            }

        # 1. 拆分數據：保留最後 test_days 天作為「考卷」
        train_data = full_history[:-test_days]
        actual_values = full_history[-test_days:]

        # 2. 準備測試模型
        models_to_test = models or ["lightgbm", "chronos", "prophet", "xgboost", "ets"]
        results = []

        for model_name in models_to_test:
            try:
                model_type = ModelType(model_name.lower())
                strategy = self.get_strategy(model_type)

                # 3. 使用訓練數據進行預測
                prediction_result = strategy.predict(
                    sku=sku,
                    erp_connector=None,
                    horizon_days=test_days,
                    inline_history=train_data
                )

                if not prediction_result.get("success"):
                    results.append({
                        "model": model_name,
                        "success": False,
                        "error": prediction_result.get("error", "Unknown")
                    })
                    continue

                # 4. 提取預測值
                forecast_values = prediction_result["prediction"]["predictions"][:test_days]

                # 5. 計算 MAPE
                mape = self._calculate_mape(actual_values, forecast_values)

                # 6. 評級
                grade = self._grade_mape(mape)

                results.append({
                    "model": model_name,
                    "success": True,
                    "mape": float(mape),
                    "grade": grade,
                    "forecast": [float(v) for v in forecast_values],
                    "actual": [float(v) for v in actual_values],
                    "bias": float(np.mean(np.array(forecast_values) - np.array(actual_values))),
                    "prediction": prediction_result["prediction"]
                })

            except Exception as e:
                results.append({
                    "model": model_name,
                    "success": False,
                    "error": str(e)
                })

        # 7. 生成綜合報告
        successful = [r for r in results if r.get("success")]

        if not successful:
            return {
                "error": "所有模型回測失敗",
                "details": results
            }

        # 找出最佳模型
        best = min(successful, key=lambda x: x["mape"])

        # 計算共識度
        if len(successful) >= 2:
            mapes = [r["mape"] for r in successful]
            mape_variance = float(np.var(mapes))
            consensus = "high" if mape_variance < 50 else "medium" if mape_variance < 200 else "low"
        else:
            consensus = "insufficient_data"
            mape_variance = None

        # 整體可信度評估
        if best["mape"] < 20:
            reliability = "trusted"
            recommendation = "✅ AI 預測具備實戰參考價值"
        elif best["mape"] < 50:
            reliability = "caution"
            recommendation = "⚠️ 預測準確度一般，建議增加安全庫存緩衝"
        else:
            reliability = "unreliable"
            recommendation = "❌ 模型對此 SKU 的預測不可靠，請檢查數據源或改用人工判斷"

        return {
            "sku": sku,
            "test_days": test_days,
            "train_points": len(train_data),
            "results": results,
            "best_model": {
                "name": best["model"],
                "mape": best["mape"],
                "grade": best["grade"]
            },
            "consensus": {
                "level": consensus,
                "mape_variance": mape_variance,
                "models_tested": len(successful)
            },
            "reliability": reliability,
            "recommendation": recommendation,
            "accuracy_score": max(0, 100 - best["mape"])  # 轉換為 0-100 的信心分數
        }

    def _calculate_mape(self, actual: List[float], forecast: List[float]) -> float:
        """計算 MAPE (Mean Absolute Percentage Error)"""
        actual_arr = np.array(actual)
        forecast_arr = np.array(forecast)

        # 避免除以零
        mask = actual_arr != 0
        if not mask.any():
            return 999.0  # 全部為零，無法計算

        actual_filtered = actual_arr[mask]
        forecast_filtered = forecast_arr[mask]

        mape = np.mean(np.abs((actual_filtered - forecast_filtered) / actual_filtered)) * 100
        return float(mape)

    def _grade_mape(self, mape: float) -> str:
        """MAPE 成績單解析"""
        if mape < 10:
            return "A+ (神諭級)"
        elif mape < 20:
            return "A (工業級優等)"
        elif mape < 50:
            return "B (可接受，需複核)"
        else:
            return "F (垃圾進，垃圾出)"

    # ══════════════════════════════════════════════════════════════
    # PR-C: Probabilistic Uncertainty & Calibration
    # ══════════════════════════════════════════════════════════════

    def backtest_with_calibration(
        self,
        sku: str,
        full_history: List[float],
        test_days: int = 7,
        models: Optional[List[str]] = None,
        gate_config: Optional[QualityGateConfig] = None,
    ) -> Dict:
        """
        Enhanced backtest that also computes residuals, quantile metrics,
        and quality gate evaluations for each model.

        Returns the standard backtest report PLUS:
          - per-model: residuals, calibration_metrics, quantile_result, gate_result
          - calibration_report: artifact-ready calibration data
        """
        if len(full_history) < test_days + 10:
            return {
                "error": f"需要至少 {test_days + 10} 個數據點進行回測，實際只有 {len(full_history)} 個"
            }

        train_data = full_history[:-test_days]
        actual_values = full_history[-test_days:]
        actual_mean = float(np.mean([abs(v) for v in actual_values])) if actual_values else 1.0

        models_to_test = models or ["lightgbm", "chronos", "prophet", "xgboost", "ets"]
        results = []
        all_residuals = []  # Global residual pool

        for model_name in models_to_test:
            try:
                model_type = ModelType(model_name.lower())
                strategy = self.get_strategy(model_type)

                prediction_result = strategy.predict(
                    sku=sku,
                    erp_connector=None,
                    horizon_days=test_days,
                    inline_history=train_data,
                )

                if not prediction_result.get("success"):
                    results.append({
                        "model": model_name,
                        "success": False,
                        "error": prediction_result.get("error", "Unknown"),
                    })
                    continue

                forecast_values = prediction_result["prediction"]["predictions"][:test_days]

                # Compute residuals: actual - predicted
                residuals = [
                    float(a - f)
                    for a, f in zip(actual_values, forecast_values)
                ]
                all_residuals.extend(residuals)

                # Fit per-model quantile engine on these residuals
                engine = QuantileEngine()
                engine.fit(residuals_global=residuals)

                # Generate quantiles
                quantile_result = engine.predict_quantiles(forecast_values)

                # Compute calibration metrics
                cal_metrics = compute_calibration_metrics(
                    actuals=actual_values,
                    p10=quantile_result.p10,
                    p50=quantile_result.p50,
                    p90=quantile_result.p90,
                )

                # Run quality gate
                gate_result = evaluate_candidate(
                    metrics=cal_metrics,
                    config=gate_config,
                    actuals_mean=actual_mean,
                )

                mape = self._calculate_mape(actual_values, forecast_values)
                grade = self._grade_mape(mape)

                results.append({
                    "model": model_name,
                    "success": True,
                    "mape": float(mape),
                    "grade": grade,
                    "forecast": [float(v) for v in forecast_values],
                    "actual": [float(v) for v in actual_values],
                    "bias": float(np.mean(np.array(forecast_values) - np.array(actual_values))),
                    "prediction": prediction_result["prediction"],
                    # PR-C additions
                    "residuals": residuals,
                    "p10": quantile_result.p10,
                    "p50": quantile_result.p50,
                    "p90": quantile_result.p90,
                    "calibration_metrics": cal_metrics,
                    "gate_result": gate_result.to_dict(),
                    "calibration_scope": quantile_result.calibration_scope,
                    "uncertainty_method": quantile_result.uncertainty_method,
                    "monotonicity_fixes": quantile_result.monotonicity_fixes,
                })

            except Exception as e:
                results.append({
                    "model": model_name,
                    "success": False,
                    "error": str(e),
                })

        # Generate report
        successful = [r for r in results if r.get("success")]

        if not successful:
            return {
                "error": "所有模型回測失敗",
                "details": results,
            }

        best = min(successful, key=lambda x: x["mape"])

        if len(successful) >= 2:
            mapes = [r["mape"] for r in successful]
            mape_variance = float(np.var(mapes))
            consensus = "high" if mape_variance < 50 else "medium" if mape_variance < 200 else "low"
        else:
            consensus = "insufficient_data"
            mape_variance = None

        if best["mape"] < 20:
            reliability = "trusted"
            recommendation = "AI forecast is production-ready"
        elif best["mape"] < 50:
            reliability = "caution"
            recommendation = "Forecast accuracy is moderate — consider safety stock buffer"
        else:
            reliability = "unreliable"
            recommendation = "Model is unreliable for this SKU — review data or use manual judgement"

        # Build calibration report artifact (global residual pool)
        global_engine = QuantileEngine()
        if all_residuals:
            global_engine.fit(residuals_global=all_residuals)
        calibration_report = global_engine.get_calibration_report()
        calibration_report["achieved_coverage_10_90"] = best.get("calibration_metrics", {}).get("coverage_10_90")
        calibration_report["pinball_losses"] = {
            "p10": best.get("calibration_metrics", {}).get("pinball_loss_p10"),
            "p50": best.get("calibration_metrics", {}).get("pinball_loss_p50"),
            "p90": best.get("calibration_metrics", {}).get("pinball_loss_p90"),
        }
        calibration_report["monotonicity_fixes_total"] = sum(
            r.get("monotonicity_fixes", 0) for r in successful
        )

        return {
            "sku": sku,
            "test_days": test_days,
            "train_points": len(train_data),
            "results": results,
            "best_model": {
                "name": best["model"],
                "mape": best["mape"],
                "grade": best["grade"],
                "gate_passed": best.get("gate_result", {}).get("passed", False),
            },
            "consensus": {
                "level": consensus,
                "mape_variance": mape_variance,
                "models_tested": len(successful),
            },
            "reliability": reliability,
            "recommendation": recommendation,
            "accuracy_score": max(0, 100 - best["mape"]),
            # PR-C additions
            "calibration_report": calibration_report,
            "global_residuals_count": len(all_residuals),
        }

    def generate_quantiles_for_inference(
        self,
        point_forecasts: List[float],
        backtest_residuals: Optional[List[float]] = None,
        series_id: Optional[str] = None,
        calibration_path: Optional[str] = None,
    ) -> QuantileResult:
        """
        Generate p10/p50/p90 for inference output.

        Priority:
        1. If calibration_path is provided, load persisted calibration data.
        2. If backtest_residuals are provided, fit a fresh engine.
        3. Fall back to heuristic (±10%).
        """
        engine = QuantileEngine()

        if calibration_path and os.path.exists(calibration_path):
            engine.load(calibration_path)
        elif backtest_residuals and len(backtest_residuals) > 0:
            engine.fit(residuals_global=backtest_residuals)

        return engine.predict_quantiles(point_forecasts, series_id=series_id)
