# SmartOps 四大模块功能扩展 - 实施计划

## 📋 项目概述

### 目标
为 SmartOps 系统新增/扩展四个核心管理模块：
1. **资料管理模组** - 数据整合与标准化
2. **供应商管理与风险分析模组** - 供应商评分与风险评估
3. **缺料与库存管理模组** - 库存监控与补货管理
4. **营运管理与成本分析模组** - 成本追踪与分析

### 当前系统状态
- ✅ 基础架构完整（React + Vite + Supabase + AI）
- ✅ 用户认证系统
- ✅ 基本数据上传功能（ExternalSystemsView）
- ✅ 基本供应商CRUD（SupplierManagementView）
- ✅ 仪表板展示
- ✅ AI决策支持
- ❌ 缺少风险分析功能
- ❌ 缺少库存管理功能
- ❌ 缺少成本分析功能

---

## 📊 阶段1：数据库设计与表结构

### 1.1 新增数据库表

#### 表1：`supplier_performance` - 供应商绩效记录
```sql
CREATE TABLE supplier_performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,

  -- 交期相关
  order_date DATE NOT NULL,
  expected_delivery_date DATE NOT NULL,
  actual_delivery_date DATE,
  delivery_delay_days INTEGER DEFAULT 0,
  on_time BOOLEAN DEFAULT true,

  -- 价格相关
  material_name TEXT NOT NULL,
  material_code TEXT,
  unit_price DECIMAL(10, 2),
  currency TEXT DEFAULT 'TWD',
  price_change_percent DECIMAL(5, 2) DEFAULT 0,

  -- 质量相关
  order_quantity INTEGER NOT NULL,
  received_quantity INTEGER NOT NULL,
  defect_quantity INTEGER DEFAULT 0,
  defect_rate DECIMAL(5, 2) DEFAULT 0,

  -- 其他
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_supplier_performance_supplier ON supplier_performance(supplier_id);
CREATE INDEX idx_supplier_performance_date ON supplier_performance(order_date DESC);
```

#### 表2：`supplier_scores` - 供应商综合评分
```sql
CREATE TABLE supplier_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,

  -- 评分维度（0-100分）
  price_score DECIMAL(5, 2) DEFAULT 0,         -- 价格评分（30%）
  delivery_score DECIMAL(5, 2) DEFAULT 0,      -- 准时交货评分（40%）
  quality_score DECIMAL(5, 2) DEFAULT 0,       -- 品质评分（20%）
  cooperation_score DECIMAL(5, 2) DEFAULT 0,   -- 配合度评分（10%）

  -- 综合评分
  total_score DECIMAL(5, 2) DEFAULT 0,
  risk_level TEXT DEFAULT 'medium',  -- low, medium, high

  -- 统计数据
  total_orders INTEGER DEFAULT 0,
  on_time_orders INTEGER DEFAULT 0,
  on_time_rate DECIMAL(5, 2) DEFAULT 0,
  avg_delay_days DECIMAL(5, 2) DEFAULT 0,

  calculation_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_supplier_scores_supplier ON supplier_scores(supplier_id);
CREATE INDEX idx_supplier_scores_total ON supplier_scores(total_score DESC);
```

#### 表3：`inventory_items` - 库存物料
```sql
CREATE TABLE inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 物料基本信息
  material_code TEXT NOT NULL UNIQUE,
  material_name TEXT NOT NULL,
  material_category TEXT,  -- raw_material, component, finished_good
  material_type TEXT,      -- metal, plastic, electronic, etc

  -- 供应商
  primary_supplier_id UUID REFERENCES suppliers(id),
  backup_supplier_ids UUID[],

  -- 库存信息
  current_stock DECIMAL(10, 2) DEFAULT 0,
  unit TEXT DEFAULT 'pcs',
  safety_stock DECIMAL(10, 2) DEFAULT 0,
  reorder_point DECIMAL(10, 2) DEFAULT 0,
  max_stock DECIMAL(10, 2),

  -- 在途量
  in_transit_quantity DECIMAL(10, 2) DEFAULT 0,

  -- 成本
  unit_cost DECIMAL(10, 2),
  currency TEXT DEFAULT 'TWD',

  -- 采购信息
  lead_time_days INTEGER DEFAULT 7,
  moq DECIMAL(10, 2),  -- 最小订购量

  -- 状态
  status TEXT DEFAULT 'active',  -- active, low_stock, out_of_stock, discontinued

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_inventory_material_code ON inventory_items(material_code);
CREATE INDEX idx_inventory_status ON inventory_items(status);
```

