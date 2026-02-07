-- ============================================================
-- Milestone 7: Risk Score + What-if + Audit (MVP)
-- WP1: DB Schema - Risk Score Results + Audit Events
-- ============================================================

-- ============================================================
-- Table 1: risk_score_results (Risk Scoring per Key/Run)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.risk_score_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  forecast_run_id uuid NOT NULL REFERENCES public.forecast_runs(id) ON DELETE CASCADE,
  
  -- Key dimensions
  material_code text NOT NULL,
  plant_id text NOT NULL,
  
  -- Score inputs
  p_stockout numeric NOT NULL DEFAULT 0 CHECK (p_stockout >= 0 AND p_stockout <= 1),
  impact_usd numeric NOT NULL DEFAULT 0,  -- From margin_at_risk or 0
  earliest_stockout_bucket text,  -- For urgency weight calculation
  
  -- Score calculation
  urgency_weight numeric NOT NULL DEFAULT 1.0,
  score numeric NOT NULL DEFAULT 0,  -- p_stockout * impact_usd * urgency_weight
  
  -- Full breakdown for transparency
  breakdown_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {
  --   p_stockout_source: 'probabilistic' | 'deterministic',
  --   impact_source: 'margin_at_risk' | 'fallback',
  --   urgency_calculation: 'W+0=1.5, W+1=1.2, others=1.0',
  --   current_bucket: '2026-W06',
  --   formula: '0.6 * 15000 * 1.5 = 13500'
  -- }
  
  -- Versioning for replayability
  version text NOT NULL DEFAULT '1.0.0',
  score_algorithm text NOT NULL DEFAULT 'mvp_v1',  -- For future algorithm changes
  
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  -- Each key per run is unique
  UNIQUE(user_id, forecast_run_id, material_code, plant_id)
);

COMMENT ON TABLE public.risk_score_results IS 'Risk scores per material/plant/run - combines P(stockout), $ impact, and urgency';
COMMENT ON COLUMN public.risk_score_results.score IS 'Calculated: p_stockout * impact_usd * urgency_weight';
COMMENT ON COLUMN public.risk_score_results.breakdown_json IS 'Full calculation inputs for transparency and audit';

-- ============================================================
-- Table 2: audit_events (Audit Trail for all actions)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- What was done
  event_type text NOT NULL,
  -- 'risk_score_computed', 'what_if_run', 'forecast_run_created', 
  -- 'revenue_forecast_run', 'cost_forecast_run', 'prob_forecast_run'
  
  -- Where it happened
  forecast_run_id uuid REFERENCES public.forecast_runs(id) ON DELETE SET NULL,
  
  -- Who/what was affected
  entity_key text,  -- e.g., "COMP-001|PLANT-01" or null for run-level events
  
  -- Full payload for replay/debug
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {
  --   inputs: {...},
  --   outputs: {...},
  --   version: '1.0.0',
  --   performance: {durationMs: 123}
  -- }
  
  -- For what-if: link to parent event
  parent_event_id uuid REFERENCES public.audit_events(id) ON DELETE SET NULL,
  
  -- IP/user agent for security (optional)
  client_info jsonb DEFAULT '{}'::jsonb,
  
  created_at timestamptz DEFAULT now()
);

COMMENT ON TABLE public.audit_events IS 'Audit trail for all forecast runs, what-if scenarios, and calculations';
COMMENT ON COLUMN public.audit_events.event_type IS 'Type of action: risk_score_computed, what_if_run, forecast_run_created, etc.';
COMMENT ON COLUMN public.audit_events.payload_json IS 'Full inputs/outputs for replay and debugging';

-- ============================================================
-- Table 3: what_if_runs (What-if Scenario Results)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.what_if_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- Baseline context
  forecast_run_id uuid NOT NULL REFERENCES public.forecast_runs(id) ON DELETE CASCADE,
  
  -- Target key
  material_code text NOT NULL,
  plant_id text NOT NULL,
  
  -- Action taken
  action_type text NOT NULL CHECK (action_type IN ('expedite', 'substitute', 'do_nothing')),
  params_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {
  --   expedite_buckets: 1,
  --   demand_reduction_pct: 20,
  //   original_inbound_bucket: '2026-W07',
  //   new_inbound_bucket: '2026-W06'
  -- }
  
  -- Before state (snapshot)
  before_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {
  //   p_stockout: 0.6,
  //   impact_usd: 15000,
  //   stockout_bucket: '2026-W07'
  -- }
  
  -- After state (calculated)
  after_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {
  //   p_stockout: 0.3,
  //   impact_usd: 7500,
  //   stockout_bucket: '2026-W08',
  //   cost: 5000
  -- }
  
  -- Delta and ROI
  delta_p_stockout numeric DEFAULT 0,
  delta_impact_usd numeric DEFAULT 0,
  cost_usd numeric DEFAULT 0,
  roi numeric GENERATED ALWAYS AS (
    CASE 
      WHEN cost_usd > 0 THEN (delta_impact_usd - cost_usd) / cost_usd
      ELSE 0
    END
  ) STORED,
  
  -- Audit link
  audit_event_id uuid REFERENCES public.audit_events(id) ON DELETE SET NULL,
  
  created_at timestamptz DEFAULT now(),
  
  -- Same action on same key = update, not duplicate
  UNIQUE(user_id, forecast_run_id, material_code, plant_id, action_type)
);

