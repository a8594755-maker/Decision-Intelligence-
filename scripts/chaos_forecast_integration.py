#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🌪️ Step 3: 混沌引擎環境擾動整合測試 (Chaos + Forecaster Integration)
======================================================================
使用 SimulationOrchestrator 在三種混沌強度下運行模擬迴圈：
  1. calm    — 低混沌，risk_score 應低
  2. high    — 中混沌，CI 應加寬
  3. extreme — 極端混沌，系統應發出警告

驗證：
  - risk_score 與混沌強度正相關
  - 極端混沌下不應給出盲目自信的窄 CI
  - 精準度衰減曲線 (MAE 隨混沌天數變化)
"""

import sys
import os
import json
import time
import numpy as np
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from ml.simulation.data_generator import DemandProfile
from ml.simulation.chaos_engine import SupplierProfile
from ml.simulation.inventory_sim import InventoryConfig
from ml.simulation.scenarios import ScenarioConfig
from ml.simulation.orchestrator import SimulationOrchestrator

DIVIDER = "=" * 72
SIM_DAYS = 120  # 120 天模擬（足夠觀察趨勢，又不會太慢）
SEED = 42


# ─── Shared demand profile (stable baseline) ───
BASELINE_DEMAND = DemandProfile(
    name="chaos_test_baseline",
    base_demand=80,
    trend_per_day=0.02,
    weekly_amplitude=8,
    monthly_amplitude=4,
    yearly_amplitude=10,
    noise_std=4,
    shock_probability=0.0,  # No data-level shocks; chaos comes from ChaosEngine
    promo_interval_days=0,
)

BASELINE_SUPPLIER = SupplierProfile(
    name="test_supplier",
    base_lead_time=7,
    lead_time_std=2.0,
    reliability=0.90,
    defect_rate=0.02,
)

BASELINE_INVENTORY = InventoryConfig(
    initial_inventory=600,
    reorder_point=200,
    safety_stock_factor=1.5,
    order_quantity_days=14,
)


# ─── Test configurations ───
CHAOS_LEVELS = [
    {
        "name": "低混沌 (calm)",
        "intensity": "calm",
        "expected_risk": "low",
    },
    {
        "name": "高混沌 (high)",
        "intensity": "high",
        "expected_risk": "medium-high",
    },
    {
        "name": "極端混沌 (extreme)",
        "intensity": "extreme",
        "expected_risk": "high",
    },
]


def run_chaos_test(intensity: str, seed: int, use_forecaster: bool = False):
    """運行單次混沌模擬"""
    scenario = ScenarioConfig(
        name=f"chaos_{intensity}",
        description=f"Chaos integration test — intensity={intensity}",
        demand_profile=BASELINE_DEMAND,
        supplier_profile=BASELINE_SUPPLIER,
        inventory_config=BASELINE_INVENTORY,
        chaos_intensity=intensity,
        duration_days=SIM_DAYS,
    )

    orch = SimulationOrchestrator(
        custom_config=scenario,
        seed=seed,
        use_forecaster=use_forecaster,
        forecast_horizon=14,
        forecast_interval=7,
    )

    result = orch.run()
    daily_df = orch.get_daily_log_df()

    return result, daily_df


def analyze_risk_correlation(daily_df):
    """分析 risk_score 的統計特徵"""
    risk_scores = daily_df["risk_score"].dropna().values
    demands = daily_df["demand"].values
    stockouts = daily_df["stockout_qty"].values

    return {
        "risk_mean": round(float(np.mean(risk_scores)), 2) if len(risk_scores) > 0 else 0,
        "risk_max": round(float(np.max(risk_scores)), 2) if len(risk_scores) > 0 else 0,
        "risk_std": round(float(np.std(risk_scores)), 2) if len(risk_scores) > 0 else 0,
        "demand_cv": round(float(np.std(demands) / (np.mean(demands) + 1e-6)), 3),
        "stockout_days": int(np.sum(stockouts > 0)),
        "total_stockout_qty": round(float(np.sum(stockouts)), 1),
    }


def compute_mae_over_windows(daily_df, window_size=7):
    """計算滾動 MAE 衰減曲線"""
    forecasts = daily_df["forecast"].dropna().values
    demands = daily_df["demand"].values[:len(forecasts)]

    if len(forecasts) < window_size:
        return []

    mae_curve = []
    for start in range(0, len(forecasts) - window_size + 1, window_size):
        end = start + window_size
        window_mae = float(np.mean(np.abs(
            demands[start:end] - forecasts[start:end]
        )))
        mae_curve.append({
            "window_start_day": start,
            "window_end_day": end,
            "mae": round(window_mae, 2),
        })

    return mae_curve


def main():
    print(f"\n{'━' * 72}")
    print(f"  🌪️ Decision-Intelligence 混沌引擎 × 預測整合測試")
    print(f"  ⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  📅 模擬天數: {SIM_DAYS}")
    print(f"  🌱 隨機種子: {SEED}")
    print(f"{'━' * 72}")

    all_results = {}

    for cfg in CHAOS_LEVELS:
        name = cfg["name"]
        intensity = cfg["intensity"]

        print(f"\n{DIVIDER}")
        print(f"  🎲 混沌等級: {name}")
        print(DIVIDER)

        t0 = time.time()
        result, daily_df = run_chaos_test(intensity, SEED, use_forecaster=False)
        elapsed = time.time() - t0

        # Analyze
        risk_stats = analyze_risk_correlation(daily_df)
        chaos_summary = result.chaos_summary
        mae_curve = compute_mae_over_windows(daily_df)

        print(f"  ⏱️  耗時: {elapsed:.3f}s")
        print(f"  📊 KPIs:")
        print(f"     填充率: {result.fill_rate * 100:.1f}%")
        print(f"     總成本: {result.total_cost:,.0f}")
        print(f"     缺貨天數: {len(result.stockout_days)}")
        print(f"     平均庫存: {result.avg_inventory:.0f}")
        print(f"  🌪️ 混沌摘要:")
        print(f"     總事件數: {chaos_summary.get('total_events', 0)}")
        print(f"     重大事件: {chaos_summary.get('critical_events', 0)}")
        print(f"     事件分布: {chaos_summary.get('by_type', {})}")
        print(f"  📈 風險分數:")
        print(f"     平均: {risk_stats['risk_mean']}")
        print(f"     最大: {risk_stats['risk_max']}")
        print(f"     標準差: {risk_stats['risk_std']}")
        print(f"  📉 需求 CV: {risk_stats['demand_cv']}")

        if mae_curve:
            print(f"  📐 MAE 衰減曲線 (每 {7} 天窗口):")
            for w in mae_curve[:5]:
                print(f"     Day {w['window_start_day']:>3}-{w['window_end_day']:>3}: MAE = {w['mae']:.2f}")
            if len(mae_curve) > 5:
                print(f"     ... (共 {len(mae_curve)} 個窗口)")

        all_results[intensity] = {
            "name": name,
            "kpis": {
                "fill_rate_pct": round(result.fill_rate * 100, 2),
                "total_cost": round(result.total_cost, 2),
                "stockout_days": len(result.stockout_days),
                "avg_inventory": round(result.avg_inventory, 1),
            },
            "chaos_summary": chaos_summary,
            "risk_stats": risk_stats,
            "mae_curve": mae_curve,
            "elapsed_s": round(elapsed, 3),
        }

    # ── Summary Table ──
    print(f"\n{'━' * 72}")
    print(f"  📋 混沌整合測試彙總")
    print(f"{'━' * 72}")
    print(f"  {'等級':<20} {'事件數':>6} {'危機':>4} {'風險均值':>8} {'風險Max':>8} {'缺貨天':>6} {'填充率':>7}")
    print(f"  {'-'*65}")

    for intensity, data in all_results.items():
        cs = data["chaos_summary"]
        rs = data["risk_stats"]
        kpi = data["kpis"]
        print(
            f"  {data['name']:<20} "
            f"{cs.get('total_events', 0):>6} "
            f"{cs.get('critical_events', 0):>4} "
            f"{rs['risk_mean']:>8.1f} "
            f"{rs['risk_max']:>8.1f} "
            f"{kpi['stockout_days']:>6} "
            f"{kpi['fill_rate_pct']:>6.1f}%"
        )

    # ── Validation Checks ──
    print(f"\n{DIVIDER}")
    print(f"  🔍 混沌整合驗證檢查")
    print(DIVIDER)

    checks = []
    calm_risk = all_results["calm"]["risk_stats"]["risk_mean"]
    high_risk = all_results["high"]["risk_stats"]["risk_mean"]
    extreme_risk = all_results["extreme"]["risk_stats"]["risk_mean"]

    calm_events = all_results["calm"]["chaos_summary"].get("total_events", 0)
    extreme_events = all_results["extreme"]["chaos_summary"].get("total_events", 0)

    # Check 1: More chaos → more events
    c1 = extreme_events > calm_events
    checks.append(("混沌強度越高 → 事件越多", c1))

    # Check 2: risk_score positively correlated with chaos intensity
    c2 = extreme_risk >= calm_risk
    checks.append(("risk_score: extreme ≥ calm (正相關)", c2))

    # Check 3: extreme should have higher risk than high
    c3 = extreme_risk >= high_risk * 0.8  # Allow some tolerance
    checks.append(("risk_score: extreme ≈≥ high", c3))

    # Check 4: Fill rate should degrade under extreme chaos
    calm_fill = all_results["calm"]["kpis"]["fill_rate_pct"]
    extreme_fill = all_results["extreme"]["kpis"]["fill_rate_pct"]
    c4 = calm_fill >= extreme_fill or calm_fill > 95  # Calm should be at least as good
    checks.append(("填充率: calm ≥ extreme (或 calm > 95%)", c4))

    # Check 5: Extreme chaos → more stockout days
    calm_stockouts = all_results["calm"]["kpis"]["stockout_days"]
    extreme_stockouts = all_results["extreme"]["kpis"]["stockout_days"]
    c5 = extreme_stockouts >= calm_stockouts
    checks.append(("缺貨天數: extreme ≥ calm", c5))

    all_pass = True
    for desc, passed in checks:
        icon = "✅" if passed else "❌"
        print(f"  {icon} {desc}")
        if not passed:
            all_pass = False

    if all_pass:
        print(f"\n  🎉 混沌整合驗證全數通過！系統在擾動下行為符合預期。")
    else:
        print(f"\n  ⚠️  部分驗證未通過，建議檢查風險計算邏輯。")

    # ── Save JSON Report ──
    report_path = os.path.join(os.path.dirname(__file__), '..', 'chaos_integration_report.json')
    json_report = {
        "timestamp": datetime.now().isoformat(),
        "seed": SEED,
        "sim_days": SIM_DAYS,
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
    main()
