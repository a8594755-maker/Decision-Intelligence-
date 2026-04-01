"""
tool_eval.py — Generic Evaluation Framework for All Tools

Usage:
    python -m ml.api.tool_eval                    # run all tool tests
    python -m ml.api.tool_eval --tool kpi          # run one tool's tests
    python -m ml.api.tool_eval --list              # list all registered tools
    python -m ml.api.tool_eval --verbose           # show passing tests too

Adding a new tool's tests:
    1. Create: src/ml/api/eval_specs/my_tool_spec.py
    2. Define SPECS = [ToolTestSpec(...), ...]
    3. Run: python -m ml.api.tool_eval --tool my_tool
"""

import time
import sys
import os
import importlib
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable, Optional
from pathlib import Path

import pandas as pd
import numpy as np


# ================================================================
# Part 1: SPEC DEFINITION
# ================================================================

@dataclass
class Assertion:
    name: str
    type: str
    expected: Any = None
    tolerance_pct: float = 1.0
    substring: str = ""
    path: str = ""
    check_fn: Optional[Callable] = None
    detail: str = ""


@dataclass
class ToolTestSpec:
    tool_id: str
    scenario: str
    description: str
    input_data: dict
    input_kwargs: dict = field(default_factory=dict)
    run_fn: Optional[str] = None
    assertions: list = field(default_factory=list)
    requires_llm: bool = False
    timeout_seconds: int = 30
    tags: list = field(default_factory=list)


# ================================================================
# Part 2: RESULT TRACKING
# ================================================================

@dataclass
class TestResult:
    tool_id: str
    scenario: str
    assertion_name: str
    passed: bool
    expected: str = ""
    actual: str = ""
    detail: str = ""
    duration_ms: int = 0


@dataclass
class EvalReport:
    results: list = field(default_factory=list)
    total_duration_ms: int = 0
    errors: list = field(default_factory=list)

    def add(self, result: TestResult):
        self.results.append(result)

    @property
    def passed(self):
        return sum(1 for r in self.results if r.passed)

    @property
    def failed(self):
        return sum(1 for r in self.results if not r.passed)

    @property
    def total(self):
        return len(self.results)

    def print_report(self, verbose=False):
        print(f"\n{'='*70}")
        print(f"TOOL EVAL REPORT")
        print(f"{'='*70}")
        print(f"Total: {self.total} | Pass: {self.passed} | Fail: {self.failed} | "
              f"Duration: {self.total_duration_ms/1000:.1f}s")
        print(f"{'='*70}\n")

        current_group = ""
        for r in self.results:
            group = f"{r.tool_id}/{r.scenario}"
            if group != current_group:
                current_group = group
                print(f"\n  [{r.tool_id}] {r.scenario}")

            if r.passed and not verbose:
                continue

            status = "\u2705" if r.passed else "\u274C"
            print(f"    {status} {r.assertion_name}")
            if not r.passed:
                if r.expected:
                    print(f"       Expected: {r.expected}")
                if r.actual:
                    print(f"       Actual:   {r.actual}")
                if r.detail:
                    print(f"       Detail:   {r.detail}")

        if self.errors:
            print(f"\n  Execution Errors:")
            for err in self.errors:
                print(f"    {err}")

        print(f"\n{'='*70}")
        if self.failed == 0:
            print(f"ALL {self.total} TESTS PASSED \u2705")
        else:
            print(f"{self.failed}/{self.total} FAILED \u274C")
        print(f"{'='*70}\n")

        return self.failed == 0


# ================================================================
# Part 3: ASSERTION ENGINE
# ================================================================

def _resolve_path(obj, path):
    parts = path.split(".")
    current = obj
    for part in parts:
        if current is None:
            return None
        if part == "*":
            if isinstance(current, list):
                remaining = ".".join(parts[parts.index(part)+1:])
                return [_resolve_path(item, remaining) for item in current]
            return None
        if isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, list):
            try:
                current = current[int(part)]
            except (IndexError, ValueError):
                return None
        else:
            return None
    return current