#### 表4：`inventory_transactions` - 库存交易记录
```sql
CREATE TABLE inventory_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  material_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,

  transaction_type TEXT NOT NULL,  -- inbound, outbound, adjustment
  quantity DECIMAL(10, 2) NOT NULL,
  unit_cost DECIMAL(10, 2),

  reference_no TEXT,  -- PO number, SO number, etc
  supplier_id UUID REFERENCES suppliers(id),

  notes TEXT,
  transaction_date TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_inventory_trans_material ON inventory_transactions(material_id);
CREATE INDEX idx_inventory_trans_date ON inventory_transactions(transaction_date DESC);
```

#### 表5：`metal_price_tracking` - 金属材料价格追踪
```sql
CREATE TABLE metal_price_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  metal_type TEXT NOT NULL,  -- steel, aluminum, copper, etc
  price_date DATE NOT NULL DEFAULT CURRENT_DATE,
  price DECIMAL(10, 4) NOT NULL,
  unit TEXT DEFAULT 'kg',
  currency TEXT DEFAULT 'TWD',

  -- 价格来源
  source TEXT,  -- manual, api, market_data

  -- 计算字段
  price_change DECIMAL(10, 4),
  price_change_percent DECIMAL(5, 2),

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(metal_type, price_date)
);

CREATE INDEX idx_metal_price_type ON metal_price_tracking(metal_type);
CREATE INDEX idx_metal_price_date ON metal_price_tracking(price_date DESC);
```

#### 表6：`shortage_alerts` - 缺料警报
```sql
CREATE TABLE shortage_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  material_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,

  alert_type TEXT NOT NULL,  -- low_stock, out_of_stock, expected_shortage
  severity TEXT DEFAULT 'medium',  -- low, medium, high, critical

  -- 缺料信息
  current_stock DECIMAL(10, 2),
  required_stock DECIMAL(10, 2),
  shortage_quantity DECIMAL(10, 2),
  expected_shortage_date DATE,

  -- 建议
  suggested_order_quantity DECIMAL(10, 2),
  suggested_order_date DATE,

  status TEXT DEFAULT 'active',  -- active, resolved, ignored
  resolved_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_shortage_alerts_material ON shortage_alerts(material_id);
CREATE INDEX idx_shortage_alerts_status ON shortage_alerts(status);
```

#### 表7：`operational_costs` - 营运成本记录
```sql
CREATE TABLE operational_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  cost_date DATE NOT NULL DEFAULT CURRENT_DATE,

  -- 直接人工成本
  direct_labor_hours DECIMAL(10, 2) DEFAULT 0,
  direct_labor_rate DECIMAL(10, 2) DEFAULT 0,
  direct_labor_cost DECIMAL(12, 2) DEFAULT 0,

  -- 间接人工成本
  indirect_labor_hours DECIMAL(10, 2) DEFAULT 0,
  indirect_labor_rate DECIMAL(10, 2) DEFAULT 0,
  indirect_labor_cost DECIMAL(12, 2) DEFAULT 0,

  -- 总成本
  total_labor_cost DECIMAL(12, 2) DEFAULT 0,

  -- 产出
  production_output DECIMAL(10, 2) DEFAULT 0,
  production_unit TEXT DEFAULT 'pcs',

  -- 单位成本
  cost_per_unit DECIMAL(10, 4),

  -- 其他成本（可选）
  material_cost DECIMAL(12, 2) DEFAULT 0,
  overhead_cost DECIMAL(12, 2) DEFAULT 0,

  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, cost_date)
);

CREATE INDEX idx_operational_costs_date ON operational_costs(cost_date DESC);
```

