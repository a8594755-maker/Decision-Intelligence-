-- Worker claim columns for server-side task execution.
-- Allows a Node.js worker process to claim and execute tasks
-- independently of the browser, enabling background execution.

ALTER TABLE ai_employee_tasks
  ADD COLUMN IF NOT EXISTS worker_id TEXT,
  ADD COLUMN IF NOT EXISTS worker_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS worker_heartbeat_at TIMESTAMPTZ;

-- Index for finding unclaimed tasks efficiently
CREATE INDEX IF NOT EXISTS idx_tasks_unclaimed
  ON ai_employee_tasks (status)
  WHERE worker_id IS NULL AND status IN ('queued', 'in_progress');

-- Index for stale heartbeat detection (worker crash recovery)
CREATE INDEX IF NOT EXISTS idx_tasks_stale_heartbeat
  ON ai_employee_tasks (worker_heartbeat_at)
  WHERE worker_id IS NOT NULL AND status = 'in_progress';

COMMENT ON COLUMN ai_employee_tasks.worker_id IS 'ID of the worker process that claimed this task (null = unclaimed)';
COMMENT ON COLUMN ai_employee_tasks.worker_claimed_at IS 'When the worker claimed this task';
COMMENT ON COLUMN ai_employee_tasks.worker_heartbeat_at IS 'Last heartbeat from the worker (stale after 60s = reclaimable)';
