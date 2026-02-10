-- Check recent component_demand records and their batch_ids
SELECT 
    cd.batch_id, 
    ib.upload_type,
    ib.target_table,
    ib.created_at,
    COUNT(*) as demand_count
FROM component_demand cd
LEFT JOIN import_batches ib ON cd.batch_id = ib.id
WHERE cd.user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
GROUP BY cd.batch_id, ib.upload_type, ib.target_table, ib.created_at
ORDER BY ib.created_at DESC;
