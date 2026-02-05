# Supabase Services - 修改 Diff 總結

## 📁 修改檔案

**檔案：** `src/services/supabaseClient.js`
- **行數變化：** +669 行
- **新增 Service：** 3 個
- **新增 Public 方法：** 13 個

---

## 📊 修改位置

### 插入位置：Line 1426-2094

**原代碼：**
```javascript
// Line 1426-1431 (原始)
/**
 * Import Batches Operations
 * 管理匯入歷史和批次撤銷功能
 */
export { importBatchesService } from './importHistoryService';
```

**修改後：**
```javascript
// Line 1426-2094 (新增 669 行)
/**
 * PO Open Lines Operations
 * 管理採購訂單未交貨明細
 */
export const poOpenLinesService = { ... };

/**
 * Inventory Snapshots Operations
 * 管理庫存快照資料
 */
export const inventorySnapshotsService = { ... };

/**
 * FG Financials Operations
 * 管理成品財務資料（定價與利潤）
 */
export const fgFinancialsService = { ... };

/**
 * Import Batches Operations
 * 管理匯入歷史和批次撤銷功能
 */
export { importBatchesService } from './importHistoryService';
```

---

## 🎯 新增內容詳細 Diff

### 1. poOpenLinesService（Line 1426-1588）

#### 新增方法（4 個）

**1.1 batchInsert(userId, rows, batchId)** - Line 1438-1469
```javascript
// 批量插入 PO Open Lines
async batchInsert(userId, rows, batchId = null) {
  // 構建 payload
  const payload = rows.map(row => ({
    user_id: userId,
    batch_id: batchId,
    po_number: row.po_number,
    po_line: row.po_line,
    material_code: row.material_code,
    plant_id: row.plant_id,
    time_bucket: row.time_bucket,
    open_qty: row.open_qty,
    uom: row.uom || 'pcs',
    supplier_id: row.supplier_id || null,
    status: row.status || 'open',
    notes: row.notes || null
  }));

  // UPSERT with UNIQUE constraint
  const { data, error } = await supabase
    .from('po_open_lines')
    .upsert(payload, {
      onConflict: 'user_id,po_number,po_line,time_bucket', // ⭐ 關鍵
      ignoreDuplicates: false
    })
    .select();

  if (error) throw error;
  return { success: true, count: data.length, data };
}
```

**1.2 fetchByFilters(userId, options)** - Line 1471-1533
```javascript
// 支援多重過濾條件
async fetchByFilters(userId, options = {}) {
  const { 
    plantId = null,           // null = all plants
    timeBuckets = null,       // null = all time
    materialCode = null,
    poNumber = null,
    supplierId = null,
    status = null,
    limit = 1000, 
    offset = 0 
  } = options;

  let query = supabase
    .from('po_open_lines')
    .select('*')
    .eq('user_id', userId)
    .order('time_bucket', { ascending: true })
    .range(offset, offset + limit - 1);

  // 條件過濾
  if (plantId) query = query.eq('plant_id', plantId);
  if (timeBuckets?.length > 0) query = query.in('time_bucket', timeBuckets);
  if (materialCode) query = query.eq('material_code', materialCode);
  if (poNumber) query = query.eq('po_number', poNumber);
  if (supplierId) query = query.eq('supplier_id', supplierId);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}
```

**1.3 deleteByBatch(batchId)** - Line 1535-1549
```javascript
// 批次刪除（支援 undo）
async deleteByBatch(batchId) {
  if (!batchId) {
    return { success: true, count: 0 };
  }

  const { data, error } = await supabase
    .from('po_open_lines')
    .delete()
    .eq('batch_id', batchId)
    .select();

  if (error) throw error;
  return { success: true, count: data?.length || 0 };
}
```

**1.4 getPoOpenLines(userId, options)** - Line 1551-1588
```javascript
// 通用查詢方法（與 demandFgService.getDemands 對齊）
async getPoOpenLines(userId, options = {}) {
  const { 
    plantId, 
    materialCode, 
    startTimeBucket, 
    endTimeBucket, 
    limit = 100, 
    offset = 0 
  } = options;

  let query = supabase
    .from('po_open_lines')
    .select('*')
    .eq('user_id', userId)
    .order('time_bucket', { ascending: true })
    .range(offset, offset + limit - 1);

  if (plantId) query = query.eq('plant_id', plantId);
  if (materialCode) query = query.eq('material_code', materialCode);
  if (startTimeBucket) query = query.gte('time_bucket', startTimeBucket);
  if (endTimeBucket) query = query.lte('time_bucket', endTimeBucket);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}
```

---

### 2. inventorySnapshotsService（Line 1590-1790）

