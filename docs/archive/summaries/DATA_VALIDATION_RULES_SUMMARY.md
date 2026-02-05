# Data Validation Rules - 資料驗證規則總結

## 📋 概述

本文件說明 SmartOps 系統中 3 種新增 upload type 的資料驗證與清理規則。

**修改檔案：** `src/utils/dataValidation.js`

---

## 🎯 新增驗證函數

### 1. `validatePoOpenLinesRules(row)`
### 2. `validateInventorySnapshotsRules(row)`
### 3. `validateFgFinancialsRules(row)`

---

## 📊 A) po_open_lines 驗證規則

### 驗證函數：`validatePoOpenLinesRules(row)`

#### ✅ 驗證項目

| 欄位 | 驗證規則 | 錯誤/警告 | 處理方式 |
|-----|---------|----------|---------|
| **open_qty** | 必須是 number 且 >= 0 | 錯誤 | 顯示錯誤訊息：「open_qty 不能小於 0」 |
| **time_bucket** | 必須存在 | 錯誤 | 顯示錯誤訊息：「time_bucket 欄位必須存在（需要 week_bucket 或 date）」 |
| **status** | 必須是 open/closed/cancelled | 警告 | 自動修正為 'open'，顯示警告訊息 |

#### 📝 詳細說明

##### 1. open_qty 驗證
```javascript
// 驗證邏輯
if (row.open_qty < 0) {
  errors.push({ 
    field: 'open_qty', 
    fieldLabel: 'Open Quantity', 
    error: 'open_qty 不能小於 0', 
    originalValue: row.open_qty 
  });
}
```

**說明：**
- 額外檢查（Schema 已有 min: 0 設定）
- 防止負數數量

##### 2. time_bucket 驗證
```javascript
// 驗證邏輯
if (!row.time_bucket || row.time_bucket === '') {
  errors.push({ 
    field: 'time_bucket', 
    fieldLabel: 'Time Bucket', 
    error: 'time_bucket 欄位必須存在（需要 week_bucket 或 date）', 
    originalValue: null 
  });
}
```

**說明：**
- 在 `processTimeBucket()` 之後執行檢查
- 確保 week_bucket 或 date 至少填寫一個
- 與 demand_fg 使用相同的 processTimeBucket 機制

##### 3. status 驗證與自動修正
```javascript
// 驗證邏輯
if (row.status !== null && row.status !== undefined && row.status !== '') {
  const validStatuses = ['open', 'closed', 'cancelled'];
  const normalizedStatus = String(row.status).toLowerCase().trim();
  
  if (!validStatuses.includes(normalizedStatus)) {
    // 自動修正為 'open' 並記錄警告
    row.status = 'open';
    warnings.push({ 
      field: 'status', 
      fieldLabel: 'Status', 
      error: `status 值「${row.status}」不在允許範圍內（open/closed/cancelled），已自動設為 'open'`, 
      originalValue: row.status,
      type: 'warning' 
    });
  } else {
    // 標準化為小寫
    row.status = normalizedStatus;
  }
}
```

**說明：**
- 允許值：`open`, `closed`, `cancelled`（不區分大小寫）
- 自動轉換：`Open` → `open`，`CLOSED` → `closed`
- 無效值自動修正為 `open`（例如：`pending` → `open`）
- 顯示 warning 而非 error，資料仍可上傳

#### 🔄 Time Bucket 處理流程

**與 demand_fg 共用機制：**
```javascript
// src/utils/dataValidation.js Line 802
if (uploadType === 'demand_fg' || uploadType === 'po_open_lines') {
  const { time_bucket, errors: timeErrors } = processTimeBucket(cleanedRow);
  cleanedRow.time_bucket = time_bucket;
  // ...
}
```

**處理順序：**
1. 優先使用 `date`（如果有填寫）→ 轉換為 YYYY-MM-DD
2. 如果沒有 `date`，使用 `week_bucket` → 保留 YYYY-W## 格式
3. 兩者都沒有 → 錯誤：「必須填寫 week_bucket 或 date 其中一個欄位」

