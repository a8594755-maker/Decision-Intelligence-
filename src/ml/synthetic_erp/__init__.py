"""
Synthetic ERP Sandbox v1
========================
Generate realistic ERP datasets for testing, demos, and digital twin scenarios.

Uses SAP-like master data + synthetic transactions + connector adapter so the
existing forecast / simulation / planning pipeline can run without a real ERP.

NOTE: v1 DatasetRegistry is process-local (in-memory singleton).
      Future versions will upgrade to a DB-backed registry.
"""

from .master_data_builder import (
    MasterDataBuilder, MaterialMaster, SupplierMaster, PlantMaster, BOMEdge,
)
from .demand_generator import SyntheticDemandGenerator
from .inventory_simulator import SyntheticInventorySimulator
from .scenario_engine import ScenarioEngine, DisruptionSpec
from .dataset_registry import DatasetRegistry, DatasetDescriptor
from .kpi_engine import KPIEngine
from .synthetic_erp_connector import SyntheticERPConnector

__all__ = [
    "MasterDataBuilder", "MaterialMaster", "SupplierMaster", "PlantMaster", "BOMEdge",
    "SyntheticDemandGenerator",
    "SyntheticInventorySimulator",
    "ScenarioEngine", "DisruptionSpec",
    "DatasetRegistry", "DatasetDescriptor",
    "KPIEngine",
    "SyntheticERPConnector",
]
