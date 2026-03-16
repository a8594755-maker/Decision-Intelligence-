-- ============================================================================
-- ROI Tracking — Phase 6
-- Table: value_events
-- ============================================================================

-- ── value_events ──────────────────────────────────────────────────────────
-- Records the measurable value produced by each completed decision task.
-- Used for ROI dashboards, demo evidence, and executive reporting.

CREATE TABLE IF NOT EXISTS value_events (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id               UUID NOT NULL,
  worker_id             UUID,
  value_type            TEXT NOT NULL
                          CHECK (value_type IN (
                            'stockout_prevented',
                            'cost_saved',
                            'time_saved_hours',
                            'revenue_protected',
                            'expedite_avoided',
                            'service_level_improvement',
                            'manual_task_automated'
                          )),
  value_amount          NUMERIC NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'USD',
  confidence            NUMERIC NOT NULL DEFAULT 0.5
                          CHECK (confidence >= 0 AND confidence <= 1),
  calculation_method    TEXT NOT NULL,
  baseline_reference    JSONB NOT NULL DEFAULT '{}',
  evidence_refs         JSONB NOT NULL DEFAULT '[]',
  workflow_type         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_value_events_task ON value_events (task_id);
CREATE INDEX IF NOT EXISTS idx_value_events_worker ON value_events (worker_id);
CREATE INDEX IF NOT EXISTS idx_value_events_type ON value_events (value_type);
CREATE INDEX IF NOT EXISTS idx_value_events_created ON value_events (created_at DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────

ALTER TABLE value_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "value_events_all" ON value_events
  FOR ALL USING (true) WITH CHECK (true);
