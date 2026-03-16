-- ============================================================================
-- KPI Continuous Monitoring — Phase 4
-- Tables: kpi_watch_rules, kpi_breach_log
-- ============================================================================

-- ── kpi_watch_rules ───────────────────────────────────────────────────────
-- Defines KPI monitoring rules. The KPI monitor daemon periodically evaluates
-- each enabled rule and writes breaches to event_queue for task creation.

CREATE TABLE IF NOT EXISTS kpi_watch_rules (
  id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name                    TEXT NOT NULL,
  metric_type             TEXT NOT NULL,
  entity_filter           JSONB NOT NULL DEFAULT '{}',
  threshold_type          TEXT NOT NULL DEFAULT 'below'
                            CHECK (threshold_type IN ('below', 'above', 'drift', 'outside_range')),
  threshold_value         NUMERIC NOT NULL,
  threshold_upper         NUMERIC,
  severity                TEXT NOT NULL DEFAULT 'medium'
                            CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  worker_id               UUID,
  check_interval_minutes  INTEGER NOT NULL DEFAULT 60,
  cooldown_minutes        INTEGER NOT NULL DEFAULT 240,
  enabled                 BOOLEAN NOT NULL DEFAULT true,
  last_checked_at         TIMESTAMPTZ,
  last_breached_at        TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kpi_watch_rules_enabled ON kpi_watch_rules (enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_kpi_watch_rules_metric ON kpi_watch_rules (metric_type);

-- ── kpi_breach_log ────────────────────────────────────────────────────────
-- Immutable log of every KPI breach detected. Links to event_queue entries
-- and resulting tasks for full traceability.

CREATE TABLE IF NOT EXISTS kpi_breach_log (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  rule_id           UUID NOT NULL REFERENCES kpi_watch_rules(id) ON DELETE CASCADE,
  metric_type       TEXT NOT NULL,
  metric_value      NUMERIC NOT NULL,
  threshold_value   NUMERIC NOT NULL,
  threshold_type    TEXT NOT NULL,
  severity          TEXT NOT NULL,
  entity_filter     JSONB NOT NULL DEFAULT '{}',
  event_id          UUID,
  task_id           UUID,
  resolved          BOOLEAN NOT NULL DEFAULT false,
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kpi_breach_log_rule ON kpi_breach_log (rule_id);
CREATE INDEX IF NOT EXISTS idx_kpi_breach_log_created ON kpi_breach_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kpi_breach_log_unresolved ON kpi_breach_log (resolved) WHERE resolved = false;

-- ── RLS ───────────────────────────────────────────────────────────────────

ALTER TABLE kpi_watch_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE kpi_breach_log ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users (same as event_queue pattern)
CREATE POLICY "kpi_watch_rules_all" ON kpi_watch_rules
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "kpi_breach_log_all" ON kpi_breach_log
  FOR ALL USING (true) WITH CHECK (true);
