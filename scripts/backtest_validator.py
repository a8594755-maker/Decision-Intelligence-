"""
📊 SmartOps 回測驗證器 (Backtesting Validator)
==============================================
驗證雙模型系統的「誠實度」— 用真實數據檢驗 AI 預測準確度。

核心邏輯：
  1. 將歷史數據切成「學習卷」(Train) 和「考卷」(Test)
  2. 模型只看學習卷，預測接下來 N 天
  3. 與考卷的真實值對比，計算 MAPE
  4. 評級並給出可信度建議

可直接運行或透過 FastAPI /backtest 端點使用。
"""

import sys
import os
import json
import time
import numpy as np
from datetime import datetime
from typing import List, Dict, Optional

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
# MAPE 計算與評級
# ─────────────────────────────────────────────────
def calculate_mape(actual: List[float], forecast: List[float]) -> float:
    """計算 MAPE (Mean Absolute Percentage Error)"""
    actual_arr = np.array(actual)
    forecast_arr = np.array(forecast)
    
    # 避免除以零
    mask = actual_arr != 0
    if not mask.any():
        return 999.0
    
    actual_filtered = actual_arr[mask]
    forecast_filtered = forecast_arr[mask]
    
    mape = np.mean(np.abs((actual_filtered - forecast_filtered) / actual_filtered)) * 100
    return float(mape)


def calculate_bias(actual: List[float], forecast: List[float]) -> float:
    """計算偏差 (Mean Error) — 正值表示模型傾向高估"""
    return float(np.mean(np.array(forecast) - np.array(actual)))


def grade_mape(mape: float) -> str:
    """MAPE 成績單解析"""
    if mape < 10:
        return "A+ (神諭級) ⭐⭐⭐"
    elif mape < 20:
        return "A (工業級優等) ⭐⭐"
    elif mape < 50:
        return "B (可接受，需複核) ⭐"
    else:
        return "F (垃圾進，垃圾出) ⚠️"


def get_reliability_advice(best_mape: float) -> tuple:
    """根據最佳 MAPE 給出可信度建議"""
    if best_mape < 20:
        return (
            "trusted",
            "✅ AI 預測具備實戰參考價值",
            "模型對此 SKU 的歷史預測準確率高，可直接用於庫存決策。"
        )
    elif best_mape < 50:
        return (
            "caution", 
            "⚠️ 預測準確度一般，建議增加安全庫存緩衝",
            f"目前模型對此 SKU 的歷史預測準確率僅為 {100-best_mape:.0f}%，建議保守規劃。"
        )
    else:
        return (
            "unreliable",
            "❌ 模型對此 SKU 的預測不可靠",
            "誤差過大，AI 可能無法理解當前的數據模式，請檢查數據源或改用人工判斷。"
        )


# ─────────────────────────────────────────────────
# 執行回測
# ─────────────────────────────────────────────────
def run_backtest_api(material_name: str, full_history: List[float], test_days: int = 7) -> Dict:
    """透過 HTTP 打 /backtest 端點"""
    payload = {
        "materialCode": material_name,
        "history": full_history,
        "testDays": test_days
    }
    resp = requests.post(f"{API_URL}/backtest", json=payload, timeout=30)
    return resp.json()


def run_backtest_local(material_name: str, full_history: List[float], test_days: int = 7) -> Dict:
    """本地直接呼叫 ForecasterFactory.backtest"""
    return factory.backtest(
        sku=material_name,
        full_history=full_history,
        test_days=test_days
    )


def run_backtest(material_name: str, full_history: List[float], test_days: int = 7) -> Dict:
    """統一入口"""
    if USE_API:
        return run_backtest_api(material_name, full_history, test_days)
    else:
        return run_backtest_local(material_name, full_history, test_days)


# ─────────────────────────────────────────────────
# 漂亮列印
# ─────────────────────────────────────────────────
DIVIDER = "=" * 72


