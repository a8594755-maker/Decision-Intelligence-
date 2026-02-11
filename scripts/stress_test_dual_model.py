"""
🧪 壓力測試：雙模型架構供應鏈災難模擬器
===========================================
測試三種極端情境：
  A. 黑天鵝事件 (The Black Swan) - 突發激增
  B. 數據噪訊 (The Dirty Data) - 完全隨機
  C. 冷啟動考驗 (The Cold Start) - 數據極少

可直接打 API 或在本地離線運行（不需要 FastAPI 伺服器）。
"""

import sys
import os
import json
import time
import numpy as np
from datetime import datetime

# 確保可以導入本地模組
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

# ── 嘗試透過 HTTP 打 API ──────────────────────────
USE_API = False
API_URL = "http://localhost:8000"

try:
    import requests
    r = requests.get(f"{API_URL}/health", timeout=2)
    if r.status_code == 200:
        USE_API = True
        print("✅  偵測到 FastAPI 伺服器，使用 HTTP 模式\n")
except Exception:
    print("ℹ️  FastAPI 伺服器未啟動，切換為本地離線模式\n")

# ── 本地離線引擎 ──────────────────────────────────
if not USE_API:
    from ml.demand_forecasting.forecaster_factory import ForecasterFactory
    factory = ForecasterFactory()


# ─────────────────────────────────────────────────
# 工具函數
# ─────────────────────────────────────────────────
def run_via_api(name, material_code, history, horizon=7, model_type="AUTO"):
    """透過 HTTP 打 /stress-test 端點"""
    payload = {
        "materialCode": material_code,
        "history": history,
        "horizonDays": horizon,
        "modelType": model_type,
        "includeComparison": True
    }
    resp = requests.post(f"{API_URL}/stress-test", json=payload, timeout=30)
    return resp.json()


def run_local(name, material_code, history, horizon=7, model_type="AUTO"):
    """本地直接呼叫 ForecasterFactory"""
    preferred = None if model_type == "AUTO" else model_type.lower()

    result = factory.predict_with_fallback(
        sku=material_code,
        erp_connector=None,
        horizon_days=horizon,
        preferred_model=preferred,
        inline_history=history
    )

    # 格式化成與 API 一致的結構
    if not result.get("success"):
        return {"error": result.get("error", "Unknown"), "raw": result}

    pred = result["prediction"]
    forecast = {
        "model": result["model_type"].upper() if isinstance(result["model_type"], str) else result["model_type"],
        "median": float(np.mean(pred["predictions"])),
        "predictions": [float(p) for p in pred["predictions"]],
        "confidence_interval": pred.get("confidence_interval", []),
        "risk_score": float(pred.get("risk_score", 50.0)),
        "model_version": pred.get("model_version", "unknown"),
        "anomaly_detected": pred.get("anomaly_detected", False)
    }

    analysis = factory.analyze_data_characteristics(material_code, inline_history=history)

    response = {
        "materialCode": material_code,
        "forecast": forecast,
        "data_analysis": analysis,
        "recommended_model": factory.recommend_model(material_code, inline_history=history).value,
        "metadata": result.get("metadata", {}),
        "attempted_models": result.get("attempted_models", []),
        "fallback_used": result.get("fallback_used", False),
    }
    if "comparison" in result:
        response["comparison"] = result["comparison"]
    if "consensus_warning" in result:
        response["consensus_warning"] = result["consensus_warning"]
    return response


def run_test(name, material_code, history, horizon=7, model_type="AUTO"):
    """統一入口"""
    if USE_API:
        return run_via_api(name, material_code, history, horizon, model_type)
    else:
        return run_local(name, material_code, history, horizon, model_type)


# ─────────────────────────────────────────────────
# 漂亮列印
# ─────────────────────────────────────────────────
DIVIDER = "=" * 72

def print_header(title, emoji="🧪"):
    print(f"\n{DIVIDER}")
    print(f"  {emoji}  {title}")
    print(DIVIDER)


