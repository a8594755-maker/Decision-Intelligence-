-- ============================================
-- Demand Forecast Table (WP1)
-- ============================================
-- Purpose: Store demand forecast results with P10/P50/P90 confidence intervals
-- Version: MVP v1

-- ============================================
-- 1. Create demand_forecast table
-- ============================================
CREATE TABLE IF NOT EXISTS public.demand_forecast (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  forecast_run_id UUID NOT NULL REFERENCES public.forecast_runs(id) ON DELETE CASCADE,
  
  -- Forecast core fields
  material_code TEXT NOT NULL,           -- FG material code
  plant_id TEXT NOT NULL,                -- Plant code
  time_bucket TEXT NOT NULL,             -- Time bucket (week/date)
  
  -- Forecast values with confidence intervals
  p10 NUMERIC,                           -- 10th percentile (lower bound)
  p50 NUMERIC NOT NULL,                  -- 50th percentile (median/forecast)
  p90 NUMERIC,                           -- 90th percentile (upper bound)
  
  -- Model and training information
  model_version TEXT NOT NULL,           -- Model version (e.g., 'ma_v1')
  train_window_buckets INTEGER,          -- Number of historical buckets used for training
  
  -- Optional metrics
  metrics JSONB DEFAULT '{}'::jsonb,     -- Store WAPE, std, n, etc.
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add comments
COMMENT ON TABLE public.demand_forecast IS 'Demand forecast results with confidence intervals (P10/P50/P90)';
COMMENT ON COLUMN public.demand_forecast.user_id IS 'User ID (foreign key to auth.users)';
COMMENT ON COLUMN public.demand_forecast.forecast_run_id IS 'Reference to forecast_runs table for traceability';
COMMENT ON COLUMN public.demand_forecast.material_code IS 'Finished goods material code';
COMMENT ON COLUMN public.demand_forecast.plant_id IS 'Plant code';
COMMENT ON COLUMN public.demand_forecast.time_bucket IS 'Time bucket (week or date format)';
COMMENT ON COLUMN public.demand_forecast.p10 IS '10th percentile forecast (lower confidence bound)';
COMMENT ON COLUMN public.demand_forecast.p50 IS '50th percentile forecast (median/point forecast)';
COMMENT ON COLUMN public.demand_forecast.p90 IS '90th percentile forecast (upper confidence bound)';
COMMENT ON COLUMN public.demand_forecast.model_version IS 'Forecast model version (e.g., ma_v1 for Moving Average v1)';
COMMENT ON COLUMN public.demand_forecast.train_window_buckets IS 'Number of historical time buckets used for training';
COMMENT ON COLUMN public.demand_forecast.metrics IS 'Optional metrics like WAPE, standard deviation, sample size (n)';

-- ============================================
-- 2. Create indexes
-- ============================================
CREATE INDEX IF NOT EXISTS idx_demand_forecast_user ON public.demand_forecast(user_id);
CREATE INDEX IF NOT EXISTS idx_demand_forecast_run ON public.demand_forecast(forecast_run_id);
CREATE INDEX IF NOT EXISTS idx_demand_forecast_material ON public.demand_forecast(material_code);
CREATE INDEX IF NOT EXISTS idx_demand_forecast_plant ON public.demand_forecast(plant_id);
CREATE INDEX IF NOT EXISTS idx_demand_forecast_time_bucket ON public.demand_forecast(time_bucket);
CREATE INDEX IF NOT EXISTS idx_demand_forecast_user_material_time ON public.demand_forecast(user_id, material_code, time_bucket);

-- ============================================
-- 3. Create unique constraint
-- ============================================
-- Ensure no duplicate forecasts for same user/run/fg/plant/time combination
ALTER TABLE public.demand_forecast 
  ADD CONSTRAINT uq_demand_forecast_key 
  UNIQUE (user_id, forecast_run_id, material_code, plant_id, time_bucket);

-- ============================================
-- 4. Enable Row Level Security (RLS)
-- ============================================
ALTER TABLE public.demand_forecast ENABLE ROW LEVEL SECURITY;

-- Users can view their own forecasts
DROP POLICY IF EXISTS "Users can view their own demand forecasts" ON public.demand_forecast;
CREATE POLICY "Users can view their own demand forecasts"
  ON public.demand_forecast FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own forecasts
DROP POLICY IF EXISTS "Users can insert their own demand forecasts" ON public.demand_forecast;
CREATE POLICY "Users can insert their own demand forecasts"
  ON public.demand_forecast FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- ============================================
-- 5. Create trigger for updated_at
-- ============================================
CREATE OR REPLACE FUNCTION update_demand_forecast_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_demand_forecast_updated_at ON public.demand_forecast;
CREATE TRIGGER trg_demand_forecast_updated_at
  BEFORE UPDATE ON public.demand_forecast
  FOR EACH ROW
  EXECUTE FUNCTION update_demand_forecast_updated_at();

-- ============================================
-- 6. Completion notice
-- ============================================
DO $$
BEGIN
  RAISE NOTICE 'Demand forecast table created successfully with P10/P50/P90 confidence intervals';
  RAISE NOTICE 'Table supports versioned runs via forecast_run_id foreign key';
  RAISE NOTICE 'Unique constraint prevents duplicate forecasts for same user/run/fg/plant/time';
END $$;
