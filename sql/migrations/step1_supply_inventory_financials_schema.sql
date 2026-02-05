-- ============================================
-- SmartOps Supply, Inventory & Financials 模块 - 数据库架构
-- ============================================
-- 创建日期: 2026-01-31
-- 说明: 包含采购订单未交货、库存快照、成品财务数据所需的表
-- 用途: 支持供应链计划、库存管理、成本分析功能
--
-- 包含的表:
--   1. po_open_lines        - 采购订单未交货明细（Open PO / Supply Commitments）
--   2. inventory_snapshots  - 库存快照（Inventory Snapshot）
--   3. fg_financials        - 成品财务数据（FG Margin / Price Rules）
--
-- ============================================

-- ============================================
-- 辅助函数：自动更新 updated_at
-- ============================================

-- 创建或替换更新时间戳的函数（如果不存在）
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

COMMENT ON FUNCTION update_updated_at_column() IS '触发器函数 - 自动更新 updated_at 字段';

-- ============================================
-- 表1: po_open_lines - 采购订单未交货明细
-- ============================================
-- 用途: 追踪采购订单的未交货数量，用于供应链计划和物料可用性分析
-- ============================================

CREATE TABLE IF NOT EXISTS po_open_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  batch_id UUID, -- 批次 ID（用于追溯导入来源）

  -- 采购订单核心字段
  po_number TEXT NOT NULL,        -- 采购订单号
  po_line TEXT NOT NULL,          -- 订单行号
  material_code TEXT NOT NULL,    -- 物料代码
  plant_id TEXT NOT NULL,         -- 工厂代码
  time_bucket TEXT NOT NULL,      -- 时间桶（支持周别 YYYY-W## 或日期 YYYY-MM-DD）
  open_qty NUMERIC(12, 2) NOT NULL CHECK (open_qty >= 0), -- 未交货数量

  -- 可选字段
  uom TEXT DEFAULT 'pcs',         -- 计量单位
  supplier_id TEXT,               -- 供应商代码
  status TEXT DEFAULT 'open',     -- 状态: open, closed, cancelled
  notes TEXT,                     -- 备注

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- 唯一性约束：同一用户、同一采购订单行、同一时间桶组合应该唯一（支持 upsert）
  UNIQUE(user_id, po_number, po_line, time_bucket)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_po_open_lines_user
  ON po_open_lines(user_id);

CREATE INDEX IF NOT EXISTS idx_po_open_lines_batch
  ON po_open_lines(batch_id);

CREATE INDEX IF NOT EXISTS idx_po_open_lines_user_plant_time
  ON po_open_lines(user_id, plant_id, time_bucket);

CREATE INDEX IF NOT EXISTS idx_po_open_lines_user_material
  ON po_open_lines(user_id, material_code);

CREATE INDEX IF NOT EXISTS idx_po_open_lines_supplier
  ON po_open_lines(supplier_id);

CREATE INDEX IF NOT EXISTS idx_po_open_lines_status
  ON po_open_lines(status);

-- 添加注释
COMMENT ON TABLE po_open_lines IS '采购订单未交货明细 - 追踪 PO 未交货数量，用于供应链计划';
COMMENT ON COLUMN po_open_lines.po_number IS '采购订单号';
COMMENT ON COLUMN po_open_lines.po_line IS '订单行号（10, 20, 30...）';
COMMENT ON COLUMN po_open_lines.material_code IS '物料代码（Component 或 Raw Material）';
COMMENT ON COLUMN po_open_lines.time_bucket IS '时间桶（支持周别 YYYY-W## 或日期 YYYY-MM-DD）';
COMMENT ON COLUMN po_open_lines.open_qty IS '未交货数量（尚未收货的数量）';
COMMENT ON COLUMN po_open_lines.status IS '状态: open=未交货, closed=已完成, cancelled=已取消';

-- ============================================
-- 表2: inventory_snapshots - 库存快照
-- ============================================
-- 用途: 记录特定时间点的库存状态，用于库存管理和计划
-- ============================================

CREATE TABLE IF NOT EXISTS inventory_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  batch_id UUID, -- 批次 ID（用于追溯导入来源）

  -- 库存核心字段
  material_code TEXT NOT NULL,    -- 物料代码
  plant_id TEXT NOT NULL,         -- 工厂代码
  snapshot_date DATE NOT NULL,    -- 快照日期（YYYY-MM-DD）
  onhand_qty NUMERIC(12, 2) NOT NULL CHECK (onhand_qty >= 0), -- 在库数量

  -- 可选字段
  allocated_qty NUMERIC(12, 2) DEFAULT 0 CHECK (allocated_qty >= 0), -- 已分配数量
  safety_stock NUMERIC(12, 2) DEFAULT 0 CHECK (safety_stock >= 0),   -- 安全库存
  uom TEXT DEFAULT 'pcs',         -- 计量单位
  notes TEXT,                     -- 备注

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- 唯一性约束：同一用户、同一物料、同一工厂、同一快照日期组合应该唯一（支持 upsert）
  UNIQUE(user_id, material_code, plant_id, snapshot_date)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_user
  ON inventory_snapshots(user_id);

CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_batch
  ON inventory_snapshots(batch_id);

CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_user_plant_date
  ON inventory_snapshots(user_id, plant_id, snapshot_date);

CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_user_material
  ON inventory_snapshots(user_id, material_code);

CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_date
  ON inventory_snapshots(snapshot_date);

-- 添加注释
COMMENT ON TABLE inventory_snapshots IS '库存快照 - 记录特定时间点的库存状态';
COMMENT ON COLUMN inventory_snapshots.material_code IS '物料代码（可以是 Component、Raw Material 或 Finished Goods）';
COMMENT ON COLUMN inventory_snapshots.snapshot_date IS '快照日期（YYYY-MM-DD）';
COMMENT ON COLUMN inventory_snapshots.onhand_qty IS '在库数量（实际库存）';
COMMENT ON COLUMN inventory_snapshots.allocated_qty IS '已分配数量（已承诺但未出货的数量）';
COMMENT ON COLUMN inventory_snapshots.safety_stock IS '安全库存（最低库存水平）';

-- ============================================
-- 表3: fg_financials - 成品财务数据
-- ============================================
-- 用途: 定义成品的财务信息，包含售价、利润、有效期间
-- ============================================

CREATE TABLE IF NOT EXISTS fg_financials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  batch_id UUID, -- 批次 ID（用于追溯导入来源）

  -- 财务核心字段
  material_code TEXT NOT NULL,    -- 成品代码（FG）
  unit_margin NUMERIC(12, 4) NOT NULL CHECK (unit_margin >= 0), -- 单位利润（必填）
  
  -- 可选字段
  plant_id TEXT,                  -- 工厂代码（NULL = 全球通用定价）
  unit_price NUMERIC(12, 4) CHECK (unit_price >= 0), -- 单位售价
  currency TEXT DEFAULT 'USD',    -- 币别
  valid_from DATE,                -- 有效起始日（YYYY-MM-DD）
  valid_to DATE,                  -- 有效结束日（YYYY-MM-DD）
  notes TEXT,                     -- 备注

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 唯一性约束：使用 UNIQUE INDEX 处理 NULL 值
-- 使用 COALESCE 将 NULL 转换为默认值以实现唯一性
CREATE UNIQUE INDEX IF NOT EXISTS idx_fg_financials_unique_key
  ON fg_financials(
    user_id, 
    material_code, 
    COALESCE(plant_id, ''), 
    currency, 
    COALESCE(valid_from, '1900-01-01'::DATE), 
    COALESCE(valid_to, '2999-12-31'::DATE)
  );

-- 创建其他索引
CREATE INDEX IF NOT EXISTS idx_fg_financials_user
  ON fg_financials(user_id);

CREATE INDEX IF NOT EXISTS idx_fg_financials_batch
  ON fg_financials(batch_id);

CREATE INDEX IF NOT EXISTS idx_fg_financials_user_material
  ON fg_financials(user_id, material_code);

CREATE INDEX IF NOT EXISTS idx_fg_financials_plant
  ON fg_financials(plant_id);

CREATE INDEX IF NOT EXISTS idx_fg_financials_currency
  ON fg_financials(currency);

CREATE INDEX IF NOT EXISTS idx_fg_financials_valid_dates
  ON fg_financials(valid_from, valid_to);

-- 添加注释
COMMENT ON TABLE fg_financials IS '成品财务数据 - 定义成品的售价、利润、有效期间';
COMMENT ON COLUMN fg_financials.material_code IS '成品代码（Finished Goods）';
COMMENT ON COLUMN fg_financials.unit_margin IS '单位利润（毛利）';
COMMENT ON COLUMN fg_financials.plant_id IS '工厂代码（NULL = 全球通用定价，适用所有工厂）';
COMMENT ON COLUMN fg_financials.unit_price IS '单位售价';
COMMENT ON COLUMN fg_financials.currency IS '币别（USD, EUR, CNY 等）';
COMMENT ON COLUMN fg_financials.valid_from IS '有效起始日（NULL = 无限制）';
COMMENT ON COLUMN fg_financials.valid_to IS '有效结束日（NULL = 无限制）';

