import requests
import os
from typing import Dict, Any, Optional
from datetime import datetime, timedelta

class SupabaseRESTClient:
    """
    Supabase REST API 客户端（避免 pyroaring 依赖）
    """
    def __init__(self):
        self.url = os.getenv("SUPABASE_URL")
        self.key = os.getenv("SUPABASE_SERVICE_KEY")
        self.headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json"
        }
    
    async def save_model_history(self, model_type: str, sku: str, version: str, 
                                metrics: Dict[str, Any], model_path: str = None):
        """保存模型训练历史"""
        data = {
            "model_type": model_type,
            "sku": sku,
            "version": version,
            "metrics": metrics,
            "model_path": model_path
        }
        
        response = requests.post(
            f"{self.url}/rest/v1/ml_model_history",
            headers=self.headers,
            json=data
        )
        response.raise_for_status()
        return response.json()[0] if response.json() else None
    
    async def get_cached_prediction(self, sku: str, horizon_days: int, 
                                  model_type: str) -> Optional[Dict[str, Any]]:
        """获取缓存的预测结果"""
        cache_key = f"{sku}_{horizon_days}_{model_type}"
        
        response = requests.get(
            f"{self.url}/rest/v1/ml_prediction_cache",
            headers=self.headers,
            params={
                "cache_key": f"eq.{cache_key}",
                "expires_at": f"gt.{datetime.now().isoformat()}"
            }
        )
        response.raise_for_status()
        
        data = response.json()
        return data[0] if data else None
    
    async def cache_prediction(self, sku: str, horizon_days: int, model_type: str,
                              prediction: Dict[str, Any], ttl_hours: int = 24):
        """缓存预测结果"""
        cache_key = f"{sku}_{horizon_days}_{model_type}"
        expires_at = datetime.now() + timedelta(hours=ttl_hours)
        
        data = {
            "sku": sku,
            "horizon_days": horizon_days,
            "model_type": model_type,
            "prediction": prediction,
            "cache_key": cache_key,
            "expires_at": expires_at.isoformat()
        }
        
        # 使用 upsert 避免重复
        response = requests.post(
            f"{self.url}/rest/v1/ml_prediction_cache",
            headers=self.headers,
            json=data
        )
        response.raise_for_status()
        return response.json()[0] if response.json() else None
    
    async def get_user_preferences(self, user_id: str) -> Optional[Dict[str, Any]]:
        """获取用户预测偏好"""
        response = requests.get(
            f"{self.url}/rest/v1/ml_user_preferences",
            headers=self.headers,
            params={"user_id": f"eq.{user_id}"}
        )
        response.raise_for_status()
        
        data = response.json()
        return data[0] if data else None
    
    async def update_user_preferences(self, user_id: str, preferences: Dict[str, Any]):
        """更新用户预测偏好"""
        data = {**preferences, "updated_at": datetime.now().isoformat()}
        
        response = requests.post(
            f"{self.url}/rest/v1/ml_user_preferences",
            headers=self.headers,
            json={**data, "user_id": user_id}
        )
        response.raise_for_status()
        
        return response.json()[0] if response.json() else None
