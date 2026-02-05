# M2: Profit at Risk 实现总结

## 🎯 目标

在 Risk Dashboard 中加入 Profit at Risk（货币化），使风险评估更具业务价值。

**核心特性：**
- 每列显示 Profit at Risk 金额
- KPI 显示总金额（Total + Critical）
- 支持真实 financials 与 fallback assumption
- UI 明确标示数据来源

---

## ✅ 完成的交付

### Step 1: 定义 Financial 输入（支持两种来源）✅

#### A) 真实 financials（优先）
**数据来源：** `fg_financials` 表

**支持字段（容错读取）：**
- 料号：`material_code` / `item_code` / `item` / `product_code`
- 利润：`profit_per_unit` / `margin_per_unit` / `gross_margin` / `unit_profit` / `margin`
- 货币：`currency` / `currency_code`（默认 USD）

#### B) Fallback 假设（无 financials 时）
**假设值：** `$10/unit`

**UI 标示：**
- 蓝色提示框追加：`"Assumption: $10/unit (FG financials not loaded)"`
- 表格中使用 assumption 的行显示 `~` 符号
- DetailsPanel 显示 `[~ Assumption]` 标签

---

### Step 2: 新增 Domain 计算器（Pure Function）✅

**新增文件：** `src/domains/risk/profitAtRiskCalculator.js`

#### 核心函数：

1. **`buildFinancialIndex(financials)`**
   ```javascript
   // 输入：fg_financials 数据
   // 输出：{ itemKey: { profitPerUnit, currency, source: 'REAL' } }
   ```

2. **`calculateProfitAtRiskForRow(riskRow, financialIndex, useFallback)`**
   ```javascript
   // 输入：单个风险行 + 财务索引
   // 输出：加入 profitPerUnit, profitAtRisk, profitAtRiskReason
   
   // 计算规则：
   exposureQty = max(0, gapQty)
   profitAtRisk = exposureQty * profitPerUnit
   ```

3. **`calculateProfitAtRiskBatch(params)`**
   ```javascript
   // 输入：{ riskRows, financials, useFallback }
   // 输出：{ rows, summary }
   
   // summary 包含：
   // - totalProfitAtRisk
   // - criticalProfitAtRisk
   // - warningProfitAtRisk
   // - itemsWithRealFinancials
   // - itemsWithAssumption
   ```

4. **`formatCurrency(amount, currency)`**
   ```javascript
   // 支持：USD ($), EUR (€), CNY (¥)
   ```

5. **`getFallbackAssumption()`**
   ```javascript
   // 返回：{ profitPerUnit: 10, currency: 'USD', displayText: 'Assumption: $10/unit' }
   ```

#### 计算规则（简洁可解释）：
```javascript
// 1. 确定 profitPerUnit
if (financialIndex[item]) {
  profitPerUnit = financialIndex[item].profitPerUnit;  // 真实数据
  profitAtRiskReason = 'REAL';
} else if (useFallback) {
  profitPerUnit = 10;  // Fallback 假设
  profitAtRiskReason = 'ASSUMPTION';
} else {
  profitPerUnit = 0;  // 无数据
  profitAtRiskReason = 'MISSING';
}

// 2. 计算暴露量
exposureQty = max(0, gapQty);

// 3. 计算 Profit at Risk
profitAtRisk = exposureQty * profitPerUnit;
```

---

### Step 3: UI 增加（最小改动）✅

#### 3.1 RiskDashboardView
**修改文件：** `src/views/RiskDashboardView.jsx`

**变更：**
1. 加载 FG Financials（如果有）
   ```javascript
   const { data: finData } = await supabase
     .from('fg_financials')
     .select('*')
     .eq('user_id', user.id);
   ```

2. 调用 Profit at Risk 计算
   ```javascript
   const { rows: rowsWithProfit, summary: profitSummaryData } = calculateProfitAtRiskBatch({
     riskRows: domainResults,
     financials: financialsData,
     useFallback: true
   });
   ```

3. 新增 `profitSummary` state
   ```javascript
   const [profitSummary, setProfitSummary] = useState({
     totalProfitAtRisk: 0,
     criticalProfitAtRisk: 0,
     itemsWithRealFinancials: 0,
     usingFallback: false
   });
   ```

4. 蓝色提示框追加 assumption 说明
   ```jsx
   {profitSummary.usingFallback && (
     <div>• Profit at Risk: Assumption: $10/unit (FG financials not loaded)</div>
   )}
   ```

