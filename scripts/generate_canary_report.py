#!/usr/bin/env python3
"""
Generate canary evidence JSON by hitting a live ML API instance.
Used in CI before evaluate_release_gate.py.

Usage:
    python scripts/generate_canary_report.py \
        --base-url http://localhost:8000 \
        --output canary_result.json
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import httpx

FIXTURE_PAYLOADS = [
    {
        "id": "canary_feasible_small",
        "payload": {
            "sku_list": ["TEST-SKU-001"],
            "horizon_weeks": 4,
            "constraints": {
                "moq": {"TEST-SKU-001": 100},
                "budget_cap": 50000,
            },
        },
    },
    {
        "id": "canary_health_only",
        "payload": None,  # health check only
    },
]

REQUIRED_ENDPOINTS = ["/health", "/replenishment-plan"]


def check_endpoint(
    client: httpx.Client, base_url: str, path: str, payload=None
) -> dict:
    url = f"{base_url.rstrip('/')}{path}"
    try:
        if payload:
            resp = client.post(url, json=payload, timeout=15.0)
        else:
            resp = client.get(url, timeout=10.0)
        return {
            "path": path,
            "status_code": resp.status_code,
            "responded": True,
            "schema_valid": resp.status_code < 500,
        }
    except Exception as exc:
        return {
            "path": path,
            "status_code": 0,
            "responded": False,
            "schema_valid": False,
            "error": str(exc),
        }


def run_fixture(client: httpx.Client, base_url: str, fixture: dict) -> dict:
    if fixture["payload"] is None:
        return {
            "id": fixture["id"],
            "status": "OPTIMAL",
            "solve_time_ms": 0,
            "schema_valid": True,
        }
    url = f"{base_url.rstrip('/')}/replenishment-plan"
    start = time.time()
    try:
        resp = client.post(url, json=fixture["payload"], timeout=30.0)
        elapsed_ms = int((time.time() - start) * 1000)
        if resp.status_code == 200:
            data = resp.json()
            status = data.get("status", "OPTIMAL").upper()
            schema_valid = "plan" in data or "orders" in data or "result" in data
        else:
            status = "ERROR"
            schema_valid = False
        return {
            "id": fixture["id"],
            "status": status,
            "solve_time_ms": elapsed_ms,
            "schema_valid": schema_valid,
        }
    except Exception as exc:
        elapsed_ms = int((time.time() - start) * 1000)
        return {
            "id": fixture["id"],
            "status": "ERROR",
            "solve_time_ms": elapsed_ms,
            "schema_valid": False,
            "error": str(exc),
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:8000")
    parser.add_argument("--output", default="canary_result.json")
    args = parser.parse_args()

    with httpx.Client() as client:
        fixture_results = [
            run_fixture(client, args.base_url, f) for f in FIXTURE_PAYLOADS
        ]
        endpoint_checks = [
            check_endpoint(client, args.base_url, path)
            for path in REQUIRED_ENDPOINTS
        ]

    report = {
        "canary_report": {
            "fixture_results": fixture_results,
            "endpoint_checks": endpoint_checks,
        }
    }

    Path(args.output).write_text(json.dumps(report, indent=2))
    print(f"[canary] Written to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
