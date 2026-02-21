from __future__ import annotations

from ml.api.async_runs import AsyncRunConfig, AsyncRunWorker, PostgresAsyncRunStore


def main() -> None:
    config = AsyncRunConfig.from_env()
    store = PostgresAsyncRunStore()
    worker = AsyncRunWorker(store=store, config=config)
    print("[di-job-worker] started", {
        "poll_seconds": config.worker_poll_seconds,
        "heartbeat_interval_seconds": config.heartbeat_interval_seconds,
    })
    worker.run_forever()


if __name__ == "__main__":
    main()