def print_report(result: Dict):
    """列印回測報告"""
    if "error" in result:
        print(f"\n  ❌ 錯誤: {result['error']}")
        if "details" in result:
            for detail in result["details"]:
                print(f"     - {detail.get('model', 'unknown')}: {detail.get('error', 'Unknown')}")
        # 顯示完整原始回應供除錯
        if "raw" in result:
            print(f"\n  � 原始回應片段: {str(result['raw'])[:200]}...")
        return
    
    # 使用 .get() 避免 KeyError
    sku = result.get('sku', result.get('materialCode', 'Unknown'))
    print(f"\n  📦 SKU: {sku}")
    print(f"  📊 訓練數據: {result['train_points']} 天 | 測試數據: {result['test_days']} 天")
    print(f"  🎯 準確度評分: {result.get('accuracy_score', 0):.1f}/100")
    print(f"  🔒 可信度: {result['reliability'].upper()}")
    print(f"\n  💡 系統建議: {result['recommendation']}")
    
    print(f"\n  📋 各模型表現:")
    print(f"  {'模型':<15} {'MAPE':>10} {'評級':<25} {'偏差':>10}")
    print("  " + "-" * 65)
    
    for r in result.get("results", []):
        if r.get("success"):
            bias_str = f"{r['bias']:+.1f}" if r.get('bias') is not None else "N/A"
            print(f"  {r['model']:<15} {r['mape']:>9.2f}% {r['grade']:<25} {bias_str:>10}")
        else:
            print(f"  {r['model']:<15} {'N/A':>10} {'失敗: ' + r.get('error', 'Unknown')[:20]:<25}")
    
    # 最佳模型
    best = result.get("best_model", {})
    print(f"\n  🏆 最佳模型: {best.get('name', 'N/A')} (MAPE: {best.get('mape', 0):.2f}%)")
    
    # 共識度
    consensus = result.get("consensus", {})
    if consensus.get("level") != "insufficient_data":
        level_icon = {"high": "🟢", "medium": "🟡", "low": "🔴"}.get(consensus["level"], "⚪")
        print(f"  🔗 模型共識度: {level_icon} {consensus['level'].upper()}")
        if consensus.get("mape_variance"):
            print(f"     MAPE 方差: {consensus['mape_variance']:.2f}")
    
    # 詳細對比 - 使用 .get() 安全存取
    test_days = result.get('test_days', result.get('horizonDays', 7))
    print(f"\n  📈 預測 vs 實際對比 (最近 {test_days} 天):")
    print(f"  {'天數':<6} {'實際值':>10} {'預測值':>10} {'誤差':>10} {'誤差%':>8}")
    print("  " + "-" * 50)
    
    # 找出一個成功的結果來顯示對比
    for r in result.get("results", []):
        if r.get("success") and "actual" in r:
            actual = r["actual"]
            forecast = r["forecast"]
            for i, (a, f) in enumerate(zip(actual, forecast)):
                err = f - a
                err_pct = (err / a * 100) if a != 0 else 0
                marker = "⚠️" if abs(err_pct) > 50 else " " if abs(err_pct) > 20 else "✓"
                print(f"  Day-{i+1:<2} {a:>10.1f} {f:>10.1f} {err:>+10.1f} {err_pct:>+7.1f}% {marker}")
            break