#### 新增方法（5 個）

**2.1 batchInsert(userId, rows, batchId)** - Line 1600-1635
```javascript
// 批量插入 Inventory Snapshots
async batchInsert(userId, rows, batchId = null) {
  const payload = rows.map(row => ({
    user_id: userId,
    batch_id: batchId,
    material_code: row.material_code,
    plant_id: row.plant_id,
    snapshot_date: row.snapshot_date,
    onhand_qty: row.onhand_qty,
    allocated_qty: row.allocated_qty ?? 0,  // 空值 → 0
    safety_stock: row.safety_stock ?? 0,    // 空值 → 0
    uom: row.uom || 'pcs',
    notes: row.notes || null
  }));

  // UPSERT with UNIQUE constraint
  const { data, error } = await supabase
    .from('inventory_snapshots')
    .upsert(payload, {
      onConflict: 'user_id,material_code,plant_id,snapshot_date', // ⭐ 關鍵
      ignoreDuplicates: false
    })
    .select();

  if (error) throw error;
  return { success: true, count: data.length, data };
}
```

**2.2 fetchByFilters(userId, options)** - Line 1637-1688
**2.3 deleteByBatch(batchId)** - Line 1690-1704
**2.4 getLatestSnapshot(userId, materialCode, plantId)** - Line 1706-1726
**2.5 getInventorySnapshots(userId, options)** - Line 1728-1789

---

### 3. fgFinancialsService（Line 1792-2089）

#### 新增方法（5 個）

**3.1 batchInsert(userId, rows, batchId)** - Line 1804-1857
```javascript
// 批量插入 FG Financials（含 error handling）
async batchInsert(userId, rows, batchId = null) {
  const payload = rows.map(row => ({
    user_id: userId,
    batch_id: batchId,
    material_code: row.material_code,
    unit_margin: row.unit_margin,
    plant_id: row.plant_id || null,  // null = global pricing
    unit_price: row.unit_price ?? null,
    currency: row.currency || 'USD',
    valid_from: row.valid_from || null,
    valid_to: row.valid_to || null,
    notes: row.notes || null
  }));

  try {
    // 先嘗試 insert
    const { data, error } = await supabase
      .from('fg_financials')
      .insert(payload)
      .select();

    if (error) {
      // 處理唯一性衝突（23505）
      if (error.code === '23505') {
        // Fallback: 逐筆 upsert
        const results = [];
        for (const row of payload) {
          const { data: upsertData, error: upsertError } = await supabase
            .from('fg_financials')
            .upsert(row, { ignoreDuplicates: false })
            .select();
          
          if (upsertError) throw upsertError;
          results.push(...(upsertData || []));
        }
        return { success: true, count: results.length, data: results };
      }
      throw error;
    }

    return { success: true, count: data.length, data };
  } catch (error) {
    console.error('batchInsert fg_financials error:', error);
    throw error;
  }
}
```

**3.2 fetchByFilters(userId, options)** ⭐ - Line 1859-1985
```javascript
// 含 Plant Fallback 邏輯
async fetchByFilters(userId, options = {}) {
  const { 
    plantId = null, 
    materialCode = null,
    currency = null,
    validDate = null,
    usePlantFallback = true,  // ⭐ 關鍵參數
    limit = 1000, 
    offset = 0 
  } = options;

  // ⭐⭐ Plant Fallback 邏輯 ⭐⭐
  if (plantId && usePlantFallback) {
    // Step 1: 查詢 plant_id = plantId
    let plantQuery = supabase
      .from('fg_financials')
      .select('*')
      .eq('user_id', userId)
      .eq('plant_id', plantId)
      .order('material_code', { ascending: true })
      .range(offset, offset + limit - 1);

    // 套用過濾條件
    if (materialCode) plantQuery = plantQuery.eq('material_code', materialCode);
    if (currency) plantQuery = plantQuery.eq('currency', currency);
    if (validDate) {
      plantQuery = plantQuery
        .or(`valid_from.is.null,valid_from.lte.${validDate}`)
        .or(`valid_to.is.null,valid_to.gte.${validDate}`);
    }

    const { data: plantData, error: plantError } = await plantQuery;
    if (plantError) throw plantError;

    // 如果找到資料，直接返回
    if (plantData && plantData.length > 0) {
      return plantData;
    }

    // Step 2: Fallback 到 plant_id IS NULL (global)
    let globalQuery = supabase
      .from('fg_financials')
      .select('*')
      .eq('user_id', userId)
      .is('plant_id', null)  // ⭐ 關鍵：查詢 global
      .order('material_code', { ascending: true })
      .range(offset, offset + limit - 1);

    // 套用相同的過濾條件
    if (materialCode) globalQuery = globalQuery.eq('material_code', materialCode);
    if (currency) globalQuery = globalQuery.eq('currency', currency);
    if (validDate) {
      globalQuery = globalQuery
        .or(`valid_from.is.null,valid_from.lte.${validDate}`)
        .or(`valid_to.is.null,valid_to.gte.${validDate}`);
    }

    const { data: globalData, error: globalError } = await globalQuery;
    if (globalError) throw globalError;

    return globalData || [];
  }

  // 一般查詢（不使用 fallback）
  let query = supabase
    .from('fg_financials')
    .select('*')
    .eq('user_id', userId)
    .order('material_code', { ascending: true })
    .range(offset, offset + limit - 1);

  // 工廠過濾
  if (plantId) {
    query = query.eq('plant_id', plantId);
  } else if (plantId === null && !usePlantFallback) {
    query = query.is('plant_id', null);
  }

  // 其他過濾條件
  if (materialCode) query = query.eq('material_code', materialCode);
  if (currency) query = query.eq('currency', currency);
  if (validDate) {
    query = query
      .or(`valid_from.is.null,valid_from.lte.${validDate}`)
      .or(`valid_to.is.null,valid_to.gte.${validDate}`);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}
```

