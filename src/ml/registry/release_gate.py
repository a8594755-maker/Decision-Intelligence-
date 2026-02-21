"""Release gate orchestration for staging -> production promotion."""
from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urljoin

from ml.api.planning_contract import PlanningResponse, PlanningStatus, normalize_status
from ml.api.replenishment_heuristic import deterministic_replenishment_plan
from ml.api.replenishment_solver import (
    ortools_available,
    solve_replenishment,
    solve_replenishment_multi_echelon,
)
from ml.registry.promotion_gates import (
    PromotionGateConfig,
    PromotionGateResult,
    evaluate_promotion_gates,
)

DEFAULT_CANARY_FIXTURE_FILES = [
    "feasible_basic_single.json",
    "feasible_tight_capacity.json",
]
DEFAULT_REQUIRED_ENDPOINTS = ["/health", "/replenishment-plan"]


@dataclass
class CanaryGateConfig:
    """Thresholds used to evaluate canary runs."""

    max_solve_time_ms: int = 10_000
    max_timeout_rate: float = 0.00
    max_infeasible_rate: float = 0.25
    min_endpoint_success_rate: float = 1.0
    required_endpoints: List[str] = field(
        default_factory=lambda: list(DEFAULT_REQUIRED_ENDPOINTS)
    )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "max_solve_time_ms": self.max_solve_time_ms,
            "max_timeout_rate": self.max_timeout_rate,
            "max_infeasible_rate": self.max_infeasible_rate,
            "min_endpoint_success_rate": self.min_endpoint_success_rate,
            "required_endpoints": list(self.required_endpoints),
        }


@dataclass
class RegressionGateResult:
    """Regression gate verdict."""

    passed: bool
    total: int
    failed: int
    reasons: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "passed": self.passed,
            "total": self.total,
            "failed": self.failed,
            "reasons": list(self.reasons),
        }


@dataclass
class CanaryGateResult:
    """Canary gate verdict."""

    passed: bool
    reasons: List[str] = field(default_factory=list)
    fixture_count: int = 0
    timeout_count: int = 0
    infeasible_count: int = 0
    endpoint_success_count: int = 0
    max_solve_time_ms: int = 0
    timeout_rate: float = 0.0
    infeasible_rate: float = 0.0
    endpoint_success_rate: float = 0.0
    fixture_results: List[Dict[str, Any]] = field(default_factory=list)
    endpoint_checks: List[Dict[str, Any]] = field(default_factory=list)
    config_used: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "passed": self.passed,
            "reasons": list(self.reasons),
            "fixture_count": self.fixture_count,
            "timeout_count": self.timeout_count,
            "infeasible_count": self.infeasible_count,
            "endpoint_success_count": self.endpoint_success_count,
            "max_solve_time_ms": self.max_solve_time_ms,
            "timeout_rate": self.timeout_rate,
            "infeasible_rate": self.infeasible_rate,
            "endpoint_success_rate": self.endpoint_success_rate,
            "fixture_results": copy.deepcopy(self.fixture_results),
            "endpoint_checks": copy.deepcopy(self.endpoint_checks),
            "config_used": dict(self.config_used),
        }


@dataclass
class ReleaseGateConfig:
    """Full release gate config for artifact + regression + canary."""

    promotion: PromotionGateConfig = field(default_factory=PromotionGateConfig)
    canary: CanaryGateConfig = field(default_factory=CanaryGateConfig)


@dataclass
class ReleaseGateResult:
    """Combined release decision used by promotion pipeline."""

    can_promote: bool
    reasons: List[str] = field(default_factory=list)
    artifact_quality_passed: bool = False
    regression_passed: bool = False
    canary_passed: bool = False
    artifact_gate: Dict[str, Any] = field(default_factory=dict)
    regression_gate: Dict[str, Any] = field(default_factory=dict)
    canary_gate: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "can_promote": self.can_promote,
            "reasons": list(self.reasons),
            "artifact_quality_passed": self.artifact_quality_passed,
            "regression_passed": self.regression_passed,
            "canary_passed": self.canary_passed,
            "artifact_gate": copy.deepcopy(self.artifact_gate),
            "regression_gate": copy.deepcopy(self.regression_gate),
            "canary_gate": copy.deepcopy(self.canary_gate),
        }


