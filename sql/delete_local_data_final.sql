-- ============================================
-- Delete All Local Data Script (Final)
-- ============================================
-- Based on actual table schema analysis
-- HAS_SOURCE tables: bom_edges, demand_fg, material_stock_snapshots, po_open_lines
-- NO_SOURCE tables: fg_financials, forecast_runs, goods_receipts, import_batches, price_history, suppliers

-- 1. Delete ALL data from NO_SOURCE tables (all local data)
DELETE FROM fg_financials 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

DELETE FROM forecast_runs 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

DELETE FROM goods_receipts 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

DELETE FROM import_batches 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

DELETE FROM price_history 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

DELETE FROM suppliers 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

DELETE FROM component_demand 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

-- 2. Delete ONLY local data from HAS_SOURCE tables (keep SAP sync data)
DELETE FROM bom_edges 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1' 
AND (source IS NULL OR source != 'sap_sync');

DELETE FROM demand_fg 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1' 
AND (source IS NULL OR source != 'sap_sync');

DELETE FROM material_stock_snapshots 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1' 
AND (source IS NULL OR source != 'sap_sync');

DELETE FROM po_open_lines 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1' 
AND (source IS NULL OR source != 'sap_sync');

-- 3. Verification - Check remaining data after deletion
SELECT 'bom_edges' as table_name, COUNT(*) as remaining_count,
       COUNT(CASE WHEN source = 'sap_sync' THEN 1 END) as sap_sync_count
FROM bom_edges WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'demand_fg' as table_name, COUNT(*) as remaining_count,
       COUNT(CASE WHEN source = 'sap_sync' THEN 1 END) as sap_sync_count
FROM demand_fg WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'material_stock_snapshots' as table_name, COUNT(*) as remaining_count,
       COUNT(CASE WHEN source = 'sap_sync' THEN 1 END) as sap_sync_count
FROM material_stock_snapshots WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'po_open_lines' as table_name, COUNT(*) as remaining_count,
       COUNT(CASE WHEN source = 'sap_sync' THEN 1 END) as sap_sync_count
FROM po_open_lines WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'fg_financials' as table_name, COUNT(*) as remaining_count, 0 as sap_sync_count
FROM fg_financials WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'forecast_runs' as table_name, COUNT(*) as remaining_count, 0 as sap_sync_count
FROM forecast_runs WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'goods_receipts' as table_name, COUNT(*) as remaining_count, 0 as sap_sync_count
FROM goods_receipts WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'import_batches' as table_name, COUNT(*) as remaining_count, 0 as sap_sync_count
FROM import_batches WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'price_history' as table_name, COUNT(*) as remaining_count, 0 as sap_sync_count
FROM price_history WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'suppliers' as table_name, COUNT(*) as remaining_count, 0 as sap_sync_count
FROM suppliers WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
ORDER BY table_name;