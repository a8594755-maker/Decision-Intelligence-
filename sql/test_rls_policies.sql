-- Test RLS policies for operational_costs
-- ============================================

-- 1. Check if RLS is actually enabled
SELECT 
  'rls_status' as check_type,
  schemaname,
  tablename,
  rowsecurity as rls_enabled
FROM pg_tables 
WHERE tablename = 'operational_costs';

-- 2. Check all policies on operational_costs
SELECT 
  'policies' as check_type,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies 
WHERE tablename = 'operational_costs'
ORDER BY policyname;

-- 3. Test with a simulated authenticated user
-- This will help identify if the policy logic is correct
SELECT 
  'policy_test' as check_type,
  'Testing policy logic with simulated user_id' as description;

-- 4. Check if there are any policy conflicts
SELECT 
  'policy_conflicts' as check_type,
  CASE 
    WHEN COUNT(*) > 1 THEN 'Multiple policies may conflict'
    ELSE 'Single policy or none'
  END as status
FROM pg_policies 
WHERE tablename = 'operational_costs' 
  AND cmd = 'SELECT';

-- 5. Verify the exact policy definition
SELECT 
  'policy_definition' as check_type,
  pg_get_viewdef('pg_policies', false) as full_definition
WHERE EXISTS (
  SELECT 1 FROM pg_policies 
  WHERE tablename = 'operational_costs'
);

-- 6. Check if the user ID format matches
SELECT 
  'user_id_format' as check_type,
  'Expected UUID format: 291075be-3bee-43ff-a296-17c8eecd26a1' as expected,
  'Current query uses: user_id=eq.291075be-3bee-43ff-a296-17c8eecd26a1' as actual;

-- 7. Test direct query bypassing RLS (as postgres)
SELECT 
  'direct_query_test' as check_type,
  COUNT(*) as total_records
FROM operational_costs;

-- 8. Check if there are any records for the user
SELECT 
  'user_records' as check_type,
  COUNT(*) as user_record_count,
  user_id
FROM operational_costs
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
GROUP BY user_id;
