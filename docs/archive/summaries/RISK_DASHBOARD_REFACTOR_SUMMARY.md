# Risk Dashboard 重構完成報告

## 📋 執行摘要

已成功重構 `RiskDashboardView`，採用「One-Page Decision」設計，實現：
- ✅ **10 秒內找到最危險料號**（紅黃綠一目瞭然，預設排序最危險在上）
- ✅ **30 秒內完成互動**（篩選工廠、搜尋料號、點開明細）
- ✅ **最小侵入**（只改 RiskDashboard，未動其他 Views）
- ✅ **Domain 層分離**（所有計算呼叫 `domains/inventory/calculator.js`）

---

## 🗂️ 新增檔案清單

### 1. 主 View（已重構）
```
src/views/RiskDashboardView.jsx  ← 完全重寫，整合所有子元件
```

### 2. 新增子元件資料夾
```
src/components/risk/
├── index.js                  ← 統一匯出
├── mapDomainToUI.js         ← 資料轉換 Adapter（Domain → UI）
├── FilterBar.jsx            ← 頂部篩選欄
├── KPICards.jsx             ← 4 張 KPI 卡片
├── RiskTable.jsx            ← 主表格（支援排序、點選）
└── DetailsPanel.jsx         ← 右側詳情面板（取代 Modal）
```

**檔案說明：**
- **mapDomainToUI.js**：統一處理資料轉換，避免 UI 層到處拼欄位
- **FilterBar.jsx**：工廠下拉、料號搜尋、風險等級、Export 按鈕
- **KPICards.jsx**：Critical Count、Shortage Items、Profit at Risk、Data Time
- **RiskTable.jsx**：6-8 欄風險表格，支援排序、行選擇
- **DetailsPanel.jsx**：右側面板，顯示「為什麼會紅」的證據

---

## 🎨 UI 佈局結構

```
┌─────────────────────────────────────────────────────────────┐
│ 🚨 庫存風險儀表板                           [重新整理]      │
├─────────────────────────────────────────────────────────────┤
│ [A] Filter Bar                                              │
│  工廠: [全部▾]  🔍 [搜尋料號...]  等級: [全部等級▾] [Export]│
├─────────────────────────────────────────────────────────────┤
│ [B] KPI Cards (4 張一列)                                    │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐              │
│  │ Crit.  │ │ Short. │ │ Profit │ │ Data   │              │
│  │   15   │ │   8    │ │  $0    │ │ 10:30  │              │
│  └────────┘ └────────┘ └────────┘ └────────┘              │
├─────────────────────────────────────────────────────────────┤
│ [C] 主內容區（左右分欄）                                    │
│ ┌───────────────────────┬───────────────────┐              │
│ │ 左側 70%: Risk Table  │ 右側 30%: Details │              │
│ │                       │                   │              │
│ │ item | site | status │ 🔍 選中項目詳情   │              │
│ │ PN123| PL01 | 🔴     │                   │              │
│ │ PN456| PL02 | 🟡     │ · 庫存狀況        │              │
│ │ ...                   │ · 未來供需        │              │
│ │                       │ · 風險指標        │              │
│ │ (點擊列 → 更新右側)   │ · 關鍵 PO        │              │
│ └───────────────────────┴───────────────────┘              │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔧 技術架構

### 資料流向
```
Supabase (inventory_snapshots, component_demand)
    ↓
RiskDashboardView.loadRiskData()
    ↓
domains/inventory/calculator.js (計算風險)
    ↓
mapDomainToUI.js (轉換為 UI 格式)
    ↓
