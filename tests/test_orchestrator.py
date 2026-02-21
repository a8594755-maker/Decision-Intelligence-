"""
Test champion selection determinism in the AutoML Orchestrator.

Verifies:
  - _sort_key produces a deterministic ordering
  - Two identical runs produce the same champion and leaderboard order
  - Tie-breaking logic: MAPE → |bias| → complexity → alphabetical name
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from ml.training.orchestrator import (
    MODEL_COMPLEXITY,
    OrchestratorResult,
    _sort_key,
    run_orchestrator,
)
from ml.training.runner import TrainingRunResult
from ml.training.evaluation import EvalMetrics


def _make_result(model_name, mape, bias, run_id="r1"):
    """Build a minimal TrainingRunResult for sort-key tests."""
    return TrainingRunResult(
        run_id=run_id,
        series_id="TEST-SKU",
        model_name=model_name,
        status="success",
        val_metrics=EvalMetrics(mape=mape, bias=bias),
        train_metrics=EvalMetrics(mape=mape * 0.8, bias=bias * 0.9),
        dataset_fingerprint="fp_test",
        elapsed_seconds=0.5,
    )


class TestSortKeyDeterminism(unittest.TestCase):
    """Unit tests for the _sort_key ranking function."""

    def test_lower_mape_wins(self):
        a = _make_result("lightgbm", mape=5.0, bias=1.0)
        b = _make_result("lightgbm", mape=10.0, bias=0.0)
        self.assertLess(_sort_key(a), _sort_key(b))

    def test_same_mape_lower_abs_bias_wins(self):
        a = _make_result("lightgbm", mape=5.0, bias=1.0)
        b = _make_result("lightgbm", mape=5.0, bias=5.0)
        self.assertLess(_sort_key(a), _sort_key(b))

    def test_negative_bias_uses_absolute_value(self):
        a = _make_result("lightgbm", mape=5.0, bias=-2.0)
        b = _make_result("lightgbm", mape=5.0, bias=3.0)
        # |bias| comparison: 2.0 < 3.0
        self.assertLess(_sort_key(a), _sort_key(b))

    def test_same_mape_bias_simpler_model_wins(self):
        a = _make_result("lightgbm", mape=5.0, bias=1.0)
        b = _make_result("prophet", mape=5.0, bias=1.0)
        self.assertLess(_sort_key(a), _sort_key(b))

    def test_complexity_order_matches_constant(self):
        self.assertLess(MODEL_COMPLEXITY["lightgbm"], MODEL_COMPLEXITY["prophet"])
        self.assertLess(MODEL_COMPLEXITY["prophet"], MODEL_COMPLEXITY["chronos"])

    def test_same_everything_alphabetical_name_breaks_tie(self):
        a = _make_result("alpha_model", mape=5.0, bias=1.0)
        b = _make_result("beta_model", mape=5.0, bias=1.0)
        # Both have complexity 99 (unknown), so alphabetical wins
        self.assertLess(_sort_key(a), _sort_key(b))

    def test_sort_is_stable_across_runs(self):
        """Running the same sort 100 times always produces the same ranking."""
        results = [
            _make_result("prophet", mape=5.0, bias=2.0),
            _make_result("lightgbm", mape=5.0, bias=2.0),
            _make_result("chronos", mape=4.0, bias=10.0),
        ]
        expected_order = ["chronos", "lightgbm", "prophet"]
        for _ in range(100):
            sorted_results = sorted(results, key=_sort_key)
            actual_order = [r.model_name for r in sorted_results]
            self.assertEqual(actual_order, expected_order)


class TestOrchestratorDeterminism(unittest.TestCase):
    """Integration test: two identical orchestrator runs produce the same champion."""

    def test_two_runs_produce_same_champion(self):
        from datetime import date, timedelta
        from ml.demand_forecasting.data_contract import SalesSeries

        base = date(2024, 1, 1)
        n_points = 120
        series = SalesSeries(
            sku="DET-TEST-001",
            dates=[(base + timedelta(days=i)).isoformat() for i in range(n_points)],
            values=[100 + (i % 7) * 5 + (i % 3) for i in range(n_points)],
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            result1 = run_orchestrator(
                series=series,
                candidate_models=["lightgbm"],
                horizon=5,
                val_days=10,
                seed=42,
                run_id="det_run_1",
                artifact_root=os.path.join(tmpdir, "run1"),
                champion_dir=os.path.join(tmpdir, "champ1"),
            )

            result2 = run_orchestrator(
                series=series,
                candidate_models=["lightgbm"],
                horizon=5,
                val_days=10,
                seed=42,
                run_id="det_run_2",
                artifact_root=os.path.join(tmpdir, "run2"),
                champion_dir=os.path.join(tmpdir, "champ2"),
            )

        self.assertIsNotNone(result1.champion)
        self.assertIsNotNone(result2.champion)
        self.assertEqual(result1.champion.model_name, result2.champion.model_name)
        self.assertAlmostEqual(
            result1.champion.val_mape, result2.champion.val_mape, places=4
        )
        self.assertAlmostEqual(
            result1.champion.val_bias, result2.champion.val_bias, places=4
        )


if __name__ == "__main__":
    unittest.main()
