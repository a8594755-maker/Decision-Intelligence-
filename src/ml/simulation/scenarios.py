"""
Week 1D: Predefined Scenarios — 預定義情境
============================================
Three canonical scenarios for stress testing:
  1. normal    — 平穩增長，低波動
  2. volatile  — 高季節性，頻繁衝擊
  3. disaster  — 頻繁斷貨，供應鏈崩潰壓力測試
"""
from .data_generator import DemandProfile
from .chaos_engine import SupplierProfile
from .inventory_sim import InventoryConfig
from dataclasses import dataclass
from typing import Dict, Optional


@dataclass
class ScenarioConfig:
    """一個完整的模擬情境"""
    name: str
    description: str
    demand_profile: DemandProfile
    supplier_profile: SupplierProfile
    inventory_config: InventoryConfig
    chaos_intensity: str       # calm | low | medium | high | extreme
    duration_days: int = 365
    start_date: str = "2024-01-01"


# ═══════════════════════════════════════
# 1. NORMAL — 平穩增長
# ═══════════════════════════════════════
SCENARIO_NORMAL = ScenarioConfig(
    name="normal",
    description="📊 平穩增長情境 — 低波動、可靠供應商、穩定需求",
    demand_profile=DemandProfile(
        name="normal",
        base_demand=100,
        trend_per_day=0.05,
        trend_type="linear",
        weekly_amplitude=10,
        monthly_amplitude=5,
        yearly_amplitude=15,
        noise_std=5,
        shock_probability=0.005,
        promo_interval_days=60,
        promo_lift=0.2,
    ),
    supplier_profile=SupplierProfile(
        name="reliable_supplier",
        base_lead_time=5,
        lead_time_std=1.0,
        reliability=0.98,
        defect_rate=0.01,
    ),
    inventory_config=InventoryConfig(
        initial_inventory=500,
        reorder_point=200,
        safety_stock_factor=1.2,
        order_quantity_days=14,
    ),
    chaos_intensity="low",
    duration_days=365,
)


# ═══════════════════════════════════════
# 2. VOLATILE — 高波動、季節性強
# ═══════════════════════════════════════
SCENARIO_VOLATILE = ScenarioConfig(
    name="volatile",
    description="🌊 高波動情境 — 強季節性、頻繁促銷、供應商不穩定",
    demand_profile=DemandProfile(
        name="volatile",
        base_demand=80,
        trend_per_day=0.1,
        trend_type="linear",
        weekly_amplitude=25,
        monthly_amplitude=15,
        yearly_amplitude=30,
        noise_std=12,
        noise_type="multiplicative",
        shock_probability=0.03,
        shock_magnitude_range=(0.3, 2.5),
        promo_interval_days=30,
        promo_duration_days=5,
        promo_lift=0.5,
    ),
    supplier_profile=SupplierProfile(
        name="unstable_supplier",
        base_lead_time=10,
        lead_time_std=4.0,
        reliability=0.85,
        defect_rate=0.05,
    ),
    inventory_config=InventoryConfig(
        initial_inventory=600,
        reorder_point=300,
        safety_stock_factor=2.0,
        order_quantity_days=21,
    ),
    chaos_intensity="high",
    duration_days=365,
)


# ═══════════════════════════════════════
# 3. DISASTER — 極端壓力測試
# ═══════════════════════════════════════
SCENARIO_DISASTER = ScenarioConfig(
    name="disaster",
    description="💀 災難情境 — 頻繁斷貨、港口罷工、需求暴增、品質危機",
    demand_profile=DemandProfile(
        name="disaster",
        base_demand=120,
        trend_per_day=0.2,
        trend_type="logistic",
        weekly_amplitude=30,
        monthly_amplitude=20,
        yearly_amplitude=40,
        noise_std=18,
        noise_type="multiplicative",
        shock_probability=0.08,
        shock_magnitude_range=(0.2, 3.5),
        shock_duration_range=(2, 10),
        promo_interval_days=20,
        promo_duration_days=4,
        promo_lift=0.6,
    ),
    supplier_profile=SupplierProfile(
        name="crisis_supplier",
        base_lead_time=14,
        lead_time_std=7.0,
        reliability=0.70,
        defect_rate=0.08,
    ),
    inventory_config=InventoryConfig(
        initial_inventory=800,
        reorder_point=500,
        safety_stock_factor=2.5,
        order_quantity_days=28,
        stockout_penalty_per_unit=25.0,
    ),
    chaos_intensity="extreme",
    duration_days=365,
)


# ═══════════════════════════════════════
# 4. SEASONAL — 年度大促 (雙11 / 黑五)
# ═══════════════════════════════════════
SCENARIO_SEASONAL = ScenarioConfig(
    name="seasonal",
    description="🎄 季節性大促情境 — Q4暴增、年中平淡、供應商年底吃緊",
    demand_profile=DemandProfile(
        name="seasonal",
        base_demand=90,
        trend_per_day=0.03,
        trend_type="linear",
        weekly_amplitude=12,
        monthly_amplitude=8,
        yearly_amplitude=45,   # 年度波動極大
        noise_std=7,
        shock_probability=0.015,
        promo_interval_days=90,
        promo_duration_days=7,
        promo_lift=0.8,        # 大促提升 80%
    ),
    supplier_profile=SupplierProfile(
        name="seasonal_supplier",
        base_lead_time=7,
        lead_time_std=3.0,
        reliability=0.90,
        defect_rate=0.03,
    ),
    inventory_config=InventoryConfig(
        initial_inventory=700,
        reorder_point=350,
        safety_stock_factor=1.8,
        order_quantity_days=21,
    ),
    chaos_intensity="medium",
    duration_days=365,
)


# ═══════════════════════════════════════
# Registry
# ═══════════════════════════════════════
SCENARIOS: Dict[str, ScenarioConfig] = {
    "normal": SCENARIO_NORMAL,
    "volatile": SCENARIO_VOLATILE,
    "disaster": SCENARIO_DISASTER,
    "seasonal": SCENARIO_SEASONAL,
}


def get_scenario(name: str) -> ScenarioConfig:
    if name not in SCENARIOS:
        raise ValueError(f"Unknown scenario: {name}. Available: {list(SCENARIOS.keys())}")
    return SCENARIOS[name]


def list_scenarios() -> list:
    return [
        {"name": s.name, "description": s.description, "chaos_intensity": s.chaos_intensity, "duration_days": s.duration_days}
        for s in SCENARIOS.values()
    ]