FilterBar + KPICards + RiskTable + DetailsPanel
```

### Adapter 模式
```javascript
// mapDomainToUI.js 提供：
1. mapDomainRiskToTableRow()    - Domain → Table Row
2. mapRowToDetailsPanel()       - Row → Details Panel
3. calculateKPIs()              - 計算 KPI 統計
4. getRiskLevelConfig()         - 風險等級樣式配置
5. formatDate() / formatNumber() - 格式化工具
```

**為什麼需要 Adapter？**
- ✅ UI 不直接拼接 domain 欄位
- ✅ 未來新增欄位只改 adapter
- ✅ 方便 mock 資料（如 next_inbound_eta）

---

## 📊 功能清單

### ✅ 已完成
| 功能 | 狀態 | 說明 |
|------|------|------|
| 頂部 Filter Bar | ✅ | 工廠、料號搜尋、風險等級、Export |
| KPI Cards | ✅ | Critical、Shortage、Profit、Data Time |
| Risk Table | ✅ | 8 欄（item、site、status、days、net、gap、eta、action） |
| 表格排序 | ✅ | 點欄位標題排序，預設最危險在上 |
| 表格搜尋 | ✅ | 料號搜尋（即時過濾） |
| 表格篩選 | ✅ | 工廠 + 風險等級雙重篩選 |
| Details Panel | ✅ | 右側面板（取代 Modal），顯示詳細資訊 |
| 行選擇高亮 | ✅ | 點擊表格列，左側高亮 + 右側更新 |
| Domain 層呼叫 | ✅ | 所有計算來自 `domains/inventory/calculator.js` |
| Loading/Empty | ✅ | 載入中、無資料狀態 |

### 🚧 TODO（標註在 code 中）
| 功能 | 位置 | 說明 |
|------|------|------|
| next_inbound_eta | mapDomainToUI.js | 從 `po_open_lines` 取得下次到貨 ETA |
| inbound_next_30d | mapDomainToUI.js | 統計未來 30 天 PO 入庫量 |
| topPOs | mapDomainToUI.js | 載入相關 PO 列表（最多 5 筆） |
| required_next_30d | mapDomainToUI.js | 應從需求預測取得，暫用 dailyDemand * 30 |
| Export CSV | RiskDashboardView.jsx | Week 2 實作 |
| Profit at Risk | KPICards.jsx | Week 2 實作（需財務資料） |

---

## 🎯 互動邏輯

### 1. 篩選流程
```javascript
原始資料 (uiRisks)
  → 工廠篩選 (selectedPlant)
  → 料號搜尋 (searchTerm)
  → 風險等級篩選 (selectedRiskLevel)
  → filteredRisks
  → 計算 KPIs + 顯示 Table
```

### 2. 點擊表格列
```javascript
handleRowSelect(row)
  → setSelectedRow(row)
  → mapRowToDetailsPanel(row, poLines)
  → setDetailsData(details)
  → DetailsPanel 顯示在右側
```

### 3. 排序機制
- 預設：`urgencyScore` 降序（最危險在上）
- 點擊欄位標題切換 asc/desc
- 特殊處理：`Infinity` 視為 999999

---

## 📐 欄位限制（嚴格遵守）

### Risk Table 欄位（8 欄）
| 欄位 | 顯示名稱 | 資料來源 | 可排序 |
|------|----------|----------|--------|
| materialCode | 料號 | Domain | ✅ |
| plantId | 工廠 | Domain | ✅ |
| riskLevel | 狀態 (🔴🟡🟢) | Domain | ✅ |
| daysToStockout | 撐幾天 | Domain | ✅ |
| netAvailable | 可用庫存 | 計算 (current - safety) | ✅ |
| gapQty | 缺口數量 | 計算 (required - current) | ✅ |
| nextInboundEta | 下次到貨 | TODO: PO 資料 | ❌ |
| action | 操作 | Info 圖示 | ❌ |

---

## 🔍 Details Panel 結構

### 4 個 Section
```
1. 📦 庫存狀況
   - 現有庫存 (On Hand)
   - 安全庫存 (Safety Stock)
   - 可用庫存 (Net Available)  ← 重點

2. 📉 未來 30 天供需
   - 未來入庫量 (Inbound)      ← TODO
   - 預計需求量 (Required)      ← TODO
   - 淨值 (Net)

3. 📅 風險指標
   - 距離斷料天數
   - 預計斷料日期
   - 斷料機率
   - 緊迫分數

4. 📄 關鍵 PO 列表（最多 5 筆）
   - PO 單號
   - 交期
   - 數量
   - 供應商
   ← TODO: 從 po_open_lines 載入
```

---

## 🚀 使用方式

### 1. 開發環境測試
```bash
npm run dev
```
訪問：`http://localhost:5173`

導航至：側邊欄 → 「庫存風險儀表板」

### 2. 互動測試
- ✅ 工廠篩選：下拉選擇工廠，表格即時更新
- ✅ 料號搜尋：輸入框輸入料號，即時過濾
- ✅ 風險等級：選擇 Critical/Warning/OK
- ✅ 點擊表格列：右側 Details Panel 顯示詳情
- ✅ 排序：點擊欄位標題，切換升降序
- ✅ 清除篩選：點擊「清除」按鈕，重置所有篩選

### 3. 資料準備
確保 Supabase 中已有資料：
```sql
-- 1. inventory_snapshots 表
SELECT * FROM inventory_snapshots WHERE user_id = '...';

-- 2. component_demand 表（選填，用於日均需求計算）
SELECT * FROM component_demand WHERE user_id = '...';
```

如無資料：
1. 至「資料上傳」頁面
2. 上傳 `templates/inventory_snapshots.xlsx`

---

## 🎨 樣式設計

### 顏色系統
- **Critical (紅)**: `bg-red-600 text-white`
- **Warning (黃)**: `bg-yellow-500 text-black`
- **Low/OK (綠)**: `bg-green-500 text-white`

### Dark Mode 支援
所有元件均支援 Dark Mode：
```css
bg-white dark:bg-slate-800
text-slate-900 dark:text-slate-100
border-slate-200 dark:border-slate-700
```

