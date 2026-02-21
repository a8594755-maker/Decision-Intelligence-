#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📊 Step 4: 量化分析與真實性判讀 (Quantitative Analysis & Reliability Verdict)
===============================================================================
整合前三步的輸出，產出最終分析報告：
  1. 偏差率分析 (Deviation Percentage)
  2. 風險分數一致性 (Risk Score Consistency)
  3. 單調性檢查 (Monotonicity)
  4. 綜合信心等級 (TRUSTED / CAUTION / UNRELIABLE)

可獨立執行（會自動運行前三步），也可讀取已有 JSON 報告。
"""

import sys
import os
import json
import time
import numpy as np
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

DIVIDER = "=" * 72
PROJECT_ROOT = os.path.join(os.path.dirname(__file__), '..')


def load_or_run_benchmark():
    """載入 benchmark_report.json 或重新執行 Step 1"""
    report_path = os.path.join(PROJECT_ROOT, 'benchmark_report.json')
    if os.path.exists(report_path):
        with open(report_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    print("  ℹ️  benchmark_report.json 不存在，執行 Step 1...")
    from benchmark_synthetic_data import run_benchmark
    return run_benchmark()


def load_or_run_chaos():
    """載入 chaos_integration_report.json 或重新執行 Step 3"""
    report_path = os.path.join(PROJECT_ROOT, 'chaos_integration_report.json')
    if os.path.exists(report_path):
        with open(report_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    print("  ℹ️  chaos_integration_report.json 不存在，執行 Step 3...")
    from chaos_forecast_integration import main as run_chaos
    return run_chaos()


def run_stress_test_and_collect():
    """
    執行 Step 2 壓力測試並收集結果。
    由於 stress_test 直接 print 結果，我們在此重新用 ForecasterFactory 跑單調性測試。
    """
    from ml.demand_forecasting.forecaster_factory import ForecasterFactory
    factory = ForecasterFactory()

    results = {}

    # ── 單調性測試 ──
    monotonicity_history = []
    for level in range(10, 101, 10):
        monotonicity_history.extend([float(level)] * 9)

    mono_result = factory.predict_with_fallback(
        sku="MONOTONE-TEST",
        inline_history=monotonicity_history,
        horizon_days=7,
    )

    if mono_result.get("success"):
        preds = mono_result["prediction"]["predictions"]
        results["monotonicity"] = {
            "predictions": [round(p, 2) for p in preds],
            "is_monotone": bool(all(preds[i] <= preds[i+1] for i in range(len(preds)-1))),
            "min_pred": round(min(preds), 2),
            "max_pred": round(max(preds), 2),
            "median_pred": round(float(np.median(preds)), 2),
            "history_final_level": 100.0,
            "history_initial_level": 10.0,
        }
    else:
        results["monotonicity"] = {"error": mono_result.get("error", "Unknown")}

    # ── 偏差率測試 (穩定數據) ──
    np.random.seed(42)
    stable_history = [50 + np.random.normal(0, 3) for _ in range(90)]

    stable_result = factory.predict_with_fallback(
        sku="STABLE-DEVIATION-TEST",
        inline_history=stable_history,
        horizon_days=7,
    )

    if stable_result.get("success"):
        comparison = stable_result.get("comparison", {})
        consensus = stable_result.get("consensus_warning", {})
        results["deviation"] = {
            "deviation_pct": round(comparison.get("deviation_percentage", 0), 2),
            "agreement_level": comparison.get("agreement_level", "N/A"),
            "warning_triggered": consensus.get("warning", False),
            "warning_level": consensus.get("level", "none") if consensus.get("warning") else "none",
        }
    else:
        results["deviation"] = {"error": stable_result.get("error", "Unknown")}

    return results


def analyze_deviation(benchmark_data, stress_data):
    """分析 1: 偏差率"""
    findings = []

    # From stress test
    dev = stress_data.get("deviation", {})
    deviation_pct = dev.get("deviation_pct", 999)
    stable_deviation_ok = deviation_pct < 10

    findings.append({
        "test": "穩定數據雙模型偏差率",
        "value": f"{deviation_pct:.1f}%",
        "threshold": "< 10%",
        "passed": stable_deviation_ok,
        "interpretation": "模型高度共識，結論可靠" if stable_deviation_ok
                          else "模型分歧較大，需檢查數據或模型配置",
    })

    # From benchmark: check if stable SKU has lower MAPE than intermittent
    if benchmark_data:
        stable_sku = benchmark_data.get("results", {}).get("STABLE-001", {})
        intermittent_sku = benchmark_data.get("results", {}).get("INTERMITTENT-003", {})
        s_mape = stable_sku.get("best_model", {}).get("mape", 999)
        i_mape = intermittent_sku.get("best_model", {}).get("mape", 0)

        findings.append({
            "test": "穩定型 vs 間歇性 MAPE 排序",
            "value": f"穩定={s_mape:.1f}% vs 間歇={i_mape:.1f}%",
            "threshold": "穩定 < 間歇",
            "passed": s_mape < i_mape,
            "interpretation": "模型對數據複雜度的區辨力正常" if s_mape < i_mape
                              else "模型無法區分穩定與間歇數據",
        })

    return findings


def analyze_risk_consistency(chaos_data):
    """分析 2: 風險分數一致性"""
    findings = []

    if not chaos_data or "results" not in chaos_data:
        findings.append({
            "test": "風險分數與混沌強度相關性",
            "value": "N/A",
            "threshold": "正相關",
            "passed": False,
            "interpretation": "混沌測試數據不可用",
        })
        return findings

    results = chaos_data["results"]
    calm_risk = results.get("calm", {}).get("risk_stats", {}).get("risk_mean", 0)
    high_risk = results.get("high", {}).get("risk_stats", {}).get("risk_mean", 0)
    extreme_risk = results.get("extreme", {}).get("risk_stats", {}).get("risk_mean", 0)

    # Correlation check: risk should increase with chaos
    risk_values = [calm_risk, high_risk, extreme_risk]
    chaos_levels = [1, 2, 3]  # Ordinal encoding

    if np.std(risk_values) > 0 and np.std(chaos_levels) > 0:
        correlation = float(np.corrcoef(chaos_levels, risk_values)[0, 1])
    else:
        correlation = 0.0

    risk_correlation_ok = correlation > 0.3

    findings.append({
        "test": "風險分數 × 混沌強度相關性",
        "value": f"r={correlation:.3f} (calm={calm_risk:.1f}, high={high_risk:.1f}, extreme={extreme_risk:.1f})",
        "threshold": "r > 0.3",
        "passed": risk_correlation_ok,
        "interpretation": "風險感知正常，模型能反映環境不確定性" if risk_correlation_ok
                          else "⚠️ 風險分數與混沌強度不相關 — 模型可能過度擬合",
    })

    # Check: extreme chaos should NOT produce low risk
    extreme_risk_high_enough = extreme_risk > 10
    findings.append({
        "test": "極端混沌下風險分數不為低",
        "value": f"extreme risk_mean={extreme_risk:.1f}",
        "threshold": "> 10",
        "passed": extreme_risk_high_enough,
        "interpretation": "模型正確識別高風險環境" if extreme_risk_high_enough
                          else "⚠️ 模型在極端混沌下仍給出低風險 — 盲目自信",
    })

    return findings


def analyze_monotonicity(stress_data):
    """分析 3: 單調性檢查"""
    findings = []

    mono = stress_data.get("monotonicity", {})
    if "error" in mono:
        findings.append({
            "test": "預測值單調性",
            "value": "N/A",
            "threshold": "遞增或平穩",
            "passed": False,
            "interpretation": f"單調性測試失敗: {mono['error']}",
        })
        return findings

    preds = mono.get("predictions", [])
    is_monotone = mono.get("is_monotone", False)

    # Relaxed check: allow small fluctuations (not strict monotonicity)
    if len(preds) >= 2:
        diffs = np.diff(preds)
        n_decreasing = int(np.sum(diffs < -1))  # Allow tiny dips < 1 unit
        mostly_increasing = n_decreasing <= 1
    else:
        mostly_increasing = True

    # Check that predictions reflect the upward trend
    median_pred = mono.get("median_pred", 0)
    reflects_trend = median_pred > 30  # Should be well above initial level of 10

    findings.append({
        "test": "預測值反映上升趨勢",
        "value": f"中位數={median_pred:.1f} (歷史末期=100)",
        "threshold": "中位數 > 30",
        "passed": reflects_trend,
        "interpretation": "模型捕捉到需求上升趨勢" if reflects_trend
                          else "模型未能反映明顯的上升趨勢",
    })

    findings.append({
        "test": "預測序列大致單調遞增",
        "value": f"嚴格單調={is_monotone}, 反向跳數={n_decreasing if len(preds) >= 2 else 0}",
        "threshold": "反向跳 ≤ 1",
        "passed": mostly_increasing,
        "interpretation": "預測序列穩定遞增" if mostly_increasing
                          else "⚠️ 預測出現反向震盪 — 內部邏輯可能不穩定",
    })

    return findings


def compute_verdict(all_findings):
    """計算綜合信心等級"""
    total = len(all_findings)
    passed = sum(1 for f in all_findings if f["passed"])
    failed = total - passed

    if failed == 0:
        return "TRUSTED", "✅ 所有指標通過 — AI 預測具備實戰參考價值"
    elif failed <= 2:
        return "CAUTION", "⚠️ 部分指標未達標 — 建議增加安全庫存緩衝並持續監控"
    else:
        return "UNRELIABLE", "❌ 多項指標異常 — 模型對此數據形態的預測不可靠，請檢查數據源或改用人工判斷"


def main():
    print(f"\n{'━' * 72}")
    print(f"  📊 Decision-Intelligence 量化分析與真實性判讀")
    print(f"  ⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'━' * 72}")

    t0 = time.time()

    # ── Load/Run Prerequisites ──
    print(f"\n  🔄 載入前置測試結果...")

    benchmark_data = None
    try:
        benchmark_data = load_or_run_benchmark()
        print(f"  ✅ Step 1 (基準線) — 已載入")
    except Exception as e:
        print(f"  ⚠️  Step 1 (基準線) — 失敗: {str(e)[:50]}")

    chaos_data = None
    try:
        chaos_data = load_or_run_chaos()
        print(f"  ✅ Step 3 (混沌整合) — 已載入")
    except Exception as e:
        print(f"  ⚠️  Step 3 (混沌整合) — 失敗: {str(e)[:50]}")

    print(f"  🔄 執行 Step 2 補充測試 (單調性 + 偏差率)...")
    stress_data = run_stress_test_and_collect()
    print(f"  ✅ Step 2 (壓力測試) — 完成")

    # ── Analysis ──
    all_findings = []

    # 1. Deviation Analysis
    print(f"\n{DIVIDER}")
    print(f"  📏 分析 1: 偏差率分析")
    print(DIVIDER)
    deviation_findings = analyze_deviation(benchmark_data, stress_data)
    all_findings.extend(deviation_findings)
    for f in deviation_findings:
        icon = "✅" if f["passed"] else "❌"
        print(f"  {icon} {f['test']}")
        print(f"     值: {f['value']}  (閾值: {f['threshold']})")
        print(f"     → {f['interpretation']}")

    # 2. Risk Score Consistency
    print(f"\n{DIVIDER}")
    print(f"  🎯 分析 2: 風險分數一致性")
    print(DIVIDER)
    risk_findings = analyze_risk_consistency(chaos_data)
    all_findings.extend(risk_findings)
    for f in risk_findings:
        icon = "✅" if f["passed"] else "❌"
        print(f"  {icon} {f['test']}")
        print(f"     值: {f['value']}  (閾值: {f['threshold']})")
        print(f"     → {f['interpretation']}")

    # 3. Monotonicity
    print(f"\n{DIVIDER}")
    print(f"  📈 分析 3: 單調性檢查")
    print(DIVIDER)
    mono_findings = analyze_monotonicity(stress_data)
    all_findings.extend(mono_findings)
    for f in mono_findings:
        icon = "✅" if f["passed"] else "❌"
        print(f"  {icon} {f['test']}")
        print(f"     值: {f['value']}  (閾值: {f['threshold']})")
        print(f"     → {f['interpretation']}")

    # ── Verdict ──
    verdict, recommendation = compute_verdict(all_findings)
    elapsed = time.time() - t0

    print(f"\n{'━' * 72}")
    print(f"  🏁 綜合信心等級: {verdict}")
    print(f"{'━' * 72}")
    print(f"  {recommendation}")
    print(f"\n  📊 統計:")
    total = len(all_findings)
    passed = sum(1 for f in all_findings if f["passed"])
    print(f"     通過: {passed}/{total} ({passed/total*100:.0f}%)")
    print(f"     未通過: {total - passed}/{total}")
    print(f"  ⏱️  總耗時: {elapsed:.2f}s")

    # ── Detailed Findings Table ──
    print(f"\n  {'測試項目':<30} {'結果':>4} {'值':<30}")
    print(f"  {'-'*68}")
    for f in all_findings:
        icon = "✅" if f["passed"] else "❌"
        print(f"  {f['test']:<30} {icon:>4} {f['value']:<30}")

    # ── Save JSON Report ──
    report_path = os.path.join(PROJECT_ROOT, 'quantitative_analysis_report.json')
    json_report = {
        "timestamp": datetime.now().isoformat(),
        "verdict": verdict,
        "recommendation": recommendation,
        "total_checks": total,
        "passed_checks": passed,
        "pass_rate_pct": round(passed / total * 100, 1),
        "findings": all_findings,
        "sources": {
            "benchmark_available": benchmark_data is not None,
            "chaos_available": chaos_data is not None,
        },
        "elapsed_seconds": round(elapsed, 2),
    }
    with open(report_path, 'w', encoding='utf-8') as f:
        json.dump(json_report, f, indent=2, ensure_ascii=False)
    print(f"\n  💾 JSON 報告已存至: {report_path}")
    print(f"{'━' * 72}\n")

    return json_report


if __name__ == "__main__":
    main()
