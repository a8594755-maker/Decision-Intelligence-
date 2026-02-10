-- Remove the "0 rows" batch to clean up the UI for the demo
DELETE FROM import_batches 
WHERE upload_type = 'bom_explosion' 
  AND (total_rows = 0 OR success_rows = 0)
  AND filename LIKE 'BOM Explosion%';

-- Ensure the Seed Data batch is set to completed and visible
UPDATE import_batches
SET status = 'completed', target_table = 'bom_explosion'
WHERE id = 'a0000001-0000-0000-0000-000000000009';
