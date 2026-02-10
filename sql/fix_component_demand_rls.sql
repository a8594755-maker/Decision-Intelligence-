-- ============================================================
-- FIX: Component Demand Visibility & RLS
-- ============================================================

-- 1. Ensure RLS is enabled and policies are correct
ALTER TABLE component_demand ENABLE ROW LEVEL SECURITY;
ALTER TABLE component_demand_trace ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to ensure clean slate
DROP POLICY IF EXISTS "Users can view their own component_demand" ON component_demand;
DROP POLICY IF EXISTS "Users can insert their own component_demand" ON component_demand;
DROP POLICY IF EXISTS "Users can update their own component_demand" ON component_demand;
DROP POLICY IF EXISTS "Users can delete their own component_demand" ON component_demand;

DROP POLICY IF EXISTS "Users can view their own component_demand_trace" ON component_demand_trace;
DROP POLICY IF EXISTS "Users can insert their own component_demand_trace" ON component_demand_trace;
DROP POLICY IF EXISTS "Users can delete their own component_demand_trace" ON component_demand_trace;

-- Re-create Policies (Simple & Permissive for Owner)
CREATE POLICY "Users can view their own component_demand"
  ON component_demand FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own component_demand"
  ON component_demand FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own component_demand"
  ON component_demand FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own component_demand"
  ON component_demand FOR DELETE
  USING (auth.uid() = user_id);

-- Trace Policies
CREATE POLICY "Users can view their own component_demand_trace"
  ON component_demand_trace FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own component_demand_trace"
  ON component_demand_trace FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own component_demand_trace"
  ON component_demand_trace FOR DELETE
  USING (auth.uid() = user_id);

-- 2. Diagnostic: Show what's in the table for your user
DO $$
DECLARE
    v_count INTEGER;
    v_user_id UUID := '291075be-3bee-43ff-a296-17c8eecd26a1';
    v_batch_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count FROM component_demand WHERE user_id = v_user_id;
    SELECT COUNT(DISTINCT batch_id) INTO v_batch_count FROM component_demand WHERE user_id = v_user_id;
    
    RAISE NOTICE 'Diagnostic Result: Found % component_demand rows across % batches for user %', v_count, v_batch_count, v_user_id;
    
    IF v_count = 0 THEN
        RAISE NOTICE 'WARNING: No data found. The BOM Explosion might have failed to insert data, or inserted with a different User ID.';
    END IF;
END $$;

-- 3. Grant Permissions (Just in case)
GRANT ALL ON component_demand TO authenticated;
GRANT ALL ON component_demand_trace TO authenticated;
GRANT ALL ON component_demand TO service_role;
GRANT ALL ON component_demand_trace TO service_role;