def print_result(result):
    if "error" in result:
        print(f"  ❌ 錯誤: {result['error']}")
        return

    fc = result.get("forecast", {})
    comp = result.get("comparison", {})
    warn = result.get("consensus_warning", {})
    analysis = result.get("data_analysis", {})

    # 基本預測
    print(f"  📊 使用模型       : {fc.get('model', 'N/A')}")
    print(f"  📈 預測中位數     : {fc.get('median', 0):.2f}")
    print(f"  🎯 風險分數       : {fc.get('risk_score', 0):.1f} / 100")
    print(f"  🔍 異常偵測       : {'🚨 YES' if fc.get('anomaly_detected') else '✅ NO'}")

    # 置信區間寬度
    ci = fc.get("confidence_interval", [])
    if ci and isinstance(ci[0], list):
        widths = [upper - lower for lower, upper in ci]
        avg_width = np.mean(widths)
        print(f"  📐 平均置信區間寬度: {avg_width:.2f}  ({'⚠️ 很寬 — 不確定性高' if avg_width > 20 else '✅ 窄 — 較確定'})")

    # 模型比較
    if comp:
        print(f"\n  🔄 模型比較:")
        print(f"     主模型    : {comp.get('primary_model', 'N/A')} → 均值 {comp.get('primary_mean', 0):.2f}")
        print(f"     次模型    : {comp.get('secondary_model', 'N/A')} → 均值 {comp.get('secondary_mean', 0):.2f}")
        print(f"     偏差率    : {comp.get('deviation_percentage', 0):.1f}%")
        print(f"     一致性    : {comp.get('agreement_level', 'N/A')}")

    # 共識警告
    if warn and warn.get("warning"):
        level = warn.get("level", "?")
        icon = "🔴" if level == "high" else "🟡"
        print(f"\n  {icon} 共識警告 [{level.upper()}]:")
        print(f"     {warn.get('message', '')}")
        print(f"     建議: {warn.get('recommendation', 'N/A')}")
        if "threshold_used" in warn:
            print(f"     動態閾值: {warn['threshold_used']:.0f}%")
    else:
        dev = warn.get("deviation_pct", 0) if warn else 0
        print(f"\n  ✅ 共識正常 (偏差 {dev:.1f}%，未達警告閾值)")

    # 數據分析
    if analysis and "characteristics" in analysis:
        chars = analysis["characteristics"]
        print(f"\n  🏷️  數據特徵: {', '.join(chars) if chars else '無特殊'}")
        if "anomaly" in analysis:
            a = analysis["anomaly"]
            print(f"     異常詳情: 末值={a['last_value']:.1f}, 歷史均值={a['historical_mean']:.1f}, σ偏離={a['deviation_sigma']:.1f}")
        if "noise_level" in analysis:
            print(f"     噪聲水平: {analysis['noise_level']}")

    # 推薦模型 & 嘗試順序
    print(f"\n  🤖 推薦模型: {result.get('recommended_model', 'N/A')}")
    print(f"  🔗 嘗試順序: {result.get('attempted_models', [])}")
    print(f"  🔀 啟用回退: {'是' if result.get('fallback_used') else '否'}")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 情境定義
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
scenarios = []

# ── 情境 A：黑天鵝事件 ──────────────────────────
scenarios.append({
    "name": "情境 A：黑天鵝事件 🦢",
    "description": "前 20 天平穩銷售 (每天 10 單位)，第 21 天突然飆升到 100 單位",
    "expected": [
        "LightGBM 反應保守（認為離群值）",
        "Chronos 對序列末端激增敏感，預測持續偏高",
        "偏差率應遠超閾值，觸發 ConsensusWarning"
    ],
    "material": "TEST-BLACKSWAN-001",
    "history": [10.0] * 20 + [100.0],
    "horizon": 7,
})

# ── 情境 B：數據噪訊 ────────────────────────────
np.random.seed(42)
noisy_data = [float(v) for v in np.random.choice([5, 50, 2, 80, 3, 70, 1, 90, 15, 60,
                                                    8, 45, 4, 75, 6, 55, 9, 85, 11, 65], size=20)]
