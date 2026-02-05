# SmartOps 系统架构设计

## 🏗️ 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                        前端层 (React)                          │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   数据管理    │  │  供应商分析   │  │  库存管理     │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   成本分析    │  │  仪表板       │  │  AI决策      │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        服务层 (Services)                       │
├─────────────────────────────────────────────────────────────┤
│  • supabaseClient.js      - 数据库操作                         │
│  • geminiAPI.js           - AI 分析                           │
│  • supplierAnalysis.js    - 供应商分析 (新)                    │
│  • inventoryService.js    - 库存管理 (新)                      │
│  • costAnalysisService.js - 成本分析 (新)                      │
│  • priceTrackingService.js- 价格追踪 (新)                      │
└─────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        数据层 (Supabase)                       │
├─────────────────────────────────────────────────────────────┤
│  基础表:                                                       │
│  • users (认证)                                               │
│  • user_files (数据文件)                                      │
│  • suppliers (供应商)                                         │
│  • conversations (AI对话)                                     │
│                                                               │
│  新增表:                                                       │
│  • supplier_performance (供应商绩效)                          │
│  • supplier_scores (供应商评分)                               │
│  • inventory_items (库存物料)                                 │
│  • inventory_transactions (库存交易)                          │
│  • metal_price_tracking (金属价格)                            │
│  • shortage_alerts (缺料警报)                                 │
│  • operational_costs (营运成本)                               │
│  • cost_anomalies (成本异常)                                  │
└─────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     外部服务 (External)                        │
├─────────────────────────────────────────────────────────────┤
│  • Google Gemini AI      - AI分析与预测                        │
│  • Price Data API        - 金属价格数据 (可选)                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 📁 文件结构

```
smartops-app/
├── src/
│   ├── App.jsx                          # 主应用（路由与布局）
│   │
│   ├── components/                      # 可重用组件
│   │   ├── ui/                         # UI 基础组件
│   │   │   ├── Card.jsx
│   │   │   ├── Button.jsx
│   │   │   ├── Badge.jsx
│   │   │   ├── Modal.jsx
│   │   │   └── index.js
│   │   │
│   │   ├── charts/                     # 图表组件
│   │   │   ├── SimpleLineChart.jsx
│   │   │   ├── SimpleBarChart.jsx
│   │   │   └── index.js
│   │   │
│   │   └── analytics/                  # 分析组件 (新)
│   │       ├── RiskScoreCard.jsx
│   │       ├── PriceChart.jsx
│   │       ├── PerformanceMetrics.jsx
│   │       ├── AlertsPanel.jsx
│   │       └── ScoreGauge.jsx
│   │
│   ├── services/                       # 服务层
│   │   ├── supabaseClient.js          # Supabase 客户端
│   │   ├── geminiAPI.js               # AI API
│   │   ├── supplierAnalysisService.js # 供应商分析 (新)
│   │   ├── inventoryService.js        # 库存管理 (新)
│   │   ├── costAnalysisService.js     # 成本分析 (新)
│   │   └── priceTrackingService.js    # 价格追踪 (新)
│   │
│   ├── utils/                         # 工具函数
│   │   ├── dataProcessing.js          # 数据处理
│   │   ├── calculations.js            # 计算函数 (新)
│   │   └── constants.js               # 常量定义 (新)
│   │
│   └── views/                         # 页面视图
│       ├── HomeView.jsx               # 主页
│       ├── ExternalSystemsView.jsx    # 数据上传
│       ├── SupplierManagementView.jsx # 供应商管理
│       ├── SupplierAnalysisView.jsx   # 供应商分析 (新)
│       ├── InventoryManagementView.jsx# 库存管理 (新)
│       ├── CostAnalysisView.jsx       # 成本分析 (新)
│       ├── OperationsDashboardView.jsx# 仪表板
│       ├── SmartAlertsView.jsx        # 智能警报
│       ├── AnalyticsCenterView.jsx    # 分析中心
│       ├── DecisionSupportView.jsx    # AI决策
│       └── SettingsView.jsx           # 设置
│
├── database/                          # 数据库脚本
│   ├── schema.sql                     # 完整数据库架构 (新)
│   └── migrations/                    # 数据库迁移 (新)
│
└── docs/                              # 文档
    ├── IMPLEMENTATION_PLAN.md         # 实施计划
    ├── ARCHITECTURE_DESIGN.md         # 架构设计 (本文档)
    ├── API_REFERENCE.md               # API 文档 (待创建)
    └── USER_GUIDE.md                  # 用户手册 (待创建)
```

