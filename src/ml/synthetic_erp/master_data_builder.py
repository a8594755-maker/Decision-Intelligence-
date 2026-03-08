"""
Master Data Builder — Build ERP-like master data deterministically from a seed.
=================================================================================
Generates: materials, suppliers, plants, BOM edges.
Field names align with existing SAP sync conventions (material_code, uom, category).
"""
import numpy as np
from dataclasses import dataclass, field, asdict
from typing import List, Optional, Dict, Any
import pandas as pd


# ── Material archetypes keyed by category ──
_CATEGORY_ARCHETYPES = {
    "electronics": {
        "base_demand_range": (60, 200),
        "unit_cost_range": (15.0, 120.0),
        "lead_time_range": (5, 14),
        "uom": "PCS",
    },
    "mechanical": {
        "base_demand_range": (40, 150),
        "unit_cost_range": (8.0, 60.0),
        "lead_time_range": (7, 21),
        "uom": "PCS",
    },
    "chemical": {
        "base_demand_range": (80, 300),
        "unit_cost_range": (3.0, 25.0),
        "lead_time_range": (10, 28),
        "uom": "KG",
    },
    "packaging": {
        "base_demand_range": (200, 600),
        "unit_cost_range": (0.5, 5.0),
        "lead_time_range": (3, 10),
        "uom": "PCS",
    },
}

_CATEGORIES = list(_CATEGORY_ARCHETYPES.keys())

_REGIONS = ["APAC", "EMEA", "AMER"]

_SUPPLIER_NAMES = [
    "TechParts Co.", "Global Components", "FastSupply Ltd.", "PrimeMaterials",
    "AlloyWorks", "ChemSource", "PackRight Inc.", "MetalCraft",
    "SemiCon Supply", "GreenPack Co.", "PrecisionParts", "RawBase Ltd.",
]


@dataclass
class MaterialMaster:
    material_code: str
    description: str
    material_type: str      # FG | SEMI | RAW
    category: str
    uom: str
    base_demand: float      # average daily demand (FG only, 0 for SEMI/RAW)
    unit_cost: float
    holding_cost_per_day: float
    lead_time_days: int
    safety_stock_days: float
    moq: float              # minimum order quantity
    reorder_point: float
    service_level_target: float
    lifecycle_status: str   # active | mature | eol


@dataclass
class SupplierMaster:
    supplier_id: str
    name: str
    country: str
    materials: List[str]    # material_codes this supplier provides
    base_lead_time: int
    lead_time_std: float
    reliability: float      # 0-1
    defect_rate: float
    capacity_per_day: float


@dataclass
class PlantMaster:
    plant_id: str
    name: str
    region: str
    capacity_factor: float  # 1.0 = baseline
    materials: List[str]    # material_codes stocked here
    storage_capacity: float


@dataclass
class BOMEdge:
    parent_material: str
    child_material: str
    qty_per: float
    uom: str
    scrap_rate: float
    plant_id: Optional[str] = None


# ── Default generation config ──
DEFAULT_CONFIG = {
    "n_fg": 10,
    "n_semi": 5,
    "n_raw": 5,
    "n_suppliers": 5,
    "n_plants": 3,
    "bom_depth": 2,         # FG -> SEMI -> RAW
    "bom_children_range": (1, 3),
}


