-- ============================================
-- Delete All Local Data Script
-- ============================================
-- Purpose: Delete all locally uploaded data (excluding SAP sync data)
-- Safety: Only affects your user_id data, keeps source='sap_sync' data
-- ============================================

-- Replace 'YOUR_USER_ID' with your actual user_id from auth.users
-- To find your user_id, run: SELECT id, email FROM auth.users;

-- 1. Delete all local batch records (keep SAP sync data)
DELETE FROM import_batches 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1' 
AND (source IS NULL OR source != 'sap_sync');

-- 2. Delete all local data from tables that support source filtering
DELETE FROM material_stock_snapshots 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1' 
AND (source IS NULL OR source != 'sap_sync');

DELETE FROM bom_edges 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1' 
AND (source IS NULL OR source != 'sap_sync');

DELETE FROM po_open_lines 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1' 
AND (source IS NULL OR source != 'sap_sync');

-- 3. Delete all local data from tables without source column
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

-- 4. Delete component_demand records (linked to forecast runs)
DELETE FROM component_demand 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

-- 5. Delete forecast runs
DELETE FROM forecast_runs 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

-- 6. Delete upload files
DELETE FROM upload_files 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

-- ============================================
-- Verification Queries (run after deletion)
-- ============================================

-- Check remaining data counts by source
SELECT 
  'material_stock_snapshots' as table_name,
  source,
  COUNT(*) as count
FROM material_stock_snapshots 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
GROUP BY source
UNION ALL
SELECT 
  'bom_edges' as table_name,
  source,
  COUNT(*) as count
FROM bom_edges 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
GROUP BY source
UNION ALL
SELECT 
  'po_open_lines' as table_name,
  source,
  COUNT(*) as count
FROM po_open_lines 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
GROUP BY source
ORDER BY table_name, source;

-- Check if any local data remains
SELECT 
  'goods_receipts' as table_name, COUNT(*) as count 
FROM goods_receipts WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 
  'demand_fg' as table_name, COUNT(*) as count 
FROM demand_fg WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 
  'price_history' as table_name, COUNT(*) as count 
FROM price_history WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 
  'suppliers' as table_name, COUNT(*) as count 
FROM suppliers WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 
  'fg_financials' as table_name, COUNT(*) as count 
FROM fg_financials WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 
  'import_batches' as table_name, COUNT(*) as count 
FROM import_batches WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 
  'forecast_runs' as table_name, COUNT(*) as count 
FROM forecast_runs WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 
  'upload_files' as table_name, COUNT(*) as count 
FROM upload_files WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
ORDER BY table_name;
