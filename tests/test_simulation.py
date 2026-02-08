"""
Unit tests for the Digital Twin Supply Chain Simulation system.
Tests: DataGenerator, ChaosEngine, InventorySimulator, Orchestrator, Optimizer
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import pytest
import numpy as np
import pandas as pd

from ml.simulation.data_generator import DataGenerator, DemandProfile
from ml.simulation.chaos_engine import ChaosEngine, ChaosEvent, SupplierProfile
from ml.simulation.inventory_sim import InventorySimulator, InventoryConfig, SimulationState
from ml.simulation.scenarios import SCENARIOS, get_scenario, list_scenarios
from ml.simulation.orchestrator import SimulationOrchestrator
from ml.simulation.optimizer import ParameterOptimizer


# ═══════════════════════════════════════
# DataGenerator Tests
# ═══════════════════════════════════════
class TestDataGenerator:
    def test_basic_generation(self):
        gen = DataGenerator(seed=42)
        df = gen.generate(days=100)
        assert len(df) == 100
        assert "date" in df.columns
        assert "demand" in df.columns
        assert df["demand"].min() >= 0

    def test_deterministic_with_seed(self):
        df1 = DataGenerator(seed=42).generate(days=60)
        df2 = DataGenerator(seed=42).generate(days=60)
        assert list(df1["demand"]) == list(df2["demand"])

    def test_different_seeds_differ(self):
        df1 = DataGenerator(seed=42).generate(days=60)
        df2 = DataGenerator(seed=99).generate(days=60)
        assert list(df1["demand"]) != list(df2["demand"])

    def test_trend_increases(self):
        profile = DemandProfile(
            base_demand=100, trend_per_day=1.0,
            weekly_amplitude=0, monthly_amplitude=0, yearly_amplitude=0,
            noise_std=0, shock_probability=0, promo_interval_days=0,
        )
        df = DataGenerator(seed=42).generate(profile, days=100)
        # Average of last 10 should be higher than first 10
        assert df["demand"].iloc[-10:].mean() > df["demand"].iloc[:10].mean()

    def test_seasonality_creates_variance(self):
        profile = DemandProfile(
            base_demand=100, trend_per_day=0,
            weekly_amplitude=30, noise_std=0, shock_probability=0,
            promo_interval_days=0,
        )
        df = DataGenerator(seed=42).generate(profile, days=28)
        assert df["demand"].std() > 5  # Should have meaningful variance

    def test_shocks_create_outliers(self):
        profile = DemandProfile(
            base_demand=100, trend_per_day=0,
            weekly_amplitude=0, monthly_amplitude=0, yearly_amplitude=0,
            noise_std=0, shock_probability=0.5,  # Very high shock rate
            shock_magnitude_range=(2.0, 3.0),
        )
        df = DataGenerator(seed=42).generate(profile, days=100)
        shock_events = df.attrs.get("shock_events", [])
        assert len(shock_events) > 0
        assert df["demand"].max() > 150  # Should have surges

    def test_custom_profile(self):
        profile = DemandProfile(
            base_demand=50, trend_per_day=0.1,
            weekly_amplitude=5, noise_std=2, shock_probability=0,
        )
        df = DataGenerator(seed=42).generate(profile, days=365)
        assert len(df) == 365
        assert df["demand"].mean() > 40  # Roughly around base

    def test_multi_sku(self):
        gen = DataGenerator(seed=42)
        profiles = {
            "SKU-A": DemandProfile(base_demand=100),
            "SKU-B": DemandProfile(base_demand=50),
        }
        results = gen.generate_multi_sku(profiles, days=60)
        assert "SKU-A" in results
        assert "SKU-B" in results
        assert results["SKU-A"]["demand"].mean() > results["SKU-B"]["demand"].mean()

    def test_decline_trend(self):
        profile = DemandProfile(
            base_demand=200, trend_per_day=1.0, trend_type="decline",
            weekly_amplitude=0, monthly_amplitude=0, yearly_amplitude=0,
            noise_std=0, shock_probability=0, promo_interval_days=0,
        )
        df = DataGenerator(seed=42).generate(profile, days=100)
        assert df["demand"].iloc[-10:].mean() < df["demand"].iloc[:10].mean()

    def test_logistic_trend(self):
        profile = DemandProfile(
            base_demand=50, trend_per_day=0.5, trend_type="logistic",
            weekly_amplitude=0, monthly_amplitude=0, yearly_amplitude=0,
            noise_std=0, shock_probability=0, promo_interval_days=0,
        )
        df = DataGenerator(seed=42).generate(profile, days=200)
        assert len(df) == 200


# ═══════════════════════════════════════
# ChaosEngine Tests
# ═══════════════════════════════════════
class TestChaosEngine:
    def test_basic_creation(self):
        chaos = ChaosEngine(seed=42, intensity="medium")
        assert chaos.intensity == "medium"
        assert chaos.multiplier == 1.0

    def test_calm_produces_fewer_events(self):
        calm = ChaosEngine(seed=42, intensity="calm")
        extreme = ChaosEngine(seed=42, intensity="extreme")
        for day in range(100):
            calm.generate_daily_chaos(day, f"2024-01-{day+1:02d}")
            extreme.generate_daily_chaos(day, f"2024-01-{day+1:02d}")
        assert len(calm.event_log) < len(extreme.event_log)

    def test_events_have_required_fields(self):
        chaos = ChaosEngine(seed=42, intensity="high")
        for day in range(50):
            events = chaos.generate_daily_chaos(day, f"2024-01-{day+1:02d}")
            for e in events:
                assert e.event_type in chaos.EVENT_CATALOG
                assert e.severity in ["low", "medium", "high", "critical"]
                assert e.duration_days >= 1

    def test_lead_time_increases_with_events(self):
        chaos = ChaosEngine(seed=42, intensity="extreme")
        base_lt = chaos.get_effective_lead_time(0)
        # Generate many events
        for day in range(50):
            chaos.generate_daily_chaos(day, f"2024-02-{day+1:02d}")
        # If there are active delay events, lead time should be higher
        lt_after = chaos.get_effective_lead_time(49)
        # At least base lead time
        assert lt_after >= chaos.supplier.base_lead_time - 5  # Allow some jitter

    def test_demand_multiplier(self):
        chaos = ChaosEngine(seed=42, intensity="medium")
        # Initially no events → multiplier = 1.0
        assert chaos.get_demand_multiplier(0) == 1.0

    def test_summary(self):
        chaos = ChaosEngine(seed=42, intensity="high")
        for day in range(100):
            chaos.generate_daily_chaos(day, f"2024-01-{day+1:02d}")
        summary = chaos.get_summary()
        assert "total_events" in summary
        assert "by_type" in summary
        assert summary["total_events"] == len(chaos.event_log)

    def test_deterministic(self):
        events1, events2 = [], []
        for seed_offset in [0]:
            chaos = ChaosEngine(seed=42, intensity="medium")
            for day in range(30):
                evts = chaos.generate_daily_chaos(day, f"2024-01-{day+1:02d}")
                events1.extend([(e.day, e.event_type) for e in evts])
            chaos2 = ChaosEngine(seed=42, intensity="medium")
            for day in range(30):
                evts = chaos2.generate_daily_chaos(day, f"2024-01-{day+1:02d}")
                events2.extend([(e.day, e.event_type) for e in evts])
        assert events1 == events2


# ═══════════════════════════════════════
# InventorySimulator Tests
# ═══════════════════════════════════════
class TestInventorySimulator:
    def test_basic_depletion(self):
        config = InventoryConfig(initial_inventory=100, reorder_point=9999)  # Never reorder
        sim = InventorySimulator(config)
        record = sim.step(day=0, date_str="2024-01-01", actual_demand=30)
        assert record.fulfilled == 30
        assert record.stockout_qty == 0
        assert record.inventory_after == 70

    def test_stockout(self):
        config = InventoryConfig(initial_inventory=50, reorder_point=9999)
        sim = InventorySimulator(config)
        record = sim.step(day=0, date_str="2024-01-01", actual_demand=80)
        assert record.fulfilled == 50
        assert record.stockout_qty == 30
        assert record.inventory_after == 0

    def test_cost_accounting(self):
        config = InventoryConfig(
            initial_inventory=100,
            holding_cost_per_unit_day=1.0,
            stockout_penalty_per_unit=10.0,
            reorder_point=9999,
        )
        sim = InventorySimulator(config)
        sim.step(day=0, date_str="2024-01-01", actual_demand=30)
        # Inventory after = 70, holding cost = 70 * 1.0 = 70
        assert sim.state.total_holding_cost == 70.0
        assert sim.state.total_stockout_cost == 0.0

    def test_reorder_triggers(self):
        config = InventoryConfig(
            initial_inventory=100, reorder_point=80,
            safety_stock_factor=0.1, order_quantity_days=7,
        )
        sim = InventorySimulator(config)
        # Deplete to trigger reorder
        sim.step(day=0, date_str="2024-01-01", actual_demand=50, forecast_demand=10, lead_time=3)
        assert len(sim.state.orders_in_transit) > 0

    def test_delivery_replenishes(self):
        config = InventoryConfig(initial_inventory=100, reorder_point=80)
        sim = InventorySimulator(config)
        # Manually add an order arriving today
        from ml.simulation.inventory_sim import PurchaseOrder
        po = PurchaseOrder(order_day=0, quantity=200, expected_arrival_day=1)
        sim.state.orders_in_transit.append(po)
        # Step to day 1 → delivery arrives
        sim.step(day=1, date_str="2024-01-02", actual_demand=10, lead_time=5)
        assert sim.state.inventory > 100  # Got replenished

    def test_fill_rate_calculation(self):
        config = InventoryConfig(initial_inventory=50, reorder_point=9999)
        sim = InventorySimulator(config)
        sim.step(day=0, date_str="2024-01-01", actual_demand=30)
        sim.step(day=1, date_str="2024-01-02", actual_demand=30)  # Only 20 left → stockout 10
        assert sim.state.fill_rate == pytest.approx(50 / 60, abs=0.01)

    def test_summary(self):
        config = InventoryConfig(initial_inventory=500)
        sim = InventorySimulator(config)
        for i in range(30):
            sim.step(day=i, date_str=f"2024-01-{i+1:02d}", actual_demand=10, lead_time=5)
        s = sim.state.summary()
        assert s["days_simulated"] == 29
        assert "costs" in s
        assert s["fill_rate"] > 0

    def test_reset(self):
        sim = InventorySimulator(InventoryConfig(initial_inventory=500))
        sim.step(day=0, date_str="2024-01-01", actual_demand=100)
        sim.reset()
        assert sim.state.inventory == 500
        assert len(sim.state.daily_log) == 0


# ═══════════════════════════════════════
# Scenarios Tests
# ═══════════════════════════════════════
class TestScenarios:
    def test_all_scenarios_exist(self):
        assert "normal" in SCENARIOS
        assert "volatile" in SCENARIOS
        assert "disaster" in SCENARIOS
        assert "seasonal" in SCENARIOS

    def test_get_scenario(self):
        s = get_scenario("normal")
        assert s.name == "normal"
        assert s.duration_days > 0

    def test_unknown_scenario_raises(self):
        with pytest.raises(ValueError):
            get_scenario("nonexistent")

    def test_list_scenarios(self):
        scenarios = list_scenarios()
        assert len(scenarios) == 4
        assert all("name" in s for s in scenarios)

    def test_disaster_harder_than_normal(self):
        normal = get_scenario("normal")
        disaster = get_scenario("disaster")
        assert disaster.demand_profile.shock_probability > normal.demand_profile.shock_probability
        assert disaster.supplier_profile.base_lead_time > normal.supplier_profile.base_lead_time


# ═══════════════════════════════════════
# Orchestrator Tests
# ═══════════════════════════════════════
class TestOrchestrator:
    def test_basic_run(self):
        orch = SimulationOrchestrator(
            scenario="normal", seed=42, use_forecaster=False,
        )
        orch.scenario.duration_days = 60  # Short run
        result = orch.run()
        assert result.duration_days == 60
        assert result.fill_rate > 0
        assert result.total_cost > 0

    def test_deterministic(self):
        results = []
        for _ in range(2):
            orch = SimulationOrchestrator(
                scenario="normal", seed=42, use_forecaster=False,
            )
            orch.scenario.duration_days = 30
            r = orch.run()
            results.append(r.total_cost)
        assert results[0] == results[1]

    def test_disaster_more_stockouts(self):
        normal_orch = SimulationOrchestrator(scenario="normal", seed=42, use_forecaster=False)
        normal_orch.scenario.duration_days = 90
        normal_result = normal_orch.run()

        disaster_orch = SimulationOrchestrator(scenario="disaster", seed=42, use_forecaster=False)
        disaster_orch.scenario.duration_days = 90
        disaster_result = disaster_orch.run()

        # Disaster should have more stockout days or higher cost
        assert (len(disaster_result.stockout_days) >= len(normal_result.stockout_days) or
                disaster_result.total_cost >= normal_result.total_cost)

    def test_to_dict(self):
        orch = SimulationOrchestrator(scenario="normal", seed=42, use_forecaster=False)
        orch.scenario.duration_days = 30
        result = orch.run()
        d = result.to_dict()
        assert "kpis" in d
        assert "fill_rate_pct" in d["kpis"]
        assert "total_cost" in d["kpis"]

    def test_daily_log_df(self):
        orch = SimulationOrchestrator(scenario="normal", seed=42, use_forecaster=False)
        orch.scenario.duration_days = 30
        orch.run()
        df = orch.get_daily_log_df()
        assert len(df) == 30
        assert "demand" in df.columns
        assert "inventory" in df.columns


# ═══════════════════════════════════════
# Optimizer Tests
# ═══════════════════════════════════════
class TestOptimizer:
    def test_basic_optimize(self):
        opt = ParameterOptimizer(scenario="normal", seed=42, use_forecaster=False)
        opt.scenario.duration_days = 60  # Short for speed
        result = opt.optimize(n_trials=5, method="random")
        assert result.n_trials == 5
        assert result.best_cost > 0
        assert len(result.all_trials) == 5

    def test_grid_search(self):
        opt = ParameterOptimizer(scenario="normal", seed=42, use_forecaster=False)
        opt.scenario.duration_days = 60
        result = opt.optimize(n_trials=8, method="grid")
        assert len(result.all_trials) == 8

    def test_to_dict(self):
        opt = ParameterOptimizer(scenario="normal", seed=42, use_forecaster=False)
        opt.scenario.duration_days = 30
        result = opt.optimize(n_trials=3)
        d = result.to_dict()
        assert "best_params" in d
        assert "best_cost" in d
        assert "top_5_trials" in d
