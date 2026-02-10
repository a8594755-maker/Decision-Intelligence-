-- ============================================
-- Inventory Sync Table for ERP Material Stock
-- ============================================
-- This table stores inventory snapshots from ERP
-- Used by sync-inventory-from-erp Edge Function
-- ============================================

-- Create material_stock_snapshots table if not exists
CREATE TABLE IF NOT EXISTS material_stock_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  material_code TEXT NOT NULL,
  plant_id TEXT NOT NULL,
  storage_location TEXT NOT NULL DEFAULT '',
  batch TEXT,
  stock_type TEXT NOT NULL DEFAULT 'UNRESTRICTED',
  qty NUMERIC NOT NULL DEFAULT 0,
  uom TEXT NOT NULL,
  snapshot_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  source TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create unique constraint for idempotent upserts
-- This prevents duplicate entries for the same material/plant/location/batch/stock_type at the same snapshot time
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_stock_snapshot'
  ) THEN
    ALTER TABLE material_stock_snapshots
    ADD CONSTRAINT uq_stock_snapshot 
    UNIQUE(user_id, material_code, plant_id, storage_location, batch, stock_type, snapshot_at);
  END IF;
END $$;

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_stock_snapshots_material 
  ON material_stock_snapshots(user_id, material_code);

CREATE INDEX IF NOT EXISTS idx_stock_snapshots_plant 
  ON material_stock_snapshots(user_id, plant_id);

CREATE INDEX IF NOT EXISTS idx_stock_snapshots_snapshot 
  ON material_stock_snapshots(snapshot_at);

CREATE INDEX IF NOT EXISTS idx_stock_snapshots_latest
  ON material_stock_snapshots(user_id, material_code, plant_id, snapshot_at DESC);

-- Add comment for documentation
COMMENT ON TABLE material_stock_snapshots IS 'Stores material stock snapshots synced from SAP. Populated by sync-inventory-from-sap Edge Function.';

-- ============================================
-- Verification Queries (run after sync)
-- ============================================

-- Count total stock records
-- SELECT COUNT(*) FROM material_stock_snapshots WHERE source = 'sap_sync';

-- Get latest snapshot timestamp
-- SELECT MAX(snapshot_at) FROM material_stock_snapshots WHERE source = 'sap_sync';

-- Sample 5 stock records
-- SELECT 
--   material_code,
--   plant_id,
--   storage_location,
--   stock_type,
--   qty,
--   uom,
--   snapshot_at
-- FROM material_stock_snapshots
-- WHERE source = 'sap_sync'
-- ORDER BY snapshot_at DESC
-- LIMIT 5;

-- Stock summary by plant
-- SELECT 
--   plant_id,
--   COUNT(DISTINCT material_code) as unique_materials,
--   SUM(qty) as total_qty,
--   MAX(snapshot_at) as latest_sync
-- FROM material_stock_snapshots
-- WHERE source = 'sap_sync'
-- GROUP BY plant_id
-- ORDER BY plant_id;

-- ============================================
-- BOM Sync Verification Queries
-- ============================================

-- Count total BOM edges from SAP
-- SELECT COUNT(*) FROM bom_edges WHERE source = 'sap_sync';

-- Sample 5 BOM edges with parent-child relationships
-- SELECT 
--   parent_material,
--   child_material,
--   qty_per,
--   uom,
--   plant_id,
--   valid_from,
--   valid_to
-- FROM bom_edges
-- WHERE source = 'sap_sync'
-- ORDER BY created_at DESC
-- LIMIT 5;

-- BOM components count per parent material
-- SELECT 
--   parent_material,
--   plant_id,
--   COUNT(*) as component_count
-- FROM bom_edges
-- WHERE source = 'sap_sync'
-- GROUP BY parent_material, plant_id
-- ORDER BY component_count DESC
-- LIMIT 10;

-- Find BOM edges expiring soon (next 30 days)
-- SELECT 
--   parent_material,
--   child_material,
--   valid_to
-- FROM bom_edges
-- WHERE source = 'sap_sync'
--   AND valid_to IS NOT NULL
--   AND valid_to BETWEEN NOW() AND NOW() + INTERVAL '30 days';