def run_assertion(assertion, result, spec):
    name = assertion.name
    base = TestResult(tool_id=spec.tool_id, scenario=spec.scenario,
                      assertion_name=name, passed=False)

    try:
        actual = _resolve_path(result, assertion.path) if assertion.path else result

        if assertion.type == "close":
            if actual is None:
                base.actual = "None"
                base.expected = f"{assertion.expected} (\u00B1{assertion.tolerance_pct}%)"
                return base
            actual_f = float(actual)
            expected_f = float(assertion.expected)
            diff_pct = abs(actual_f - expected_f) / max(abs(expected_f), 0.01) * 100
            base.passed = diff_pct <= assertion.tolerance_pct
            base.expected = f"{expected_f:,.2f} (\u00B1{assertion.tolerance_pct}%)"
            base.actual = f"{actual_f:,.2f} (diff: {diff_pct:.2f}%)"

        elif assertion.type == "equals":
            base.passed = actual == assertion.expected
            base.expected = str(assertion.expected)
            base.actual = str(actual)

        elif assertion.type == "contains":
            text = str(actual) if actual else ""
            base.passed = assertion.substring.lower() in text.lower()
            base.expected = f"contains '{assertion.substring}'"
            base.actual = text[:100] if not base.passed else "OK"

        elif assertion.type == "not_contains":
            text = str(actual) if actual else ""
            base.passed = assertion.substring.lower() not in text.lower()
            base.expected = f"does NOT contain '{assertion.substring}'"
            base.actual = f"Found '{assertion.substring}'" if not base.passed else "OK"

        elif assertion.type == "true":
            base.passed = bool(actual)
            base.expected = "truthy"
            base.actual = str(actual)[:100]
            base.detail = assertion.detail

        elif assertion.type == "exists":
            base.passed = actual is not None
            base.expected = f"'{assertion.path}' exists"
            base.actual = "None" if actual is None else "exists"

        elif assertion.type == "range":
            lo, hi = assertion.expected
            actual_f = float(actual) if actual is not None else None
            if actual_f is None:
                base.passed = False
                base.actual = "None"
            else:
                base.passed = lo <= actual_f <= hi
                base.actual = f"{actual_f:,.2f}"
            base.expected = f"between {lo} and {hi}"

        elif assertion.type == "count":
            n = len(actual) if isinstance(actual, (list, dict)) else 0
            lo, hi = assertion.expected
            base.passed = lo <= n <= hi
            base.expected = f"count between {lo} and {hi}"
            base.actual = f"count={n}"

        elif assertion.type == "custom":
            if assertion.check_fn:
                passed, detail = assertion.check_fn(result)
                base.passed = passed
                base.detail = detail

    except Exception as e:
        base.detail = f"Exception: {type(e).__name__}: {str(e)[:200]}"

    return base


# ================================================================
# Part 4: SPEC RUNNER
# ================================================================

def run_spec(spec, report):
    t0 = time.time()

    if spec.requires_llm and not os.getenv("EVAL_RUN_LLM"):
        for a in spec.assertions:
            report.add(TestResult(tool_id=spec.tool_id, scenario=spec.scenario,
                                  assertion_name=a.name, passed=True,
                                  detail="SKIPPED (requires LLM)"))
        return

    try:
        if spec.run_fn:
            module_path, fn_name = spec.run_fn.rsplit(".", 1)
            module = importlib.import_module(module_path)
            fn = getattr(module, fn_name)
            result = fn(spec.input_data, **spec.input_kwargs)
        else:
            result = spec.input_data

        duration = int((time.time() - t0) * 1000)
        for assertion in spec.assertions:
            test_result = run_assertion(assertion, result, spec)
            test_result.duration_ms = duration
            report.add(test_result)

    except Exception as e:
        duration = int((time.time() - t0) * 1000)
        report.errors.append(f"{spec.tool_id}/{spec.scenario}: {type(e).__name__}: {str(e)[:200]}")
        report.add(TestResult(tool_id=spec.tool_id, scenario=spec.scenario,
                              assertion_name="execution", passed=False,
                              detail=f"{type(e).__name__}: {str(e)[:200]}",
                              duration_ms=duration))


