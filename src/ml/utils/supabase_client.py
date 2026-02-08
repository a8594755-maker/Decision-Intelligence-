import os
from supabase import create_client, Client
from typing import Dict, Any, Optional
from datetime import datetime, timedelta

class SupabaseMLClient:
    """
    Supabase 客户端 - ML 数据存储
    """
    def __init__(self):
        self.supabase_url = os.getenv("SUPABASE_URL")
        self.supabase_key = os.getenv("SUPABASE_SERVICE_KEY")
        self.client: Client = create_client(self.supabase_url, self.supabase_key)
    
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
        result = self.client.table("ml_model_history").insert(data).execute()
        return result.data[0] if result.data else None
    
    async def get_cached_prediction(self, sku: str, horizon_days: int, 
                                  model_type: str) -> Optional[Dict[str, Any]]:
        """获取缓存的预测结果"""
        cache_key = f"{sku}_{horizon_days}_{model_type}"
        
        result = self.client.table("ml_prediction_cache").select("*").eq(
            "cache_key", cache_key
        ).eq("expires_at", "gt", datetime.now().isoformat()).execute()
        
        return result.data[0] if result.data else None
    
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
        result = self.client.table("ml_prediction_cache").upsert(data).execute()
        return result.data[0] if result.data else None
    
    async def get_user_preferences(self, user_id: str) -> Optional[Dict[str, Any]]:
        """获取用户预测偏好"""
        result = self.client.table("ml_user_preferences").select("*").eq(
            "user_id", user_id
        ).execute()
        
        return result.data[0] if result.data else None
    
    async def update_user_preferences(self, user_id: str, preferences: Dict[str, Any]):
        """更新用户预测偏好"""
        data = {**preferences, "updated_at": datetime.now().isoformat()}
        
        result = self.client.table("ml_user_preferences").upsert({
            **data, "user_id": user_id
        }).execute()
        
        return result.data[0] if result.data else None