COMMENT ON TABLE public.what_if_runs IS 'What-if scenario results: before/after comparison for expedite/substitute actions';
COMMENT ON COLUMN public.what_if_runs.roi IS 'Return on Investment: (ΔImpact - Cost) / Cost';

-- ============================================================
-- Indexes for Performance
-- ============================================================

-- risk_score_results indexes
CREATE INDEX IF NOT EXISTS idx_risk_score_run ON public.risk_score_results(forecast_run_id);
CREATE INDEX IF NOT EXISTS idx_risk_score_user ON public.risk_score_results(user_id);
CREATE INDEX IF NOT EXISTS idx_risk_score_material ON public.risk_score_results(material_code);
CREATE INDEX IF NOT EXISTS idx_risk_score_plant ON public.risk_score_results(plant_id);
CREATE INDEX IF NOT EXISTS idx_risk_score_score ON public.risk_score_results(score DESC);

-- audit_events indexes
CREATE INDEX IF NOT EXISTS idx_audit_user ON public.audit_events(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_run ON public.audit_events(forecast_run_id);
CREATE INDEX IF NOT EXISTS idx_audit_type ON public.audit_events(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_created ON public.audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON public.audit_events(entity_key);

-- what_if_runs indexes
CREATE INDEX IF NOT EXISTS idx_whatif_run ON public.what_if_runs(forecast_run_id);
CREATE INDEX IF NOT EXISTS idx_whatif_user ON public.what_if_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_whatif_key ON public.what_if_runs(material_code, plant_id);
CREATE INDEX IF NOT EXISTS idx_whatif_action ON public.what_if_runs(action_type);

-- ============================================================
-- RLS Policies
-- ============================================================

-- risk_score_results RLS
ALTER TABLE public.risk_score_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own risk scores" ON public.risk_score_results;
CREATE POLICY "Users can view own risk scores"
  ON public.risk_score_results FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own risk scores" ON public.risk_score_results;
CREATE POLICY "Users can insert own risk scores"
  ON public.risk_score_results FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own risk scores" ON public.risk_score_results;
CREATE POLICY "Users can update own risk scores"
  ON public.risk_score_results FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own risk scores" ON public.risk_score_results;
CREATE POLICY "Users can delete own risk scores"
  ON public.risk_score_results FOR DELETE
  USING (auth.uid() = user_id);

-- audit_events RLS
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own audit events" ON public.audit_events;
CREATE POLICY "Users can view own audit events"
  ON public.audit_events FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own audit events" ON public.audit_events;
CREATE POLICY "Users can insert own audit events"
  ON public.audit_events FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Note: No UPDATE/DELETE for audit (immutable log)

-- what_if_runs RLS
ALTER TABLE public.what_if_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own what-if runs" ON public.what_if_runs;
CREATE POLICY "Users can view own what-if runs"
  ON public.what_if_runs FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own what-if runs" ON public.what_if_runs;
CREATE POLICY "Users can insert own what-if runs"
  ON public.what_if_runs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own what-if runs" ON public.what_if_runs;
CREATE POLICY "Users can update own what-if runs"
  ON public.what_if_runs FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own what-if runs" ON public.what_if_runs;
CREATE POLICY "Users can delete own what-if runs"
  ON public.what_if_runs FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================================
-- Triggers: Auto-update updated_at
-- ============================================================

DROP TRIGGER IF EXISTS update_risk_score_updated_at ON public.risk_score_results;
CREATE TRIGGER update_risk_score_updated_at
  BEFORE UPDATE ON public.risk_score_results
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- Sample Queries for Verification
-- ============================================================

-- Get top risk keys for a run
-- SELECT material_code, plant_id, p_stockout, impact_usd, score 
-- FROM public.risk_score_results 
-- WHERE forecast_run_id = 'xxx' 
-- ORDER BY score DESC 
-- LIMIT 20;

-- Get audit trail for a run
-- SELECT event_type, entity_key, payload_json, created_at 
-- FROM public.audit_events 
-- WHERE forecast_run_id = 'xxx' 
-- ORDER BY created_at DESC;

-- Get what-if results for a key
-- SELECT action_type, params_json, before_json, after_json, roi 
-- FROM public.what_if_runs 
-- WHERE material_code = 'FG-001' AND plant_id = 'PLANT-01'
-- ORDER BY created_at DESC;
