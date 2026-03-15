-- ============================================================
-- Excel Ops Queue — command queue for AI Employee → Excel Add-in
-- @product: ai-employee
--
-- The AI agent pushes typed Excel operations (create sheet, write
-- values, format cells, create charts …) into this table. The
-- Excel Add-in polls for pending ops and executes them via
-- Office.js, then reports status back.
-- ============================================================

CREATE TABLE IF NOT EXISTS excel_ops_queue (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     text NOT NULL,
  batch_id    text NOT NULL,
  sequence    integer NOT NULL DEFAULT 0,
  op          text NOT NULL,            -- operation type: create_sheet, write_values, format_cells, …
  target_sheet text,                    -- worksheet name
  range_addr  text,                     -- A1-style range (e.g. "A1:F20")
  payload     jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'pending',  -- pending | executing | succeeded | failed | skipped
  error       text,
  user_id     uuid NOT NULL REFERENCES auth.users(id),
  created_at  timestamptz DEFAULT now(),
  executed_at timestamptz
);

-- Fast lookup: add-in polls for pending ops by user
CREATE INDEX idx_excel_ops_pending
  ON excel_ops_queue (user_id, status, created_at)
  WHERE status = 'pending';

-- Task-level ordering
CREATE INDEX idx_excel_ops_task
  ON excel_ops_queue (task_id, sequence);

-- Batch grouping
CREATE INDEX idx_excel_ops_batch
  ON excel_ops_queue (batch_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE excel_ops_queue ENABLE ROW LEVEL SECURITY;

-- Users can read their own ops
CREATE POLICY excel_ops_select ON excel_ops_queue
  FOR SELECT USING (auth.uid() = user_id);

-- Users can update status of their own ops (add-in reports execution result)
CREATE POLICY excel_ops_update ON excel_ops_queue
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Insert is done server-side (service role) — no user INSERT policy needed
-- But allow authenticated users to insert their own ops (for direct add-in use)
CREATE POLICY excel_ops_insert ON excel_ops_queue
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Service role bypass for server-side inserts
CREATE POLICY excel_ops_service ON excel_ops_queue
  FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE excel_ops_queue IS
  'Command queue: AI Employee pushes Excel operations, Office.js Add-in executes them.';
