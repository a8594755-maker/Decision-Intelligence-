-- Comprehensive 406 Error Diagnostic
-- ============================================

-- 1. Table existence check
SELECT 
  'table_existence' as check_type,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM information_schema.tables 
      WHERE table_name = 'operational_costs'
    ) THEN 'PASS: Table exists'
    ELSE 'FAIL: Table does not exist'
  END as result;

-- 2. Schema visibility check
SELECT 
  'schema_visibility' as check_type,
  table_schema,
  CASE
    WHEN table_schema = 'public' THEN 'PASS: Visible to PostgREST'
    ELSE 'FAIL: Table not in public schema'
  END as status
FROM information_schema.tables 
WHERE table_name = 'operational_costs';

-- 3. PostgREST cache status
SELECT 
  'postgrest_cache' as check_type,
  'Last reload: Unknown' as note,
  'Execute: NOTIFY pgrst, ''reload schema'';' as fix_suggestion;

-- 4. RLS policy check
SELECT 
  'rls_policies' as check_type,
  policyname,
  cmd,
  roles
FROM pg_policies 
WHERE tablename = 'operational_costs';

-- 5. API endpoint test
SELECT 
  'api_endpoint_test' as check_type,
  '/rest/v1/operational_costs' as endpoint,
  '406 Not Acceptable' as current_status,
  'Should be 200 OK' as expected_status;

-- 6. Final recommendation
SELECT 
  'recommendation' as check_type,
  CASE
    WHEN (SELECT COUNT(*) FROM pg_policies WHERE tablename = 'operational_costs') = 0
      THEN 'Create RLS policies'
    WHEN (SELECT table_schema FROM information_schema.tables WHERE table_name = 'operational_costs') != 'public'
      THEN 'Move table to public schema'
    ELSE 'Execute: NOTIFY pgrst, ''reload schema''; and wait 60 seconds'
  END as action;
