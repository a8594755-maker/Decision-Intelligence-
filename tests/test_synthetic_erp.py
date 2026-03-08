"""
Tests for Synthetic ERP Sandbox v1
===================================
Covers: MasterDataBuilder, SyntheticDemandGenerator, SyntheticInventorySimulator,
        ScenarioEngine, DatasetRegistry, KPIEngine, SyntheticERPConnector.
"""
import sys
import os
import pytest
import numpy as np

# Ensure src is on path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from ml.synthetic_erp.master_data_builder import MasterDataBuilder, MaterialMaster, BOMEdge
from ml.synthetic_erp.demand_generator import SyntheticDemandGenerator
from ml.synthetic_erp.inventory_simulator import SyntheticInventorySimulator
from ml.synthetic_erp.scenario_engine import ScenarioEngine, DisruptionSpec, DEMAND_SIDE, SUPPLY_SIDE
from ml.synthetic_erp.dataset_registry import DatasetRegistry
from ml.synthetic_erp.kpi_engine import KPIEngine
from ml.synthetic_erp.synthetic_erp_connector import SyntheticERPConnector


# ══════════════════════════════════════════════
#  Test MasterDataBuilder
# ══════════════════════════════════════════════

class TestMasterDataBuilder:

    def test_default_build(self):
        builder = MasterDataBuilder(seed=42)
        md = builder.build()
        assert len(md["materials"]) == 20  # 10 FG + 5 SEMI + 5 RAW
        assert len(md["suppliers"]) == 5
        assert len(md["plants"]) == 3
        assert len(md["bom_edges"]) > 0

    def test_deterministic_with_seed(self):
        md1 = MasterDataBuilder(seed=42).build()
        md2 = MasterDataBuilder(seed=42).build()
        codes1 = [m.material_code for m in md1["materials"]]
        codes2 = [m.material_code for m in md2["materials"]]
        assert codes1 == codes2
        # Same categories
        cats1 = [m.category for m in md1["materials"]]
        cats2 = [m.category for m in md2["materials"]]
        assert cats1 == cats2

    def test_different_seeds_differ(self):
        md1 = MasterDataBuilder(seed=42).build()
        md2 = MasterDataBuilder(seed=99).build()
        cats1 = [m.category for m in md1["materials"]]
        cats2 = [m.category for m in md2["materials"]]
        assert cats1 != cats2

    def test_material_types(self):
        md = MasterDataBuilder(seed=42).build()
        types = [m.material_type for m in md["materials"]]
        assert types.count("FG") == 10
        assert types.count("SEMI") == 5
        assert types.count("RAW") == 5

    def test_bom_acyclicity(self):
        """BOM should only have FG→SEMI and SEMI→RAW edges."""
        md = MasterDataBuilder(seed=42).build()
        mat_type = {m.material_code: m.material_type for m in md["materials"]}
        for edge in md["bom_edges"]:
            parent_type = mat_type[edge.parent_material]
            child_type = mat_type[edge.child_material]
            assert (parent_type, child_type) in [("FG", "SEMI"), ("SEMI", "RAW")], \
                f"Invalid BOM edge: {parent_type} → {child_type}"

    def test_fg_have_demand(self):
        md = MasterDataBuilder(seed=42).build()
        for m in md["materials"]:
            if m.material_type == "FG":
                assert m.base_demand > 0
            else:
                assert m.base_demand == 0

    def test_custom_config(self):
        md = MasterDataBuilder(seed=42, config={"n_fg": 5, "n_semi": 2, "n_raw": 3, "n_plants": 2}).build()
        assert len(md["materials"]) == 10
        assert len(md["plants"]) == 2

    def test_to_dataframes(self):
        builder = MasterDataBuilder(seed=42)
        dfs = builder.to_dataframes()
        assert "materials" in dfs
        assert "bom_edges" in dfs
        assert len(dfs["materials"]) == 20


# ══════════════════════════════════════════════
#  Test SyntheticDemandGenerator
# ══════════════════════════════════════════════

