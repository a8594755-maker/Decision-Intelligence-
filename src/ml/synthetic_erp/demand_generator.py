"""
Synthetic Demand Generator — Multi-SKU, multi-plant demand history.
====================================================================
Wraps ml.simulation.data_generator.DataGenerator, adding:
  - Plant-level capacity scaling
  - Category → DemandProfile mapping
  - ERP-compatible sales record output (matches MockERPConnector shape)
"""
import numpy as np
import pandas as pd
from typing import List, Dict, Optional, Tuple
from datetime import datetime, timedelta

from ml.simulation.data_generator import DataGenerator, DemandProfile
from .master_data_builder import MaterialMaster, PlantMaster


# ── Category → DemandProfile parameter presets ──
_CATEGORY_PROFILES = {
    "electronics": {
        "trend_per_day": 0.08,
        "weekly_amplitude": 18.0,
        "monthly_amplitude": 8.0,
        "yearly_amplitude": 25.0,
        "noise_std": 10.0,
        "shock_probability": 0.015,
        "promo_interval_days": 30,
        "promo_lift": 0.35,
    },
    "mechanical": {
        "trend_per_day": 0.03,
        "weekly_amplitude": 8.0,
        "monthly_amplitude": 12.0,
        "yearly_amplitude": 15.0,
        "noise_std": 6.0,
        "shock_probability": 0.01,
        "promo_interval_days": 60,
        "promo_lift": 0.2,
    },
    "chemical": {
        "trend_per_day": 0.02,
        "weekly_amplitude": 5.0,
        "monthly_amplitude": 6.0,
        "yearly_amplitude": 10.0,
        "noise_std": 5.0,
        "noise_type": "multiplicative",
        "shock_probability": 0.008,
        "promo_interval_days": 0,  # no promos
        "promo_lift": 0.0,
    },
    "packaging": {
        "trend_per_day": 0.05,
        "weekly_amplitude": 20.0,
        "monthly_amplitude": 10.0,
        "yearly_amplitude": 30.0,
        "noise_std": 12.0,
        "shock_probability": 0.02,
        "promo_interval_days": 45,
        "promo_lift": 0.3,
    },
}


