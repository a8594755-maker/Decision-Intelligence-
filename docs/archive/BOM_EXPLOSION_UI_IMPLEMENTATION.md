# BOM Explosion UI 實施指南

## 📋 實施摘要

本次實施在 Decision-Intelligence 應用中加入了 BOM Explosion 執行入口，允許使用者從 UI 觸發 BOM 展開計算，並整合到批次管理和撤銷機制中。

### 完成日期
2026-01-26

---

## 🎯 功能特性

### 1. **UI 執行入口**
- ✅ 位於 EnhancedExternalSystemsView（資料上傳頁面）
- ✅ 可摺疊的 Card 區塊，不干擾現有上傳流程
- ✅ 支援篩選條件：
  - Plant ID（可留空選擇全部工廠）
  - Time Buckets（可輸入多個，逗號分隔，或留空選擇全部）

### 2. **執行流程**
1. 使用者輸入篩選條件（可選）
2. 點擊「執行 BOM Explosion」按鈕
3. 系統自動：
   - Fetch `demand_fg` 資料
   - Fetch `bom_edges` 資料
   - 執行 BOM Explosion 計算
   - 建立 `import_batches` 記錄
   - 寫入 `component_demand` 和 `component_demand_trace`
   - 更新批次狀態為 `completed`

### 3. **結果顯示**
- ✅ Component 需求數量
- ✅ 追溯記錄數量
- ✅ 錯誤/警告數量
- ✅ 執行狀態（成功/有警告）
- ✅ 批次 ID（可在 Import History 查看）
- ✅ 可展開查看詳細錯誤/警告訊息

### 4. **批次管理整合**
- ✅ 自動建立 `import_batches` 記錄（`target_table='bom_explosion'`）
- ✅ 在 Import History 頁面可見
- ✅ 支援 Undo 復原功能
- ✅ Undo 時分別顯示 `component_demand` 和 `trace` 的刪除數量

---

## 📂 修改的檔案

### 1. **前端檔案**

#### `src/views/EnhancedExternalSystemsView.jsx`
**修改內容**：
- 加入 BOM Explosion 相關狀態變數
- 加入 `handleBomExplosion()` 執行函數
- 加入 UI 區塊（摺疊式 Card）
- 支援 loading 狀態和錯誤提示

**關鍵功能**：
```javascript
// 執行 BOM Explosion
const handleBomExplosion = async () => {
  // 1. Fetch demand_fg
  // 2. Fetch bom_edges
  // 3. Execute BOM Explosion
  // 4. Display results
}
```

#### `src/services/bomExplosionService.js`
**修改內容**：
- 更新 `executeBomExplosion()` 函數
- 整合 `import_batches` 建立和更新邏輯
- 返回 `batchId` 供前端使用

**關鍵修改**：
- 如果未提供 `batchId`，自動建立新的批次記錄
- 執行完成後更新批次狀態為 `completed`
- 在 metadata 中記錄詳細統計資訊

#### `src/services/importHistoryService.js`
**修改內容**：
- 更新 `getBatchData()` 函數
- 加入 `bom_explosion` case，查詢 `component_demand` 資料

---

### 2. **資料庫檔案**

#### `database/add_bom_explosion_batch_support.sql`（新增）
**內容**：
1. 更新 `undo_import_batch()` 函數
   - 加入 `bom_explosion` case
   - 先刪除 `component_demand_trace`（有 FK 約束）
   - 再刪除 `component_demand`
   - 返回詳細刪除統計

2. 確認欄位存在
   - 檢查 `component_demand.batch_id`
   - 檢查 `component_demand_trace.batch_id`
   - 如果不存在則自動建立

**執行方式**：
```bash
# 連接到 Supabase 資料庫
psql -U postgres -h <your-supabase-host> -d postgres -f database/add_bom_explosion_batch_support.sql

# 或在 Supabase Dashboard 的 SQL Editor 中執行
```

---

## 🚀 部署步驟

### Step 1: 執行資料庫 Patch
```bash
cd c:\Users\a8594\decision-intelligence
psql -U postgres -h <your-supabase-host> -d postgres -f database/add_bom_explosion_batch_support.sql
```

