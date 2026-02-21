-- ============================================
-- Decision-Intelligence 供应商 KPI 模块 - 数据库架构（含 suppliers）
-- ============================================
-- 创建日期: 2025-12-03
-- 说明: 包含供应商、物料、收货记录、价格历史和 KPI 计算所需的表和视图

-- ============================================
-- 辅助函数：自动更新 updated_at
-- ============================================

-- 创建或替换更新时间戳的函数
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

COMMENT ON FUNCTION update_updated_at_column() IS '触发器函数 - 自动更新 updated_at 字段';

-- ============================================
-- 表0: suppliers - 供应商主档（新增）
-- ============================================
CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 基本信息
  supplier_name TEXT NOT NULL,
  plant_id TEXT,                 -- 可選：工廠/站點維度（NULL 表示跨工廠）
  lead_time_days NUMERIC,        -- 可選：交期天數（MVP 供 Inventory / Risk fallback 使用）
  on_time_rate NUMERIC CHECK (on_time_rate >= 0 AND on_time_rate <= 1),
  contact_info JSONB,           -- 可存联络人、电话、email 等结构化信息
  notes TEXT,

  -- 状态字段
  supplier_code TEXT,           -- 内部编码
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_suppliers_user
  ON suppliers(user_id);

CREATE INDEX IF NOT EXISTS idx_suppliers_code
  ON suppliers(supplier_code);

CREATE INDEX IF NOT EXISTS idx_suppliers_status
  ON suppliers(status);

CREATE INDEX IF NOT EXISTS idx_suppliers_user_status
  ON suppliers(user_id, status);

-- 注释
COMMENT ON TABLE suppliers IS '供应商主档 - 存储供应商基本信息';
COMMENT ON COLUMN suppliers.supplier_name IS '供应商名称';
COMMENT ON COLUMN suppliers.supplier_code IS '供应商代码（内部编码）';
COMMENT ON COLUMN suppliers.status IS '供应商状态: active, inactive';
COMMENT ON COLUMN suppliers.contact_info IS '联络信息（JSON，如电话、email 等）';

-- ============================================
-- 表1: materials - 物料主档
-- ============================================
CREATE TABLE IF NOT EXISTS materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 物料信息
  material_code TEXT NOT NULL,
  material_name TEXT NOT NULL,
  category TEXT,
  uom TEXT DEFAULT 'pcs',  -- 单位 (Unit of Measure)

  -- 备注
  notes TEXT,

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- 确保每个用户的料号唯一
  UNIQUE(user_id, material_code)
);

-- 创建索引以优化查询
CREATE INDEX IF NOT EXISTS idx_materials_user
  ON materials(user_id);

CREATE INDEX IF NOT EXISTS idx_materials_code
  ON materials(material_code);

CREATE INDEX IF NOT EXISTS idx_materials_user_code
  ON materials(user_id, material_code);

-- 添加注释
COMMENT ON TABLE materials IS '物料主档 - 存储物料基本信息';
COMMENT ON COLUMN materials.material_code IS '物料代码（料号）';
COMMENT ON COLUMN materials.material_name IS '物料名称';
COMMENT ON COLUMN materials.category IS '物料类别';
COMMENT ON COLUMN materials.uom IS '单位（pcs, kg, m, etc.）';