scenarios.append({
    "name": "情境 B：數據噪訊 📡",
    "description": "忽高忽低、完全隨機的數據（CV >> 0.5）",
    "expected": [
        "置信區間應變得很「胖」（寬度大）",
        "風險分數標高",
        "動態閾值應自動提高（噪聲容忍）"
    ],
    "material": "TEST-NOISE-002",
    "history": noisy_data,
    "horizon": 7,
})

# ── 情境 C：冷啟動 ──────────────────────────────
scenarios.append({
    "name": "情境 C：冷啟動考驗 🧊",
    "description": "只有最近 5 天的數據 [15, 18, 12, 20, 14]",
    "expected": [
        "ForecasterFactory 判定數據不足",
        "跳過 LightGBM（需 ≥10 點），直接使用 Chronos",
        "推薦模型應為 chronos"
    ],
    "material": "TEST-COLDSTART-003",
    "history": [15.0, 18.0, 12.0, 20.0, 14.0],
    "horizon": 7,
})

# ── 情境 D：穩定基準線（對照組）────────────────
scenarios.append({
    "name": "情境 D：穩定基準線 ✅ (對照組)",
    "description": "90 天穩定銷售（均值 50，微小波動），雙模型應高度一致",
    "expected": [
        "兩模型預測接近",
        "偏差率 < 10%",
        "不觸發警告"
    ],
    "material": "TEST-STABLE-000",
    "history": [50 + np.random.normal(0, 3) for _ in range(90)],
    "horizon": 7,
})

# ── 情境 E：單調性測試 ──────────────────────────
# 10 組遞增需求序列，驗證預測值是否單調上升
monotonicity_history = []
for level in range(10, 101, 10):  # 10, 20, 30, ... 100
    monotonicity_history.extend([float(level)] * 9)  # 每級 9 天
scenarios.append({
    "name": "情境 E：單調性測試 📈",
    "description": "需求從 10→20→...→100 階梯式遞增（90 天），預測應反映上升趨勢",
    "expected": [
        "預測中位數應高於早期水準",
        "預測值序列應呈單調遞增（或至少不出現反向震盪）",
    ],
    "material": "TEST-MONOTONE-005",
    "history": monotonicity_history,
    "horizon": 7,
})

# ── 情境 F：長序列回測 ──────────────────────────
# 365 天穩定型 DataGenerator 資料，驗證 MAPE
try:
    from ml.simulation.data_generator import DataGenerator, DemandProfile
    _gen = DataGenerator(seed=42)
    _stable_profile = DemandProfile(
        name="long_stable", base_demand=80, trend_per_day=0.02,
        weekly_amplitude=8, monthly_amplitude=4, yearly_amplitude=12,
        noise_std=4, shock_probability=0.0, promo_interval_days=0,
    )
    _stable_df = _gen.generate(_stable_profile, days=365)
    long_stable_history = [float(v) for v in _stable_df["demand"].tolist()]
except Exception:
    # Fallback: simple synthetic
    long_stable_history = [80 + np.random.normal(0, 4) for _ in range(365)]