或在 Supabase Dashboard → SQL Editor 中直接執行 `add_bom_explosion_batch_support.sql` 的內容。

### Step 2: 確認前端檔案已更新
- ✅ `src/views/EnhancedExternalSystemsView.jsx`
- ✅ `src/services/bomExplosionService.js`
- ✅ `src/services/importHistoryService.js`

### Step 3: 測試流程

#### 測試前置條件
1. 確保已上傳 `demand_fg` 資料
2. 確保已上傳 `bom_edge` 資料

#### 測試步驟
1. 前往 External Systems（資料上傳頁面）
2. 在頂部找到「BOM Explosion 計算」區塊
3. 點擊「展開」按鈕
4. 輸入篩選條件（可選）：
   - Plant ID: `P001`（或留空）
   - Time Buckets: `2026-W01, 2026-W02`（或留空）
5. 點擊「執行 BOM Explosion」
6. 等待計算完成（會顯示 loading 狀態）
7. 查看結果統計

#### 驗證結果
- ✅ 顯示 Component 需求數量
- ✅ 顯示追溯記錄數量
- ✅ 顯示批次 ID
- ✅ 前往 Import History 頁面
- ✅ 找到 `bom_explosion` 類型的批次記錄
- ✅ 點擊 Undo 測試復原功能
- ✅ 確認資料被正確刪除

---

## 💡 使用範例

### 範例 1: 執行全部工廠的全部時間範圍
```
Plant ID: (留空)
Time Buckets: (留空)
```
→ 計算所有工廠、所有時間的 BOM Explosion

### 範例 2: 執行特定工廠的特定週次
```
Plant ID: P001
Time Buckets: 2026-W01, 2026-W02, 2026-W03
```
→ 只計算 P001 工廠在 2026 年第 1-3 週的 BOM Explosion

### 範例 3: 執行特定工廠的全部時間
```
Plant ID: P002
Time Buckets: (留空)
```
→ 計算 P002 工廠的所有時間範圍

---

## 🔍 Undo 功能說明

### Undo 執行邏輯
當使用者在 Import History 頁面點擊 Undo：

1. 系統呼叫 `undo_import_batch(batch_id, user_id)`
2. 函數檢查 `target_table='bom_explosion'`
3. 執行刪除操作：
   ```sql
   -- 先刪除 trace（因為有 FK 約束）
   DELETE FROM component_demand_trace WHERE batch_id = ?
   
   -- 再刪除 demand
   DELETE FROM component_demand WHERE batch_id = ?
   ```
4. 更新批次狀態為 `undone`

### Undo 返回格式
```json
{
  "success": true,
  "batch_id": "uuid-xxx",
  "deleted_count": 250,
  "target_table": "bom_explosion",
  "details": {
    "component_demand_count": 50,
    "component_demand_trace_count": 200
  }
}
```

---

## 📊 資料流圖

```
使用者 → 輸入篩選條件
   ↓
前端 → fetch demand_fg (demandFgService.fetchDemandFg)
   ↓
前端 → fetch bom_edges (bomEdgesService.fetchBomEdges)
   ↓
前端 → executeBomExplosion(userId, null, demandRows, bomRows, options)
   ↓
後端 → createBatch (建立 import_batches 記錄)
   ↓
後端 → calculateBomExplosion (執行計算邏輯)
   ↓
後端 → upsertComponentDemand (寫入 component_demand)
   ↓
後端 → insertComponentDemandTrace (寫入 component_demand_trace)
   ↓
後端 → updateBatch (更新批次狀態為 completed)
   ↓
前端 ← 返回 { success, componentDemandCount, traceCount, errors, batchId }
   ↓
使用者 ← 顯示結果統計和批次 ID
```

---

## ⚠️ 注意事項

### 1. **資料庫權限**
確保執行 SQL patch 的使用者有以下權限：
- `CREATE OR REPLACE FUNCTION`
- `ALTER TABLE`
- `CREATE INDEX`

