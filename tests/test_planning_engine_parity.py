"""Cross-engine parity checks (heuristic vs OR-Tools) at contract level."""
from __future__ import annotations

import pytest

from tests.planning_regression_harness import (
    assert_contract_schema,
    get_status_family,
    get_status_type,
    load_core_fixtures,
    run_fixture_engine,
)


PARITY_FIXTURES = [
    fixture for fixture in load_core_fixtures()
    if set(fixture.get("engines") or []) >= {"heuristic", "ortools"}
]


def _expected_family(fixture):
    statuses = set((fixture.get("expectations") or {}).get("status_any") or [])
    if not statuses:
        return None
    if statuses <= {"OPTIMAL", "FEASIBLE"}:
        return "FEASIBLE_FAMILY"
    if len(statuses) == 1:
        return list(statuses)[0]
    return None


@pytest.mark.parametrize("fixture", PARITY_FIXTURES, ids=lambda f: f["id"])
def test_cross_engine_parity_contract_and_status(fixture):
    heuristic_result = run_fixture_engine(fixture, "heuristic")
    ortools_result = run_fixture_engine(fixture, "ortools")

    assert_contract_schema(heuristic_result, expect_multi=False)
    assert_contract_schema(ortools_result, expect_multi=False)

    assert heuristic_result.get("contract_version") == ortools_result.get("contract_version")

    heuristic_status = get_status_type(heuristic_result)
    ortools_status = get_status_type(ortools_result)

    heuristic_family = get_status_family(heuristic_status)
    ortools_family = get_status_family(ortools_status)

    assert heuristic_family == ortools_family, (
        f"status family mismatch: heuristic={heuristic_status}, ortools={ortools_status}"
    )

    expected_family = _expected_family(fixture)
    if expected_family is not None:
        assert heuristic_family == expected_family, (
            f"fixture {fixture['id']} expected family {expected_family}, got {heuristic_family}"
        )

    for result in (heuristic_result, ortools_result):
        proof = result.get("proof") or {}
        solver_meta = result.get("solver_meta") or {}
        assert isinstance(proof.get("objective_terms"), list)
        assert isinstance(proof.get("constraints_checked"), list)
        assert isinstance(solver_meta, dict) and len(solver_meta) > 0

    if heuristic_family in {"INFEASIBLE", "TIMEOUT", "ERROR"}:
        heuristic_reasons = heuristic_result.get("infeasible_reasons") or []
        ortools_reasons = ortools_result.get("infeasible_reasons") or []
        assert len(heuristic_reasons) > 0
        assert len(ortools_reasons) > 0

        expected_reason_tokens = [
            str(token).lower()
            for token in ((fixture.get("expectations") or {}).get("reasons_any_substrings") or [])
        ]
        if expected_reason_tokens:
            heur_blob = "\n".join(str(item) for item in heuristic_reasons).lower()
            ort_blob = "\n".join(str(item) for item in ortools_reasons).lower()
            assert any(token in heur_blob for token in expected_reason_tokens)
            assert any(token in ort_blob for token in expected_reason_tokens)
