-- Async AI proxy tasks — stores results for long-running LLM calls
-- Used by EdgeRuntime.waitUntil() pattern to bypass 150s timeout
CREATE TABLE IF NOT EXISTS ai_proxy_tasks (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  result     JSONB,
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Auto-cleanup: delete tasks older than 1 hour
CREATE INDEX IF NOT EXISTS idx_ai_proxy_tasks_created ON ai_proxy_tasks (created_at);

-- RLS: allow authenticated users to read their tasks
ALTER TABLE ai_proxy_tasks ENABLE ROW LEVEL SECURITY;

-- Server-to-server (service role) can read/write everything
-- Authenticated users can read any task (tasks are ephemeral, no user_id needed)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_proxy_tasks' AND policyname = 'ai_proxy_tasks_read') THEN
    CREATE POLICY ai_proxy_tasks_read ON ai_proxy_tasks FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_proxy_tasks' AND policyname = 'ai_proxy_tasks_insert') THEN
    CREATE POLICY ai_proxy_tasks_insert ON ai_proxy_tasks FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_proxy_tasks' AND policyname = 'ai_proxy_tasks_update') THEN
    CREATE POLICY ai_proxy_tasks_update ON ai_proxy_tasks FOR UPDATE USING (true);
  END IF;
END $$;
