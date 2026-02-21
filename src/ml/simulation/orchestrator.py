"""
Week 2A: SimulationOrchestrator — 模擬迴圈編排器
==================================================
The main loop that ties everything together:
  ChaosEngine (Environment) ↔ Decision-Intelligence (Brain) ↔ InventorySimulator (Body)

Each tick = 1 simulated day:
  1. DataGenerator produces base demand
  2. ChaosEngine modifies it (spikes, crashes) + supplier disruptions
  3. InventorySimulator depletes stock, checks stockout
  4. Decision-Intelligence forecaster predicts future demand
  5. Inventory decides whether to place PO
  6. Deliveries arrive (with delays/defects from ChaosEngine)
"""
import sys
import os
import time
import logging
import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Callable
from datetime import datetime, timedelta
from dataclasses import dataclass, field, asdict

from .data_generator import DataGenerator, DemandProfile
from .chaos_engine import ChaosEngine, SupplierProfile
from .inventory_sim import InventorySimulator, InventoryConfig, SimulationState
from .scenarios import ScenarioConfig, get_scenario, SCENARIOS

logger = logging.getLogger(__name__)


@dataclass
class SimulationResult:
    """完整模擬結果"""
    scenario_name: str
    seed: int
    duration_days: int
    inventory_summary: Dict = field(default_factory=dict)
    chaos_summary: Dict = field(default_factory=dict)
    demand_stats: Dict = field(default_factory=dict)
    cost_breakdown: Dict = field(default_factory=dict)
    risk_timeline: List[Dict] = field(default_factory=list)
    stockout_days: List[int] = field(default_factory=list)
    model_accuracy: Dict = field(default_factory=dict)
    elapsed_seconds: float = 0.0

    # KPIs
    fill_rate: float = 0.0
    total_cost: float = 0.0
    avg_inventory: float = 0.0
    inventory_turns: float = 0.0

    def to_dict(self) -> Dict:
        return {
            "scenario": self.scenario_name,
            "seed": self.seed,
            "duration_days": self.duration_days,
            "kpis": {
                "fill_rate_pct": round(self.fill_rate * 100, 2),
                "total_cost": round(self.total_cost, 2),
                "avg_inventory": round(self.avg_inventory, 1),
                "inventory_turns": round(self.inventory_turns, 2),
                "stockout_days": len(self.stockout_days),
            },
            "inventory_summary": self.inventory_summary,
            "chaos_summary": self.chaos_summary,
            "demand_stats": self.demand_stats,
            "cost_breakdown": self.cost_breakdown,
            "model_accuracy": self.model_accuracy,
            "elapsed_seconds": round(self.elapsed_seconds, 2),
        }


