-- Check upload_mappings table structure and constraints
-- ============================================

-- 1. Check if table exists
SELECT 
  'table_exists' as check_type,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM information_schema.tables 
      WHERE table_name = 'upload_mappings'
    ) THEN 'YES'
    ELSE 'NO'
  END as status;

-- 2. Check table structure
SELECT 
  'table_columns' as check_type,
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns 
WHERE table_name = 'upload_mappings'
ORDER BY ordinal_position;

-- 3. Check current CHECK constraint
SELECT 
  'check_constraint' as check_type,
  conname as constraint_name,
  pg_get_constraintdef(oid) as definition
FROM pg_constraint 
WHERE conrelid = 'upload_mappings'::regclass 
  AND contype = 'c';

-- 4. Check if operational_costs is already in the constraint
SELECT 
  'operational_costs_in_check' as check_type,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM pg_constraint 
      WHERE conrelid = 'upload_mappings'::regclass 
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%operational_costs%'
    ) THEN 'YES'
    ELSE 'NO'
  END as status;
