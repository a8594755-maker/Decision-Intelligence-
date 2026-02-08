-- Temporarily disable RLS for testing
-- WARNING: This removes row-level security! Use only for debugging.
-- ============================================

-- Disable RLS temporarily
ALTER TABLE operational_costs DISABLE ROW LEVEL SECURITY;

-- Test if query works without RLS
SELECT 
  'rls_disabled_test' as check_type,
  'RLS temporarily disabled for testing' as status,
  COUNT(*) as record_count
FROM operational_costs;

-- Re-enable RLS after testing
-- ALTER TABLE operational_costs ENABLE ROW LEVEL SECURITY;
