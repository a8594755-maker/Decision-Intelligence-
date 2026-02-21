#!/usr/bin/env python3
"""Rollback production pointer for a series in the lifecycle registry."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from ml.registry.model_registry import ModelLifecycleRegistry  # noqa: E402


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--series-id", required=True, help="Series ID to rollback")
    parser.add_argument("--steps", type=int, default=1, help="How many promotions to step back")
    parser.add_argument("--registry-root", default="", help="Optional registry root override")
    parser.add_argument("--fail-exit-code", type=int, default=1)
    return parser


def main() -> int:
    args = _build_parser().parse_args()

    registry = ModelLifecycleRegistry(root=(args.registry_root or None))
    restored = registry.rollback_prod(series_id=str(args.series_id), steps=max(1, int(args.steps)))

    if not restored:
        payload = {
            "rolled_back": False,
            "series_id": str(args.series_id),
            "steps": max(1, int(args.steps)),
            "error": "No previous PROD artifact found",
        }
        print(json.dumps(payload, indent=2, sort_keys=True))
        return int(args.fail_exit_code)

    payload = {
        "rolled_back": True,
        "series_id": str(args.series_id),
        "steps": max(1, int(args.steps)),
        "artifact_id": restored.get("artifact_id"),
        "lifecycle_state": restored.get("lifecycle_state"),
        "record": restored,
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
