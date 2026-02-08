-- ============================================
-- Add unique constraint to bom_edges for upsert operations
-- ============================================
-- This constraint is required for the ON CONFLICT clause in BOM sync

-- Add unique constraint for bom_edges upsert
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'uq_bom_edges_user_parent_child_plant'
  ) THEN
    ALTER TABLE bom_edges
    ADD CONSTRAINT uq_bom_edges_user_parent_child_plant 
    UNIQUE(user_id, parent_material, child_material, plant_id);
  END IF;
END $$;

-- Verify constraint was added
SELECT conname, contype 
FROM pg_constraint 
WHERE conname = 'uq_bom_edges_user_parent_child_plant';
