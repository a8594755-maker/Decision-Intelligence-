-- =============================================================
-- Company Output Profiles — Versioned learned house style
-- =============================================================
-- Tables:
--   1. company_output_profiles           — approved baseline versions
--   2. company_output_profile_proposals  — improvement proposals pending approval
-- =============================================================

CREATE TABLE IF NOT EXISTS company_output_profiles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id           UUID REFERENCES ai_employees(id) ON DELETE CASCADE,
  team_id               TEXT,
  doc_type              TEXT NOT NULL,
  profile_name          TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status                TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'active', 'superseded', 'archived')),

  base_profile_id       UUID REFERENCES company_output_profiles(id) ON DELETE SET NULL,
  source_style_profile_id UUID REFERENCES style_profiles(id) ON DELETE SET NULL,

  deliverable_type      TEXT,
  audience              TEXT,
  format                TEXT,
  channel               TEXT,

  sample_count          INTEGER DEFAULT 0,
  confidence            NUMERIC(3,2) DEFAULT 0.00,
  high_variance_dims    TEXT[] DEFAULT '{}',

  canonical_structure   JSONB DEFAULT '{}',
  canonical_formatting  JSONB DEFAULT '{}',
  canonical_charts      JSONB DEFAULT '{}',
  canonical_kpi_layout  JSONB DEFAULT '{}',
  canonical_text_style  JSONB DEFAULT '{}',

  change_summary        TEXT,
  approved_by           UUID REFERENCES auth.users(id),
  approved_at           TIMESTAMPTZ,
  activated_at          TIMESTAMPTZ,
  created_by            UUID REFERENCES auth.users(id),
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_output_profiles_version
  ON company_output_profiles (employee_id, COALESCE(team_id, ''), doc_type, version);

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_output_profiles_active
  ON company_output_profiles (employee_id, COALESCE(team_id, ''), doc_type)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_company_output_profiles_lookup
  ON company_output_profiles (employee_id, doc_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS company_output_profile_proposals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id           UUID REFERENCES ai_employees(id) ON DELETE CASCADE,
  team_id               TEXT,
  doc_type              TEXT NOT NULL,
  proposal_name         TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending_approval'
                         CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected')),

  base_profile_id       UUID REFERENCES company_output_profiles(id) ON DELETE SET NULL,
  source_style_profile_id UUID REFERENCES style_profiles(id) ON DELETE SET NULL,
  proposed_version      INTEGER NOT NULL CHECK (proposed_version > 0),

  deliverable_type      TEXT,
  audience              TEXT,
  format                TEXT,
  channel               TEXT,

  rationale             TEXT,
  proposed_changes      JSONB DEFAULT '{}',
  comparison_summary    JSONB DEFAULT '{}',
  candidate_profile     JSONB DEFAULT '{}',
  source_task_id        TEXT,
  source_review_id      TEXT,
  source_run_id         TEXT,

  requested_by          UUID REFERENCES auth.users(id),
  requested_at          TIMESTAMPTZ DEFAULT now(),
  reviewed_by           UUID REFERENCES auth.users(id),
  reviewed_at           TIMESTAMPTZ,
  review_comment        TEXT,
  activated_profile_id  UUID REFERENCES company_output_profiles(id) ON DELETE SET NULL,

  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_output_profile_proposals_lookup
  ON company_output_profile_proposals (employee_id, doc_type, status, created_at DESC);

INSERT INTO company_output_profiles (
  employee_id,
  team_id,
  doc_type,
  profile_name,
  version,
  status,
  base_profile_id,
  source_style_profile_id,
  deliverable_type,
  audience,
  format,
  channel,
  sample_count,
  confidence,
  high_variance_dims,
  canonical_structure,
  canonical_formatting,
  canonical_charts,
  canonical_kpi_layout,
  canonical_text_style,
  change_summary,
  approved_by,
  approved_at,
  activated_at,
  created_by,
  created_at,
  updated_at
)
SELECT
  sp.employee_id,
  sp.team_id,
  sp.doc_type,
  COALESCE(NULLIF(sp.profile_name, ''), sp.doc_type || '_baseline'),
  1,
  'active',
  NULL,
  sp.id,
  NULL,
  NULL,
  NULL,
  NULL,
  COALESCE(sp.sample_count, 0),
  COALESCE(sp.confidence, 0),
  COALESCE(sp.high_variance_dims, '{}'),
  COALESCE(sp.canonical_structure, '{}'),
  COALESCE(sp.canonical_formatting, '{}'),
  COALESCE(sp.canonical_charts, '{}'),
  COALESCE(sp.canonical_kpi_layout, '{}'),
  COALESCE(sp.canonical_text_style, '{}'),
  'Seeded from legacy style profile',
  NULL,
  NULL,
  COALESCE(sp.updated_at, sp.created_at, now()),
  NULL,
  COALESCE(sp.created_at, now()),
  COALESCE(sp.updated_at, sp.created_at, now())
FROM style_profiles sp
WHERE NOT EXISTS (
  SELECT 1
  FROM company_output_profiles cop
  WHERE cop.employee_id = sp.employee_id
    AND cop.doc_type = sp.doc_type
    AND cop.version = 1
    AND cop.team_id IS NOT DISTINCT FROM sp.team_id
);

ALTER TABLE company_output_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_output_profile_proposals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "manager_company_output_profiles" ON company_output_profiles
  FOR ALL USING (
    employee_id IN (SELECT id FROM ai_employees WHERE manager_user_id = auth.uid())
  );

CREATE POLICY "manager_company_output_profile_proposals" ON company_output_profile_proposals
  FOR ALL USING (
    employee_id IN (SELECT id FROM ai_employees WHERE manager_user_id = auth.uid())
  );

CREATE POLICY "service_company_output_profiles" ON company_output_profiles
  FOR ALL USING (current_setting('request.headers', true)::json->>'x-di-server' = 'true');

CREATE POLICY "service_company_output_profile_proposals" ON company_output_profile_proposals
  FOR ALL USING (current_setting('request.headers', true)::json->>'x-di-server' = 'true');

CREATE TRIGGER set_updated_at_company_output_profiles
  BEFORE UPDATE ON company_output_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_updated_at_company_output_profile_proposals
  BEFORE UPDATE ON company_output_profile_proposals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