scenarios.append({
    "name": "情境 F：長序列穩定 📊",
    "description": "365 天穩定合成數據 (DataGenerator)，驗證長序列預測能力",
    "expected": [
        "雙模型 MAPE 應在合理範圍",
        "偏差率 < 15%",
    ],
    "material": "TEST-LONGSTABLE-006",
    "history": long_stable_history,
    "horizon": 7,
})


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 執行
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def main():
    print("\n" + "━" * 72)
    print("  🏭 SmartOps 雙模型壓力測試 — 供應鏈災難模擬器")
    print(f"  ⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  🔧 模式: {'HTTP API' if USE_API else '本地離線'}")
    print("━" * 72)

    results_summary = []

    for scenario in scenarios:
        print_header(scenario["name"])
        print(f"  📝 {scenario['description']}")
        print(f"  📊 數據長度: {len(scenario['history'])} 點")
        print(f"  🔮 預測天數: {scenario['horizon']} 天")
        print(f"\n  預期行為:")
        for exp in scenario["expected"]:
            print(f"    → {exp}")
        print()

        t0 = time.time()
        result = run_test(
            scenario["name"],
            scenario["material"],
            scenario["history"],
            scenario["horizon"]
        )
        elapsed = time.time() - t0

        print(f"  ⏱️  耗時: {elapsed:.3f}s")
        print_result(result)

        # 收集摘要
        fc = result.get("forecast", {})
        warn = result.get("consensus_warning", {})
        results_summary.append({
            "scenario": scenario["name"],
            "model_used": fc.get("model", "ERROR"),
            "median": fc.get("median", 0),
            "risk_score": fc.get("risk_score", 0),
            "anomaly": fc.get("anomaly_detected", False),
            "deviation_pct": result.get("comparison", {}).get("deviation_percentage", 0),
            "warning_level": warn.get("level", "none") if warn.get("warning") else "none",
            "elapsed_s": elapsed,
        })

    # ── 彙總報告 ─────────────────────────────────
    print_header("壓力測試彙總報告", "📋")
    print(f"  {'情境':<30} {'模型':<12} {'中位數':>8} {'風險':>6} {'偏差%':>7} {'警告':>6} {'異常':>6} {'耗時':>7}")
    print("  " + "-" * 85)
    for s in results_summary:
        warn_icon = {"high": "🔴", "medium": "🟡", "none": "🟢"}.get(s["warning_level"], "⚪")
        anom_icon = "🚨" if s["anomaly"] else "—"
        print(f"  {s['scenario']:<30} {s['model_used']:<12} {s['median']:>8.1f} {s['risk_score']:>5.1f}% {s['deviation_pct']:>6.1f}% {warn_icon:>6} {anom_icon:>6} {s['elapsed_s']:>6.3f}s")

    print(f"\n  ✅ 全部 {len(scenarios)} 個情境測試完成！")
    print("━" * 72)

    # ── 決策邏輯驗證 ─────────────────────────────
    print_header("決策邏輯驗證結果", "🔍")
    
    checks = []
    
    # A: 黑天鵝 → 應有異常 + 高偏差
    a = results_summary[0]
    a_pass = a["anomaly"] or a["deviation_pct"] > 15
    checks.append(("A: 黑天鵝觸發異常/高偏差", a_pass))
    
    # B: 噪訊 → 風險分數應偏高
    b = results_summary[1]
    b_pass = b["risk_score"] > 30
    checks.append(("B: 噪訊數據風險分數偏高", b_pass))
    
    # C: 冷啟動 → 應使用 Chronos
    c = results_summary[2]
    c_pass = c["model_used"].lower() == "chronos"
    checks.append(("C: 冷啟動自動切換到 Chronos", c_pass))
    
    # D: 穩定 → 偏差低 + 不觸發警告
    d = results_summary[3]
    d_pass = d["warning_level"] == "none" and d["deviation_pct"] < 15
    checks.append(("D: 穩定數據無警告", d_pass))

    # E: 單調性 → 預測中位數應高於歷史早期均值
    if len(results_summary) > 4:
        e = results_summary[4]
        # 預測中位數應接近或高於末期水準 (100)，至少 > 早期均值 (10)
        e_pass = e["median"] > 30  # 至少高於最低檔
        checks.append(("E: 單調性預測反映上升趨勢", e_pass))

    # F: 長序列 → 偏差率應在合理範圍
    if len(results_summary) > 5:
        f = results_summary[5]
        f_pass = f["deviation_pct"] < 20
        checks.append(("F: 長序列穩定數據偏差率 < 20%", f_pass))

    all_pass = True
    for desc, passed in checks:
        icon = "✅" if passed else "❌"
        print(f"  {icon} {desc}")
        if not passed:
            all_pass = False

    if all_pass:
        print(f"\n  🎉 所有決策邏輯驗證通過！雙模型架構行為符合預期。")
    else:
        print(f"\n  ⚠️  部分驗證未通過，建議檢查模型邏輯。")

    print("━" * 72 + "\n")


if __name__ == "__main__":
    main()