class TestSyntheticDemandGenerator:

    @pytest.fixture
    def master_data(self):
        return MasterDataBuilder(seed=42, config={"n_fg": 3, "n_semi": 1, "n_raw": 1, "n_plants": 2}).build()

    def test_basic_generation(self, master_data):
        gen = SyntheticDemandGenerator(seed=42)
        demand = gen.generate(master_data["materials"], master_data["plants"], days=90)
        assert len(demand) > 0
        for key, df in demand.items():
            assert len(df) == 90
            assert "demand" in df.columns
            assert "date" in df.columns

    def test_deterministic(self, master_data):
        gen1 = SyntheticDemandGenerator(seed=42)
        gen2 = SyntheticDemandGenerator(seed=42)
        d1 = gen1.generate(master_data["materials"], master_data["plants"], days=90)
        d2 = gen2.generate(master_data["materials"], master_data["plants"], days=90)
        for key in d1:
            assert list(d1[key]["demand"]) == list(d2[key]["demand"])

    def test_only_fg_get_demand(self, master_data):
        gen = SyntheticDemandGenerator(seed=42)
        demand = gen.generate(master_data["materials"], master_data["plants"], days=30)
        fg_codes = {m.material_code for m in master_data["materials"] if m.material_type == "FG"}
        for (mat_code, _) in demand.keys():
            assert mat_code in fg_codes

    def test_erp_sales_record_shape(self, master_data):
        gen = SyntheticDemandGenerator(seed=42)
        demand = gen.generate(master_data["materials"], master_data["plants"], days=30)
        erp = gen.to_erp_sales_records(demand)
        assert len(erp) > 0
        for sku, records in erp.items():
            assert len(records) == 30
            r = records[0]
            assert "date" in r
            assert "sales" in r
            assert "sku" in r
            assert "features" in r
            assert "price_index" in r["features"]
            assert "promotion" in r["features"]
            assert "inventory" in r["features"]

    def test_plant_scaling(self, master_data):
        """Different plants should produce different demand levels due to capacity_factor."""
        gen = SyntheticDemandGenerator(seed=42)
        demand = gen.generate(master_data["materials"], master_data["plants"], days=365)
        if len(demand) >= 2:
            keys = list(demand.keys())
            # Demands should differ (different seeds and capacity factors)
            d1 = demand[keys[0]]["demand"].mean()
            d2 = demand[keys[1]]["demand"].mean()
            assert d1 != d2


# ══════════════════════════════════════════════
#  Test SyntheticInventorySimulator
# ══════════════════════════════════════════════

class TestSyntheticInventorySimulator:

    @pytest.fixture
    def sim_data(self):
        md = MasterDataBuilder(seed=42, config={"n_fg": 3, "n_semi": 1, "n_raw": 1, "n_plants": 2}).build()
        gen = SyntheticDemandGenerator(seed=42)
        demand = gen.generate(md["materials"], md["plants"], days=60)
        return md, demand

    def test_basic_run(self, sim_data):
        md, demand = sim_data
        sim = SyntheticInventorySimulator(master_data=md, demand_data=demand, seed=42)
        result = sim.run(days=60)
        assert len(result["stock_snapshots"]) > 0
        assert "summary" in result

    def test_stock_snapshot_shape(self, sim_data):
        md, demand = sim_data
        sim = SyntheticInventorySimulator(master_data=md, demand_data=demand, seed=42)
        result = sim.run(days=30)
        if result["stock_snapshots"]:
            snap = result["stock_snapshots"][0]
            assert "material_code" in snap
            assert "plant_id" in snap
            assert "qty" in snap
            assert "uom" in snap
            assert "snapshot_at" in snap
            assert "source" in snap
            assert snap["source"] == "synthetic_erp"

    def test_deterministic(self, sim_data):
        md, demand = sim_data
        r1 = SyntheticInventorySimulator(master_data=md, demand_data=demand, seed=42).run(days=30)
        r2 = SyntheticInventorySimulator(master_data=md, demand_data=demand, seed=42).run(days=30)
        assert r1["summary"]["total_demand"] == r2["summary"]["total_demand"]
        assert r1["summary"]["fill_rate"] == r2["summary"]["fill_rate"]

    def test_fill_rate_valid(self, sim_data):
        md, demand = sim_data
        sim = SyntheticInventorySimulator(master_data=md, demand_data=demand, seed=42)
        result = sim.run(days=60)
        fr = result["summary"]["fill_rate"]
        assert 0.0 <= fr <= 1.0


