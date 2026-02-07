-- ============================================================
-- Milestone 7.2 WP2: What-if Results Table (MVP)
-- ============================================================
-- Stores before/after KPIs for each key in a what-if run
-- Key granularity: material_code + plant_id
-- ============================================================

CREATE TABLE IF NOT EXISTS public.what_if_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  what_if_run_id uuid NOT NULL REFERENCES public.what_if_runs(id) ON DELETE CASCADE,
  
  -- Key dimensions
  material_code text NOT NULL,
  plant_id text NOT NULL,
  
  -- Before state (baseline)
  before_p_stockout numeric NOT NULL DEFAULT 0,
  before_score numeric NOT NULL DEFAULT 0,
  before_impact_usd numeric NOT NULL DEFAULT 0,
  before_cost_usd numeric NOT NULL DEFAULT 0,
  
  -- After state (post-action)
  after_p_stockout numeric NOT NULL DEFAULT 0,
  after_score numeric NOT NULL DEFAULT 0,
  after_impact_usd numeric NOT NULL DEFAULT 0,
  after_cost_usd numeric NOT NULL DEFAULT 0,
  
  -- Delta (calculated impact)
  delta_p_stockout numeric GENERATED ALWAYS AS (after_p_stockout - before_p_stockout) STORED,
  delta_score numeric GENERATED ALWAYS AS (after_score - before_score) STORED,
  delta_impact_usd numeric GENERATED ALWAYS AS (after_impact_usd - before_impact_usd) STORED,
  delta_cost_usd numeric GENERATED ALWAYS AS (after_cost_usd - before_cost_usd) STORED,
  
  -- ROI calculation
  -- ROI = (delta_impact_usd - delta_cost_usd) / NULLIF(delta_cost_usd, 0)
  -- If cost is 0, ROI is 0 (avoid division by zero)
  roi numeric GENERATED ALWAYS AS (
    CASE 
      WHEN delta_cost_usd > 0 THEN (delta_impact_usd - delta_cost_usd) / delta_cost_usd
      ELSE 0
    END
  ) STORED,
  
  -- Meta data
  action_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {
  --   action_type: 'expedite',
  --   by_buckets: 1,
  --   scope: 'single_key'
  -- }
  
  version text NOT NULL DEFAULT '1.0.0',
  perf jsonb DEFAULT '{}'::jsonb, -- { compute_ms: 123, projection_ms: 456 }
  
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  -- Unique: one result per key per what-if run
  UNIQUE(user_id, what_if_run_id, material_code, plant_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_what_if_results_run ON public.what_if_results(what_if_run_id);
CREATE INDEX IF NOT EXISTS idx_what_if_results_user ON public.what_if_results(user_id);
CREATE INDEX IF NOT EXISTS idx_what_if_results_key ON public.what_if_results(material_code, plant_id);
CREATE INDEX IF NOT EXISTS idx_what_if_results_created ON public.what_if_results(created_at DESC);

-- RLS Policies
ALTER TABLE public.what_if_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own what_if_results" ON public.what_if_results;
CREATE POLICY "Users can view own what_if_results"
  ON public.what_if_results FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own what_if_results" ON public.what_if_results;
CREATE POLICY "Users can insert own what_if_results"
  ON public.what_if_results FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own what_if_results" ON public.what_if_results;
CREATE POLICY "Users can update own what_if_results"
  ON public.what_if_results FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own what_if_results" ON public.what_if_results;
CREATE POLICY "Users can delete own what_if_results"
  ON public.what_if_results FOR DELETE
  USING (auth.uid() = user_id);

-- Comments
COMMENT ON TABLE public.what_if_results IS 'M7.2 WP2: What-if scenario results per key - stores before/after KPIs and ROI';
COMMENT ON COLUMN public.what_if_results.roi IS 'ROI = (delta_impact - delta_cost) / delta_cost. Auto-calculated.';

-- ============================================================
-- Sample queries for verification
-- ============================================================

-- Count results per what-if run
-- SELECT what_if_run_id, COUNT(*) FROM public.what_if_results GROUP BY what_if_run_id;

-- Get latest what-if results with ROI
-- SELECT material_code, plant_id, delta_score, delta_impact_usd, delta_cost_usd, roi
-- FROM public.what_if_results
-- ORDER BY created_at DESC
-- LIMIT 10;
