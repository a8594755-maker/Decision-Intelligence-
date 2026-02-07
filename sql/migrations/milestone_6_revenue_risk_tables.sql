-- ============================================================
-- Milestone 6: Revenue/Price/Margin at Risk (MVP v1)
-- WP1: DB Schema - Revenue Terms + Margin at Risk Results
-- ============================================================

-- ============================================================
-- Table 1: revenue_terms (Revenue Terms per FG/Plant)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.revenue_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plant_id text NOT NULL,
  fg_material_code text NOT NULL,
  
  -- Currency and pricing
  currency text NOT NULL DEFAULT 'USD',
  price_per_unit numeric,
  cogs_per_unit numeric,
  margin_per_unit numeric NOT NULL, -- MVP: only this is required
  
  -- Penalty terms (optional for MVP)
  penalty_type text CHECK (penalty_type IN ('none', 'per_unit', 'percent_of_revenue')),
  penalty_value numeric DEFAULT 0,
  
  -- Validity period (optional for MVP)
  effective_from date DEFAULT CURRENT_DATE,
  effective_to date,
  
  -- Metadata
  description text,
  
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  -- Each user + plant + fg combination is unique
  UNIQUE(user_id, plant_id, fg_material_code)
);

COMMENT ON TABLE public.revenue_terms IS 'Revenue terms per FG/Plant - margin/price/penalty for Margin at Risk calculation';
COMMENT ON COLUMN public.revenue_terms.margin_per_unit IS 'Unit margin - the key field for Margin at Risk (MVP)';
COMMENT ON COLUMN public.revenue_terms.penalty_type IS 'Penalty type: none, per_unit ($/unit), or percent_of_revenue (%)';

-- ============================================================
-- Table 2: margin_at_risk_results (Margin at Risk Results)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.margin_at_risk_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  forecast_run_id uuid NOT NULL REFERENCES public.forecast_runs(id) ON DELETE CASCADE,
  
  -- Bloodline: source BOM run for traceability
  source_bom_run_id uuid,
  
  -- Risk input mode
  risk_input_mode text NOT NULL CHECK (risk_input_mode IN ('deterministic', 'probabilistic')),
  
  -- Key dimensions
  fg_material_code text NOT NULL,
  plant_id text NOT NULL,
  time_bucket text NOT NULL,
  
  -- Input quantities
  demand_qty numeric NOT NULL DEFAULT 0,
  shortage_qty numeric DEFAULT 0,
  p_stockout numeric CHECK (p_stockout >= 0 AND p_stockout <= 1),
  
  -- Revenue terms snapshot (at time of calculation)
  margin_per_unit numeric NOT NULL,
  price_per_unit numeric,
  penalty_type text,
  penalty_value numeric,
  
  -- Impacted quantity calculation
  impacted_qty numeric NOT NULL DEFAULT 0,
  
  -- Results
  expected_margin_at_risk numeric NOT NULL DEFAULT 0,
  expected_penalty_at_risk numeric DEFAULT 0,
  expected_total_at_risk numeric GENERATED ALWAYS AS (
    COALESCE(expected_margin_at_risk, 0) + COALESCE(expected_penalty_at_risk, 0)
  ) STORED,
  
  -- Inputs JSON for traceability/hand calculation verification
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {
  --   demand_source: 'uploaded' | 'demand_forecast',
  --   demand_forecast_run_id: uuid,
  --   allocation_rule: 'fg_only',
  --   inbound_source: string,
  --   revenue_terms_id: uuid
  -- }
  
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  -- Unique constraint: one result per run + fg + plant + bucket
  UNIQUE(user_id, forecast_run_id, fg_material_code, plant_id, time_bucket)
);

COMMENT ON TABLE public.margin_at_risk_results IS 'Margin at Risk results per FG/Plant/Bucket - versioned by forecast_run';
COMMENT ON COLUMN public.margin_at_risk_results.impacted_qty IS 'Quantity impacted by shortage/risk - calculation input for margin_at_risk';
COMMENT ON COLUMN public.margin_at_risk_results.expected_margin_at_risk IS 'impacted_qty * margin_per_unit - the core MVP output';

-- ============================================================
-- Indexes for performance
-- ============================================================

-- revenue_terms indexes
CREATE INDEX IF NOT EXISTS idx_revenue_terms_user 
  ON public.revenue_terms(user_id);
CREATE INDEX IF NOT EXISTS idx_revenue_terms_plant 
  ON public.revenue_terms(plant_id);
