-- ============================================
-- SmartOps BOM Forecast 模块 - 数据库架构
-- ============================================
-- 创建日期: 2026-01-08
-- 说明: 包含 BOM 关系、FG 需求、Component 需求计算所需的表
-- 用途: 支持 BOM Explosion MVP 功能

-- ============================================
-- 表1: bom_edges - BOM 关系表（父子件用量关系）
-- ============================================
CREATE TABLE IF NOT EXISTS bom_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  batch_id UUID, -- 批次 ID（用于追溯，可关联到 import_batches）

  -- BOM 关系核心字段
  parent_material TEXT NOT NULL,  -- 父件料号
  child_material TEXT NOT NULL,   -- 子件料号
  qty_per DECIMAL(10, 4) NOT NULL CHECK (qty_per > 0), -- 单位用量（必须 > 0）
  uom TEXT DEFAULT 'pcs',         -- 单位

  -- 工厂和版本
  plant_id TEXT,                  -- 工厂代码（多厂支持）
  bom_version TEXT,               -- BOM 版本

  -- 时效性
  valid_from DATE,                -- 生效日期
  valid_to DATE,                  -- 失效日期

  -- 损耗和良率
  scrap_rate DECIMAL(5, 4),       -- 损耗率 (0 <= scrap_rate < 1)
  yield_rate DECIMAL(5, 4),       -- 良率 (0 < yield_rate <= 1)

  -- 替代料相关
  alt_group TEXT,                 -- 替代料组
  priority INTEGER,                -- 优先顺序（数字越小优先级越高）
  mix_ratio DECIMAL(5, 4),       -- 混合比例 (0 < mix_ratio <= 1)

  -- 工程变更
  ecn_number TEXT,                -- 工程变更单号
  ecn_effective_date DATE,        -- ECN 生效日

  -- 制程
  routing_id TEXT,                -- 制程代码

  -- 备注
  notes TEXT,

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- 约束：同一用户、同一父件、同一子件、同一工厂的组合应该唯一（可选，根据业务需求）
  -- UNIQUE(user_id, parent_material, child_material, plant_id)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_bom_edges_user
  ON bom_edges(user_id);

CREATE INDEX IF NOT EXISTS idx_bom_edges_batch
  ON bom_edges(batch_id);

CREATE INDEX IF NOT EXISTS idx_bom_edges_parent
  ON bom_edges(parent_material);

CREATE INDEX IF NOT EXISTS idx_bom_edges_child
  ON bom_edges(child_material);

CREATE INDEX IF NOT EXISTS idx_bom_edges_user_parent
  ON bom_edges(user_id, parent_material);

CREATE INDEX IF NOT EXISTS idx_bom_edges_plant
  ON bom_edges(plant_id);

-- 添加注释
COMMENT ON TABLE bom_edges IS 'BOM 关系表 - 存储父子件用量关系，用于 BOM explosion';
COMMENT ON COLUMN bom_edges.parent_material IS '父件料号（FG 或 Assembly）';
COMMENT ON COLUMN bom_edges.child_material IS '子件料号（Component）';
COMMENT ON COLUMN bom_edges.qty_per IS '单位用量（每个父件需要多少子件）';
COMMENT ON COLUMN bom_edges.batch_id IS '批次 ID（用于追溯导入来源）';

