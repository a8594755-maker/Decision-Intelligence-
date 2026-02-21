-- ============================================
-- Decision-Intelligence 成本分析模块 - 数据库架构 (跳过已存在的策略)
-- ============================================
-- 创建日期: 2025-12-02
-- 说明: 包含营运成本记录与异常检测所需的表
-- 修改: 跳过已存在的 RLS 策略创建

-- ============================================
-- 表1: operational_costs - 营运成本记录
-- ============================================
CREATE TABLE IF NOT EXISTS operational_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 日期
  cost_date DATE NOT NULL DEFAULT CURRENT_DATE,

  -- 直接人工成本
  direct_labor_hours DECIMAL(10, 2) DEFAULT 0 CHECK (direct_labor_hours >= 0),
  direct_labor_rate DECIMAL(10, 2) DEFAULT 0 CHECK (direct_labor_rate >= 0),
  direct_labor_cost DECIMAL(12, 2) DEFAULT 0 CHECK (direct_labor_cost >= 0),

  -- 间接人工成本
  indirect_labor_hours DECIMAL(10, 2) DEFAULT 0 CHECK (indirect_labor_hours >= 0),
  indirect_labor_rate DECIMAL(10, 2) DEFAULT 0 CHECK (indirect_labor_rate >= 0),
  indirect_labor_cost DECIMAL(12, 2) DEFAULT 0 CHECK (indirect_labor_cost >= 0),

  -- 总成本
  total_labor_cost DECIMAL(12, 2) DEFAULT 0 CHECK (total_labor_cost >= 0),

  -- 产出信息
  production_output DECIMAL(10, 2) DEFAULT 0 CHECK (production_output >= 0),
  production_unit TEXT DEFAULT 'pcs',

  -- 单位成本
  cost_per_unit DECIMAL(10, 4),

  -- 其他成本（可选）
  material_cost DECIMAL(12, 2) DEFAULT 0 CHECK (material_cost >= 0),
  overhead_cost DECIMAL(12, 2) DEFAULT 0 CHECK (overhead_cost >= 0),

  -- 备注
  notes TEXT,

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- 确保每个用户每天只有一条记录
  UNIQUE(user_id, cost_date)
);

-- 创建索引以优化查询
CREATE INDEX IF NOT EXISTS idx_operational_costs_user
  ON operational_costs(user_id);

CREATE INDEX IF NOT EXISTS idx_operational_costs_date
  ON operational_costs(cost_date DESC);

CREATE INDEX IF NOT EXISTS idx_operational_costs_user_date
  ON operational_costs(user_id, cost_date DESC);

-- ============================================
-- 表2: cost_anomalies - 成本异常记录
-- ============================================
CREATE TABLE IF NOT EXISTS cost_anomalies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cost_id UUID REFERENCES operational_costs(id) ON DELETE CASCADE,

  -- 异常类型
  anomaly_type TEXT NOT NULL CHECK (anomaly_type IN (
    'high_cost',           -- 高成本
    'efficiency_drop',     -- 效率下降
    'overhead_spike',      -- 间接费用激增
    'labor_cost_spike',    -- 人工成本激增
    'low_output',          -- 产出过低
    'unit_cost_spike'      -- 单位成本激增
  )),

  -- 严重程度
  severity TEXT DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),

  -- 异常详情
  anomaly_date DATE NOT NULL,
  detected_value DECIMAL(12, 2),
  expected_value DECIMAL(12, 2),
  deviation_percent DECIMAL(5, 2),

  -- 描述与分析
  description TEXT,
  ai_analysis TEXT,

  -- 状态
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'investigating', 'resolved', 'ignored')),
  resolution_notes TEXT,
  resolved_at TIMESTAMPTZ,

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_cost_anomalies_user
  ON cost_anomalies(user_id);

CREATE INDEX IF NOT EXISTS idx_cost_anomalies_date
  ON cost_anomalies(anomaly_date DESC);

CREATE INDEX IF NOT EXISTS idx_cost_anomalies_status
  ON cost_anomalies(status);

CREATE INDEX IF NOT EXISTS idx_cost_anomalies_severity
  ON cost_anomalies(severity);

CREATE INDEX IF NOT EXISTS idx_cost_anomalies_cost
  ON cost_anomalies(cost_id);

-- ============================================
-- 启用 Row Level Security (RLS) - 跳过已存在的策略
-- ============================================

-- operational_costs 表的 RLS
ALTER TABLE operational_costs ENABLE ROW LEVEL SECURITY;

-- 只创建不存在的策略
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
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'operational_costs' 
      AND policyname = 'Users can insert their own costs'
  ) THEN
    CREATE POLICY "Users can insert their own costs"
      ON operational_costs FOR INSERT
      WITH CHECK (auth.uid() = user_id);
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
  END IF;
END $$;

-- cost_anomalies 表的 RLS
ALTER TABLE cost_anomalies ENABLE ROW LEVEL SECURITY;

-- 只创建不存在的策略
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'cost_anomalies' 
      AND policyname = 'Users can view their own anomalies'
  ) THEN
    CREATE POLICY "Users can view their own anomalies"
      ON cost_anomalies FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'cost_anomalies' 
      AND policyname = 'Users can insert their own anomalies'
  ) THEN
    CREATE POLICY "Users can insert their own anomalies"
      ON cost_anomalies FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'cost_anomalies' 
      AND policyname = 'Users can update their own anomalies'
  ) THEN
    CREATE POLICY "Users can update their own anomalies"
      ON cost_anomalies FOR UPDATE
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================
-- 创建触发器以自动更新 updated_at 字段
-- ============================================

-- operational_costs updated_at 触发器
CREATE OR REPLACE FUNCTION update_operational_costs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS operational_costs_updated_at_trigger ON operational_costs;
CREATE TRIGGER operational_costs_updated_at_trigger
  BEFORE UPDATE ON operational_costs
  FOR EACH ROW
  EXECUTE FUNCTION update_operational_costs_updated_at();

-- cost_anomalies updated_at 触发器
CREATE OR REPLACE FUNCTION update_cost_anomalies_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cost_anomalies_updated_at_trigger ON cost_anomalies;
CREATE TRIGGER cost_anomalies_updated_at_trigger
  BEFORE UPDATE ON cost_anomalies
  FOR EACH ROW
  EXECUTE FUNCTION update_cost_anomalies_updated_at();