class SimulationOrchestrator:
    """
    模擬迴圈編排器 — The Director
    ================================
    串接 DataGenerator + ChaosEngine + InventorySimulator + ForecasterFactory。

    Usage:
        orch = SimulationOrchestrator(scenario="disaster", seed=42)
        result = orch.run()
        print(result.to_dict())
    """

    def __init__(
        self,
        scenario: str = "normal",
        seed: int = 42,
        use_forecaster: bool = True,
        forecast_horizon: int = 14,
        forecast_interval: int = 7,    # 每 N 天跑一次預測
        custom_config: Optional[ScenarioConfig] = None,
        progress_callback: Optional[Callable] = None,
    ):
        self.seed = seed
        self.use_forecaster = use_forecaster
        self.forecast_horizon = forecast_horizon
        self.forecast_interval = forecast_interval
        self.progress_callback = progress_callback

        # Load scenario
        self.scenario = custom_config or get_scenario(scenario)

        # Initialize components
        self.generator = DataGenerator(seed=seed)
        self.chaos = ChaosEngine(
            seed=seed + 1,
            intensity=self.scenario.chaos_intensity,
            supplier=self.scenario.supplier_profile,
        )
        self.inventory = InventorySimulator(self.scenario.inventory_config)

        # Forecaster (lazy-loaded)
        self._forecaster = None
        self._forecast_cache: Optional[List[float]] = None
        self._forecast_day: int = -999
        self._forecast_errors: List[float] = []

    def run(self) -> SimulationResult:
        """執行完整模擬"""
        t0 = time.time()

        # 1. Generate demand data
        demand_df = self.generator.generate(
            self.scenario.demand_profile,
            days=self.scenario.duration_days,
            start_date=self.scenario.start_date,
        )

        demands = demand_df["demand"].values
        dates = demand_df["date"].values
        n = len(demands)

        # 2. Day-by-day simulation loop
        for day in range(n):
            date_str = str(pd.Timestamp(dates[day]).date())

            # ── ChaosEngine: generate daily chaos ──
            current_state = {
                "inventory": self.inventory.state.inventory,
                "daily_demand_avg": self.inventory._avg_daily_demand(),
                "day": day,
            }
            chaos_events = self.chaos.generate_daily_chaos(day, date_str, current_state)

            # ── Apply demand multiplier from chaos ──
            demand_mult = self.chaos.get_demand_multiplier(day)
            actual_demand = max(0, float(demands[day]) * demand_mult)

            # ── Get effective lead time & defect rate ──
            lead_time = self.chaos.get_effective_lead_time(day)
            defect_rate = self.chaos.get_defect_rate(day)

            # ── Forecast (every N days) ──
            forecast_demand = self._get_forecast(day, demands[:day+1].tolist())

            # ── Track forecast error ──
            if forecast_demand is not None and day > 0:
                self._forecast_errors.append(abs(forecast_demand - actual_demand))

            # ── Risk score ──
            risk_score = self._compute_risk_score(day, actual_demand, chaos_events)

            # ── Inventory step ──
            record = self.inventory.step(
                day=day,
                date_str=date_str,
                actual_demand=actual_demand,
                forecast_demand=forecast_demand,
                lead_time=lead_time,
                defect_rate=defect_rate,
                chaos_events=[{"type": e.event_type, "severity": e.severity,
                               "desc": e.description} for e in chaos_events],
                risk_score=risk_score,
            )

            # ── Progress callback ──
            if self.progress_callback and day % 10 == 0:
                self.progress_callback(day, n, record)

        # 3. Compile results
        elapsed = time.time() - t0
        state = self.inventory.state

        # Model accuracy
        model_acc = {}
        if self._forecast_errors:
            mae = float(np.mean(self._forecast_errors))
            model_acc = {
                "mae": round(mae, 2),
                "forecasts_made": len(self._forecast_errors),
                "method": "decision_intelligence_forecaster" if self.use_forecaster else "naive_mean",
            }

        result = SimulationResult(
            scenario_name=self.scenario.name,
            seed=self.seed,
            duration_days=n,
            inventory_summary=state.summary(),
            chaos_summary=self.chaos.get_summary(),
            demand_stats={
                "mean": round(float(np.mean(demands)), 2),
                "std": round(float(np.std(demands)), 2),
                "min": round(float(np.min(demands)), 2),
                "max": round(float(np.max(demands)), 2),
                "total": round(float(np.sum(demands)), 2),
                "shock_events": len(demand_df.attrs.get("shock_events", [])),
            },
            cost_breakdown=state.summary()["costs"],
            stockout_days=[r.day for r in state.daily_log if r.stockout_qty > 0],
            model_accuracy=model_acc,
            elapsed_seconds=elapsed,
            fill_rate=state.fill_rate,
            total_cost=state.total_cost,
            avg_inventory=state.avg_inventory,
            inventory_turns=(state.total_demand / max(state.avg_inventory, 1)) if state.avg_inventory > 0 else 0,
        )

        # Risk timeline (sampled every 7 days)
        result.risk_timeline = [
            {
                "day": r.day,
                "date": r.date,
                "inventory": round(r.inventory_after, 1),
                "demand": round(r.demand, 1),
                "stockout": round(r.stockout_qty, 1),
                "risk_score": r.risk_score,
                "events": len(r.chaos_events),
            }
            for r in state.daily_log if r.day % 7 == 0
        ]

        return result

    def run_comparison(self, configs: Dict[str, InventoryConfig]) -> Dict:
        """用不同庫存策略跑同一情境，比較結果"""
        results = {}
        for name, config in configs.items():
            self.inventory = InventorySimulator(config)
            self.chaos = ChaosEngine(
                seed=self.seed + 1,
                intensity=self.scenario.chaos_intensity,
                supplier=self.scenario.supplier_profile,
            )
            result = self.run()
            results[name] = result.to_dict()
        return results

    def get_daily_log_df(self) -> pd.DataFrame:
        """將每日日誌轉為 DataFrame，方便分析"""
        records = []
        for r in self.inventory.state.daily_log:
            records.append({
                "day": r.day,
                "date": r.date,
                "demand": r.demand,
                "fulfilled": r.fulfilled,
                "stockout_qty": r.stockout_qty,
                "inventory": r.inventory_after,
                "forecast": r.forecast_used,
                "risk_score": r.risk_score,
                "holding_cost": r.costs.get("holding", 0),
                "stockout_cost": r.costs.get("stockout", 0),
                "n_events": len(r.chaos_events),
            })
        return pd.DataFrame(records)

    # ─── Internal ───

    def _get_forecast(self, day: int, history: List[float]) -> Optional[float]:
        """取得預測需求（帶快取）"""
        if day < 30:
            # Warmup: use naive mean
            return float(np.mean(history[-7:])) if len(history) >= 7 else None

        # Re-forecast every N days
        if day - self._forecast_day >= self.forecast_interval:
            self._forecast_day = day
            self._forecast_cache = self._run_forecast(history)

        if self._forecast_cache:
            offset = day - self._forecast_day
            if 0 <= offset < len(self._forecast_cache):
                return self._forecast_cache[offset]

        # Fallback: naive mean
        return float(np.mean(history[-14:])) if len(history) >= 14 else float(np.mean(history))

    def _run_forecast(self, history: List[float]) -> Optional[List[float]]:
        """呼叫 Decision-Intelligence 預測引擎"""
        if not self.use_forecaster:
            # Naive: last-14-day mean
            recent = history[-14:] if len(history) >= 14 else history
            return [float(np.mean(recent))] * self.forecast_horizon

        try:
            if self._forecaster is None:
                from ml.demand_forecasting.forecaster_factory import ForecasterFactory
                self._forecaster = ForecasterFactory()

            result = self._forecaster.predict_with_fallback(
                sku="SIM",
                inline_history=history,
                horizon_days=self.forecast_horizon,
            )

            if result.get("success"):
                return result["prediction"]["predictions"]
        except Exception as e:
            logger.warning(f"Forecast failed at history len {len(history)}: {e}")

        # Fallback
        recent = history[-14:] if len(history) >= 14 else history
        return [float(np.mean(recent))] * self.forecast_horizon

    def _compute_risk_score(self, day: int, demand: float,
                            events: list) -> float:
        """計算當日風險分數 (0-100)"""
        score = 0.0
        inv = self.inventory.state.inventory
        avg_demand = self.inventory._avg_daily_demand()

        # 1. Inventory coverage risk
        days_of_stock = inv / max(avg_demand, 1)
        if days_of_stock < 3:
            score += 40
        elif days_of_stock < 7:
            score += 25
        elif days_of_stock < 14:
            score += 10

        # 2. Chaos event risk
        for e in events:
            severity_scores = {"low": 5, "medium": 15, "high": 25, "critical": 40}
            score += severity_scores.get(e.severity, 5)

        # 3. Demand volatility risk
        if len(self.inventory._demand_history) >= 14:
            recent = self.inventory._demand_history[-14:]
            cv = float(np.std(recent)) / max(float(np.mean(recent)), 1)
            if cv > 0.5:
                score += 15
            elif cv > 0.3:
                score += 8

        return min(100.0, round(score, 1))