-- ============================================
-- 表2: goods_receipts - 收货记录
-- ============================================
CREATE TABLE IF NOT EXISTS goods_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 注意：user_files.id 为 BIGINT，这里需使用 BIGINT
  upload_file_id BIGINT REFERENCES user_files(id) ON DELETE SET NULL,

  -- 关联
  supplier_id UUID REFERENCES suppliers(id) ON DELETE CASCADE,
  material_id UUID REFERENCES materials(id) ON DELETE SET NULL,

  -- 订单信息
  po_number TEXT,
  receipt_number TEXT,

  -- 日期
  planned_delivery_date DATE,
  actual_delivery_date DATE NOT NULL,
  receipt_date DATE DEFAULT CURRENT_DATE,

  -- 数量
  received_qty DECIMAL(10, 2) NOT NULL CHECK (received_qty >= 0),
  rejected_qty DECIMAL(10, 2) DEFAULT 0 CHECK (rejected_qty >= 0),
  accepted_qty DECIMAL(10, 2) GENERATED ALWAYS AS (received_qty - rejected_qty) STORED,

  -- 品质 - 计算列
  defect_rate DECIMAL(5, 2) GENERATED ALWAYS AS (
    CASE
      WHEN received_qty > 0 THEN (rejected_qty / received_qty * 100)
      ELSE 0
    END
  ) STORED,

  -- 准时交货 - 计算列
  is_on_time BOOLEAN GENERATED ALWAYS AS (
    CASE
      WHEN planned_delivery_date IS NULL THEN NULL
      ELSE actual_delivery_date <= planned_delivery_date
    END
  ) STORED,

  delay_days INTEGER GENERATED ALWAYS AS (
    CASE
      WHEN planned_delivery_date IS NULL THEN NULL
      ELSE actual_delivery_date - planned_delivery_date
    END
  ) STORED,

  -- 备注
  notes TEXT,

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_goods_receipts_user
  ON goods_receipts(user_id);

CREATE INDEX IF NOT EXISTS idx_goods_receipts_supplier
  ON goods_receipts(supplier_id);

CREATE INDEX IF NOT EXISTS idx_goods_receipts_material
  ON goods_receipts(material_id);

CREATE INDEX IF NOT EXISTS idx_goods_receipts_date
  ON goods_receipts(actual_delivery_date DESC);

CREATE INDEX IF NOT EXISTS idx_goods_receipts_user_supplier
  ON goods_receipts(user_id, supplier_id);

CREATE INDEX IF NOT EXISTS idx_goods_receipts_upload
  ON goods_receipts(upload_file_id);

-- 添加注释
COMMENT ON TABLE goods_receipts IS '收货记录表 - 存储每次收货的详细信息';
COMMENT ON COLUMN goods_receipts.po_number IS '采购订单号';
COMMENT ON COLUMN goods_receipts.receipt_number IS '收货单号';
COMMENT ON COLUMN goods_receipts.planned_delivery_date IS '预计交期';
COMMENT ON COLUMN goods_receipts.actual_delivery_date IS '实际交期';
COMMENT ON COLUMN goods_receipts.received_qty IS '收货数量';
COMMENT ON COLUMN goods_receipts.rejected_qty IS '不良数量';
COMMENT ON COLUMN goods_receipts.accepted_qty IS '合格数量（计算列）';
COMMENT ON COLUMN goods_receipts.defect_rate IS '不良率（计算列）';
COMMENT ON COLUMN goods_receipts.is_on_time IS '是否准时（计算列）';
COMMENT ON COLUMN goods_receipts.delay_days IS '延迟天数（计算列）';

-- ============================================
-- 表3: price_history - 价格历史
-- ============================================
CREATE TABLE IF NOT EXISTS price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 注意：user_files.id 为 BIGINT，这里需使用 BIGINT
  upload_file_id BIGINT REFERENCES user_files(id) ON DELETE SET NULL,

  -- 关联
  supplier_id UUID REFERENCES suppliers(id) ON DELETE CASCADE,
  material_id UUID REFERENCES materials(id) ON DELETE SET NULL,

  -- 价格信息
  order_date DATE NOT NULL,
  unit_price DECIMAL(12, 4) NOT NULL CHECK (unit_price >= 0),
  currency TEXT DEFAULT 'USD',
  quantity DECIMAL(10, 2) DEFAULT 0,

  -- 合约价格标记
  is_contract_price BOOLEAN DEFAULT false,

  -- 备注
  notes TEXT,

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_price_history_user
  ON price_history(user_id);

CREATE INDEX IF NOT EXISTS idx_price_history_supplier
  ON price_history(supplier_id);

CREATE INDEX IF NOT EXISTS idx_price_history_material
  ON price_history(material_id);

CREATE INDEX IF NOT EXISTS idx_price_history_date
  ON price_history(order_date DESC);

CREATE INDEX IF NOT EXISTS idx_price_history_user_supplier
  ON price_history(user_id, supplier_id);

