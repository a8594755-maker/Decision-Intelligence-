import os
import sys
import threading
import time
import unittest
from datetime import date, timedelta
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from ml.api.async_runs import (  # noqa: E402
    AsyncRunConfig,
    AsyncRunService,
    AsyncRunSubmitRequest,
    AsyncRunWorker,
    InMemoryAsyncRunStore,
)
from ml.api.solver_telemetry import InMemorySolverTelemetryStore  # noqa: E402


def _build_request(
    contract_template_id: int = 11,
    engine_flags=None,
    max_attempts=None,
    dataset_fingerprint: str = 'fp::dataset::alpha',
    settings: dict | None = None,
):
    return AsyncRunSubmitRequest(
        user_id='00000000-0000-0000-0000-000000000001',
        dataset_profile_id=101,
        dataset_fingerprint=dataset_fingerprint,
        contract_template_id=contract_template_id,
        workflow='workflow_A_replenishment',
        engine_flags=engine_flags or {},
        settings=settings or {
            'forecast': {'horizon_periods': 8},
            'plan': {'objective': 'balanced'},
            'solver': {'engine': 'heuristic'},
        },
        horizon=8,
        granularity='day',
        workload={
            'rows_per_sheet': 500,
            'skus': 20,
            'forecast_series': 20,
            'bom_edges': 300,
            'bom_depth': 2,
        },
        max_attempts=max_attempts,
    )


def _build_planning_payload(
    *,
    horizon_days: int = 14,
    time_limit_seconds: float = 0.2,
    include_demand: bool = True,
) -> dict:
    base_day = date(2025, 6, 1)
    series = []
    if include_demand:
        for idx in range(horizon_days):
            series.append(
                {
                    "sku": "SKU-ASYNC-001",
                    "plant_id": "P1",
                    "date": (base_day + timedelta(days=idx)).isoformat(),
                    "p50": 10.0,
                    "p90": None,
                }
            )

    return {
        "dataset_profile_id": 101,
        "planning_horizon_days": horizon_days,
        "demand_forecast": {"granularity": "day", "series": series},
        "inventory": [
            {
                "sku": "SKU-ASYNC-001",
                "plant_id": "P1",
                "as_of_date": base_day.isoformat(),
                "on_hand": 0.0,
                "safety_stock": 0.0,
                "lead_time_days": 0.0,
            }
        ],
        "open_pos": [],
        "constraints": {
            "moq": [{"sku": "SKU-ASYNC-001", "min_qty": 17.0}],
            "pack_size": [{"sku": "SKU-ASYNC-001", "pack_qty": 7.0}],
            "max_order_qty": [],
            "budget_cap": None,
            "unit_costs": [],
        },
        "objective": {
            "optimize_for": "balanced",
            "stockout_penalty": 1.0,
            "holding_cost": 0.01,
            "service_level_target": None,
        },
        "multi_echelon": {"mode": "off"},
        "bom_usage": [],
        "settings": {
            "solver": {
                "time_limit_seconds": float(time_limit_seconds),
                "num_search_workers": 1,
                "random_seed": 42,
            }
        },
        "engine_flags": {},
    }


def _build_planning_async_request(
    *,
    contract_template_id: int,
    dataset_fingerprint: str,
    planning_payload: dict,
    max_attempts: int = 1,
) -> AsyncRunSubmitRequest:
    return _build_request(
        contract_template_id=contract_template_id,
        max_attempts=max_attempts,
        dataset_fingerprint=dataset_fingerprint,
        settings={
            "forecast": {"horizon_periods": 8},
            "plan": {"objective": "balanced"},
            "solver": {
                "time_limit_seconds": float(
                    ((planning_payload.get("settings") or {}).get("solver") or {}).get("time_limit_seconds", 0.2)
                ),
                "num_search_workers": 1,
                "random_seed": 42,
            },
            "planning_request": planning_payload,
        },
    )