def evaluate_regression_gate(regression_result: Optional[Dict[str, Any]]) -> RegressionGateResult:
    """Evaluate whether regression evidence is a pass/fail."""
    payload = regression_result if isinstance(regression_result, dict) else {}

    total = _to_int(payload.get("total"), fallback=0)
    failed = _to_int(payload.get("failed"), fallback=0)
    passed_field = payload.get("passed")

    reasons: List[str] = []
    if total <= 0 and not isinstance(passed_field, bool):
        reasons.append("Regression evidence missing: provide passed flag or total/failed counts")

    if isinstance(passed_field, bool):
        passed = bool(passed_field) and failed <= 0
    else:
        passed = total > 0 and failed <= 0

    if failed > 0:
        reasons.append(f"Regression suite has failures: failed={failed}")

    if not passed and not reasons:
        reasons.append("Regression gate failed")

    return RegressionGateResult(
        passed=passed,
        total=total,
        failed=max(0, failed),
        reasons=reasons,
    )


def evaluate_canary_gate(
    canary_result: Optional[Dict[str, Any]],
    config: Optional[CanaryGateConfig] = None,
) -> CanaryGateResult:
    """Evaluate canary evidence against deterministic thresholds."""
    cfg = config or CanaryGateConfig()
    payload = canary_result if isinstance(canary_result, dict) else {}

    fixture_results = payload.get("fixture_results") or payload.get("fixtures") or []
    if not isinstance(fixture_results, list):
        fixture_results = []

    endpoint_checks = payload.get("endpoint_checks") or []
    if not isinstance(endpoint_checks, list):
        endpoint_checks = []

    fixture_count = len(fixture_results)
    timeout_count = 0
    infeasible_count = 0
    max_solve_time_ms = 0
    invalid_schema_count = 0

    for row in fixture_results:
        status = normalize_status((row or {}).get("status"), PlanningStatus.ERROR).value
        solve_time = _to_int((row or {}).get("solve_time_ms"), fallback=0)
        schema_valid = bool((row or {}).get("schema_valid", True))

        max_solve_time_ms = max(max_solve_time_ms, max(0, solve_time))
        if status == PlanningStatus.TIMEOUT.value:
            timeout_count += 1
        if status in {PlanningStatus.INFEASIBLE.value, PlanningStatus.ERROR.value}:
            infeasible_count += 1
        if not schema_valid:
            invalid_schema_count += 1

    timeout_rate = (timeout_count / fixture_count) if fixture_count else 1.0
    infeasible_rate = (infeasible_count / fixture_count) if fixture_count else 1.0

    reasons: List[str] = []
    if fixture_count == 0:
        reasons.append("No canary fixture runs were provided")

    if invalid_schema_count > 0:
        reasons.append(f"Canary fixture schema validation failures={invalid_schema_count}")

    if max_solve_time_ms > cfg.max_solve_time_ms:
        reasons.append(
            f"max_solve_time_ms={max_solve_time_ms} exceeds threshold={cfg.max_solve_time_ms}"
        )

    if timeout_rate > cfg.max_timeout_rate:
        reasons.append(
            f"timeout_rate={timeout_rate:.3f} exceeds threshold={cfg.max_timeout_rate:.3f}"
        )

    if infeasible_rate > cfg.max_infeasible_rate:
        reasons.append(
            f"infeasible_rate={infeasible_rate:.3f} exceeds threshold={cfg.max_infeasible_rate:.3f}"
        )

    endpoint_success_count = 0
    required_endpoints = list(cfg.required_endpoints)
    endpoint_by_path: Dict[str, List[Dict[str, Any]]] = {}
    for check in endpoint_checks:
        path = str((check or {}).get("path") or "").strip()
        if not path:
            continue
        endpoint_by_path.setdefault(path, []).append(check)

    for required_path in required_endpoints:
        matches = endpoint_by_path.get(required_path, [])
        if not matches:
            reasons.append(f"Missing canary endpoint check for {required_path}")
            continue

        matched_ok = False
        for check in matches:
            status_code = _to_int((check or {}).get("status_code"), fallback=0)
            responded = bool((check or {}).get("responded", status_code > 0))
            schema_valid = bool((check or {}).get("schema_valid", False))
            if responded and 200 <= status_code < 300 and schema_valid:
                matched_ok = True
                break

        if matched_ok:
            endpoint_success_count += 1
        else:
            last = matches[-1]
            reasons.append(
                f"Endpoint check failed for {required_path}: "
                f"status_code={_to_int(last.get('status_code'), 0)}, "
                f"schema_valid={bool(last.get('schema_valid', False))}"
            )

    required_count = len(required_endpoints)
    endpoint_success_rate = (
        (endpoint_success_count / required_count) if required_count else 1.0
    )
    if endpoint_success_rate < cfg.min_endpoint_success_rate:
        reasons.append(
            f"endpoint_success_rate={endpoint_success_rate:.3f} "
            f"below threshold={cfg.min_endpoint_success_rate:.3f}"
        )

    passed = len(reasons) == 0
    if passed:
        reasons.append("Canary checks passed")

    return CanaryGateResult(
        passed=passed,
        reasons=reasons,
        fixture_count=fixture_count,
        timeout_count=timeout_count,
        infeasible_count=infeasible_count,
        endpoint_success_count=endpoint_success_count,
        max_solve_time_ms=max_solve_time_ms,
        timeout_rate=timeout_rate,
        infeasible_rate=infeasible_rate,
        endpoint_success_rate=endpoint_success_rate,
        fixture_results=copy.deepcopy(fixture_results),
        endpoint_checks=copy.deepcopy(endpoint_checks),
        config_used=cfg.to_dict(),
    )