CREATE INDEX IF NOT EXISTS idx_price_history_upload
  ON price_history(upload_file_id);

-- 添加注释
COMMENT ON TABLE price_history IS '价格历史表 - 存储物料价格变化';
COMMENT ON COLUMN price_history.order_date IS '订单日期';
COMMENT ON COLUMN price_history.unit_price IS '单价';
COMMENT ON COLUMN price_history.currency IS '币别';
COMMENT ON COLUMN price_history.quantity IS '订购数量';
COMMENT ON COLUMN price_history.is_contract_price IS '是否为合约价格';

-- ============================================
-- （安全起见）再补一次 suppliers 字段（若未来你改过表）
-- ============================================
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS supplier_code TEXT,
  ADD COLUMN IF NOT EXISTS plant_id TEXT,
  ADD COLUMN IF NOT EXISTS lead_time_days NUMERIC,
  ADD COLUMN IF NOT EXISTS on_time_rate NUMERIC CHECK (on_time_rate >= 0 AND on_time_rate <= 1),
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ============================================
-- VIEW 1: supplier_defect_stats - 来料不良率统计
-- ============================================
CREATE OR REPLACE VIEW supplier_defect_stats AS
SELECT
  gr.user_id,
  gr.supplier_id,
  s.supplier_name,
  s.supplier_code,

  -- 统计信息
  COUNT(*) as total_receipts,
  SUM(gr.received_qty) as total_received_qty,
  SUM(gr.rejected_qty) as total_rejected_qty,
  SUM(gr.accepted_qty) as total_accepted_qty,

  -- 不良率百分比
  CASE
    WHEN SUM(gr.received_qty) > 0
    THEN ROUND((SUM(gr.rejected_qty) / SUM(gr.received_qty) * 100)::numeric, 2)
    ELSE 0
  END as defect_rate_percent,

  -- 日期范围
  MIN(gr.actual_delivery_date) as first_receipt_date,
  MAX(gr.actual_delivery_date) as last_receipt_date

FROM goods_receipts gr
LEFT JOIN suppliers s ON gr.supplier_id = s.id
GROUP BY gr.user_id, gr.supplier_id, s.supplier_name, s.supplier_code;

COMMENT ON VIEW supplier_defect_stats IS '供应商来料不良率统计 - 基于 goods_receipts';

-- ============================================
-- VIEW 2: supplier_delivery_stats - 准时交货率统计
-- ============================================
CREATE OR REPLACE VIEW supplier_delivery_stats AS
SELECT
  gr.user_id,
  gr.supplier_id,
  s.supplier_name,
  s.supplier_code,

  -- 统计信息
  COUNT(*) as total_shipments,
  COUNT(*) FILTER (WHERE gr.is_on_time = true) as on_time_shipments,
  COUNT(*) FILTER (WHERE gr.is_on_time = false) as late_shipments,

  -- 准时率百分比
  CASE
    WHEN COUNT(*) > 0
    THEN ROUND((COUNT(*) FILTER (WHERE gr.is_on_time = true)::numeric / COUNT(*) * 100), 2)
    ELSE 0
  END as on_time_rate_percent,

  -- 平均延迟天数（仅计算延迟的）
  ROUND(AVG(CASE WHEN gr.delay_days > 0 THEN gr.delay_days ELSE NULL END)::numeric, 1) as avg_delay_days,

  -- 最大延迟天数
  MAX(gr.delay_days) as max_delay_days,

  -- 日期范围
  MIN(gr.actual_delivery_date) as first_delivery_date,
  MAX(gr.actual_delivery_date) as last_delivery_date

FROM goods_receipts gr
LEFT JOIN suppliers s ON gr.supplier_id = s.id
WHERE gr.planned_delivery_date IS NOT NULL  -- 只统计有预计交期的记录
GROUP BY gr.user_id, gr.supplier_id, s.supplier_name, s.supplier_code;

COMMENT ON VIEW supplier_delivery_stats IS '供应商准时交货率统计 - 基于 goods_receipts';

