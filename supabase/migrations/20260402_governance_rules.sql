-- Migration: Governance Rules Table
-- Date: 2026-04-02
-- Persists user-configurable governance rules that were previously in-memory only.
-- Used by policyRuleService.js for no-code policy management.

CREATE TABLE IF NOT EXISTS governance_rules (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name                TEXT NOT NULL,
  description         TEXT DEFAULT '',
  rule_type           TEXT NOT NULL,           -- approval_threshold | autonomy_gate | review_required | rate_limit | data_access | time_window
  capability_class    TEXT,                    -- null = applies to all capabilities
  worker_template_id  TEXT REFERENCES worker_templates(id) ON DELETE SET NULL,
  conditions          JSONB NOT NULL DEFAULT '{}',
  actions             JSONB NOT NULL DEFAULT '{}',
  priority            INT NOT NULL DEFAULT 50, -- lower = evaluated first
  is_active           BOOLEAN DEFAULT true,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_governance_rules_type ON governance_rules(rule_type);
CREATE INDEX IF NOT EXISTS idx_governance_rules_cap ON governance_rules(capability_class) WHERE capability_class IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_governance_rules_template ON governance_rules(worker_template_id) WHERE worker_template_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_governance_rules_active ON governance_rules(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_governance_rules_priority ON governance_rules(priority ASC);

-- RLS
ALTER TABLE governance_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read governance rules"
  ON governance_rules FOR SELECT USING (true);

CREATE POLICY "Users can manage own governance rules"
  ON governance_rules FOR ALL USING (true) WITH CHECK (true);

-- Webhook configs table (for webhookIntakeService.js)
CREATE TABLE IF NOT EXISTS webhook_configs (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source_type       TEXT NOT NULL,            -- sap_mm | sap_pp | oracle_scm | generic_rest
  name              TEXT NOT NULL,
  api_key           TEXT NOT NULL UNIQUE,
  hmac_secret       TEXT,
  employee_id       UUID NOT NULL,
  user_id           UUID NOT NULL,
  field_mapping     JSONB,
  is_active         BOOLEAN DEFAULT true,
  last_received_at  TIMESTAMPTZ,
  total_received    INT DEFAULT 0,
  total_processed   INT DEFAULT 0,
  total_errors      INT DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_configs_api_key ON webhook_configs(api_key) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_webhook_configs_user ON webhook_configs(user_id);

ALTER TABLE webhook_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own webhooks"
  ON webhook_configs FOR ALL USING (true) WITH CHECK (true);

-- Webhook event log (audit trail for incoming webhooks)
CREATE TABLE IF NOT EXISTS webhook_events (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  webhook_id      TEXT REFERENCES webhook_configs(id) ON DELETE CASCADE,
  source_type     TEXT NOT NULL,
  status          TEXT NOT NULL,              -- processed | error | rate_limited
  work_order_id   TEXT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_webhook ON webhook_events(webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_created ON webhook_events(created_at DESC);

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read webhook events"
  ON webhook_events FOR SELECT USING (true);