**3.3 deleteByBatch(batchId)** - Line 1987-2001
**3.4 getFgFinancial(userId, materialCode, plantId, currency)** - Line 2003-2047
**3.5 getFgFinancials(userId, options)** - Line 2049-2089

---

## 📋 每個 Service 的 Public API 清單

### 1. poOpenLinesService

| 方法 | 參數 | 返回值 | 用途 |
|-----|------|--------|------|
| `batchInsert` | `(userId, rows, batchId?)` | `{ success, count, data }` | 批量插入（upsert） |
| `fetchByFilters` | `(userId, options)` | `Array<POOpenLine>` | 條件查詢（供引擎用） |
| `deleteByBatch` | `(batchId)` | `{ success, count }` | 批次刪除（undo） |
| `getPoOpenLines` | `(userId, options)` | `Array<POOpenLine>` | 通用查詢 |

**Options 參數（fetchByFilters）：**
```javascript
{
  plantId: string | null,           // null = all plants ⭐
  timeBuckets: Array<string> | null, // null = all time ⭐
  materialCode: string,
  poNumber: string,
  supplierId: string,
  status: string,
  limit: number,                    // default: 1000
  offset: number                    // default: 0
}
```

---

### 2. inventorySnapshotsService

| 方法 | 參數 | 返回值 | 用途 |
|-----|------|--------|------|
| `batchInsert` | `(userId, rows, batchId?)` | `{ success, count, data }` | 批量插入（upsert） |
| `fetchByFilters` | `(userId, options)` | `Array<InventorySnapshot>` | 條件查詢 |
| `deleteByBatch` | `(batchId)` | `{ success, count }` | 批次刪除（undo） |
| `getLatestSnapshot` | `(userId, materialCode, plantId)` | `InventorySnapshot \| null` | 獲取最新快照 |
| `getInventorySnapshots` | `(userId, options)` | `Array<InventorySnapshot>` | 通用查詢 |

**Options 參數（fetchByFilters）：**
```javascript
{
  plantId: string | null,    // null = all plants ⭐
  materialCode: string,
  snapshotDate: string,      // YYYY-MM-DD
  startDate: string,         // YYYY-MM-DD
  endDate: string,           // YYYY-MM-DD
  limit: number,             // default: 1000
  offset: number             // default: 0
}
```

---

### 3. fgFinancialsService

| 方法 | 參數 | 返回值 | 用途 |
|-----|------|--------|------|
| `batchInsert` | `(userId, rows, batchId?)` | `{ success, count, data }` | 批量插入（upsert fallback） |
| `fetchByFilters` ⭐ | `(userId, options)` | `Array<FgFinancial>` | 條件查詢（含 plant fallback） |
| `deleteByBatch` | `(batchId)` | `{ success, count }` | 批次刪除（undo） |
| `getFgFinancial` ⭐ | `(userId, materialCode, plantId?, currency?)` | `FgFinancial \| null` | 單筆查詢（含 fallback） |
| `getFgFinancials` | `(userId, options)` | `Array<FgFinancial>` | 通用查詢 |

**Options 參數（fetchByFilters）：**
```javascript
{
  plantId: string | null,         // null = all plants ⭐
  materialCode: string,
  currency: string,
  validDate: string,              // YYYY-MM-DD
  usePlantFallback: boolean,      // default: true ⭐⭐ 關鍵
  limit: number,                  // default: 1000
  offset: number                  // default: 0
}
```