#### 3.2 RiskTable
**修改文件：** `src/components/risk/RiskTable.jsx`

**变更：**
- 新增 `Profit at Risk` 列（可排序）
- 显示金额（带货币符号）
- 使用 assumption 的行显示 `~` 符号

**表格结构：**
```
| 料号 | 工厂 | 状态 | Net available | Gap qty | Next bucket | Profit at Risk | 操作 |
```

#### 3.3 DetailsPanel
**修改文件：** `src/components/risk/DetailsPanel.jsx`

**新增区块：** Section 5 - Profit at Risk（货币化）

**显示内容：**
- 来源标签（✓ Real financials / ~ Assumption / ⚠ Missing）
- Profit per unit
- Exposure qty（来自 gapQty）
- Profit at Risk（计算结果）
- 公式：`profitAtRisk = max(0, gapQty) * profitPerUnit`
- 若 MISSING：显示 "⚠️ Missing financials for this item"

#### 3.4 KPICards
**修改文件：** `src/components/risk/KPICards.jsx`

**变更：**
- Card 3：显示真实 Profit at Risk（不再是 $0）
- 移除 "📋 Coming Week 2" 标签
- 显示 Critical Profit at Risk 子标签
- 红色主题（强调风险）

---

### Step 4: 透明度（必须）✅

#### 4.1 蓝色提示框追加说明
```
Supply Coverage Risk (Bucket-Based)

• Horizon: 3 buckets（約 3 週）
• Data source: Open PO + Inventory snapshots + FG financials
• Limitation: Stockout date/Days to stockout require demand/usage/forecast data
• Profit at Risk: Using real financials for 5 items, Assumption: $10/unit for others
  （或）
• Profit at Risk: Assumption: $10/unit (FG financials not loaded)
```

#### 4.2 表格行标示
使用 assumption 的行显示 `~` 符号：
```
| PART-A101 | TW01 | 🔴 | 250 | 0 | W06 | $0    |    |
| PART-B202 | CN01 | 🔴 | 100 | 50 | N/A | $500~ | ⓘ |  ← ~ 表示使用 assumption
```

#### 4.3 DetailsPanel 标签
```
[✓ Real financials]  ← 绿色（有真实数据）
[~ Assumption]       ← 黄色（使用假设）
[⚠ Missing financials] ← 灰色（无数据）
```

#### 4.4 缺失处理
若 profitAtRisk = 0（因为 MISSING）：
- 显示 `$0`
- DetailsPanel 说明：`"⚠️ Missing financials for this item"`
- 不影响总金额计算

---

## 📂 修改/新增文件清单

### 新增文件（2 个）
1. ✨ **`src/domains/risk/profitAtRiskCalculator.js`** ⭐ 核心逻辑
   - `buildFinancialIndex()` - 建立财务索引
   - `calculateProfitAtRiskForRow()` - 单行计算
   - `calculateProfitAtRiskBatch()` - 批量计算
   - `formatCurrency()` - 货币格式化
   - `getFallbackAssumption()` - 获取 fallback 假设

2. 📄 **`M2_PROFIT_AT_RISK_IMPLEMENTATION.md`** - 本实现总结

### 修改文件（6 个）
1. **`src/views/RiskDashboardView.jsx`**
   - 加载 FG Financials
   - 调用 `calculateProfitAtRiskBatch()`
   - 新增 `profitSummary` state
   - 更新 KPI Cards props
   - 蓝色提示框追加 assumption 说明

2. **`src/components/risk/mapDomainToUI.js`**
   - 传递 Profit at Risk 相关字段

3. **`src/components/risk/RiskTable.jsx`**
   - 新增 `Profit at Risk` 列（可排序）
   - 显示货币金额
   - 使用 assumption 的行显示 `~`

4. **`src/components/risk/DetailsPanel.jsx`**
   - 新增 Section 5: Profit at Risk
   - 显示来源标签（REAL/ASSUMPTION/MISSING）
   - 显示计算明细与公式

5. **`src/components/risk/KPICards.jsx`**
   - 更新 Card 3 显示真实金额
   - 移除 "Coming Week 2"
   - 显示 Critical Profit at Risk

6. **（无需修改）** `src/domains/risk/coverageCalculator.js` - 保持不变

---

## 🔧 profitPerUnit 来源优先级

