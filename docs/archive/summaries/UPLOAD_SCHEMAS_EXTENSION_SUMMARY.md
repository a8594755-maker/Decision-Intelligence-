# Upload Schemas Extension - 實作總結

## 📋 概述

本次更新為 SmartOps 系統新增了 3 種資料上傳類型，支援採購訂單、庫存快照和成品財務資料的上傳功能。

---

## 📁 修改檔案清單

### 1. **src/utils/uploadSchemas.js**
- **新增 3 個 upload type 定義**
  - `po_open_lines` - 採購訂單未交貨明細
  - `inventory_snapshots` - 庫存快照
  - `fg_financials` - 成品財務數據
- **遵循現有風格**（與 `bom_edge` 和 `demand_fg` 一致）

### 2. **src/views/EnhancedExternalSystemsView.jsx**
- **更新 `targetTableMap`**
  - 新增 3 個映射：upload type → database table
  - `'po_open_lines': 'po_open_lines'`
  - `'inventory_snapshots': 'inventory_snapshots'`
  - `'fg_financials': 'fg_financials'`

### 3. **src/utils/dataValidation.js**
- **擴充 `processTimeBucket` 支援**
  - 原本只支援 `demand_fg`
  - 現在也支援 `po_open_lines`
  - 自動從 `week_bucket` 或 `date` 填入 `time_bucket`

### 4. **src/services/importHistoryService.js**
- **更新 `getBatchData` 函數**
  - 新增 5 個 case（含現有的 bom_edges, demand_fg）
  - 支援批次資料查詢
- **更新 `getBatchDataWithFilters` 函數**
  - 新增 5 個 case（含現有的 bom_edges, demand_fg）
  - 支援帶篩選條件的批次資料查詢

---

## 🎯 新增的 Upload Types 詳細規格

### 1️⃣ po_open_lines（採購訂單未交貨明細）

**用途：** 追蹤採購訂單的未交貨數量，用於供應鏈計劃

#### Required Fields（必填欄位）
```javascript
[
  'po_number',      // 採購訂單號碼
  'po_line',        // 訂單行號
  'material_code',  // 物料代碼
  'plant_id',       // 工廠代碼
  'open_qty'        // 未交貨數量
  // 注意：time_bucket 透過 week_bucket 或 date 自動填入
]
```

#### Optional Fields（選填欄位）
```javascript
[
  'week_bucket',   // 週別（YYYY-W##）- 與 date 二選一
  'date',          // 日期（YYYY-MM-DD）- 與 week_bucket 二選一
  'time_bucket',   // 時間桶（自動填入）
  'uom',           // 計量單位（預設 'pcs'）
  'supplier_id',   // 供應商代碼
  'status',        // 狀態（預設 'open'）
  'notes'          // 備註
]
```

#### 數字欄位
- `open_qty` (min: 0)

#### 日期欄位
- `date` (格式: YYYY-MM-DD)

#### 特殊處理
- 支援 `week_bucket` 或 `date` → 自動填入 `time_bucket`
- 週別格式：`YYYY-W##`（例如：2026-W05）
- 日期格式：`YYYY-MM-DD`（例如：2026-02-10）

#### Database Mapping
- Upload Type: `po_open_lines`
- Target Table: `po_open_lines`

---

### 2️⃣ inventory_snapshots（庫存快照）

**用途：** 記錄特定時間點的庫存狀態

#### Required Fields（必填欄位）
```javascript
[
  'material_code',  // 物料代碼
  'plant_id',       // 工廠代碼
  'snapshot_date',  // 快照日期
  'onhand_qty'      // 在庫數量
]
```

#### Optional Fields（選填欄位）
```javascript
[
  'allocated_qty',  // 已分配數量（預設 0）
  'safety_stock',   // 安全庫存（預設 0）
  'uom',            // 計量單位（預設 'pcs'）
  'notes'           // 備註
]
```

#### 數字欄位
- `onhand_qty` (min: 0)
- `allocated_qty` (min: 0, default: 0)
- `safety_stock` (min: 0, default: 0)

#### 日期欄位
- `snapshot_date` (格式: YYYY-MM-DD)

#### Database Mapping
- Upload Type: `inventory_snapshots`
- Target Table: `inventory_snapshots`

