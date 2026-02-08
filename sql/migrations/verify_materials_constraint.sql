-- ============================================
-- Verify Materials Unique Constraint for SAP Sync
-- ============================================
-- Purpose: Ensure materials table has UNIQUE(user_id, material_code) constraint
-- for proper upsert operations from SAP sync
-- ============================================

DO $$
DECLARE
  constraint_exists BOOLEAN;
  index_exists BOOLEAN;
BEGIN
  -- Check if unique constraint exists
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conrelid = 'materials'::regclass 
      AND contype = 'u'
      AND conkey @> (
        SELECT array_agg(a.attnum) 
        FROM pg_attribute a 
        WHERE a.attrelid = 'materials'::regclass 
          AND a.attname IN ('user_id', 'material_code')
      )
  ) INTO constraint_exists;

  IF NOT constraint_exists THEN
    -- Add unique constraint if missing
    ALTER TABLE materials 
    ADD CONSTRAINT uq_materials_user_material_code 
    UNIQUE (user_id, material_code);
    
    RAISE NOTICE '✅ Added unique constraint: uq_materials_user_material_code';
  ELSE
    RAISE NOTICE '✓ Unique constraint already exists on materials(user_id, material_code)';
  END IF;

  -- Verify index for performance
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE tablename = 'materials' 
      AND indexname = 'idx_materials_user_code'
  ) INTO index_exists;

  IF NOT index_exists THEN
    CREATE INDEX idx_materials_user_code 
    ON materials(user_id, material_code);
    
    RAISE NOTICE '✅ Created index: idx_materials_user_code';
  ELSE
    RAISE NOTICE '✓ Index idx_materials_user_code already exists';
  END IF;
END $$;

-- Verify the result
SELECT 
  'materials' AS table_name,
  (
    SELECT COUNT(*) 
    FROM pg_constraint 
    WHERE conrelid = 'materials'::regclass 
      AND contype = 'u'
  ) AS unique_constraint_count,
  (
    SELECT COUNT(*) 
    FROM pg_indexes 
    WHERE tablename = 'materials'
  ) AS index_count,
  (
    SELECT COUNT(*) 
    FROM materials 
    WHERE user_id = (
      SELECT id FROM auth.users LIMIT 1
    )
  ) AS sample_materials_count;
