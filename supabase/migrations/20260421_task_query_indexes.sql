-- Speed up listTasks / listTasksByUser queries that were causing statement timeouts
CREATE INDEX IF NOT EXISTS idx_ai_employee_tasks_employee_created
ON ai_employee_tasks (employee_id, created_at DESC);

-- Speed up listTasksByStatus queries
CREATE INDEX IF NOT EXISTS idx_ai_employee_tasks_employee_status_created
ON ai_employee_tasks (employee_id, status, created_at DESC);