#### 表8：`cost_anomalies` - 成本异常记录
```sql
CREATE TABLE cost_anomalies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cost_id UUID REFERENCES operational_costs(id) ON DELETE CASCADE,

  anomaly_type TEXT NOT NULL,  -- high_cost, efficiency_drop, overhead_spike
  severity TEXT DEFAULT 'medium',  -- low, medium, high

  anomaly_date DATE NOT NULL,
  detected_value DECIMAL(12, 2),
  expected_value DECIMAL(12, 2),
  deviation_percent DECIMAL(5, 2),

  description TEXT,
  ai_analysis TEXT,

  status TEXT DEFAULT 'pending',  -- pending, investigating, resolved
  resolution_notes TEXT,
  resolved_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cost_anomalies_date ON cost_anomalies(anomaly_date DESC);
CREATE INDEX idx_cost_anomalies_status ON cost_anomalies(status);
```

### 1.2 更新现有表

#### 扩展 `suppliers` 表（如果需要）
```sql
-- 如果 suppliers 表还未创建，先创建基础表
CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  supplier_name TEXT NOT NULL,
  supplier_code TEXT,
  contact_info TEXT,
  address TEXT,
  product_category TEXT,
  payment_terms TEXT,
  delivery_time TEXT,

  -- 新增字段
  email TEXT,
  phone TEXT,
  website TEXT,
  status TEXT DEFAULT 'active',  -- active, inactive, blacklisted

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 添加索引
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(supplier_name);
CREATE INDEX IF NOT EXISTS idx_suppliers_status ON suppliers(status);

-- 启用 RLS
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own suppliers"
  ON suppliers
  USING (auth.uid() = user_id);
```

---

## 🛠️ 阶段2：服务层开发

### 2.1 创建新服务文件

#### `src/services/supplierAnalysisService.js`
供应商分析相关服务：
- 计算供应商评分
- 获取风险分析
- 价格趋势分析
- 绩效统计

#### `src/services/inventoryService.js`
库存管理服务：
- CRUD 库存物料
- 库存交易记录
- 缺料检测
- 补货建议生成

#### `src/services/costAnalysisService.js`
成本分析服务：
- 每日成本记录
- 成本异常检测
- 成本趋势分析
- 成本报表生成

#### `src/services/priceTrackingService.js`
价格追踪服务：
- 金属价格记录
- 价格趋势分析
- 价格预警

### 2.2 AI增强服务

扩展 `src/services/geminiAPI.js` 添加：
- 供应商风险分析 AI
- 缺料预测 AI
- 成本异常分析 AI
- 价格趋势预测 AI

---

## 🎨 阶段3：UI组件开发

### 3.1 扩展现有组件

#### 扩展 `src/views/SupplierManagementView.jsx`
新增功能：
- 供应商评分卡片
- 风险等级显示
- 价格历史图表
- 绩效追踪表格
- AI 风险分析面板

### 3.2 新增视图组件

#### `src/views/InventoryManagementView.jsx` - 库存管理
功能：
- 库存物料列表
- 库存水平监控
- 缺料警报看板
- 补货建议列表
- 金属价格追踪
- 安全库存设置

#### `src/views/CostAnalysisView.jsx` - 成本分析
功能：
- 每日成本输入表单
- 成本趋势图表（折线图）
- 直接/间接成本对比（饼图）
- 单位成本分析
- 成本异常警报
- AI 成本分析建议

#### `src/views/SupplierAnalysisView.jsx` - 供应商分析（独立页面）
功能：
- 供应商 Scorecard
- 风险矩阵图
- 价格比较表
- 绩效仪表板
- AI 供应商推荐

### 3.3 共享组件

#### `src/components/analytics/` - 分析组件
- `RiskScoreCard.jsx` - 风险评分卡
- `PriceChart.jsx` - 价格趋势图
- `PerformanceMetrics.jsx` - 绩效指标
- `AlertsPanel.jsx` - 警报面板
- `ScoreGauge.jsx` - 评分仪表盘

---

## 🔗 阶段4：导航与集成

### 4.1 更新导航结构

在 `src/App.jsx` 中更新导航菜单，采用分组结构：

