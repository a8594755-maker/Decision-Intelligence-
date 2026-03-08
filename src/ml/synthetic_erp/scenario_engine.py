"""
Scenario Engine — Inject disruptions into synthetic ERP datasets.
==================================================================
Key design: demand-side vs supply-side disruptions are handled separately.

  demand-side  (demand_spike, demand_crash)  → modifies demand_data
  supply-side  (supplier_delay, quality_issue, plant_shutdown) → produces
               ChaosEvent list for inventory simulation (lead time / defect / capacity)

This prevents supply problems from being mis-modeled as demand problems.
"""
import numpy as np
import pandas as pd
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional, Tuple

from ml.simulation.chaos_engine import ChaosEvent


@dataclass
class DisruptionSpec:
    """One disruption to inject."""
    name: str                                      # demand_spike | demand_crash | supplier_delay | quality_issue | plant_shutdown
    target_material: Optional[str] = None          # None = all FG materials
    target_plant: Optional[str] = None             # None = all plants
    start_day: int = 60
    duration_days: int = 14
    severity: str = "medium"                       # low | medium | high | critical
    params: Dict[str, Any] = field(default_factory=dict)


# ── Severity → impact mappings ──
_DEMAND_SPIKE_MULTIPLIERS = {"low": 1.3, "medium": 1.6, "high": 2.0, "critical": 3.0}
_DEMAND_CRASH_MULTIPLIERS = {"low": 0.8, "medium": 0.6, "high": 0.4, "critical": 0.15}
_SUPPLIER_DELAY_DAYS      = {"low": 3, "medium": 7, "high": 14, "critical": 30}
_QUALITY_DEFECT_RATES     = {"low": 0.05, "medium": 0.20, "high": 0.50, "critical": 1.0}
_PLANT_CAPACITY_FACTORS   = {"low": 0.8, "medium": 0.5, "high": 0.2, "critical": 0.0}

# ── Which disruptions are demand-side vs supply-side ──
DEMAND_SIDE = {"demand_spike", "demand_crash"}
SUPPLY_SIDE = {"supplier_delay", "quality_issue", "plant_shutdown"}


