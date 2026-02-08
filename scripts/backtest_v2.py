"""
P0-2.2: Walk-Forward Rolling Origin Backtest + Naive Baseline Gate
──────────────────────────────────────────────────────────────────
不是只做一次 holdout，而是多次滾動：
  - 每次往前滾 step_days 天做一次 holdout
  - 收集多次 MAPE 分佈
  - 加 baseline（naive: yhat = last_7_mean）
  - 要求模型至少贏 baseline 才能 deploy

Usage:
    python scripts/backtest_v2.py
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import json
import numpy as np
from typing import List, Dict, Optional
from ml.demand_forecasting.data_contract import SalesSeries
from ml.demand_forecasting.forecaster_factory import ForecasterFactory, ModelType


def naive_baseline(train_values: List[float], horizon: int) -> List[float]:
    """Naive baseline: yhat = mean of last 7 days"""
    last_7 = train_values[-7:] if len(train_values) >= 7 else train_values
    mean_val = float(np.mean(last_7))
    return [mean_val] * horizon


def calculate_mape(actual: List[float], forecast: List[float]) -> float:
    """MAPE with zero-actual exclusion"""
    actual_arr = np.array(actual)
    forecast_arr = np.array(forecast)
    mask = actual_arr != 0
    if not mask.any():
        return 999.0
    return float(np.mean(np.abs((actual_arr[mask] - forecast_arr[mask]) / actual_arr[mask])) * 100)


def walk_forward_backtest(
    series: SalesSeries,
    model_names: List[str] = None,
    horizon: int = 7,
    step_days: int = 7,
    min_train: int = 60,
) -> Dict:
    """
    Walk-Forward Rolling Origin Backtest.

    Parameters:
        series: 完整歷史 SalesSeries
        model_names: 要測試的模型 ["lightgbm", "prophet", "chronos"]
        horizon: 每次預測天數
        step_days: 每次滾動步長
        min_train: 最少訓練資料點數

    Returns:
        完整回測報告 dict
    """
    model_names = model_names or ["lightgbm", "chronos"]
    factory = ForecasterFactory()
    values = series.to_values_list()
    n = len(values)

    if n < min_train + horizon:
        return {"error": f"資料不足: {n} < {min_train} + {horizon}"}

    # 計算滾動窗口
    origins = []
    start = min_train
    while start + horizon <= n:
        origins.append(start)
        start += step_days

    if not origins:
        return {"error": "無法建立任何滾動窗口"}

    # 每個模型 + baseline 的結果
    model_results = {name: [] for name in model_names}
    model_results["naive_baseline"] = []

    for origin in origins:
        train_data = values[:origin]
        actual = values[origin:origin + horizon]
        actual_len = len(actual)

        # Naive baseline
        baseline_pred = naive_baseline(train_data, actual_len)
        baseline_mape = calculate_mape(actual, baseline_pred)
        model_results["naive_baseline"].append({
            "origin": origin,
            "mape": baseline_mape,
        })

        # Each model
        for model_name in model_names:
            try:
                model_type = ModelType(model_name.lower())
                strategy = factory.get_strategy(model_type)
                result = strategy.predict(
                    sku="BACKTEST",
                    inline_history=train_data,
                    horizon_days=actual_len,
                )
                if result.get("success"):
                    preds = result["prediction"]["predictions"][:actual_len]
                    mape = calculate_mape(actual, preds)
                    model_results[model_name].append({
                        "origin": origin,
                        "mape": mape,
                        "preds_sample": [round(p, 1) for p in preds[:3]],
                    })
                else:
                    model_results[model_name].append({
                        "origin": origin,
                        "mape": None,
                        "error": result.get("error", "Unknown"),
                    })
            except Exception as e:
                model_results[model_name].append({
                    "origin": origin,
                    "mape": None,
                    "error": str(e),
                })

    # 彙總
    summary = {}
    for name, results in model_results.items():
        valid_mapes = [r["mape"] for r in results if r.get("mape") is not None]
        if valid_mapes:
            summary[name] = {
                "mean_mape": round(float(np.mean(valid_mapes)), 2),
                "median_mape": round(float(np.median(valid_mapes)), 2),
                "std_mape": round(float(np.std(valid_mapes)), 2),
                "min_mape": round(float(np.min(valid_mapes)), 2),
                "max_mape": round(float(np.max(valid_mapes)), 2),
                "n_folds": len(valid_mapes),
                "n_failed": len(results) - len(valid_mapes),
            }
        else:
            summary[name] = {
                "mean_mape": None,
                "n_folds": 0,
                "n_failed": len(results),
            }

    # Baseline gate: 模型必須贏 baseline
    baseline_mean = summary.get("naive_baseline", {}).get("mean_mape")
    gate_results = {}
    for name in model_names:
        model_mean = summary.get(name, {}).get("mean_mape")
        if model_mean is not None and baseline_mean is not None:
            beats_baseline = model_mean < baseline_mean
            improvement = round(baseline_mean - model_mean, 2) if beats_baseline else 0
            gate_results[name] = {
                "beats_baseline": beats_baseline,
                "model_mape": model_mean,
                "baseline_mape": baseline_mean,
                "improvement_pp": improvement,
                "deploy_approved": beats_baseline and model_mean < 20,
            }
        else:
            gate_results[name] = {
                "beats_baseline": False,
                "deploy_approved": False,
                "reason": "Insufficient data or all folds failed",
            }

    # Find best model
    deployable = {k: v for k, v in gate_results.items() if v.get("deploy_approved")}
    best_model = min(deployable, key=lambda k: gate_results[k]["model_mape"]) if deployable else None

    return {
        "series_info": series.summary(),
        "config": {
            "horizon": horizon,
            "step_days": step_days,
            "min_train": min_train,
            "n_origins": len(origins),
        },
        "summary": summary,
        "gate_results": gate_results,
        "best_model": best_model,
        "recommendation": _recommendation(best_model, gate_results, summary),
        "details": model_results,
    }


def _recommendation(best: Optional[str], gates: Dict, summary: Dict) -> str:
    if best:
        mape = gates[best]["model_mape"]
        improvement = gates[best]["improvement_pp"]
        return (
            f"✅ Deploy {best} (mean MAPE {mape}%, "
            f"beats baseline by {improvement}pp)"
        )
    # Check if any model exists but failed gate
    failed = [k for k, v in gates.items() if not v.get("deploy_approved")]
    if failed:
        reasons = []
        for f in failed:
            m = summary.get(f, {}).get("mean_mape")
            if m and m >= 20:
                reasons.append(f"{f}: MAPE {m}% >= 20% gate")
            elif m and gates[f].get("baseline_mape") and m >= gates[f]["baseline_mape"]:
                reasons.append(f"{f}: doesn't beat naive baseline ({gates[f]['baseline_mape']}%)")
            else:
                reasons.append(f"{f}: insufficient data")
        return f"❌ No model approved. {'; '.join(reasons)}"
    return "❌ No models tested"


# ── CLI ──
if __name__ == "__main__":
    np.random.seed(42)
    days = 180
    dates = np.arange(days)
    sales = 50 + 5 * np.sin(2 * np.pi * dates / 7) + 0.02 * dates + np.random.normal(0, 4, days)
    sales = np.maximum(sales, 0).round(1)

    import pandas as pd
    series = SalesSeries.from_inline_history(
        values=sales.tolist(),
        base_date='2025-01-01',
        sku='BACKTEST-DEMO'
    )

    print("=" * 60)
    print("  Walk-Forward Rolling Origin Backtest")
    print("=" * 60)
    print(f"  Series: {series}")
    print(f"  Data: {series.date_range_str}")
    print()

    report = walk_forward_backtest(
        series,
        model_names=["lightgbm", "chronos"],
        horizon=7,
        step_days=7,
        min_train=60,
    )

    if "error" in report:
        print(f"  ERROR: {report['error']}")
        sys.exit(1)

    print(f"  Folds: {report['config']['n_origins']}")
    print()

    print("  Model Summary:")
    print(f"  {'Model':<20s} {'Mean MAPE':>10s} {'Median':>8s} {'Std':>6s} {'Folds':>6s}")
    print("  " + "-" * 52)
    for name, s in report["summary"].items():
        if s.get("mean_mape") is not None:
            print(f"  {name:<20s} {s['mean_mape']:>9.2f}% {s['median_mape']:>7.2f}% {s['std_mape']:>5.2f} {s['n_folds']:>6d}")
        else:
            print(f"  {name:<20s} {'N/A':>10s}")

    print()
    print("  Gate Results:")
    for name, g in report["gate_results"].items():
        status = "✅ PASS" if g.get("deploy_approved") else "❌ FAIL"
        print(f"  {name}: {status} — {json.dumps({k: v for k, v in g.items() if k != 'deploy_approved'}, default=str)}")

    print()
    print(f"  {report['recommendation']}")
    print()

    # Save report
    report_path = os.path.join(os.path.dirname(__file__), '..', 'backtest_report.json')
    # Remove non-serializable details for JSON
    json_report = {k: v for k, v in report.items() if k != 'details'}
    with open(report_path, 'w', encoding='utf-8') as f:
        json.dump(json_report, f, indent=2, ensure_ascii=False, default=str)
    print(f"  Report saved to: {report_path}")