-- ============================================
-- VIEW 3: supplier_price_volatility - 价格波动统计
-- ============================================
CREATE OR REPLACE VIEW supplier_price_volatility AS
SELECT
  ph.user_id,
  ph.supplier_id,
  s.supplier_name,
  s.supplier_code,
  ph.material_id,
  m.material_code,
  m.material_name,

  -- 价格统计
  COUNT(*) as price_records,
  ROUND(AVG(ph.unit_price)::numeric, 4) as avg_price,
  ROUND(MIN(ph.unit_price)::numeric, 4) as min_price,
  ROUND(MAX(ph.unit_price)::numeric, 4) as max_price,

  -- 价格波动度百分比
  CASE
    WHEN AVG(ph.unit_price) > 0
    THEN ROUND(((MAX(ph.unit_price) - MIN(ph.unit_price)) / AVG(ph.unit_price) * 100)::numeric, 2)
    ELSE 0
  END as volatility_percent,

  -- 币别
  ph.currency,

  -- 日期范围
  MIN(ph.order_date) as first_order_date,
  MAX(ph.order_date) as last_order_date

FROM price_history ph
LEFT JOIN suppliers s ON ph.supplier_id = s.id
LEFT JOIN materials m ON ph.material_id = m.id
GROUP BY ph.user_id, ph.supplier_id, s.supplier_name, s.supplier_code,
         ph.material_id, m.material_code, m.material_name, ph.currency;

COMMENT ON VIEW supplier_price_volatility IS '供应商价格波动统计 - 按供应商和物料分组';

-- ============================================
-- VIEW 4: supplier_kpi_summary - 供应商 KPI 汇总
-- ============================================
CREATE OR REPLACE VIEW supplier_kpi_summary AS
SELECT
  s.id as supplier_id,
  s.user_id,
  s.supplier_name,
  s.supplier_code,
  s.contact_info,
  s.status,

  -- 来料不良率指标
  COALESCE(def.defect_rate_percent, 0) as defect_rate,
  COALESCE(def.total_receipts, 0) as total_receipts,
  COALESCE(def.total_received_qty, 0) as total_received_qty,
  COALESCE(def.total_rejected_qty, 0) as total_rejected_qty,

  -- 准时交货率指标
  COALESCE(del.on_time_rate_percent, 0) as on_time_rate,
  COALESCE(del.total_shipments, 0) as total_shipments_with_plan,
  COALESCE(del.on_time_shipments, 0) as on_time_shipments,
  COALESCE(del.late_shipments, 0) as late_shipments,
  COALESCE(del.avg_delay_days, 0) as avg_delay_days,

  -- 价格波动指标（取最大值作为整体风险指标）
  COALESCE(MAX(pv.volatility_percent), 0) as max_price_volatility,
  COUNT(DISTINCT pv.material_id) as materials_count,

  -- 综合评分（加权计算）
  ROUND(
    (
      COALESCE(100 - def.defect_rate_percent, 100) * 0.4 +
      COALESCE(del.on_time_rate_percent, 100) * 0.4 +
      COALESCE(100 - LEAST(MAX(pv.volatility_percent), 100), 100) * 0.2
    )::numeric,
  2) as overall_score,

  -- 风险等级（基于综合评分）
  CASE
    WHEN ROUND(
      (
        COALESCE(100 - def.defect_rate_percent, 100) * 0.4 +
        COALESCE(del.on_time_rate_percent, 100) * 0.4 +
        COALESCE(100 - LEAST(MAX(pv.volatility_percent), 100), 100) * 0.2
      )::numeric, 2) >= 90 THEN 'low'
    WHEN ROUND(
      (
        COALESCE(100 - def.defect_rate_percent, 100) * 0.4 +
        COALESCE(del.on_time_rate_percent, 100) * 0.4 +
        COALESCE(100 - LEAST(MAX(pv.volatility_percent), 100), 100) * 0.2
      )::numeric, 2) >= 70 THEN 'medium'
    ELSE 'high'
  END as risk_level

FROM suppliers s
LEFT JOIN supplier_defect_stats def
  ON s.id = def.supplier_id AND s.user_id = def.user_id
LEFT JOIN supplier_delivery_stats del
  ON s.id = del.supplier_id AND s.user_id = del.user_id