def evaluate_release_gate(
    artifact_record: Dict[str, Any],
    regression_result: Optional[Dict[str, Any]],
    canary_result: Optional[Dict[str, Any]],
    config: Optional[ReleaseGateConfig] = None,
) -> ReleaseGateResult:
    """Evaluate whether staged artifact can be promoted to production."""
    cfg = config or ReleaseGateConfig()

    artifact_gate_result: PromotionGateResult = evaluate_promotion_gates(
        artifact_record=artifact_record,
        config=cfg.promotion,
    )
    regression_gate_result = evaluate_regression_gate(regression_result)
    canary_gate_result = evaluate_canary_gate(canary_result, config=cfg.canary)

    reasons: List[str] = []
    if not artifact_gate_result.can_promote:
        reasons.extend(f"artifact: {reason}" for reason in artifact_gate_result.reasons)
    if not regression_gate_result.passed:
        reasons.extend(f"regression: {reason}" for reason in regression_gate_result.reasons)
    if not canary_gate_result.passed:
        reasons.extend(f"canary: {reason}" for reason in canary_gate_result.reasons)

    can_promote = (
        artifact_gate_result.can_promote
        and regression_gate_result.passed
        and canary_gate_result.passed
    )

    if can_promote:
        reasons.append("All release gates passed (artifact + regression + canary)")

    return ReleaseGateResult(
        can_promote=can_promote,
        reasons=reasons,
        artifact_quality_passed=artifact_gate_result.can_promote,
        regression_passed=regression_gate_result.passed,
        canary_passed=canary_gate_result.passed,
        artifact_gate=artifact_gate_result.to_dict(),
        regression_gate=regression_gate_result.to_dict(),
        canary_gate=canary_gate_result.to_dict(),
    )


def run_fixture_smoke_checks(
    fixture_files: Optional[List[str]] = None,
    engine: str = "heuristic",
) -> List[Dict[str, Any]]:
    """Run minimal planning smoke checks using deterministic fixtures."""
    files = fixture_files or list(DEFAULT_CANARY_FIXTURE_FILES)
    results: List[Dict[str, Any]] = []

    for file_name in files:
        fixture = load_planning_fixture(file_name)
        fixture_id = str(fixture.get("id") or file_name)
        fixture_request = fixture.get("request") or {}

        row: Dict[str, Any] = {
            "id": fixture_id,
            "file": file_name,
            "engine": engine,
            "status": PlanningStatus.ERROR.value,
            "solve_time_ms": 0,
            "schema_valid": False,
            "error": "",
        }

        try:
            response = _run_fixture_request(fixture_request, engine=engine)
            row["status"] = normalize_status(
                response.get("status"), PlanningStatus.ERROR
            ).value
            row["solve_time_ms"] = _to_int(
                (response.get("solver_meta") or {}).get("solve_time_ms"),
                fallback=0,
            )
            try:
                PlanningResponse.model_validate(response)
                row["schema_valid"] = True
            except Exception as exc:  # pragma: no cover - deterministic in tests
                row["schema_valid"] = False
                row["error"] = f"schema_validation_failed: {exc}"
        except Exception as exc:
            row["status"] = PlanningStatus.ERROR.value
            row["schema_valid"] = False
            row["error"] = str(exc)

        results.append(row)

    return results


