"""
Decision-Intelligence Supply Chain Digital Twin — Self-Generating Sandbox
============================================================
Two AI agents compete:
  1. ChaosEngine (The Environment) — creates problems
  2. Decision-Intelligence Core (The Brain) — predicts, plans, reacts

The simulation loop accelerates time (1 tick = 1 day) and measures
whether the Brain can keep inventory healthy under chaos.
"""
from .data_generator import DataGenerator, DemandProfile
from .chaos_engine import ChaosEngine, ChaosEvent
from .inventory_sim import InventorySimulator, InventoryConfig, SimulationState
from .scenarios import SCENARIOS, get_scenario, list_scenarios
from .optimizer import ParameterOptimizer
from .orchestrator import SimulationOrchestrator
