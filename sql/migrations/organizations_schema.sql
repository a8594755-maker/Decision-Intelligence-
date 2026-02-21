-- ============================================================
-- Organizations & Team RBAC Schema
-- SmartOps 2.0 Enterprise Multi-Tenant Permission Design
-- ============================================================

-- 1. Organizations table (top-level multi-tenant isolation unit)
CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,  -- URL-friendly, e.g. "acme-ems"
  plan        TEXT NOT NULL DEFAULT 'standard',  -- 'standard' | 'enterprise'
  settings    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Organization members (user-org relationship + role)
CREATE TABLE IF NOT EXISTS org_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'viewer'
              CHECK (role IN ('admin','approver','planner','analyst','viewer')),
  -- Plant scope: NULL = all plants, non-NULL = restricted to specified plants
  plant_scope TEXT[] DEFAULT NULL,
  -- Dataset scope: NULL = all, specified dataset_profile_id array
  dataset_scope BIGINT[] DEFAULT NULL,
  invited_by  UUID REFERENCES auth.users(id),
  joined_at   TIMESTAMPTZ DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, user_id)
);

-- 3. Plan approval records
CREATE TABLE IF NOT EXISTS plan_approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id),
  run_id          BIGINT NOT NULL,  -- di_runs.id
  requested_by    UUID NOT NULL REFERENCES auth.users(id),
  reviewed_by     UUID REFERENCES auth.users(id),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','withdrawn')),
  -- Plan summary snapshot at submission time (avoids re-query)
  plan_summary    JSONB DEFAULT '{}',
  -- Notes
  requester_note  TEXT,
  reviewer_note   TEXT,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ,
  -- Approval timeout (enterprise SLA)
  expires_at      TIMESTAMPTZ DEFAULT NOW() + INTERVAL '72 hours'
);

-- 4. Audit log (append-only, no UPDATE/DELETE)
CREATE TABLE IF NOT EXISTS plan_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID REFERENCES organizations(id),
  user_id     UUID REFERENCES auth.users(id),
  run_id      BIGINT,
  action      TEXT NOT NULL,
  -- Allowed action values:
  -- plan_run_started / plan_run_completed / plan_approved /
  -- plan_rejected / risk_trigger_approved / risk_trigger_dismissed /
  -- forecast_run_started / data_uploaded / user_role_changed
  actor_role  TEXT,
  payload     JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Indexes
CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org_id  ON org_members(org_id);
CREATE INDEX IF NOT EXISTS idx_plan_approvals_run_id ON plan_approvals(run_id);
CREATE INDEX IF NOT EXISTS idx_plan_approvals_status ON plan_approvals(status);
CREATE INDEX IF NOT EXISTS idx_plan_audit_org_run ON plan_audit_log(org_id, run_id);
CREATE INDEX IF NOT EXISTS idx_plan_audit_created ON plan_audit_log(created_at DESC);

-- ============================================================
-- RLS Policies
-- ============================================================

-- organizations: only members can see their own org
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_members_can_view_their_org"
  ON organizations FOR SELECT
  USING (
    id IN (
      SELECT org_id FROM org_members WHERE user_id = auth.uid()
    )
  );

-- org_members: members can see other members in the same org
ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_members_can_view_same_org"
  ON org_members FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM org_members WHERE user_id = auth.uid()
    )
  );

-- Only admin can manage members
CREATE POLICY "only_org_admin_can_manage_members"
  ON org_members FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM org_members AS m
      WHERE m.org_id = org_members.org_id
        AND m.user_id = auth.uid()
        AND m.role = 'admin'
    )
  );

CREATE POLICY "only_org_admin_can_update_members"
  ON org_members FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM org_members AS m
      WHERE m.org_id = org_members.org_id
        AND m.user_id = auth.uid()
        AND m.role = 'admin'
    )
  );

CREATE POLICY "only_org_admin_can_delete_members"
  ON org_members FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM org_members AS m
      WHERE m.org_id = org_members.org_id
        AND m.user_id = auth.uid()
        AND m.role = 'admin'
    )
  );

-- plan_approvals: same-org members can view
ALTER TABLE plan_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_members_can_view_approvals"
  ON plan_approvals FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM org_members WHERE user_id = auth.uid()
    )
  );

-- Only planner/approver/admin can submit approval requests
CREATE POLICY "planners_can_request_approval"
  ON plan_approvals FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM org_members
      WHERE user_id = auth.uid()
        AND role IN ('planner','approver','admin')
    )
    AND requested_by = auth.uid()
  );

-- Only approver/admin can update (approve/reject)
CREATE POLICY "approvers_can_review"
  ON plan_approvals FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM org_members
      WHERE user_id = auth.uid()
        AND role IN ('approver','admin')
    )
  );

-- plan_audit_log: INSERT only, no UPDATE/DELETE
ALTER TABLE plan_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_log_org_read"
  ON plan_audit_log FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM org_members WHERE user_id = auth.uid()
    )
  );

-- audit_log writes go through service_role (bypasses RLS) via RPC function
-- Frontend cannot write directly, ensuring immutability
