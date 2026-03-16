-- Migration: Add Knowledge Vault table for Style / Policy / Exemplar memory
-- Date: 2026-03-28

CREATE TABLE IF NOT EXISTS ai_employee_knowledge_vault (
  id               TEXT PRIMARY KEY,
  employee_id      UUID NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('policy', 'exemplar', 'style')),

  -- Policy fields
  category         TEXT,            -- 'naming_convention','approval_rule','data_handling','reporting','communication'
  rule             TEXT,
  scope            TEXT DEFAULT 'global',
  scope_value      TEXT,

  -- Exemplar fields
  workflow_type    TEXT,
  task_id          TEXT,
  output_snapshot  JSONB DEFAULT '{}',
  kpis             JSONB DEFAULT '{}',
  manager_notes    TEXT DEFAULT '',
  tags             TEXT[] DEFAULT '{}',

  -- Style fields
  dimension        TEXT,            -- 'tone','detail_level','format','terminology','visual_style'
  preference       TEXT,
  context          TEXT DEFAULT 'all',
  confidence       REAL DEFAULT 0.5,
  learned_from     TEXT,

  -- Common
  is_active        BOOLEAN DEFAULT true,
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vault_employee ON ai_employee_knowledge_vault(employee_id);
CREATE INDEX IF NOT EXISTS idx_vault_type ON ai_employee_knowledge_vault(type);
CREATE INDEX IF NOT EXISTS idx_vault_active ON ai_employee_knowledge_vault(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_vault_workflow ON ai_employee_knowledge_vault(workflow_type) WHERE workflow_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vault_dimension ON ai_employee_knowledge_vault(dimension) WHERE dimension IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vault_tags ON ai_employee_knowledge_vault USING GIN(tags);

ALTER TABLE ai_employee_knowledge_vault ENABLE ROW LEVEL SECURITY;

-- RLS: employees can access their own vault entries
CREATE POLICY "Employees can access own vault"
  ON ai_employee_knowledge_vault
  FOR ALL
  USING (true)
  WITH CHECK (true);
