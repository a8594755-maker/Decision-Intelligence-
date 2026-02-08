-- Quick fix for operational_costs table
-- ============================================

-- 1. Create table if not exists
CREATE TABLE IF NOT EXISTS operational_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cost_date DATE NOT NULL DEFAULT CURRENT_DATE,
  direct_labor_hours DECIMAL(10, 2) DEFAULT 0 CHECK (direct_labor_hours >= 0),
  direct_labor_rate DECIMAL(10, 2) DEFAULT 0 CHECK (direct_labor_rate >= 0),
  direct_labor_cost DECIMAL(12, 2) DEFAULT 0 CHECK (direct_labor_cost >= 0),
  indirect_labor_hours DECIMAL(10, 2) DEFAULT 0 CHECK (indirect_labor_hours >= 0),
  indirect_labor_rate DECIMAL(10, 2) DEFAULT 0 CHECK (indirect_labor_rate >= 0),
  indirect_labor_cost DECIMAL(12, 2) DEFAULT 0 CHECK (indirect_labor_cost >= 0),
  total_labor_cost DECIMAL(12, 2) DEFAULT 0 CHECK (total_labor_cost >= 0),
  production_output DECIMAL(10, 2) DEFAULT 0 CHECK (production_output >= 0),
  production_unit TEXT DEFAULT 'pcs',
  cost_per_unit DECIMAL(10, 4),
  material_cost DECIMAL(12, 2) DEFAULT 0 CHECK (material_cost >= 0),
  overhead_cost DECIMAL(12, 2) DEFAULT 0 CHECK (overhead_cost >= 0),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, cost_date)
);

-- 2. Enable RLS
ALTER TABLE operational_costs ENABLE ROW LEVEL SECURITY;

-- 3. Create policies (only if they don't exist)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'operational_costs' 
      AND policyname = 'Users can view their own costs'
  ) THEN
    CREATE POLICY "Users can view their own costs"
      ON operational_costs FOR SELECT
      USING (auth.uid() = user_id);
    RAISE NOTICE 'Created SELECT policy';
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'operational_costs' 
      AND policyname = 'Users can insert their own costs'
  ) THEN
    CREATE POLICY "Users can insert their own costs"
      ON operational_costs FOR INSERT
      WITH CHECK (auth.uid() = user_id);
    RAISE NOTICE 'Created INSERT policy';
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'operational_costs' 
      AND policyname = 'Users can update their own costs'
  ) THEN
    CREATE POLICY "Users can update their own costs"
      ON operational_costs FOR UPDATE
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
    RAISE NOTICE 'Created UPDATE policy';
  END IF;
END $$;

-- 4. Grant necessary permissions to authenticated users
GRANT SELECT, INSERT, UPDATE ON operational_costs TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;

-- 5. Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_operational_costs_user 
  ON operational_costs(user_id);

CREATE INDEX IF NOT EXISTS idx_operational_costs_date 
  ON operational_costs(cost_date DESC);

CREATE INDEX IF NOT EXISTS idx_operational_costs_user_date 
  ON operational_costs(user_id, cost_date DESC);

-- 6. Test with postgres user (should work)
SELECT 'Table exists and is accessible' as status;
