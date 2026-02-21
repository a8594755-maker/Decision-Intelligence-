import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict


_FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "planning"


def load_fixture(name: str) -> Dict[str, Any]:
    path = _FIXTURE_ROOT / name
    return json.loads(path.read_text(encoding="utf-8"))


def to_namespace(value: Any) -> Any:
    if isinstance(value, dict):
        return SimpleNamespace(**{k: to_namespace(v) for k, v in value.items()})
    if isinstance(value, list):
        return [to_namespace(item) for item in value]
    return value


def canonicalize_for_compare(payload: Dict[str, Any]) -> Dict[str, Any]:
    clone = json.loads(json.dumps(payload))
    solver_meta = clone.get("solver_meta") or {}
    if isinstance(solver_meta, dict):
        solver_meta.pop("solve_time_ms", None)
        solver_meta.pop("objective_value", None)
        solver_meta.pop("best_bound", None)
        solver_meta.pop("gap", None)
    return clone
