-- ============================================
-- SmartOps 成本分析模块 - 数据库架构
-- ============================================
-- 创建日期: 2025-12-02
-- 说明: 包含营运成本记录与异常检测所需的表

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

-- 添加注释
COMMENT ON TABLE operational_costs IS '营运成本记录表 - 存储每日直接和间接人工成本';
COMMENT ON COLUMN operational_costs.cost_date IS '成本日期';
COMMENT ON COLUMN operational_costs.direct_labor_cost IS '直接人工成本（工时 × 时薪）';
COMMENT ON COLUMN operational_costs.indirect_labor_cost IS '间接人工成本（工时 × 时薪）';
COMMENT ON COLUMN operational_costs.total_labor_cost IS '总人工成本';
COMMENT ON COLUMN operational_costs.cost_per_unit IS '单位产品成本（总成本 / 产出）';

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

-- 添加注释
COMMENT ON TABLE cost_anomalies IS '成本异常记录表 - 存储检测到的成本异常';
COMMENT ON COLUMN cost_anomalies.anomaly_type IS '异常类型';
COMMENT ON COLUMN cost_anomalies.severity IS '严重程度: low, medium, high, critical';
COMMENT ON COLUMN cost_anomalies.deviation_percent IS '偏差百分比';
COMMENT ON COLUMN cost_anomalies.ai_analysis IS 'AI 分析结果';

-- ============================================
-- 启用 Row Level Security (RLS)
-- ============================================

-- operational_costs 表的 RLS
ALTER TABLE operational_costs ENABLE ROW LEVEL SECURITY;

-- 用户只能查看自己的成本记录
DROP POLICY IF EXISTS "Users can view their own costs" ON operational_costs;
CREATE POLICY "Users can view their own costs"
  ON operational_costs FOR SELECT
  USING (auth.uid() = user_id);

-- 用户只能插入自己的成本记录
DROP POLICY IF EXISTS "Users can insert their own costs" ON operational_costs;
CREATE POLICY "Users can insert their own costs"
  ON operational_costs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 用户只能更新自己的成本记录
DROP POLICY IF EXISTS "Users can update their own costs" ON operational_costs;
CREATE POLICY "Users can update their own costs"
  ON operational_costs FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 用户只能删除自己的成本记录
DROP POLICY IF EXISTS "Users can delete their own costs" ON operational_costs;
CREATE POLICY "Users can delete their own costs"
  ON operational_costs FOR DELETE
  USING (auth.uid() = user_id);

-- cost_anomalies 表的 RLS
ALTER TABLE cost_anomalies ENABLE ROW LEVEL SECURITY;

-- 用户只能查看自己的异常记录
DROP POLICY IF EXISTS "Users can view their own anomalies" ON cost_anomalies;
CREATE POLICY "Users can view their own anomalies"
  ON cost_anomalies FOR SELECT
  USING (auth.uid() = user_id);

-- 用户只能插入自己的异常记录
DROP POLICY IF EXISTS "Users can insert their own anomalies" ON cost_anomalies;
CREATE POLICY "Users can insert their own anomalies"
  ON cost_anomalies FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 用户只能更新自己的异常记录
DROP POLICY IF EXISTS "Users can update their own anomalies" ON cost_anomalies;
CREATE POLICY "Users can update their own anomalies"
  ON cost_anomalies FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 用户只能删除自己的异常记录
DROP POLICY IF EXISTS "Users can delete their own anomalies" ON cost_anomalies;
CREATE POLICY "Users can delete their own anomalies"
  ON cost_anomalies FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 触发器：自动更新 updated_at
-- ============================================

-- 创建更新时间戳的函数
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 为 operational_costs 表添加触发器
DROP TRIGGER IF EXISTS update_operational_costs_updated_at ON operational_costs;
CREATE TRIGGER update_operational_costs_updated_at
    BEFORE UPDATE ON operational_costs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 为 cost_anomalies 表添加触发器
DROP TRIGGER IF EXISTS update_cost_anomalies_updated_at ON cost_anomalies;
CREATE TRIGGER update_cost_anomalies_updated_at
    BEFORE UPDATE ON cost_anomalies
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 插入示例数据（用于测试，可选）
-- ============================================

-- 注意：以下 INSERT 语句仅用于开发测试
-- 生产环境中请注释掉或删除

/*
-- 示例：插入一条成本记录
INSERT INTO operational_costs (
  user_id,
  cost_date,
  direct_labor_hours,
  direct_labor_rate,
  direct_labor_cost,
  indirect_labor_hours,
  indirect_labor_rate,
  indirect_labor_cost,
  total_labor_cost,
  production_output,
  cost_per_unit
) VALUES (
  auth.uid(),
  CURRENT_DATE,
  160,        -- 直接人工工时
  150,        -- 时薪 150
  24000,      -- 160 × 150 = 24000
  80,         -- 间接人工工时
  120,        -- 时薪 120
  9600,       -- 80 × 120 = 9600
  33600,      -- 24000 + 9600 = 33600
  1000,       -- 产出 1000 件
  33.6        -- 33600 / 1000 = 33.6
);
*/

-- ============================================
-- 完成提示
-- ============================================

DO $$
BEGIN
  RAISE NOTICE '================================================';
  RAISE NOTICE '成本分析模块数据库架构创建完成！';
  RAISE NOTICE '================================================';
  RAISE NOTICE '';
  RAISE NOTICE '已创建的表:';
  RAISE NOTICE '  1. operational_costs  - 营运成本记录';
  RAISE NOTICE '  2. cost_anomalies     - 成本异常记录';
  RAISE NOTICE '';
  RAISE NOTICE '已配置:';
  RAISE NOTICE '  ✓ Row Level Security (RLS)';
  RAISE NOTICE '  ✓ 索引优化';
  RAISE NOTICE '  ✓ 自动更新时间戳';
  RAISE NOTICE '  ✓ 数据约束检查';
  RAISE NOTICE '';
  RAISE NOTICE '下一步:';
  RAISE NOTICE '  1. 在 Supabase SQL Editor 中执行此脚本';
  RAISE NOTICE '  2. 验证表结构: SELECT * FROM operational_costs LIMIT 1;';
  RAISE NOTICE '  3. 开始开发 costAnalysisService.js';
  RAISE NOTICE '================================================';
END $$;
