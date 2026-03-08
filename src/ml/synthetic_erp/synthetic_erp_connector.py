"""
Synthetic ERP Connector — ERP-like read interface over generated datasets.
============================================================================
Implements the same duck-typed interface as MockERPConnector:
  - fetch_sales_data(sku, days) → List[Dict]   (aggregated across plants for forecast)
  - get_available_skus() → List[str]
  - generate_batch_data(skus, days) → Dict[str, List[Dict]]
  - add_sku_pattern(...) → no-op compatibility shim

Extended API for planning / inventory / stock (plant-level detail):
  - get_master_data()
  - get_stock_snapshots(material_code, plant_id)
  - get_bom_edges(parent_material)
  - get_purchase_orders(material_code, plant_id)
  - get_kpis()
  - get_sales_data_by_plant(material_code, plant_id, days)
"""
from dataclasses import asdict
from typing import List, Dict, Any, Optional

from .master_data_builder import MasterDataBuilder
from .demand_generator import SyntheticDemandGenerator
from .inventory_simulator import SyntheticInventorySimulator
from .scenario_engine import ScenarioEngine, DisruptionSpec
from .dataset_registry import DatasetRegistry
from .kpi_engine import KPIEngine


class SyntheticERPConnector:
    """ERP-like connector serving data from the Synthetic ERP Sandbox.

    On construction, either loads an existing dataset from the registry
    or generates a new one from seed + config.
    """

    def __init__(
        self,
        dataset_id: Optional[str] = None,
        seed: int = 42,
        config: Optional[Dict[str, Any]] = None,
        api_endpoint: str = None,
        api_key: str = None,
    ):
        """
        Args:
            dataset_id: Use existing registered dataset.
            seed: Generate new dataset if dataset_id is None or not found.
            config: Generation config (n_fg, n_plants, days, disruptions, etc.).
            api_endpoint: Ignored (compatibility with MockERPConnector.__init__).
            api_key: Ignored (compatibility).
        """
        self._registry = DatasetRegistry.get_instance()
        self._config = config or {}
        self._seed = seed

        if dataset_id and self._registry.get(dataset_id):
            self._dataset_id = dataset_id
        else:
            self._dataset_id = self._generate(seed, self._config)

    # ══════════════════════════════════════════════
    #  MockERPConnector-compatible interface
    # ══════════════════════════════════════════════

    def fetch_sales_data(self, sku: str, days: int = 730) -> Optional[List[Dict]]:
        """Fetch sales data aggregated across plants (forecast-compatible).

        Returns: [{date, sales, sku, features: {price_index, promotion, inventory}}]
        Same shape as MockERPConnector.fetch_sales_data().
        """
        data = self._registry.get(self._dataset_id)
        if data is None:
            return None

        erp_sales = data.get("erp_sales", {})
        records = erp_sales.get(sku)
        if records is None:
            return None

        # Trim to requested days (from end)
        if days < len(records):
            records = records[-days:]
        return records

    def get_available_skus(self) -> List[str]:
        """List all FG material codes that have demand data."""
        data = self._registry.get(self._dataset_id)
        if data is None:
            return []
        erp_sales = data.get("erp_sales", {})
        return list(erp_sales.keys())

    def generate_batch_data(self, skus: List[str], days: int = 365) -> Dict[str, List[Dict]]:
        """Fetch sales data for multiple SKUs."""
        return {
            sku: self.fetch_sales_data(sku, days) or []
            for sku in skus
        }

    def add_sku_pattern(self, sku: str, base: float, trend: float = 0.0,
                        seasonality: float = 0.0, volatility: float = 0.1):
        """No-op compatibility shim. Synthetic datasets use MasterDataBuilder profiles."""
        pass

    # ══════════════════════════════════════════════
    #  Extended API (plant-level detail)
    # ══════════════════════════════════════════════

    def get_master_data(self) -> Dict[str, Any]:
        """Get full master data (materials, suppliers, plants, bom_edges) as dicts."""
        data = self._registry.get(self._dataset_id)
        if data is None:
            return {}
        md = data.get("master_data", {})
        return {
            key: [asdict(item) for item in items]
            for key, items in md.items()
        }

    def get_stock_snapshots(
        self,
        material_code: Optional[str] = None,
        plant_id: Optional[str] = None,
    ) -> List[Dict]:
        """Get inventory snapshots matching material_stock_snapshots shape."""
        data = self._registry.get(self._dataset_id)
        if data is None:
            return []
        inv = data.get("inventory_data") or {}
        snapshots = inv.get("stock_snapshots", [])

        if material_code:
            snapshots = [s for s in snapshots if s["material_code"] == material_code]
        if plant_id:
            snapshots = [s for s in snapshots if s["plant_id"] == plant_id]
        return snapshots

    def get_purchase_orders(
        self,
        material_code: Optional[str] = None,
        plant_id: Optional[str] = None,
    ) -> List[Dict]:
        """Get purchase orders."""
        data = self._registry.get(self._dataset_id)
        if data is None:
            return []
        inv = data.get("inventory_data") or {}
        pos = inv.get("purchase_orders", [])

        if material_code:
            pos = [p for p in pos if p["material_code"] == material_code]
        if plant_id:
            pos = [p for p in pos if p["plant_id"] == plant_id]
        return pos

    def get_bom_edges(self, parent_material: Optional[str] = None) -> List[Dict]:
        """Get BOM edges matching bom_edges table shape."""
        data = self._registry.get(self._dataset_id)
        if data is None:
            return []
        md = data.get("master_data", {})
        edges = md.get("bom_edges", [])
        result = [asdict(e) for e in edges]
        if parent_material:
            result = [e for e in result if e["parent_material"] == parent_material]
        return result

    def get_kpis(self) -> Dict[str, Any]:
        """Get computed KPIs for this dataset."""
        data = self._registry.get(self._dataset_id)
        if data is None:
            return {}
        return data.get("kpis") or {}

    def get_sales_data_by_plant(
        self,
        material_code: str,
        plant_id: Optional[str] = None,
        days: int = 730,
    ) -> List[Dict]:
        """Get plant-level sales data (not aggregated)."""
        data = self._registry.get(self._dataset_id)
        if data is None:
            return []
        demand_data = data.get("demand_data", {})

        records = []
        for (mat, plt), df in demand_data.items():
            if mat != material_code:
                continue
            if plant_id and plt != plant_id:
                continue

            n = min(days, len(df))
            subset = df.iloc[-n:] if n < len(df) else df
            for _, row in subset.iterrows():
                date_val = row["date"]
                records.append({
                    "date": str(date_val.date()) if hasattr(date_val, "date") else str(date_val),
                    "sales": round(float(row["demand"]), 2),
                    "sku": mat,
                    "plant_id": plt,
                })

        return records

    @property
    def dataset_id(self) -> str:
        return self._dataset_id

    # ══════════════════════════════════════════════
    #  Internal generation
    # ══════════════════════════════════════════════

    def _generate(self, seed: int, config: Dict) -> str:
        """Generate a full synthetic ERP dataset and register it."""
        # Parse config
        n_fg = config.get("n_fg", config.get("n_materials", 10))
        n_semi = config.get("n_semi", max(3, n_fg // 2))
        n_raw = config.get("n_raw", max(3, n_fg // 2))
        n_suppliers = config.get("n_suppliers", 5)
        n_plants = config.get("n_plants", 3)
        days = config.get("days", 730)
        start_date = config.get("start_date", "2024-01-01")
        chaos_intensity = config.get("chaos_intensity", "medium")
        disruptions_raw = config.get("disruptions", [])

        builder_config = {
            "n_fg": n_fg, "n_semi": n_semi, "n_raw": n_raw,
            "n_suppliers": n_suppliers, "n_plants": n_plants,
        }

        # 1. Build master data
        builder = MasterDataBuilder(seed=seed, config=builder_config)
        master_data = builder.build()

        # 2. Generate demand
        demand_gen = SyntheticDemandGenerator(seed=seed)
        demand_data = demand_gen.generate(
            master_data["materials"], master_data["plants"],
            days=days, start_date=start_date,
        )

        # 3. Apply scenarios (demand-side only at generation time)
        disruption_names = []
        if disruptions_raw:
            specs = []
            for d in disruptions_raw:
                if isinstance(d, str):
                    # Template name
                    specs.extend(ScenarioEngine.get_template(d))
                    disruption_names.append(d)
                elif isinstance(d, dict):
                    specs.append(DisruptionSpec(**d))
                    disruption_names.append(d.get("name", "custom"))

            engine = ScenarioEngine(seed=seed)
            demand_data = engine.apply_demand(specs, demand_data)

        # 4. Run inventory simulation
        inv_sim = SyntheticInventorySimulator(
            master_data=master_data, demand_data=demand_data,
            seed=seed, chaos_intensity=chaos_intensity,
        )
        inventory_data = inv_sim.run(days=days)

        # 5. Compute KPIs
        kpis = KPIEngine.compute(inventory_data, demand_data, master_data)

        # 6. Build ERP sales records (aggregated for forecast)
        erp_sales = demand_gen.to_erp_sales_records(demand_data)

        # 7. Register
        full_config = {
            **builder_config,
            "days": days, "start_date": start_date,
            "chaos_intensity": chaos_intensity,
            "disruptions": disruption_names,
        }
        descriptor = self._registry.register(
            seed=seed, config=full_config,
            master_data=master_data, demand_data=demand_data,
            inventory_data=inventory_data, kpis=kpis,
            erp_sales=erp_sales, disruptions=disruption_names,
        )

        return descriptor.dataset_id