# ══════════════════════════════════════════════
#  Test ScenarioEngine
# ══════════════════════════════════════════════

class TestScenarioEngine:

    @pytest.fixture
    def demand_data(self):
        md = MasterDataBuilder(seed=42, config={"n_fg": 2, "n_semi": 1, "n_raw": 1, "n_plants": 1}).build()
        gen = SyntheticDemandGenerator(seed=42)
        return gen.generate(md["materials"], md["plants"], days=120), md

    def test_demand_spike_is_demand_side(self):
        assert "demand_spike" in DEMAND_SIDE
        assert "demand_spike" not in SUPPLY_SIDE

    def test_supplier_delay_is_supply_side(self):
        assert "supplier_delay" in SUPPLY_SIDE
        assert "supplier_delay" not in DEMAND_SIDE

    def test_demand_spike_modifies_demand(self, demand_data):
        demand, md = demand_data
        engine = ScenarioEngine(seed=42)
        spec = DisruptionSpec("demand_spike", severity="high", start_day=30, duration_days=10)
        modified = engine.apply_demand([spec], demand)

        key = list(demand.keys())[0]
        original_avg = demand[key].iloc[30:40]["demand"].mean()
        modified_avg = modified[key].iloc[30:40]["demand"].mean()
        assert modified_avg > original_avg

    def test_supplier_delay_not_demand_mutation(self, demand_data):
        """Supply-side disruptions should NOT modify demand data."""
        demand, md = demand_data
        engine = ScenarioEngine(seed=42)
        spec = DisruptionSpec("supplier_delay", severity="critical", start_day=30, duration_days=10)
        modified = engine.apply_demand([spec], demand)

        key = list(demand.keys())[0]
        # Demand should be unchanged
        assert list(modified[key]["demand"]) == list(demand[key]["demand"])

    def test_supplier_delay_produces_chaos_events(self, demand_data):
        demand, md = demand_data
        engine = ScenarioEngine(seed=42)
        spec = DisruptionSpec("supplier_delay", severity="high", start_day=30, duration_days=10)
        events = engine.to_supply_events([spec])
        assert len(events) == 10  # one per day
        assert all(e.event_type == "supplier_delay" for e in events)
        assert all(e.impact.get("lead_time_add", 0) > 0 for e in events)

    def test_templates(self):
        templates = ScenarioEngine.list_templates()
        assert "baseline" in templates
        assert "single_spike" in templates
        assert "supplier_crisis" in templates

    def test_get_template(self):
        specs = ScenarioEngine.get_template("single_spike")
        assert len(specs) == 1
        assert specs[0].name == "demand_spike"

    def test_unknown_template_raises(self):
        with pytest.raises(ValueError):
            ScenarioEngine.get_template("nonexistent")


# ══════════════════════════════════════════════
#  Test DatasetRegistry
# ══════════════════════════════════════════════

