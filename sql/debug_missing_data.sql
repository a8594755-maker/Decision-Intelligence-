-- Show ALL component_demand rows (limit 20) to debug columns
SELECT 
  id, 
  user_id, 
  batch_id, 
  forecast_run_id, 
  material_code, 
  demand_qty, 
  created_at 
FROM component_demand 
ORDER BY created_at DESC 
LIMIT 20;

-- Show ALL import_batches (limit 5)
SELECT 
  id, 
  user_id, 
  upload_type, 
  target_table, 
  status, 
  created_at 
FROM import_batches 
ORDER BY created_at DESC 
LIMIT 5;

-- Check for mismatch
SELECT 
  b.id as batch_id, 
  b.status, 
  COUNT(cd.id) as linked_demands
FROM import_batches b
LEFT JOIN component_demand cd ON b.id = cd.batch_id
WHERE b.upload_type = 'bom_explosion'
GROUP BY b.id, b.status
ORDER BY b.created_at DESC
LIMIT 5;
