-- Check if component_demand has data for the user
SELECT COUNT(*) as component_demand_count FROM component_demand WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

-- Check recent batches
SELECT id, upload_type, target_table, status, created_at 
FROM import_batches 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1' 
ORDER BY created_at DESC 
LIMIT 5;

-- Check component_demand associated with the latest batch
SELECT batch_id, COUNT(*) 
FROM component_demand 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1' 
GROUP BY batch_id;
