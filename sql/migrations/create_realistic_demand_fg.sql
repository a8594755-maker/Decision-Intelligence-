-- ============================================
-- Create Realistic FG Demand from Existing SAP Data
-- ============================================
-- This creates meaningful FG demand based on SAP BOM parent materials
-- Used for demonstrating BOM Explosion with real SAP data flow

-- Create demand for BOM parent materials (FG items)
INSERT INTO demand_fg (user_id, material_code, plant_id, time_bucket, demand_qty, uom, source, created_at, updated_at)
SELECT 
  '291075be-3bee-43ff-a296-17c8eecd26a1' as user_id,  -- Your integration user_id
  parent_material,
  plant_id,
  DATE('2026-02-08')::text as time_bucket,
  -- Create realistic demand quantities based on material patterns
  CASE 
    WHEN parent_material LIKE 'SG%' THEN 500 + (RANDOM() * 500)::integer  -- SG materials: 500-1000
    WHEN parent_material LIKE 'MZ-TG%' THEN 200 + (RANDOM() * 300)::integer  -- TG materials: 200-500
    WHEN parent_material LIKE 'MZ-RM%' THEN 100 + (RANDOM() * 200)::integer  -- RM materials: 100-300
    ELSE 50 + (RANDOM() * 100)::integer  -- Others: 50-150
  END as demand_qty,
  'PC' as uom,
  'sap_sync',
  NOW(),
  NOW()
FROM bom_edges 
WHERE source = 'sap_sync'
  AND parent_material IS NOT NULL
  AND parent_material != ''
ON CONFLICT (user_id, material_code, plant_id, time_bucket) 
DO UPDATE SET 
  demand_qty = EXCLUDED.demand_qty,
  uom = EXCLUDED.uom,
  updated_at = NOW();

-- Create additional demand for key FG materials with multiple time buckets
INSERT INTO demand_fg (user_id, material_code, plant_id, time_bucket, demand_qty, uom, source, created_at, updated_at)
VALUES 
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SG23', '1010', '2026-02-08', 800, 'PC', 'sap_sync', NOW(), NOW()),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SG23', '1010', '2026-02-15', 750, 'PC', 'sap_sync', NOW(), NOW()),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SG23', '1010', '2026-02-22', 900, 'PC', 'sap_sync', NOW(), NOW()),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'MZ-TG-A17', '1710', '2026-02-08', 300, 'EA', 'sap_sync', NOW(), NOW()),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'MZ-TG-A18', '1710', '2026-02-08', 250, 'EA', 'sap_sync', NOW(), NOW()),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'MZ-RM-R14-01', '1710', '2026-02-08', 150, 'PC', 'sap_sync', NOW(), NOW())
ON CONFLICT (user_id, material_code, plant_id, time_bucket) 
DO UPDATE SET 
  demand_qty = EXCLUDED.demand_qty,
  uom = EXCLUDED.uom,
  updated_at = NOW();

-- Verify the created demand data
SELECT COUNT(*) as total_demand_fg FROM demand_fg WHERE source = 'sap_sync';

-- Show sample demand records
SELECT material_code, plant_id, time_bucket, demand_qty, uom, source
FROM demand_fg 
WHERE source = 'sap_sync' 
  AND material_code != 'UNKNOWN_MATERIAL'
ORDER BY time_bucket, material_code
LIMIT 10;
