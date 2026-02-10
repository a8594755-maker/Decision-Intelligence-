-- ============================================
-- Create Sample Demand FG Data for BOM Explosion Demo
-- ============================================
-- This creates sample demand data based on existing ERP PO and BOM data
-- Used for demonstrating end-to-end BOM Explosion with ERP data

-- Create sample demand for FG materials based on ERP PO data
INSERT INTO demand_fg (user_id, material_code, plant_id, time_bucket, demand_qty, uom, source, created_at, updated_at)
SELECT 
  INTEGRATION_USER_ID,
  po.material_code,
  po.plant_id,
  po.time_bucket,
  po.open_qty,
  po.uom,
  'erp_sync',
  NOW(),
  NOW()
FROM po_open_lines po
WHERE po.source = 'erp_sync'
  AND po.material_code IN (
    SELECT DISTINCT parent_material 
    FROM bom_edges 
    WHERE source = 'erp_sync'
    AND parent_material IS NOT NULL
  )
ON CONFLICT (user_id, material_code, plant_id, time_bucket) 
DO UPDATE SET 
  demand_qty = EXCLUDED.demand_qty,
  uom = EXCLUDED.uom,
  updated_at = NOW();

-- Create additional demand for key FG materials
INSERT INTO demand_fg (user_id, material_code, plant_id, time_bucket, demand_qty, uom, source, created_at, updated_at)
VALUES 
  (INTEGRATION_USER_ID, 'SG23', '1010', '2026-02-08', 500, 'PC', 'sap_sync', NOW(), NOW()),
  (INTEGRATION_USER_ID, 'SG24', '1010', '2026-02-08', 300, 'PC', 'sap_sync', NOW(), NOW()),
  (INTEGRATION_USER_ID, 'MZ-TG-A17', '1710', '2026-02-08', 200, 'EA', 'sap_sync', NOW(), NOW()),
  (INTEGRATION_USER_ID, 'MZ-TG-A18', '1710', '2026-02-08', 150, 'EA', 'sap_sync', NOW(), NOW()),
  (INTEGRATION_USER_ID, 'MZ-RM-R14-01', '1710', '2026-02-08', 100, 'PC', 'sap_sync', NOW(), NOW())
ON CONFLICT (user_id, material_code, plant_id, time_bucket) 
DO UPDATE SET 
  demand_qty = EXCLUDED.demand_qty,
  uom = EXCLUDED.uom,
  updated_at = NOW();

-- Verify the created demand data
SELECT COUNT(*) as demand_fg_records FROM demand_fg WHERE source = 'sap_sync';

-- Show sample demand records
SELECT material_code, plant_id, time_bucket, demand_qty, uom, source
FROM demand_fg 
WHERE source = 'sap_sync' 
ORDER BY time_bucket, material_code
LIMIT 10;
