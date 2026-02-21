# Supabase Services Implementation - 實作總結

## 📋 概述

為 Decision-Intelligence 系統的 3 種新資料類型新增 Supabase service layer，提供完整的 CRUD 操作和查詢功能。

**修改檔案：** `src/services/supabaseClient.js`

---

## 📁 新增的 3 個 Services

### 1. poOpenLinesService
### 2. inventorySnapshotsService
### 3. fgFinancialsService

---

## 🎯 1. poOpenLinesService

### Public API

#### 1.1 `batchInsert(userId, rows, batchId)`

**用途：** 批量插入 PO Open Lines（採購訂單未交貨明細）

**參數：**
- `userId` (string) - 使用者 ID
- `rows` (Array) - PO Open Lines 資料陣列
- `batchId` (string, optional) - 批次 ID

**Row 結構：**
```javascript
{
  po_number: string,        // 採購訂單號碼
  po_line: string,          // 訂單行號
  material_code: string,    // 物料代碼
  plant_id: string,         // 工廠代碼
  time_bucket: string,      // 時間桶
  open_qty: number,         // 未交貨數量
  uom: string,              // 計量單位（預設 'pcs'）
  supplier_id: string,      // 供應商 ID（可選）
  status: string,           // 狀態（預設 'open'）
  notes: string             // 備註（可選）
}
```

**返回值：**
```javascript
{ success: true, count: number, data: Array }
```

**UPSERT 策略：**
- 使用 UNIQUE 約束：`(user_id, po_number, po_line, time_bucket)`
- 自動處理重複資料

---

#### 1.2 `fetchByFilters(userId, options)`

**用途：** 根據條件查詢 PO Open Lines（用於 forecast/risk 引擎）

**參數：**
```javascript
{
  plantId: string | null,           // 工廠 ID（null = all plants）
  timeBuckets: Array<string> | null, // 時間桶陣列（null = all time）
  materialCode: string,             // 物料代碼（可選）
  poNumber: string,                 // 採購訂單號碼（可選）
  supplierId: string,               // 供應商 ID（可選）
  status: string,                   // 狀態（可選）
  limit: number,                    // 限制筆數（預設 1000）
  offset: number                    // 偏移量（預設 0）
}
```

**返回值：**
```javascript
Array<POOpenLine>
```

**查詢邏輯：**
- `plantId = null` → 查詢所有工廠
- `timeBuckets = null` → 查詢所有時間
- 支援多重過濾條件組合

---

#### 1.3 `deleteByBatch(batchId)`

**用途：** 根據批次 ID 刪除資料（支援 undo）

**參數：**
- `batchId` (string) - 批次 ID

**返回值：**
```javascript
{ success: true, count: number }
```

---

#### 1.4 `getPoOpenLines(userId, options)`

**用途：** 通用查詢方法

**參數：**
```javascript
{
  plantId: string,
  materialCode: string,
  startTimeBucket: string,
  endTimeBucket: string,
  limit: number,
  offset: number
}
```

**返回值：**
```javascript
Array<POOpenLine>
```

---

## 📦 2. inventorySnapshotsService

### Public API

#### 2.1 `batchInsert(userId, rows, batchId)`

**用途：** 批量插入 Inventory Snapshots（庫存快照）

**參數：**
- `userId` (string) - 使用者 ID
- `rows` (Array) - Inventory Snapshots 資料陣列
- `batchId` (string, optional) - 批次 ID

**Row 結構：**
```javascript
{
  material_code: string,    // 物料代碼
  plant_id: string,         // 工廠代碼
  snapshot_date: string,    // 快照日期（YYYY-MM-DD）
  onhand_qty: number,       // 在庫數量
  allocated_qty: number,    // 已分配數量（預設 0）
  safety_stock: number,     // 安全庫存（預設 0）
  uom: string,              // 計量單位（預設 'pcs'）
  notes: string             // 備註（可選）
}
```

**返回值：**
```javascript
{ success: true, count: number, data: Array }
```

