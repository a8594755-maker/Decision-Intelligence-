# Supabase Services API Reference - 快速參考

## 📋 三個新增 Service 的 Public API

---

## 1️⃣ poOpenLinesService

### Methods

```javascript
// 批量插入（含 upsert）
batchInsert(userId, rows, batchId = null)
  → { success, count, data }

// 根據條件查詢（供 forecast/risk 引擎使用）
fetchByFilters(userId, {
  plantId,           // string | null (null = all plants)
  timeBuckets,       // Array | null (null = all time)
  materialCode,      // string (optional)
  poNumber,          // string (optional)
  supplierId,        // string (optional)
  status,            // string (optional)
  limit,             // number (default: 1000)
  offset             // number (default: 0)
})
  → Array<POOpenLine>

// 批次刪除（支援 undo）
deleteByBatch(batchId)
  → { success, count }

// 通用查詢
getPoOpenLines(userId, {
  plantId,
  materialCode,
  startTimeBucket,
  endTimeBucket,
  limit,             // number (default: 100)
  offset             // number (default: 0)
})
  → Array<POOpenLine>
```

### UNIQUE 約束
```
(user_id, po_number, po_line, time_bucket)
```

---

## 2️⃣ inventorySnapshotsService

### Methods

```javascript
// 批量插入（含 upsert）
batchInsert(userId, rows, batchId = null)
  → { success, count, data }

// 根據條件查詢
fetchByFilters(userId, {
  plantId,           // string | null (null = all plants)
  materialCode,      // string (optional)
  snapshotDate,      // string YYYY-MM-DD (optional)
  startDate,         // string YYYY-MM-DD (optional)
  endDate,           // string YYYY-MM-DD (optional)
  limit,             // number (default: 1000)
  offset             // number (default: 0)
})
  → Array<InventorySnapshot>

// 批次刪除（支援 undo）
deleteByBatch(batchId)
  → { success, count }

// 獲取最新快照
getLatestSnapshot(userId, materialCode, plantId)
  → InventorySnapshot | null

// 通用查詢
getInventorySnapshots(userId, {
  plantId,
  materialCode,
  snapshotDate,
  limit,             // number (default: 100)
  offset             // number (default: 0)
})
  → Array<InventorySnapshot>
```

### UNIQUE 約束
```
(user_id, material_code, plant_id, snapshot_date)
```

---

## 3️⃣ fgFinancialsService ⭐

### Methods

```javascript
// 批量插入（含 upsert fallback）
batchInsert(userId, rows, batchId = null)
  → { success, count, data }

// 根據條件查詢（含 plant fallback 邏輯）
fetchByFilters(userId, {
  plantId,           // string | null (null = all plants)
  materialCode,      // string (optional)
  currency,          // string (optional)
  validDate,         // string YYYY-MM-DD (optional)
  usePlantFallback,  // boolean (default: true) ⭐
  limit,             // number (default: 1000)
  offset             // number (default: 0)
})
  → Array<FgFinancial>

// 批次刪除（支援 undo）
deleteByBatch(batchId)
  → { success, count }

// 單筆查詢（含 fallback）
getFgFinancial(userId, materialCode, plantId = null, currency = 'USD')
  → FgFinancial | null

// 通用查詢
getFgFinancials(userId, {
  plantId,           // string | null
  materialCode,      // string (optional)
  currency,          // string (optional)
  limit,             // number (default: 100)
  offset             // number (default: 0)
})
  → Array<FgFinancial>
```

### UNIQUE 約束
```
UNIQUE INDEX on (
  user_id, 
  material_code, 
  COALESCE(plant_id, ''), 
  currency, 
  COALESCE(valid_from, '1900-01-01'), 
  COALESCE(valid_to, '2999-12-31')
)
```

---

## 🎯 Plant Fallback 邏輯

### fgFinancialsService 特殊功能

**問題：** 成品定價可能有工廠特定價格，也可能只有全球統一價格

**解決方案：** Plant Fallback

```javascript
// 查詢順序
1. 查詢 plant_id = 'PLANT-01' 的資料
   ↓ (找不到)
2. Fallback 到 plant_id IS NULL (global pricing)
   ↓
3. 返回結果
```

**控制參數：** `usePlantFallback: boolean`
- `true` (預設) - 啟用 fallback
- `false` - 禁用 fallback（只查詢指定條件）

