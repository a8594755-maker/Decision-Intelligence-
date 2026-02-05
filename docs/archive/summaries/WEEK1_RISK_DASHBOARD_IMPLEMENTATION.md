# Week 1 Risk Dashboard 實現總結

## 🎯 目標達成

使用「Supply Coverage Risk」實現 Risk Dashboard：只根據 Open PO（可選 Inventory）判斷未來 30 天供應覆蓋風險。

## ✅ 交付清單

### 交付 1：Domain 純函數
**新增檔案：** `src/domains/risk/coverageCalculator.js`

#### 功能：
- `calculateSupplyCoverageRisk()` - 計算單一 Item/Factory 的供應覆蓋風險
- `calculateSupplyCoverageRiskBatch()` - 批量計算多個 Item/Factory 組合
- `generateSampleData()` - 生成測試用 Sample Data（20 筆，至少 3 條 CRITICAL、5 條 WARNING）

#### 輸入：
- **openPOs**（必需）：數組，至少含 `item/material_code`, `factory/site`, `eta`, `qty`
- **inventorySnapshots**（可選）：含 `item`, `factory`, `on_hand`

#### 輸出（domainResult）：
```javascript
{
  item: string,
  factory: string,
  horizonDays: 30,
  inboundCountNext30: number,
  inboundQtyNext30: number,
  nextInboundEta: string | null,
  daysUntilNextInbound: number | null,
  currentStock: number,
  status: 'CRITICAL' | 'WARNING' | 'OK',
  reason: string,
  poDetails: Array<{ eta, qty, poNumber }> // Top 5
}
```

#### 風險規則（固定）：
- **CRITICAL**：未來 30 天 `inboundCountNext30 === 0`
- **WARNING**：
  - `inboundCountNext30 > 0` 但 `nextInboundEta` 距離今天 > 14 天，或
  - `inboundCountNext30 === 1`（僅 1 次入庫）
- **OK**：其他情況

---

### 交付 2：UI Adapter
**修改檔案：** `src/components/risk/mapDomainToUI.js`

#### 新增函數：
- `mapSupplyCoverageToUI(domainResult, warnings)` - 將 Domain 結果轉換為 UI 格式

#### 輸出（uiRow）：
```javascript
{
  // 識別
  id: string,
  item: string,
  plantId: string,
  
  // 風險指標
  riskLevel: 'critical' | 'warning' | 'low',
  status: 'CRITICAL' | 'WARNING' | 'OK',
  reason: string,
  urgencyScore: number,
  
  // Supply Coverage 專屬
  inboundCount: number,
  inboundQty: number,
  nextInboundEta: string | null,
  daysUntilNextInbound: number | null,
  poDetails: Array<{ eta, qty, poNumber }>,
  
  // 庫存狀況
  onHand: number,
  currentStock: number,
  
  // 向後兼容（為舊組件）
  safetyStock: 0,
  netAvailable: number,
  daysToStockout: number | Infinity,
  // ...
}
```

#### 容錯處理：
- 缺少 `item` 時顯示 `(unknown)`，並推入 `warnings` 數組
- 自動正規化料號與工廠代碼（去空格、轉大寫）

---

### 交付 3：RiskDashboardView 可用版
**修改檔案：** `src/views/RiskDashboardView.jsx`

#### A) Filter Bar
- Factory 選擇下拉
- Item 搜索框
- Status 篩選（All / Critical / Warning / OK）
- Export 按鈕（目前 disabled）
- 清除篩選按鈕

#### B) KPI Cards
- **Critical Count**：CRITICAL 風險項數量
- **Shortage within Horizon**：30 天內斷料數量
- **Profit at Risk**：0（Coming Week 2）
- **Snapshot Time**：資料批次時間

#### C) 表格
- 默認排序：CRITICAL → WARNING → OK，再按 `nextInboundEta`
- 顯示欄位：料號、工廠、狀態、Days to stockout、Net available、Gap qty、Next inbound ETA、操作
- 支援點擊行選取

#### D) 右側詳情欄
點擊行時顯示：
- **風險警示**：為什麼是 Critical/Warning（原因列表）
- **庫存狀況**：On hand、Safety stock、Net available
- **未來 30 天供需**：Inbound qty、Required、Net
- **風險指標**：Days to stockout、Shortage date、Gap qty、Probability
- **未來 30 天內 PO 明細（Top 5）**：
  - PO 統計摘要（Inbound count、Total qty、Next ETA）
  - PO 列表（每條含 PO Number、ETA、Qty）
  - 無 PO 時顯示警告

---

### 交付 4：Sample Data 功能
**新增功能：** "Load Sample Data" 按鈕

