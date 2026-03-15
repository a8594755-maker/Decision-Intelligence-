-- =============================================================
-- Style Learning Pipeline — Onboarding & Continuous Learning
-- =============================================================
-- Tables:
--   1. style_profiles        — aggregated style fingerprints per doc_type + team
--   2. style_exemplars       — approved output examples with extracted skeleton
--   3. style_policies        — company/team policies, glossary, KPI definitions
--   4. style_feedback_rules  — rules extracted from manager revision patterns
--   5. style_ingestion_jobs  — batch ingestion job tracking
--   6. trust_metrics         — per-employee trust & autonomy metrics
-- =============================================================

-- 1. Style Profiles — aggregated style fingerprints
CREATE TABLE IF NOT EXISTS style_profiles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID REFERENCES ai_employees(id) ON DELETE CASCADE,
  team_id       TEXT,                          -- logical team grouping
  doc_type      TEXT NOT NULL,                 -- e.g. 'mbr_report', 'weekly_report', 'ad_hoc_analysis'
  profile_name  TEXT NOT NULL,
  sample_count  INTEGER DEFAULT 0,
  confidence    NUMERIC(3,2) DEFAULT 0.00,     -- 0.00–1.00 style consistency score

  -- Aggregated canonical style (JSONB)
  canonical_structure   JSONB DEFAULT '{}',    -- sheet layout, sections, ordering
  canonical_formatting  JSONB DEFAULT '{}',    -- colors, fonts, number formats
  canonical_charts      JSONB DEFAULT '{}',    -- chart types, palettes, labels
  canonical_kpi_layout  JSONB DEFAULT '{}',    -- KPI placement, card style, conditionals
  canonical_text_style  JSONB DEFAULT '{}',    -- language, tone, bullet style, phrases

  -- Variance tracking
  high_variance_dims    TEXT[] DEFAULT '{}',   -- dimensions with low consistency
  exemplar_refs         UUID[] DEFAULT '{}',   -- top exemplar IDs

  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),

  UNIQUE (employee_id, team_id, doc_type)
);

CREATE INDEX idx_style_profiles_lookup
  ON style_profiles (employee_id, doc_type);