---

### 3️⃣ fg_financials（成品財務數據）

**用途：** 定義成品的財務資訊（售價、利潤）

#### Required Fields（必填欄位）
```javascript
[
  'material_code',  // 成品代碼
  'unit_margin'     // 單位利潤
]
```

#### Optional Fields（選填欄位）
```javascript
[
  'plant_id',       // 工廠代碼（空值 = 全球通用定價）
  'unit_price',     // 單位售價
  'currency',       // 幣別（預設 'USD'）
  'valid_from',     // 有效起始日
  'valid_to',       // 有效結束日
  'notes'           // 備註
]
```

#### 數字欄位
- `unit_margin` (min: 0)
- `unit_price` (min: 0)

#### 日期欄位
- `valid_from` (格式: YYYY-MM-DD)
- `valid_to` (格式: YYYY-MM-DD)

#### 特殊處理
- `plant_id` 可為空值，代表全球通用定價（適用所有工廠）

#### Database Mapping
- Upload Type: `fg_financials`
- Target Table: `fg_financials`

---

## 🔄 Time Bucket 自動處理機制

### 支援的 Upload Types
- `demand_fg`（原有）
- `po_open_lines`（新增）

### 處理邏輯
```javascript
// 優先順序：date > week_bucket
if (date) {
  time_bucket = parseDate(date);  // YYYY-MM-DD
} else if (week_bucket) {
  time_bucket = week_bucket;      // YYYY-W##
} else {
  error: '必須填寫 week_bucket 或 date 其中一個欄位';
}
```

### 週別格式驗證
- Pattern: `/^\d{4}-W\d{1,2}$/`
- 範例：`2026-W05`, `2026-W52`, `2026-W1`

---

## 📊 Target Table Mapping 完整列表

| Upload Type | Target Table | 用途 |
|------------|--------------|------|
| `goods_receipt` | `goods_receipts` | 收貨記錄 |
| `price_history` | `price_history` | 價格歷史 |
| `supplier_master` | `suppliers` | 供應商主檔 |
| `bom_edge` | `bom_edges` | BOM 關係 |
| `demand_fg` | `demand_fg` | 成品需求 |
| **`po_open_lines`** | **`po_open_lines`** | **採購訂單未交貨** ✨ |
| **`inventory_snapshots`** | **`inventory_snapshots`** | **庫存快照** ✨ |
| **`fg_financials`** | **`fg_financials`** | **成品財務** ✨ |

---

## 🔍 Import History Service 查詢支援

### getBatchData（預覽查詢）

**新增支援：**
```javascript
case 'bom_edges':
  // 按 parent_material 排序，限制 50 筆

case 'demand_fg':
  // 按 material_code 排序，限制 50 筆

case 'po_open_lines':
  // 按 po_number 排序，限制 50 筆

case 'inventory_snapshots':
  // 按 material_code 排序，限制 50 筆

case 'fg_financials':
  // 按 material_code 排序，限制 50 筆
```

### getBatchDataWithFilters（帶篩選條件查詢）

**新增支援的篩選條件：**

#### bom_edges
- `parent_material` (ILIKE)
- `child_material` (ILIKE)
- `plant_id` (ILIKE)

#### demand_fg
- `material_code` (ILIKE)
- `plant_id` (ILIKE)
- `time_bucket` (ILIKE)

#### po_open_lines
- `po_number` (ILIKE)
- `material_code` (ILIKE)
- `plant_id` (ILIKE)
- `time_bucket` (ILIKE)

#### inventory_snapshots
- `material_code` (ILIKE)
- `plant_id` (ILIKE)
- `snapshot_date` (EXACT)

#### fg_financials
- `material_code` (ILIKE)
- `plant_id` (ILIKE)
- `currency` (EXACT)

---

## ✅ 實作檢查清單

- [x] 新增 3 個 upload type 至 `uploadSchemas.js`
- [x] 遵循現有風格（與 bom_edge/demand_fg 一致）
- [x] 定義所有欄位（snake_case）
- [x] 標記 required fields
- [x] 定義數字欄位（含 min/max）
- [x] 定義日期欄位
- [x] 更新 `targetTableMap`（EnhancedExternalSystemsView.jsx）
- [x] 支援 time_bucket 自動處理（po_open_lines）
- [x] 更新 `getBatchData`（importHistoryService.js）
- [x] 更新 `getBatchDataWithFilters`（importHistoryService.js）
- [x] 創建本總結文件