class ScenarioEngine:
    """Inject disruptions into synthetic ERP datasets.

    Separates demand-side mutations from supply-side events:
    - apply_demand() modifies demand DataFrames
    - to_supply_events() produces ChaosEvent list for inventory simulation
    """

    # ── Predefined scenario templates ──
    TEMPLATES: Dict[str, List[DisruptionSpec]] = {
        "baseline": [],
        "single_spike": [
            DisruptionSpec("demand_spike", severity="high", start_day=90, duration_days=14),
        ],
        "supplier_crisis": [
            DisruptionSpec("supplier_delay", severity="critical", start_day=60, duration_days=30),
        ],
        "quality_recall": [
            DisruptionSpec("quality_issue", severity="high", start_day=45, duration_days=21),
        ],
        "multi_disruption": [
            DisruptionSpec("demand_spike", severity="medium", start_day=60, duration_days=10),
            DisruptionSpec("supplier_delay", severity="high", start_day=100, duration_days=21),
            DisruptionSpec("quality_issue", severity="medium", start_day=150, duration_days=14),
        ],
        "plant_emergency": [
            DisruptionSpec("plant_shutdown", severity="critical", start_day=80, duration_days=7),
            DisruptionSpec("demand_spike", severity="medium", start_day=80, duration_days=7),
        ],
    }

    def __init__(self, seed: int = 42):
        self._seed = seed
        self._rng = np.random.RandomState(seed)

    def apply_demand(
        self,
        disruptions: List[DisruptionSpec],
        demand_data: Dict[Tuple[str, str], pd.DataFrame],
    ) -> Dict[Tuple[str, str], pd.DataFrame]:
        """Apply demand-side disruptions. Returns modified copy of demand data.

        Only processes disruptions in DEMAND_SIDE set.
        Supply-side disruptions are ignored here (use to_supply_events instead).
        """
        demand_side = [d for d in disruptions if d.name in DEMAND_SIDE]
        if not demand_side:
            return demand_data  # no demand mutations needed

        # Deep copy DataFrames
        modified: Dict[Tuple[str, str], pd.DataFrame] = {
            k: df.copy() for k, df in demand_data.items()
        }

        for spec in demand_side:
            for (mat_code, plant_id), df in modified.items():
                # Filter by target
                if spec.target_material and mat_code != spec.target_material:
                    continue
                if spec.target_plant and plant_id != spec.target_plant:
                    continue

                start = spec.start_day
                end = min(start + spec.duration_days, len(df))
                if start >= len(df):
                    continue

                if spec.name == "demand_spike":
                    mult = spec.params.get("multiplier", _DEMAND_SPIKE_MULTIPLIERS[spec.severity])
                    df.loc[start:end - 1, "demand"] = (df.loc[start:end - 1, "demand"] * mult).astype(int)
                    df.loc[start:end - 1, "shock_multiplier"] = mult

                elif spec.name == "demand_crash":
                    mult = spec.params.get("multiplier", _DEMAND_CRASH_MULTIPLIERS[spec.severity])
                    df.loc[start:end - 1, "demand"] = (df.loc[start:end - 1, "demand"] * mult).astype(int)
                    df.loc[start:end - 1, "shock_multiplier"] = mult

        return modified

    def to_supply_events(
        self,
        disruptions: List[DisruptionSpec],
    ) -> List[ChaosEvent]:
        """Convert supply-side DisruptionSpecs to ChaosEvent list.

        These events are injected into the ChaosEngine during inventory simulation
        to affect lead time, defect rate, and plant capacity — NOT demand.
        """
        supply_side = [d for d in disruptions if d.name in SUPPLY_SIDE]
        events: List[ChaosEvent] = []

        for spec in supply_side:
            for day in range(spec.start_day, spec.start_day + spec.duration_days):
                if spec.name == "supplier_delay":
                    delay = spec.params.get("delay_days", _SUPPLIER_DELAY_DAYS[spec.severity])
                    events.append(ChaosEvent(
                        day=day,
                        date="",  # filled during simulation
                        event_type="supplier_delay",
                        severity=spec.severity,
                        description=f"Scenario: supplier delay +{delay}d ({spec.severity})",
                        impact={"lead_time_add": delay},
                        duration_days=1,
                    ))

                elif spec.name == "quality_issue":
                    defect = spec.params.get("defect_rate", _QUALITY_DEFECT_RATES[spec.severity])
                    events.append(ChaosEvent(
                        day=day,
                        date="",
                        event_type="quality_issue",
                        severity=spec.severity,
                        description=f"Scenario: quality issue, defect rate +{defect:.0%} ({spec.severity})",
                        impact={"defect_rate_add": defect, "inventory_loss_pct": defect},
                        duration_days=1,
                    ))

                elif spec.name == "plant_shutdown":
                    cap_factor = spec.params.get("capacity_factor", _PLANT_CAPACITY_FACTORS[spec.severity])
                    # Plant shutdown modeled as massive supplier delay + quality issue
                    events.append(ChaosEvent(
                        day=day,
                        date="",
                        event_type="supplier_delay",
                        severity=spec.severity,
                        description=f"Scenario: plant shutdown, capacity at {cap_factor:.0%} ({spec.severity})",
                        impact={"lead_time_add": 14 if cap_factor < 0.5 else 5},
                        duration_days=1,
                    ))

        return events

    def describe(self, disruptions: List[DisruptionSpec]) -> List[Dict[str, Any]]:
        """Human-readable description of disruptions."""
        return [
            {
                "name": d.name,
                "side": "demand" if d.name in DEMAND_SIDE else "supply",
                "target_material": d.target_material or "all",
                "target_plant": d.target_plant or "all",
                "start_day": d.start_day,
                "duration_days": d.duration_days,
                "severity": d.severity,
            }
            for d in disruptions
        ]

    @classmethod
    def get_template(cls, name: str) -> List[DisruptionSpec]:
        if name not in cls.TEMPLATES:
            raise ValueError(f"Unknown scenario template: {name}. Available: {list(cls.TEMPLATES.keys())}")
        return cls.TEMPLATES[name]

    @classmethod
    def list_templates(cls) -> List[str]:
        return list(cls.TEMPLATES.keys())