class TestDatasetRegistry:

    def setup_method(self):
        DatasetRegistry.reset_instance()

    def test_register_and_get(self):
        registry = DatasetRegistry.get_instance()
        md = MasterDataBuilder(seed=1, config={"n_fg": 2, "n_semi": 1, "n_raw": 1}).build()
        gen = SyntheticDemandGenerator(seed=1)
        demand = gen.generate(md["materials"], md["plants"], days=30)

        desc = registry.register(seed=1, config={"test": True}, master_data=md, demand_data=demand)
        assert desc.dataset_id is not None
        assert desc.seed == 1

        data = registry.get(desc.dataset_id)
        assert data is not None
        assert data["master_data"] == md

    def test_fingerprint_reproducibility(self):
        registry = DatasetRegistry.get_instance()
        md = MasterDataBuilder(seed=1, config={"n_fg": 2, "n_semi": 1, "n_raw": 1}).build()
        gen = SyntheticDemandGenerator(seed=1)
        demand = gen.generate(md["materials"], md["plants"], days=30)

        desc1 = registry.register(seed=1, config={"test": True}, master_data=md, demand_data=demand)

        # Re-generate same data
        md2 = MasterDataBuilder(seed=1, config={"n_fg": 2, "n_semi": 1, "n_raw": 1}).build()
        demand2 = SyntheticDemandGenerator(seed=1).generate(md2["materials"], md2["plants"], days=30)
        desc2 = registry.register(seed=1, config={"test": True}, master_data=md2, demand_data=demand2)

        assert desc1.fingerprint == desc2.fingerprint

    def test_list_and_delete(self):
        registry = DatasetRegistry.get_instance()
        md = MasterDataBuilder(seed=1, config={"n_fg": 2, "n_semi": 1, "n_raw": 1}).build()
        gen = SyntheticDemandGenerator(seed=1)
        demand = gen.generate(md["materials"], md["plants"], days=30)

        desc = registry.register(seed=1, config={}, master_data=md, demand_data=demand)
        assert len(registry.list_datasets()) == 1

        deleted = registry.delete(desc.dataset_id)
        assert deleted
        assert len(registry.list_datasets()) == 0

    def test_lru_eviction(self):
        registry = DatasetRegistry.get_instance()
        registry.MAX_DATASETS = 3

        for i in range(5):
            md = MasterDataBuilder(seed=i, config={"n_fg": 2, "n_semi": 1, "n_raw": 1}).build()
            demand = SyntheticDemandGenerator(seed=i).generate(md["materials"], md["plants"], days=10)
            registry.register(seed=i, config={"i": i}, master_data=md, demand_data=demand)

        assert len(registry.list_datasets()) <= 3


# ══════════════════════════════════════════════
#  Test KPIEngine
# ══════════════════════════════════════════════

class TestKPIEngine:

    @pytest.fixture
    def sim_result(self):
        md = MasterDataBuilder(seed=42, config={"n_fg": 2, "n_semi": 1, "n_raw": 1, "n_plants": 1}).build()
        gen = SyntheticDemandGenerator(seed=42)
        demand = gen.generate(md["materials"], md["plants"], days=60)
        sim = SyntheticInventorySimulator(master_data=md, demand_data=demand, seed=42)
        result = sim.run(days=60)
        return result, demand, md

    def test_aggregate_kpis(self, sim_result):
        result, demand, md = sim_result
        kpis = KPIEngine.compute(result, demand, md)
        agg = kpis["aggregate"]
        assert "fill_rate" in agg
        assert "stockout_days" in agg
        assert "avg_inventory" in agg
        assert "total_cost" in agg
        assert 0.0 <= agg["fill_rate"] <= 1.0
        assert agg["total_demand"] > 0

    def test_by_material_breakdown(self, sim_result):
        result, demand, md = sim_result
        kpis = KPIEngine.compute(result, demand, md)
        by_mat = kpis["by_material"]
        assert len(by_mat) > 0
        for mat_code, mat_kpis in by_mat.items():
            assert "fill_rate" in mat_kpis
            assert 0.0 <= mat_kpis["fill_rate"] <= 1.0

    def test_time_series(self, sim_result):
        result, demand, md = sim_result
        kpis = KPIEngine.compute(result, demand, md)
        ts = kpis["time_series"]
        assert len(ts) > 0
        assert "day" in ts[0]
        assert "fill_rate" in ts[0]
        assert "inventory" in ts[0]


# ══════════════════════════════════════════════
#  Test SyntheticERPConnector
# ══════════════════════════════════════════════