# ================================================================
# Part 5: SPEC DISCOVERY
# ================================================================

def discover_specs(eval_specs_dir=None, tool_filter=None, tag_filter=None):
    if eval_specs_dir is None:
        eval_specs_dir = Path(__file__).parent / "eval_specs"

    all_specs = []

    if not eval_specs_dir.exists():
        eval_specs_dir.mkdir(parents=True, exist_ok=True)
        return all_specs

    for spec_file in sorted(eval_specs_dir.glob("*_spec.py")):
        if spec_file.name.startswith("_"):
            continue
        module_name = spec_file.stem
        try:
            sys.path.insert(0, str(eval_specs_dir))
            module = importlib.import_module(module_name)
            sys.path.pop(0)

            specs = getattr(module, "SPECS", [])
            for spec in specs:
                if tool_filter and spec.tool_id != tool_filter:
                    continue
                if tag_filter and tag_filter not in spec.tags:
                    continue
                all_specs.append(spec)

        except Exception as e:
            print(f"  Failed to load {spec_file.name}: {e}")

    return all_specs


# ================================================================
# Part 6: CONVENIENCE BUILDERS
# ================================================================

def close(name, path, expected, tolerance_pct=1.0):
    return Assertion(name=name, type="close", path=path, expected=expected, tolerance_pct=tolerance_pct)

def equals(name, path, expected):
    return Assertion(name=name, type="equals", path=path, expected=expected)

def contains(name, path, substring):
    return Assertion(name=name, type="contains", path=path, substring=substring)

def not_contains(name, path, substring):
    return Assertion(name=name, type="not_contains", path=path, substring=substring)

def exists(name, path):
    return Assertion(name=name, type="exists", path=path)

def truthy(name, path, detail=""):
    return Assertion(name=name, type="true", path=path, detail=detail)

def count(name, path, min_count, max_count=999):
    return Assertion(name=name, type="count", path=path, expected=(min_count, max_count))

def in_range(name, path, lo, hi):
    return Assertion(name=name, type="range", path=path, expected=(lo, hi))

def custom(name, check_fn, detail=""):
    return Assertion(name=name, type="custom", check_fn=check_fn, detail=detail)


# ================================================================
# Part 7: MAIN
# ================================================================

def main():
    args = sys.argv[1:]
    tool_filter = None
    tag_filter = None
    verbose = False
    list_mode = False

    i = 0
    while i < len(args):
        if args[i] == "--tool" and i + 1 < len(args):
            tool_filter = args[i + 1]; i += 2
        elif args[i] == "--tag" and i + 1 < len(args):
            tag_filter = args[i + 1]; i += 2
        elif args[i] == "--verbose":
            verbose = True; i += 1
        elif args[i] == "--list":
            list_mode = True; i += 1
        elif args[i] == "--e2e":
            os.environ["EVAL_RUN_LLM"] = "1"; i += 1
        else:
            i += 1

    specs = discover_specs(tool_filter=tool_filter, tag_filter=tag_filter)

    if list_mode:
        print(f"\nRegistered test specs ({len(specs)}):\n")
        for s in specs:
            tags = f" [{', '.join(s.tags)}]" if s.tags else ""
            llm = " (LLM)" if s.requires_llm else ""
            print(f"  {s.tool_id}/{s.scenario}{tags}{llm}")
            print(f"    {s.description}")
        return

    if not specs:
        print(f"\nNo specs found.", end="")
        if tool_filter:
            print(f" (filter: --tool {tool_filter})", end="")
        print(f"\nCreate specs in: src/ml/api/eval_specs/\n")
        return

    report = EvalReport()
    t0 = time.time()
    print(f"\nRunning {len(specs)} test specs...\n")

    for spec in specs:
        run_spec(spec, report)

    report.total_duration_ms = int((time.time() - t0) * 1000)
    success = report.print_report(verbose=verbose)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
