-- ============================================
-- BOM Explosion Edge Function Migration
-- Database Schema Updates
-- ============================================

-- Add error_message column to import_batches for detailed error tracking
ALTER TABLE import_batches 
  ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Index for polling queries: user + status + upload_type
CREATE INDEX IF NOT EXISTS idx_import_batches_user_status 
  ON import_batches(user_id, status, upload_type);

-- Index for idempotency cleanup and result queries
CREATE INDEX IF NOT EXISTS idx_component_demand_user_run 
  ON component_demand(user_id, forecast_run_id);

CREATE INDEX IF NOT EXISTS idx_component_demand_trace_user_run 
  ON component_demand_trace(user_id, forecast_run_id);

-- Index for trace lookups by component_demand_id
CREATE INDEX IF NOT EXISTS idx_component_demand_trace_component_id 
  ON component_demand_trace(component_demand_id);

-- Index for forecast_run_id based cleanup (idempotency)
CREATE INDEX IF NOT EXISTS idx_component_demand_run_id 
  ON component_demand(forecast_run_id);

CREATE INDEX IF NOT EXISTS idx_component_demand_trace_run_id 
  ON component_demand_trace(forecast_run_id);

-- Add comments
COMMENT ON COLUMN import_batches.error_message IS 'Detailed error message when status is failed';

-- Verify indexes were created
DO $$
BEGIN
  RAISE NOTICE 'BOM Explosion indexes created successfully';
END $$;
