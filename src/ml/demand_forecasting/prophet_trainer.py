import pandas as pd
try:
    from prophet import Prophet
except ImportError:
    Prophet = None
try:
    from .feature_engineer import FeatureEngineer
except ImportError:
    FeatureEngineer = None
from .erp_connector import ERPConnector
import json
import os

class ProphetTrainer:
    """
    Prophet 模型训练器
    用于时间序列需求预测
    """
    def __init__(self, config_path="config/prophet_config.json"):
        self.config = self._load_config(config_path)
        self.feature_engineer = FeatureEngineer() if FeatureEngineer else None
        
    def _load_config(self, path):
        """加载模型配置"""
        try:
            with open(path) as f:
                return json.load(f)
        except FileNotFoundError:
            return {
                "seasonality_mode": "multiplicative",
                "changepoint_prior_scale": 0.05,
                "seasonality_prior_scale": 10.0
            }
            
    def train(self, sku, erp_connector):
        """
        训练Prophet模型
        :param sku: 产品SKU
        :param erp_connector: ERP连接器实例
        :return: 训练好的模型
        """
        # 获取数据
        sales_data = erp_connector.fetch_sales_data(sku)
        df = pd.DataFrame(sales_data)
        
        # 特征工程
        df = self.feature_engineer.create_features(df)
        
        # 准备Prophet格式
        prophet_df = df[['date', 'sales']].rename(columns={
            'date': 'ds',
            'sales': 'y'
        })
        
        # 创建并训练模型
        model = Prophet(
            seasonality_mode=self.config["seasonality_mode"],
            changepoint_prior_scale=self.config["changepoint_prior_scale"],
            seasonality_prior_scale=self.config["seasonality_prior_scale"]
        )
        
        # 添加节假日
        for date, name in self.feature_engineer.calendar.items():
            model.add_country_holidays(country_name='CN')
            
        model.fit(prophet_df)
        return model

    def save_model(self, model, sku, version="1.0"):
        """保存模型到文件"""
        model_dir = f"models/prophet/{sku}"
        os.makedirs(model_dir, exist_ok=True)
        model_path = f"{model_dir}/v{version}.json"
        with open(model_path, 'w') as fout:
            json.dump(model.to_json(), fout)
        return model_path
