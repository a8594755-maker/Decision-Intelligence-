-- ============================================================
-- Milestone 4-B: Probabilistic Inventory Forecast (Monte Carlo)
-- ============================================================
-- Two new tables for probabilistic inventory forecast results
-- Step 1: Create summary table (key-level)
-- Step 1: Create series table (key+bucket for fan charts)
-- RLS policies included
-- ============================================================

-- 1. inventory_forecast_prob_summary: Key-level probabilistic summary
CREATE TABLE IF NOT EXISTS inventory_forecast_prob_summary (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    forecast_run_id uuid NOT NULL REFERENCES forecast_runs(id) ON DELETE CASCADE,
    material_code text NOT NULL,
    plant_id text NOT NULL,
    
    -- Monte Carlo config
    trials int NOT NULL DEFAULT 200,
    seed bigint,
    
    -- Key probabilistic metrics
    p_stockout numeric NOT NULL DEFAULT 0,
    stockout_bucket_p50 text,
    stockout_bucket_p90 text,
    expected_shortage_qty numeric NOT NULL DEFAULT 0,
    expected_min_available numeric,
    
    -- Input source tracking (bloodline)
    input_demand_source text,
    input_demand_forecast_run_id uuid,
    input_inbound_source text,
    input_supply_forecast_run_id uuid,
    
    -- Performance metrics
    metrics jsonb DEFAULT '{}',
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    
    -- Unique: one summary per key per run
    CONSTRAINT uq_inventory_prob_summary_key UNIQUE (user_id, forecast_run_id, material_code, plant_id)
);

-- 2. inventory_forecast_prob_series: Key+Bucket level for fan charts
CREATE TABLE IF NOT EXISTS inventory_forecast_prob_series (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    forecast_run_id uuid NOT NULL REFERENCES forecast_runs(id) ON DELETE CASCADE,
    material_code text NOT NULL,
    plant_id text NOT NULL,
    time_bucket text NOT NULL,
    
    -- Inventory quantiles (end_on_hand)
    inv_p10 numeric,
    inv_p50 numeric,
    inv_p90 numeric,
    
    -- Available quantiles (optional, for future use)
    available_p10 numeric,
    available_p50 numeric,
    available_p90 numeric,
    
    -- Stockout probability per bucket (optional)
    p_stockout_bucket numeric DEFAULT 0,
    
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    
    -- Unique: one series row per key per bucket per run
    CONSTRAINT uq_inventory_prob_series_key UNIQUE (user_id, forecast_run_id, material_code, plant_id, time_bucket)
);

-- ============================================================
-- Indexes for performance
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_inventory_prob_summary_run 
    ON inventory_forecast_prob_summary(user_id, forecast_run_id);
CREATE INDEX IF NOT EXISTS idx_inventory_prob_summary_key 
    ON inventory_forecast_prob_summary(user_id, material_code, plant_id);

CREATE INDEX IF NOT EXISTS idx_inventory_prob_series_run 
    ON inventory_forecast_prob_series(user_id, forecast_run_id);
CREATE INDEX IF NOT EXISTS idx_inventory_prob_series_key 
    ON inventory_forecast_prob_series(user_id, material_code, plant_id, time_bucket);

-- ============================================================
-- Row Level Security (RLS)
-- ============================================================
ALTER TABLE inventory_forecast_prob_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_forecast_prob_series ENABLE ROW LEVEL SECURITY;

-- Drop existing policies first (to avoid "already exists" error)
DROP POLICY IF EXISTS "Users can view own inventory_forecast_prob_summary" ON inventory_forecast_prob_summary;
DROP POLICY IF EXISTS "Users can insert own inventory_forecast_prob_summary" ON inventory_forecast_prob_summary;
DROP POLICY IF EXISTS "Users can update own inventory_forecast_prob_summary" ON inventory_forecast_prob_summary;
DROP POLICY IF EXISTS "Users can delete own inventory_forecast_prob_summary" ON inventory_forecast_prob_summary;

DROP POLICY IF EXISTS "Users can view own inventory_forecast_prob_series" ON inventory_forecast_prob_series;
DROP POLICY IF EXISTS "Users can insert own inventory_forecast_prob_series" ON inventory_forecast_prob_series;
DROP POLICY IF EXISTS "Users can update own inventory_forecast_prob_series" ON inventory_forecast_prob_series;
DROP POLICY IF EXISTS "Users can delete own inventory_forecast_prob_series" ON inventory_forecast_prob_series;

-- RLS Policies for inventory_forecast_prob_summary
CREATE POLICY "Users can view own inventory_forecast_prob_summary"
    ON inventory_forecast_prob_summary FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own inventory_forecast_prob_summary"
    ON inventory_forecast_prob_summary FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own inventory_forecast_prob_summary"
    ON inventory_forecast_prob_summary FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own inventory_forecast_prob_summary"
    ON inventory_forecast_prob_summary FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- RLS Policies for inventory_forecast_prob_series
CREATE POLICY "Users can view own inventory_forecast_prob_series"
    ON inventory_forecast_prob_series FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own inventory_forecast_prob_series"
    ON inventory_forecast_prob_series FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own inventory_forecast_prob_series"
    ON inventory_forecast_prob_series FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own inventory_forecast_prob_series"
    ON inventory_forecast_prob_series FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- ============================================================
-- Comments for documentation
-- ============================================================
COMMENT ON TABLE inventory_forecast_prob_summary IS 'Milestone 4-B: Probabilistic inventory forecast summary per key (pStockout, stockout buckets, expected shortage)';
COMMENT ON TABLE inventory_forecast_prob_series IS 'Milestone 4-B: Probabilistic inventory forecast series per key+bucket (invP10/P50/P90 for fan charts)';
