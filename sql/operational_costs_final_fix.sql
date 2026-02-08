-- Operational Costs Final Fix
-- ============================================

-- 1. Verify table exists in public schema
SELECT 
  'Step 1: Verify schema' as step,
  CASE 
    WHEN EXISTS (
      SELECT 1 
      FROM information_schema.tables 
      WHERE table_name = 'operational_costs' 
        AND table_schema = 'public'
    ) THEN 'PASS: Table exists in public schema'
    ELSE 'FAIL: Table not in public schema'
  END as result;

-- 2. Force PostgREST schema reload
NOTIFY pgrst, 'reload schema';

-- 3. Grant necessary permissions
GRANT SELECT, INSERT, UPDATE ON operational_costs TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;

-- 4. Recreate RLS policies with explicit role targeting
DO $$
BEGIN
  -- Drop existing policies
  DROP POLICY IF EXISTS "Users can view their own costs" ON operational_costs;
  DROP POLICY IF EXISTS "Users can insert their own costs" ON operational_costs;
  DROP POLICY IF EXISTS "Users can update their own costs" ON operational_costs;
  
  -- Create new policies
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
    
  RAISE NOTICE 'RLS policies recreated';
END $$;

-- 5. Test access
SELECT 
  'Step 5: Test access' as step,
  COUNT(*) as record_count
FROM operational_costs 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

-- 6. Final instructions
SELECT 
  'Final step' as step,
  'Execute this script, then refresh your browser' as instruction;
