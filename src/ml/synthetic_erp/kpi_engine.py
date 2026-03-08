"""
KPI Engine — Calculate supply chain KPIs from synthetic ERP simulation data.
=============================================================================
Produces metrics compatible with SimulationState.summary() shape.
KPI names: fill_rate, stockout_days, avg_inventory, inventory_turns,
           holding_cost, stockout_cost, total_cost.
"""
import numpy as np
from typing import Dict, List, Any, Tuple

from ml.simulation.inventory_sim import DailyRecord


class KPIEngine:
    """Calculate supply chain KPIs from inventory simulation output."""

    @staticmethod
    def compute(
        inventory_result: Dict[str, Any],
        demand_data: Dict[Tuple[str, str], Any],
        master_data: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Compute all KPIs.

        Args:
            inventory_result: Output from SyntheticInventorySimulator.run()
            demand_data: Demand DataFrames keyed by (material_code, plant_id)
            master_data: Master data dict from MasterDataBuilder.build()

        Returns:
            {
                "aggregate": {fill_rate, stockout_days, avg_inventory, ...},
                "by_material": {material_code: {fill_rate, ...}},
                "by_plant": {plant_id: {fill_rate, ...}},
                "time_series": [{day, date, fill_rate, inventory, cost}],
            }
        """
        daily_log = inventory_result.get("daily_log", {})

        # ── Aggregate ──
        aggregate = KPIEngine._compute_aggregate(daily_log)

        # ── By material ──
        by_material = KPIEngine._compute_by_dimension(daily_log, dim="material")

        # ── By plant ──
        by_plant = KPIEngine._compute_by_dimension(daily_log, dim="plant")

        # ── Time series (daily aggregate) ──
        time_series = KPIEngine._compute_time_series(daily_log)

        return {
            "aggregate": aggregate,
            "by_material": by_material,
            "by_plant": by_plant,
            "time_series": time_series,
        }

    @staticmethod
    def _compute_aggregate(daily_log: Dict[Tuple[str, str], List[DailyRecord]]) -> Dict[str, Any]:
        total_demand = 0.0
        total_fulfilled = 0.0
        total_stockout = 0.0
        total_holding_cost = 0.0
        total_stockout_cost = 0.0
        total_ordering_cost = 0.0
        inventory_values: List[float] = []
        stockout_days_set = set()
        order_count = 0

        for (mat, plant), records in daily_log.items():
            for r in records:
                total_demand += r.demand
                total_fulfilled += r.fulfilled
                total_stockout += r.stockout_qty
                total_holding_cost += r.costs.get("holding", 0)
                total_stockout_cost += r.costs.get("stockout", 0)
                inventory_values.append(r.inventory_after)
                if r.stockout_qty > 0:
                    stockout_days_set.add((mat, plant, r.day))
                order_count += len(r.orders_placed)

        fill_rate = total_fulfilled / total_demand if total_demand > 0 else 1.0
        avg_inv = float(np.mean(inventory_values)) if inventory_values else 0.0
        inv_turns = total_demand / avg_inv if avg_inv > 0 else 0.0
        total_cost = total_holding_cost + total_stockout_cost + total_ordering_cost

        return {
            "fill_rate": round(fill_rate, 4),
            "stockout_days": len(stockout_days_set),
            "avg_inventory": round(avg_inv, 1),
            "inventory_turns": round(inv_turns, 2),
            "holding_cost": round(total_holding_cost, 2),
            "stockout_cost": round(total_stockout_cost, 2),
            "total_cost": round(total_cost, 2),
            "order_count": order_count,
            "total_demand": round(total_demand, 1),
            "total_fulfilled": round(total_fulfilled, 1),
        }

    @staticmethod
    def _compute_by_dimension(
        daily_log: Dict[Tuple[str, str], List[DailyRecord]],
        dim: str,
    ) -> Dict[str, Dict[str, Any]]:
        """Compute KPIs grouped by 'material' or 'plant'."""
        groups: Dict[str, List[DailyRecord]] = {}

        for (mat, plant), records in daily_log.items():
            key = mat if dim == "material" else plant
            groups.setdefault(key, []).extend(records)

        result = {}
        for key, records in groups.items():
            demand = sum(r.demand for r in records)
            fulfilled = sum(r.fulfilled for r in records)
            stockout = sum(1 for r in records if r.stockout_qty > 0)
            holding = sum(r.costs.get("holding", 0) for r in records)
            stockout_cost = sum(r.costs.get("stockout", 0) for r in records)
            inv_values = [r.inventory_after for r in records]
            avg_inv = float(np.mean(inv_values)) if inv_values else 0.0

            result[key] = {
                "fill_rate": round(fulfilled / demand, 4) if demand > 0 else 1.0,
                "stockout_days": stockout,
                "avg_inventory": round(avg_inv, 1),
                "inventory_turns": round(demand / avg_inv, 2) if avg_inv > 0 else 0.0,
                "holding_cost": round(holding, 2),
                "stockout_cost": round(stockout_cost, 2),
                "total_cost": round(holding + stockout_cost, 2),
            }

        return result

    @staticmethod
    def _compute_time_series(
        daily_log: Dict[Tuple[str, str], List[DailyRecord]],
    ) -> List[Dict[str, Any]]:
        """Aggregate KPIs per day across all (material, plant) pairs."""
        # Group records by day
        by_day: Dict[int, List[DailyRecord]] = {}
        for records in daily_log.values():
            for r in records:
                by_day.setdefault(r.day, []).append(r)

        series = []
        cumulative_demand = 0.0
        cumulative_fulfilled = 0.0

        for day in sorted(by_day.keys()):
            records = by_day[day]
            day_demand = sum(r.demand for r in records)
            day_fulfilled = sum(r.fulfilled for r in records)
            day_inventory = sum(r.inventory_after for r in records)
            day_cost = sum(r.costs.get("holding", 0) + r.costs.get("stockout", 0) for r in records)

            cumulative_demand += day_demand
            cumulative_fulfilled += day_fulfilled
            cum_fill = cumulative_fulfilled / cumulative_demand if cumulative_demand > 0 else 1.0

            series.append({
                "day": day,
                "date": records[0].date,
                "demand": round(day_demand, 1),
                "fulfilled": round(day_fulfilled, 1),
                "inventory": round(day_inventory, 1),
                "cost": round(day_cost, 2),
                "fill_rate": round(cum_fill, 4),
            })

        return series
