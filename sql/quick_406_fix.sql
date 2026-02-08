-- Quick fix for 406 error
-- ============================================

-- 1. Drop and recreate RLS policies with explicit authenticated role
DROP POLICY IF EXISTS "Users can view their own costs" ON operational_costs;
DROP POLICY IF EXISTS "Users can insert their own costs" ON operational_costs;
DROP POLICY IF EXISTS "Users can update their own costs" ON operational_costs;

-- 2. Enable RLS
ALTER TABLE operational_costs ENABLE ROW LEVEL SECURITY;

-- 3. Create policies for authenticated role only
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

-- 4. Grant permissions
GRANT SELECT, INSERT, UPDATE ON operational_costs TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;

-- 5. Test query
SELECT 'RLS fixed' as status, COUNT(*) as records 
FROM operational_costs 
WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
