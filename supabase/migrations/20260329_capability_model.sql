-- Migration: Add Capability Model + Worker Templates
-- Date: 2026-03-29
-- P2-1: Platform-level capability abstraction

-- Worker Templates: defines worker types and their capability bindings
CREATE TABLE IF NOT EXISTS worker_templates (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT DEFAULT '',
  allowed_capabilities TEXT[] NOT NULL DEFAULT '{}',
  default_autonomy TEXT NOT NULL DEFAULT 'A1',
  max_autonomy     TEXT NOT NULL DEFAULT 'A4',
  is_active        BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Capability Policies: per-capability governance rules (overrides defaults)
CREATE TABLE IF NOT EXISTS capability_policies (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  capability_class      TEXT NOT NULL,
  capability_id         TEXT,                -- null = class-level default
  approval_required     BOOLEAN DEFAULT false,
  min_autonomy_level    TEXT DEFAULT 'A1',
  auto_approve_at       TEXT DEFAULT 'A3',
  review_required       BOOLEAN DEFAULT true,
  max_retry             INT DEFAULT 3,
  data_access           TEXT DEFAULT 'read', -- 'read' | 'read_write'
  sensitive_data_allowed BOOLEAN DEFAULT false,
  budget_tier           TEXT DEFAULT 'tier_b',
  org_id                UUID,               -- null = global default
  is_active             BOOLEAN DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Worker Capability Profile: per-worker capability-specific autonomy overrides
CREATE TABLE IF NOT EXISTS worker_capability_profiles (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  employee_id      UUID NOT NULL,
  capability_class TEXT NOT NULL,
  autonomy_level   TEXT NOT NULL DEFAULT 'A1',
  tasks_completed  INT DEFAULT 0,
  first_pass_rate  REAL DEFAULT 0,
  last_evaluated   TIMESTAMPTZ,
  is_active        BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(employee_id, capability_class)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_cap_policies_class ON capability_policies(capability_class);
CREATE INDEX IF NOT EXISTS idx_cap_profiles_employee ON worker_capability_profiles(employee_id);
CREATE INDEX IF NOT EXISTS idx_cap_profiles_class ON worker_capability_profiles(capability_class);
CREATE INDEX IF NOT EXISTS idx_worker_templates_active ON worker_templates(is_active) WHERE is_active = true;

-- RLS
ALTER TABLE worker_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE capability_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_capability_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read templates"
  ON worker_templates FOR SELECT USING (true);

CREATE POLICY "Authenticated users can read policies"
  ON capability_policies FOR SELECT USING (true);

CREATE POLICY "Workers can access own profiles"
  ON worker_capability_profiles FOR ALL USING (true) WITH CHECK (true);

-- Seed default templates
INSERT INTO worker_templates (id, name, description, allowed_capabilities, default_autonomy, max_autonomy) VALUES
  ('supply_chain_analyst', 'Supply Chain Analyst', 'Full-scope supply chain planning, forecasting, and risk analysis',
   ARRAY['planning','analysis','reporting','synthesis','custom_code','monitoring'], 'A1', 'A4'),
  ('procurement_specialist', 'Procurement Specialist', 'Negotiation support, supplier analysis, and procurement workflows',
   ARRAY['negotiation','analysis','reporting','synthesis'], 'A1', 'A3'),
  ('data_analyst', 'Data Analyst', 'General-purpose data analysis, reporting, and custom tooling',
   ARRAY['analysis','reporting','synthesis','custom_code'], 'A1', 'A4'),
  ('operations_coordinator', 'Operations Coordinator', 'Integration, monitoring, and cross-system coordination',
   ARRAY['integration','monitoring','reporting','synthesis'], 'A1', 'A3')
ON CONFLICT (id) DO NOTHING;
