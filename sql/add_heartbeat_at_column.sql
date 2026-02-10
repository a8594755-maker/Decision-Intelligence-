-- ============================================
-- Comprehensive fix for BOM Explosion Edge Function
-- Adds ALL missing columns to forecast_runs and import_batches
-- ============================================

-- 1. forecast_runs: add missing columns
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS job_key TEXT DEFAULT NULL;
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS logic_version_id UUID DEFAULT NULL;

-- 2. import_batches: add missing columns
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS job_key TEXT DEFAULT NULL;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS job_type TEXT DEFAULT NULL;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS result_summary JSONB DEFAULT NULL;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS logic_version_id UUID DEFAULT NULL;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ DEFAULT NULL;

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_forecast_runs_heartbeat ON forecast_runs(heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_forecast_runs_job_key ON forecast_runs(job_key);
CREATE INDEX IF NOT EXISTS idx_import_batches_heartbeat ON import_batches(heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_import_batches_job_key ON import_batches(job_key);

-- 4. Verify
SELECT 'forecast_runs' as tbl, column_name, data_type 
FROM information_schema.columns WHERE table_name = 'forecast_runs' 
AND column_name IN ('heartbeat_at','started_at','failed_at','job_key','logic_version_id')
UNION ALL
SELECT 'import_batches', column_name, data_type 
FROM information_schema.columns WHERE table_name = 'import_batches' 
AND column_name IN ('heartbeat_at','started_at','failed_at','job_key','job_type','progress','result_summary','logic_version_id','completed_at')
ORDER BY tbl, column_name;
