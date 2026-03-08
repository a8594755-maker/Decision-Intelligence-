"""
Synthetic ERP Router — FastAPI endpoints for the Synthetic ERP Sandbox.
=========================================================================
Follows the registry_router.py pattern using APIRouter.

The /forecast endpoint calls ForecasterFactory directly (no HTTP self-call)
to avoid extra overhead, exception handling complexity, and test difficulty.
"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from dataclasses import asdict

from .synthetic_erp_connector import SyntheticERPConnector
from .dataset_registry import DatasetRegistry
from .scenario_engine import ScenarioEngine

router = APIRouter(prefix="/synthetic", tags=["Synthetic ERP"])


# ══════════════════════════════════════════════
#  Request / Response models
# ══════════════════════════════════════════════

class GenerateDatasetRequest(BaseModel):
    seed: int = 42
    n_materials: int = 10
    n_plants: int = 3
    n_suppliers: int = 5
    days: int = 730
    start_date: str = "2024-01-01"
    chaos_intensity: str = "medium"
    disruptions: List[Any] = Field(default_factory=list)

class ForecastOnSyntheticRequest(BaseModel):
    material_code: str
    horizon_days: int = 30
    model_type: Optional[str] = None


# ══════════════════════════════════════════════
#  Dataset CRUD endpoints
# ══════════════════════════════════════════════

@router.post("/generate")
async def generate_dataset(request: GenerateDatasetRequest):
    """Generate a complete synthetic ERP dataset."""
    config = {
        "n_materials": request.n_materials,
        "n_plants": request.n_plants,
        "n_suppliers": request.n_suppliers,
        "days": request.days,
        "start_date": request.start_date,
        "chaos_intensity": request.chaos_intensity,
        "disruptions": request.disruptions,
    }
    connector = SyntheticERPConnector(seed=request.seed, config=config)
    registry = DatasetRegistry.get_instance()
    descriptor = registry.get_descriptor(connector.dataset_id)

    return {
        "dataset_id": connector.dataset_id,
        "descriptor": asdict(descriptor) if descriptor else None,
        "status": "generated",
    }


@router.get("/datasets")
async def list_datasets():
    """List all registered synthetic datasets."""
    registry = DatasetRegistry.get_instance()
    return {"datasets": registry.list_datasets()}


@router.get("/datasets/{dataset_id}")
async def get_dataset(dataset_id: str):
    """Get dataset descriptor and summary."""
    registry = DatasetRegistry.get_instance()
    descriptor = registry.get_descriptor(dataset_id)
    if descriptor is None:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found")

    data = registry.get(dataset_id)
    summary = {}
    if data:
        inv = data.get("inventory_data") or {}
        summary = {
            "n_stock_snapshots": len(inv.get("stock_snapshots", [])),
            "n_purchase_orders": len(inv.get("purchase_orders", [])),
            "n_demand_pairs": len(data.get("demand_data", {})),
            "n_erp_skus": len(data.get("erp_sales", {})),
        }

    return {
        "descriptor": asdict(descriptor),
        "summary": summary,
        "kpis": data.get("kpis") if data else None,
    }


@router.delete("/datasets/{dataset_id}")
async def delete_dataset(dataset_id: str):
    """Delete a registered dataset."""
    registry = DatasetRegistry.get_instance()
    deleted = registry.delete(dataset_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found")
    return {"status": "deleted", "dataset_id": dataset_id}


# ══════════════════════════════════════════════
#  Data access endpoints
# ══════════════════════════════════════════════

@router.get("/datasets/{dataset_id}/sales")
async def get_sales_data(
    dataset_id: str,
    material_code: Optional[str] = None,
    days: int = Query(default=730, ge=1),
):
    """Fetch sales data in ERP connector format (aggregated across plants)."""
    connector = _get_connector(dataset_id)
    if material_code:
        data = connector.fetch_sales_data(material_code, days)
        if data is None:
            raise HTTPException(status_code=404, detail=f"No sales data for {material_code}")
        return {"material_code": material_code, "records": data, "count": len(data)}
    else:
        skus = connector.get_available_skus()
        return {
            "available_skus": skus,
            "hint": "Provide ?material_code=MAT-001 to fetch sales data for a specific SKU",
        }


@router.get("/datasets/{dataset_id}/stock")
async def get_stock_snapshots(
    dataset_id: str,
    material_code: Optional[str] = None,
    plant_id: Optional[str] = None,
):
    """Get inventory stock snapshots (plant-level detail)."""
    connector = _get_connector(dataset_id)
    snapshots = connector.get_stock_snapshots(material_code, plant_id)
    return {"count": len(snapshots), "snapshots": snapshots[:1000]}  # cap response size


@router.get("/datasets/{dataset_id}/purchase-orders")
async def get_purchase_orders(
    dataset_id: str,
    material_code: Optional[str] = None,
    plant_id: Optional[str] = None,
):
    """Get purchase orders (plant-level detail)."""
    connector = _get_connector(dataset_id)
    pos = connector.get_purchase_orders(material_code, plant_id)
    return {"count": len(pos), "purchase_orders": pos[:1000]}


@router.get("/datasets/{dataset_id}/bom")
async def get_bom_edges(
    dataset_id: str,
    parent_material: Optional[str] = None,
):
    """Get BOM edges."""
    connector = _get_connector(dataset_id)
    edges = connector.get_bom_edges(parent_material)
    return {"count": len(edges), "bom_edges": edges}


@router.get("/datasets/{dataset_id}/kpis")
async def get_kpis(dataset_id: str):
    """Get computed KPIs for a dataset."""
    connector = _get_connector(dataset_id)
    kpis = connector.get_kpis()
    if not kpis:
        raise HTTPException(status_code=404, detail="No KPIs computed for this dataset")
    return kpis


@router.get("/datasets/{dataset_id}/master-data")
async def get_master_data(dataset_id: str):
    """Get full master data tables."""
    connector = _get_connector(dataset_id)
    md = connector.get_master_data()
    return {k: {"count": len(v), "data": v} for k, v in md.items()}


@router.get("/datasets/{dataset_id}/sales-by-plant")
async def get_sales_by_plant(
    dataset_id: str,
    material_code: str = Query(...),
    plant_id: Optional[str] = None,
    days: int = Query(default=730, ge=1),
):
    """Get plant-level sales data (not aggregated). For planning / inventory."""
    connector = _get_connector(dataset_id)
    records = connector.get_sales_data_by_plant(material_code, plant_id, days)
    return {"count": len(records), "records": records}


# ══════════════════════════════════════════════
#  Forecast endpoint (direct ForecasterFactory call)
# ══════════════════════════════════════════════

@router.post("/datasets/{dataset_id}/forecast")
async def forecast_on_synthetic(dataset_id: str, request: ForecastOnSyntheticRequest):
    """Run demand forecast using synthetic dataset's history.

    Calls ForecasterFactory.predict_with_fallback() directly with inline history.
    No HTTP self-call — uses the same in-process forecaster instance.
    """
    connector = _get_connector(dataset_id)
    sales = connector.fetch_sales_data(request.material_code, days=730)
    if not sales:
        raise HTTPException(status_code=404, detail=f"No sales data for {request.material_code}")

    # Extract history as float list (matches ForecastRequest.history format)
    history = [float(r["sales"]) for r in sales]

    # Import the module-level forecaster_factory from main
    # This avoids circular imports by doing a lazy import
    from ml.api.main import forecaster_factory

    result = forecaster_factory.predict_with_fallback(
        sku=request.material_code,
        erp_connector=None,  # bypass connector — use inline_history
        horizon_days=request.horizon_days,
        preferred_model=request.model_type,
        inline_history=history,
    )

    return {
        "dataset_id": dataset_id,
        "material_code": request.material_code,
        "horizon_days": request.horizon_days,
        "history_points": len(history),
        "forecast": result,
    }


# ══════════════════════════════════════════════
#  Scenario templates
# ══════════════════════════════════════════════

@router.get("/scenario-templates")
async def list_scenario_templates():
    """List available scenario templates."""
    return {
        "templates": ScenarioEngine.list_templates(),
    }


# ══════════════════════════════════════════════
#  Helpers
# ══════════════════════════════════════════════

def _get_connector(dataset_id: str) -> SyntheticERPConnector:
    """Get a connector for an existing dataset. Raises 404 if not found."""
    registry = DatasetRegistry.get_instance()
    if registry.get(dataset_id) is None:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found")
    return SyntheticERPConnector(dataset_id=dataset_id)
