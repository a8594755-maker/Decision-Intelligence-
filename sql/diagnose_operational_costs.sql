-- Diagnose operational_costs table status
-- ============================================

-- 1. Check if table exists
SELECT 
  'table_exists' as check_type,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM information_schema.tables 
      WHERE table_name = 'operational_costs'
    ) THEN 'YES'
    ELSE 'NO'
  END as status;

-- 2. Check table structure (if exists)
SELECT 
  'table_columns' as check_type,
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns 
WHERE table_name = 'operational_costs'
ORDER BY ordinal_position;

-- 3. Check RLS status
SELECT 
  'rls_enabled' as check_type,
  rowsecurity as is_enabled
FROM pg_tables 
WHERE tablename = 'operational_costs';

-- 4. Check RLS policies
SELECT 
  'rls_policies' as check_type,
  policyname,
  cmd,
  permissive,
  roles
FROM pg_policies 
WHERE tablename = 'operational_costs';

-- 5. Check if user can access (try a simple query)
-- This will show if RLS is working correctly
SELECT 
  'user_access_test' as check_type,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM information_schema.table_privileges 
      WHERE table_name = 'operational_costs' 
        AND privilege_type = 'SELECT'
        AND grantee = current_user
    ) THEN 'HAS_SELECT_PRIVILEGE'
    ELSE 'NO_SELECT_PRIVILEGE'
  END as status;

-- 6. Check current user
SELECT 
  'current_user' as check_type,
  current_user as user_name,
  session_user as session_user_name;
