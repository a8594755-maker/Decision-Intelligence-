-- ============================================
-- FINAL FIX: Complete schema setup for BOM Explosion
-- Fixes: target_table NOT NULL + all missing columns
-- ============================================

-- 1. Fix import_batches: allow NULL target_table and add missing columns
ALTER TABLE import_batches ALTER COLUMN target_table DROP NOT NULL;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS job_key TEXT DEFAULT NULL;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS job_type TEXT DEFAULT NULL;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS result_summary JSONB DEFAULT NULL;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS logic_version_id UUID DEFAULT NULL;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ DEFAULT NULL;

-- 2. Fix forecast_runs: add missing columns
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS job_key TEXT DEFAULT NULL;
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS logic_version_id UUID DEFAULT NULL;
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS parameters JSONB DEFAULT '{}';
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS scenario_name TEXT DEFAULT 'baseline';

-- 3. Verify fixes
SELECT 'import_batches columns:' as info;
SELECT column_name, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'import_batches' AND column_name IN ('target_table','heartbeat_at','job_key','progress');

SELECT 'forecast_runs columns:' as info;
SELECT column_name, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'forecast_runs' AND column_name IN ('heartbeat_at','metadata','job_key','scenario_name');
