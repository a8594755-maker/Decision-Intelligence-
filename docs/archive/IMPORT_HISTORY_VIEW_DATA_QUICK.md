# Import History - View Data 快速指南

## 🎯 快速摘要

在 Import History 頁面新增「View Data」功能，讓使用者可以查看、篩選和分頁瀏覽每次上傳的資料。

## ✅ 修改的檔案

1. **`src/services/importHistoryService.js`** - 新增 `getBatchDataWithFilters()` 方法
2. **`src/components/ViewDataModal.jsx`** - 新建 Modal 元件（支援篩選、分頁、錯誤處理）
3. **`src/views/ImportHistoryView.jsx`** - 整合 View Data 按鈕和 Modal
4. **`database/add_batch_id_indexes.sql`** - 新建索引優化 SQL

## 🚀 立即使用

### 步驟 1：執行資料庫 Migration

在 **Supabase SQL Editor** 中執行：

```sql
-- 檔案：database/add_batch_id_indexes.sql

CREATE INDEX IF NOT EXISTS idx_bom_edges_user_batch
  ON bom_edges(user_id, batch_id);

CREATE INDEX IF NOT EXISTS idx_demand_fg_user_batch
  ON demand_fg(user_id, batch_id);
```

### 步驟 2：前端使用

1. 進入 **Import History** 頁面
2. 找到任一批次記錄
3. 點擊綠色 **Database 圖標**（View Data 按鈕）
4. 在 Modal 中：
   - 點擊「顯示篩選」展開篩選器
   - 輸入篩選條件（支援模糊搜尋）
   - 使用底部按鈕翻頁（每頁 100 筆）

## 📊 功能特性

| 功能 | 說明 |
|------|------|
| **智慧查詢** | 根據 `batch.target_table` 自動決定查哪張表 |
| **動態篩選** | bom_edges: parent/child/plant<br>demand_fg: material/plant/time_bucket |
| **分頁** | Server-side pagination，每頁 100 筆 |
| **錯誤處理** | 顯示完整 Supabase error.message/details |
| **效能優化** | 使用複合索引 (user_id, batch_id) |

## 🔍 支援的表格

| 表格 | 篩選欄位 |
|------|----------|
| `bom_edges` | parent_material, child_material, plant_id |
| `demand_fg` | material_code, plant_id, time_bucket |
| `goods_receipts` | material_code, supplier_name, plant_id |
| `price_history` | material_code, supplier_name, plant_id |
| `suppliers` | supplier_code, supplier_name |
| `bom_explosion` | material_code, plant_id |

## 🎨 UI 位置

```
Import History 頁面
└─ Batches Table
   └─ 操作欄
      ├─ 🗄️ View Data 按鈕（新）← 綠色 Database 圖標
      ├─ 👁️ 預覽按鈕（原有）
      └─ ↩️ 撤銷按鈕（原有）
```

## 💡 使用範例

### 範例 1：查看 BOM 批次資料

```
1. 找到 upload_type = 'bom_edge' 的批次
2. 點擊 View Data 按鈕
3. 在篩選器中：
   - Parent Material: "FG001"
   - Plant ID: "P01"
4. 點擊「下一頁」查看更多
```

### 範例 2：查看需求批次資料

```
1. 找到 upload_type = 'demand_fg' 的批次
2. 點擊 View Data 按鈕
3. 在篩選器中：
   - Material Code: "FG"
   - Time Bucket: "2026-W05"
4. 瀏覽所有符合條件的資料
```

## ⚠️ 注意事項

1. **必須先執行 SQL migration**，建立索引以確保查詢效能
2. 篩選使用 `ILIKE` 模糊搜尋，支援部分匹配
3. 每頁固定顯示 100 筆，適合大批次資料
4. 錯誤訊息會完整顯示，方便除錯

## 📖 詳細文檔

完整的實作說明和測試建議請參考：
- **`IMPORT_HISTORY_VIEW_DATA.md`**

---

**狀態**：✅ 已完成  
**日期**：2026-01-30
