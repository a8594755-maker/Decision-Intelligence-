"""
Shared constants, dataclasses and generic utility helpers for the
replenishment solver family (single-echelon, multi-echelon, analysis).

Extracted from replenishment_solver.py to keep modules under ~2 000 lines.
"""
from __future__ import annotations

import copy
import math
import os
from dataclasses import dataclass
from types import SimpleNamespace
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple

from ml.api.planning_contract import PlanningStatus

# ── scaling constants ──────────────────────────────────────────────────────────
# All float quantities are multiplied by SCALE and rounded to integers for CP-SAT.
# 1 real unit = SCALE integer units  →  precision = 1/SCALE = 0.001 real units.
SCALE: int = 1_000

# Objective coefficients are also scaled (penalties may be floats like 2.5).
# true_cost ≈ integer_objective / (OBJ_SCALE * SCALE)
OBJ_SCALE: int = 1_000

MAX_SOLVER_SECONDS: float = 30.0
DIAGNOSE_SOLVER_SECONDS: float = 3.0
DEFAULT_SOLVER_RANDOM_SEED: int = int(os.getenv("DI_CP_SAT_RANDOM_SEED", "42"))
DEFAULT_SOLVER_NUM_SEARCH_WORKERS: int = max(1, int(os.getenv("DI_CP_SAT_NUM_SEARCH_WORKERS", "1")))
DEFAULT_SOLVER_LOG_PROGRESS: bool = str(os.getenv("DI_CP_SAT_LOG_PROGRESS", "false")).strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
DEFAULT_SOLVER_SINGLE_TIME_LIMIT_SECONDS: float = float(
    os.getenv("DI_CP_SAT_TIME_LIMIT_SECONDS", str(MAX_SOLVER_SECONDS))
)
DEFAULT_SOLVER_MULTI_TIME_LIMIT_SECONDS: float = float(
    os.getenv("DI_CP_SAT_MULTI_TIME_LIMIT_SECONDS", "25.0")
)


@dataclass(frozen=True)
class SolverRunSettings:
    """CP-SAT run policy: deterministic defaults with optional contract overrides."""

    time_limit_seconds: float
    random_seed: int
    num_search_workers: int
    log_search_progress: bool
    deterministic_mode: bool
    stop_after_first_solution: bool = False
    force_timeout: bool = False


@dataclass(frozen=True)
class SolverStatusInfo:
    status: PlanningStatus
    termination_reason: str
    status_name: str
    has_feasible_solution: bool
    time_limit_hit: bool


@dataclass(frozen=True)
class SupplierInfo:
    """V2: Per-supplier parameters for multi-supplier optimization."""
    supplier_id: str
    lead_time_days: int
    unit_cost: float
    moq_s: int        # scaled MOQ
    pack_s: int        # scaled pack size
    max_order_qty_s: int  # scaled max order qty
    fixed_order_cost: float


# ── generic utility functions ──────────────────────────────────────────────────

def _read_attr(obj: Any, name: str, default: Any = None) -> Any:
    """Read an attribute from object or dict with graceful fallback."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _as_list(value: Any) -> List[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


def _read_path(obj: Any, path: str, default: Any = None) -> Any:
    cur = obj
    for part in path.split("."):
        cur = _read_attr(cur, part, None)
        if cur is None:
            return default
    return cur


def _to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _payload_to_plain(obj: Any) -> Any:
    if obj is None:
        return None
    if hasattr(obj, "model_dump"):
        try:
            return obj.model_dump(mode="json")
        except TypeError:
            return obj.model_dump()
    if isinstance(obj, dict):
        return {k: _payload_to_plain(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_payload_to_plain(v) for v in obj]
    if isinstance(obj, tuple):
        return [_payload_to_plain(v) for v in obj]
    if hasattr(obj, "__dict__"):
        return {k: _payload_to_plain(v) for k, v in vars(obj).items()}
    return obj


def _plain_to_ns(obj: Any) -> Any:
    if isinstance(obj, dict):
        return SimpleNamespace(**{k: _plain_to_ns(v) for k, v in obj.items()})
    if isinstance(obj, list):
        return [_plain_to_ns(v) for v in obj]
    return obj


def _clone_payload(payload: Any) -> Any:
    if hasattr(payload, "model_copy"):
        try:
            return payload.model_copy(deep=True)
        except TypeError:
            pass
    return copy.deepcopy(payload)


def _set_path(obj: Any, path: str, value: Any) -> None:
    parts = path.split(".")
    cur = obj
    for part in parts[:-1]:
        nxt = _read_attr(cur, part, None)
        if nxt is None:
            nxt = {} if isinstance(cur, dict) else SimpleNamespace()
            if isinstance(cur, dict):
                cur[part] = nxt
            else:
                setattr(cur, part, nxt)
        cur = nxt
    last = parts[-1]
    if isinstance(cur, dict):
        cur[last] = value
    else:
        setattr(cur, last, value)


def _first_non_none(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def _as_dict(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    plain = _payload_to_plain(value)
    return plain if isinstance(plain, dict) else {}


# ── scaling + parsing helpers ──────────────────────────────────────────────────

def _s(v: float) -> int:
    """Scale a real float to an integer for CP-SAT (multiply by SCALE, round)."""
    return int(round(v * SCALE))


def _us(v: int) -> float:
    """Unscale a CP-SAT integer back to a real float."""
    return v / SCALE


def _parse_day(value: Any) -> Optional[date]:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        return datetime.strptime(raw[:10], "%Y-%m-%d").date()
    except Exception:
        return None


def _key(sku: Any, plant_id: Any) -> Tuple[str, str]:
    return (str(sku or "").strip(), str(plant_id or "").strip())


def _parse_sku_plant_key(raw_key: Any) -> Optional[Tuple[str, str]]:
    text = str(raw_key or "").strip()
    if not text:
        return None
    if "|" in text:
        sku, plant = text.split("|", 1)
    else:
        sku, plant = text, ""
    sku = sku.strip()
    plant = plant.strip()
    if not sku:
        return None
    return sku, plant


def _parse_keyed_scaled_qty_map(raw_map: Any) -> Dict[Tuple[str, str], int]:
    out: Dict[Tuple[str, str], int] = {}
    if not isinstance(raw_map, dict):
        return out
    for raw_key, raw_value in raw_map.items():
        parsed = _parse_sku_plant_key(raw_key)
        if parsed is None:
            continue
        out[parsed] = _s(max(0.0, _to_float(raw_value, 0.0)))
    return out


def _lookup_keyed_value(
    mapping: Dict[Tuple[str, str], Any],
    key: Tuple[str, str],
) -> Optional[Any]:
    if key in mapping:
        return mapping[key]
    sku, plant = key
    if plant and (sku, "") in mapping:
        return mapping[(sku, "")]
    return None


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        v = float(value)
        if math.isnan(v) or math.isinf(v):
            return default
        return v
    except Exception:
        return default


def _build_qty_map(rows: Any, attr: str) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for row in rows or []:
        sku = str(_read_attr(row, "sku", "") or "").strip()
        if not sku:
            continue
        v = _read_attr(row, attr, None)
        if v is None:
            continue
        out[sku] = _s(max(0.0, _to_float(v, 0.0)))
    return out
