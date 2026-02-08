-- Diagnose 406 error - test different scenarios
-- ============================================

-- Test 1: Basic SELECT (should work)
SELECT 'Test 1: Basic SELECT' as test, COUNT(*) as count FROM operational_costs;

-- Test 2: SELECT with user_id filter
SELECT 'Test 2: With user_id filter' as test, COUNT(*) as count 
FROM operational_costs 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

-- Test 3: SELECT with date filter
SELECT 'Test 3: With date filter' as test, COUNT(*) as count 
FROM operational_costs 
WHERE cost_date = '2026-02-08';

-- Test 4: SELECT with both filters (matching the API query)
SELECT 'Test 4: Both filters' as test, COUNT(*) as count 
FROM operational_costs 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
  AND cost_date = '2026-02-08';

-- Test 5: Check if RLS is affecting the query
-- Run as authenticated role simulation
SET LOCAL ROLE authenticated;
SELECT 'Test 5: As authenticated role' as test, COUNT(*) as count 
FROM operational_costs 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
RESET ROLE;

-- Test 6: Check table permissions
SELECT 
  'Test 6: Permissions' as test,
  grantee,
  privilege_type
FROM information_schema.table_privileges 
WHERE table_name = 'operational_costs';

-- Test 7: Check for any API-specific issues (like column names)
SELECT 
  'Test 7: Column names' as test,
  column_name,
  data_type
FROM information_schema.columns 
WHERE table_name = 'operational_costs'
  AND column_name IN ('id', 'user_id', 'cost_date', 'created_at', 'updated_at')
ORDER BY ordinal_position;

-- Final status
SELECT 
  'All tests completed' as status,
  'Check results above for any failures' as note;
