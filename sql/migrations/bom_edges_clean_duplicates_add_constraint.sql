-- ============================================
-- Clean duplicate BOM edges and add unique constraint
-- ============================================
-- This removes duplicates and creates the constraint needed for upsert

-- First, identify and remove duplicates
DELETE FROM bom_edges 
WHERE ctid NOT IN (
  SELECT max(ctid)
  FROM bom_edges
  GROUP BY user_id, parent_material, child_material, plant_id
);

-- Verify duplicates are removed
SELECT COUNT(*) as remaining_records FROM bom_edges;

-- Now add the unique constraint
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
