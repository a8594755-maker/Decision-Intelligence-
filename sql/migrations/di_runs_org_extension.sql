-- ============================================================
-- Extend di_runs with organization concept
-- Allows same-org members to see each other's plan runs
-- ============================================================

ALTER TABLE di_runs ADD COLUMN IF NOT EXISTS
  org_id UUID REFERENCES organizations(id);

ALTER TABLE di_runs ADD COLUMN IF NOT EXISTS
  visibility TEXT DEFAULT 'private'
  CHECK (visibility IN ('private','org','public'));
-- private = only owner can see (V1 default behaviour)
-- org     = all org members can see
-- public  = future expansion

-- Update RLS: let org members also see org-visible runs
-- Note: original "user can see own runs" policy is preserved

CREATE POLICY "org_members_can_view_org_runs"
  ON di_runs FOR SELECT
  USING (
    visibility = 'org'
    AND org_id IN (
      SELECT org_id FROM org_members WHERE user_id = auth.uid()
    )
  );