CREATE INDEX IF NOT EXISTS idx_revenue_terms_fg 
  ON public.revenue_terms(fg_material_code);

-- margin_at_risk_results indexes
CREATE INDEX IF NOT EXISTS idx_margin_at_risk_run_id 
  ON public.margin_at_risk_results(forecast_run_id);
CREATE INDEX IF NOT EXISTS idx_margin_at_risk_fg 
  ON public.margin_at_risk_results(fg_material_code);
CREATE INDEX IF NOT EXISTS idx_margin_at_risk_plant 
  ON public.margin_at_risk_results(plant_id);
CREATE INDEX IF NOT EXISTS idx_margin_at_risk_time_bucket 
  ON public.margin_at_risk_results(time_bucket);
CREATE INDEX IF NOT EXISTS idx_margin_at_risk_source_bom 
  ON public.margin_at_risk_results(source_bom_run_id);

-- ============================================================
-- RLS Policies (Row Level Security)
-- ============================================================

-- revenue_terms RLS
ALTER TABLE public.revenue_terms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own revenue_terms" ON public.revenue_terms;
CREATE POLICY "Users can view own revenue_terms"
  ON public.revenue_terms FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own revenue_terms" ON public.revenue_terms;
CREATE POLICY "Users can insert own revenue_terms"
  ON public.revenue_terms FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own revenue_terms" ON public.revenue_terms;
CREATE POLICY "Users can update own revenue_terms"
  ON public.revenue_terms FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own revenue_terms" ON public.revenue_terms;
CREATE POLICY "Users can delete own revenue_terms"
  ON public.revenue_terms FOR DELETE
  USING (auth.uid() = user_id);

-- margin_at_risk_results RLS
ALTER TABLE public.margin_at_risk_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own margin_at_risk_results" ON public.margin_at_risk_results;
CREATE POLICY "Users can view own margin_at_risk_results"
  ON public.margin_at_risk_results FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own margin_at_risk_results" ON public.margin_at_risk_results;
CREATE POLICY "Users can insert own margin_at_risk_results"
  ON public.margin_at_risk_results FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own margin_at_risk_results" ON public.margin_at_risk_results;
CREATE POLICY "Users can update own margin_at_risk_results"
  ON public.margin_at_risk_results FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own margin_at_risk_results" ON public.margin_at_risk_results;
CREATE POLICY "Users can delete own margin_at_risk_results"
  ON public.margin_at_risk_results FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================================
-- Triggers: Auto-update updated_at
-- ============================================================

-- revenue_terms trigger
DROP TRIGGER IF EXISTS update_revenue_terms_updated_at ON public.revenue_terms;
CREATE TRIGGER update_revenue_terms_updated_at
  BEFORE UPDATE ON public.revenue_terms
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- margin_at_risk_results trigger  
DROP TRIGGER IF EXISTS update_margin_at_risk_results_updated_at ON public.margin_at_risk_results;
CREATE TRIGGER update_margin_at_risk_results_updated_at
  BEFORE UPDATE ON public.margin_at_risk_results
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- Demo Data Template (Run manually with actual user_id)
-- ============================================================
-- 
-- -- Insert demo revenue terms for high-margin FG items
-- INSERT INTO public.revenue_terms (
--   user_id, plant_id, fg_material_code, currency, 
--   price_per_unit, cogs_per_unit, margin_per_unit,
--   penalty_type, penalty_value, description
-- ) VALUES
--   ('YOUR_USER_ID', 'PLANT-01', 'FG-001', 'USD', 200, 100, 100, 'none', 0, 'High margin product'),
--   ('YOUR_USER_ID', 'PLANT-01', 'FG-002', 'USD', 150, 80, 70, 'per_unit', 10, 'Medium margin with per-unit penalty'),
--   ('YOUR_USER_ID', 'PLANT-01', 'FG-003', 'USD', 300, 200, 100, 'percent_of_revenue', 0.05, 'Premium with 5% late delivery penalty');

-- ============================================================
-- Verification Queries
-- ============================================================
-- 
-- -- Check tables exist
-- SELECT table_name FROM information_schema.tables 
-- WHERE table_schema = 'public' 
-- AND table_name IN ('revenue_terms', 'margin_at_risk_results');
-- 
-- -- Check unique constraints
-- SELECT tc.table_name, kcu.column_name
-- FROM information_schema.table_constraints tc
-- JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
-- WHERE tc.constraint_type = 'UNIQUE'
-- AND tc.table_name IN ('revenue_terms', 'margin_at_risk_results');