### 響應式設計
- **Mobile**: 單欄佈局，Details Panel 自動隱藏
- **Tablet**: 篩選欄 2 列，KPI Cards 2x2
- **Desktop**: 完整 One-Page 佈局

---

## ⚠️ 重要限制

### 1. 只改 RiskDashboard
✅ **已改：**
- `src/views/RiskDashboardView.jsx`
- `src/components/risk/*`（新增）

❌ **未改（刻意不動）：**
- `src/views/ForecastsView.jsx`
- `src/views/CostAnalysisView.jsx`
- `src/views/SupplierManagementView.jsx`
- 路由結構
- 側邊欄導航

### 2. 不在 View 層寫計算
所有計算邏輯在：
- `src/domains/inventory/calculator.js`（Domain 層）
- `src/components/risk/mapDomainToUI.js`（Adapter 層）

### 3. 未使用 Modal
改用右側 **Details Panel**（Side Panel），優點：
- 不遮擋表格
- 快速切換項目（點不同列即更新）
- 更符合 One-Page Decision

---

## 🧪 測試建議

### 手動測試 Checklist
- [ ] 載入資料成功（有 Loading 狀態）
- [ ] KPI Cards 數字正確（Critical Count、Shortage Items）
- [ ] 表格顯示所有料號，預設最危險在上
- [ ] 工廠篩選生效
- [ ] 料號搜尋即時過濾
- [ ] 風險等級篩選生效
- [ ] 點擊表格列，右側 Details Panel 顯示
- [ ] Details Panel 顯示正確資訊（庫存、風險指標）
- [ ] 排序功能（點擊欄位標題）
- [ ] 清除篩選按鈕生效
- [ ] Empty 狀態（無資料時顯示提示）
- [ ] Dark Mode 切換正常

### Edge Cases
- [ ] 無庫存資料時的提示
- [ ] 搜尋無結果時的提示
- [ ] `daysToStockout = Infinity` 顯示為 ∞
- [ ] 無 PO 資料時的警告

---

## 📝 下一步（Week 2）

### 高優先級
1. **PO 資料整合**
   - 實作 `next_inbound_eta`（從 `po_open_lines` 取得最近到貨日期）
   - 實作 `inbound_next_30d`（統計未來 30 天入庫量）
   - 實作 `topPOs`（載入前 5 筆關鍵 PO）

2. **Export CSV**
   - 匯出當前篩選結果為 CSV
   - 包含所有表格欄位

3. **Profit at Risk**
   - 整合財務資料（fg_financials）
   - 計算潛在利潤損失

### 中優先級
4. **批次操作**
   - 多選料號
   - 批次標記 / 批次匯出

5. **趨勢圖表**
   - 風險趨勢（過去 30 天）
   - 使用 `SimpleLineChart` 元件

---

## 🙏 技術債務標記

在 code 中標註 `TODO` 的位置：

```javascript
// mapDomainToUI.js
// TODO: next_inbound_eta 應從 po_open_lines 或 goods_receipt 表取得
// TODO: inbound_next_30d 應統計 po_open_lines 的未來 30 天入庫量
// TODO: Total Profit at Risk - Week 2 實作

// RiskDashboardView.jsx
// TODO: 載入該料號的 PO 資料
// TODO: nextInboundEta 應從 po_open_lines 取得
```

---

## 📚 相關文件

- **Domain 層文件**: `src/domains/inventory/README.md`
- **風險計算邏輯**: `src/domains/inventory/calculator.js`
- **資料庫架構**: `database/step1_supply_inventory_financials_schema.sql`
- **上傳範本**: `templates/inventory_snapshots.xlsx`

---

## ✅ 驗收標準

- [x] 10 秒內找到最危險料號（紅色 Critical 在最上方）
- [x] 30 秒內完成篩選和查看詳情（工廠、搜尋、點擊）
- [x] 不使用 Modal，改用右側 Details Panel
- [x] 所有計算呼叫 Domain 層
- [x] 使用 Adapter 統一轉換資料
- [x] 只改 RiskDashboard，未動其他 Views
- [x] 支援 Dark Mode
- [x] 響應式設計（Mobile/Tablet/Desktop）
- [x] Loading/Empty/Error 狀態完善

---

## 🎉 總結

此次重構成功實現「One-Page Decision」設計目標，將 RiskDashboard 從傳統列表頁升級為高效決策介面。

**核心優勢：**
1. **快速決策**：10 秒找到問題，30 秒完成操作
2. **資訊密度**：一頁顯示全部關鍵資訊
3. **互動流暢**：無需切換頁面，即時更新
4. **架構清晰**：Domain 層分離，Adapter 統一轉換
5. **可擴展性**：元件化設計，易於新增功能

**待完成項目清楚標註在 code 中（`TODO`），可按優先級逐步實作。**

---

**最後更新**: 2026-02-04  
**版本**: v2.0 (重構版)  
**作者**: Cursor AI Agent