---

## 🔄 数据流设计

### 1. 供应商风险分析流程

```
用户上传数据
    ↓
extractSuppliers() - 提取供应商信息
    ↓
保存到 suppliers 表
    ↓
记录绩效数据 → supplier_performance 表
    ↓
AI 分析 ← geminiAPI.analyzeSupplierRisk()
    ↓
计算评分 ← calculateSupplierScore()
    ↓
保存评分 → supplier_scores 表
    ↓
展示在 SupplierAnalysisView
```

### 2. 缺料检测流程

```
库存数据输入 → inventory_items 表
    ↓
定期检查（每天）
    ↓
compareStockLevels()
    ↓
检测缺料风险
    ↓
生成警报 → shortage_alerts 表
    ↓
AI 分析 ← geminiAPI.predictShortage()
    ↓
生成补货建议
    ↓
通知用户 → InventoryManagementView
```

### 3. 成本分析流程

```
每日成本输入 → operational_costs 表
    ↓
计算 totalLaborCost = direct + indirect
    ↓
计算 costPerUnit = totalCost / output
    ↓
检测异常 ← detectCostAnomalies()
    ↓
如果异常 → cost_anomalies 表
    ↓
AI 分析 ← geminiAPI.analyzeCostAnomaly()
    ↓
可视化 → CostAnalysisView
```

### 4. 价格追踪流程

```
每日价格更新 → metal_price_tracking 表
    ↓
计算价格变化
    ↓
价格趋势分析 ← analyzePriceTrend()
    ↓
关联库存物料 → inventory_items
    ↓
调整安全库存建议
    ↓
展示 → InventoryManagementView
```

---

## 🎯 核心功能模块详解

### 模块1：资料管理模组

**视图**: `ExternalSystemsView` (扩展)

**功能**:
- Excel/CSV 文件上传
- AI 数据分析与验证
- 数据标准化处理
- 版本控制与历史记录
- 供应商数据自动提取

**关键API**:
```javascript
// 数据上传与分析
handleExcelUpload(file)
runAiAnalysis(data)
extractSuppliers(data)
saveToDatabase(data, version)
```

---

### 模块2：供应商管理与风险分析模组

**视图**:
- `SupplierManagementView` (扩展)
- `SupplierAnalysisView` (新)

**功能**:
1. **基本管理** (已有)
   - 供应商 CRUD
   - 搜索与筛选
   - 批量导入

2. **风险分析** (新)
   - 缺料风险评估
   - 交期延迟分析
   - 供应商稳定性评分

3. **价格分析** (新)
   - 历史价格追踪
   - 同料件价格比较
   - 价格异常检测

4. **综合评分** (新)
   - 多维度评分系统
   - Scorecard 展示
   - 排名与推荐

**关键API**:
```javascript
// 供应商分析服务
calculateSupplierScore(supplierId)
getSupplierRiskAnalysis(supplierId)
comparePrices(materialCode)
getSupplierPerformance(supplierId, period)
```

---

### 模块3：缺料与库存管理模组

**视图**: `InventoryManagementView` (新)

**功能**:
1. **库存管理**
   - 物料主数据管理
   - 当前库存查询
   - 安全库存设置
   - 库存交易记录

2. **缺料检测**
   - 自动缺料检测
   - 预期缺料预警
   - 缺料优先级排序

3. **金属价格追踪**
   - 每日价格更新
   - 价格趋势图表
   - 30日平均价格
   - 价格变化警报

4. **补货建议**
   - 基于需求的采购建议
   - 考虑价格趋势
   - 考虑供应商交期
   - 生成采购单草稿

**关键API**:
```javascript
// 库存服务
getInventoryItems()
updateStock(materialId, quantity)
detectShortages()
generateReplenishmentSuggestions()
trackMetalPrices(metalType)
getStockAlerts()
```

---

### 模块4：营运管理与成本分析模组

**视图**: `CostAnalysisView` (新)

**功能**:
1. **成本记录**
   - 每日直接人工成本
   - 每日间接人工成本
   - 其他成本（材料、制造费用）