```javascript
const navGroups = [
  {
    name: '核心功能',
    items: [
      { id: 'home', label: 'Home', icon: LayoutDashboard },
      { id: 'dashboard', label: 'Dashboard', icon: BarChart3 }
    ]
  },
  {
    name: '数据管理',
    items: [
      { id: 'external', label: 'External Systems', icon: Database },
      { id: 'integration', label: 'Data Integration', icon: RefreshCw }
    ]
  },
  {
    name: '供应链管理',
    items: [
      { id: 'suppliers', label: '供应商管理', icon: Building2 },
      { id: 'supplier-analysis', label: '供应商分析', icon: TrendingUp },
      { id: 'inventory', label: '库存管理', icon: Package },
    ]
  },
  {
    name: '营运分析',
    items: [
      { id: 'cost-analysis', label: '成本分析', icon: DollarSign },
      { id: 'alerts', label: 'Smart Alerts', icon: AlertTriangle }
    ]
  },
  {
    name: 'AI 辅助',
    items: [
      { id: 'decision', label: 'Decision AI', icon: Bot },
      { id: 'analytics', label: 'Analytics', icon: TrendingUp }
    ]
  }
];
```

### 4.2 路由配置

```javascript
const renderView = () => {
  switch (view) {
    // 现有路由
    case 'home': return <HomeView setView={setView} />;
    case 'dashboard': return <OperationsDashboardView excelData={excelData} />;
    case 'external': return <ExternalSystemsView ... />;

    // 供应商相关
    case 'suppliers': return <SupplierManagementView ... />;
    case 'supplier-analysis': return <SupplierAnalysisView ... />;

    // 库存管理（新）
    case 'inventory': return <InventoryManagementView ... />;

    // 成本分析（新）
    case 'cost-analysis': return <CostAnalysisView ... />;

    // 其他
    case 'alerts': return <SmartAlertsView ... />;
    case 'analytics': return <AnalyticsCenterView ... />;
    case 'decision': return <DecisionSupportView ... />;
    case 'settings': return <SettingsView ... />;

    default: return <HomeView setView={setView} />;
  }
};
```

---

## 📅 实施时间表

### 第1周：数据库设计与服务层
- Day 1-2: 创建数据库表和索引
- Day 3-4: 开发服务层 API
- Day 5: 测试服务层功能

### 第2周：供应商分析模块
- Day 1-2: 扩展 SupplierManagementView
- Day 3-4: 创建 SupplierAnalysisView
- Day 5: AI 风险分析集成

### 第3周：库存管理模块
- Day 1-2: 创建 InventoryManagementView
- Day 3: 实现缺料检测功能
- Day 4: 金属价格追踪功能
- Day 5: 补货建议系统

### 第4周：成本分析模块
- Day 1-2: 创建 CostAnalysisView
- Day 3: 成本图表与可视化
- Day 4: 成本异常检测
- Day 5: AI 成本分析

### 第5周：集成与优化
- Day 1-2: 导航重构与集成
- Day 3: Dashboard 更新（新增 KPI）
- Day 4-5: 全面测试与bug修复

---

## 🧪 测试计划

### 单元测试
- 服务层函数测试
- 数据处理工具测试
- AI 调用测试

### 集成测试
- 数据库连接测试
- API 调用测试
- 组件交互测试

### 用户验收测试
- 功能完整性测试
- 性能测试
- 响应式设计测试

---

## 📦 部署计划

### 准备工作
1. 在 Supabase 中执行所有 SQL 脚本
2. 更新环境变量
3. 构建生产版本

### 部署步骤
1. 备份当前数据库
2. 运行数据库迁移
3. 部署新代码
4. 验证功能
5. 监控错误

---

## 🎯 成功指标

### 技术指标
- 所有新功能正常运行
- 响应时间 < 2 秒
- 无重大 bug
- 代码测试覆盖率 > 60%

### 业务指标
- 供应商风险评分准确率 > 80%
- 缺料预警提前期 > 7 天
- 成本异常检测率 > 90%
- 用户满意度 > 85%

---

## 🚀 后续优化方向

### 短期（1-2个月）
- 添加数据导出功能（PDF/Excel）
- 实现移动端优化
- 添加多语言支持
- 增加更多图表类型

### 中期（3-6个月）
- 实现实时数据同步
- 添加通知推送系统
- 开发供应商协作门户
- 集成第三方 ERP 系统

### 长期（6-12个月）
- 机器学习预测模型
- 区块链供应链追踪
- 物联网设备集成
- 移动应用开发

---

## 📞 技术支持

### 开发团队
- 前端开发
- 后端开发
- 数据库管理
- AI/ML 工程

### 文档
- API 文档
- 用户手册
- 部署指南
- 故障排除

---

**文档版本**: v1.0
**创建日期**: 2025-12-02
**最后更新**: 2025-12-02
**负责人**: Development Team