class TestSyntheticERPConnector:

    def setup_method(self):
        DatasetRegistry.reset_instance()

    def test_fetch_sales_data_shape(self):
        connector = SyntheticERPConnector(seed=42, config={"n_materials": 3, "n_plants": 1, "days": 90})
        skus = connector.get_available_skus()
        assert len(skus) > 0

        data = connector.fetch_sales_data(skus[0], days=90)
        assert data is not None
        assert len(data) == 90

        r = data[0]
        assert "date" in r
        assert "sales" in r
        assert "sku" in r
        assert "features" in r
        assert "price_index" in r["features"]
        assert "promotion" in r["features"]
        assert "inventory" in r["features"]

    def test_shape_matches_mock_connector(self):
        """Verify SyntheticERPConnector output shape matches MockERPConnector."""
        connector = SyntheticERPConnector(seed=42, config={"n_materials": 3, "n_plants": 1, "days": 30})
        skus = connector.get_available_skus()
        synth_data = connector.fetch_sales_data(skus[0], days=10)

        from ml.demand_forecasting.mock_erp_connector import MockERPConnector
        mock = MockERPConnector()
        mock_data = mock.fetch_sales_data("SKU001", days=10)

        assert set(synth_data[0].keys()) == set(mock_data[0].keys())
        assert set(synth_data[0]["features"].keys()) == set(mock_data[0]["features"].keys())

    def test_generate_batch_data(self):
        connector = SyntheticERPConnector(seed=42, config={"n_materials": 3, "n_plants": 1, "days": 30})
        skus = connector.get_available_skus()
        batch = connector.generate_batch_data(skus, days=30)
        assert len(batch) == len(skus)
        for sku, records in batch.items():
            assert len(records) == 30

    def test_extended_api_master_data(self):
        connector = SyntheticERPConnector(seed=42, config={"n_materials": 3, "n_plants": 1, "days": 30})
        md = connector.get_master_data()
        assert "materials" in md
        assert "suppliers" in md
        assert "plants" in md
        assert "bom_edges" in md
        assert len(md["materials"]) > 0  # count depends on n_semi/n_raw defaults

    def test_extended_api_stock_snapshots(self):
        connector = SyntheticERPConnector(seed=42, config={"n_materials": 3, "n_plants": 1, "days": 30})
        snapshots = connector.get_stock_snapshots()
        assert len(snapshots) > 0
        s = snapshots[0]
        assert "material_code" in s
        assert "plant_id" in s
        assert "qty" in s

    def test_extended_api_bom_edges(self):
        connector = SyntheticERPConnector(seed=42, config={"n_materials": 3, "n_plants": 1, "days": 30})
        edges = connector.get_bom_edges()
        assert len(edges) > 0
        assert "parent_material" in edges[0]
        assert "child_material" in edges[0]

    def test_kpis(self):
        connector = SyntheticERPConnector(seed=42, config={"n_materials": 3, "n_plants": 1, "days": 60})
        kpis = connector.get_kpis()
        assert "aggregate" in kpis
        assert "by_material" in kpis
        assert 0.0 <= kpis["aggregate"]["fill_rate"] <= 1.0

    def test_dataset_id_reuse(self):
        """Creating connector with same seed+config should reuse dataset."""
        c1 = SyntheticERPConnector(seed=42, config={"n_materials": 3, "n_plants": 1, "days": 30})
        id1 = c1.dataset_id
        c2 = SyntheticERPConnector(dataset_id=id1)
        assert c2.dataset_id == id1
        assert c2.get_available_skus() == c1.get_available_skus()

    def test_add_sku_pattern_noop(self):
        """add_sku_pattern should be a no-op (compatibility shim)."""
        connector = SyntheticERPConnector(seed=42, config={"n_materials": 3, "n_plants": 1, "days": 30})
        skus_before = connector.get_available_skus()
        connector.add_sku_pattern("NEW_SKU", base=100)
        skus_after = connector.get_available_skus()
        assert skus_before == skus_after  # no change