LEFT JOIN supplier_price_volatility pv
  ON s.id = pv.supplier_id AND s.user_id = pv.user_id
GROUP BY
  s.id, s.user_id, s.supplier_name, s.supplier_code, s.contact_info, s.status,
  def.defect_rate_percent, def.total_receipts, def.total_received_qty, def.total_rejected_qty,
  del.on_time_rate_percent, del.total_shipments, del.on_time_shipments,
  del.late_shipments, del.avg_delay_days;

COMMENT ON VIEW supplier_kpi_summary IS '供应商 KPI 汇总视图 - 整合所有关键指标';

-- ============================================
-- 启用 Row Level Security (RLS)
-- ============================================

-- materials 表的 RLS
ALTER TABLE materials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own materials"
  ON materials FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own materials"
  ON materials FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own materials"
  ON materials FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own materials"
  ON materials FOR DELETE
  USING (auth.uid() = user_id);

-- goods_receipts 表的 RLS
ALTER TABLE goods_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own receipts"
  ON goods_receipts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own receipts"
  ON goods_receipts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own receipts"
  ON goods_receipts FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own receipts"
  ON goods_receipts FOR DELETE
  USING (auth.uid() = user_id);

-- price_history 表的 RLS
ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own price history"
  ON price_history FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own price history"
  ON price_history FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own price history"
  ON price_history FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own price history"
  ON price_history FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 触发器：自动更新 updated_at
-- ============================================

-- 为 materials 表添加触发器
DROP TRIGGER IF EXISTS update_materials_updated_at ON materials;
CREATE TRIGGER update_materials_updated_at
    BEFORE UPDATE ON materials
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 为 goods_receipts 表添加触发器
DROP TRIGGER IF EXISTS update_goods_receipts_updated_at ON goods_receipts;
CREATE TRIGGER update_goods_receipts_updated_at
    BEFORE UPDATE ON goods_receipts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 为 price_history 表添加触发器
DROP TRIGGER IF EXISTS update_price_history_updated_at ON price_history;
CREATE TRIGGER update_price_history_updated_at
    BEFORE UPDATE ON price_history
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 为 suppliers 表添加触发器
DROP TRIGGER IF EXISTS update_suppliers_updated_at ON suppliers;
CREATE TRIGGER update_suppliers_updated_at
    BEFORE UPDATE ON suppliers
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 完成提示
-- ============================================
DO $$
BEGIN
  RAISE NOTICE '================================================';
  RAISE NOTICE '供应商 KPI 模块数据库架构创建完成！';
  RAISE NOTICE '================================================';
  RAISE NOTICE '';
  RAISE NOTICE '已创建的表:';
  RAISE NOTICE '  0. suppliers          - 供应商主档';
  RAISE NOTICE '  1. materials          - 物料主档';
  RAISE NOTICE '  2. goods_receipts     - 收货记录（KPI 核心）';
  RAISE NOTICE '  3. price_history      - 价格历史';
  RAISE NOTICE '';
  RAISE NOTICE '已创建的 Views:';
  RAISE NOTICE '  1. supplier_defect_stats      - 来料不良率统计';
  RAISE NOTICE '  2. supplier_delivery_stats    - 准时交货率统计';
  RAISE NOTICE '  3. supplier_price_volatility  - 价格波动统计';
  RAISE NOTICE '  4. supplier_kpi_summary       - KPI 汇总视图';
  RAISE NOTICE '';
  RAISE NOTICE '已配置:';
  RAISE NOTICE '  ✓ Row Level Security (RLS)';
  RAISE NOTICE '  ✓ 索引优化';
  RAISE NOTICE '  ✓ 自动更新时间戳';
  RAISE NOTICE '  ✓ 数据约束检查';
  RAISE NOTICE '  ✓ 计算列（不良率、准时率等）';
  RAISE NOTICE '';
  RAISE NOTICE '下一步:';
  RAISE NOTICE '  1. 在 Supabase SQL Editor 中执行此脚本';
  RAISE NOTICE '  2. 验证视图: SELECT * FROM supplier_kpi_summary LIMIT 1;';
  RAISE NOTICE '================================================';
END $$;
