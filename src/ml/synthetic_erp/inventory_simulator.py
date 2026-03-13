"""
Synthetic Inventory Simulator — Multi-material, multi-plant daily loop.
========================================================================
Wraps ml.simulation.inventory_sim.InventorySimulator and
ml.simulation.chaos_engine.ChaosEngine into a unified daily simulation
that produces stock snapshots matching material_stock_snapshots shape.
"""
import numpy as np
import pandas as pd
from dataclasses import asdict
from typing import Dict, List, Any, Optional, Tuple
from datetime import datetime, timedelta

from ml.simulation.inventory_sim import InventorySimulator, InventoryConfig, DailyRecord
from ml.simulation.chaos_engine import ChaosEngine, SupplierProfile
from .master_data_builder import MaterialMaster, PlantMaster, SupplierMaster


class SyntheticInventorySimulator:
    """Multi-material, multi-plant inventory simulator.

    Creates one InventorySimulator per (material, plant) pair and one
    ChaosEngine per plant. Runs a daily loop that produces stock snapshots,
    purchase orders, and daily logs.
    """

    def __init__(
        self,
        master_data: Dict[str, Any],
        demand_data: Dict[Tuple[str, str], pd.DataFrame],
        seed: int = 42,
        chaos_intensity: str = "medium",
    ):
        self._master = master_data
        self._demand = demand_data
        self._seed = seed
        self._chaos_intensity = chaos_intensity

        # Build lookup dicts
        self._mat_by_code: Dict[str, MaterialMaster] = {
            m.material_code: m for m in master_data["materials"]
        }
        self._sup_by_id: Dict[str, SupplierMaster] = {
            s.supplier_id: s for s in master_data["suppliers"]
        }

        # Per (material, plant) simulators
        self._sims: Dict[Tuple[str, str], InventorySimulator] = {}
        # Per plant chaos engine
        self._chaos: Dict[str, ChaosEngine] = {}

        self._init_simulators()

    def inject_supply_events(self, events: list):
        """Inject external ChaosEvents (from ScenarioEngine) into all plant ChaosEngines.

        These events affect lead_time, defect_rate, etc. during simulation
        via ChaosEngine._active_events / event_log.
        """
        for event in events:
            # Inject into all plants (supply disruptions affect the whole network)
            for plant_id, chaos in self._chaos.items():
                chaos.event_log.append(event)
                chaos._active_events.append(event)

    def _init_simulators(self):
        """Create InventorySimulator per (mat, plant) and ChaosEngine per plant."""
        plants: List[PlantMaster] = self._master["plants"]
        suppliers: List[SupplierMaster] = self._master["suppliers"]

        # Map plant → its primary supplier (first supplier whose materials overlap)
        plant_supplier: Dict[str, SupplierMaster] = {}
        for plant in plants:
            for sup in suppliers:
                if any(mc in sup.materials for mc in plant.materials):
                    plant_supplier[plant.plant_id] = sup
                    break

        for plant in plants:
            # Create ChaosEngine for this plant
            sup = plant_supplier.get(plant.plant_id)
            supplier_profile = SupplierProfile(
                name=sup.name if sup else "default",
                base_lead_time=sup.base_lead_time if sup else 7,
                lead_time_std=sup.lead_time_std if sup else 2.0,
                reliability=sup.reliability if sup else 0.95,
                defect_rate=sup.defect_rate if sup else 0.02,
                capacity_per_day=sup.capacity_per_day if sup else 500.0,
            )
            plant_seed = self._seed + hash(plant.plant_id) % 10000
            self._chaos[plant.plant_id] = ChaosEngine(
                seed=plant_seed,
                intensity=self._chaos_intensity,
                supplier=supplier_profile,
            )

        # Create InventorySimulator for each (material, plant) with demand data
        for (mat_code, plant_id) in self._demand.keys():
            mat = self._mat_by_code.get(mat_code)
            if mat is None:
                continue

            config = InventoryConfig(
                initial_inventory=mat.base_demand * 5,  # ~5 days of stock
                reorder_point=mat.reorder_point if mat.reorder_point > 0 else mat.base_demand * mat.lead_time_days * 0.8,
                safety_stock_factor=mat.safety_stock_days / max(mat.lead_time_days, 1),
                order_quantity_days=14.0,
                max_order_quantity=mat.base_demand * 30,
                min_order_quantity=mat.moq,
                holding_cost_per_unit_day=mat.holding_cost_per_day,
                stockout_penalty_per_unit=mat.unit_cost * 1.5,
                ordering_cost_per_order=100.0,
                unit_cost=mat.unit_cost,
            )
            self._sims[(mat_code, plant_id)] = InventorySimulator(config)

    def run(self, days: Optional[int] = None) -> Dict[str, Any]:
        """Run full inventory simulation.

        Args:
            days: Override number of days. If None, uses length of demand data.

        Returns:
            {
                "stock_snapshots": List[Dict],   # matches material_stock_snapshots shape
                "purchase_orders": List[Dict],
                "daily_log": Dict[(mat, plant), List[DailyRecord]],
                "summary": Dict with aggregate stats,
            }
        """
        if not self._demand:
            return {"stock_snapshots": [], "purchase_orders": [], "goods_receipts": [],
                    "quality_incidents": [], "daily_log": {}, "summary": {}}

        # Determine simulation length
        first_df = next(iter(self._demand.values()))
        n_days = days if days is not None else len(first_df)

        rng = np.random.RandomState(self._seed + 999)

        stock_snapshots: List[Dict] = []
        all_purchase_orders: List[Dict] = []
        all_goods_receipts: List[Dict] = []
        all_quality_incidents: List[Dict] = []
        daily_logs: Dict[Tuple[str, str], List[DailyRecord]] = {k: [] for k in self._sims}

        # Track open POs for goods receipt generation
        open_pos: List[Dict] = []  # POs awaiting receipt
        po_counter = 0

        for day in range(n_days):
            date_str = None
            for (mat_code, plant_id), sim in self._sims.items():
                df = self._demand.get((mat_code, plant_id))
                if df is None or day >= len(df):
                    continue

                row = df.iloc[day]
                date_str = str(row["date"].date()) if hasattr(row["date"], "date") else str(row["date"])
                actual_demand = float(row["demand"])

                # Get chaos effects for this plant
                chaos = self._chaos[plant_id]
                current_state = {
                    "inventory": sim.state.inventory,
                    "daily_demand_avg": sim._avg_daily_demand(),
                }
                events = chaos.generate_daily_chaos(day, date_str, current_state)
                lead_time = chaos.get_effective_lead_time(day)
                defect_rate = chaos.get_defect_rate(day)

                # Apply demand multiplier from chaos (demand_spike events)
                demand_mult = chaos.get_demand_multiplier(day)
                effective_demand = actual_demand * demand_mult

                # Step the inventory simulator
                record = sim.step(
                    day=day,
                    date_str=date_str,
                    actual_demand=effective_demand,
                    forecast_demand=actual_demand,  # use base demand as naive forecast
                    lead_time=lead_time,
                    defect_rate=defect_rate,
                    chaos_events=[{"type": e.event_type, "severity": e.severity, "desc": e.description} for e in events],
                )
                daily_logs[(mat_code, plant_id)].append(record)

                # Build stock snapshot (matching material_stock_snapshots table shape)
                mat = self._mat_by_code.get(mat_code)
                stock_snapshots.append({
                    "material_code": mat_code,
                    "plant_id": plant_id,
                    "qty": round(record.inventory_after, 1),
                    "uom": mat.uom if mat else "PCS",
                    "snapshot_at": date_str,
                    "stock_type": "unrestricted",
                    "source": "synthetic_erp",
                })

                # Collect POs placed this day
                for po_info in record.orders_placed:
                    po_counter += 1
                    po_id = f"PO-{po_counter:05d}"
                    expected_receipt = self._day_to_date(first_df, po_info["eta"])
                    all_purchase_orders.append({
                        "po_id": po_id,
                        "material_code": mat_code,
                        "plant_id": plant_id,
                        "order_date": date_str,
                        "ordered_qty": po_info["qty"],
                        "expected_receipt_date": expected_receipt,
                        "status": "in_transit",
                        "unit_cost": mat.unit_cost if mat else 10.0,
                    })
                    open_pos.append({
                        "po_id": po_id,
                        "material_code": mat_code,
                        "plant_id": plant_id,
                        "ordered_qty": po_info["qty"],
                        "eta_day": po_info["eta"],
                        "expected_receipt_date": expected_receipt,
                        "unit_cost": mat.unit_cost if mat else 10.0,
                        "defect_rate_at_order": defect_rate,
                    })

                # Generate quality incidents from chaos events
                for evt in events:
                    if evt.event_type == "quality_issue":
                        sev = evt.severity
                        impact_pct = evt.impact.get("defect_rate_add", 0.05)
                        affected_qty = round(record.inventory_after * impact_pct, 1) if record.inventory_after > 0 else 0
                        all_quality_incidents.append({
                            "incident_id": f"QI-{len(all_quality_incidents)+1:05d}",
                            "material_code": mat_code,
                            "plant_id": plant_id,
                            "incident_date": date_str,
                            "severity": sev,
                            "type": "incoming_inspection",
                            "defect_rate": round(impact_pct, 4),
                            "affected_qty": affected_qty,
                            "description": evt.description,
                            "status": "open" if sev in ("high", "critical") else "resolved",
                        })

            # Process goods receipts: POs that have reached their ETA
            if date_str:
                still_open = []
                for po in open_pos:
                    if po["eta_day"] <= day:
                        # Generate goods receipt
                        defect = po["defect_rate_at_order"]
                        received_qty = po["ordered_qty"]
                        rejected_qty = round(received_qty * defect * rng.uniform(0.5, 1.5), 1)
                        rejected_qty = min(rejected_qty, received_qty)
                        accepted_qty = round(received_qty - rejected_qty, 1)

                        all_goods_receipts.append({
                            "gr_id": f"GR-{len(all_goods_receipts)+1:05d}",
                            "po_id": po["po_id"],
                            "material_code": po["material_code"],
                            "plant_id": po["plant_id"],
                            "receipt_date": date_str,
                            "received_qty": received_qty,
                            "accepted_qty": accepted_qty,
                            "rejected_qty": rejected_qty,
                            "unit_cost": po["unit_cost"],
                            "total_value": round(accepted_qty * po["unit_cost"], 2),
                            "status": "posted",
                        })

                        # Update PO status
                        for existing_po in all_purchase_orders:
                            if existing_po.get("po_id") == po["po_id"]:
                                existing_po["status"] = "received"
                                break
                    else:
                        still_open.append(po)
                open_pos = still_open

        # Build summary
        summary = self._build_summary(daily_logs)

        return {
            "stock_snapshots": stock_snapshots,
            "purchase_orders": all_purchase_orders,
            "goods_receipts": all_goods_receipts,
            "quality_incidents": all_quality_incidents,
            "daily_log": daily_logs,
            "summary": summary,
        }

    def _build_summary(self, daily_logs: Dict[Tuple[str, str], List[DailyRecord]]) -> Dict:
        """Aggregate summary across all (material, plant) pairs."""
        total_demand = 0.0
        total_fulfilled = 0.0
        total_stockout = 0.0
        total_holding_cost = 0.0
        total_stockout_cost = 0.0
        stockout_days = 0

        for key, sim in self._sims.items():
            state = sim.state
            total_demand += state.total_demand
            total_fulfilled += state.total_fulfilled
            total_stockout += state.total_stockout
            total_holding_cost += state.total_holding_cost
            total_stockout_cost += state.total_stockout_cost

            for record in daily_logs.get(key, []):
                if record.stockout_qty > 0:
                    stockout_days += 1

        fill_rate = total_fulfilled / total_demand if total_demand > 0 else 1.0

        return {
            "total_demand": round(total_demand, 1),
            "total_fulfilled": round(total_fulfilled, 1),
            "total_stockout": round(total_stockout, 1),
            "fill_rate": round(fill_rate, 4),
            "stockout_days": stockout_days,
            "total_holding_cost": round(total_holding_cost, 2),
            "total_stockout_cost": round(total_stockout_cost, 2),
            "n_material_plant_pairs": len(self._sims),
        }

    @staticmethod
    def _day_to_date(ref_df: pd.DataFrame, day_idx: int) -> str:
        """Convert day index to date string using the reference DataFrame."""
        if day_idx < len(ref_df):
            d = ref_df.iloc[day_idx]["date"]
            return str(d.date()) if hasattr(d, "date") else str(d)
        # Extrapolate beyond data range
        last = ref_df.iloc[-1]["date"]
        if hasattr(last, "date"):
            last = last.date()
        delta = day_idx - len(ref_df) + 1
        return str(last + timedelta(days=delta))