**Plant Fallback 邏輯：**
```
if (plantId && usePlantFallback) {
  查詢 plant_id = plantId
    ↓ (找不到)
  Fallback 到 plant_id IS NULL (global)
}
```

---

## 🔑 UPSERT 策略對照

### 1. po_open_lines
```javascript
// DB UNIQUE constraint
UNIQUE(user_id, po_number, po_line, time_bucket)

// Supabase upsert
.upsert(payload, {
  onConflict: 'user_id,po_number,po_line,time_bucket'
})
```

---

### 2. inventory_snapshots
```javascript
// DB UNIQUE constraint
UNIQUE(user_id, material_code, plant_id, snapshot_date)

// Supabase upsert
.upsert(payload, {
  onConflict: 'user_id,material_code,plant_id,snapshot_date'
})
```

---

### 3. fg_financials ⚠️ 特殊處理
```javascript
// DB UNIQUE INDEX with COALESCE
CREATE UNIQUE INDEX idx_fg_financials_unique_key
  ON fg_financials(
    user_id, 
    material_code, 
    COALESCE(plant_id, ''), 
    currency, 
    COALESCE(valid_from, '1900-01-01'), 
    COALESCE(valid_to, '2999-12-31')
  );

// Supabase 處理策略
try {
  // 先嘗試 insert
  .insert(payload)
} catch (error) {
  // 如果遇到 23505 (unique violation)
  if (error.code === '23505') {
    // 改為逐筆 upsert
    for (const row of payload) {
      .upsert(row, { ignoreDuplicates: false })
    }
  }
}
```

**說明：**
- 因為 UNIQUE INDEX 使用 COALESCE，無法直接指定 `onConflict` column names
- 採用 try-catch 策略處理衝突
- 自動降級為逐筆 upsert

---

## ✅ 與現有 Service 對齊檢查

### 命名風格

| 現有 | 新增 | 對齊 |
|-----|------|------|
| `demandFgService` | `poOpenLinesService` | ✅ |
| `bomEdgesService` | `inventorySnapshotsService` | ✅ |
| - | `fgFinancialsService` | ✅ |

### 方法命名

| 現有 | 新增 | 對齊 |
|-----|------|------|
| `batchInsert(userId, rows, batchId)` | `batchInsert(userId, rows, batchId)` | ✅ |
| `fetchDemandFg(userId, plantId, timeBuckets)` | `fetchByFilters(userId, { plantId, timeBuckets })` | ✅ |
| `deleteByBatch(batchId)` | `deleteByBatch(batchId)` | ✅ |

### 返回格式

| 方法 | 現有 | 新增 | 對齊 |
|-----|------|------|------|
| batchInsert | `{ success, count, data }` | `{ success, count, data }` | ✅ |
| fetchByFilters | `Array` | `Array` | ✅ |
| deleteByBatch | `{ success, count }` | `{ success, count }` | ✅ |

---

## 📊 修改統計

| 項目 | 數量 |
|-----|------|
| 修改檔案 | 1 個 |
| 新增 Service | 3 個 |
| 新增 Public 方法 | 13 個 |
| 新增程式碼行數 | 669 行 |
| JSDoc 註釋 | 完整 |
| 錯誤處理 | 完善 |

---

## 🚀 使用範例

### Import 語法

```javascript
import { 
  poOpenLinesService,
  inventorySnapshotsService,
  fgFinancialsService
} from '@/services/supabaseClient';
```

### 基本使用

```javascript
// 1. 插入資料
const result = await poOpenLinesService.batchInsert(userId, rows, batchId);

// 2. 查詢資料
const data = await inventorySnapshotsService.fetchByFilters(userId, {
  plantId: 'PLANT-01',
  startDate: '2026-01-01'
});

// 3. FG Financials 含 Fallback
const financials = await fgFinancialsService.fetchByFilters(userId, {
  plantId: 'PLANT-01',
  materialCode: 'FG-2000',
  usePlantFallback: true  // 啟用 fallback
});

// 4. 刪除批次
const deleteResult = await poOpenLinesService.deleteByBatch(batchId);
```

---

## 📚 相關文件

- `SUPABASE_SERVICES_IMPLEMENTATION.md` - 完整實作說明
- `SUPABASE_SERVICES_API_REFERENCE.md` - API 快速參考
- `src/services/supabaseClient.js` - 原始碼（Line 1426-2094）
- `database/step1_supply_inventory_financials_schema.sql` - Database Schema

---

**文件版本：** 1.0  
**創建日期：** 2026-01-31
