-- 1. Check Input Data (Must be > 0)
SELECT 'demand_fg' as table_name, COUNT(*) as row_count FROM demand_fg WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'bom_edges', COUNT(*) FROM bom_edges WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

-- 2. Check the "0 rows" batch details
SELECT 
    id, 
    upload_type, 
    target_table, 
    total_rows, 
    success_rows, 
    error_message, 
    metadata 
FROM import_batches 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
ORDER BY created_at DESC 
LIMIT 1;

-- 3. Check if any component_demand was created for that batch but maybe hidden?
SELECT COUNT(*) as actual_demand_rows
FROM component_demand
WHERE batch_id = (
    SELECT id FROM import_batches 
    WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1' 
    ORDER BY created_at DESC LIMIT 1
);
