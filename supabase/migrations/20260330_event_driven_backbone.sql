-- ============================================================================
-- Event-Driven Backbone — Phase 2
-- Tables: event_queue, event_rules
-- ============================================================================

-- ── event_queue ─────────────────────────────────────────────────────────────
-- Receives events from external systems, KPI monitors, webhooks, and manual triggers.
-- Processed by the event loop background task.

CREATE TABLE IF NOT EXISTS event_queue (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type      TEXT NOT NULL,
  source_system   TEXT NOT NULL DEFAULT 'internal',
  payload         JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'matched', 'ignored', 'processed', 'failed')),
  worker_id       UUID,
  processed_task_id UUID,
  error_message   TEXT,
  signature       TEXT,  -- HMAC signature for external events
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ
);

-- Indexes for the event loop poller
CREATE INDEX IF NOT EXISTS idx_event_queue_status ON event_queue (status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_event_queue_type ON event_queue (event_type);
CREATE INDEX IF NOT EXISTS idx_event_queue_created ON event_queue (created_at DESC);

-- ── event_rules ─────────────────────────────────────────────────────────────
-- Defines which events trigger task creation, for which worker, using which template.

CREATE TABLE IF NOT EXISTS event_rules (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name                TEXT NOT NULL,
  event_type_pattern  TEXT NOT NULL,          -- glob or exact match (e.g., 'supplier_*', 'inventory_below_threshold')
  condition_json      JSONB NOT NULL DEFAULT '{}',  -- payload conditions (e.g., {"severity": "high"})
  target_worker_id    UUID,                   -- which worker to assign
  task_template_id    UUID,                   -- which template to use
  intent_type         TEXT,                   -- DWO intent_type override
  business_domain     TEXT DEFAULT 'supply_planning',
  cooldown_seconds    INTEGER NOT NULL DEFAULT 300,  -- 5 min default cooldown
  enabled             BOOLEAN NOT NULL DEFAULT true,
  priority            INTEGER NOT NULL DEFAULT 0,    -- higher = checked first
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_rules_enabled ON event_rules (enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_event_rules_type ON event_rules (event_type_pattern);

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE event_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_rules ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read; server writes via service role
CREATE POLICY "event_queue_read" ON event_queue FOR SELECT USING (true);
CREATE POLICY "event_queue_insert" ON event_queue FOR INSERT WITH CHECK (true);
CREATE POLICY "event_queue_update" ON event_queue FOR UPDATE USING (true);

CREATE POLICY "event_rules_read" ON event_rules FOR SELECT USING (true);
CREATE POLICY "event_rules_insert" ON event_rules FOR INSERT WITH CHECK (true);
CREATE POLICY "event_rules_update" ON event_rules FOR UPDATE USING (true);
CREATE POLICY "event_rules_delete" ON event_rules FOR DELETE USING (true);
