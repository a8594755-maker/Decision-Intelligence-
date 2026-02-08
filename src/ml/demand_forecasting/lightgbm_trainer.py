import pandas as pd
try:
    import lightgbm as lgb
except ImportError:
    lgb = None
try:
    from sklearn.model_selection import train_test_split
except ImportError:
    train_test_split = None
try:
    from .feature_engineer import FeatureEngineer
except ImportError:
    FeatureEngineer = None
from .erp_connector import ERPConnector
try:
    import joblib
except ImportError:
    joblib = None
import json
import os

class LightGBMTrainer:
    """
    LightGBM 模型训练器
    用于结构化特征需求预测
    """
    def __init__(self, config_path="config/lightgbm_config.json"):
        self.config = self._load_config(config_path)
        self.feature_engineer = FeatureEngineer() if FeatureEngineer else None
        
    def _load_config(self, path):
        """加载模型配置"""
        try:
            with open(path) as f:
                return json.load(f)
        except FileNotFoundError:
            return {
                "boosting_type": "gbdt",
                "objective": "regression",
                "metric": "mape",
                "num_leaves": 31,
                "learning_rate": 0.05,
                "feature_fraction": 0.9
            }
            
    def train(self, sku, erp_connector):
        """
        训练LightGBM模型
        :param sku: 产品SKU
        :param erp_connector: ERP连接器实例
        :return: 训练好的模型
        """
        # 获取数据
        sales_data = erp_connector.fetch_sales_data(sku)
        df = pd.DataFrame(sales_data)
        
        # 特征工程
        df = self.feature_engineer.create_features(df)
        
        # 准备训练数据
        X = df.drop(['sales', 'date'], axis=1)
        y = df['sales']
        
        # 分割数据集
        X_train, X_val, y_train, y_val = train_test_split(
            X, y, test_size=0.2, random_state=42
        )
        
        # 创建数据集
        train_data = lgb.Dataset(X_train, label=y_train)
        val_data = lgb.Dataset(X_val, label=y_val, reference=train_data)
        
        # 训练模型
        model = lgb.train(
            self.config,
            train_data,
            valid_sets=[val_data],
            num_boost_round=1000,
            early_stopping_rounds=50
        )
        return model

    def save_model(self, model, sku, version="1.0"):
        """保存模型到文件"""
        model_dir = f"models/lightgbm/{sku}"
        os.makedirs(model_dir, exist_ok=True)
        model_path = f"{model_dir}/v{version}.pkl"
        joblib.dump(model, model_path)
        return model_path
