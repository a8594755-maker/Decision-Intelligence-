-- ============================================
-- Complete forecast_runs table setup for BOM Explosion Edge Function
-- This creates the table with ALL required columns
-- ============================================

-- Drop and recreate forecast_runs with complete schema
DROP TABLE IF EXISTS forecast_runs CASCADE;

CREATE TABLE forecast_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'pending',
    job_key TEXT DEFAULT NULL,
    scenario_name TEXT DEFAULT 'baseline',
    parameters JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    logic_version_id UUID DEFAULT NULL,
    heartbeat_at TIMESTAMPTZ DEFAULT NULL,
    started_at TIMESTAMPTZ DEFAULT NULL,
    completed_at TIMESTAMPTZ DEFAULT NULL,
    failed_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE forecast_runs ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Users can view own forecast_runs" 
    ON forecast_runs FOR SELECT 
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own forecast_runs" 
    ON forecast_runs FOR INSERT 
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own forecast_runs" 
    ON forecast_runs FOR UPDATE 
    USING (auth.uid() = user_id);

-- Indexes
CREATE INDEX idx_forecast_runs_user_id ON forecast_runs(user_id);
CREATE INDEX idx_forecast_runs_status ON forecast_runs(status);
CREATE INDEX idx_forecast_runs_job_key ON forecast_runs(job_key);
CREATE INDEX idx_forecast_runs_heartbeat ON forecast_runs(heartbeat_at);

-- Verify
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'forecast_runs'
ORDER BY ordinal_position;
