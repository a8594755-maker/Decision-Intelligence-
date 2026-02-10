import pandas as pd
import numpy as np
try:
    import torch
except ImportError:
    torch = None
try:
    from chronos import ChronosPipeline
except ImportError:
    ChronosPipeline = None
from .erp_connector import ERPConnector
import json
import os
from typing import List, Dict, Optional, Tuple
import logging

class ChronosTrainer:
    """
    Amazon Chronos 模型训练器
    用于零样本时间序列预测
    """
    
    def __init__(self, model_name: str = "amazon/chronos-t5-tiny"):
        self.model_name = model_name
        self.model = None
        self.tokenizer = None
        self._torch_available = torch is not None
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu") if self._torch_available else None
        if self._torch_available and ChronosPipeline is not None:
            self._load_model()
        else:
            logging.warning("torch/chronos not available — Chronos will use simulation mode")
        
    def _load_model(self):
        """加载 Chronos 模型"""
        try:
            logging.info(f"Loading Chronos model: {self.model_name}")
            self.model = ChronosPipeline.from_pretrained(
                self.model_name,
                device_map=self.device,
                torch_dtype=torch.float32,
            )
            logging.info("Chronos model loaded successfully")
        except Exception as e:
            logging.error(f"Failed to load Chronos model: {e}")
            raise
    
    def _preprocess_sequence(self, sequence: List[float]) -> torch.Tensor:
        """预处理时间序列数据"""
        # 转换为 numpy 数组并处理 NaN 值
        clean_sequence = np.array(sequence)
        clean_sequence = np.nan_to_num(clean_sequence, nan=0.0)
        
        # 归一化（可选，Chronos 通常不需要）
        if len(clean_sequence) > 0 and np.std(clean_sequence) > 0:
            clean_sequence = (clean_sequence - np.mean(clean_sequence)) / np.std(clean_sequence)
        
        return torch.tensor(clean_sequence, dtype=torch.float32)
    
    def _tokenize_sequence(self, sequence: torch.Tensor) -> Dict[str, torch.Tensor]:
        """将序列 tokenization"""
        # Chronos 使用特殊的 tokenization 方法
        # 将数值转换为 token IDs
        scaled_sequence = sequence * self.tokenizer.scale  # 缩放因子
        
        # 转换为整数 token IDs
        token_ids = torch.round(scaled_sequence).long()
        
        # 创建 attention mask
        attention_mask = torch.ones_like(token_ids)
        
        return {
            "input_ids": token_ids.unsqueeze(0),  # batch dimension
            "attention_mask": attention_mask.unsqueeze(0)
        }
    
    def _detokenize_predictions(self, predictions: torch.Tensor, original_sequence: List[float]) -> List[float]:
        """将预测结果反 tokenization"""
        # 移除 batch 维度
        predictions = predictions.squeeze(0)
        
        # 反向缩放
        if self.tokenizer.scale:
            predictions = predictions / self.tokenizer.scale
        
        # 如果原始数据进行了归一化，需要反向归一化
        original_mean = np.mean(original_sequence) if len(original_sequence) > 0 else 0
        original_std = np.std(original_sequence) if len(original_sequence) > 0 else 1
        
        if original_std > 0:
            predictions = predictions * original_std + original_mean
        
        # 确保预测值为正数（销量不能为负）
        predictions = torch.clamp(predictions, min=0)
        
        return predictions.cpu().numpy().tolist()
    
    def predict(self, 
                sku: str, 
                erp_connector: ERPConnector = None, 
                forecast_horizon: int = 30,
                confidence_intervals: bool = True,
                inline_history: Optional[List[float]] = None) -> Dict:
        """
        执行 Chronos 预测
        :param sku: 产品SKU
        :param erp_connector: ERP连接器实例（当 inline_history 提供时可为 None）
        :param forecast_horizon: 预测天数
        :param confidence_intervals: 是否计算置信区间
        :param inline_history: 直接传入的历史数据序列（用于压力测试等场景）
        :return: 预测结果字典
        """
        try:
            # 获取历史数据：优先使用 inline_history
            if inline_history is not None:
                sales_sequence = [float(v) for v in inline_history]
            else:
                if erp_connector is None:
                    raise ValueError("Either erp_connector or inline_history must be provided")
                sales_data = erp_connector.fetch_sales_data(sku)
                if not sales_data or len(sales_data) < 3:
                    raise ValueError(f"Insufficient data for SKU {sku}. Need at least 3 data points.")
                sales_sequence = [float(record['sales']) for record in sales_data]
            
            if len(sales_sequence) < 3:
                raise ValueError(f"Insufficient data for SKU {sku}. Need at least 3 data points, got {len(sales_sequence)}.")
            
            sales_sequence = sales_sequence[-365:]  # 使用最近一年的数据
            
            # 预处理
            processed_sequence = self._preprocess_sequence(sales_sequence)
            
            # Tokenization
            tokenized_input = self._tokenize_sequence(processed_sequence)
            
            # 移动到设备
            tokenized_input = {k: v.to(self.device) for k, v in tokenized_input.items()}
            
            # 执行预测
            with torch.no_grad():
                # Chronos 使用 generate 方法进行预测
                predictions = self.model.generate(
                    **tokenized_input,
                    prediction_length=forecast_horizon,
                    num_return_sequences=10 if confidence_intervals else 1  # 多次采样用于置信区间
                )
            
            # 处理预测结果
            if confidence_intervals:
                # 计算置信区间
                all_predictions = []
                for pred in predictions:
                    detokenized = self._detokenize_predictions(pred, sales_sequence)
                    all_predictions.append(detokenized)
                
                all_predictions = np.array(all_predictions)
                
                # 计算中位数和置信区间
                median_prediction = np.median(all_predictions, axis=0)
                lower_bound = np.percentile(all_predictions, 10, axis=0)  # 90% 置信区间
                upper_bound = np.percentile(all_predictions, 90, axis=0)
                
                # 计算风险分数（基于预测方差）
                prediction_variance = np.var(all_predictions, axis=0)
                risk_score = float(np.mean(prediction_variance) / (np.mean(median_prediction) + 1e-6) * 100)
                risk_score = min(100, max(0, risk_score))  # 限制在 0-100 范围
                
                result = {
                    "predictions": median_prediction.tolist(),
                    "confidence_interval": [lower_bound.tolist(), upper_bound.tolist()],
                    "risk_score": risk_score,
                    "model_version": "chronos-t5-tiny-v1.0"
                }
            else:
                # 单次预测
                detokenized = self._detokenize_predictions(predictions[0], sales_sequence)
                result = {
                    "predictions": detokenized,
                    "confidence_interval": None,
                    "risk_score": 50.0,  # 默认风险分数
                    "model_version": "chronos-t5-tiny-v1.0"
                }
            
            return result
            
        except Exception as e:
            logging.error(f"Chronos prediction failed for SKU {sku}: {e}")
            raise
    
    def get_model_info(self) -> Dict:
        """获取模型信息"""
        return {
            "model_name": self.model_name,
            "device": str(self.device) if self.device else "cpu",
            "parameters": sum(p.numel() for p in self.model.parameters()) if self.model is not None else 0,
            "model_loaded": self.model is not None
        }
    
    def predict_from_sequence(self,
                              sequence: List[float],
                              forecast_horizon: int = 30,
                              confidence_intervals: bool = True) -> Dict:
        """
        从原始序列直接预测（压力测试用）
        """
        return self.predict(
            sku="INLINE",
            erp_connector=None,
            forecast_horizon=forecast_horizon,
            confidence_intervals=confidence_intervals,
            inline_history=sequence
        )

    def validate_data_suitability(self, sales_data) -> Dict:
        """
        评估数据是否适合 Chronos 预测
        :param sales_data: 销售数据（可以是 List[Dict] 或 List[float]）
        :return: 适合性评估结果
        """
        if not sales_data:
            return {"suitable": False, "reason": "No data available"}
        
        data_points = len(sales_data)
        
        # Chronos 特别适合的场景
        reasons = []
        
        # 新产品（数据较少）
        if data_points < 90:
            reasons.append("Limited historical data - ideal for zero-shot learning")
        
        # 检查数据模式：支持 List[float] 和 List[Dict]
        if isinstance(sales_data[0], (int, float)):
            sales_values = [float(v) for v in sales_data]
        else:
            sales_values = [float(record['sales']) for record in sales_data]
        
        # 异常模式检测
        if len(sales_values) > 10:
            recent_std = np.std(sales_values[-10:])
            overall_std = np.std(sales_values)
            
            if recent_std > overall_std * 2:
                reasons.append("Recent volatility detected - AI model may capture patterns better")
        
        # 缺乏外部特征
        if isinstance(sales_data[0], (int, float)) or len(sales_data[0].get('features', {})) == 0:
            reasons.append("No external features - Chronos works with raw sequences")
        
        suitable = len(reasons) > 0 or data_points < 365
        
        return {
            "suitable": suitable,
            "reasons": reasons,
            "data_points": data_points,
            "recommendation": "chronos" if suitable else "lightgbm"
        }
    
    def save_model(self, sku: str, version: str = "1.0"):
        """
        保存模型（Chronos 是预训练模型，这里只保存配置）
        """
        config = {
            "model_name": self.model_name,
            "sku": sku,
            "version": version,
            "device": str(self.device),
            "saved_at": pd.Timestamp.now().isoformat()
        }
        
        model_dir = f"models/chronos/{sku}"
        os.makedirs(model_dir, exist_ok=True)
        config_path = f"{model_dir}/v{version}.json"
        
        with open(config_path, 'w') as f:
            json.dump(config, f, indent=2)
        
        return config_path
