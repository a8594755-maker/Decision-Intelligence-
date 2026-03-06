"""Conditional imports and availability checks for all solver backends.

Usage:
    from ml.api.solver_availability import gurobi_available, cplex_available
    if gurobi_available():
        from ml.api.replenishment_solver_gurobi import solve_replenishment_gurobi
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# ── OR-Tools CP-SAT ───────────────────────────────────────────────────────────
try:
    from ortools.sat.python import cp_model as _cp_model  # noqa: F401

    _ORTOOLS_OK = True
except ImportError:
    _cp_model = None
    _ORTOOLS_OK = False

# ── OR-Tools Linear Solver (pywraplp) ─────────────────────────────────────────
try:
    from ortools.linear_solver import pywraplp as _pywraplp  # noqa: F401

    _ORTOOLS_LINEAR_OK = True
except ImportError:
    _pywraplp = None
    _ORTOOLS_LINEAR_OK = False

# ── Gurobi ────────────────────────────────────────────────────────────────────
_GUROBI_OK = False
_GUROBI_VERSION: Optional[Tuple[int, int, int]] = None
_GUROBI_LICENSE_TYPE: Optional[str] = None

try:
    import gurobipy as _grb  # noqa: F401

    # Verify license is valid by creating a throwaway environment.
    _test_env = _grb.Env(empty=True)
    _test_env.setParam("OutputFlag", 0)
    _test_env.start()
    _test_env.dispose()
    del _test_env
    _GUROBI_OK = True
    _GUROBI_VERSION = _grb.gurobi.version()
except Exception:
    _grb = None  # type: ignore[assignment]

# ── CPLEX (via docplex) ───────────────────────────────────────────────────────
_CPLEX_OK = False
_CPLEX_VERSION: Optional[str] = None

try:
    from docplex.mp.model import Model as _CplexModel  # noqa: F401

    # Quick validation: create a trivial model.
    _test_mdl = _CplexModel(name="__availability_check__")
    _CPLEX_VERSION = _test_mdl.get_cplex().get_version() if hasattr(_test_mdl, "get_cplex") else "unknown"
    _test_mdl.end()
    del _test_mdl
    _CPLEX_OK = True
except Exception:
    _CplexModel = None  # type: ignore[assignment,misc]


# ── Public API ────────────────────────────────────────────────────────────────


def ortools_available() -> bool:
    """Return True if OR-Tools CP-SAT is importable."""
    return _ORTOOLS_OK


def ortools_linear_available() -> bool:
    """Return True if OR-Tools pywraplp (GLOP / LP) is importable."""
    return _ORTOOLS_LINEAR_OK


def gurobi_available() -> bool:
    """Return True if gurobipy is importable and a valid license is present."""
    return _GUROBI_OK


def cplex_available() -> bool:
    """Return True if docplex is importable and CPLEX engine is usable."""
    return _CPLEX_OK


def _detect_gurobi_license_type() -> Optional[str]:
    """Heuristic detection of Gurobi license type from environment."""
    if os.getenv("GRB_CLOUDACCESSID"):
        return "cloud"
    if os.getenv("GRB_CSMANAGER") or os.getenv("DI_GUROBI_COMPUTE_SERVER"):
        return "compute_server"
    if os.getenv("GRB_LICENSE_FILE"):
        return "file"
    return "local"


@dataclass(frozen=True)
class SolverBackendInfo:
    """Metadata about a solver backend for inventory/health checks."""

    name: str
    available: bool
    version: Optional[str]
    license_type: Optional[str]  # "open_source" | "local" | "cloud" | "compute_server" | "file"


def get_solver_inventory() -> Dict[str, SolverBackendInfo]:
    """Return availability info for all known solver backends."""
    return {
        "ortools": SolverBackendInfo(
            name="OR-Tools CP-SAT",
            available=_ORTOOLS_OK,
            version=None,
            license_type="open_source",
        ),
        "gurobi": SolverBackendInfo(
            name="Gurobi Optimizer",
            available=_GUROBI_OK,
            version=(
                f"{_GUROBI_VERSION[0]}.{_GUROBI_VERSION[1]}.{_GUROBI_VERSION[2]}"
                if _GUROBI_VERSION
                else None
            ),
            license_type=_detect_gurobi_license_type() if _GUROBI_OK else None,
        ),
        "cplex": SolverBackendInfo(
            name="IBM ILOG CPLEX",
            available=_CPLEX_OK,
            version=str(_CPLEX_VERSION) if _CPLEX_VERSION else None,
            license_type="local" if _CPLEX_OK else None,
        ),
    }
