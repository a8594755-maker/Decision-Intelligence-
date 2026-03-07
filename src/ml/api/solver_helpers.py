"""
Shared higher-level helpers used by both single-echelon and multi-echelon
replenishment solvers.

Extracted from replenishment_solver.py to enable the ME solver module
(solver_multi.py) to reuse these without circular imports.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

from ml.api.planning_contract import (
    PlanningStatus,
    finalize_planning_response,
    normalize_status,
)
from ml.api.solver_utils import (
    SCALE,
    DEFAULT_SOLVER_RANDOM_SEED,
    DEFAULT_SOLVER_NUM_SEARCH_WORKERS,
    DEFAULT_SOLVER_LOG_PROGRESS,
    DEFAULT_SOLVER_SINGLE_TIME_LIMIT_SECONDS,
    DEFAULT_SOLVER_MULTI_TIME_LIMIT_SECONDS,
    SolverRunSettings,
    SolverStatusInfo,
    _as_list,
    _us,
)
from ml.api.solver_capacity import _build_solver_meta
from ml.api.solver_analysis import (
    _mk_constraint_check,
    _suggestions_for_categories,
    _summarize_infeasibility,
    _run_relaxation_analysis_single,
    _build_relaxation_summary,
)


# ── tag collector ─────────────────────────────────────────────────────────────

def _make_tag_collector(echelon: str = "single") -> Tuple[List[Dict[str, Any]], Callable]:
    """Return (tag_list, tag_fn) for recording constraint metadata."""
    tags: List[Dict[str, Any]] = []
    def _tag(
        tag: str, description: str, *,
        severity: str = "hard", scope: str = "global",
        period: Optional[str] = None, sku: Optional[str] = None,
        echelon_override: Optional[str] = None,
    ) -> None:
        tags.append({
            "tag": tag, "description": description, "severity": severity,
            "scope": scope, "period": period, "sku": sku,
            "echelon": echelon_override or echelon,
        })
    return tags, _tag


# ── status determination ──────────────────────────────────────────────────────

def _determine_final_status(
    status_info: SolverStatusInfo,
    constraints_checked: List[Dict[str, Any]],
) -> PlanningStatus:
    """Compute the final status from CP-SAT status and constraint-check results."""
    all_passed = all(c["passed"] for c in constraints_checked)
    if status_info.status == PlanningStatus.TIMEOUT:
        return PlanningStatus.TIMEOUT
    if not all_passed:
        return PlanningStatus.INFEASIBLE
    return status_info.status if status_info.status in {
        PlanningStatus.OPTIMAL, PlanningStatus.FEASIBLE,
    } else PlanningStatus.FEASIBLE


# ── proof / diagnostics builder ───────────────────────────────────────────────

def _build_proof_and_diagnostics(
    infeasible_reasons_detailed: List[Dict[str, Any]],
    diagnose_mode: bool,
    internal_diagnose: bool,
    payload: Any,
    *,
    multi_echelon: bool = False,
    infeasible_reasons: Optional[List[str]] = None,
) -> Tuple[Dict, List, Dict, Dict]:
    """Return (infeasibility_analysis, relaxation_analysis, relaxation_applied, diagnostics)."""
    proof_tags = []
    for row in infeasible_reasons_detailed:
        proof_tags.extend(_as_list(row.get("top_offending_tags")))
    infeasibility_analysis = (
        _summarize_infeasibility(proof_tags) if proof_tags
        else {"categories": [], "top_offending_tags": [], "suggestions": []}
    )
    relaxation_analysis: List[Dict[str, Any]] = []
    if diagnose_mode and not internal_diagnose:
        if multi_echelon:
            if infeasible_reasons:
                relaxation_analysis = [
                    {"relaxed_tags": [t], "feasible_after_relaxation": None, "delta_cost_proxy": None}
                    for t in ["CAP_PROD", "CAP_INV", "BUDGET_GLOBAL"]
                ]
        else:
            relaxation_analysis = _run_relaxation_analysis_single(payload)
    relaxation_applied = _build_relaxation_summary(relaxation_analysis)
    diagnostics: Dict[str, Any] = {}
    if diagnose_mode and not internal_diagnose:
        diagnostics = {"mode": "progressive_relaxation", "relaxation_analysis": relaxation_analysis}
    return infeasibility_analysis, relaxation_analysis, relaxation_applied, diagnostics


# ── base constraint checks ────────────────────────────────────────────────────

def _build_base_constraint_checks(
    nonneg_failed: int, moq_failed: int, pack_failed: int, max_failed: int,
    budget_passed: bool, budget_detail: str,
    *,
    echelon: str = "single",
    budget_binding: Any = None, budget_slack: Any = None,
    budget_slack_unit: Any = None, budget_nl: Any = None,
    moq_binding: Any = None, moq_nl: Any = None,
    item_label: str = "SKU-period",
) -> List[Dict[str, Any]]:
    """Return the five base constraint checks shared by both solvers."""
    return [
        _mk_constraint_check(
            name="order_qty_non_negative", tag="NONNEG",
            passed=nonneg_failed == 0,
            details=f"Negative quantity rows: {nonneg_failed}.",
            description="All planned order quantities must be non-negative.",
            scope="row", echelon=echelon,
            binding=nonneg_failed > 0,
        ),
        _mk_constraint_check(
            name="moq", tag="MOQ", passed=moq_failed == 0,
            details=f"Rows violating MOQ: {moq_failed}.",
            description=f"MOQ enforcement across {item_label} rows.",
            scope="sku_period", echelon=echelon,
            binding=moq_binding, slack=0.0 if moq_binding else None,
            slack_unit="units", natural_language=moq_nl,
        ),
        _mk_constraint_check(
            name="pack_size_multiple", tag="PACK", passed=pack_failed == 0,
            details=f"Rows violating pack-size multiple: {pack_failed}.",
            description=f"Pack-size multiple enforcement across {item_label} rows.",
            scope="sku_period", echelon=echelon,
            binding=pack_failed > 0,
        ),
        _mk_constraint_check(
            name="budget_cap", tag="BUDGET_GLOBAL",
            passed=budget_passed, details=budget_detail,
            description="Shared budget cap across all SKUs.",
            echelon=echelon,
            binding=budget_binding, slack=budget_slack,
            slack_unit=budget_slack_unit, natural_language=budget_nl,
        ),
        _mk_constraint_check(
            name="max_order_qty", tag="MAXQ", passed=max_failed == 0,
            details=f"Rows violating max_order_qty: {max_failed}.",
            description=f"Max order quantity per {item_label}.",
            scope="sku_period", echelon=echelon,
            binding=max_failed > 0,
        ),
    ]


# ── BOM demand propagation ────────────────────────────────────────────────────

def _propagate_bom_demand(
    seed: Dict[Tuple[str, str], float],
    children_by_parent: Dict[Tuple[str, str], List[Tuple[Tuple[str, str], int, float]]],
    max_depth: int,
    cap: float = 1e9,
) -> Tuple[Dict[Tuple[str, str], float], Dict[Tuple[str, str], float], bool]:
    """BFS BOM demand propagation. Returns (total_need, frontier_remainder, truncated)."""
    total = dict(seed)
    frontier = {k: v for k, v in total.items() if v > 0.0}
    for _ in range(max_depth):
        if not frontier:
            break
        nxt: Dict[Tuple[str, str], float] = {}
        for pk, pq in frontier.items():
            if pq <= 0.0:
                continue
            for ck, _, uq in children_by_parent.get(pk, []):
                add = min(pq * uq, cap)
                if add <= 0.0:
                    continue
                new = min(cap, total.get(ck, 0.0) + add)
                delta = max(0.0, new - total.get(ck, 0.0))
                if delta <= 0.0:
                    continue
                total[ck] = new
                nxt[ck] = min(cap, nxt.get(ck, 0.0) + delta)
        frontier = nxt
    return total, frontier, bool(frontier)


def _propagate_bom_demand_by_period(
    seed: Dict[Tuple[str, str], Dict[int, float]],
    children_by_parent: Dict[Tuple[str, str], List[Tuple[Tuple[str, str], int, float]]],
    max_depth: int,
    cap: float = 1e9,
) -> Tuple[Dict[Tuple[str, str], Dict[int, float]], bool]:
    """BFS BOM demand propagation per-period. Returns (need_by_key_idx, truncated)."""
    need = {k: dict(v) for k, v in seed.items()}
    frontier = {k: dict(v) for k, v in seed.items() if any(vv > 0 for vv in v.values())}
    for _ in range(max_depth):
        if not frontier:
            break
        nxt: Dict[Tuple[str, str], Dict[int, float]] = {}
        for pk, pq in frontier.items():
            for ck, _, uq in children_by_parent.get(pk, []):
                cb = need.setdefault(ck, {})
                fb = nxt.setdefault(ck, {})
                for t, pqt in pq.items():
                    add = pqt * uq
                    if add <= 0.0:
                        continue
                    prev = cb.get(t, 0.0)
                    new = min(cap, prev + add)
                    delta = max(0.0, new - prev)
                    if delta <= 0.0:
                        continue
                    cb[t] = new
                    fb[t] = min(cap, fb.get(t, 0.0) + delta)
        frontier = {k: b for k, b in nxt.items() if any(v > 0 for v in b.values())}
    return need, bool(frontier)


# ── empty / fallback response ─────────────────────────────────────────────────

def _empty_response(
    t0: datetime,
    status: str,
    reasons: List[str],
    solve_time_ms: Optional[int] = None,
    settings: Optional[SolverRunSettings] = None,
    termination_reason: str = "NO_FEASIBLE_SOLUTION",
    status_name: str = "UNKNOWN",
    *,
    multi_echelon: bool = False,
) -> Dict[str, Any]:
    """Empty response for single or multi-echelon (superset shape when multi_echelon=True)."""
    if solve_time_ms is None:
        solve_time_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
    normalized_status = normalize_status(status, PlanningStatus.ERROR)
    default_tl = DEFAULT_SOLVER_MULTI_TIME_LIMIT_SECONDS if multi_echelon else DEFAULT_SOLVER_SINGLE_TIME_LIMIT_SECONDS
    solver_settings = settings or SolverRunSettings(
        time_limit_seconds=default_tl,
        random_seed=DEFAULT_SOLVER_RANDOM_SEED,
        num_search_workers=DEFAULT_SOLVER_NUM_SEARCH_WORKERS,
        log_search_progress=DEFAULT_SOLVER_LOG_PROGRESS,
        deterministic_mode=DEFAULT_SOLVER_NUM_SEARCH_WORKERS == 1,
    )
    status_info = SolverStatusInfo(
        status=normalized_status,
        termination_reason=termination_reason,
        status_name=status_name,
        has_feasible_solution=False,
        time_limit_hit=normalized_status == PlanningStatus.TIMEOUT,
    )
    extra = {"multi_echelon_mode": "bom_v0"} if multi_echelon else None
    body: Dict[str, Any] = {
        "status": status,
        "plan_lines": [],
        "kpis": {
            "estimated_service_level": None,
            "estimated_stockout_units": None,
            "estimated_holding_units": None,
            "estimated_total_cost": None,
        },
        "solver_meta": _build_solver_meta(
            status_info=status_info,
            settings=solver_settings,
            solve_time_ms=solve_time_ms,
            objective_value=None, best_bound=None, gap=None,
            **({"extra": extra} if extra else {}),
        ),
        "infeasible_reasons": reasons,
        "proof": {"objective_terms": [], "constraints_checked": []},
    }
    if multi_echelon:
        body["component_plan"] = []
        body["component_inventory_projection"] = {"total_rows": 0, "rows": [], "truncated": False}
        body["bottlenecks"] = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "items": [], "rows": [], "total_rows": 0,
        }
    return finalize_planning_response(body, default_engine="cp_sat", default_status=normalized_status)
