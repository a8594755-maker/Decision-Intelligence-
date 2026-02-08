#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1 & 2: LightGBM 真實模型訓練腳本
========================================
從模擬/真實銷售數據訓練 LightGBM 回歸模型，保存為 .pkl 文件。
API 推論時載入此文件，不再用 np.random 模擬。

用法:
  python scripts/train_lgbm.py                          # 使用內建模擬數據
  python scripts/train_lgbm.py --csv data/sales.csv     # 使用真實 CSV
"""

import sys
import os
import argparse
import json
import numpy as np
import pandas as pd
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import lightgbm as lgb
import joblib
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_percentage_error, mean_squared_error

from ml.demand_forecasting.feature_engineer import FeatureEngineer, FEATURE_COLUMNS


# ─────────────────────────────────────────────────
# 1. 生成模擬訓練數據（無真實數據時使用）
# ─────────────────────────────────────────────────
def generate_synthetic_data(days: int = 365, seed: int = 42) -> pd.DataFrame:
    """
    生成帶趨勢 + 季節性 + 噪聲的模擬銷售數據
    模擬一個工業零件的日銷量（均值 ~50 單位）
    """
    np.random.seed(seed)
    dates = pd.date_range(start='2025-01-01', periods=days, freq='D')

    # 基礎需求
    base = 50

    # 上升趨勢 (每天 +0.02)
    trend = np.arange(days) * 0.02

    # 週循環（週一高、週日低）
    weekly = 5 * np.sin(2 * np.pi * np.arange(days) / 7)

    # 月循環（月初補貨潮）
    monthly = 8 * np.sin(2 * np.pi * np.arange(days) / 30)

    # 年季節性（Q4 旺季）
    yearly = 12 * np.sin(2 * np.pi * (np.arange(days) - 90) / 365)

    # 隨機噪聲
    noise = np.random.normal(0, 4, days)

    # 偶爾的促銷衝擊（每 60 天一次大促）
    promos = np.zeros(days)
    for i in range(0, days, 60):
        if i + 3 < days:
            promos[i:i+3] = 20

    sales = base + trend + weekly + monthly + yearly + noise + promos
    sales = np.maximum(sales, 0).round(1)

    df = pd.DataFrame({'date': dates, 'sales': sales})
    print(f"  📊 生成模擬數據: {days} 天, 均值={sales.mean():.1f}, 標準差={sales.std():.1f}")
    return df


# ─────────────────────────────────────────────────
# 2. 訓練 LightGBM
# ─────────────────────────────────────────────────
def train_lightgbm(df: pd.DataFrame, test_size: float = 0.15):
    """
    訓練 LightGBM 回歸模型
    :param df: 含 date, sales 的 DataFrame
    :param test_size: 驗證集比例
    :return: (model, metrics_dict)
    """
    fe = FeatureEngineer()

    # 構建特徵
    X, y = fe.create_training_data(df, min_rows=30)
    print(f"  📐 特徵矩陣: {X.shape[0]} 行 × {X.shape[1]} 列")
    print(f"  📋 特徵列: {list(X.columns)}")

    # 時序分割（不隨機，保持時間順序）
    split_idx = int(len(X) * (1 - test_size))
    X_train, X_val = X.iloc[:split_idx], X.iloc[split_idx:]
    y_train, y_val = y.iloc[:split_idx], y.iloc[split_idx:]
    print(f"  ✂️  訓練集: {len(X_train)} | 驗證集: {len(X_val)}")

    # 建立 LightGBM Dataset
    train_data = lgb.Dataset(X_train, label=y_train, feature_name=FEATURE_COLUMNS)
    val_data = lgb.Dataset(X_val, label=y_val, reference=train_data)

    # 訓練參數
    params = {
        'boosting_type': 'gbdt',
        'objective': 'regression',
        'metric': 'mape',
        'num_leaves': 31,
        'learning_rate': 0.05,
        'feature_fraction': 0.9,
        'bagging_fraction': 0.8,
        'bagging_freq': 5,
        'verbose': -1,
    }

    callbacks = [
        lgb.early_stopping(stopping_rounds=50),
        lgb.log_evaluation(period=100),
    ]

    print("\n  🚂 開始訓練 LightGBM...")
    model = lgb.train(
        params,
        train_data,
        valid_sets=[train_data, val_data],
        valid_names=['train', 'valid'],
        num_boost_round=1000,
        callbacks=callbacks,
    )

    # 評估
    y_pred_train = model.predict(X_train)
    y_pred_val = model.predict(X_val)

    train_mape = mean_absolute_percentage_error(y_train, y_pred_train) * 100
    val_mape = mean_absolute_percentage_error(y_val, y_pred_val) * 100
    val_rmse = np.sqrt(mean_squared_error(y_val, y_pred_val))

    metrics = {
        'train_mape': round(train_mape, 2),
        'val_mape': round(val_mape, 2),
        'val_rmse': round(val_rmse, 2),
        'best_iteration': model.best_iteration,
        'num_features': len(FEATURE_COLUMNS),
        'feature_importance': dict(zip(
            FEATURE_COLUMNS,
            [int(x) for x in model.feature_importance(importance_type='gain')]
        )),
        'train_samples': len(X_train),
        'val_samples': len(X_val),
        'trained_at': datetime.now().isoformat(),
    }

    print(f"\n  📊 訓練結果:")
    print(f"     Train MAPE: {train_mape:.2f}%")
    print(f"     Valid MAPE: {val_mape:.2f}%")
    print(f"     Valid RMSE: {val_rmse:.2f}")
    print(f"     Best iteration: {model.best_iteration}")

    # 特徵重要性
    print(f"\n  🔍 Top 5 重要特徵:")
    sorted_feats = sorted(metrics['feature_importance'].items(), key=lambda x: x[1], reverse=True)
    for feat, imp in sorted_feats[:5]:
        print(f"     {feat:<20} {imp:>8}")

    return model, metrics


# ─────────────────────────────────────────────────
# 3. 保存模型
# ─────────────────────────────────────────────────
def save_model(model, metrics: dict, model_dir: str):
    """保存模型和元數據"""
    os.makedirs(model_dir, exist_ok=True)

    model_path = os.path.join(model_dir, 'lgbm_model.pkl')
    meta_path = os.path.join(model_dir, 'lgbm_meta.json')

    joblib.dump(model, model_path)
    with open(meta_path, 'w', encoding='utf-8') as f:
        json.dump(metrics, f, indent=2, ensure_ascii=False)

    file_size = os.path.getsize(model_path) / 1024
    print(f"\n  💾 模型已保存:")
    print(f"     模型檔: {model_path} ({file_size:.1f} KB)")
    print(f"     元數據: {meta_path}")

    return model_path


# ─────────────────────────────────────────────────
# 4. 主程式
# ─────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='Train LightGBM demand forecasting model')
    parser.add_argument('--csv', type=str, help='Path to CSV file with date,sales columns')
    parser.add_argument('--days', type=int, default=365, help='Days of synthetic data to generate')
    parser.add_argument('--seed', type=int, default=42, help='Random seed')
    parser.add_argument('--output', type=str, default=None, help='Output model directory')
    args = parser.parse_args()

    print("\n" + "=" * 60)
    print("  🏭 SmartOps LightGBM 模型訓練器")
    print(f"  ⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    # 1. 載入或生成數據
    if args.csv:
        print(f"\n  📂 載入 CSV: {args.csv}")
        df = pd.read_csv(args.csv)
        if 'date' not in df.columns or 'sales' not in df.columns:
            print("  ❌ CSV 必須包含 'date' 和 'sales' 欄位")
            sys.exit(1)
    else:
        print("\n  🧪 使用模擬數據 (無 --csv 參數)")
        df = generate_synthetic_data(days=args.days, seed=args.seed)

    # 2. 訓練
    model, metrics = train_lightgbm(df)

    # 3. 質量閘門
    if metrics['val_mape'] > 50:
        print(f"\n  ❌ 質量閘門失敗: MAPE {metrics['val_mape']:.2f}% > 50%，拒絕保存。")
        print("     請檢查數據品質或增加訓練數據量。")
        sys.exit(1)

    # 4. 保存
    model_dir = args.output or os.path.join(
        os.path.dirname(__file__), '..', 'src', 'ml', 'models'
    )
    save_model(model, metrics, model_dir)

    # 5. 結論
    grade = "A+" if metrics['val_mape'] < 10 else "A" if metrics['val_mape'] < 20 else "B" if metrics['val_mape'] < 50 else "F"
    print(f"\n  🏆 模型評級: {grade} (MAPE: {metrics['val_mape']:.2f}%)")
    print("=" * 60 + "\n")


if __name__ == '__main__':
    main()