### 来源优先级（按顺序尝试）

1. **REAL**（最优先）
   ```javascript
   // 从 fg_financials 查找
   if (financialIndex[item]) {
     profitPerUnit = financialIndex[item].profitPerUnit;
     profitAtRiskReason = 'REAL';
   }
   ```

2. **ASSUMPTION**（次优先，useFallback = true）
   ```javascript
   else if (useFallback) {
     profitPerUnit = 10;  // $10/unit
     profitAtRiskReason = 'ASSUMPTION';
   }
   ```

3. **MISSING**（最后，useFallback = false）
   ```javascript
   else {
     profitPerUnit = 0;
     profitAtRiskReason = 'MISSING';
   }
   ```

### Fallback 值
- **profitPerUnit**: `10`
- **currency**: `'USD'`
- **displayText**: `"Assumption: $10/unit"`

### 字段容错读取优先级
```javascript
// 料号
material_code > item_code > item > product_code

// 利润
profit_per_unit > margin_per_unit > gross_margin > unit_profit > margin

// 货币
currency > currency_code > 'USD'
```

---

## 📊 计算示例

### 示例 1: 有真实 financials
```javascript
// Input
riskRow = {
  item: 'PART-A101',
  factory: 'FAC-TW01',
  gapQty: 50,
  status: 'CRITICAL'
}
financialIndex = {
  'PART-A101': { profitPerUnit: 25, currency: 'USD', source: 'REAL' }
}

// Calculation
exposureQty = max(0, 50) = 50
profitAtRisk = 50 * 25 = 1250

// Output
{
  ...riskRow,
  profitPerUnit: 25,
  currency: 'USD',
  exposureQty: 50,
  profitAtRisk: 1250,
  profitAtRiskReason: 'REAL'
}
```

### 示例 2: 使用 fallback assumption
```javascript
// Input
riskRow = {
  item: 'PART-B202',
  gapQty: 30,
  status: 'WARNING'
}
financialIndex = {}  // 无真实 financials

// Calculation
exposureQty = max(0, 30) = 30
profitAtRisk = 30 * 10 = 300  // 使用 fallback

// Output
{
  ...riskRow,
  profitPerUnit: 10,
  currency: 'USD',
  exposureQty: 30,
  profitAtRisk: 300,
  profitAtRiskReason: 'ASSUMPTION'
}
```

### 示例 3: Missing（useFallback = false）
```javascript
// Input
riskRow = { item: 'PART-C303', gapQty: 20 }
useFallback = false

// Output
{
  ...riskRow,
  profitPerUnit: 0,
  profitAtRisk: 0,
  profitAtRiskReason: 'MISSING'
}
```

---

## 🎨 UI 展示

### KPI Cards
```
┌────────────────┐ ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
│ 🔴 45          │ │ 🟡 125         │ │ 💰 $125,450    │ │ 🕐 2026-02-04  │
│ Critical 風險項│ │ 3 buckets 內   │ │ Total Profit   │ │ 資料批次時間   │
│ 總計 1180 料號 │ │ CRITICAL +     │ │ at Risk        │ │ ✓ 資料已同步   │
│                │ │ WARNING        │ │ Critical: $85K │ │                │
└────────────────┘ └────────────────┘ └────────────────┘ └────────────────┘
```

### RiskTable（新增 Profit at Risk 列）
```
| 料号      | 工厂  | 状态 | Net available | Gap qty | Next bucket | Profit at Risk | 操作 |
|-----------|-------|------|---------------|---------|-------------|----------------|------|
| PART-A101 | TW01  | 🔴  |      250      |   50    |   2026-W06  |    $1,250~     |  ⓘ  |
| PART-B202 | CN01  | 🔴  |      100      |   30    |     N/A     |      $750      |  ⓘ  |
| PART-C303 | US01  | 🟡  |      150      |   10    |   2026-W07  |      $100~     |  ⓘ  |
```

**符号说明：**
- `~` 表示使用 assumption（黄色标示）
- 无符号表示使用真实 financials

### DetailsPanel（新增 Section 5）
```
┌─ Profit at Risk（貨幣化）────────────────┐
│ [~ Assumption] ← 黄色标签                │
│                                           │
│ Profit per unit            $10           │
│ Exposure qty                50           │
│ ────────────────────────────────────────│
│ Profit at Risk          $500             │
│ ────────────────────────────────────────│
│ profitAtRisk = max(0, gapQty) * profitPerUnit │
└──────────────────────────────────────────┘
```

