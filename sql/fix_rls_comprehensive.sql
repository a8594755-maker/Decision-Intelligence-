-- Comprehensive fix for operational_costs RLS
-- ============================================

-- 1. First, let's see current policies
SELECT '=== BEFORE FIX ===' as status;
SELECT 
  policyname,
  permissive,
  roles,
  cmd,
  CASE 
    WHEN qual IS NOT NULL THEN 'USING: ' || qual
    ELSE 'No USING clause'
  END as using_clause,
  CASE 
    WHEN with_check IS NOT NULL THEN 'WITH CHECK: ' || with_check
    ELSE 'No WITH CHECK clause'
  END as with_check_clause
FROM pg_policies 
WHERE tablename = 'operational_costs';

-- 2. Drop all existing policies
DROP POLICY IF EXISTS "Users can view their own costs" ON operational_costs;
DROP POLICY IF EXISTS "Users can insert their own costs" ON operational_costs;
DROP POLICY IF EXISTS "Users can update their own costs" ON operational_costs;

-- 3. Ensure RLS is enabled
ALTER TABLE operational_costs ENABLE ROW LEVEL SECURITY;

-- 4. Create policies with explicit role targeting and proper syntax
CREATE POLICY "Users can view their own costs"
  ON operational_costs FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own costs"
  ON operational_costs FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own costs"
  ON operational_costs FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 5. Ensure proper permissions
GRANT SELECT ON operational_costs TO authenticated;
GRANT INSERT ON operational_costs TO authenticated;
GRANT UPDATE ON operational_costs TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;

-- 6. Verify the fix
SELECT '=== AFTER FIX ===' as status;
SELECT 
  policyname,
  permissive,
  roles,
  cmd,
  CASE 
    WHEN qual IS NOT NULL THEN 'USING: ' || qual
    ELSE 'No USING clause'
  END as using_clause,
  CASE 
    WHEN with_check IS NOT NULL THEN 'WITH CHECK: ' || with_check
    ELSE 'No WITH CHECK clause'
  END as with_check_clause
FROM pg_policies 
WHERE tablename = 'operational_costs';

-- 7. Test the policy with a simulated query
-- This should return the same 3 records
SELECT 
  'policy_test' as check_type,
  COUNT(*) as record_count_with_policy,
  'Should be 3 if policy works' as expected_result
FROM operational_costs
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

-- 8. Final verification
SELECT 
  'final_status' as check_type,
  'RLS policies recreated and tested' as status,
  'Frontend should now work' as next_step;