---

## 📦 B) inventory_snapshots 驗證規則

### 驗證函數：`validateInventorySnapshotsRules(row)`

#### ✅ 驗證項目

| 欄位 | 驗證規則 | 錯誤類型 | 處理方式 |
|-----|---------|----------|---------|
| **snapshot_date** | 必須可 parse 成 YYYY-MM-DD | 錯誤 | Schema date 類型自動驗證 |
| **onhand_qty** | 必須 >= 0 | 錯誤 | 顯示錯誤訊息 |
| **allocated_qty** | 必須 >= 0 | 錯誤 | 顯示錯誤訊息 |
| **safety_stock** | 必須 >= 0 | 錯誤 | 顯示錯誤訊息 |
| **allocated_qty** (空值) | - | 自動處理 | 設為 0 |
| **safety_stock** (空值) | - | 自動處理 | 設為 0 |
| **uom** (空值) | - | 自動處理 | 設為 'pcs' |

#### 📝 詳細說明

##### 1. snapshot_date 驗證
```javascript
// 驗證邏輯
if (!row.snapshot_date || row.snapshot_date === '') {
  errors.push({ 
    field: 'snapshot_date', 
    fieldLabel: 'Snapshot Date', 
    error: 'snapshot_date 為必填欄位', 
    originalValue: row.snapshot_date 
  });
}
```

**說明：**
- 必填欄位
- 由 Schema 的 date 類型自動驗證格式
- 支援格式：YYYY-MM-DD, DD/MM/YYYY, Excel 數字格式等

##### 2. 數量欄位驗證（onhand_qty, allocated_qty, safety_stock）
```javascript
// onhand_qty 驗證
if (row.onhand_qty !== null && row.onhand_qty !== undefined) {
  if (row.onhand_qty < 0) {
    errors.push({ 
      field: 'onhand_qty', 
      fieldLabel: 'On-hand Quantity', 
      error: 'onhand_qty 不能小於 0', 
      originalValue: row.onhand_qty 
    });
  }
}

// allocated_qty 和 safety_stock 使用相同邏輯
```

**說明：**
- 所有數量欄位都不允許負數
- 結合 Schema 的 min: 0 設定

##### 3. 預設值自動設定
```javascript
// 預設值設定
if (row.allocated_qty === null || row.allocated_qty === undefined || row.allocated_qty === '') {
  row.allocated_qty = 0;
}
if (row.safety_stock === null || row.safety_stock === undefined || row.safety_stock === '') {
  row.safety_stock = 0;
}
if (!row.uom || row.uom === '') {
  row.uom = 'pcs';
}
```

**說明：**
- 空值自動轉換，不會產生錯誤
- `allocated_qty` 空值 → 0
- `safety_stock` 空值 → 0
- `uom` 空值 → 'pcs'

---

## 💰 C) fg_financials 驗證規則

### 驗證函數：`validateFgFinancialsRules(row)`

#### ✅ 驗證項目

| 欄位 | 驗證規則 | 錯誤類型 | 處理方式 |
|-----|---------|----------|---------|
| **unit_margin** | 必填且 >= 0 | 錯誤 | 顯示錯誤訊息 |
| **unit_price** | 可空，但若有則 >= 0 | 錯誤 | 顯示錯誤訊息 |
| **currency** (空值) | - | 自動處理 | 設為 'USD' |
| **valid_from / valid_to** | 若兩者都有，必須 valid_from <= valid_to | 錯誤 | 顯示錯誤訊息 |
| **plant_id** (空值) | - | 允許 | 代表全球通用定價 |

#### 📝 詳細說明

##### 1. unit_margin 驗證
```javascript
// 驗證邏輯
if (row.unit_margin !== null && row.unit_margin !== undefined) {
  if (row.unit_margin < 0) {
    errors.push({ 
      field: 'unit_margin', 
      fieldLabel: 'Unit Margin', 
      error: 'unit_margin 不能小於 0', 
      originalValue: row.unit_margin 
    });
  }
}
```