-- ============================================
-- 表2: demand_fg - FG 需求表（成品需求时间序列）
-- ============================================
CREATE TABLE IF NOT EXISTS demand_fg (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  batch_id UUID, -- 批次 ID（用于追溯，可关联到 import_batches）

  -- 需求核心字段
  material_code TEXT NOT NULL,    -- 成品料号（FG）
  plant_id TEXT NOT NULL,         -- 工厂代码（必填，支持多厂）
  time_bucket TEXT NOT NULL,      -- 时间桶（统一时间键，从 week_bucket 或 date 填入）
  week_bucket TEXT,               -- 周桶格式：YYYY-W##（例如：2026-W02）
  date DATE,                       -- 日期格式：YYYY-MM-DD（例如：2026-01-08）
  demand_qty DECIMAL(12, 2) NOT NULL CHECK (demand_qty >= 0), -- 需求数量
  uom TEXT DEFAULT 'pcs',         -- 单位

  -- 需求来源
  source_type TEXT,                -- 需求来源类型：SO, forecast, manual, other
  source_id TEXT,                  -- 需求来源 ID（如订单号、预测编号等）

  -- 关联信息
  customer_id TEXT,                -- 客户代码
  project_id TEXT,                 -- 项目代码

  -- 优先级和状态
  priority INTEGER,                -- 优先顺序（数字越小优先级越高）
  status TEXT DEFAULT 'confirmed', -- 状态：draft, confirmed, cancelled

  -- 备注
  notes TEXT,

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_demand_fg_user
  ON demand_fg(user_id);

CREATE INDEX IF NOT EXISTS idx_demand_fg_batch
  ON demand_fg(batch_id);

CREATE INDEX IF NOT EXISTS idx_demand_fg_material
  ON demand_fg(material_code);

CREATE INDEX IF NOT EXISTS idx_demand_fg_plant
  ON demand_fg(plant_id);

CREATE INDEX IF NOT EXISTS idx_demand_fg_time_bucket
  ON demand_fg(time_bucket);

CREATE INDEX IF NOT EXISTS idx_demand_fg_user_material_time
  ON demand_fg(user_id, material_code, time_bucket);

-- 添加注释
COMMENT ON TABLE demand_fg IS 'FG 需求表 - 存储成品需求时间序列数据';
COMMENT ON COLUMN demand_fg.material_code IS '成品料号（Finished Goods）';
COMMENT ON COLUMN demand_fg.plant_id IS '工厂代码（必填，支持多厂）';
COMMENT ON COLUMN demand_fg.time_bucket IS '时间桶（统一时间键，从 week_bucket 或 date 自动填入）';
COMMENT ON COLUMN demand_fg.week_bucket IS '周桶格式：YYYY-W##（例如：2026-W02）';
COMMENT ON COLUMN demand_fg.date IS '日期格式：YYYY-MM-DD（例如：2026-01-08）';
COMMENT ON COLUMN demand_fg.batch_id IS '批次 ID（用于追溯导入来源）';

-- ============================================
-- 表3: component_demand - Component 需求表（预留，用于下一步 BOM explosion 计算）
-- ============================================
CREATE TABLE IF NOT EXISTS component_demand (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  batch_id UUID, -- 批次 ID（用于追溯计算批次）

  -- 需求核心字段
  material_code TEXT NOT NULL,    -- Component 料号
  plant_id TEXT NOT NULL,          -- 工厂代码
  time_bucket TEXT NOT NULL,      -- 时间桶
  demand_qty DECIMAL(12, 2) NOT NULL CHECK (demand_qty >= 0), -- 需求数量
  uom TEXT DEFAULT 'pcs',         -- 单位

  -- 计算来源（用于追溯）
  source_fg_material TEXT,        -- 来源 FG 料号
  source_fg_demand_id UUID,       -- 来源 FG 需求 ID（关联到 demand_fg.id）
  bom_level INTEGER,               -- BOM 层级（1 = 直接子件，2 = 子件的子件，以此类推）

  -- 备注
  notes TEXT,

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_component_demand_user
  ON component_demand(user_id);

CREATE INDEX IF NOT EXISTS idx_component_demand_batch
  ON component_demand(batch_id);

CREATE INDEX IF NOT EXISTS idx_component_demand_material
  ON component_demand(material_code);

CREATE INDEX IF NOT EXISTS idx_component_demand_plant
  ON component_demand(plant_id);

CREATE INDEX IF NOT EXISTS idx_component_demand_time_bucket
  ON component_demand(time_bucket);

CREATE INDEX IF NOT EXISTS idx_component_demand_user_material_time
  ON component_demand(user_id, material_code, time_bucket);

-- 添加注释
COMMENT ON TABLE component_demand IS 'Component 需求表 - 存储通过 BOM explosion 计算出的 Component 需求（预留）';
COMMENT ON COLUMN component_demand.material_code IS 'Component 料号';
COMMENT ON COLUMN component_demand.source_fg_material IS '来源 FG 料号（用于追溯）';
COMMENT ON COLUMN component_demand.bom_level IS 'BOM 层级（1 = 直接子件，2 = 子件的子件）';

-- ============================================
-- 表4: component_demand_trace - Component 需求追溯表（预留，用于追溯需求来源）
-- ============================================
CREATE TABLE IF NOT EXISTS component_demand_trace (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  batch_id UUID, -- 批次 ID

  -- 追溯关系
  component_demand_id UUID NOT NULL, -- 关联到 component_demand.id
  fg_demand_id UUID NOT NULL,        -- 关联到 demand_fg.id
  bom_edge_id UUID,                  -- 关联到 bom_edges.id（用于追溯 BOM 路径）

  -- 计算信息
  qty_multiplier DECIMAL(12, 4),    -- 数量乘数（用于追溯计算过程）
  bom_level INTEGER,                 -- BOM 层级

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_component_demand_trace_user
  ON component_demand_trace(user_id);

CREATE INDEX IF NOT EXISTS idx_component_demand_trace_batch
  ON component_demand_trace(batch_id);

CREATE INDEX IF NOT EXISTS idx_component_demand_trace_component
  ON component_demand_trace(component_demand_id);

CREATE INDEX IF NOT EXISTS idx_component_demand_trace_fg
  ON component_demand_trace(fg_demand_id);

-- 添加注释
COMMENT ON TABLE component_demand_trace IS 'Component 需求追溯表 - 用于追溯 Component 需求来源（预留）';
COMMENT ON COLUMN component_demand_trace.component_demand_id IS 'Component 需求 ID';
COMMENT ON COLUMN component_demand_trace.fg_demand_id IS '来源 FG 需求 ID';
COMMENT ON COLUMN component_demand_trace.qty_multiplier IS '数量乘数（用于追溯计算过程）';

-- ============================================
-- 启用 Row Level Security (RLS)
-- ============================================

-- bom_edges 表的 RLS
ALTER TABLE bom_edges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own bom_edges"
  ON bom_edges FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own bom_edges"
  ON bom_edges FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own bom_edges"
  ON bom_edges FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own bom_edges"
  ON bom_edges FOR DELETE
  USING (auth.uid() = user_id);

-- demand_fg 表的 RLS
ALTER TABLE demand_fg ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own demand_fg"
  ON demand_fg FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own demand_fg"
  ON demand_fg FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own demand_fg"
  ON demand_fg FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own demand_fg"
  ON demand_fg FOR DELETE
  USING (auth.uid() = user_id);

-- component_demand 表的 RLS
ALTER TABLE component_demand ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own component_demand"
  ON component_demand FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own component_demand"
  ON component_demand FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own component_demand"
  ON component_demand FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own component_demand"
  ON component_demand FOR DELETE
  USING (auth.uid() = user_id);

-- component_demand_trace 表的 RLS
ALTER TABLE component_demand_trace ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own component_demand_trace"
  ON component_demand_trace FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own component_demand_trace"
  ON component_demand_trace FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own component_demand_trace"
  ON component_demand_trace FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own component_demand_trace"
  ON component_demand_trace FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 触发器：自动更新 updated_at
-- ============================================

-- 为 bom_edges 表添加触发器
DROP TRIGGER IF EXISTS update_bom_edges_updated_at ON bom_edges;
CREATE TRIGGER update_bom_edges_updated_at
    BEFORE UPDATE ON bom_edges
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 为 demand_fg 表添加触发器
DROP TRIGGER IF EXISTS update_demand_fg_updated_at ON demand_fg;
CREATE TRIGGER update_demand_fg_updated_at
    BEFORE UPDATE ON demand_fg
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 为 component_demand 表添加触发器
DROP TRIGGER IF EXISTS update_component_demand_updated_at ON component_demand;
CREATE TRIGGER update_component_demand_updated_at
    BEFORE UPDATE ON component_demand
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 完成提示
-- ============================================
DO $$
BEGIN
  RAISE NOTICE '================================================';
  RAISE NOTICE 'BOM Forecast 模块数据库架构创建完成！';
  RAISE NOTICE '================================================';
  RAISE NOTICE '';
  RAISE NOTICE '已创建的表:';
  RAISE NOTICE '  1. bom_edges              - BOM 关系表';
  RAISE NOTICE '  2. demand_fg              - FG 需求表';
  RAISE NOTICE '  3. component_demand        - Component 需求表（预留）';
  RAISE NOTICE '  4. component_demand_trace - Component 需求追溯表（预留）';
  RAISE NOTICE '';
  RAISE NOTICE '已配置:';
  RAISE NOTICE '  ✓ Row Level Security (RLS)';
  RAISE NOTICE '  ✓ 索引优化';
  RAISE NOTICE '  ✓ 自动更新时间戳';
  RAISE NOTICE '  ✓ 数据约束检查';
  RAISE NOTICE '';
  RAISE NOTICE '下一步:';
  RAISE NOTICE '  1. 在 Supabase SQL Editor 中执行此脚本';
  RAISE NOTICE '  2. 验证表结构: SELECT * FROM bom_edges LIMIT 1;';
  RAISE NOTICE '  3. 开始上传 BOM 和需求数据';
  RAISE NOTICE '================================================';
END $$;
