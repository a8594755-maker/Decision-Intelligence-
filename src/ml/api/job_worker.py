from __future__ import annotations

from ml.api.async_runs import AsyncRunConfig, AsyncRunWorker, PostgresAsyncRunStore
from ml.api.solver_telemetry import PostgresSolverTelemetryStore


def main() -> None:
    config = AsyncRunConfig.from_env()
    store = PostgresAsyncRunStore()
    telemetry_store = PostgresSolverTelemetryStore()
    worker = AsyncRunWorker(store=store, config=config, telemetry_store=telemetry_store)
    print("[di-job-worker] started", {
        "poll_seconds": config.worker_poll_seconds,
        "heartbeat_interval_seconds": config.heartbeat_interval_seconds,
    })
    worker.run_forever()


if __name__ == "__main__":
    main()
