"""
Week 2B: ParameterOptimizer — 參數優化器
==========================================
Grid search / random search over inventory parameters to minimize Total Cost.
目標函數: Total Cost = 持有成本 + 缺貨罰款 + 物流成本
約束: fill_rate >= 95%

Usage:
    opt = ParameterOptimizer(scenario="volatile", seed=42)
    best = opt.optimize(n_trials=50)
"""
import numpy as np
import time
import logging
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from .scenarios import get_scenario, ScenarioConfig
from .inventory_sim import InventoryConfig
from .orchestrator import SimulationOrchestrator

logger = logging.getLogger(__name__)


@dataclass
class OptimizationResult:
    """優化結果"""
    best_params: Dict
    best_cost: float
    best_fill_rate: float
    all_trials: List[Dict]
    n_trials: int
    elapsed_seconds: float
    scenario: str
    constraint_met: bool

    def to_dict(self) -> Dict:
        top_5 = sorted(self.all_trials, key=lambda x: x["cost"])[:5]
        return {
            "best_params": self.best_params,
            "best_cost": round(self.best_cost, 2),
            "best_fill_rate": round(self.best_fill_rate * 100, 2),
            "constraint_met": self.constraint_met,
            "n_trials": self.n_trials,
            "elapsed_seconds": round(self.elapsed_seconds, 2),
            "scenario": self.scenario,
            "top_5_trials": top_5,
        }


class ParameterOptimizer:
    """
    參數優化器 — The Learner
    ==========================
    跑多次模擬，自動找出最佳庫存策略參數。
    """

    # 搜索空間
    PARAM_SPACE = {
        "safety_stock_factor": (0.5, 4.0),
        "reorder_point_ratio": (0.5, 3.0),      # 相對於 avg_demand * lead_time
        "order_quantity_days": (7, 42),
    }

    def __init__(
        self,
        scenario: str = "normal",
        seed: int = 42,
        min_fill_rate: float = 0.95,
        custom_config: Optional[ScenarioConfig] = None,
        use_forecaster: bool = False,  # Default False for speed
    ):
        self.scenario_name = scenario
        self.scenario = custom_config or get_scenario(scenario)
        self.seed = seed
        self.min_fill_rate = min_fill_rate
        self.use_forecaster = use_forecaster
        self._rng = np.random.RandomState(seed)

    def optimize(self, n_trials: int = 50, method: str = "random") -> OptimizationResult:
        """
        執行優化搜索。

        Args:
            n_trials: 搜索次數
            method: "random" | "grid"
        """
        t0 = time.time()

        if method == "grid":
            param_sets = self._grid_search_params(n_trials)
        else:
            param_sets = self._random_search_params(n_trials)

        trials = []
        best_cost = float("inf")
        best_params = None
        best_fill_rate = 0.0

        for i, params in enumerate(param_sets):
            # Build config from params
            config = self._params_to_config(params)

            # Run simulation
            try:
                orch = SimulationOrchestrator(
                    custom_config=self._make_scenario_with_config(config),
                    seed=self.seed,
                    use_forecaster=self.use_forecaster,
                )
                result = orch.run()

                cost = result.total_cost
                fill_rate = result.fill_rate
                meets_constraint = fill_rate >= self.min_fill_rate

                trial = {
                    "trial": i,
                    "params": {k: round(v, 3) for k, v in params.items()},
                    "cost": round(cost, 2),
                    "fill_rate": round(fill_rate * 100, 2),
                    "avg_inventory": round(result.avg_inventory, 1),
                    "stockout_days": len(result.stockout_days),
                    "meets_constraint": meets_constraint,
                }
                trials.append(trial)

                # Update best (only if constraint met)
                if meets_constraint and cost < best_cost:
                    best_cost = cost
                    best_params = params.copy()
                    best_fill_rate = fill_rate

                if (i + 1) % 10 == 0:
                    logger.info(f"Trial {i+1}/{n_trials} — best cost: {best_cost:.0f}")

            except Exception as e:
                logger.warning(f"Trial {i} failed: {e}")
                trials.append({"trial": i, "params": params, "error": str(e)})

        elapsed = time.time() - t0

        # If no constrained solution, pick lowest cost anyway
        if best_params is None and trials:
            valid = [t for t in trials if "cost" in t]
            if valid:
                best_trial = min(valid, key=lambda x: x["cost"])
                best_params = best_trial["params"]
                best_cost = best_trial["cost"]
                best_fill_rate = best_trial.get("fill_rate", 0) / 100

        return OptimizationResult(
            best_params=best_params or {},
            best_cost=best_cost,
            best_fill_rate=best_fill_rate,
            all_trials=trials,
            n_trials=n_trials,
            elapsed_seconds=elapsed,
            scenario=self.scenario_name,
            constraint_met=best_fill_rate >= self.min_fill_rate,
        )

    def _random_search_params(self, n: int) -> List[Dict]:
        params_list = []
        for _ in range(n):
            params = {}
            for key, (lo, hi) in self.PARAM_SPACE.items():
                if isinstance(lo, int) and isinstance(hi, int):
                    params[key] = self._rng.randint(lo, hi + 1)
                else:
                    params[key] = self._rng.uniform(lo, hi)
            params_list.append(params)
        return params_list

    def _grid_search_params(self, n: int) -> List[Dict]:
        # Approximate grid: cube root of n per dimension
        per_dim = max(2, int(round(n ** (1.0 / len(self.PARAM_SPACE)))))
        grids = {}
        for key, (lo, hi) in self.PARAM_SPACE.items():
            grids[key] = np.linspace(lo, hi, per_dim).tolist()

        # Cartesian product
        import itertools
        keys = list(grids.keys())
        combos = list(itertools.product(*[grids[k] for k in keys]))
        return [dict(zip(keys, combo)) for combo in combos[:n]]

    def _params_to_config(self, params: Dict) -> InventoryConfig:
        base = self.scenario.inventory_config
        return InventoryConfig(
            initial_inventory=base.initial_inventory,
            reorder_point=base.reorder_point * params.get("reorder_point_ratio", 1.0),
            safety_stock_factor=params.get("safety_stock_factor", base.safety_stock_factor),
            order_quantity_days=params.get("order_quantity_days", base.order_quantity_days),
            max_order_quantity=base.max_order_quantity,
            min_order_quantity=base.min_order_quantity,
            holding_cost_per_unit_day=base.holding_cost_per_unit_day,
            stockout_penalty_per_unit=base.stockout_penalty_per_unit,
            ordering_cost_per_order=base.ordering_cost_per_order,
            unit_cost=base.unit_cost,
        )

    def _make_scenario_with_config(self, config: InventoryConfig) -> ScenarioConfig:
        return ScenarioConfig(
            name=self.scenario.name,
            description=self.scenario.description,
            demand_profile=self.scenario.demand_profile,
            supplier_profile=self.scenario.supplier_profile,
            inventory_config=config,
            chaos_intensity=self.scenario.chaos_intensity,
            duration_days=self.scenario.duration_days,
            start_date=self.scenario.start_date,
        )
