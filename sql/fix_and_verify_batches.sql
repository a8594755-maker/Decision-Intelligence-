-- 1. Fix missing target_table for BOM Explosion batches
-- This ensures they appear in the frontend list even with old filters
UPDATE import_batches
SET target_table = 'bom_explosion'
WHERE upload_type = 'bom_explosion' 
  AND (target_table IS NULL OR target_table = '');

-- 2. Verify Component Demand data exists
SELECT 
    COUNT(*) as total_rows,
    COUNT(DISTINCT batch_id) as batch_count,
    COUNT(DISTINCT forecast_run_id) as run_count
FROM component_demand
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

-- 3. Check the specific batch from your screenshot
SELECT 
    id as batch_id,
    target_table,
    upload_type,
    status,
    total_rows
FROM import_batches
WHERE id = '0006992e-f79d-41c4-a863-f2226a6f71bf';

-- 4. Check demands for that batch
SELECT COUNT(*) as count_in_batch
FROM component_demand
WHERE batch_id = '0006992e-f79d-41c4-a863-f2226a6f71bf';
