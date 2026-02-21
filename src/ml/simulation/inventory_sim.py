"""
Week 1C: InventorySimulator — 庫存模擬引擎
============================================
Day-by-day supply chain loop:
  Day T:   ChaosEngine generates demand → deplete inventory → check stockout
  Day T+1: Decision-Intelligence forecasts → calculates risk → decides PO (purchase order)
  Day T+L: Supplier delivers (with possible delays) → inventory replenished
"""
import numpy as np
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Tuple
from datetime import date, timedelta


@dataclass
class InventoryConfig:
    """庫存策略參數（可由 Optimizer 自動調整）"""
    initial_inventory: float = 500.0
    reorder_point: float = 200.0          # 當庫存 < ROP 時觸發補貨
    safety_stock_factor: float = 1.5      # 安全庫存 = factor * avg_daily * lead_time
    order_quantity_days: float = 14.0     # 訂購量 = 未來 N 天預測需求
    max_order_quantity: float = 2000.0    # 單次最大訂購量
    min_order_quantity: float = 50.0      # 最小訂購量（MOQ）

    # 成本參數
    holding_cost_per_unit_day: float = 0.5     # 持有成本 / 單位 / 天
    stockout_penalty_per_unit: float = 15.0    # 缺貨罰款 / 單位
    ordering_cost_per_order: float = 100.0     # 每次下單固定成本
    unit_cost: float = 10.0                    # 採購單價


@dataclass
class PurchaseOrder:
    """一筆採購訂單"""
    order_day: int
    quantity: float
    expected_arrival_day: int
    actual_arrival_day: Optional[int] = None
    received_quantity: Optional[float] = None
    status: str = "in_transit"   # in_transit | delivered | partial


@dataclass
class DailyRecord:
    """每日模擬紀錄"""
    day: int
    date: str
    demand: float
    fulfilled: float
    stockout_qty: float
    inventory_before: float
    inventory_after: float
    orders_placed: List[Dict] = field(default_factory=list)
    orders_received: List[Dict] = field(default_factory=list)
    chaos_events: List[Dict] = field(default_factory=list)
    costs: Dict = field(default_factory=dict)
    forecast_used: Optional[float] = None
    risk_score: Optional[float] = None


@dataclass
class SimulationState:
    """模擬器的即時狀態"""
    day: int = 0
    inventory: float = 0.0
    total_demand: float = 0.0
    total_fulfilled: float = 0.0
    total_stockout: float = 0.0
    total_holding_cost: float = 0.0
    total_stockout_cost: float = 0.0
    total_ordering_cost: float = 0.0
    total_purchase_cost: float = 0.0
    orders_in_transit: List[PurchaseOrder] = field(default_factory=list)
    daily_log: List[DailyRecord] = field(default_factory=list)

    @property
    def total_cost(self) -> float:
        return (self.total_holding_cost + self.total_stockout_cost +
                self.total_ordering_cost + self.total_purchase_cost)

    @property
    def fill_rate(self) -> float:
        if self.total_demand == 0:
            return 1.0
        return self.total_fulfilled / self.total_demand

    @property
    def stockout_rate(self) -> float:
        return 1.0 - self.fill_rate

    @property
    def avg_inventory(self) -> float:
        if not self.daily_log:
            return 0.0
        return float(np.mean([r.inventory_after for r in self.daily_log]))

    def summary(self) -> Dict:
        return {
            "days_simulated": self.day,
            "total_demand": round(self.total_demand, 1),
            "total_fulfilled": round(self.total_fulfilled, 1),
            "total_stockout": round(self.total_stockout, 1),
            "fill_rate": round(self.fill_rate * 100, 2),
            "stockout_rate": round(self.stockout_rate * 100, 2),
            "avg_inventory": round(self.avg_inventory, 1),
            "costs": {
                "holding": round(self.total_holding_cost, 2),
                "stockout_penalty": round(self.total_stockout_cost, 2),
                "ordering": round(self.total_ordering_cost, 2),
                "purchase": round(self.total_purchase_cost, 2),
                "total": round(self.total_cost, 2),
            },
            "orders_in_transit": len(self.orders_in_transit),
        }