**UPSERT 策略：**
- 使用 UNIQUE 約束：`(user_id, material_code, plant_id, snapshot_date)`
- 自動處理重複資料

---

#### 2.2 `fetchByFilters(userId, options)`

**用途：** 根據條件查詢 Inventory Snapshots

**參數：**
```javascript
{
  plantId: string | null,    // 工廠 ID（null = all plants）
  materialCode: string,      // 物料代碼（可選）
  snapshotDate: string,      // 特定快照日期（可選）
  startDate: string,         // 起始日期（可選）
  endDate: string,           // 結束日期（可選）
  limit: number,             // 限制筆數（預設 1000）
  offset: number             // 偏移量（預設 0）
}
```

**返回值：**
```javascript
Array<InventorySnapshot>
```

**查詢邏輯：**
- `plantId = null` → 查詢所有工廠
- 支援日期範圍查詢
- 預設按 `snapshot_date` 降序排序

---

#### 2.3 `deleteByBatch(batchId)`

**用途：** 根據批次 ID 刪除資料（支援 undo）

**參數：**
- `batchId` (string) - 批次 ID

**返回值：**
```javascript
{ success: true, count: number }
```

---

#### 2.4 `getLatestSnapshot(userId, materialCode, plantId)`

**用途：** 獲取最新的庫存快照

**參數：**
- `userId` (string) - 使用者 ID
- `materialCode` (string) - 物料代碼
- `plantId` (string) - 工廠 ID

**返回值：**
```javascript
InventorySnapshot | null
```

---

#### 2.5 `getInventorySnapshots(userId, options)`

**用途：** 通用查詢方法

**參數：**
```javascript
{
  plantId: string,
  materialCode: string,
  snapshotDate: string,
  limit: number,
  offset: number
}
```

**返回值：**
```javascript
Array<InventorySnapshot>
```

---

## 💰 3. fgFinancialsService

### Public API

#### 3.1 `batchInsert(userId, rows, batchId)`

**用途：** 批量插入 FG Financials（成品財務資料）

**參數：**
- `userId` (string) - 使用者 ID
- `rows` (Array) - FG Financials 資料陣列
- `batchId` (string, optional) - 批次 ID

**Row 結構：**
```javascript
{
  material_code: string,    // 成品代碼
  unit_margin: number,      // 單位利潤
  plant_id: string | null,  // 工廠代碼（null = global pricing）
  unit_price: number,       // 單位售價（可選）
  currency: string,         // 幣別（預設 'USD'）
  valid_from: string,       // 有效起始日（可選）
  valid_to: string,         // 有效結束日（可選）
  notes: string             // 備註（可選）
}
```

**返回值：**
```javascript
{ success: true, count: number, data: Array }
```

**UPSERT 策略：**
- 使用 UNIQUE INDEX with COALESCE
- 自動處理 unique violation（23505 error code）
- Fallback 到逐筆 upsert

---

#### 3.2 `fetchByFilters(userId, options)` ⭐ 特殊實作

**用途：** 根據條件查詢 FG Financials（含 plant fallback 邏輯）

**參數：**
```javascript
{
  plantId: string | null,         // 工廠 ID（null = all plants）
  materialCode: string,           // 物料代碼（可選）
  currency: string,               // 幣別（可選）
  validDate: string,              // 有效日期（YYYY-MM-DD，可選）
  usePlantFallback: boolean,      // 是否使用 plant fallback（預設 true）
  limit: number,                  // 限制筆數（預設 1000）
  offset: number                  // 偏移量（預設 0）
}
```

**返回值：**
```javascript
Array<FgFinancial>
```

**特殊查詢邏輯（Plant Fallback）：**

```
1. 如果指定 plantId 且 usePlantFallback = true:
   a. 先查詢 plant_id = plantId 的資料
   b. 如果找到資料 → 返回
   c. 如果找不到 → fallback 到 plant_id IS NULL (global pricing)
   
2. 如果 plantId = null:
   - 查詢所有資料（不限制 plant_id）
   
3. 如果 usePlantFallback = false:
   - 直接查詢指定條件（不使用 fallback）
```