### 2. **前置資料要求**
執行 BOM Explosion 前必須：
- ✅ 上傳 `demand_fg` 資料（至少 1 筆）
- ✅ 上傳 `bom_edge` 資料（至少 1 筆）

否則會顯示錯誤訊息：
- "找不到 FG 需求資料..."
- "找不到 BOM 關係資料..."

### 3. **效能考量**
- 大量資料（>10,000 筆 FG 需求）可能需要較長執行時間
- 建議先使用篩選條件進行小範圍測試
- Loading 狀態會顯示「計算中...」

### 4. **錯誤處理**
常見錯誤類型：
- `NO_INPUT`: 沒有 FG 需求資料
- `NO_BOM`: 沒有 BOM 關係資料
- `BOM_CYCLE`: 檢測到 BOM 循環引用
- `MISSING_BOM`: 找不到某個料號的 BOM 定義
- `OVERLAP_EFFECTIVITY`: 時效性重疊警告

---

## 🎨 UI 截圖說明

### 執行前（摺疊狀態）
```
┌─────────────────────────────────────────┐
│ ▶ BOM Explosion 計算              [展開] │
│   將 FG 需求展開為 Component 需求        │
└─────────────────────────────────────────┘
```

### 執行中（展開狀態）
```
┌─────────────────────────────────────────┐
│ ▼ BOM Explosion 計算              [收起] │
├─────────────────────────────────────────┤
│ Plant ID: [P001        ]  (留空=全部)    │
│ Time Buckets: [2026-W01, W02] (留空=全部)│
│                                          │
│        [⚡ 執行 BOM Explosion]           │
│                                          │
│ 🔄 計算中...                             │
└─────────────────────────────────────────┘
```

### 執行完成（成功）
```
┌─────────────────────────────────────────┐
│ ▼ BOM Explosion 計算              [收起] │
├─────────────────────────────────────────┤
│ ┌────┬────┬────┬────┐                   │
│ │ 50 │200 │ 0  │ ✓  │                   │
│ │需求│追溯│警告│成功│                   │
│ └────┴────┴────┴────┘                   │
│                                          │
│ ✓ BOM Explosion 執行成功                 │
│   已產生 50 筆 Component 需求和 200 筆   │
│   追溯記錄。                             │
│   批次 ID: abc-123-def                   │
│   💡 您可以在 Import History 頁面查看    │
└─────────────────────────────────────────┘
```

---

## 🧪 測試案例

### Test Case 1: 正常執行
**前置條件**：
- 有 5 筆 `demand_fg`
- 有 20 筆 `bom_edge`

**執行**：
- Plant ID: 留空
- Time Buckets: 留空

**預期結果**：
- ✅ 成功執行
- ✅ 產生 Component 需求
- ✅ 產生追溯記錄
- ✅ 批次記錄建立在 Import History

### Test Case 2: 無資料錯誤
**前置條件**：
- 沒有 `demand_fg` 資料

**執行**：
- 點擊執行

**預期結果**：
- ❌ 顯示錯誤訊息
- ❌ "找不到 FG 需求資料..."

### Test Case 3: Undo 功能
**前置條件**：
- 已成功執行一次 BOM Explosion

**執行**：
- 前往 Import History
- 找到 `bom_explosion` 批次
- 點擊 Undo

**預期結果**：
- ✅ 資料被刪除
- ✅ 批次狀態變為 `undone`
- ✅ 顯示刪除統計

---

## 🔗 相關文件

- [BOM_EXPLOSION_SPEC.md](./BOM_EXPLOSION_SPEC.md) - BOM Explosion MVP 規格
- [IMPORT_HISTORY_GUIDE.md](./IMPORT_HISTORY_GUIDE.md) - Import History 使用指南
- [database/bom_forecast_schema.sql](./database/bom_forecast_schema.sql) - BOM 資料表結構

---

## 📞 支援

如有問題，請參考：
1. Console 錯誤訊息（F12 開發者工具）
2. Supabase Dashboard 的 Table Editor
3. Import History 頁面的批次詳情

---

**實施完成！** 🎉
