-- 检查 BOM Explosion 所需的数据是否存在

-- 1. 检查 demand_fg 数据
SELECT 'demand_fg' as table_name, COUNT(*) as row_count 
FROM demand_fg 
WHERE user_id = auth.uid();

-- 2. 检查 bom_edges 数据  
SELECT 'bom_edges' as table_name, COUNT(*) as row_count
FROM bom_edges
WHERE user_id = auth.uid();

-- 3. 检查最近的 import_batches（BOM Explosion 类型）
SELECT id, status, upload_type, created_at, error_message
FROM import_batches
WHERE user_id = auth.uid() 
  AND upload_type = 'bom_explosion'
ORDER BY created_at DESC
LIMIT 5;
