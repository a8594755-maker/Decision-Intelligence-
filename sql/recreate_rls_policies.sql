-- Recreate RLS policies for operational_costs
-- ============================================

-- 1. Drop existing policies
DROP POLICY IF EXISTS "Users can view their own costs" ON operational_costs;
DROP POLICY IF EXISTS "Users can insert their own costs" ON operational_costs;
DROP POLICY IF EXISTS "Users can update their own costs" ON operational_costs;

-- 2. Ensure RLS is enabled
ALTER TABLE operational_costs ENABLE ROW LEVEL SECURITY;

-- 3. Create new policies with explicit roles
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

-- 4. Grant permissions explicitly
GRANT SELECT, INSERT, UPDATE ON operational_costs TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;

-- 5. Verify policies were created
SELECT 
  'policy_check' as check_type,
  policyname,
  cmd,
  roles
FROM pg_policies 
WHERE tablename = 'operational_costs';
