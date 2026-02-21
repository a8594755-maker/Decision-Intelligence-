-- ============================================================
-- What-If Analysis / Trade-off Explorer v0
-- di_scenarios table migration
-- ============================================================
-- Run this in Supabase SQL Editor or via psql

-- 1. Create the di_scenarios table
CREATE TABLE IF NOT EXISTS di_scenarios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL,
  base_run_id   bigint REFERENCES di_runs(id) ON DELETE SET NULL,
  scenario_key  text NOT NULL,          -- deterministic hash: sha256(stable_json(base_run_id + overrides + engine_flags))
  name          text,
  overrides     jsonb NOT NULL DEFAULT '{}'::jsonb,
  engine_flags  jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','queued','running','succeeded','failed')),
  scenario_run_id bigint REFERENCES di_runs(id) ON DELETE SET NULL,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 2. Indexes for query patterns
CREATE UNIQUE INDEX IF NOT EXISTS di_scenarios_scenario_key_uidx
  ON di_scenarios (scenario_key);

CREATE INDEX IF NOT EXISTS di_scenarios_base_run_id_idx
  ON di_scenarios (base_run_id);

CREATE INDEX IF NOT EXISTS di_scenarios_user_status_idx
  ON di_scenarios (user_id, status);

CREATE INDEX IF NOT EXISTS di_scenarios_created_at_idx
  ON di_scenarios (created_at DESC);

-- 3. Row-Level Security (RLS)
ALTER TABLE di_scenarios ENABLE ROW LEVEL SECURITY;

-- Allow users to read their own scenarios
CREATE POLICY "di_scenarios_select_own" ON di_scenarios
  FOR SELECT USING (user_id = auth.uid()::text);

-- Allow users to insert their own scenarios
CREATE POLICY "di_scenarios_insert_own" ON di_scenarios
  FOR INSERT WITH CHECK (user_id = auth.uid()::text);

-- Allow users to update their own scenarios
CREATE POLICY "di_scenarios_update_own" ON di_scenarios
  FOR UPDATE USING (user_id = auth.uid()::text);

-- 4. Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_di_scenarios_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER di_scenarios_updated_at_trigger
  BEFORE UPDATE ON di_scenarios
  FOR EACH ROW
  EXECUTE FUNCTION update_di_scenarios_updated_at();

-- 5. Helpful comments
COMMENT ON TABLE di_scenarios IS
  'What-If Analysis scenarios. Each scenario is a variant of a base plan run with parameter overrides.';
COMMENT ON COLUMN di_scenarios.base_run_id IS
  'The plan/optimize run used as baseline. Must have plan_table and replay_metrics artifacts.';
COMMENT ON COLUMN di_scenarios.scenario_key IS
  'Deterministic SHA-256 hash of (base_run_id + JSON-sorted overrides + engine_flags). Used for deduplication.';
COMMENT ON COLUMN di_scenarios.overrides IS
  'Parameter overrides: budget_cap, service_target, stockout_penalty_multiplier, holding_cost_multiplier, safety_stock_alpha, risk_mode, expedite_mode, expedite_cost_per_unit, lead_time_buffer_days';
COMMENT ON COLUMN di_scenarios.engine_flags IS
  'Solver engine flags: solver_engine, risk_mode, multi_echelon_mode, etc.';
COMMENT ON COLUMN di_scenarios.scenario_run_id IS
  'The di_runs ID produced by executing this scenario. Populated when status=succeeded.';