**說明：**
- 必填欄位（Schema required: true）
- 必須 >= 0
- 額外檢查（Schema 已有 min: 0 設定）

##### 2. unit_price 驗證
```javascript
// 驗證邏輯
if (row.unit_price !== null && row.unit_price !== undefined && row.unit_price !== '') {
  if (row.unit_price < 0) {
    errors.push({ 
      field: 'unit_price', 
      fieldLabel: 'Unit Price', 
      error: 'unit_price 不能小於 0', 
      originalValue: row.unit_price 
    });
  }
}
```

**說明：**
- 選填欄位
- 如果有填寫，必須 >= 0
- 空值允許（不檢查）

##### 3. valid_from / valid_to 日期範圍驗證
```javascript
// 驗證邏輯
if (row.valid_from && row.valid_to) {
  const fromDate = new Date(row.valid_from);
  const toDate = new Date(row.valid_to);
  
  // 檢查日期是否有效
  if (!isNaN(fromDate.getTime()) && !isNaN(toDate.getTime())) {
    if (fromDate > toDate) {
      errors.push({ 
        field: 'valid_from', 
        fieldLabel: 'Valid From', 
        error: 'valid_from 不能晚於 valid_to', 
        originalValue: row.valid_from 
      });
    }
  }
}
```

**說明：**
- 僅當兩個日期都有填寫時才驗證
- 確保起始日期 <= 結束日期
- 與 bom_edge 的 valid_from/valid_to 驗證邏輯相同

##### 4. currency 預設值
```javascript
// 預設值設定
if (!row.currency || row.currency === '') {
  row.currency = 'USD';
}
```

**說明：**
- 空值自動設為 'USD'
- 不會產生錯誤

##### 5. plant_id 處理
```javascript
// plant_id 可以為空（代表全球通用定價），不需要額外驗證
```

**說明：**
- `plant_id` 為選填欄位
- 空值（NULL）代表全球通用定價（適用所有工廠）
- 有值則代表特定工廠的定價

---

## 🔄 驗證流程整合

### validateAndCleanRows 函數流程

```javascript
// Line 802-839
cleanRows.forEach((row, index) => {
  // 1. 基本欄位驗證（所有 upload types）
  schema.fields.forEach(fieldDef => {
    const { value, errors } = validateAndCleanField(originalValue, fieldDef, uploadType, row);
    // ...
  });

  // 2. 特殊處理：time_bucket（demand_fg 和 po_open_lines）
  if (uploadType === 'demand_fg' || uploadType === 'po_open_lines') {
    const { time_bucket, errors: timeErrors } = processTimeBucket(cleanedRow);
    // ...
  }

  // 3. 特殊處理：bom_edge 業務規則驗證
  if (uploadType === 'bom_edge') {
    const bomErrors = validateBomEdgeRules(cleanedRow);
    rowErrors.push(...bomErrors);
  }

  // 4. 特殊處理：po_open_lines 業務規則驗證 ✨ 新增
  if (uploadType === 'po_open_lines') {
    const poErrors = validatePoOpenLinesRules(cleanedRow);
    rowErrors.push(...poErrors);
  }

  // 5. 特殊處理：inventory_snapshots 業務規則驗證 ✨ 新增
  if (uploadType === 'inventory_snapshots') {
    const inventoryErrors = validateInventorySnapshotsRules(cleanedRow);
    rowErrors.push(...inventoryErrors);
  }

  // 6. 特殊處理：fg_financials 業務規則驗證 ✨ 新增
  if (uploadType === 'fg_financials') {
    const fgErrors = validateFgFinancialsRules(cleanedRow);
    rowErrors.push(...fgErrors);
  }

  // 7. 判斷這一行是否有效
  if (rowErrors.length === 0) {
    validRows.push(cleanedRow);
  } else {
    errorRows.push({ rowIndex, originalData, cleanedData, errors: rowErrors });
  }
});
```

---

## 📊 錯誤格式

所有驗證錯誤都使用統一格式，可直接顯示在 UI：

