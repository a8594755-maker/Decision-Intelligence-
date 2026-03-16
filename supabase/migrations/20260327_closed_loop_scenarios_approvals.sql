-- Migration: Add tables for closed-loop persistence, scenario persistence, and approval workflow
-- Date: 2026-03-27

-- ─── Closed-Loop Runs ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS di_closed_loop_runs (
  id               TEXT PRIMARY KEY,
  dataset_id       TEXT,
  forecast_run_id  TEXT,
  user_id          UUID REFERENCES auth.users(id),
  mode             TEXT NOT NULL DEFAULT 'dry_run' CHECK (mode IN ('dry_run', 'auto_run', 'manual_approve')),
  status           TEXT NOT NULL DEFAULT 'NO_TRIGGER',
  trigger_facts    JSONB DEFAULT '{}',
  trigger_decision TEXT,
  param_patch      JSONB,
  planning_run_id  TEXT,
  planning_run_status TEXT,
  outcome          JSONB,
  cooldown_key     TEXT,
  cooldown_expires_at TIMESTAMPTZ,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cl_runs_dataset ON di_closed_loop_runs(dataset_id);
CREATE INDEX IF NOT EXISTS idx_cl_runs_user ON di_closed_loop_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_cl_runs_status ON di_closed_loop_runs(status);
CREATE INDEX IF NOT EXISTS idx_cl_runs_created ON di_closed_loop_runs(created_at DESC);

ALTER TABLE di_closed_loop_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own closed-loop runs"
  ON di_closed_loop_runs
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─── Scenarios ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS di_scenarios (
  id            TEXT PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES auth.users(id),
  name          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  type          TEXT NOT NULL DEFAULT 'what_if' CHECK (type IN ('what_if', 'strategy_comparison', 'chaos_test', 'parameter_sweep')),
  parameters    JSONB DEFAULT '{}',
  results       JSONB DEFAULT '{}',
  kpis          JSONB DEFAULT '{}',
  baseline_id   TEXT REFERENCES di_scenarios(id),
  tags          TEXT[] DEFAULT '{}',
  is_shared     BOOLEAN DEFAULT false,
  shared_with   UUID[] DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scenarios_user ON di_scenarios(user_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_type ON di_scenarios(type);
CREATE INDEX IF NOT EXISTS idx_scenarios_shared ON di_scenarios(is_shared) WHERE is_shared = true;
CREATE INDEX IF NOT EXISTS idx_scenarios_tags ON di_scenarios USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_scenarios_updated ON di_scenarios(updated_at DESC);

ALTER TABLE di_scenarios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own scenarios"
  ON di_scenarios
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can read shared scenarios"
  ON di_scenarios
  FOR SELECT
  USING (is_shared = true AND auth.uid() = ANY(shared_with));

-- ─── Approval Requests ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS di_approval_requests (
  id              TEXT PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id),
  type            TEXT NOT NULL CHECK (type IN ('plan_commit', 'closed_loop', 'risk_replan', 'negotiation', 'model_promotion')),
  title           TEXT NOT NULL,
  description     TEXT DEFAULT '',
  payload         JSONB DEFAULT '{}',
  urgency         TEXT DEFAULT 'normal' CHECK (urgency IN ('low', 'normal', 'high', 'critical')),
  metadata        JSONB DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  reviewer_id     UUID REFERENCES auth.users(id),
  review_comment  TEXT,
  reviewed_at     TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approvals_user ON di_approval_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON di_approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approvals_type ON di_approval_requests(type);
CREATE INDEX IF NOT EXISTS idx_approvals_created ON di_approval_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approvals_expires ON di_approval_requests(expires_at) WHERE status = 'pending';

ALTER TABLE di_approval_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own approval requests"
  ON di_approval_requests
  FOR ALL
  USING (auth.uid() = user_id OR auth.uid() = reviewer_id)
  WITH CHECK (auth.uid() = user_id);
