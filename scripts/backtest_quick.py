#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
簡化版回測驗證 — 強制本地模式
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import numpy as np
from ml.demand_forecasting.forecaster_factory import ForecasterFactory

# 強制本地模式
factory = ForecasterFactory()

def run_backtest(name, history, test_days=7):
    print(f"\n{'='*60}")
    print(f"🧪 測試: {name}")
    print(f"📊 數據: {len(history)} 天 (訓練: {len(history)-test_days}, 測試: {test_days})")
    print('='*60)
    
    result = factory.backtest(
        sku=name,
        full_history=history,
        test_days=test_days
    )
    
    if "error" in result:
        print(f"❌ 錯誤: {result['error']}")
        return result
    
    print(f"\n📦 SKU: {result['sku']}")
    print(f"🎯 準確度評分: {result['accuracy_score']:.1f}/100")
    print(f"🔒 可信度: {result['reliability'].upper()}")
    print(f"💡 {result['recommendation']}")
    
    print(f"\n📋 各模型表現:")
    for r in result['results']:
        if r.get('success'):
            print(f"  • {r['model']:<12} MAPE: {r['mape']:>6.2f}%  {r['grade']}")
        else:
            print(f"  • {r['model']:<12} 失敗: {r.get('error', 'Unknown')[:30]}")
    
    best = result['best_model']
    print(f"\n🏆 最佳: {best['name']} (MAPE {best['mape']:.2f}%)")
    
    # 顯示預測 vs 實際
    for r in result['results']:
        if r.get('success') and 'actual' in r:
            print(f"\n📈 預測 vs 實際 ({best['name']}):")
            for i, (a, f) in enumerate(zip(r['actual'][:5], r['forecast'][:5])):
                err_pct = (f - a) / a * 100 if a != 0 else 0
                print(f"  Day-{i+1}: 實際={a:5.1f} 預測={f:5.1f} ({err_pct:+.1f}%)")
            break
    
    return result

# 測試情境
print("\n" + "="*60)
print("📊 SmartOps 回測驗證 — AI 誠實度測試")
print("="*60)

# 1. 穩定增長
history1 = [10, 12, 11, 13, 15, 14, 16, 18, 20, 19, 21, 23, 22, 25, 27, 26, 28, 30, 29, 31, 33, 32]
result1 = run_backtest("穩定增長 SKU-001", history1)

# 2. 黑天鵝後恢復
history2 = [20]*15 + [80] + [22, 23, 21, 24, 25, 23, 26]
result2 = run_backtest("黑天鵝後 SKU-003", history2)

# 總結
print("\n" + "="*60)
print("📊 彙總")
print("="*60)
all_results = [result1, result2]
successful = [r for r in all_results if 'error' not in r]
trusted = sum(1 for r in successful if r.get('reliability') == 'trusted')
print(f"✅ 可信賴: {trusted}/{len(successful)} 個 SKU")
print(f"📈 平均準確度: {np.mean([r['accuracy_score'] for r in successful]):.1f}/100")
print("="*60)