-- 2. Style Exemplars — approved output examples
CREATE TABLE IF NOT EXISTS style_exemplars (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID REFERENCES ai_employees(id) ON DELETE CASCADE,
  team_id       TEXT,
  doc_type      TEXT NOT NULL,
  source_type   TEXT NOT NULL DEFAULT 'upload',  -- 'upload', 'task_output', 'manual'

  -- Metadata
  title         TEXT,
  description   TEXT,
  source_file   TEXT,                          -- original filename
  source_task_id UUID,                         -- if from a task output

  -- Extracted style features (same shape as style_profiles canonical_*)
  structure_fingerprint   JSONB DEFAULT '{}',
  formatting_fingerprint  JSONB DEFAULT '{}',
  charts_fingerprint      JSONB DEFAULT '{}',
  kpi_layout_fingerprint  JSONB DEFAULT '{}',
  text_style_fingerprint  JSONB DEFAULT '{}',

  -- Skeleton (structure without data — for few-shot injection)
  skeleton      JSONB DEFAULT '{}',

  -- Quality
  approved_by   UUID REFERENCES auth.users(id),
  approved_at   TIMESTAMPTZ,
  quality_score NUMERIC(3,2) DEFAULT 0.50,
  usage_count   INTEGER DEFAULT 0,

  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_style_exemplars_lookup
  ON style_exemplars (employee_id, doc_type);
CREATE INDEX idx_style_exemplars_quality
  ON style_exemplars (quality_score DESC);

-- 3. Style Policies — company/team knowledge base
CREATE TABLE IF NOT EXISTS style_policies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID REFERENCES ai_employees(id) ON DELETE CASCADE,
  team_id       TEXT,
  policy_type   TEXT NOT NULL,                 -- 'glossary', 'naming_convention', 'kpi_definition',
                                               -- 'formatting_rule', 'tone_guide', 'prohibited_terms',
                                               -- 'sop', 'template_rule', 'custom'
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,                 -- the policy rule in natural language
  structured    JSONB DEFAULT '{}',            -- optional structured representation

  -- Applicability
  applies_to_doc_types TEXT[] DEFAULT '{}',    -- empty = all doc types
  priority      INTEGER DEFAULT 0,             -- higher = more important
  active        BOOLEAN DEFAULT true,

  -- Provenance
  source        TEXT DEFAULT 'manual',         -- 'manual', 'extracted', 'handbook_upload'
  source_file   TEXT,
  created_by    UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_style_policies_lookup
  ON style_policies (employee_id, policy_type, active);

-- 4. Style Feedback Rules — extracted from manager revision patterns
CREATE TABLE IF NOT EXISTS style_feedback_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID REFERENCES ai_employees(id) ON DELETE CASCADE,
  team_id       TEXT,

  -- Rule
  rule_type     TEXT NOT NULL,                 -- 'structure', 'formatting', 'wording', 'data', 'kpi', 'chart', 'tone'
  rule_text     TEXT NOT NULL,                 -- natural language rule
  rule_structured JSONB DEFAULT '{}',          -- machine-readable version

  -- Evidence
  evidence_count    INTEGER DEFAULT 1,         -- how many revisions support this rule
  evidence_task_ids UUID[] DEFAULT '{}',       -- source tasks
  confidence        NUMERIC(3,2) DEFAULT 0.50,

  -- Lifecycle
  auto_extracted    BOOLEAN DEFAULT true,      -- false = manually added
  verified_by       UUID REFERENCES auth.users(id),
  verified_at       TIMESTAMPTZ,
  active            BOOLEAN DEFAULT true,

  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_style_feedback_rules_lookup
  ON style_feedback_rules (employee_id, rule_type, active);

-- 5. Style Ingestion Jobs — batch processing tracker
CREATE TABLE IF NOT EXISTS style_ingestion_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID REFERENCES ai_employees(id) ON DELETE CASCADE,
  job_type      TEXT NOT NULL,                 -- 'bulk_excel', 'handbook', 'exemplar_batch', 'feedback_extraction'

  -- Progress
  status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'processing', 'completed', 'failed'
  total_files   INTEGER DEFAULT 0,
  processed     INTEGER DEFAULT 0,
  failed        INTEGER DEFAULT 0,
  error_log     JSONB DEFAULT '[]',

  -- Config
  config        JSONB DEFAULT '{}',            -- job-specific config (folder path, filters, etc.)
  result        JSONB DEFAULT '{}',            -- job result summary

  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_by    UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_style_ingestion_jobs_status
  ON style_ingestion_jobs (employee_id, status);

-- 6. Trust Metrics — per-employee trust & autonomy scores
CREATE TABLE IF NOT EXISTS trust_metrics (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         UUID REFERENCES ai_employees(id) ON DELETE CASCADE,
  period_start        DATE NOT NULL,
  period_end          DATE NOT NULL,

  -- Core trust metrics
  first_pass_acceptance_rate  NUMERIC(5,4),    -- 0.0000–1.0000
  manager_edit_distance       NUMERIC(5,4),    -- avg normalized edit distance
  revision_rate               NUMERIC(5,4),    -- % tasks needing revision
  policy_violation_rate       NUMERIC(5,4),    -- % steps violating policies

  -- Autonomy metrics
  autonomy_level              TEXT DEFAULT 'A1', -- A1/A2/A3/A4
  auto_approved_rate          NUMERIC(5,4),    -- % tasks auto-approved (no human review)
  escalation_rate             NUMERIC(5,4),    -- % tasks escalated

  -- Quality metrics
  avg_review_score            NUMERIC(5,2),    -- 0–100 from ai_review_results
  style_compliance_score      NUMERIC(5,4),    -- how well output matches style profile
  artifact_completeness_rate  NUMERIC(5,4),    -- % tasks with all expected artifacts

  -- Volume
  tasks_completed             INTEGER DEFAULT 0,
  tasks_failed                INTEGER DEFAULT 0,
  total_steps_executed        INTEGER DEFAULT 0,

  -- Breakdown by doc type (JSONB)
  metrics_by_doc_type         JSONB DEFAULT '{}',

  created_at    TIMESTAMPTZ DEFAULT now(),

  UNIQUE (employee_id, period_start, period_end)
);

CREATE INDEX idx_trust_metrics_lookup
  ON trust_metrics (employee_id, period_end DESC);

-- =============================================================
-- RLS Policies
-- =============================================================

ALTER TABLE style_profiles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE style_exemplars      ENABLE ROW LEVEL SECURITY;
ALTER TABLE style_policies       ENABLE ROW LEVEL SECURITY;
ALTER TABLE style_feedback_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE style_ingestion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_metrics        ENABLE ROW LEVEL SECURITY;

-- Manager of employee can manage all style tables
CREATE POLICY "manager_style_profiles" ON style_profiles
  FOR ALL USING (
    employee_id IN (SELECT id FROM ai_employees WHERE manager_user_id = auth.uid())
  );

CREATE POLICY "manager_style_exemplars" ON style_exemplars
  FOR ALL USING (
    employee_id IN (SELECT id FROM ai_employees WHERE manager_user_id = auth.uid())
  );

CREATE POLICY "manager_style_policies" ON style_policies
  FOR ALL USING (
    employee_id IN (SELECT id FROM ai_employees WHERE manager_user_id = auth.uid())
  );

CREATE POLICY "manager_style_feedback_rules" ON style_feedback_rules
  FOR ALL USING (
    employee_id IN (SELECT id FROM ai_employees WHERE manager_user_id = auth.uid())
  );

CREATE POLICY "manager_style_ingestion_jobs" ON style_ingestion_jobs
  FOR ALL USING (
    employee_id IN (SELECT id FROM ai_employees WHERE manager_user_id = auth.uid())
  );

CREATE POLICY "manager_trust_metrics" ON trust_metrics
  FOR ALL USING (
    employee_id IN (SELECT id FROM ai_employees WHERE manager_user_id = auth.uid())
  );

-- Service role bypass for server-side operations
CREATE POLICY "service_style_profiles" ON style_profiles
  FOR ALL USING (current_setting('request.headers', true)::json->>'x-di-server' = 'true');

CREATE POLICY "service_style_exemplars" ON style_exemplars
  FOR ALL USING (current_setting('request.headers', true)::json->>'x-di-server' = 'true');

CREATE POLICY "service_style_policies" ON style_policies
  FOR ALL USING (current_setting('request.headers', true)::json->>'x-di-server' = 'true');

CREATE POLICY "service_style_feedback_rules" ON style_feedback_rules
  FOR ALL USING (current_setting('request.headers', true)::json->>'x-di-server' = 'true');

CREATE POLICY "service_style_ingestion_jobs" ON style_ingestion_jobs
  FOR ALL USING (current_setting('request.headers', true)::json->>'x-di-server' = 'true');

CREATE POLICY "service_trust_metrics" ON trust_metrics
  FOR ALL USING (current_setting('request.headers', true)::json->>'x-di-server' = 'true');

-- Trigger for updated_at
CREATE TRIGGER set_updated_at_style_profiles
  BEFORE UPDATE ON style_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_updated_at_style_exemplars
  BEFORE UPDATE ON style_exemplars
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_updated_at_style_policies
  BEFORE UPDATE ON style_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_updated_at_style_feedback_rules
  BEFORE UPDATE ON style_feedback_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
