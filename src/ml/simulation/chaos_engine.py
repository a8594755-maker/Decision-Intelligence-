"""
Week 1B: ChaosEngine — 混沌引擎（環境代理人）
==============================================
模擬供應鏈中的各種擾動：供應商延遲、港口罷工、品質問題等。
"""
import numpy as np
from dataclasses import dataclass, field
from typing import List, Optional, Dict
from datetime import date


@dataclass
class ChaosEvent:
    """一次混沌事件"""
    day: int
    date: str
    event_type: str          # supplier_delay | port_strike | quality_issue | demand_spike | raw_material_shortage
    severity: str            # low | medium | high | critical
    description: str
    impact: Dict             # 具體影響參數
    duration_days: int = 1
    resolved: bool = False


@dataclass
class SupplierProfile:
    """供應商特性"""
    name: str = "default_supplier"
    base_lead_time: int = 7           # 基礎交期（天）
    lead_time_std: float = 2.0        # 交期標準差
    reliability: float = 0.95         # 準時率
    defect_rate: float = 0.02         # 瑕疵率
    capacity_per_day: float = 500.0   # 日產能上限


class ChaosEngine:
    """
    混沌引擎 — The Environment Agent
    =================================
    每個模擬日，它決定是否製造問題、製造什麼問題。

    Usage:
        chaos = ChaosEngine(seed=42, intensity="medium")
        events = chaos.generate_daily_chaos(day=100, current_state={...})
    """

    # 事件定義表
    EVENT_CATALOG = {
        "supplier_delay": {
            "prob_base": 0.08,
            "severity_weights": [0.5, 0.3, 0.15, 0.05],
            "descriptions": {
                "low": "📦 供應商小幅延遲 (1-2天)",
                "medium": "🚚 供應商交期延長 (3-5天)",
                "high": "⚠️ 供應商重大延遲 (1-2週)",
                "critical": "🚨 供應商停產 — 交期不確定",
            },
        },
        "port_strike": {
            "prob_base": 0.005,
            "severity_weights": [0.2, 0.3, 0.3, 0.2],
            "descriptions": {
                "low": "🚢 港口輕微壅塞 (1天延遲)",
                "medium": "⚓ 港口罷工 — 3-5天延遲",
                "high": "🚧 港口嚴重罷工 — 7-14天延遲",
                "critical": "⛔ 港口全面封鎖 — 30天+延遲",
            },
        },
        "quality_issue": {
            "prob_base": 0.03,
            "severity_weights": [0.4, 0.35, 0.2, 0.05],
            "descriptions": {
                "low": "🔍 小批次品質異常 (5%退貨)",
                "medium": "⚠️ 品質問題 (20%退貨)",
                "high": "🚫 嚴重品質瑕疵 (50%退貨)",
                "critical": "💀 全批次召回",
            },
        },
        "demand_spike": {
            "prob_base": 0.02,
            "severity_weights": [0.3, 0.4, 0.2, 0.1],
            "descriptions": {
                "low": "📈 需求小幅上升 (+20%)",
                "medium": "🔥 社群討論熱度上升 (+50%)",
                "high": "💥 KOL爆款推薦 (+100%)",
                "critical": "🌊 病毒式傳播 (+200%)",
            },
        },
        "raw_material_shortage": {
            "prob_base": 0.01,
            "severity_weights": [0.3, 0.35, 0.25, 0.1],
            "descriptions": {
                "low": "🏭 原料小幅漲價 (+10%成本)",
                "medium": "📊 原料短缺 — 交期+5天",
                "high": "⚠️ 原料嚴重短缺 — 交期+14天",
                "critical": "🚨 原料斷供 — 無法生產",
            },
        },
    }

    INTENSITY_MULTIPLIERS = {
        "calm": 0.3,
        "low": 0.6,
        "medium": 1.0,
        "high": 1.8,
        "extreme": 3.0,
    }

    SEVERITY_LEVELS = ["low", "medium", "high", "critical"]

    def __init__(self, seed: Optional[int] = None, intensity: str = "medium",
                 supplier: Optional[SupplierProfile] = None):
        self.seed = seed
        self._rng = np.random.RandomState(seed)
        self.intensity = intensity
        self.multiplier = self.INTENSITY_MULTIPLIERS.get(intensity, 1.0)
        self.supplier = supplier or SupplierProfile()
        self.event_log: List[ChaosEvent] = []
        self._active_events: List[ChaosEvent] = []

    def generate_daily_chaos(self, day: int, date_str: str,
                             current_state: Optional[Dict] = None) -> List[ChaosEvent]:
        """每日混沌生成：根據當前狀態決定產生哪些事件"""
        events = []

        for event_type, config in self.EVENT_CATALOG.items():
            prob = config["prob_base"] * self.multiplier

            # Context-sensitive: 庫存低時更容易出問題（墨菲定律）
            if current_state:
                inv = current_state.get("inventory", 0)
                capacity = current_state.get("daily_demand_avg", 100)
                days_of_stock = inv / max(capacity, 1)
                if days_of_stock < 7:
                    prob *= 1.5  # 庫存低時壓力大

            if self._rng.random() < prob:
                severity = self._pick_severity(config["severity_weights"])
                impact = self._calculate_impact(event_type, severity)
                duration = impact.pop("duration", 1)

                event = ChaosEvent(
                    day=day,
                    date=date_str,
                    event_type=event_type,
                    severity=severity,
                    description=config["descriptions"][severity],
                    impact=impact,
                    duration_days=duration,
                )
                events.append(event)
                self.event_log.append(event)
                self._active_events.append(event)

        # Resolve expired events
        self._active_events = [
            e for e in self._active_events
            if day < e.day + e.duration_days
        ]

        return events

    def get_effective_lead_time(self, day: int) -> int:
        """計算當前有效交期（考慮所有活躍事件）"""
        base = self.supplier.base_lead_time
        jitter = max(0, int(self._rng.normal(0, self.supplier.lead_time_std)))
        delay = 0

        for e in self._active_events:
            if day < e.day + e.duration_days:
                delay += e.impact.get("lead_time_add", 0)

        return base + jitter + delay

    def get_defect_rate(self, day: int) -> float:
        """計算當前瑕疵率"""
        base = self.supplier.defect_rate
        for e in self._active_events:
            if e.event_type == "quality_issue" and day < e.day + e.duration_days:
                base += e.impact.get("defect_rate_add", 0)
        return min(base, 1.0)

    def get_demand_multiplier(self, day: int) -> float:
        """計算需求乘數（來自 demand_spike 事件）"""
        mult = 1.0
        for e in self._active_events:
            if e.event_type == "demand_spike" and day < e.day + e.duration_days:
                mult *= e.impact.get("demand_multiplier", 1.0)
        return mult

    def get_summary(self) -> Dict:
        """回傳混沌引擎摘要"""
        by_type = {}
        for e in self.event_log:
            by_type.setdefault(e.event_type, []).append(e)
        return {
            "intensity": self.intensity,
            "total_events": len(self.event_log),
            "by_type": {k: len(v) for k, v in by_type.items()},
            "critical_events": sum(1 for e in self.event_log if e.severity == "critical"),
            "active_events": len(self._active_events),
        }

    # ─── Internal ───

    def _pick_severity(self, weights: List[float]) -> str:
        return self._rng.choice(self.SEVERITY_LEVELS, p=weights)

    def _calculate_impact(self, event_type: str, severity: str) -> Dict:
        severity_idx = self.SEVERITY_LEVELS.index(severity)
        if event_type == "supplier_delay":
            delays = [2, 5, 12, 30]
            return {"lead_time_add": delays[severity_idx], "duration": [2, 5, 10, 21][severity_idx]}
        elif event_type == "port_strike":
            delays = [1, 4, 10, 30]
            return {"lead_time_add": delays[severity_idx], "duration": [1, 4, 10, 30][severity_idx]}
        elif event_type == "quality_issue":
            rates = [0.05, 0.20, 0.50, 1.0]
            return {"defect_rate_add": rates[severity_idx], "inventory_loss_pct": rates[severity_idx], "duration": [1, 2, 3, 5][severity_idx]}
        elif event_type == "demand_spike":
            mults = [1.2, 1.5, 2.0, 3.0]
            return {"demand_multiplier": mults[severity_idx], "duration": [2, 4, 7, 14][severity_idx]}
        elif event_type == "raw_material_shortage":
            delays = [2, 5, 14, 45]
            costs = [1.1, 1.25, 1.5, 2.0]
            return {"lead_time_add": delays[severity_idx], "cost_multiplier": costs[severity_idx], "duration": [3, 7, 14, 30][severity_idx]}
        return {"duration": 1}