class InventorySimulator:
    """
    庫存模擬器 — The Supply Chain Body
    ====================================
    管理庫存水準、接收訂單、計算成本。

    Usage:
        config = InventoryConfig(initial_inventory=500, reorder_point=200)
        sim = InventorySimulator(config)
        sim.step(day=1, date_str="2024-01-01", actual_demand=80,
                 forecast_demand=75, lead_time=7, defect_rate=0.02)
    """

    def __init__(self, config: Optional[InventoryConfig] = None):
        self.config = config or InventoryConfig()
        self.state = SimulationState(inventory=self.config.initial_inventory)
        self._demand_history: List[float] = []

    def step(
        self,
        day: int,
        date_str: str,
        actual_demand: float,
        forecast_demand: Optional[float] = None,
        lead_time: int = 7,
        defect_rate: float = 0.0,
        chaos_events: Optional[List[Dict]] = None,
        risk_score: Optional[float] = None,
    ) -> DailyRecord:
        """
        執行一天的模擬步驟。

        Flow:
        1. Receive pending deliveries
        2. Deplete inventory by demand
        3. Calculate costs
        4. Decide whether to place new PO
        """
        self.state.day = day
        self._demand_history.append(actual_demand)
        inv_before = self.state.inventory

        # ── 1. Receive deliveries ──
        received_orders = self._receive_deliveries(day, defect_rate)

        # ── 2. Deplete inventory ──
        fulfilled = min(self.state.inventory, actual_demand)
        stockout_qty = max(0, actual_demand - self.state.inventory)
        self.state.inventory = max(0, self.state.inventory - actual_demand)

        # Update totals
        self.state.total_demand += actual_demand
        self.state.total_fulfilled += fulfilled
        self.state.total_stockout += stockout_qty

        # ── 3. Calculate costs ──
        holding_cost = self.state.inventory * self.config.holding_cost_per_unit_day
        stockout_cost = stockout_qty * self.config.stockout_penalty_per_unit
        self.state.total_holding_cost += holding_cost
        self.state.total_stockout_cost += stockout_cost

        # ── 4. Reorder decision ──
        new_orders = self._reorder_decision(day, forecast_demand, lead_time)

        # ── Build record ──
        record = DailyRecord(
            day=day,
            date=date_str,
            demand=actual_demand,
            fulfilled=fulfilled,
            stockout_qty=stockout_qty,
            inventory_before=inv_before,
            inventory_after=self.state.inventory,
            orders_placed=[{"qty": o.quantity, "eta": o.expected_arrival_day} for o in new_orders],
            orders_received=[{"qty": o.received_quantity, "order_day": o.order_day} for o in received_orders],
            chaos_events=chaos_events or [],
            costs={"holding": round(holding_cost, 2), "stockout": round(stockout_cost, 2)},
            forecast_used=forecast_demand,
            risk_score=risk_score,
        )
        self.state.daily_log.append(record)
        return record

    def _receive_deliveries(self, day: int, defect_rate: float) -> List[PurchaseOrder]:
        """接收到貨的訂單"""
        received = []
        still_in_transit = []

        for po in self.state.orders_in_transit:
            arrival = po.actual_arrival_day or po.expected_arrival_day
            if day >= arrival:
                # Apply defect rate
                good_qty = po.quantity * (1 - defect_rate)
                po.received_quantity = round(good_qty, 1)
                po.status = "delivered" if defect_rate < 0.01 else "partial"
                self.state.inventory += po.received_quantity
                received.append(po)
            else:
                still_in_transit.append(po)

        self.state.orders_in_transit = still_in_transit
        return received

    def _reorder_decision(self, day: int, forecast_demand: Optional[float],
                          lead_time: int) -> List[PurchaseOrder]:
        """補貨決策邏輯"""
        # Calculate dynamic reorder point
        avg_demand = self._avg_daily_demand()
        safety_stock = self.config.safety_stock_factor * avg_demand * lead_time
        dynamic_rop = avg_demand * lead_time + safety_stock

        # Use configured ROP or dynamic, whichever is higher
        effective_rop = max(self.config.reorder_point, dynamic_rop)

        # Pipeline inventory (what's already on order)
        pipeline = sum(po.quantity for po in self.state.orders_in_transit)

        # Inventory position = on-hand + pipeline
        inventory_position = self.state.inventory + pipeline

        if inventory_position >= effective_rop:
            return []

        # Calculate order quantity
        if forecast_demand is not None:
            target_days = self.config.order_quantity_days
            order_qty = forecast_demand * target_days - inventory_position
        else:
            order_qty = avg_demand * self.config.order_quantity_days - inventory_position

        order_qty = max(self.config.min_order_quantity,
                        min(order_qty, self.config.max_order_quantity))
        order_qty = round(order_qty, 0)

        if order_qty <= 0:
            return []

        po = PurchaseOrder(
            order_day=day,
            quantity=order_qty,
            expected_arrival_day=day + lead_time,
        )
        self.state.orders_in_transit.append(po)
        self.state.total_ordering_cost += self.config.ordering_cost_per_order
        self.state.total_purchase_cost += order_qty * self.config.unit_cost

        return [po]

    def _avg_daily_demand(self) -> float:
        """近 30 天平均日需求"""
        recent = self._demand_history[-30:] if len(self._demand_history) >= 30 else self._demand_history
        return float(np.mean(recent)) if recent else 50.0

    def reset(self):
        """重置模擬器"""
        self.state = SimulationState(inventory=self.config.initial_inventory)
        self._demand_history = []
