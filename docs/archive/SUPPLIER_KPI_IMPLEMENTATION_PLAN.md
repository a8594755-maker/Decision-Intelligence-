# Decision-Intelligence 供应商管理模块优化 - 实施计划

**创建时间**: 2025-12-03
**目标**: 实现脏数据上传、字段映射、数据清洗和供应商KPI计算功能

---

## 📋 目录

1. [现有架构分析](#现有架构分析)
2. [需求总结](#需求总结)
3. [数据库设计](#数据库设计)
4. [实施方案](#实施方案)
5. [技术决策](#技术决策)
6. [分阶段实施计划](#分阶段实施计划)

---

## 🏗️ 现有架构分析

### 已有数据表

| 表名 | 用途 | 状态 |
|-----|------|------|
| `user_files` | 存储原始上传文件数据（JSON） | ✅ 已存在 |
| `suppliers` | 供应商主档（基本信息） | ✅ 已存在 |
| `conversations` | AI对话历史 | ✅ 已存在 |
| `operational_costs` | 营运成本记录 | ✅ 已存在 |
| `cost_anomalies` | 成本异常记录 | ✅ 已存在 |

### 现有服务层

| 服务文件 | 功能 |
|---------|------|
| `supabaseClient.js` | Supabase CRUD + Auth |
| `geminiAPI.js` | AI分析和对话 |
| `costAnalysisService.js` | 成本分析业务逻辑 |

### 现有工具函数

| 文件 | 功能 |
|-----|------|
| `dataProcessing.js` | 数据处理（包含`extractSuppliers`） |

### 现有上传流程（ExternalSystemsView）

```
1. 用户选择 Excel/CSV 文件
2. 使用 XLSX 库读取 → rows (Array of Objects)
3. AI 分析数据质量和内容（可选）
4. extractSuppliers() 提取供应商信息
5. 保存到 user_files + suppliers 表
```

**问题点**：
- ❌ 无法处理不规范的列名（如"供應商", "vendor", "廠商"）
- ❌ 没有字段映射机制
- ❌ 缺少数据验证和清洗步骤
- ❌ 无法支持多种上传类型（goods_receipt, price_history）

---

## 🎯 需求总结

### 核心功能需求

#### 1. 多类型数据上传
- 用户可选择上传类型：
  - `supplier_master` - 供应商主档
  - `goods_receipt` - 收货记录
  - `price_history` - 价格历史
  - 未来扩展：`quality_incident` - 品质事件

#### 2. 字段映射 (Field Mapping)
- 用户手动将 Excel 列名映射到系统字段
- AI 辅助建议映射关系
- 支持保存映射模板（未来）

#### 3. 数据清洗与验证
- 日期格式转换（支持多种格式）
- 数字格式化（去除逗号、货币符号）
- 必填字段检查
- 错误行标记和报告

#### 4. 供应商 KPI 计算

| KPI 指标 | 计算公式 | 数据来源 |
|---------|---------|---------|
| 来料不良率 | `sum(rejected_qty) / sum(received_qty)` | goods_receipts |
| 准时交货率 | `on_time_count / total_shipments` | goods_receipts |
| 价格波动度 | `(max_price - min_price) / avg_price * 100` | price_history |

#### 5. KPI 展示位置
- ✅ SupplierManagementView（供应商列表）
- ✅ OperationsDashboardView（仪表板）
- ✅ SmartAlertsView（基于 KPI 阈值生成告警）

---

## 💾 数据库设计

### 新增表结构

#### 1. `materials` - 物料主档

```sql
CREATE TABLE IF NOT EXISTS materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  material_code TEXT NOT NULL,
  material_name TEXT NOT NULL,
  category TEXT,
  uom TEXT DEFAULT 'pcs',  -- 单位

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, material_code)
);

CREATE INDEX idx_materials_user ON materials(user_id);
CREATE INDEX idx_materials_code ON materials(material_code);
```

#### 2. `goods_receipts` - 收货记录

```sql
CREATE TABLE IF NOT EXISTS goods_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  upload_file_id UUID REFERENCES user_files(id) ON DELETE SET NULL,

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

  -- 品质
  defect_rate DECIMAL(5, 2) GENERATED ALWAYS AS (
    CASE
      WHEN received_qty > 0 THEN (rejected_qty / received_qty * 100)
      ELSE 0
    END
  ) STORED,

  -- 准时交货
  is_on_time BOOLEAN GENERATED ALWAYS AS (
    actual_delivery_date <= planned_delivery_date
  ) STORED,
  delay_days INTEGER GENERATED ALWAYS AS (
    actual_delivery_date - planned_delivery_date
  ) STORED,

  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_goods_receipts_user ON goods_receipts(user_id);
CREATE INDEX idx_goods_receipts_supplier ON goods_receipts(supplier_id);
CREATE INDEX idx_goods_receipts_material ON goods_receipts(material_id);
CREATE INDEX idx_goods_receipts_date ON goods_receipts(actual_delivery_date DESC);
```

#### 3. `price_history` - 价格历史

```sql
CREATE TABLE IF NOT EXISTS price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  upload_file_id UUID REFERENCES user_files(id) ON DELETE SET NULL,

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

  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_price_history_user ON price_history(user_id);
CREATE INDEX idx_price_history_supplier ON price_history(supplier_id);
CREATE INDEX idx_price_history_material ON price_history(material_id);
CREATE INDEX idx_price_history_date ON price_history(order_date DESC);
```

#### 4. `column_mappings` - 字段映射模板（可选，第二阶段）

```sql
CREATE TABLE IF NOT EXISTS column_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  file_type TEXT NOT NULL CHECK (file_type IN (
    'supplier_master', 'goods_receipt', 'price_history', 'quality_incident'
  )),

  template_name TEXT NOT NULL,
  source_pattern TEXT,  -- 文件名关键字或来源系统
  mapping_json JSONB NOT NULL,  -- {"原始列名": "系统字段名"}

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, file_type, template_name)
);

CREATE INDEX idx_column_mappings_user ON column_mappings(user_id);
CREATE INDEX idx_column_mappings_type ON column_mappings(file_type);
```

#### 5. 修改 `suppliers` 表（添加新字段）

```sql
-- 添加供应商代码和状态字段
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS supplier_code TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 添加索引
CREATE INDEX IF NOT EXISTS idx_suppliers_code ON suppliers(supplier_code);
CREATE INDEX IF NOT EXISTS idx_suppliers_status ON suppliers(status);
```

### KPI 计算 Views

#### View 1: `supplier_defect_stats` - 来料不良率

```sql
CREATE OR REPLACE VIEW supplier_defect_stats AS
SELECT
  gr.user_id,
  gr.supplier_id,
  s.supplier_name,
  COUNT(*) as total_receipts,
  SUM(gr.received_qty) as total_received_qty,
  SUM(gr.rejected_qty) as total_rejected_qty,
  SUM(gr.accepted_qty) as total_accepted_qty,
  CASE
    WHEN SUM(gr.received_qty) > 0
    THEN ROUND((SUM(gr.rejected_qty) / SUM(gr.received_qty) * 100)::numeric, 2)
    ELSE 0
  END as defect_rate_percent,
  MIN(gr.actual_delivery_date) as first_receipt_date,
  MAX(gr.actual_delivery_date) as last_receipt_date
FROM goods_receipts gr
LEFT JOIN suppliers s ON gr.supplier_id = s.id
GROUP BY gr.user_id, gr.supplier_id, s.supplier_name;
```

#### View 2: `supplier_delivery_stats` - 准时交货率

```sql
CREATE OR REPLACE VIEW supplier_delivery_stats AS
SELECT
  gr.user_id,
  gr.supplier_id,
  s.supplier_name,
  COUNT(*) as total_shipments,
  COUNT(*) FILTER (WHERE gr.is_on_time = true) as on_time_shipments,
  COUNT(*) FILTER (WHERE gr.is_on_time = false) as late_shipments,
  CASE
    WHEN COUNT(*) > 0
    THEN ROUND((COUNT(*) FILTER (WHERE gr.is_on_time = true)::numeric / COUNT(*) * 100), 2)
    ELSE 0
  END as on_time_rate_percent,
  ROUND(AVG(CASE WHEN gr.delay_days > 0 THEN gr.delay_days ELSE NULL END)::numeric, 1) as avg_delay_days
FROM goods_receipts gr
LEFT JOIN suppliers s ON gr.supplier_id = s.id
WHERE gr.planned_delivery_date IS NOT NULL
GROUP BY gr.user_id, gr.supplier_id, s.supplier_name;
```

#### View 3: `supplier_price_volatility` - 价格波动度

```sql
CREATE OR REPLACE VIEW supplier_price_volatility AS
SELECT
  ph.user_id,
  ph.supplier_id,
  s.supplier_name,
  ph.material_id,
  m.material_name,
  COUNT(*) as price_records,
  ROUND(AVG(ph.unit_price)::numeric, 4) as avg_price,
  ROUND(MIN(ph.unit_price)::numeric, 4) as min_price,
  ROUND(MAX(ph.unit_price)::numeric, 4) as max_price,
  CASE
    WHEN AVG(ph.unit_price) > 0
    THEN ROUND(((MAX(ph.unit_price) - MIN(ph.unit_price)) / AVG(ph.unit_price) * 100)::numeric, 2)
    ELSE 0
  END as volatility_percent,
  MIN(ph.order_date) as first_order_date,
  MAX(ph.order_date) as last_order_date
FROM price_history ph
LEFT JOIN suppliers s ON ph.supplier_id = s.id
LEFT JOIN materials m ON ph.material_id = m.id
GROUP BY ph.user_id, ph.supplier_id, s.supplier_name, ph.material_id, m.material_name;
```

#### View 4: `supplier_kpi_summary` - 供应商KPI汇总

```sql
CREATE OR REPLACE VIEW supplier_kpi_summary AS
SELECT
  s.id as supplier_id,
  s.user_id,
  s.supplier_name,
  s.supplier_code,
  s.status,

  -- 不良率指标
  COALESCE(def.defect_rate_percent, 0) as defect_rate,
  COALESCE(def.total_receipts, 0) as total_receipts,

  -- 准时率指标
  COALESCE(del.on_time_rate_percent, 0) as on_time_rate,
  COALESCE(del.avg_delay_days, 0) as avg_delay_days,

  -- 价格波动（取最大值作为整体指标）
  COALESCE(MAX(pv.volatility_percent), 0) as max_price_volatility,

  -- 综合评分（简单加权）
  ROUND(
    (
      COALESCE(100 - def.defect_rate_percent, 100) * 0.4 +
      COALESCE(del.on_time_rate_percent, 100) * 0.4 +
      COALESCE(100 - LEAST(MAX(pv.volatility_percent), 100), 100) * 0.2
    )::numeric,
  2) as overall_score

FROM suppliers s
LEFT JOIN supplier_defect_stats def ON s.id = def.supplier_id AND s.user_id = def.user_id
LEFT JOIN supplier_delivery_stats del ON s.id = del.supplier_id AND s.user_id = del.user_id
LEFT JOIN supplier_price_volatility pv ON s.id = pv.supplier_id AND s.user_id = pv.user_id
GROUP BY
  s.id, s.user_id, s.supplier_name, s.supplier_code, s.status,
  def.defect_rate_percent, def.total_receipts,
  del.on_time_rate_percent, del.avg_delay_days;
```

---

## 🛠️ 实施方案

### Phase 1: 数据库层（MVP）

**文件**: `database/supplier_kpi_schema.sql`

```sql
-- 1. 创建 materials 表
-- 2. 创建 goods_receipts 表
-- 3. 创建 price_history 表
-- 4. 修改 suppliers 表
-- 5. 创建 KPI Views
-- 6. 创建索引
-- 7. 启用 RLS
-- 8. 创建触发器（自动更新 updated_at）
```

**执行步骤**：
1. 在 Supabase SQL Editor 运行脚本
2. 验证表和视图已创建
3. 测试 RLS 策略

---

### Phase 2: 后端服务层

#### 2.1 扩展 `supabaseClient.js`

添加新表的 CRUD 操作：

```javascript
// --- Materials Operations ---
export const materialsService = {
  async findOrCreate(userId, materialData) {
    // 查找或创建物料
  },

  async getAllMaterials(userId) {
    // 获取所有物料
  }
};

// --- Goods Receipts Operations ---
export const goodsReceiptsService = {
  async insertReceipts(receipts) {
    // 批量插入收货记录
  },

  async getReceipts(userId, filters) {
    // 获取收货记录
  }
};

// --- Price History Operations ---
export const priceHistoryService = {
  async insertPrices(prices) {
    // 批量插入价格记录
  },

  async getPriceHistory(userId, supplierId, materialId) {
    // 获取价格历史
  }
};
```

#### 2.2 创建 `supplierKpiService.js`

```javascript
/**
 * Supplier KPI Service
 * 供应商 KPI 计算与查询
 */

import { supabase } from './supabaseClient';

/**
 * 获取供应商 KPI 汇总
 */
export const getSupplierKpiSummary = async (userId, supplierId = null) => {
  let query = supabase
    .from('supplier_kpi_summary')
    .select('*')
    .eq('user_id', userId);

  if (supplierId) {
    query = query.eq('supplier_id', supplierId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
};

/**
 * 获取来料不良率详情
 */
export const getDefectStats = async (userId, supplierId, days = 90) => {
  const { data, error } = await supabase
    .from('goods_receipts')
    .select('*')
    .eq('user_id', userId)
    .eq('supplier_id', supplierId)
    .gte('actual_delivery_date', getDateNDaysAgo(days))
    .order('actual_delivery_date', { ascending: false });

  if (error) throw error;
  return data;
};

/**
 * 获取价格波动详情
 */
export const getPriceVolatility = async (userId, supplierId, materialId = null) => {
  let query = supabase
    .from('supplier_price_volatility')
    .select('*')
    .eq('user_id', userId)
    .eq('supplier_id', supplierId);

  if (materialId) {
    query = query.eq('material_id', materialId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
};

// ... 更多 KPI 相关函数
```

---

### Phase 3: 数据清洗工具

#### 创建 `src/utils/dataCleaningUtils.js`

```javascript
/**
 * Data Cleaning & Validation Utilities
 */

/**
 * 解析日期（支持多种格式）
 */
export const parseDate = (dateString) => {
  if (!dateString) return null;

  const formats = [
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/,     // YYYY-MM-DD or YYYY/MM/DD
    /^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/,     // MM-DD-YYYY or DD-MM-YYYY
    /^\d{1,2}[-/]\d{1,2}[-/]\d{2}$/      // MM-DD-YY
  ];

  try {
    const date = new Date(dateString);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  } catch (e) {
    return null;
  }

  return null;
};

/**
 * 解析数字（去除逗号、货币符号）
 */
export const parseNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;

  // 去除逗号、货币符号、空格
  const cleaned = String(value)
    .replace(/[$€¥,\s]/g, '')
    .replace(/[^\d.-]/g, '');

  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
};

/**
 * 验证并清洗一行数据
 */
export const validateAndCleanRow = (row, fieldMappings, uploadType) => {
  const cleaned = {};
  const errors = [];

  // 根据上传类型定义必填字段
  const requiredFields = getRequiredFields(uploadType);

  // 遍历映射的字段
  Object.entries(fieldMappings).forEach(([originalCol, systemField]) => {
    if (!systemField) return;  // 未映射的列跳过

    const rawValue = row[originalCol];
    const fieldType = getFieldType(systemField, uploadType);

    // 清洗数据
    let cleanedValue;
    switch (fieldType) {
      case 'date':
        cleanedValue = parseDate(rawValue);
        break;
      case 'number':
        cleanedValue = parseNumber(rawValue);
        break;
      case 'text':
      default:
        cleanedValue = rawValue ? String(rawValue).trim() : null;
    }

    // 验证必填字段
    if (requiredFields.includes(systemField) && !cleanedValue) {
      errors.push(`Missing required field: ${systemField}`);
    }

    cleaned[systemField] = cleanedValue;
  });

  return { cleaned, errors };
};

/**
 * 获取必填字段列表
 */
const getRequiredFields = (uploadType) => {
  const required = {
    'supplier_master': ['supplier_name'],
    'goods_receipt': ['supplier_name', 'actual_delivery_date', 'received_qty'],
    'price_history': ['supplier_name', 'order_date', 'unit_price']
  };

  return required[uploadType] || [];
};

/**
 * 获取字段类型
 */
const getFieldType = (fieldName, uploadType) => {
  const dateFields = ['order_date', 'planned_delivery_date', 'actual_delivery_date', 'receipt_date'];
  const numberFields = ['unit_price', 'received_qty', 'rejected_qty', 'quantity'];

  if (dateFields.includes(fieldName)) return 'date';
  if (numberFields.includes(fieldName)) return 'number';
  return 'text';
};

export default {
  parseDate,
  parseNumber,
  validateAndCleanRow,
  getRequiredFields
};
```

---

### Phase 4: 前端 - 字段映射 UI

#### 4.1 修改 `ExternalSystemsView.jsx`

添加上传类型选择器：

```jsx
// 在文件顶部添加 state
const [uploadType, setUploadType] = useState('supplier_master');

// 在上传按钮前添加类型选择
<div className="mb-4">
  <label className="block text-sm font-medium mb-2">上传类型</label>
  <select
    value={uploadType}
    onChange={(e) => setUploadType(e.target.value)}
    className="w-full px-4 py-2 rounded-lg border"
  >
    <option value="supplier_master">供应商主档</option>
    <option value="goods_receipt">收货记录</option>
    <option value="price_history">价格历史</option>
  </select>
</div>
```

#### 4.2 创建字段映射组件

```jsx
/**
 * Field Mapping Component
 * 字段映射界面
 */
const FieldMappingStep = ({
  uploadType,
  originalColumns,
  onMappingChange,
  aiSuggestedMapping
}) => {
  const [mappings, setMappings] = useState(aiSuggestedMapping || {});

  // 根据上传类型获取可选的系统字段
  const systemFields = getSystemFields(uploadType);
  const requiredFields = getRequiredFields(uploadType);

  const handleMappingChange = (originalCol, systemField) => {
    const newMappings = { ...mappings, [originalCol]: systemField };
    setMappings(newMappings);
    onMappingChange(newMappings);
  };

  return (
    <Card>
      <h3 className="font-semibold mb-4">字段映射</h3>
      <div className="space-y-3">
        {originalColumns.map((col) => (
          <div key={col} className="grid grid-cols-2 gap-4 items-center">
            {/* 原始列名 */}
            <div className="font-medium text-sm">
              {col}
            </div>

            {/* 系统字段下拉选择 */}
            <select
              value={mappings[col] || ''}
              onChange={(e) => handleMappingChange(col, e.target.value)}
              className="px-3 py-2 rounded border text-sm"
            >
              <option value="">-- 不导入 --</option>
              {systemFields.map((field) => (
                <option key={field.value} value={field.value}>
                  {field.label}
                  {requiredFields.includes(field.value) && ' *'}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      {/* 必填字段提示 */}
      <div className="mt-4 p-3 bg-blue-50 rounded text-sm text-blue-700">
        <strong>必填字段：</strong>
        {requiredFields.map((f) => systemFields.find(s => s.value === f)?.label).join(', ')}
      </div>
    </Card>
  );
};

/**
 * 获取系统字段选项
 */
const getSystemFields = (uploadType) => {
  const fieldOptions = {
    'supplier_master': [
      { value: 'supplier_name', label: '供应商名称' },
      { value: 'supplier_code', label: '供应商代码' },
      { value: 'contact_info', label: '联络方式' },
      { value: 'address', label: '地址' },
      { value: 'product_category', label: '产品类别' },
      { value: 'payment_terms', label: '付款条件' },
      { value: 'delivery_time', label: '交货时间' }
    ],
    'goods_receipt': [
      { value: 'supplier_name', label: '供应商名称' },
      { value: 'material_code', label: '料号' },
      { value: 'material_name', label: '料名' },
      { value: 'po_number', label: 'PO单号' },
      { value: 'receipt_number', label: '收货单号' },
      { value: 'planned_delivery_date', label: '预计交期' },
      { value: 'actual_delivery_date', label: '实际交期' },
      { value: 'received_qty', label: '收货数量' },
      { value: 'rejected_qty', label: '不良数量' },
      { value: 'notes', label: '备注' }
    ],
    'price_history': [
      { value: 'supplier_name', label: '供应商名称' },
      { value: 'material_code', label: '料号' },
      { value: 'material_name', label: '料名' },
      { value: 'order_date', label: '订单日期' },
      { value: 'unit_price', label: '单价' },
      { value: 'currency', label: '币别' },
      { value: 'quantity', label: '数量' },
      { value: 'is_contract_price', label: '是否合约价' },
      { value: 'notes', label: '备注' }
    ]
  };

  return fieldOptions[uploadType] || [];
};
```

#### 4.3 数据验证与预览组件

```jsx
/**
 * Data Validation & Preview Component
 */
const DataValidationStep = ({
  stagedRows,
  fieldMappings,
  uploadType,
  onAccept,
  onReject
}) => {
  const [validationResults, setValidationResults] = useState(null);
  const [processing, setProcessing] = useState(true);

  useEffect(() => {
    validateData();
  }, [stagedRows, fieldMappings]);

  const validateData = () => {
    setProcessing(true);

    const results = {
      valid: [],
      invalid: [],
      errors: []
    };

    stagedRows.forEach((row, index) => {
      const { cleaned, errors } = validateAndCleanRow(row, fieldMappings, uploadType);

      if (errors.length === 0) {
        results.valid.push({ index, original: row, cleaned });
      } else {
        results.invalid.push({ index, original: row, errors });
      }
    });

    setValidationResults(results);
    setProcessing(false);
  };

  return (
    <Card>
      <h3 className="font-semibold mb-4">数据验证结果</h3>

      {processing ? (
        <div className="text-center py-8">
          <Loader2 className="w-8 h-8 animate-spin mx-auto text-blue-600" />
          <p className="mt-2 text-sm text-slate-500">验证中...</p>
        </div>
      ) : (
        <>
          {/* 概要统计 */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <Card className="bg-green-50">
              <div className="text-center">
                <div className="text-2xl font-bold text-green-600">
                  {validationResults.valid.length}
                </div>
                <div className="text-sm text-slate-500">有效行</div>
              </div>
            </Card>
            <Card className="bg-red-50">
              <div className="text-center">
                <div className="text-2xl font-bold text-red-600">
                  {validationResults.invalid.length}
                </div>
                <div className="text-sm text-slate-500">错误行</div>
              </div>
            </Card>
            <Card className="bg-blue-50">
              <div className="text-center">
                <div className="text-2xl font-bold text-blue-600">
                  {stagedRows.length}
                </div>
                <div className="text-sm text-slate-500">总行数</div>
              </div>
            </Card>
          </div>

          {/* 错误列表 */}
          {validationResults.invalid.length > 0 && (
            <div className="mb-6">
              <h4 className="font-semibold text-red-600 mb-2">错误详情</h4>
              <div className="max-h-60 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100">
                    <tr>
                      <th className="px-3 py-2 text-left">行号</th>
                      <th className="px-3 py-2 text-left">错误信息</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validationResults.invalid.map((item) => (
                      <tr key={item.index} className="border-b">
                        <td className="px-3 py-2">{item.index + 1}</td>
                        <td className="px-3 py-2 text-red-600 text-xs">
                          {item.errors.join('; ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 预览前5笔有效数据 */}
          {validationResults.valid.length > 0 && (
            <div>
              <h4 className="font-semibold text-green-600 mb-2">
                数据预览（前5笔）
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-green-50">
                    <tr>
                      {Object.keys(validationResults.valid[0].cleaned).map((key) => (
                        <th key={key} className="px-3 py-2 text-left text-xs">
                          {key}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {validationResults.valid.slice(0, 5).map((item, idx) => (
                      <tr key={idx} className="border-b">
                        {Object.values(item.cleaned).map((val, i) => (
                          <td key={i} className="px-3 py-2 text-xs">
                            {val || '-'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex gap-3 justify-end mt-6">
            <Button variant="secondary" onClick={onReject}>
              取消
            </Button>
            <Button
              variant="success"
              onClick={() => onAccept(validationResults.valid)}
              disabled={validationResults.valid.length === 0}
            >
              导入 {validationResults.valid.length} 笔数据
            </Button>
          </div>
        </>
      )}
    </Card>
  );
};
```

---

### Phase 5: 前端 - SupplierManagementView 显示 KPI

#### 修改 SupplierManagementView.jsx

```jsx
// 在组件内添加 KPI state
const [supplierKpis, setSupplierKpis] = useState({});
const [loadingKpis, setLoadingKpis] = useState(false);

// 加载 KPI 数据
const loadSupplierKpis = async () => {
  setLoadingKpis(true);
  try {
    const kpis = await getSupplierKpiSummary(user.id);

    // 转换为 { supplierId: kpiData } 的形式
    const kpiMap = {};
    kpis.forEach((kpi) => {
      kpiMap[kpi.supplier_id] = kpi;
    });

    setSupplierKpis(kpiMap);
  } catch (error) {
    console.error('Load KPIs failed:', error);
  } finally {
    setLoadingKpis(false);
  }
};

// 在表格中显示 KPI
<table className="w-full text-sm">
  <thead>
    <tr>
      <th>供应商名称</th>
      <th>来料不良率</th>
      <th>准时交货率</th>
      <th>价格波动度</th>
      <th>综合评分</th>
      <th>操作</th>
    </tr>
  </thead>
  <tbody>
    {suppliers.map((supplier) => {
      const kpi = supplierKpis[supplier.id] || {};

      return (
        <tr key={supplier.id}>
          <td>{supplier.supplier_name}</td>
          <td>
            <Badge type={kpi.defect_rate > 5 ? 'danger' : 'success'}>
              {kpi.defect_rate?.toFixed(2) || '0.00'}%
            </Badge>
          </td>
          <td>
            <Badge type={kpi.on_time_rate < 90 ? 'warning' : 'success'}>
              {kpi.on_time_rate?.toFixed(2) || '0.00'}%
            </Badge>
          </td>
          <td>
            {kpi.max_price_volatility?.toFixed(2) || '0.00'}%
          </td>
          <td>
            <div className="font-bold text-lg">
              {kpi.overall_score?.toFixed(1) || 'N/A'}
            </div>
          </td>
          <td>...</td>
        </tr>
      );
    })}
  </tbody>
</table>
```

---

## 🎯 技术决策

### 决策 1: 字段映射存储方式

**选项 A**: 仅前端 state（会话级别）
**选项 B**: 存储到 `column_mappings` 表（持久化模板）

**推荐**: 第一版使用选项 A，第二版实现选项 B

**理由**:
- 快速实现 MVP
- 用户可以快速测试上传流程
- 后续可以无缝升级到模板功能

---

### 决策 2: 数据清洗位置

**选项 A**: 前端清洗
**选项 B**: 后端 Edge Function 清洗
**选项 C**: 混合方式（前端初步+后端最终）

**推荐**: 选项 A（前端清洗）

**理由**:
- 即时反馈，用户体验更好
- 减少服务器负载
- 更容易调试和维护

---

### 决策 3: KPI 计算方式

**选项 A**: Postgres VIEW
**选项 B**: Supabase Edge Function
**选项 C**: 前端实时计算

**推荐**: 选项 A（Postgres VIEW）

**理由**:
- 性能最优
- 易于维护和优化
- 支持复杂的 SQL 聚合查询
- 可以利用数据库索引

---

### 决策 4: 供应商去重策略

**选项 A**: 简单名称匹配（normalized_name）
**选项 B**: Fuzzy Matching（Levenshtein 距离）
**选项 C**: 手动确认

**推荐**: 第一版使用选项 A，必要时升级到选项 C

**理由**:
- 简单有效
- 性能好
- 用户可以在 SupplierManagementView 中手动合并

---

## 📅 分阶段实施计划

### Phase 1: 数据库架构（1-2天）

**目标**: 创建所有必要的数据表和 Views

**任务清单**:
- [ ] 创建 `database/supplier_kpi_schema.sql`
- [ ] 创建 `materials` 表
- [ ] 创建 `goods_receipts` 表
- [ ] 创建 `price_history` 表
- [ ] 修改 `suppliers` 表（添加 code 和 status）
- [ ] 创建 4 个 KPI Views
- [ ] 创建索引
- [ ] 配置 RLS 策略
- [ ] 在 Supabase 执行脚本
- [ ] 验证表结构

**交付物**:
- ✅ SQL 脚本文件
- ✅ 数据库文档

---

### Phase 2: 后端服务层（2-3天）

**目标**: 实现数据访问和 KPI 计算逻辑

**任务清单**:
- [ ] 扩展 `supabaseClient.js`
  - [ ] materialsService
  - [ ] goodsReceiptsService
  - [ ] priceHistoryService
- [ ] 创建 `supplierKpiService.js`
  - [ ] getSupplierKpiSummary
  - [ ] getDefectStats
  - [ ] getDeliveryStats
  - [ ] getPriceVolatility
- [ ] 创建 `dataCleaningUtils.js`
  - [ ] parseDate
  - [ ] parseNumber
  - [ ] validateAndCleanRow
- [ ] 单元测试（可选）

**交付物**:
- ✅ `src/services/supplierKpiService.js`
- ✅ `src/utils/dataCleaningUtils.js`
- ✅ 扩展的 `supabaseClient.js`

---

### Phase 3: 上传流程改造（3-4天）

**目标**: 实现多类型上传、字段映射和数据验证

**任务清单**:
- [ ] 修改 `ExternalSystemsView.jsx`
  - [ ] 添加上传类型选择器
  - [ ] 实现字段映射 UI（FieldMappingStep）
  - [ ] 实现数据验证 UI（DataValidationStep）
  - [ ] 更新保存逻辑（根据类型调用不同 service）
- [ ] AI 字段映射建议（可选）
  - [ ] 调用 Gemini API 推荐映射
- [ ] 错误处理和用户反馈

**交付物**:
- ✅ 多步骤上传向导
- ✅ 字段映射界面
- ✅ 数据验证和预览

---

### Phase 4: SupplierManagementView KPI 展示（2天）

**目标**: 在供应商列表显示 KPI

**任务清单**:
- [ ] 加载 KPI 数据
- [ ] 在表格中显示 KPI 列
- [ ] 添加 KPI 筛选和排序
- [ ] 详细 KPI 面板（点击供应商查看详情）
- [ ] 响应式设计优化

**交付物**:
- ✅ 带 KPI 的供应商列表
- ✅ KPI 详情面板

---

### Phase 5: Dashboard 和 Alerts 集成（2-3天）

**目标**: 在 Dashboard 显示 KPI 趋势，在 Alerts 根据阈值生成告警

**任务清单**:
- [ ] 修改 `OperationsDashboardView.jsx`
  - [ ] 添加供应商 KPI 卡片
  - [ ] 添加 KPI 趋势图表
- [ ] 修改 `SmartAlertsView.jsx`
  - [ ] 基于 KPI 阈值生成告警
  - [ ] 支持 KPI 告警筛选
- [ ] 创建 KPI 告警规则（可配置）

**交付物**:
- ✅ Dashboard KPI 模块
- ✅ 基于 KPI 的智能告警

---

### Phase 6: 测试与优化（2天）

**目标**: 全面测试和性能优化

**任务清单**:
- [ ] 功能测试
  - [ ] 上传各类型数据
  - [ ] 字段映射和验证
  - [ ] KPI 计算准确性
  - [ ] 多用户隔离（RLS）
- [ ] 性能测试
  - [ ] 大数据量上传（10,000+ 行）
  - [ ] KPI 查询性能
  - [ ] 数据库索引优化
- [ ] UI/UX 优化
  - [ ] 响应式设计检查
  - [ ] 加载状态和错误提示
  - [ ] 用户引导

**交付物**:
- ✅ 测试报告
- ✅ 性能优化建议

---

## 📊 预期时间表

| 阶段 | 预计时间 | 累计时间 |
|-----|---------|---------|
| Phase 1: 数据库 | 1-2 天 | 2 天 |
| Phase 2: 后端服务 | 2-3 天 | 5 天 |
| Phase 3: 上传流程 | 3-4 天 | 9 天 |
| Phase 4: KPI 展示 | 2 天 | 11 天 |
| Phase 5: Dashboard & Alerts | 2-3 天 | 14 天 |
| Phase 6: 测试优化 | 2 天 | 16 天 |

**总计**: 约 **2-3 周**（以全职开发计）

---

## ✅ 验收标准

### 功能完整性
- ✅ 用户可以选择上传类型（供应商、收货、价格）
- ✅ 用户可以手动映射字段
- ✅ 系统自动验证和清洗数据
- ✅ 错误行有清晰的提示
- ✅ KPI 正确计算并显示
- ✅ 多用户数据隔离

### 性能指标
- ✅ 10,000 行数据上传 < 30 秒
- ✅ KPI 查询响应 < 2 秒
- ✅ 页面加载时间 < 3 秒

### 用户体验
- ✅ 界面友好，操作流畅
- ✅ 错误提示清晰
- ✅ 响应式设计支持手机/平板

---

## 🚀 后续扩展计划

### 短期（1-2 个月）
1. 字段映射模板保存和复用
2. 批量上传多个文件
3. 导出 KPI 报告（Excel）
4. KPI 趋势图表

### 中期（3-6 个月）
1. 自动化数据导入（定时任务）
2. 供应商评级系统（A/B/C/D）
3. 多语言支持
4. 高级筛选和搜索

### 长期（6-12 个月）
1. 与 ERP 系统集成（API）
2. 供应商协作平台
3. 预测性分析（AI 预测不良率）
4. 移动端 App

---

## 📝 相关文档

- [INTEGRATION_COMPLETE.md](INTEGRATION_COMPLETE.md) - 已完成的集成
- [NEXT_STEPS.md](NEXT_STEPS.md) - 下一步操作
- [supabase-setup.sql](supabase-setup.sql) - 基础数据库设置
- [cost_analysis_schema.sql](database/cost_analysis_schema.sql) - 成本分析架构

---

## 🙋 问题与讨论

### 需要确认的问题

1. **上传类型优先级**：应该先实现哪个类型？
   - 建议：先做 `goods_receipt`（收货记录），因为不良率和准时率都需要它
   - 然后：`price_history`（价格历史）
   - 最后：完善 `supplier_master`（供应商主档）

2. **KPI 阈值设定**：
   - 不良率多少算高？建议 > 5%
   - 准时率多少算低？建议 < 90%
   - 价格波动多少算高？建议 > 15%

3. **数据保留策略**：
   - 是否需要定期归档旧数据？
   - 建议：保留最近 2 年的数据，超过 2 年的归档

4. **权限控制**：
   - 目前只有用户自己的数据隔离（RLS）
   - 未来是否需要团队共享数据？

---

**计划制定完成时间**: 2025-12-03
**状态**: ✅ 待用户审核

---

如有任何问题或需要调整，请随时提出！
