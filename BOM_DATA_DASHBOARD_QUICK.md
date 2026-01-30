# BOM Data Dashboard - 快速指南

## 🎯 快速摘要

新增 BOM Data Dashboard 頁面，提供簡潔的 Tab 介面查看和搜尋 BOM Edges 和 Demand FG 資料。

## ✅ 新增/修改檔案

1. **`src/views/BOMDataView.jsx`** ✅ (新檔案) - 完整的 Dashboard 元件
2. **`src/App.jsx`** ✅ - 添加路由和導航配置

## 🚀 立即使用

### 訪問頁面

**方式 1：導航列**
```
導航列 → Data 下拉選單 → BOM Data
```

**方式 2：首頁卡片**
```
首頁 → Data Management → BOM Data Dashboard
```

## 📊 功能特性

| 功能 | 說明 |
|------|------|
| **雙 Tab** | BOM Edges / Demand FG 切換 |
| **預設排序** | created_at DESC（最新優先） |
| **動態篩選** | 根據 Tab 顯示不同搜尋欄位 |
| **分頁** | Server-side pagination，每頁 100 筆 |
| **UI** | 最小可用設計，無複雜圖表 |

## 🔍 搜尋條件

### BOM Edges Tab
- `batch_id` - 批次 ID
- `plant_id` - 工廠代碼
- `parent_material` - 父件料號
- `child_material` - 子件料號

### Demand FG Tab
- `batch_id` - 批次 ID
- `plant_id` - 工廠代碼
- `material_code` - 料號
- `time_bucket` - 時間桶

## 💡 使用範例

### 範例 1：查看所有 BOM

```
1. 進入 BOM Data Dashboard
2. 預設在 BOM Edges Tab
3. 查看前 100 筆最新資料
```

### 範例 2：搜尋特定料號

```
1. 切換到 Demand FG Tab
2. 在 "Material Code" 輸入：FG001
3. 在 "Time Bucket" 輸入：2026-W
4. 查看結果並翻頁
```

### 範例 3：查看特定批次

```
1. 在任一 Tab
2. 在 "Batch ID" 輸入：batch-123
3. 查看該批次的所有資料
```

### 範例 4：清除篩選

```
點擊篩選器右上角的 "清除篩選" 按鈕
```

## 🎨 UI 結構

```
BOM Data Dashboard
├─ Header（標題 + 重新整理）
├─ Tabs（BOM Edges / Demand FG + 資料筆數）
├─ Filters（4 個搜尋欄位，可摺疊）
├─ Data Table（最多 12 欄）
└─ Pagination（上一頁 / 頁碼 / 下一頁）
```

## 📝 技術細節

### SQL 查詢邏輯

```javascript
// Supabase 查詢範例
supabase
  .from('bom_edges')
  .select('*', { count: 'exact' })
  .eq('user_id', userId)
  .ilike('parent_material', '%FG%')  // 模糊搜尋
  .order('created_at', { ascending: false })
  .range(0, 99);  // 前 100 筆
```

### 分頁計算

```javascript
const offset = (currentPage - 1) * itemsPerPage;
const totalPages = Math.ceil(totalCount / itemsPerPage);
const startItem = offset + 1;
const endItem = Math.min(currentPage * itemsPerPage, totalCount);
```

## 🔧 導航配置

### 導航列位置

```
Data 下拉選單
├─ BOM Data ← 新增
├─ External Systems
├─ Import History
├─ Data Integration
└─ Supplier Management
```

### 首頁位置

```
Data Management 區塊（5 個卡片）
├─ BOM Data Dashboard ← 新增
├─ Supplier Management
├─ External Systems
├─ Import History
└─ AI Decision Assistant
```

## ⚡ 效能優化

### 建議索引（如果需要）

```sql
-- bom_edges
CREATE INDEX idx_bom_edges_user_created 
  ON bom_edges(user_id, created_at DESC);

-- demand_fg
CREATE INDEX idx_demand_fg_user_created 
  ON demand_fg(user_id, created_at DESC);
```

### 查詢效能

- Server-side pagination: 每次只載入 100 筆
- 支援大數據集: 可處理 10,000+ 筆資料
- ILIKE 模糊搜尋: 支援部分匹配

## 📖 完整文檔

詳細的實作說明和測試建議請參考：
- **`BOM_DATA_DASHBOARD.md`**

---

**狀態**：✅ 已完成  
**日期**：2026-01-30