-- ============================================
-- 启用 Row Level Security (RLS)
-- ============================================

-- po_open_lines 表的 RLS
ALTER TABLE po_open_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own po_open_lines"
  ON po_open_lines FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own po_open_lines"
  ON po_open_lines FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own po_open_lines"
  ON po_open_lines FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own po_open_lines"
  ON po_open_lines FOR DELETE
  USING (auth.uid() = user_id);

-- inventory_snapshots 表的 RLS
ALTER TABLE inventory_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own inventory_snapshots"
  ON inventory_snapshots FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own inventory_snapshots"
  ON inventory_snapshots FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own inventory_snapshots"
  ON inventory_snapshots FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own inventory_snapshots"
  ON inventory_snapshots FOR DELETE
  USING (auth.uid() = user_id);

-- fg_financials 表的 RLS
ALTER TABLE fg_financials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own fg_financials"
  ON fg_financials FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own fg_financials"
  ON fg_financials FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own fg_financials"
  ON fg_financials FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own fg_financials"
  ON fg_financials FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 触发器：自动更新 updated_at
-- ============================================

-- 为 po_open_lines 表添加触发器
DROP TRIGGER IF EXISTS update_po_open_lines_updated_at ON po_open_lines;
CREATE TRIGGER update_po_open_lines_updated_at
    BEFORE UPDATE ON po_open_lines
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 为 inventory_snapshots 表添加触发器
DROP TRIGGER IF EXISTS update_inventory_snapshots_updated_at ON inventory_snapshots;
CREATE TRIGGER update_inventory_snapshots_updated_at
    BEFORE UPDATE ON inventory_snapshots
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 为 fg_financials 表添加触发器
DROP TRIGGER IF EXISTS update_fg_financials_updated_at ON fg_financials;
CREATE TRIGGER update_fg_financials_updated_at
    BEFORE UPDATE ON fg_financials
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 完成提示
-- ============================================
DO $$
BEGIN
  RAISE NOTICE '================================================';
  RAISE NOTICE 'Supply, Inventory & Financials 模块数据库架构创建完成！';
  RAISE NOTICE '================================================';
  RAISE NOTICE '';
  RAISE NOTICE '已创建的表:';
  RAISE NOTICE '  1. po_open_lines        - 采购订单未交货明细（Open PO）';
  RAISE NOTICE '  2. inventory_snapshots  - 库存快照（Inventory）';
  RAISE NOTICE '  3. fg_financials        - 成品财务数据（FG Pricing & Margin）';
  RAISE NOTICE '';
  RAISE NOTICE '已配置:';
  RAISE NOTICE '  ✓ Row Level Security (RLS) - 用户数据隔离';
  RAISE NOTICE '  ✓ 索引优化 - 查询性能优化';
  RAISE NOTICE '  ✓ 自动更新时间戳 - updated_at 触发器';
  RAISE NOTICE '  ✓ 数据约束检查 - 数量 >= 0';
  RAISE NOTICE '  ✓ 唯一性约束 - 支持 upsert 操作';
  RAISE NOTICE '';
  RAISE NOTICE '特殊功能:';
  RAISE NOTICE '  • po_open_lines.time_bucket - 支持周别（YYYY-W##）或日期（YYYY-MM-DD）';
  RAISE NOTICE '  • fg_financials.plant_id - NULL 代表全球通用定价';
  RAISE NOTICE '  • 所有表支持 batch_id - 用于追溯数据来源';
  RAISE NOTICE '';
  RAISE NOTICE '下一步:';
  RAISE NOTICE '  1. 在 Supabase SQL Editor 中执行此脚本';
  RAISE NOTICE '  2. 验证表结构:';
  RAISE NOTICE '     SELECT * FROM po_open_lines LIMIT 1;';
  RAISE NOTICE '     SELECT * FROM inventory_snapshots LIMIT 1;';
  RAISE NOTICE '     SELECT * FROM fg_financials LIMIT 1;';
  RAISE NOTICE '  3. 上传对应的模板数据:';
  RAISE NOTICE '     - templates/po_open_lines.xlsx';
  RAISE NOTICE '     - templates/inventory_snapshots.xlsx';
  RAISE NOTICE '     - templates/fg_financials.xlsx';
  RAISE NOTICE '';
  RAISE NOTICE '相关模板文件位置: templates/ 目录';
  RAISE NOTICE '使用说明文档: NEW_TEMPLATES_GUIDE.md';
  RAISE NOTICE '================================================';
END $$;