```javascript
{
  field: 'field_name',           // 欄位名稱（snake_case）
  fieldLabel: 'Field Label',     // 欄位標籤（使用者友善）
  error: '錯誤訊息',              // 錯誤描述
  originalValue: value,          // 原始值
  type: 'warning'                // 可選：標記為警告而非錯誤
}
```

### 範例

#### 錯誤範例
```javascript
{
  field: 'open_qty',
  fieldLabel: 'Open Quantity',
  error: 'open_qty 不能小於 0',
  originalValue: -100
}
```

#### 警告範例
```javascript
{
  field: 'status',
  fieldLabel: 'Status',
  error: 'status 值「pending」不在允許範圍內（open/closed/cancelled），已自動設為 \'open\'',
  originalValue: 'pending',
  type: 'warning'
}
```

---

## 🧪 測試場景

### po_open_lines 測試

| 場景 | 輸入值 | 預期結果 |
|-----|-------|---------|
| 正常 open_qty | `5000` | ✅ 通過 |
| 負數 open_qty | `-100` | ❌ 錯誤：「open_qty 不能小於 0」 |
| 有效 status | `OPEN` | ✅ 通過，自動轉為 `open` |
| 無效 status | `pending` | ⚠️ 警告，自動修正為 `open` |
| week_bucket | `2026-W05` | ✅ 通過，time_bucket = `2026-W05` |
| date | `2026-02-10` | ✅ 通過，time_bucket = `2026-02-10` |
| 兩者都空 | - | ❌ 錯誤：「必須填寫 week_bucket 或 date 其中一個欄位」 |

### inventory_snapshots 測試

| 場景 | 輸入值 | 預期結果 |
|-----|-------|---------|
| 正常 onhand_qty | `15000` | ✅ 通過 |
| 負數 onhand_qty | `-100` | ❌ 錯誤：「onhand_qty 不能小於 0」 |
| 空 allocated_qty | `` | ✅ 通過，自動設為 0 |
| 空 safety_stock | `` | ✅ 通過，自動設為 0 |
| 空 uom | `` | ✅ 通過，自動設為 'pcs' |
| 有效日期 | `2026-01-31` | ✅ 通過 |

### fg_financials 測試

| 場景 | 輸入值 | 預期結果 |
|-----|-------|---------|
| 正常 unit_margin | `25.50` | ✅ 通過 |
| 負數 unit_margin | `-10` | ❌ 錯誤：「unit_margin 不能小於 0」 |
| 正常 unit_price | `125.00` | ✅ 通過 |
| 負數 unit_price | `-50` | ❌ 錯誤：「unit_price 不能小於 0」 |
| 空 currency | `` | ✅ 通過，自動設為 'USD' |
| valid_from > valid_to | `2026-06-01` > `2026-01-01` | ❌ 錯誤：「valid_from 不能晚於 valid_to」 |
| 空 plant_id | `` | ✅ 通過，代表全球定價 |

---

## 📚 相關文件

- `src/utils/uploadSchemas.js` - Schema 定義
- `src/utils/dataValidation.js` - 驗證邏輯（本文件）
- `UPLOAD_SCHEMAS_EXTENSION_SUMMARY.md` - Upload Schemas 總結
- `UPLOAD_TYPES_REQUIRED_FIELDS.md` - 必填欄位快速參考

---

## 📝 修改總結

### 新增函數（3 個）
1. ✅ `validatePoOpenLinesRules(row)` - Line 577-630
2. ✅ `validateInventorySnapshotsRules(row)` - Line 632-698
3. ✅ `validateFgFinancialsRules(row)` - Line 700-755

### 修改函數
1. ✅ `validateAndCleanRows(cleanRows, uploadType)` - Line 823-839
   - 新增 po_open_lines 驗證調用
   - 新增 inventory_snapshots 驗證調用
   - 新增 fg_financials 驗證調用

### 程式碼行數變化
- **總行數變化：** +180 行
- **新增驗證函數：** +175 行
- **新增調用邏輯：** +15 行

---

**文件版本：** 1.0  
**創建日期：** 2026-01-31  
**最後更新：** 2026-01-31