2. **成本计算**
   - 总营运成本 = 直接 + 间接
   - 单位成本 = 总成本 / 产出

3. **成本分析**
   - 成本趋势图表
   - 成本结构分析（饼图）
   - 每产品/产线成本比较

4. **异常检测**
   - 自动检测成本异常
   - AI 分析异常原因
   - 改善建议

**关键API**:
```javascript
// 成本分析服务
recordDailyCost(costData)
calculateTotalCost(directCost, indirectCost)
detectCostAnomalies(period)
getCostTrends(period)
analyzeCostStructure(date)
```

---

## 🧩 组件设计模式

### 1. Container-Presenter 模式

```javascript
// Container (逻辑层)
const InventoryManagementView = () => {
  const [inventory, setInventory] = useState([]);

  useEffect(() => {
    loadInventory();
  }, []);

  const loadInventory = async () => {
    const data = await inventoryService.getAll();
    setInventory(data);
  };

  return <InventoryList inventory={inventory} onRefresh={loadInventory} />;
};

// Presenter (展示层)
const InventoryList = ({ inventory, onRefresh }) => {
  return (
    <div>
      <Button onClick={onRefresh}>刷新</Button>
      {inventory.map(item => <InventoryCard key={item.id} item={item} />)}
    </div>
  );
};
```

### 2. 服务层抽象

```javascript
// 统一的服务接口
class BaseService {
  constructor(tableName) {
    this.tableName = tableName;
  }

  async getAll(userId) {
    const { data, error } = await supabase
      .from(this.tableName)
      .select('*')
      .eq('user_id', userId);

    if (error) throw error;
    return data;
  }

  async getById(id) { /* ... */ }
  async create(data) { /* ... */ }
  async update(id, data) { /* ... */ }
  async delete(id) { /* ... */ }
}

// 具体服务
class InventoryService extends BaseService {
  constructor() {
    super('inventory_items');
  }

  // 特定方法
  async detectShortages(userId) { /* ... */ }
  async getStockAlerts(userId) { /* ... */ }
}
```

---

## 🔐 安全设计

### Row Level Security (RLS)

所有表都启用 RLS，确保用户只能访问自己的数据：

```sql
-- 示例：inventory_items 表的 RLS 策略
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own inventory"
  ON inventory_items
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

### API Key 安全

- Gemini API Key 存储在 localStorage（客户端）
- 提供默认 API Key 用于演示
- 用户可自行配置私人 API Key

---

## 📊 性能优化策略

### 1. 数据库优化
- 为常用查询字段添加索引
- 使用 JSONB 存储灵活数据
- 定期清理历史数据

### 2. 前端优化
- 使用 React.memo 避免不必要的重渲染
- 懒加载大型组件
- 虚拟滚动处理大数据列表

### 3. 缓存策略
- 供应商评分缓存（每日更新）
- 金属价格缓存（每日更新）
- AI 分析结果缓存

---

## 🧪 测试策略

### 单元测试
```javascript
// 服务层测试
describe('inventoryService', () => {
  test('detectShortages returns items below safety stock', async () => {
    const shortages = await inventoryService.detectShortages(userId);
    expect(shortages.length).toBeGreaterThan(0);
  });
});
```

### 集成测试
- 测试数据库连接
- 测试 API 调用
- 测试组件交互

### E2E 测试
- 用户流程测试
- 跨模块集成测试

---

## 📈 监控与日志

### 关键指标监控
- API 响应时间
- 数据库查询时间
- AI 调用成功率
- 用户活跃度

### 错误日志
```javascript
// 统一错误处理
const handleError = (error, context) => {
  console.error(`[${context}]`, error);
  // 发送到日志服务
  logToService({
    timestamp: new Date(),
    context,
    error: error.message,
    stack: error.stack
  });
};
```

---

## 🚀 部署架构

```
┌─────────────────┐
│   Vercel/Netlify │  ← 前端托管
└─────────────────┘
        ↓
┌─────────────────┐
│    Supabase     │  ← 数据库 + 认证
└─────────────────┘
        ↓
┌─────────────────┐
│  Google Gemini  │  ← AI 服务
└─────────────────┘
```

---

**文档版本**: v1.0
**创建日期**: 2025-12-02
**最后更新**: 2025-12-02