class AsyncRunLayerTests(unittest.TestCase):
    def test_job_idempotency_returns_same_job_and_run(self):
        store = InMemoryAsyncRunStore()
        service = AsyncRunService(store=store, config=AsyncRunConfig())

        req = _build_request(contract_template_id=21)
        first = service.submit(req)
        second = service.submit(req)

        self.assertEqual(first.job_id, second.job_id)
        self.assertEqual(first.run_id, second.run_id)
        self.assertFalse(first.reused_existing)
        self.assertTrue(second.reused_existing)

    def test_worker_claims_queued_job_and_marks_succeeded(self):
        store = InMemoryAsyncRunStore()
        service = AsyncRunService(store=store, config=AsyncRunConfig())
        worker = AsyncRunWorker(store=store, config=AsyncRunConfig())

        submit = service.submit(_build_request(contract_template_id=31))
        processed = worker.run_once()
        status = service.get_job_status(submit.job_id)

        self.assertTrue(processed)
        self.assertEqual(status.status, 'succeeded')
        self.assertEqual(status.lifecycle_status, 'SUCCEEDED')
        self.assertEqual(status.run_status, 'succeeded')
        self.assertEqual(status.run_lifecycle_status, 'SUCCEEDED')
        self.assertAlmostEqual(status.progress_pct, 100.0, places=3)
        self.assertTrue(any(step.status == 'succeeded' for step in status.step_summary))

    def test_cancellation_request_stops_execution(self):
        config = AsyncRunConfig(step_sleep_slice_seconds=0.05)
        store = InMemoryAsyncRunStore()
        service = AsyncRunService(store=store, config=config)
        worker = AsyncRunWorker(store=store, config=config)

        submit = service.submit(_build_request(contract_template_id=41, engine_flags={
            'simulate_forecast_seconds': 0.4,
        }))

        thread = threading.Thread(target=worker.run_once)
        thread.start()
        time.sleep(0.08)
        service.cancel_job(submit.job_id)
        thread.join(timeout=3)

        status = service.get_job_status(submit.job_id)
        self.assertEqual(status.status, 'canceled')
        self.assertEqual(status.lifecycle_status, 'CANCELLED')
        self.assertTrue(status.cancel_requested)
        self.assertTrue(any(step.status == 'canceled' for step in status.step_summary))
        artifacts = service.get_run_artifacts(submit.run_id)
        self.assertEqual(artifacts, [])

    def test_timeout_handling_is_controlled_failure(self):
        config = AsyncRunConfig(
            forecast_timeout_seconds=0,
            step_sleep_slice_seconds=0.01,
        )
        store = InMemoryAsyncRunStore()
        service = AsyncRunService(store=store, config=config)
        worker = AsyncRunWorker(store=store, config=config)

        req = _build_request(contract_template_id=51, engine_flags={
            'simulate_forecast_seconds': 0.3,
        }, max_attempts=1)
        submit = service.submit(req)

        worker.run_once()
        status = service.get_job_status(submit.job_id)

        self.assertEqual(status.status, 'failed')
        self.assertEqual(status.lifecycle_status, 'FAILED')
        self.assertIn('timeout', (status.error_message or '').lower())

        forecast_step = next(step for step in status.step_summary if step.step == 'forecast')
        self.assertEqual(forecast_step.status, 'failed')
        self.assertEqual(forecast_step.error_code, 'STEP_TIMEOUT')

    def test_retry_requeues_before_terminal_failure(self):
        config = AsyncRunConfig(
            forecast_timeout_seconds=0,
            step_sleep_slice_seconds=0.01,
        )
        store = InMemoryAsyncRunStore()
        service = AsyncRunService(store=store, config=config)
        worker = AsyncRunWorker(store=store, config=config)

        submit = service.submit(_build_request(
            contract_template_id=56,
            engine_flags={'simulate_forecast_seconds': 0.2},
            max_attempts=2,
        ))

        worker.run_once()
        status_after_first = service.get_job_status(submit.job_id)
        self.assertEqual(status_after_first.status, 'queued')
        self.assertEqual(status_after_first.attempts, 1)

        worker.run_once()
        status_after_second = service.get_job_status(submit.job_id)
        self.assertEqual(status_after_second.status, 'failed')
        self.assertEqual(status_after_second.attempts, 2)

    def test_async_infeasible_plan_keeps_job_succeeded(self):
        config = AsyncRunConfig(step_sleep_slice_seconds=0.01)
        store = InMemoryAsyncRunStore()
        service = AsyncRunService(store=store, config=config)
        worker = AsyncRunWorker(store=store, config=config)

        submit = service.submit(_build_request(contract_template_id=71, engine_flags={
            'simulate_plan_status': 'INFEASIBLE',
        }))
        worker.run_once()
        status = service.get_job_status(submit.job_id)

        self.assertEqual(status.status, 'succeeded')
        self.assertEqual(status.lifecycle_status, 'SUCCEEDED')
        self.assertEqual(status.planning_status, 'INFEASIBLE')
        self.assertIsNotNone(status.result_payload)
        self.assertEqual((status.result_payload or {}).get('status'), 'INFEASIBLE')

    def test_async_timeout_plan_keeps_job_succeeded(self):
        config = AsyncRunConfig(step_sleep_slice_seconds=0.01)
        store = InMemoryAsyncRunStore()
        service = AsyncRunService(store=store, config=config)
        worker = AsyncRunWorker(store=store, config=config)

        submit = service.submit(_build_request(contract_template_id=72, engine_flags={
            'simulate_plan_status': 'TIMEOUT',
            'simulate_timeout_with_feasible': False,
        }))
        worker.run_once()
        status = service.get_job_status(submit.job_id)

        self.assertEqual(status.status, 'succeeded')
        self.assertEqual(status.planning_status, 'TIMEOUT')
        self.assertEqual(status.planning_termination_reason, 'TIME_LIMIT_NO_FEASIBLE')
        self.assertIn('time_limit', (status.planning_termination_reason or '').lower())

    def _run_with_telemetry_summary(
        self,
        *,
        simulate_plan_status: str,
        timeout_with_feasible: bool = True,
    ):
        config = AsyncRunConfig(step_sleep_slice_seconds=0.01)
        store = InMemoryAsyncRunStore()
        telemetry = InMemorySolverTelemetryStore()
        service = AsyncRunService(store=store, config=config)
        worker = AsyncRunWorker(store=store, config=config, telemetry_store=telemetry)

        flags = {'simulate_plan_status': simulate_plan_status}
        if simulate_plan_status == 'TIMEOUT':
            flags['simulate_timeout_with_feasible'] = timeout_with_feasible
        submit = service.submit(_build_request(
            contract_template_id=int(time.time_ns() % 1_000_000),
            engine_flags=flags,
        ))

        worker.run_once()
        status = service.get_job_status(submit.job_id)
        rows = telemetry.list_events(event_type='summary', limit=50)
        summary_rows = [row for row in rows if row.get('run_id') == submit.run_id]
        self.assertEqual(len(summary_rows), 1)
        return submit, status, summary_rows[0]

    def test_async_optimal_plan_emits_summary_telemetry_with_job_link(self):
        submit, status, summary = self._run_with_telemetry_summary(simulate_plan_status='OPTIMAL')
        self.assertEqual(status.status, 'succeeded')
        self.assertEqual(summary.get('status'), 'OPTIMAL')
        self.assertEqual(summary.get('job_id'), submit.job_id)
        self.assertEqual(summary.get('run_id'), submit.run_id)
        for key in (
            'solve_time_ms',
            'status',
            'termination_reason',
            'engine',
            'objective',
            'infeasible_summary',
            'queue_wait_ms',
            'env',
            'git_sha',
            'contract_version',
        ):
            self.assertIn(key, summary)

    def test_async_infeasible_plan_emits_summary_telemetry(self):
        _, status, summary = self._run_with_telemetry_summary(simulate_plan_status='INFEASIBLE')
        self.assertEqual(status.status, 'succeeded')
        self.assertEqual(summary.get('status'), 'INFEASIBLE')
        self.assertEqual((summary.get('infeasible_summary') or {}).get('count'), 1)

    def test_async_timeout_plan_emits_summary_telemetry(self):
        _, status, summary = self._run_with_telemetry_summary(
            simulate_plan_status='TIMEOUT',
            timeout_with_feasible=False,
        )
        self.assertEqual(status.status, 'succeeded')
        self.assertEqual(summary.get('status'), 'TIMEOUT')
        self.assertEqual(summary.get('termination_reason'), 'TIME_LIMIT_NO_FEASIBLE')

    def test_async_planning_success_returns_contract_payload_and_events(self):
        config = AsyncRunConfig(step_sleep_slice_seconds=0.01)
        store = InMemoryAsyncRunStore()
        service = AsyncRunService(store=store, config=config)
        worker = AsyncRunWorker(store=store, config=config)

        payload = _build_planning_payload(horizon_days=14, time_limit_seconds=0.2, include_demand=True)
        submit = service.submit(
            _build_planning_async_request(
                contract_template_id=181,
                dataset_fingerprint=f'fp::planning::success::{time.time_ns()}',
                planning_payload=payload,
                max_attempts=1,
            )
        )

        def _mock_solver(_request_ns, cancel_check=None):
            return {
                'status': 'OPTIMAL',
                'plan_lines': [{'sku': 'SKU-ASYNC-001', 'plant_id': 'P1',
                                'order_date': '2025-06-01', 'arrival_date': '2025-06-01',
                                'order_qty': 21.0}],
                'kpis': {'estimated_service_level': 0.95,
                         'estimated_stockout_units': 0,
                         'estimated_holding_units': 5},
                'solver_meta': {'status': 'OPTIMAL', 'termination_reason': 'OPTIMAL',
                                'solve_time_ms': 50, 'time_limit_seconds': 0.2,
                                'random_seed': 42, 'num_search_workers': 1},
                'infeasible_reasons': [],
                'proof': {'objective_terms': [], 'constraints_checked': [
                    {'name': 'moq', 'passed': True}]},
            }

        with patch('ml.api.async_runs.solve_planning_contract', side_effect=_mock_solver):
            worker.run_once()
        status = service.get_job_status(submit.job_id)

        self.assertEqual(status.status, 'succeeded')
        self.assertEqual(status.lifecycle_status, 'SUCCEEDED')
        self.assertIn(status.planning_status, {'OPTIMAL', 'FEASIBLE', 'TIMEOUT'})
        self.assertIsInstance(status.result_payload, dict)
        self.assertIn((status.result_payload or {}).get('status'), {'OPTIMAL', 'FEASIBLE', 'TIMEOUT'})
        solver_meta = (status.result_payload or {}).get('solver_meta') or {}
        for key in ('status', 'termination_reason', 'solve_time_ms', 'time_limit_seconds', 'random_seed', 'num_search_workers'):
            self.assertIn(key, solver_meta)

        self.assertIsInstance(status.result_summary, dict)
        for key in ('duration_ms', 'planning_status', 'termination_reason', 'input_hash'):
            self.assertIn(key, status.result_summary)

        event_names = [event.get('event') for event in (status.events or [])]
        required = {
            'job_started',
            'validation_complete',
            'model_built',
            'solving_started',
            'solving_finished',
            'result_persisted',
            'job_completed',
        }
        self.assertTrue(required.issubset(set(event_names)))

    def test_async_planning_infeasible_keeps_job_succeeded(self):
        config = AsyncRunConfig(step_sleep_slice_seconds=0.01)
        store = InMemoryAsyncRunStore()
        service = AsyncRunService(store=store, config=config)
        worker = AsyncRunWorker(store=store, config=config)

        payload = _build_planning_payload(horizon_days=14, time_limit_seconds=0.2, include_demand=False)
        submit = service.submit(
            _build_planning_async_request(
                contract_template_id=182,
                dataset_fingerprint=f'fp::planning::infeasible::{time.time_ns()}',
                planning_payload=payload,
                max_attempts=1,
            )
        )

        def _mock_solver(_request_ns, cancel_check=None):
            return {
                'status': 'INFEASIBLE',
                'plan_lines': [],
                'kpis': {},
                'solver_meta': {'status': 'INFEASIBLE', 'termination_reason': 'INFEASIBLE',
                                'solve_time_ms': 10, 'time_limit_seconds': 0.2,
                                'random_seed': 42, 'num_search_workers': 1},
                'infeasible_reasons': ['No demand data provided'],
            }

        with patch('ml.api.async_runs.solve_planning_contract', side_effect=_mock_solver):
            worker.run_once()
        status = service.get_job_status(submit.job_id)

        self.assertEqual(status.status, 'succeeded')
        self.assertEqual(status.lifecycle_status, 'SUCCEEDED')
        self.assertEqual(status.planning_status, 'INFEASIBLE')
        self.assertEqual((status.result_payload or {}).get('status'), 'INFEASIBLE')
        self.assertTrue(status.warnings)
        self.assertTrue((status.result_payload or {}).get('infeasible_reasons'))

    def test_async_planning_timeout_is_reported(self):
        config = AsyncRunConfig(step_sleep_slice_seconds=0.01)
        store = InMemoryAsyncRunStore()
        service = AsyncRunService(store=store, config=config)
        worker = AsyncRunWorker(store=store, config=config)

        payload = _build_planning_payload(horizon_days=14, time_limit_seconds=0.00001, include_demand=True)
        payload.setdefault('settings', {}).setdefault('solver', {})['force_timeout'] = True
        submit = service.submit(
            _build_planning_async_request(
                contract_template_id=183,
                dataset_fingerprint=f'fp::planning::timeout::{time.time_ns()}',
                planning_payload=payload,
                max_attempts=1,
            )
        )

        def _mock_solver(_request_ns, cancel_check=None):
            return {
                'status': 'TIMEOUT',
                'plan_lines': [],
                'kpis': {},
                'solver_meta': {'status': 'TIMEOUT', 'termination_reason': 'FORCED_TIMEOUT',
                                'solve_time_ms': 0, 'time_limit_seconds': 0.00001,
                                'random_seed': 42, 'num_search_workers': 1},
                'infeasible_reasons': [],
            }

        with patch('ml.api.async_runs.solve_planning_contract', side_effect=_mock_solver):
            worker.run_once()
        status = service.get_job_status(submit.job_id)

        self.assertEqual(status.status, 'succeeded')
        self.assertEqual(status.lifecycle_status, 'SUCCEEDED')
        self.assertEqual(status.planning_status, 'TIMEOUT')
        self.assertEqual(status.planning_termination_reason, 'FORCED_TIMEOUT')
        self.assertEqual((status.result_payload or {}).get('status'), 'TIMEOUT')

    def test_async_planning_cancel_during_solving_marks_canceled_and_purges_results(self):
        config = AsyncRunConfig(step_sleep_slice_seconds=0.01)
        store = InMemoryAsyncRunStore()
        service = AsyncRunService(store=store, config=config)
        worker = AsyncRunWorker(store=store, config=config)

        payload = _build_planning_payload(horizon_days=14, time_limit_seconds=10.0, include_demand=True)
        submit = service.submit(
            _build_planning_async_request(
                contract_template_id=184,
                dataset_fingerprint=f'fp::planning::cancel::{time.time_ns()}',
                planning_payload=payload,
                max_attempts=1,
            )
        )

        def _slow_solver(_request_ns, cancel_check=None):
            started = time.monotonic()
            while time.monotonic() - started < 2.0:
                if callable(cancel_check) and cancel_check():
                    return {
                        'status': 'TIMEOUT',
                        'plan_lines': [],
                        'kpis': {},
                        'solver_meta': {
                            'status': 'TIMEOUT',
                            'termination_reason': 'CANCELLED',
                            'solve_time_ms': int((time.monotonic() - started) * 1000),
                            'time_limit_seconds': 10.0,
                            'random_seed': 42,
                            'num_search_workers': 1,
                        },
                        'infeasible_reasons': [],
                    }
                time.sleep(0.02)
            return {
                'status': 'OPTIMAL',
                'plan_lines': [],
                'kpis': {},
                'solver_meta': {
                    'status': 'OPTIMAL',
                    'termination_reason': 'OPTIMAL',
                    'solve_time_ms': int((time.monotonic() - started) * 1000),
                    'time_limit_seconds': 10.0,
                    'random_seed': 42,
                    'num_search_workers': 1,
                },
                'infeasible_reasons': [],
            }

        with patch('ml.api.async_runs.solve_planning_contract', side_effect=_slow_solver):
            thread = threading.Thread(target=worker.run_once)
            thread.start()

            saw_solving_started = False
            for _ in range(120):
                status_probe = service.get_job_status(submit.job_id)
                if any(evt.get('event') == 'solving_started' for evt in (status_probe.events or [])):
                    saw_solving_started = True
                    break
                time.sleep(0.02)
            self.assertTrue(saw_solving_started)

            service.cancel_job(submit.job_id)
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())

        status = service.get_job_status(submit.job_id)
        artifacts = service.get_run_artifacts(submit.run_id)

        self.assertEqual(status.status, 'canceled')
        self.assertEqual(status.lifecycle_status, 'CANCELLED')
        self.assertTrue(status.cancel_requested)
        self.assertIsNone(status.result_payload)
        self.assertEqual(status.planning_status, None)
        self.assertEqual(artifacts, [])

    def test_reuse_skips_cached_compute_steps(self):
        config = AsyncRunConfig(step_sleep_slice_seconds=0.01)
        store = InMemoryAsyncRunStore()
        service = AsyncRunService(store=store, config=config)
        worker = AsyncRunWorker(store=store, config=config)

        first_submit = service.submit(_build_request(contract_template_id=61))
        worker.run_once()
        first_status = service.get_job_status(first_submit.job_id)
        self.assertEqual(first_status.status, 'succeeded')

        second_submit = service.submit(_build_request(contract_template_id=62))
        self.assertNotEqual(second_submit.job_id, first_submit.job_id)
        self.assertNotEqual(second_submit.run_id, first_submit.run_id)

        worker.run_once()
        second_status = service.get_job_status(second_submit.job_id)

        self.assertEqual(second_status.status, 'succeeded')
        self.assertTrue(second_status.run_meta.get('reused_cached_forecast'))
        self.assertTrue(second_status.run_meta.get('reused_cached_plan'))

        steps = service.get_run_steps(second_submit.run_id)
        forecast_step = next(step for step in steps if step['step'] == 'forecast')
        optimize_step = next(step for step in steps if step['step'] == 'optimize')
        self.assertEqual(forecast_step['status'], 'skipped')
        self.assertEqual(optimize_step['status'], 'skipped')


if __name__ == '__main__':
    unittest.main()
