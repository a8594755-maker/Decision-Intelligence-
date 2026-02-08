-- Check operational_costs table schema visibility
-- ============================================

-- 1. Check schema
SELECT 
  'table_schema' as check_type,
  table_schema
FROM information_schema.tables 
WHERE table_name = 'operational_costs';

-- 2. Verify API visibility
SELECT 
  'api_visibility' as check_type,
  CASE
    WHEN table_schema = 'public' THEN 'Visible'
    ELSE 'Not visible - must be in public schema'
  END as status
FROM information_schema.tables 
WHERE table_name = 'operational_costs';

-- 3. Check PostgREST cache status
SELECT 
  'cache_status' as check_type,
  'Last reload: Unknown' as note,
  'Execute: NOTIFY pgrst, ''reload schema'';' as fix_suggestion;