class MasterDataBuilder:
    """Build ERP-like master data deterministically from a seed."""

    def __init__(self, seed: int = 42, config: Optional[Dict[str, Any]] = None):
        self.seed = seed
        self._rng = np.random.RandomState(seed)
        self.cfg = {**DEFAULT_CONFIG, **(config or {})}
        self._result: Optional[Dict[str, Any]] = None

    def build(self) -> Dict[str, Any]:
        """Build all master data tables. Returns dict with materials, suppliers, plants, bom_edges."""
        materials = self._build_materials()
        suppliers = self._build_suppliers(materials)
        plants = self._build_plants(materials)
        bom_edges = self._build_bom(materials)

        self._result = {
            "materials": materials,
            "suppliers": suppliers,
            "plants": plants,
            "bom_edges": bom_edges,
        }
        return self._result

    def to_dataframes(self) -> Dict[str, pd.DataFrame]:
        """Convert all master data to DataFrames."""
        if self._result is None:
            self.build()
        return {
            key: pd.DataFrame([asdict(item) for item in items])
            for key, items in self._result.items()
        }

    # ── Internal builders ──

    def _build_materials(self) -> List[MaterialMaster]:
        materials: List[MaterialMaster] = []
        idx = 1

        for mat_type, count_key in [("FG", "n_fg"), ("SEMI", "n_semi"), ("RAW", "n_raw")]:
            n = self.cfg[count_key]
            for _ in range(n):
                cat = _CATEGORIES[self._rng.randint(0, len(_CATEGORIES))]
                arch = _CATEGORY_ARCHETYPES[cat]

                base_demand = float(self._rng.uniform(*arch["base_demand_range"])) if mat_type == "FG" else 0.0
                unit_cost = float(self._rng.uniform(*arch["unit_cost_range"]))
                lead_time = int(self._rng.randint(*arch["lead_time_range"]))

                materials.append(MaterialMaster(
                    material_code=f"MAT-{idx:03d}",
                    description=f"{cat.title()} {mat_type} Part {idx}",
                    material_type=mat_type,
                    category=cat,
                    uom=arch["uom"],
                    base_demand=round(base_demand, 1),
                    unit_cost=round(unit_cost, 2),
                    holding_cost_per_day=round(unit_cost * 0.001, 4),
                    lead_time_days=lead_time,
                    safety_stock_days=round(float(self._rng.uniform(1.0, 3.0)), 1),
                    moq=float(self._rng.choice([10, 25, 50, 100])),
                    reorder_point=round(base_demand * lead_time * 0.8, 0) if mat_type == "FG" else 0.0,
                    service_level_target=round(float(self._rng.uniform(0.90, 0.99)), 2),
                    lifecycle_status=str(self._rng.choice(["active", "active", "active", "mature", "eol"])),
                ))
                idx += 1

        return materials

    def _build_suppliers(self, materials: List[MaterialMaster]) -> List[SupplierMaster]:
        n = self.cfg["n_suppliers"]
        # Assign materials to suppliers (round-robin + randomness)
        raw_and_semi = [m.material_code for m in materials if m.material_type in ("RAW", "SEMI")]
        suppliers: List[SupplierMaster] = []

        for i in range(n):
            # Each supplier gets a subset of raw/semi materials
            chunk_size = max(1, len(raw_and_semi) // n)
            start = i * chunk_size
            assigned = raw_and_semi[start:start + chunk_size]
            # Add 1-2 random extras for supplier overlap
            extras = int(self._rng.randint(0, 3))
            for _ in range(extras):
                if raw_and_semi:
                    assigned.append(raw_and_semi[self._rng.randint(0, len(raw_and_semi))])
            assigned = list(set(assigned))

            name = _SUPPLIER_NAMES[i % len(_SUPPLIER_NAMES)]
            country = str(self._rng.choice(["TW", "CN", "JP", "KR", "DE", "US", "IN"]))

            suppliers.append(SupplierMaster(
                supplier_id=f"SUP-{i+1:03d}",
                name=name,
                country=country,
                materials=assigned,
                base_lead_time=int(self._rng.randint(5, 21)),
                lead_time_std=round(float(self._rng.uniform(1.0, 5.0)), 1),
                reliability=round(float(self._rng.uniform(0.75, 0.99)), 2),
                defect_rate=round(float(self._rng.uniform(0.005, 0.08)), 3),
                capacity_per_day=round(float(self._rng.uniform(200, 1000)), 0),
            ))

        return suppliers

    def _build_plants(self, materials: List[MaterialMaster]) -> List[PlantMaster]:
        n = self.cfg["n_plants"]
        fg_codes = [m.material_code for m in materials if m.material_type == "FG"]
        plants: List[PlantMaster] = []

        for i in range(n):
            region = _REGIONS[i % len(_REGIONS)]
            # Distribute FG materials across plants (overlapping)
            chunk_size = max(1, len(fg_codes) // n)
            start = i * chunk_size
            assigned = fg_codes[start:start + chunk_size]
            # Add some overlap
            extras = int(self._rng.randint(1, min(4, len(fg_codes) + 1)))
            for _ in range(extras):
                assigned.append(fg_codes[self._rng.randint(0, len(fg_codes))])
            assigned = sorted(set(assigned))

            plants.append(PlantMaster(
                plant_id=f"P{(i+1)*100}",
                name=f"{region} Plant {i+1}",
                region=region,
                capacity_factor=round(float(self._rng.uniform(0.6, 1.4)), 2),
                materials=assigned,
                storage_capacity=round(float(self._rng.uniform(5000, 20000)), 0),
            ))

        return plants

    def _build_bom(self, materials: List[MaterialMaster]) -> List[BOMEdge]:
        """Build BOM edges ensuring acyclicity: FG -> SEMI -> RAW."""
        fg = [m for m in materials if m.material_type == "FG"]
        semi = [m for m in materials if m.material_type == "SEMI"]
        raw = [m for m in materials if m.material_type == "RAW"]

        edges: List[BOMEdge] = []
        lo, hi = self.cfg["bom_children_range"]

        # FG -> SEMI
        for parent in fg:
            n_children = int(self._rng.randint(lo, hi + 1))
            if not semi:
                break
            children = self._rng.choice(semi, size=min(n_children, len(semi)), replace=False)
            for child in children:
                edges.append(BOMEdge(
                    parent_material=parent.material_code,
                    child_material=child.material_code,
                    qty_per=round(float(self._rng.uniform(1, 5)), 1),
                    uom=child.uom,
                    scrap_rate=round(float(self._rng.uniform(0.0, 0.05)), 3),
                ))

        # SEMI -> RAW
        for parent in semi:
            n_children = int(self._rng.randint(lo, hi + 1))
            if not raw:
                break
            children = self._rng.choice(raw, size=min(n_children, len(raw)), replace=False)
            for child in children:
                edges.append(BOMEdge(
                    parent_material=parent.material_code,
                    child_material=child.material_code,
                    qty_per=round(float(self._rng.uniform(0.5, 10)), 1),
                    uom=child.uom,
                    scrap_rate=round(float(self._rng.uniform(0.0, 0.03)), 3),
                ))

        return edges
