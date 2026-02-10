-- ============================================
-- Check which tables have source column
-- ============================================

-- Check if source column exists in each table
SELECT 'import_batches' as table_name, 
       COUNT(*) as total_records,
       CASE 
         WHEN EXISTS (
           SELECT 1 FROM information_schema.columns 
           WHERE table_name = 'import_batches' 
           AND column_name = 'source'
         ) THEN 'HAS_SOURCE'
         ELSE 'NO_SOURCE'
       END as source_status
FROM import_batches 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'material_stock_snapshots' as table_name, 
       COUNT(*) as total_records,
       CASE 
         WHEN EXISTS (
           SELECT 1 FROM information_schema.columns 
           WHERE table_name = 'material_stock_snapshots' 
           AND column_name = 'source'
         ) THEN 'HAS_SOURCE'
         ELSE 'NO_SOURCE'
       END as source_status
FROM material_stock_snapshots 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'bom_edges' as table_name, 
       COUNT(*) as total_records,
       CASE 
         WHEN EXISTS (
           SELECT 1 FROM information_schema.columns 
           WHERE table_name = 'bom_edges' 
           AND column_name = 'source'
         ) THEN 'HAS_SOURCE'
         ELSE 'NO_SOURCE'
       END as source_status
FROM bom_edges 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'po_open_lines' as table_name, 
       COUNT(*) as total_records,
       CASE 
         WHEN EXISTS (
           SELECT 1 FROM information_schema.columns 
           WHERE table_name = 'po_open_lines' 
           AND column_name = 'source'
         ) THEN 'HAS_SOURCE'
         ELSE 'NO_SOURCE'
       END as source_status
FROM po_open_lines 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'goods_receipts' as table_name, 
       COUNT(*) as total_records,
       CASE 
         WHEN EXISTS (
           SELECT 1 FROM information_schema.columns 
           WHERE table_name = 'goods_receipts' 
           AND column_name = 'source'
         ) THEN 'HAS_SOURCE'
         ELSE 'NO_SOURCE'
       END as source_status
FROM goods_receipts 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'demand_fg' as table_name, 
       COUNT(*) as total_records,
       CASE 
         WHEN EXISTS (
           SELECT 1 FROM information_schema.columns 
           WHERE table_name = 'demand_fg' 
           AND column_name = 'source'
         ) THEN 'HAS_SOURCE'
         ELSE 'NO_SOURCE'
       END as source_status
FROM demand_fg 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'price_history' as table_name, 
       COUNT(*) as total_records,
       CASE 
         WHEN EXISTS (
           SELECT 1 FROM information_schema.columns 
           WHERE table_name = 'price_history' 
           AND column_name = 'source'
         ) THEN 'HAS_SOURCE'
         ELSE 'NO_SOURCE'
       END as source_status
FROM price_history 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'suppliers' as table_name, 
       COUNT(*) as total_records,
       CASE 
         WHEN EXISTS (
           SELECT 1 FROM information_schema.columns 
           WHERE table_name = 'suppliers' 
           AND column_name = 'source'
         ) THEN 'HAS_SOURCE'
         ELSE 'NO_SOURCE'
       END as source_status
FROM suppliers 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'fg_financials' as table_name, 
       COUNT(*) as total_records,
       CASE 
         WHEN EXISTS (
           SELECT 1 FROM information_schema.columns 
           WHERE table_name = 'fg_financials' 
           AND column_name = 'source'
         ) THEN 'HAS_SOURCE'
         ELSE 'NO_SOURCE'
       END as source_status
FROM fg_financials 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'forecast_runs' as table_name, 
       COUNT(*) as total_records,
       CASE 
         WHEN EXISTS (
           SELECT 1 FROM information_schema.columns 
           WHERE table_name = 'forecast_runs' 
           AND column_name = 'source'
         ) THEN 'HAS_SOURCE'
         ELSE 'NO_SOURCE'
       END as source_status
FROM forecast_runs 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
ORDER BY table_name;