def print_summary_table(all_results: List[tuple]):
    """列印所有 SKU 的彙總表"""
    print(f"\n{DIVIDER}")
    print("  📊 回測彙總報告")
    print(DIVIDER)
    print(f"  {'SKU':<25} {'最佳模型':<12} {'MAPE':>8} {'評級':<20} {'可信度':<10}")
    print("  " + "-" * 85)
    
    for name, result in all_results:
        if "error" in result:
            print(f"  {name:<25} {'ERROR':<12} {'N/A':>8} {'N/A':<20} {'N/A':<10}")
            continue
        
        best = result.get("best_model", {})
        reliability = result.get("reliability", "unknown")
        icon = {"trusted": "✅", "caution": "⚠️", "unreliable": "❌"}.get(reliability, "❓")
        
        print(f"  {name:<25} {best.get('name', 'N/A'):<12} {best.get('mape', 0):>7.2f}% {best.get('grade', 'N/A'):<20} {icon} {reliability:<10}")
    
    # 統計
    successful = [r for _, r in all_results if "error" not in r]
    if successful:
        trusted_count = sum(1 for r in successful if r.get("reliability") == "trusted")
        caution_count = sum(1 for r in successful if r.get("reliability") == "caution")
        unreliable_count = sum(1 for r in successful if r.get("reliability") == "unreliable")
        
        print(f"\n  📈 統計:")
        print(f"     ✅ 可信賴: {trusted_count} 個 SKU")
        print(f"     ⚠️  需謹慎: {caution_count} 個 SKU")
        print(f"     ❌ 不可靠: {unreliable_count} 個 SKU")
    
    print(DIVIDER)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 測試情境
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def get_test_scenarios() -> List[tuple]:
    """獲取預設測試情境"""
    scenarios = []
    
    # 情境 1: 穩定增長（應該預測準確）
    scenarios.append((
        "穩定增長 SKU-001",
        [10, 12, 11, 13, 15, 14, 16, 18, 20, 19, 21, 23, 22, 25, 27, 26, 28, 30, 29, 31, 33, 32]
    ))
    
    # 情境 2: 季節性波動（考驗 Prophet）
    seasonal = []
    base = 50
    for i in range(30):
        seasonal.append(base + 10 * np.sin(i * 2 * np.pi / 7) + np.random.normal(0, 2))
    scenarios.append(("季節性 SKU-002", [round(x, 1) for x in seasonal]))
    
    # 情境 3: 黑天鵝後的穩定期（考驗回復能力）
    scenarios.append((
        "黑天鵝後 SKU-003",
        [20]*15 + [80] + [22, 23, 21, 24, 25, 23, 26]  # 15天穩定 -> 激增 -> 恢復
    ))
    
    # 情境 4: 高噪訊（挑戰準確度極限）
    np.random.seed(42)
    noisy = [50 + np.random.normal(0, 15) for _ in range(30)]
    scenarios.append(("高噪訊 SKU-004", [max(0, round(x, 1)) for x in noisy]))
    
    return scenarios


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 主程式
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def main():
    print("\n" + "━" * 72)
    print("  📊 SmartOps 回測驗證器 — AI 誠實度測試")
    print(f"  ⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  🔧 模式: {'HTTP API' if USE_API else '本地離線'}")
    print("━" * 72)
    print("\n  核心邏輯：保留最後 7 天不給模型看，讓它預測，再與真實值對比。")
    print("  評分標準：MAPE <10% A+ | <20% A | <50% B | >=50% F")
    print("━" * 72)
    
    scenarios = get_test_scenarios()
    all_results = []
    
    for name, history in scenarios:
        print(f"\n{DIVIDER}")
        print(f"  🧪 測試: {name}")
        print(f"  📝 數據: {len(history)} 天歷史數據")
        print(DIVIDER)
        
        if len(history) < 17:  # 至少 10 + 7
            print(f"  ⚠️  數據不足 (需要至少 17 天)，跳過")
            continue
        
        t0 = time.time()
        result = run_backtest(name, history, test_days=7)
        elapsed = time.time() - t0
        
        print(f"  ⏱️  耗時: {elapsed:.3f}s")
        print_report(result)
        all_results.append((name, result))
    
    # 彙總
    print_summary_table(all_results)
    
    # 最終建議
    print("\n  💡 行動建議:")
    trusted = sum(1 for _, r in all_results if r.get("reliability") == "trusted")
    total = len([r for _, r in all_results if "error" not in r])
    
    if total > 0:
        trust_rate = trusted / total * 100
        if trust_rate >= 80:
            print(f"     ✅ 整體可信度高 ({trust_rate:.0f}%)，雙模型系統表現優異！")
        elif trust_rate >= 50:
            print(f"     ⚠️  部分 SKU 需要關注 ({trust_rate:.0f}% 可信)，建議審查低分 SKU 的數據質量。")
        else:
            print(f"     ❌ 整體可信度偏低 ({trust_rate:.0f}%)，建議檢查數據源或調整模型參數。")
    
    print("\n  📝 你可以把這個回測邏輯整合進 Dashboard，顯示「模型信心得分」！")
    print("━" * 72 + "\n")


if __name__ == "__main__":
    main()
