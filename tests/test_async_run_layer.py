import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from ml.api.async_runs import (  # noqa: E402
    AsyncRunConfig,
    AsyncRunService,
    AsyncRunSubmitRequest,
    AsyncRunWorker,
    InMemoryAsyncRunStore,
)


def _build_request(contract_template_id: int = 11, engine_flags=None, max_attempts=None):
    return AsyncRunSubmitRequest(
        user_id='00000000-0000-0000-0000-000000000001',
        dataset_profile_id=101,
        dataset_fingerprint='fp::dataset::alpha',
        contract_template_id=contract_template_id,
        workflow='workflow_A_replenishment',
        engine_flags=engine_flags or {},
        settings={
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
        self.assertEqual(status.run_status, 'succeeded')
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
        self.assertTrue(status.cancel_requested)
        self.assertTrue(any(step.status == 'canceled' for step in status.step_summary))

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