---

## 🧪 測試建議

### 1. 上傳測試
使用模板檔案測試上傳功能：
- `templates/po_open_lines.xlsx`
- `templates/inventory_snapshots.xlsx`
- `templates/fg_financials.xlsx`

### 2. 驗證測試

#### po_open_lines
- ✅ 測試 week_bucket 自動填入 time_bucket
- ✅ 測試 date 自動填入 time_bucket
- ✅ 測試 open_qty >= 0 驗證
- ✅ 測試必填欄位驗證

#### inventory_snapshots
- ✅ 測試 snapshot_date 日期格式驗證
- ✅ 測試 onhand_qty >= 0 驗證
- ✅ 測試 allocated_qty/safety_stock 預設值

#### fg_financials
- ✅ 測試 unit_margin >= 0 驗證
- ✅ 測試 plant_id 空值（全球定價）
- ✅ 測試 valid_from/valid_to 日期格式

### 3. Import History 測試
- ✅ 測試批次資料預覽
- ✅ 測試篩選功能
- ✅ 測試資料匯出

---

## 📚 相關文件

### 模板檔案
- `templates/po_open_lines.xlsx` / `.csv`
- `templates/inventory_snapshots.xlsx` / `.csv`
- `templates/fg_financials.xlsx` / `.csv`
- `NEW_TEMPLATES_GUIDE.md` - 模板使用說明

### Database Schema
- `database/step1_supply_inventory_financials_schema.sql`
- `database/STEP1_SCHEMA_DEPLOYMENT_GUIDE.md`
- `database/STEP1_SCHEMA_QUICK_REFERENCE.md`

### 前端代碼
- `src/utils/uploadSchemas.js` - Schema 定義
- `src/utils/dataValidation.js` - 驗證邏輯
- `src/views/EnhancedExternalSystemsView.jsx` - 上傳介面
- `src/services/importHistoryService.js` - 資料查詢服務

---

## 💡 使用範例

### po_open_lines 上傳範例
```csv
po_number,po_line,material_code,plant_id,week_bucket,open_qty,supplier_id,status
PO-10001,10,COMP-3100,PLANT-01,2026-W05,5000,SUP-001,open
PO-10001,20,RM-9000,PLANT-01,2026-W06,3500,SUP-001,open
```

### inventory_snapshots 上傳範例
```csv
material_code,plant_id,snapshot_date,onhand_qty,allocated_qty,safety_stock
COMP-3100,PLANT-01,2026-01-31,15000,8000,5000
RM-9000,PLANT-01,2026-01-31,12500,3000,2000
```

### fg_financials 上傳範例
```csv
material_code,unit_margin,plant_id,unit_price,currency,valid_from,valid_to
FG-2000,25.50,PLANT-01,125.00,USD,2026-01-01,2026-06-30
FG-2100,30.00,,150.00,USD,2026-01-01,2026-12-31
```

---

## 🔧 Utility Functions 使用方式

```javascript
import { 
  getRequiredFields, 
  getOptionalFields, 
  getAllFields 
} from '@/utils/uploadSchemas';

// 取得必填欄位
const requiredFields = getRequiredFields('po_open_lines');
// ['po_number', 'po_line', 'material_code', 'plant_id', 'open_qty']

// 取得選填欄位
const optionalFields = getOptionalFields('inventory_snapshots');
// ['allocated_qty', 'safety_stock', 'uom', 'notes']

// 取得所有欄位
const allFields = getAllFields('fg_financials');
// ['material_code', 'unit_margin', 'plant_id', ...]
```

---

## 📝 更新紀錄

### 2026-01-31
- ✅ 新增 3 種 upload type
- ✅ 整合 time_bucket 自動處理
- ✅ 更新資料查詢服務
- ✅ 完成前後端整合

---

**文件版本：** 1.0  
**創建日期：** 2026-01-31  
**作者：** SmartOps 開發團隊