def run_endpoint_canary_checks(
    base_url: str,
    planning_payload: Dict[str, Any],
    timeout_seconds: float = 10.0,
) -> List[Dict[str, Any]]:
    """Probe health + planning endpoints and validate response schemas."""
    health = _probe_endpoint(base_url, "/health", method="GET", timeout_seconds=timeout_seconds)
    health_payload = health.get("json")
    health["schema_valid"] = _validate_health_payload(health_payload)

    planning = _probe_endpoint(
        base_url,
        "/replenishment-plan",
        method="POST",
        payload=planning_payload,
        timeout_seconds=timeout_seconds,
    )
    planning_payload_resp = planning.get("json")
    planning_schema_error = ""
    try:
        if isinstance(planning_payload_resp, dict):
            PlanningResponse.model_validate(planning_payload_resp)
            planning["schema_valid"] = True
        else:
            planning["schema_valid"] = False
            planning_schema_error = "response body is not a JSON object"
    except Exception as exc:
        planning["schema_valid"] = False
        planning_schema_error = str(exc)

    if planning_schema_error:
        planning["error"] = planning_schema_error

    return [health, planning]


def run_staging_canary(
    *,
    base_url: Optional[str],
    fixture_files: Optional[List[str]] = None,
    engine: str = "heuristic",
    include_endpoints: bool = True,
    timeout_seconds: float = 10.0,
) -> Dict[str, Any]:
    """Run fixture smoke checks and optional endpoint probes."""
    fixture_results = run_fixture_smoke_checks(fixture_files=fixture_files, engine=engine)

    endpoint_checks: List[Dict[str, Any]] = []
    if include_endpoints and base_url:
        fixture = load_planning_fixture((fixture_files or DEFAULT_CANARY_FIXTURE_FILES)[0])
        endpoint_checks = run_endpoint_canary_checks(
            base_url=base_url,
            planning_payload=fixture.get("request") or {},
            timeout_seconds=timeout_seconds,
        )

    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "engine": engine,
        "fixture_results": fixture_results,
        "endpoint_checks": endpoint_checks,
    }


def load_planning_fixture(file_name: str) -> Dict[str, Any]:
    """Load a planning fixture by filename from tests/fixtures/planning."""
    fixture_path = _planning_fixture_dir() / file_name
    with fixture_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _planning_fixture_dir() -> Path:
    return Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "planning"


def _run_fixture_request(request_payload: Dict[str, Any], engine: str) -> Dict[str, Any]:
    request = _to_namespace(copy.deepcopy(request_payload))
    normalized_engine = str(engine or "heuristic").strip().lower()

    if normalized_engine == "heuristic":
        return deterministic_replenishment_plan(request)

    if normalized_engine != "ortools":
        raise ValueError(f"Unsupported canary engine: {engine}")

    if not ortools_available():
        raise RuntimeError("ortools engine requested but OR-Tools is not installed")

    if _is_multi_echelon_payload(request_payload):
        return solve_replenishment_multi_echelon(request)
    return solve_replenishment(request)


def _is_multi_echelon_payload(request_payload: Dict[str, Any]) -> bool:
    multi = (request_payload or {}).get("multi_echelon") or {}
    mode = str(multi.get("mode") or "").strip().lower()
    return mode == "bom_v0"


def _to_namespace(value: Any) -> Any:
    if isinstance(value, dict):
        return SimpleNamespace(**{k: _to_namespace(v) for k, v in value.items()})
    if isinstance(value, list):
        return [_to_namespace(v) for v in value]
    return value


def _to_int(value: Any, fallback: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return fallback


def _probe_endpoint(
    base_url: str,
    path: str,
    *,
    method: str,
    payload: Optional[Dict[str, Any]] = None,
    timeout_seconds: float = 10.0,
) -> Dict[str, Any]:
    url = urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))

    encoded_body: Optional[bytes] = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        encoded_body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib_request.Request(
        url=url,
        method=method.upper(),
        headers=headers,
        data=encoded_body,
    )

    status_code = 0
    raw_body = ""
    responded = False
    error_text = ""

    try:
        with urllib_request.urlopen(req, timeout=timeout_seconds) as resp:
            status_code = int(resp.status)
            raw_body = resp.read().decode("utf-8", errors="replace")
            responded = True
    except urllib_error.HTTPError as exc:
        status_code = int(exc.code)
        raw_body = exc.read().decode("utf-8", errors="replace")
        responded = True
        error_text = f"HTTPError: {exc.code}"
    except Exception as exc:
        error_text = str(exc)

    parsed_json: Any = None
    if raw_body:
        try:
            parsed_json = json.loads(raw_body)
        except Exception:
            parsed_json = None

    return {
        "path": path,
        "url": url,
        "method": method.upper(),
        "responded": responded,
        "status_code": status_code,
        "schema_valid": False,
        "json": parsed_json,
        "error": error_text,
    }


def _validate_health_payload(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    return all(k in payload for k in ("status", "timestamp", "version"))