**範例：**
```javascript
// 範例 1: 查詢 PLANT-01 的 FG-2000 定價（含 fallback）
const data = await fgFinancialsService.fetchByFilters(userId, {
  plantId: 'PLANT-01',
  materialCode: 'FG-2000',
  usePlantFallback: true
});
// 先找 plant_id='PLANT-01' 的資料，找不到則返回 plant_id=NULL 的全球定價

// 範例 2: 只查詢全球定價
const globalData = await fgFinancialsService.fetchByFilters(userId, {
  plantId: null,
  usePlantFallback: false
});
```

---

#### 3.3 `deleteByBatch(batchId)`

**用途：** 根據批次 ID 刪除資料（支援 undo）

**參數：**
- `batchId` (string) - 批次 ID

**返回值：**
```javascript
{ success: true, count: number }
```

---

#### 3.4 `getFgFinancial(userId, materialCode, plantId, currency)`

**用途：** 獲取特定成品的財務資料（含 plant fallback）

**參數：**
- `userId` (string) - 使用者 ID
- `materialCode` (string) - 物料代碼
- `plantId` (string, optional) - 工廠 ID
- `currency` (string, default: 'USD') - 幣別

**返回值：**
```javascript
FgFinancial | null
```

**查詢邏輯：**
1. 如果指定 `plantId`，先查詢該工廠的資料
2. 找不到則 fallback 到 `plant_id IS NULL` (global)
3. 按 `valid_from` 降序排序（最新優先）

---

#### 3.5 `getFgFinancials(userId, options)`

**用途：** 通用查詢方法

**參數：**
```javascript
{
  plantId: string | null,
  materialCode: string,
  currency: string,
  limit: number,
  offset: number
}
```

**返回值：**
```javascript
Array<FgFinancial>
```

---

## 📊 API 對照表

### 共通方法

| 方法 | poOpenLines | inventorySnapshots | fgFinancials |
|-----|-------------|-------------------|--------------|
| `batchInsert()` | ✅ | ✅ | ✅ |
| `fetchByFilters()` | ✅ | ✅ | ✅ ⭐ (含 fallback) |
| `deleteByBatch()` | ✅ | ✅ | ✅ |

### 特殊方法

| Service | 特殊方法 | 用途 |
|---------|---------|------|
| poOpenLinesService | `getPoOpenLines()` | 通用查詢 |
| inventorySnapshotsService | `getLatestSnapshot()` | 獲取最新快照 |
| inventorySnapshotsService | `getInventorySnapshots()` | 通用查詢 |
| fgFinancialsService | `getFgFinancial()` | 單筆查詢（含 fallback） |
| fgFinancialsService | `getFgFinancials()` | 通用查詢 |

---

## 🔑 UNIQUE 約束對照

### 1. po_open_lines
```sql
UNIQUE(user_id, po_number, po_line, time_bucket)
```

**Upsert 配置：**
```javascript
onConflict: 'user_id,po_number,po_line,time_bucket'
```

---

### 2. inventory_snapshots
```sql
UNIQUE(user_id, material_code, plant_id, snapshot_date)
```

**Upsert 配置：**
```javascript
onConflict: 'user_id,material_code,plant_id,snapshot_date'
```

---

### 3. fg_financials
```sql
CREATE UNIQUE INDEX idx_fg_financials_unique_key
  ON fg_financials(
    user_id, 
    material_code, 
    COALESCE(plant_id, ''), 
    currency, 
    COALESCE(valid_from, '1900-01-01'::DATE), 
    COALESCE(valid_to, '2999-12-31'::DATE)
  );
```

**Upsert 處理：**
- 因為使用 UNIQUE INDEX with COALESCE，無法直接指定 `onConflict`
- 採用 try-catch 策略：先 insert，遇到 23505 錯誤則逐筆 upsert