**标签颜色：**
- `[✓ Real financials]` - 绿色
- `[~ Assumption]` - 黄色
- `[⚠ Missing financials]` - 灰色

### 蓝色提示框（追加说明）
```
Supply Coverage Risk (Bucket-Based)

• Horizon: 3 buckets（約 3 週）
• Data source: Open PO + Inventory snapshots + FG financials
• Limitation: Stockout date/Days to stockout require demand/usage/forecast data
• Profit at Risk: Using real financials for 5 items, Assumption: $10/unit for others
```

---

## 📈 修正前后对比

### Before（M1 - 只有 Supply Coverage）
```
KPI: Critical count, Warning count, Shortage, $0
表格: 料号, 工厂, 状态, Net available, Gap qty, Next bucket, 操作
```

### After（M2 - 加入 Profit at Risk）
```
KPI: Critical count, Warning count, Shortage, $125,450 (Total Profit at Risk)
表格: 料号, 工厂, 状态, Net available, Gap qty, Next bucket, Profit at Risk, 操作
DetailsPanel: 新增 Section 5 - Profit at Risk（含公式与来源标签）
```

---

## 🎯 Demo 场景

### 场景 1: 有真实 FG Financials
```
1. 上传 fg_financials.xlsx
2. 前往 Risk Dashboard
3. 看到：
   - KPI: Total Profit at Risk 显示真实金额
   - 蓝色提示框："Using real financials for X items"
   - 表格：部分行无 ~ 符号（使用真实数据）
   - DetailsPanel：显示 [✓ Real financials] 标签
```

### 场景 2: 无 FG Financials（使用 fallback）
```
1. 未上传 fg_financials.xlsx
2. 前往 Risk Dashboard
3. 看到：
   - KPI: Total Profit at Risk 显示基于 $10/unit 的估算
   - 蓝色提示框："Assumption: $10/unit (FG financials not loaded)"
   - 表格：所有行显示 ~ 符号
   - DetailsPanel：显示 [~ Assumption] 标签
```

### 场景 3: Sample Data 模式
```
1. 点击 "Load Sample Data"
2. 看到：
   - KPI: Total Profit at Risk 显示估算金额
   - 蓝色提示框："Assumption: $10/unit"
   - 表格：所有行显示 ~ 符号（Sample 无 financials）
```

---

## ✅ 驗收標準

### 功能验收
- [x] 加载 FG Financials（如果有）
- [x] 计算 Profit at Risk（domain 层）
- [x] KPI 显示 Total Profit at Risk
- [x] 表格显示 Profit at Risk 列
- [x] DetailsPanel 显示 Profit at Risk 区块
- [x] 支持真实 financials 与 fallback
- [x] UI 明确标示数据来源

### 透明度验收
- [x] 蓝色提示框追加 assumption 说明
- [x] 表格使用 assumption 的行显示 `~`
- [x] DetailsPanel 显示来源标签（REAL/ASSUMPTION/MISSING）
- [x] DetailsPanel 显示计算公式
- [x] Missing 时显示 $0 并说明

### 技术验收
- [x] 不新增 npm 依赖
- [x] 不改旧 Views
- [x] UI 层不写计算公式（domain 内）
- [x] 保持 diagnostics / 模式互斥 / bucket-based 逻辑
- [x] 无 linter 错误

---

## 🎉 M2 完成

### 交付成果
- ✅ Profit at Risk 计算器（pure function）
- ✅ KPI 显示总金额
- ✅ 表格显示每行金额
- ✅ DetailsPanel 显示明细与公式
- ✅ 支持真实 financials 与 fallback
- ✅ 透明的数据来源标示

### 业务价值
- 💰 **货币化风险**：将库存风险转换为利润损失
- 📊 **可量化决策**：优先处理 Profit at Risk 高的项目
- 🎯 **透明可信**：清楚标示数据来源与假设

### Demo 准备度
- 🚀 **Always Demo-able**：即使无 financials，也有可解释的 fallback
- 📈 **Progressive Enhancement**：有 financials 时自动升级为真实数据
- 💡 **Self-explanatory**：UI 明确说明假设与限制

---

**实现完成时间：** 2026-02-04  
**版本：** M2 - Profit at Risk  
**测试状态：** ✅ 通过 linter 检查  
**Demo 状态：** ✅ Ready for demo
