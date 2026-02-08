import json
import os
from datetime import datetime, timedelta
from typing import Dict, Any, Optional

class SimpleCacheClient:
    """
    简单文件缓存客户端（替代 Supabase）
    """
    def __init__(self, cache_dir="cache/ml"):
        self.cache_dir = cache_dir
        os.makedirs(cache_dir, exist_ok=True)
    
    def _get_cache_file(self, key: str) -> str:
        return os.path.join(self.cache_dir, f"{key}.json")
    
    def get_cached_prediction(self, sku: str, horizon_days: int, model_type: str) -> Optional[Dict[str, Any]]:
        """获取缓存的预测结果"""
        cache_key = f"{sku}_{horizon_days}_{model_type}"
        cache_file = self._get_cache_file(cache_key)
        
        if not os.path.exists(cache_file):
            return None
        
        try:
            with open(cache_file, 'r') as f:
                data = json.load(f)
            
            # 检查是否过期
            expires_at = datetime.fromisoformat(data["expires_at"])
            if expires_at < datetime.now():
                os.remove(cache_file)
                return None
            
            return data
        except Exception:
            return None
    
    def cache_prediction(self, sku: str, horizon_days: int, model_type: str,
                        prediction: Dict[str, Any], ttl_hours: int = 24):
        """缓存预测结果"""
        cache_key = f"{sku}_{horizon_days}_{model_type}"
        cache_file = self._get_cache_file(cache_key)
        
        data = {
            "sku": sku,
            "horizon_days": horizon_days,
            "model_type": model_type,
            "prediction": prediction,
            "expires_at": (datetime.now() + timedelta(hours=ttl_hours)).isoformat(),
            "created_at": datetime.now().isoformat()
        }
        
        with open(cache_file, 'w') as f:
            json.dump(data, f, indent=2)
    
    def save_model_history(self, model_type: str, sku: str, version: str,
                          metrics: Dict[str, Any], model_path: str = None):
        """保存模型历史"""
        history_file = os.path.join(self.cache_dir, "model_history.json")
        
        # 读取现有历史
        history = []
        if os.path.exists(history_file):
            try:
                with open(history_file, 'r') as f:
                    history = json.load(f)
            except Exception:
                history = []
        
        # 添加新记录
        record = {
            "model_type": model_type,
            "sku": sku,
            "version": version,
            "metrics": metrics,
            "model_path": model_path,
            "created_at": datetime.now().isoformat()
        }
        history.append(record)
        
        # 保存历史（保留最近100条）
        with open(history_file, 'w') as f:
            json.dump(history[-100:], f, indent=2)