---

## 🔍 查詢功能比較

### plantId 處理

| Service | plantId = null | plantId = 指定值 | 特殊功能 |
|---------|---------------|-----------------|---------|
| poOpenLines | 查詢所有工廠 | 查詢指定工廠 | - |
| inventorySnapshots | 查詢所有工廠 | 查詢指定工廠 | - |
| fgFinancials | 查詢所有工廠 | 查詢指定工廠 | ⭐ Plant Fallback |

### timeBuckets 處理

| Service | timeBuckets = null | timeBuckets = Array | 
|---------|-------------------|---------------------|
| poOpenLines | 查詢所有時間 | 查詢指定時間桶 |
| inventorySnapshots | 查詢所有日期 | 使用 startDate/endDate |
| fgFinancials | 查詢所有有效期 | 使用 validDate |

---

## 🎯 Plant Fallback 詳細說明

### 使用場景

當查詢 FG Financial 資料時，系統需要：
1. 優先使用工廠特定定價（plant-specific pricing）
2. 如果該工廠沒有定價，則使用全球定價（global pricing，`plant_id IS NULL`）

### 實作邏輯

```javascript
async fetchByFilters(userId, options = {}) {
  const { plantId, materialCode, usePlantFallback = true } = options;
  
  if (plantId && usePlantFallback) {
    // Step 1: 查詢指定工廠的資料
    const plantData = await queryPlantSpecific(plantId);
    if (plantData.length > 0) {
      return plantData; // 找到就返回
    }
    
    // Step 2: Fallback 到 global
    const globalData = await queryGlobal();
    return globalData;
  }
  
  // 一般查詢（不使用 fallback）
  return await queryNormal();
}
```

### 範例查詢

#### 範例 1: 標準 Fallback
```javascript
// PLANT-01 的 FG-2000 定價
const result = await fgFinancialsService.fetchByFilters(userId, {
  plantId: 'PLANT-01',
  materialCode: 'FG-2000',
  currency: 'USD',
  usePlantFallback: true
});

// 查詢順序：
// 1. plant_id = 'PLANT-01' AND material_code = 'FG-2000'
// 2. 如果找不到 → plant_id IS NULL AND material_code = 'FG-2000'
```

#### 範例 2: 禁用 Fallback
```javascript
// 只查詢 PLANT-01 的特定定價（不要 global）
const result = await fgFinancialsService.fetchByFilters(userId, {
  plantId: 'PLANT-01',
  materialCode: 'FG-2000',
  usePlantFallback: false
});

// 只查詢：plant_id = 'PLANT-01' AND material_code = 'FG-2000'
// 找不到就返回 []
```

#### 範例 3: 查詢所有工廠
```javascript
// 查詢所有工廠的 FG-2000 定價
const result = await fgFinancialsService.fetchByFilters(userId, {
  plantId: null,  // 不指定工廠
  materialCode: 'FG-2000'
});

// 查詢：material_code = 'FG-2000'（所有 plant_id）
```

---

## 🧪 使用範例

### 範例 1: 上傳並插入 PO Open Lines

```javascript
import { poOpenLinesService } from '@/services/supabaseClient';

// 上傳資料
const rows = [
  {
    po_number: 'PO-10001',
    po_line: '10',
    material_code: 'COMP-3100',
    plant_id: 'PLANT-01',
    time_bucket: '2026-W05',
    open_qty: 5000,
    supplier_id: 'SUP-001',
    status: 'open'
  }
];

const result = await poOpenLinesService.batchInsert(
  userId, 
  rows, 
  batchId
);

console.log(`Inserted ${result.count} rows`);
```

---

### 範例 2: 查詢庫存快照

```javascript
import { inventorySnapshotsService } from '@/services/supabaseClient';

// 查詢 PLANT-01 的所有庫存
const snapshots = await inventorySnapshotsService.fetchByFilters(userId, {
  plantId: 'PLANT-01',
  startDate: '2026-01-01',
  endDate: '2026-01-31'
});

console.log(`Found ${snapshots.length} snapshots`);
```

