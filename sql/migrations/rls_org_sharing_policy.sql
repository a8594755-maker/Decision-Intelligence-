-- ============================================================
-- Organization-level data sharing RLS policies
-- Makes di_runs visible to same-org members when visibility='org'
-- ============================================================

-- dataset_profiles sharing policy
-- Assumes dataset_profiles has org_id column (add if not present)
ALTER TABLE dataset_profiles ADD COLUMN IF NOT EXISTS
  org_id UUID REFERENCES organizations(id);

CREATE POLICY "org_members_can_view_shared_profiles"
  ON dataset_profiles FOR SELECT
  USING (
    user_id = auth.uid()
    OR
    (
      org_id IS NOT NULL
      AND org_id IN (
        SELECT org_id FROM org_members
        WHERE user_id = auth.uid()
      )
    )
  );
