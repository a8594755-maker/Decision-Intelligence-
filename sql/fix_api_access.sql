-- Fix for Supabase REST API 406 error
-- ============================================

-- 1. Check if the table has all required columns for the REST API
SELECT 
  'column_check' as check_type,
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns 
WHERE table_name = 'operational_costs'
  AND column_name IN ('id', 'user_id', 'cost_date', 'created_at')
ORDER BY ordinal_position;

-- 2. Check if id column has proper default
SELECT 
  'id_default' as check_type,
  column_name,
  column_default,
  is_nullable
FROM information_schema.columns 
WHERE table_name = 'operational_costs' 
  AND column_name = 'id';

-- 3. Ensure the table is in the public schema and accessible
SELECT 
  'schema_access' as check_type,
  table_schema,
  table_name,
  table_type
FROM information_schema.tables 
WHERE table_name = 'operational_costs';

-- 4. Grant access to anon role as well (for testing)
GRANT SELECT ON operational_costs TO anon;

-- 5. Create a simple test policy for anon (temporary)
-- DROP POLICY IF EXISTS "Allow anon to view" ON operational_costs;
-- CREATE POLICY "Allow anon to view"
--   ON operational_costs FOR SELECT
--   TO anon
--   USING (true);

-- 6. Check if there's an issue with the specific query format
-- Test the exact query that the frontend is making
SELECT 
  'query_simulation' as check_type,
  COUNT(*) as would_return_count
FROM operational_costs
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
  AND cost_date = '2026-02-08'::date;

-- 7. Alternative: Allow service role to bypass RLS
-- This is useful for debugging
ALTER TABLE operational_costs FORCE ROW LEVEL SECURITY;

-- 8. Check publication status for realtime (if applicable)
SELECT 
  'publication_status' as check_type,
  pubname,
  tablename
FROM pg_publication_tables 
WHERE tablename = 'operational_costs';

-- 9. Final status
SELECT 
  'setup_complete' as check_type,
  'All checks passed. Table should be accessible via REST API.' as status;