#### 特性：
- 點擊後生成 20 條測試資料
- 確保至少 3 條 CRITICAL、5 條 WARNING
- 顯示【Sample Data 模式】標籤
- 用於快速展示完整交互

#### Sample Data 組成：
- 10 個料號（PART-A101 ~ PART-J1010）
- 4 個工廠（FAC-TW01、FAC-CN01、FAC-US01、FAC-JP01）
- 隨機庫存快照（100-600 件）
- 隨機 Open PO（ETA 分佈在未來 1-30 天）

---

## 🚫 已遵守的禁止事項

✅ **未修改任何舊 Views**（ForecastsView、CostAnalysisView、SupplierManagementView 等）  
✅ **未新增 npm 依賴**（npm install 0 次）  
✅ **UI 層無計算公式**（全部在 `domains/risk/coverageCalculator.js`）  
✅ **未重構路由/側邊欄**  

---

## 📂 修改/新增檔案清單

### 新增檔案（1 個）
1. `src/domains/risk/coverageCalculator.js` - Domain 層純函數

### 修改檔案（3 個）
1. `src/components/risk/mapDomainToUI.js` - 新增 `mapSupplyCoverageToUI()` adapter
2. `src/views/RiskDashboardView.jsx` - 完全重構，使用 Supply Coverage Risk 邏輯
3. `src/components/risk/DetailsPanel.jsx` - 顯示 PO Top 5 明細

---

## 🎬 Demo 流程

### 情境 1：使用真實資料
1. 上傳 `po_open_lines.xlsx`（必需）
2. 上傳 `inventory_snapshots.xlsx`（選填）
3. 前往 Risk Dashboard
4. 查看 KPI Cards、篩選、排序
5. 點擊任一行查看詳細資訊（含 PO Top 5）

### 情境 2：使用 Sample Data（無真實資料時）
1. 前往 Risk Dashboard
2. 點擊 "Load Sample Data" 按鈕
3. 立即看到 20 條測試資料（3+ CRITICAL、5+ WARNING）
4. 進行完整 UI 交互測試

---

## 🔧 技術細節

### 資料流
```
Open PO + Inventory
  ↓
calculateSupplyCoverageRiskBatch() (Domain)
  ↓
domainResults (Array)
  ↓
mapSupplyCoverageToUI() (Adapter)
  ↓
uiRows (單一資料來源)
  ↓
KPI Cards / Table / Details (UI)
```

### 風險計算邏輯
```javascript
// 1. 篩選該 item/factory 在未來 30 天內的 PO
const relevantPOs = openPOs.filter(po => 
  matchItem(po) && matchFactory(po) && withinHorizon(po.eta)
);

// 2. 統計
const inboundCountNext30 = relevantPOs.length;
const inboundQtyNext30 = sum(relevantPOs, 'qty');
const nextInboundEta = min(relevantPOs, 'eta');

// 3. 判定風險
if (inboundCountNext30 === 0) {
  status = 'CRITICAL';
} else if (daysUntilNextInbound > 14 || inboundCountNext30 === 1) {
  status = 'WARNING';
} else {
  status = 'OK';
}
```

### 容錯設計
- 支援多種欄位名稱（`item` / `material_code` / `material` / `part_no`）
- 自動正規化（去空格、轉大寫）
- 日期解析失敗時回傳 `null`
- 缺少 item 時顯示 `(unknown)` 並記錄警告

---

## 📊 Demo 資料範例

### Sample Data 包含：
- **3+ CRITICAL**：前 3 條無任何 PO
- **5+ WARNING**：
  - 3 條：nextInboundEta > 14 天
  - 2 條：僅 1 次入庫（< 14 天）
- **其餘 OK**：多次入庫且在 14 天內

---

## ✨ 下一步（Week 2）

- 實現 Export CSV 功能
- 加入 Profit at Risk 計算（需 FG Financials）
- 整合真實 Forecast 資料（可選）
- 加入趨勢圖表（歷史風險走勢）

---

## 🎉 完成標誌

- [x] Domain 純函數（coverageCalculator.js）
- [x] UI Adapter（mapSupplyCoverageToUI）
- [x] RiskDashboardView 可用版（含 Filter、KPI、Table、Details）
- [x] Sample Data 按鈕（Load Sample Data）
- [x] PO Top 5 明細顯示
- [x] 無 linter 錯誤
- [x] 完全不依賴 Forecast/PR 資料

---

**實現完成時間：** 2026-02-04  
**版本：** Week 1 Demo Version  
**計算邏輯：** Supply Coverage Risk（純 PO 導向）
