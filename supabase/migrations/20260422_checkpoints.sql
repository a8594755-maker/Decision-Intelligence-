-- Checkpoint table for workflow state snapshots.
-- Created after each step completes for time-travel, resume, and replay.

CREATE TABLE IF NOT EXISTS ai_employee_checkpoints (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  task_id         UUID NOT NULL REFERENCES ai_employee_tasks(id) ON DELETE CASCADE,
  step_index      SMALLINT NOT NULL,
  step_name       TEXT,
  task_status     TEXT NOT NULL,
  task_version    INTEGER NOT NULL,
  state_snapshot  JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_task_step
  ON ai_employee_checkpoints(task_id, step_index);

CREATE INDEX IF NOT EXISTS idx_checkpoints_task_created
  ON ai_employee_checkpoints(task_id, created_at DESC);

-- RLS: only the task's assigned user can read checkpoints
ALTER TABLE ai_employee_checkpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY checkpoints_select ON ai_employee_checkpoints
  FOR SELECT USING (
    task_id IN (
      SELECT id FROM ai_employee_tasks
      WHERE assigned_by_user_id = auth.uid()
    )
  );
