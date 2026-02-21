"""Planning API contract v1.0 models and response normalization utilities."""
from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


PLANNING_API_CONTRACT_VERSION = "1.0"


class PlanningStatus(str, Enum):
    OPTIMAL = "OPTIMAL"
    FEASIBLE = "FEASIBLE"
    INFEASIBLE = "INFEASIBLE"
    TIMEOUT = "TIMEOUT"
    ERROR = "ERROR"


_STATUS_MAP = {
    "OPTIMAL": PlanningStatus.OPTIMAL,
    "FEASIBLE": PlanningStatus.FEASIBLE,
    "INFEASIBLE": PlanningStatus.INFEASIBLE,
    "TIMEOUT": PlanningStatus.TIMEOUT,
    "ERROR": PlanningStatus.ERROR,
    # Legacy lowercase compatibility
    "optimal": PlanningStatus.OPTIMAL,
    "feasible": PlanningStatus.FEASIBLE,
    "infeasible": PlanningStatus.INFEASIBLE,
    "timeout": PlanningStatus.TIMEOUT,
    "error": PlanningStatus.ERROR,
    # CP-SAT native names
    "UNKNOWN": PlanningStatus.TIMEOUT,
    "MODEL_INVALID": PlanningStatus.ERROR,
}


def normalize_status(value: Any, fallback: PlanningStatus = PlanningStatus.ERROR) -> PlanningStatus:
    if isinstance(value, PlanningStatus):
        return value
    text = str(value or "").strip()
    if not text:
        return fallback
    return _STATUS_MAP.get(text, _STATUS_MAP.get(text.upper(), fallback))


class PlanLine(BaseModel):
    model_config = ConfigDict(extra="allow")

    sku: str
    plant_id: Optional[str] = None
    order_date: str
    arrival_date: str
    order_qty: float


class ComponentPlanLine(BaseModel):
    model_config = ConfigDict(extra="allow")

    component_sku: str
    plant_id: Optional[str] = None
    order_date: str
    arrival_date: str
    order_qty: float


class PlanningKpis(BaseModel):
    model_config = ConfigDict(extra="allow")

    estimated_service_level: Optional[float] = None
    estimated_stockout_units: Optional[float] = None
    estimated_holding_units: Optional[float] = None
    estimated_total_cost: Optional[float] = None


class ConstraintCheck(BaseModel):
    model_config = ConfigDict(extra="allow")

    name: str
    passed: bool
    details: str = ""
    tag: Optional[str] = None
    tags: List[str] = Field(default_factory=list)


class ObjectiveTerm(BaseModel):
    model_config = ConfigDict(extra="allow")

    name: str
    value: Any = None
    note: Optional[str] = None


class ProofPayload(BaseModel):
    model_config = ConfigDict(extra="allow")

    objective_terms: List[ObjectiveTerm] = Field(default_factory=list)
    constraints_checked: List[ConstraintCheck] = Field(default_factory=list)


class ComponentInventoryProjectionPayload(BaseModel):
    model_config = ConfigDict(extra="allow")

    total_rows: int = 0
    rows: List[Dict[str, Any]] = Field(default_factory=list)
    truncated: bool = False


class BottlenecksPayload(BaseModel):
    model_config = ConfigDict(extra="allow")

    generated_at: Optional[str] = None
    total_rows: int = 0
    rows: List[Dict[str, Any]] = Field(default_factory=list)
    items: List[Dict[str, Any]] = Field(default_factory=list)


class InfeasibleReasonDetail(BaseModel):
    model_config = ConfigDict(extra="allow")

    category: str = "capacity"
    top_offending_tags: List[str] = Field(default_factory=list)
    suggested_actions: List[str] = Field(default_factory=list)


class SolverMeta(BaseModel):
    model_config = ConfigDict(extra="allow")

    engine: str
    status: PlanningStatus
    termination_reason: str = "unspecified"
    solve_time_ms: int = 0
    time_limit: float = 0.0
    seed: int = 0
    workers: int = 1
    solver: Optional[str] = None
    objective_value: Optional[float] = None
    gap: Optional[float] = None


class PlanningResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    contract_version: str = PLANNING_API_CONTRACT_VERSION
    status: PlanningStatus
    plan_lines: List[PlanLine] = Field(default_factory=list)
    # Backward-compatible alias retained for existing consumers.
    plan: List[PlanLine] = Field(default_factory=list)

    component_plan: List[ComponentPlanLine] = Field(default_factory=list)
    component_inventory_projection: ComponentInventoryProjectionPayload = Field(
        default_factory=ComponentInventoryProjectionPayload
    )
    bottlenecks: BottlenecksPayload = Field(default_factory=BottlenecksPayload)

    kpis: PlanningKpis = Field(default_factory=PlanningKpis)
    shared_kpis: Dict[str, Any] = Field(default_factory=dict)
    solver_meta: SolverMeta
    infeasible_reasons: List[str] = Field(default_factory=list)
    infeasible_reason_details: List[InfeasibleReasonDetail] = Field(default_factory=list)
    diagnostics: Dict[str, Any] = Field(default_factory=dict)
    proof: ProofPayload = Field(default_factory=ProofPayload)

    @field_validator("contract_version")
    @classmethod
    def _validate_contract_version(cls, value: str) -> str:
        text = str(value or "").strip() or PLANNING_API_CONTRACT_VERSION
        if not text.startswith("1."):
            raise ValueError(
                f"Unsupported planning contract version '{text}'. Expected 1.x for this API instance."
            )
        return text