class SyntheticDemandGenerator:
    """Generate high-fidelity demand history for (material, plant) FG pairs.

    Delegates to ml.simulation.data_generator.DataGenerator for signal
    composition, adding plant-level scaling and category-based profiles.
    """

    def __init__(self, seed: int = 42):
        self._seed = seed

    def generate(
        self,
        materials: List[MaterialMaster],
        plants: List[PlantMaster],
        days: int = 730,
        start_date: str = "2024-01-01",
    ) -> Dict[Tuple[str, str], pd.DataFrame]:
        """Generate demand for every (material_code, plant_id) FG combination.

        Only finished-goods (FG) materials that are assigned to a plant get demand.

        Returns:
            Dict keyed by (material_code, plant_id) → DataFrame with columns:
            date, demand, trend, seasonality, noise, shock_multiplier, promo_lift
        """
        fg_materials = [m for m in materials if m.material_type == "FG"]
        results: Dict[Tuple[str, str], pd.DataFrame] = {}

        for mat_idx, mat in enumerate(fg_materials):
            for plant_idx, plant in enumerate(plants):
                if mat.material_code not in plant.materials:
                    continue

                # Deterministic seed per (material, plant)
                pair_seed = self._seed + mat_idx * 1000 + plant_idx
                gen = DataGenerator(seed=pair_seed)

                profile = self._material_to_profile(mat, plant)
                df = gen.generate(profile, days=days, start_date=start_date)
                results[(mat.material_code, plant.plant_id)] = df

        return results

    def to_erp_sales_records(
        self,
        demand_data: Dict[Tuple[str, str], pd.DataFrame],
    ) -> Dict[str, List[Dict]]:
        """Convert demand DataFrames to MockERPConnector-compatible sales records.

        Aggregates across plants per material_code (for forecast compatibility).

        Returns:
            Dict keyed by material_code → [{date, sales, sku, features}]
            Shape matches MockERPConnector.fetch_sales_data() output exactly.
        """
        # Aggregate demand by material_code across plants
        by_material: Dict[str, pd.DataFrame] = {}

        for (mat_code, plant_id), df in demand_data.items():
            if mat_code not in by_material:
                by_material[mat_code] = df[["date", "demand"]].copy()
                by_material[mat_code] = by_material[mat_code].rename(columns={"demand": "demand_total"})
            else:
                merged = by_material[mat_code].merge(
                    df[["date", "demand"]], on="date", how="outer"
                ).fillna(0)
                merged["demand_total"] = merged["demand_total"] + merged["demand"]
                by_material[mat_code] = merged[["date", "demand_total"]]

        rng = np.random.RandomState(self._seed + 99999)
        result: Dict[str, List[Dict]] = {}

        for mat_code, agg_df in by_material.items():
            records = []
            for i, row in enumerate(agg_df.itertuples(index=False)):
                sales = max(0.0, float(row.demand_total))
                promo = 1 if rng.random() < 0.05 else 0
                records.append({
                    "date": str(row.date.date()) if hasattr(row.date, "date") else str(row.date),
                    "sales": round(sales, 2),
                    "sku": mat_code,
                    "features": {
                        "price_index": round(1.0 + 0.1 * np.sin(2 * np.pi * i / 30), 4),
                        "promotion": promo,
                        "inventory": round(max(0, sales * rng.uniform(1.5, 3.0)), 2),
                    },
                })
            result[mat_code] = records

        return result

    def to_erp_sales_records_by_plant(
        self,
        demand_data: Dict[Tuple[str, str], pd.DataFrame],
    ) -> Dict[Tuple[str, str], List[Dict]]:
        """Convert demand DataFrames to sales records per (material, plant).

        Used by planning/inventory endpoints that need plant-level detail.
        """
        rng = np.random.RandomState(self._seed + 99998)
        result: Dict[Tuple[str, str], List[Dict]] = {}

        for (mat_code, plant_id), df in demand_data.items():
            records = []
            for i, row in enumerate(df.itertuples(index=False)):
                sales = max(0.0, float(row.demand))
                promo = 1 if rng.random() < 0.05 else 0
                records.append({
                    "date": str(row.date.date()) if hasattr(row.date, "date") else str(row.date),
                    "sales": round(sales, 2),
                    "sku": mat_code,
                    "plant_id": plant_id,
                    "features": {
                        "price_index": round(1.0 + 0.1 * np.sin(2 * np.pi * i / 30), 4),
                        "promotion": promo,
                        "inventory": round(max(0, sales * rng.uniform(1.5, 3.0)), 2),
                    },
                })
            result[(mat_code, plant_id)] = records

        return result

    @staticmethod
    def _material_to_profile(mat: MaterialMaster, plant: PlantMaster) -> DemandProfile:
        """Convert MaterialMaster + PlantMaster into a DemandProfile.

        Uses mat.base_demand * plant.capacity_factor as base,
        and derives seasonality/noise from material category.
        """
        presets = _CATEGORY_PROFILES.get(mat.category, _CATEGORY_PROFILES["mechanical"])

        return DemandProfile(
            name=f"{mat.material_code}_{plant.plant_id}",
            base_demand=mat.base_demand * plant.capacity_factor,
            trend_per_day=presets["trend_per_day"],
            trend_type="linear",
            weekly_amplitude=presets["weekly_amplitude"],
            monthly_amplitude=presets["monthly_amplitude"],
            yearly_amplitude=presets["yearly_amplitude"],
            noise_std=presets["noise_std"],
            noise_type=presets.get("noise_type", "gaussian"),
            shock_probability=presets["shock_probability"],
            promo_interval_days=presets["promo_interval_days"],
            promo_lift=presets["promo_lift"],
        )
