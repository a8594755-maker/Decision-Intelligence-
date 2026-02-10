-- ============================================
-- Delete All Local Data Script (Fixed)
-- ============================================
-- Purpose: Delete all locally uploaded data (excluding SAP sync data)
-- Safety: Only affects your user_id data, keeps source='sap_sync' data
-- ============================================

-- 1. Delete all data from tables WITHOUT source column (all local data)
DELETE FROM goods_receipts 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

DELETE FROM demand_fg 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

DELETE FROM price_history 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

DELETE FROM suppliers 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

DELETE FROM fg_financials 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

DELETE FROM component_demand 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

DELETE FROM forecast_runs 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

DELETE FROM upload_files 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

-- 2. Delete all local data from tables WITH source column
-- Keep only records where source = 'sap_sync'

DELETE FROM import_batches 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1' 
AND (source IS NULL OR source != 'sap_sync');

DELETE FROM material_stock_snapshots 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1' 
AND (source IS NULL OR source != 'sap_sync');

DELETE FROM bom_edges 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1' 
AND (source IS NULL OR source != 'sap_sync');

DELETE FROM po_open_lines 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1' 
AND (source IS NULL OR source != 'sap_sync');

-- 3. Alternative approach - if above doesn't work, try this:
-- First, check what data exists
SELECT 'import_batches' as table_name, COUNT(*) as total, 
       COUNT(CASE WHEN source = 'sap_sync' THEN 1 END) as sap_sync,
       COUNT(CASE WHEN source IS NULL OR source != 'sap_sync' THEN 1 END) as local
FROM import_batches WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'material_stock_snapshots' as table_name, COUNT(*) as total, 
       COUNT(CASE WHEN source = 'sap_sync' THEN 1 END) as sap_sync,
       COUNT(CASE WHEN source IS NULL OR source != 'sap_sync' THEN 1 END) as local
FROM material_stock_snapshots WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'bom_edges' as table_name, COUNT(*) as total, 
       COUNT(CASE WHEN source = 'sap_sync' THEN 1 END) as sap_sync,
       COUNT(CASE WHEN source IS NULL OR source != 'sap_sync' THEN 1 END) as local
FROM bom_edges WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'po_open_lines' as table_name, COUNT(*) as total, 
       COUNT(CASE WHEN source = 'sap_sync' THEN 1 END) as sap_sync,
       COUNT(CASE WHEN source IS NULL OR source != 'sap_sync' THEN 1 END) as local
FROM po_open_lines WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'goods_receipts' as table_name, COUNT(*) as total, 0 as sap_sync, COUNT(*) as local
FROM goods_receipts WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'demand_fg' as table_name, COUNT(*) as total, 0 as sap_sync, COUNT(*) as local
FROM demand_fg WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'price_history' as table_name, COUNT(*) as total, 0 as sap_sync, COUNT(*) as local
FROM price_history WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'suppliers' as table_name, COUNT(*) as total, 0 as sap_sync, COUNT(*) as local
FROM suppliers WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'fg_financials' as table_name, COUNT(*) as total, 0 as sap_sync, COUNT(*) as local
FROM fg_financials WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'forecast_runs' as table_name, COUNT(*) as total, 0 as sap_sync, COUNT(*) as local
FROM forecast_runs WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
ORDER BY table_name;