def _coerce_solve_time_ms(value: Any) -> int:
    try:
        parsed = int(round(float(value)))
    except Exception:
        return 0
    return max(0, parsed)


def _coerce_float(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except Exception:
        return default
    return parsed if parsed >= 0.0 else default


def _coerce_int(value: Any, default: int = 0, minimum: int = 0) -> int:
    try:
        parsed = int(value)
    except Exception:
        return max(minimum, int(default))
    return max(minimum, parsed)


def finalize_planning_response(
    payload: Dict[str, Any],
    *,
    default_engine: str,
    default_status: PlanningStatus = PlanningStatus.ERROR,
) -> Dict[str, Any]:
    """Normalize and validate a planning response to the v1.0 contract."""
    root = dict(payload or {})

    root["contract_version"] = str(root.get("contract_version") or PLANNING_API_CONTRACT_VERSION)

    status = normalize_status(root.get("status"), fallback=default_status)
    root["status"] = status.value

    plan_lines = root.get("plan_lines")
    legacy_plan = root.get("plan")
    if plan_lines is None and legacy_plan is not None:
        plan_lines = legacy_plan
    if plan_lines is None:
        plan_lines = []
    root["plan_lines"] = plan_lines
    root["plan"] = legacy_plan if legacy_plan is not None else plan_lines

    root.setdefault("component_plan", [])
    root.setdefault(
        "component_inventory_projection",
        {"total_rows": 0, "rows": [], "truncated": False},
    )
    root.setdefault(
        "bottlenecks",
        {"generated_at": None, "total_rows": 0, "rows": [], "items": []},
    )

    root.setdefault(
        "kpis",
        {
            "estimated_service_level": None,
            "estimated_stockout_units": None,
            "estimated_holding_units": None,
            "estimated_total_cost": None,
        },
    )
    root.setdefault("shared_kpis", {})

    root.setdefault("infeasible_reasons", [])
    if not isinstance(root.get("infeasible_reasons"), list):
        root["infeasible_reasons"] = [str(root.get("infeasible_reasons"))]

    details = root.get("infeasible_reason_details")
    if details is None:
        details = []
    elif not isinstance(details, list):
        details = [details]
    root["infeasible_reason_details"] = details

    diagnostics = root.get("diagnostics")
    root["diagnostics"] = diagnostics if isinstance(diagnostics, dict) else {}

    proof = dict(root.get("proof") or {})
    if not isinstance(proof.get("objective_terms"), list):
        proof["objective_terms"] = []
    if not isinstance(proof.get("constraints_checked"), list):
        proof["constraints_checked"] = []
    if not isinstance(proof.get("constraint_tags"), list):
        proof["constraint_tags"] = []
    infeasibility_analysis = proof.get("infeasibility_analysis")
    if not isinstance(infeasibility_analysis, dict):
        proof["infeasibility_analysis"] = {
            "categories": [],
            "top_offending_tags": [],
            "suggestions": [],
        }
    if not isinstance(proof.get("relaxation_analysis"), list):
        proof["relaxation_analysis"] = []
    if "diagnose_mode" not in proof:
        proof["diagnose_mode"] = bool(root["diagnostics"].get("mode") == "progressive_relaxation")
    else:
        proof["diagnose_mode"] = bool(proof.get("diagnose_mode"))
    root["proof"] = proof

    solver_meta = dict(root.get("solver_meta") or {})
    engine = str(
        solver_meta.get("engine")
        or solver_meta.get("solver")
        or root.get("engine")
        or default_engine
        or "unknown"
    ).strip() or "unknown"
    solver_meta["engine"] = engine
    solver_meta.setdefault("solver", engine)
    solver_meta["solve_time_ms"] = _coerce_solve_time_ms(solver_meta.get("solve_time_ms"))
    solver_meta["status"] = status.value
    solver_meta["termination_reason"] = str(solver_meta.get("termination_reason") or "unspecified")
    solver_meta["time_limit"] = _coerce_float(solver_meta.get("time_limit"), 0.0)
    solver_meta["seed"] = _coerce_int(solver_meta.get("seed"), 0, 0)
    solver_meta["workers"] = _coerce_int(solver_meta.get("workers"), 1, 1)
    root["solver_meta"] = solver_meta

    validated = PlanningResponse.model_validate(root)
    return validated.model_dump(mode="json")


def build_contract_error_response(
    *,
    engine: str,
    reason: str,
    solve_time_ms: int = 0,
    termination_reason: str = "error",
    time_limit: float = 0.0,
    seed: int = 0,
    workers: int = 1,
) -> Dict[str, Any]:
    return finalize_planning_response(
        {
            "status": PlanningStatus.ERROR.value,
            "plan_lines": [],
            "kpis": {
                "estimated_service_level": None,
                "estimated_stockout_units": None,
                "estimated_holding_units": None,
                "estimated_total_cost": None,
            },
            "solver_meta": {
                "engine": engine,
                "solver": engine,
                "solve_time_ms": max(0, int(solve_time_ms)),
                "objective_value": None,
                "gap": None,
                "termination_reason": str(termination_reason or "error"),
                "time_limit": max(0.0, float(time_limit)),
                "seed": max(0, int(seed)),
                "workers": max(1, int(workers)),
            },
            "infeasible_reasons": [str(reason or "Unknown planning error")],
            "proof": {"objective_terms": [], "constraints_checked": []},
            "component_plan": [],
            "component_inventory_projection": {"total_rows": 0, "rows": [], "truncated": False},
            "bottlenecks": {"generated_at": None, "total_rows": 0, "rows": [], "items": []},
        },
        default_engine=engine,
        default_status=PlanningStatus.ERROR,
    )