---

### 範例 3: FG Financials 含 Fallback

```javascript
import { fgFinancialsService } from '@/services/supabaseClient';

// 查詢 FG-2000 在 PLANT-01 的定價（含 fallback）
const financials = await fgFinancialsService.fetchByFilters(userId, {
  plantId: 'PLANT-01',
  materialCode: 'FG-2000',
  currency: 'USD',
  validDate: '2026-01-31',
  usePlantFallback: true  // 啟用 fallback
});

// 如果 PLANT-01 沒有特定定價，會自動返回 global 定價
console.log(`Found ${financials.length} financial records`);
```

---

### 範例 4: 刪除批次資料（Undo）

```javascript
import { 
  poOpenLinesService, 
  inventorySnapshotsService, 
  fgFinancialsService 
} from '@/services/supabaseClient';

// 刪除批次資料
const batchId = 'some-batch-uuid';

const result1 = await poOpenLinesService.deleteByBatch(batchId);
const result2 = await inventorySnapshotsService.deleteByBatch(batchId);
const result3 = await fgFinancialsService.deleteByBatch(batchId);

console.log(`Deleted ${result1.count + result2.count + result3.count} rows`);
```

---

## 📊 程式碼統計

| 項目 | 數量 |
|-----|------|
| 新增 Service | 3 個 |
| 新增 Public 方法 | 13 個 |
| 新增程式碼行數 | ~650 行 |
| 支援 UPSERT | 3 個 table |
| 支援 Batch Delete | 3 個 table |
| 特殊功能實作 | 1 個（Plant Fallback） |

---

## ✅ 功能檢查清單

### poOpenLinesService ✅
- ✅ `batchInsert` - 批量插入（含 upsert）
- ✅ `fetchByFilters` - 支援 plantId/timeBuckets 過濾
- ✅ `deleteByBatch` - 支援 undo
- ✅ `getPoOpenLines` - 通用查詢方法
- ✅ UNIQUE 約束：`(user_id, po_number, po_line, time_bucket)`

### inventorySnapshotsService ✅
- ✅ `batchInsert` - 批量插入（含 upsert）
- ✅ `fetchByFilters` - 支援 plantId/日期範圍過濾
- ✅ `deleteByBatch` - 支援 undo
- ✅ `getLatestSnapshot` - 獲取最新快照
- ✅ `getInventorySnapshots` - 通用查詢方法
- ✅ UNIQUE 約束：`(user_id, material_code, plant_id, snapshot_date)`

### fgFinancialsService ✅
- ✅ `batchInsert` - 批量插入（含 upsert fallback）
- ✅ `fetchByFilters` - 支援 **plant fallback** 邏輯
- ✅ `deleteByBatch` - 支援 undo
- ✅ `getFgFinancial` - 單筆查詢（含 fallback）
- ✅ `getFgFinancials` - 通用查詢方法
- ✅ UNIQUE INDEX with COALESCE
- ✅ 特殊功能：Plant-specific → Global fallback

---

## 🎉 完成狀態

**✅ 所有需求已 100% 完成！**

- ✅ 3 個 service 已新增
- ✅ 所有 service 提供 batchInsert/fetchByFilters/deleteByBatch
- ✅ UPSERT 使用正確的 UNIQUE 約束
- ✅ fetchByFilters 支援 plantId null（all plants）
- ✅ fetchByFilters 支援 timeBuckets null（all time）
- ✅ fg_financials 支援 plant fallback 邏輯
- ✅ 函數命名對齊 demandFgService / bomEdgesService 風格
- ✅ 完整的 JSDoc 註釋
- ✅ 錯誤處理完善

**系統已準備就緒，可立即使用！** 🚀

---

**文件版本：** 1.0  
**創建日期：** 2026-01-31  
**最後更新：** 2026-01-31