**範例：**
```javascript
// 啟用 fallback（推薦）
const data = await fgFinancialsService.fetchByFilters(userId, {
  plantId: 'PLANT-01',
  materialCode: 'FG-2000',
  usePlantFallback: true  // 找不到 PLANT-01 就用 global
});

// 禁用 fallback
const data = await fgFinancialsService.fetchByFilters(userId, {
  plantId: 'PLANT-01',
  materialCode: 'FG-2000',
  usePlantFallback: false  // 只找 PLANT-01，找不到就返回 []
});
```

---

## 📊 方法對照表

| 方法類型 | poOpenLines | inventorySnapshots | fgFinancials |
|---------|-------------|-------------------|--------------|
| **批量插入** | `batchInsert()` | `batchInsert()` | `batchInsert()` |
| **條件查詢** | `fetchByFilters()` | `fetchByFilters()` | `fetchByFilters()` ⭐ |
| **批次刪除** | `deleteByBatch()` | `deleteByBatch()` | `deleteByBatch()` |
| **通用查詢** | `getPoOpenLines()` | `getInventorySnapshots()` | `getFgFinancials()` |
| **特殊查詢** | - | `getLatestSnapshot()` | `getFgFinancial()` ⭐ |

---

## 🔑 參數說明

### plantId 參數

| 值 | 行為 | 適用 |
|----|------|------|
| `null` | 查詢所有工廠 | 所有 service |
| `'PLANT-01'` | 查詢指定工廠 | 所有 service |
| `'PLANT-01'` + `usePlantFallback: true` | 優先查詢指定工廠，找不到則查詢 global | 僅 fgFinancials |

### timeBuckets 參數

| 值 | 行為 |
|----|------|
| `null` | 查詢所有時間 |
| `[]` | 查詢所有時間 |
| `['2026-W05', '2026-W06']` | 只查詢這些時間桶 |

### batchId 參數

| 使用場景 | 值 | 用途 |
|---------|---|------|
| 上傳新資料 | UUID | 追蹤資料來源 |
| 手動新增 | `null` | 不需追蹤 |
| 刪除批次 | UUID | 支援 undo |

---

## 💡 最佳實務

### 1. 使用 batchInsert 上傳資料
```javascript
// ✅ 好的做法
const result = await poOpenLinesService.batchInsert(userId, rows, batchId);
if (result.success) {
  console.log(`Successfully inserted ${result.count} rows`);
}
```

### 2. 查詢供應鏈資料（供引擎使用）
```javascript
// ✅ 查詢特定工廠和時間範圍
const poData = await poOpenLinesService.fetchByFilters(userId, {
  plantId: 'PLANT-01',
  timeBuckets: ['2026-W05', '2026-W06', '2026-W07']
});
```

### 3. FG Financials 含 Fallback
```javascript
// ✅ 使用 fallback 邏輯（推薦）
const pricing = await fgFinancialsService.fetchByFilters(userId, {
  plantId: 'PLANT-01',
  materialCode: 'FG-2000',
  usePlantFallback: true  // 重要：啟用 fallback
});
```

### 4. 批次撤銷
```javascript
// ✅ 支援 undo
const result = await poOpenLinesService.deleteByBatch(batchId);
console.log(`Deleted ${result.count} rows from batch ${batchId}`);
```

---

## 🔍 與現有 Service 的對齊

### 命名風格對齊

| 現有 Service | 新增 Service |
|-------------|-------------|
| `demandFgService.batchInsert()` | `poOpenLinesService.batchInsert()` ✅ |
| `demandFgService.fetchDemandFg()` | `poOpenLinesService.fetchByFilters()` ✅ |
| `componentDemandService.deleteByBatch()` | `poOpenLinesService.deleteByBatch()` ✅ |

### 參數風格對齊

| 現有 Service | 新增 Service |
|-------------|-------------|
| `getDemands(userId, { plantId, limit, offset })` | `fetchByFilters(userId, { plantId, limit, offset })` ✅ |
| `fetchDemandFg(userId, plantId, timeBuckets)` | `fetchByFilters(userId, { plantId, timeBuckets })` ✅ |

---

## 📚 相關文件

- `SUPABASE_SERVICES_IMPLEMENTATION.md` - 完整實作說明
- `src/services/supabaseClient.js` - 原始碼
- `database/step1_supply_inventory_financials_schema.sql` - Database Schema
- `UPLOAD_SCHEMAS_EXTENSION_SUMMARY.md` - Upload Schemas 總結

---

**最後更新：** 2026-01-31
