#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📊 Step 1: 受控合成數據基準線測試 (Controlled Synthetic Data Benchmark)
========================================================================
使用 DataGenerator 產出三種特性 SKU 的 365 天需求數據：
  1. 穩定型 (Stable)    — 低噪、明顯季節性
  2. 成長型 (Growth)    — 正向趨勢
  3. 間歇性 (Intermittent) — 低頻、不規則

前 330 天作為訓練集，最後 35 天作為測試集。
計算各模型 MAE / MAPE，輸出 JSON 報告 + 終端摘要表。
"""

import sys
import os
import json
import time
import numpy as np
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from ml.simulation.data_generator import DataGenerator, DemandProfile
from ml.demand_forecasting.forecaster_factory import ForecasterFactory

# ─── Constants ───
TOTAL_DAYS = 365
TEST_DAYS = 35
TRAIN_DAYS = TOTAL_DAYS - TEST_DAYS
SEED = 42
DIVIDER = "=" * 72


# ─── SKU Profiles ───
PROFILES = {
    "STABLE-001": DemandProfile(
        name="stable",
        base_demand=100,
        trend_per_day=0.0,
        trend_type="linear",
        weekly_amplitude=10,
        monthly_amplitude=5,
        yearly_amplitude=15,
        noise_std=3,
        shock_probability=0.0,
        promo_interval_days=0,   # No promos for clean test
        min_demand=0,
    ),
    "GROWTH-002": DemandProfile(
        name="growth",
        base_demand=50,
        trend_per_day=0.5,
        trend_type="linear",
        weekly_amplitude=5,
        monthly_amplitude=3,
        yearly_amplitude=8,
        noise_std=4,
        shock_probability=0.0,
        promo_interval_days=0,
        min_demand=0,
    ),
    "INTERMITTENT-003": DemandProfile(
        name="intermittent",
        base_demand=5,
        trend_per_day=0.0,
        trend_type="linear",
        weekly_amplitude=2,
        monthly_amplitude=1,
        yearly_amplitude=3,
        noise_std=8,
        shock_probability=0.15,
        shock_magnitude_range=(0.1, 4.0),
        shock_duration_range=(1, 3),
        promo_interval_days=0,
        min_demand=0,
    ),
}


def calculate_mae(actual, forecast):
    """計算 MAE (Mean Absolute Error)"""
    actual_arr = np.array(actual)
    forecast_arr = np.array(forecast)
    return float(np.mean(np.abs(actual_arr - forecast_arr)))


def calculate_mape(actual, forecast):
    """計算 MAPE (Mean Absolute Percentage Error)"""
    actual_arr = np.array(actual)
    forecast_arr = np.array(forecast)
    mask = actual_arr != 0
    if not mask.any():
        return 999.0
    return float(np.mean(np.abs((actual_arr[mask] - forecast_arr[mask]) / actual_arr[mask])) * 100)


def calculate_bias(actual, forecast):
    """計算 Bias (正=高估, 負=低估)"""
    return float(np.mean(np.array(forecast) - np.array(actual)))


def grade_mape(mape):
    if mape < 10:
        return "A+ (神諭級)"
    elif mape < 20:
        return "A (工業級優等)"
    elif mape < 50:
        return "B (可接受)"
    else:
        return "F (不可靠)"


def run_benchmark():
    print(f"\n{'━' * 72}")
    print(f"  📊 Decision-Intelligence 合成數據基準線測試")
    print(f"  ⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  📅 總天數: {TOTAL_DAYS} (訓練: {TRAIN_DAYS}, 測試: {TEST_DAYS})")
    print(f"  🌱 隨機種子: {SEED}")
    print(f"{'━' * 72}")

    gen = DataGenerator(seed=SEED)
    factory = ForecasterFactory()
    all_results = {}

    for sku, profile in PROFILES.items():
        print(f"\n{DIVIDER}")
        print(f"  🏭 SKU: {sku}  ({profile.name})")
        print(DIVIDER)

        # 1. Generate data
        df = gen.generate(profile, days=TOTAL_DAYS)
        full_history = df["demand"].tolist()
        train_data = full_history[:TRAIN_DAYS]
        actual_test = full_history[TRAIN_DAYS:]

        print(f"  📈 訓練集: mean={np.mean(train_data):.1f}, std={np.std(train_data):.1f}")
        print(f"  🎯 測試集: mean={np.mean(actual_test):.1f}, std={np.std(actual_test):.1f}")

        # 2. Backtest via ForecasterFactory
        t0 = time.time()
        backtest_result = factory.backtest(
            sku=sku,
            full_history=[float(v) for v in full_history],
            test_days=TEST_DAYS,
        )
        elapsed = time.time() - t0

        if "error" in backtest_result:
            print(f"  ❌ 回測失敗: {backtest_result['error']}")
            all_results[sku] = {"error": backtest_result["error"]}
            continue

        # 3. Analyze each model
        sku_report = {
            "profile": profile.name,
            "train_points": TRAIN_DAYS,
            "test_points": TEST_DAYS,
            "train_stats": {
                "mean": round(float(np.mean(train_data)), 2),
                "std": round(float(np.std(train_data)), 2),
            },
            "test_stats": {
                "mean": round(float(np.mean(actual_test)), 2),
                "std": round(float(np.std(actual_test)), 2),
            },
            "models": [],
            "best_model": backtest_result.get("best_model", {}),
            "reliability": backtest_result.get("reliability", "unknown"),
            "accuracy_score": backtest_result.get("accuracy_score", 0),
            "elapsed_s": round(elapsed, 3),
        }

        print(f"\n  📋 各模型表現 (測試 {TEST_DAYS} 天):")
        print(f"  {'模型':<14} {'MAPE':>8} {'MAE':>8} {'Bias':>8} {'等級':<20}")
        print(f"  {'-'*62}")

        for r in backtest_result.get("results", []):
            if not r.get("success"):
                print(f"  {r['model']:<14} {'失敗':>8}   {r.get('error', 'Unknown')[:30]}")
                sku_report["models"].append({
                    "model": r["model"],
                    "success": False,
                    "error": r.get("error", "Unknown"),
                })
                continue

            forecast_vals = r["forecast"][:TEST_DAYS]
            actual_vals = r["actual"][:TEST_DAYS]

            mae = calculate_mae(actual_vals, forecast_vals)
            mape = r["mape"]
            bias = calculate_bias(actual_vals, forecast_vals)
            grade = grade_mape(mape)

            print(f"  {r['model']:<14} {mape:>7.2f}% {mae:>7.2f} {bias:>+7.2f} {grade}")

            sku_report["models"].append({
                "model": r["model"],
                "success": True,
                "mape": round(mape, 2),
                "mae": round(mae, 2),
                "bias": round(bias, 2),
                "grade": grade,
            })

        # Best model summary
        best = backtest_result.get("best_model", {})
        print(f"\n  🏆 最佳: {best.get('name', 'N/A')} (MAPE {best.get('mape', 0):.2f}%)")
        print(f"  🔒 可信度: {backtest_result.get('reliability', 'N/A').upper()}")
        print(f"  💡 {backtest_result.get('recommendation', 'N/A')}")
        print(f"  ⏱️  耗時: {elapsed:.3f}s")

        all_results[sku] = sku_report

    # ── Summary Table ──
    print(f"\n{'━' * 72}")
    print(f"  📋 基準線測試彙總報告")
    print(f"{'━' * 72}")
    print(f"  {'SKU':<22} {'類型':<12} {'最佳模型':<12} {'MAPE':>7} {'MAE':>7} {'可信度':<10}")
    print(f"  {'-'*72}")

    for sku, report in all_results.items():
        if "error" in report:
            print(f"  {sku:<22} {'ERROR':<12}")
            continue
        best = report.get("best_model", {})
        successful_models = [m for m in report["models"] if m.get("success")]
        best_model_detail = next(
            (m for m in successful_models if m["model"] == best.get("name")), {}
        )
        print(
            f"  {sku:<22} {report['profile']:<12} "
            f"{best.get('name', 'N/A'):<12} "
            f"{best.get('mape', 0):>6.2f}% "
            f"{best_model_detail.get('mae', 0):>6.2f} "
            f"{report.get('reliability', '?'):<10}"
        )

    # ── Validation Checks ──
    print(f"\n{DIVIDER}")
    print(f"  🔍 基準線驗證檢查")
    print(DIVIDER)

    checks = []

    # Check 1: 穩定型 MAPE should be lowest
    stable = all_results.get("STABLE-001", {})
    stable_best_mape = stable.get("best_model", {}).get("mape", 999)
    intermittent = all_results.get("INTERMITTENT-003", {})
    intermittent_best_mape = intermittent.get("best_model", {}).get("mape", 0)

    c1 = stable_best_mape < intermittent_best_mape
    checks.append(("穩定型 MAPE < 間歇性 MAPE (模型對規律數據更準)", c1))

    # Check 2: 成長型 bias should reflect growth
    growth = all_results.get("GROWTH-002", {})
    growth_models = [m for m in growth.get("models", []) if m.get("success")]
    # At least one model should have relatively low MAPE
    c2 = any(m.get("mape", 999) < 50 for m in growth_models)
    checks.append(("成長型至少一個模型 MAPE < 50%", c2))

    # Check 3: 間歇性 CI should be wider (risk score higher)
    c3 = intermittent_best_mape > stable_best_mape
    checks.append(("間歇性難度 > 穩定型 (符合供應鏈常識)", c3))

    all_pass = True
    for desc, passed in checks:
        icon = "✅" if passed else "❌"
        print(f"  {icon} {desc}")
        if not passed:
            all_pass = False

    if all_pass:
        print(f"\n  🎉 基準線驗證全數通過！合成數據的模型表現符合預期。")
    else:
        print(f"\n  ⚠️  部分驗證未通過，建議檢查模型或數據設定。")

    # ── Save JSON Report ──
    report_path = os.path.join(os.path.dirname(__file__), '..', 'benchmark_report.json')
    json_report = {
        "timestamp": datetime.now().isoformat(),
        "seed": SEED,
        "total_days": TOTAL_DAYS,
        "train_days": TRAIN_DAYS,
        "test_days": TEST_DAYS,
        "results": all_results,
        "validation_checks": [
            {"description": desc, "passed": passed}
            for desc, passed in checks
        ],
        "all_passed": all_pass,
    }
    with open(report_path, 'w', encoding='utf-8') as f:
        json.dump(json_report, f, indent=2, ensure_ascii=False)
    print(f"\n  💾 JSON 報告已存至: {report_path}")
    print(f"{'━' * 72}\n")

    return json_report


if __name__ == "__main__":
    run_benchmark()
