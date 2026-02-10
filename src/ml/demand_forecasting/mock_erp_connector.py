import random
import numpy as np
from datetime import datetime, timedelta
from typing import List, Dict, Optional

class MockERPConnector:
    """
    Mock ERP 数据连接器 - 用于测试环境
    生成模拟销售数据，无需真实的ERP API连接
    """
    
    def __init__(self, api_endpoint: str = None, api_key: str = None):
        """初始化Mock连接器（忽略真实API参数）"""
        self.endpoint = api_endpoint
        self.api_key = api_key
        # 设置随机种子以确保可重现性
        random.seed(42)
        np.random.seed(42)
        
        # 预定义的SKU数据模式
        self.sku_patterns = {
            "SKU001": {"base": 100, "trend": 0.5, "seasonality": 0.3, "volatility": 0.1},
            "SKU002": {"base": 50, "trend": -0.2, "seasonality": 0.5, "volatility": 0.15},
            "SKU003": {"base": 200, "trend": 1.0, "seasonality": 0.2, "volatility": 0.08},
            "DEFAULT": {"base": 80, "trend": 0.3, "seasonality": 0.4, "volatility": 0.12}
        }
    
    def fetch_sales_data(self, sku: str, days: int = 730) -> List[Dict]:
        """
        获取指定SKU的模拟销售数据
        :param sku: 产品SKU
        :param days: 获取数据的天数（默认2年）
        :return: 模拟销售数据列表
        """
        try:
            # 获取SKU模式
            pattern = self.sku_patterns.get(sku, self.sku_patterns["DEFAULT"])
            
            # 生成日期序列
            end_date = datetime.now()
            start_date = end_date - timedelta(days=days)
            dates = [start_date + timedelta(days=i) for i in range(days)]
            
            sales_data = []
            
            for i, date in enumerate(dates):
                # 基础销量
                base_sales = pattern["base"]
                
                # 趋势效应
                trend_effect = pattern["trend"] * i
                
                # 季节性效应（年度周期）
                day_of_year = date.timetuple().tm_yday
                seasonal_effect = pattern["seasonality"] * base_sales * np.sin(2 * np.pi * day_of_year / 365.25)
                
                # 周期性效应（周周期）
                day_of_week = date.weekday()
                weekly_effect = 0.1 * base_sales * np.sin(2 * np.pi * day_of_week / 7)
                
                # 随机噪声
                noise = np.random.normal(0, pattern["volatility"] * base_sales)
                
                # 特殊事件（随机促销）
                special_event = 0
                if random.random() < 0.05:  # 5%概率有促销
                    special_event = random.uniform(0.2, 0.5) * base_sales
                
                # 计算最终销量
                sales = max(0, base_sales + trend_effect + seasonal_effect + weekly_effect + noise + special_event)
                
                sales_data.append({
                    "date": date.strftime("%Y-%m-%d"),
                    "sales": round(sales, 2),
                    "sku": sku,
                    "features": {
                        "price_index": 1.0 + 0.1 * np.sin(2 * np.pi * i / 30),  # 价格指数
                        "promotion": 1 if special_event > 0 else 0,  # 促销标记
                        "inventory": max(0, sales * random.uniform(1.5, 3.0))  # 库存水平
                    }
                })
            
            return sales_data
            
        except Exception as e:
            print(f"Mock ERP连接失败: {e}")
            return None
    
    def get_available_skus(self) -> List[str]:
        """获取可用的SKU列表"""
        return list(self.sku_patterns.keys())[:-1]  # 排除"DEFAULT"
    
    def add_sku_pattern(self, sku: str, base: float, trend: float = 0.0, 
                        seasonality: float = 0.0, volatility: float = 0.1):
        """添加新的SKU模式"""
        self.sku_patterns[sku] = {
            "base": base,
            "trend": trend,
            "seasonality": seasonality,
            "volatility": volatility
        }
    
    def generate_batch_data(self, skus: List[str], days: int = 365) -> Dict[str, List[Dict]]:
        """批量生成多个SKU的数据"""
        batch_data = {}
        for sku in skus:
            batch_data[sku] = self.fetch_sales_data(sku, days)
        return batch_data

# 为了向后兼容，保留原始ERPConnector类名的别名
ERPConnector = MockERPConnector
