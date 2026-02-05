# Upload Schemas Extension - 修改 Diff

## 📝 修改檔案總覽

本次更新共修改 **4 個檔案**，新增 **2 個文件**：

### 修改的檔案
1. ✅ `src/utils/uploadSchemas.js`
2. ✅ `src/views/EnhancedExternalSystemsView.jsx`
3. ✅ `src/utils/dataValidation.js`
4. ✅ `src/services/importHistoryService.js`

### 新增的文件
5. ✅ `UPLOAD_SCHEMAS_EXTENSION_SUMMARY.md`
6. ✅ `UPLOAD_TYPES_REQUIRED_FIELDS.md`

---

## 📄 1. src/utils/uploadSchemas.js

### 位置：Line 593-838（新增 246 行）

**新增內容：**
```javascript
  // PO Open Lines - Purchase order open lines table
  po_open_lines: {
    label: 'PO Open Lines',
    description: 'Purchase order open lines (supply commitments)',
    icon: '📋',
    fields: [
      // 5 個必填欄位
      { key: 'po_number', required: true, type: 'string' },
      { key: 'po_line', required: true, type: 'string' },
      { key: 'material_code', required: true, type: 'string' },
      { key: 'plant_id', required: true, type: 'string' },
      { key: 'open_qty', required: true, type: 'number', min: 0 },
      
      // Time bucket 欄位（與 demand_fg 相同設計）
      { key: 'week_bucket', required: false, type: 'string' },
      { key: 'date', required: false, type: 'date' },
      { key: 'time_bucket', required: false, type: 'string' },
      
      // 4 個選填欄位
      { key: 'uom', required: false, default: 'pcs' },
      { key: 'supplier_id', required: false },
      { key: 'status', required: false, default: 'open' },
      { key: 'notes', required: false }
    ]
  },

  // Inventory Snapshots - Inventory snapshot table
  inventory_snapshots: {
    label: 'Inventory Snapshots',
    description: 'Inventory snapshot data (on-hand inventory by date)',
    icon: '📦',
    fields: [
      // 4 個必填欄位
      { key: 'material_code', required: true, type: 'string' },
      { key: 'plant_id', required: true, type: 'string' },
      { key: 'snapshot_date', required: true, type: 'date' },
      { key: 'onhand_qty', required: true, type: 'number', min: 0 },
      
      // 4 個選填欄位
      { key: 'allocated_qty', required: false, type: 'number', min: 0, default: 0 },
      { key: 'safety_stock', required: false, type: 'number', min: 0, default: 0 },
      { key: 'uom', required: false, default: 'pcs' },
      { key: 'notes', required: false }
    ]
  },

  // FG Financials - Finished goods financial data
  fg_financials: {
    label: 'FG Financials',
    description: 'Finished goods financial data (pricing and margin)',
    icon: '💵',
    fields: [
      // 2 個必填欄位
      { key: 'material_code', required: true, type: 'string' },
      { key: 'unit_margin', required: true, type: 'number', min: 0 },
      
      // 6 個選填欄位
      { key: 'plant_id', required: false },
      { key: 'unit_price', required: false, type: 'number', min: 0 },
      { key: 'currency', required: false, default: 'USD' },
      { key: 'valid_from', required: false, type: 'date' },
      { key: 'valid_to', required: false, type: 'date' },
      { key: 'notes', required: false }
    ]
  }
```

**修改說明：**
- ✅ 完全遵循現有風格（與 bom_edge 和 demand_fg 一致）
- ✅ 使用 snake_case 命名
- ✅ 完整的欄位定義（label, type, description）
- ✅ 明確標記 required fields
- ✅ 數字欄位設定 min 約束
- ✅ 日期欄位標記為 'date' type
- ✅ po_open_lines 支援 time_bucket 機制

---

## 📄 2. src/views/EnhancedExternalSystemsView.jsx

### 位置：Line 626-635（修改 targetTableMap）

**修改前：**
```javascript
const targetTableMap = {
  'goods_receipt': 'goods_receipts',
  'price_history': 'price_history',
  'supplier_master': 'suppliers',
  'bom_edge': 'bom_edges',
  'demand_fg': 'demand_fg'
};
```

**修改後：**
```javascript
const targetTableMap = {
  'goods_receipt': 'goods_receipts',
  'price_history': 'price_history',
  'supplier_master': 'suppliers',
  'bom_edge': 'bom_edges',
  'demand_fg': 'demand_fg',
  'po_open_lines': 'po_open_lines',          // ✨ 新增
  'inventory_snapshots': 'inventory_snapshots', // ✨ 新增
  'fg_financials': 'fg_financials'            // ✨ 新增
};
```

**修改說明：**
- ✅ 新增 3 個 upload type 到 database table 的映射
- ✅ 所有新增的表名都與 upload type 同名（簡化設計）

---

## 📄 3. src/utils/dataValidation.js

### 位置：Line 618-632（修改條件判斷）

**修改前：**
```javascript
// 特殊處理：demand_fg 的時間欄位
if (uploadType === 'demand_fg') {
  const { time_bucket, errors: timeErrors } = processTimeBucket(cleanedRow);
  cleanedRow.time_bucket = time_bucket;
  if (timeErrors.length > 0) {
    timeErrors.forEach(error => {
      rowErrors.push({
        field: 'time_bucket',
        fieldLabel: 'Time Bucket',
        error,
        originalValue: cleanedRow.week_bucket || cleanedRow.date
      });
    });
  }
}
```

**修改後：**
```javascript
// 特殊處理：demand_fg 和 po_open_lines 的時間欄位
if (uploadType === 'demand_fg' || uploadType === 'po_open_lines') { // ✨ 新增 po_open_lines
  const { time_bucket, errors: timeErrors } = processTimeBucket(cleanedRow);
  cleanedRow.time_bucket = time_bucket;
  if (timeErrors.length > 0) {
    timeErrors.forEach(error => {
      rowErrors.push({
        field: 'time_bucket',
        fieldLabel: 'Time Bucket',
        error,
        originalValue: cleanedRow.week_bucket || cleanedRow.date
      });
    });
  }
}
```

**修改說明：**
- ✅ 擴充 `processTimeBucket` 支援 `po_open_lines`
- ✅ 保持與 `demand_fg` 相同的處理邏輯
- ✅ 自動從 `week_bucket` 或 `date` 填入 `time_bucket`

---

## 📄 4. src/services/importHistoryService.js

### 修改 A：getBatchData 函數（Line 183-240）

**新增 5 個 case：**

```javascript
case 'bom_edges':
  query = supabase
    .from('bom_edges')
    .select('*')
    .eq('batch_id', batchId)
    .order('parent_material', { ascending: true })
    .limit(limit);
  break;
  
case 'demand_fg':
  query = supabase
    .from('demand_fg')
    .select('*')
    .eq('batch_id', batchId)
    .order('material_code', { ascending: true })
    .limit(limit);
  break;
  
case 'po_open_lines':         // ✨ 新增
  query = supabase
    .from('po_open_lines')
    .select('*')
    .eq('batch_id', batchId)
    .order('po_number', { ascending: true })
    .limit(limit);
  break;
  
case 'inventory_snapshots':   // ✨ 新增
  query = supabase
    .from('inventory_snapshots')
    .select('*')
    .eq('batch_id', batchId)
    .order('material_code', { ascending: true })
    .limit(limit);
  break;
  
case 'fg_financials':         // ✨ 新增
  query = supabase
    .from('fg_financials')
    .select('*')
    .eq('batch_id', batchId)
    .order('material_code', { ascending: true })
    .limit(limit);
  break;
```

---

### 修改 B：getBatchDataWithFilters 函數（Line 495-653）

**新增 5 個完整的查詢處理：**

#### bom_edges
```javascript
case 'bom_edges':
  query = supabase.from('bom_edges')
    .select('*')
    .eq('user_id', userId)
    .eq('batch_id', batchId);
  
  // 篩選條件
  filters: parent_material, child_material, plant_id
  
  query.order('parent_material', { ascending: true });
```

#### demand_fg
```javascript
case 'demand_fg':
  query = supabase.from('demand_fg')
    .select('*')
    .eq('user_id', userId)
    .eq('batch_id', batchId);
  
  // 篩選條件
  filters: material_code, plant_id, time_bucket
  
  query.order('material_code', { ascending: true });
```

#### po_open_lines ✨
```javascript
case 'po_open_lines':
  query = supabase.from('po_open_lines')
    .select('*')
    .eq('user_id', userId)
    .eq('batch_id', batchId);
  
  // 篩選條件
  filters: po_number, material_code, plant_id, time_bucket
  
  query.order('po_number', { ascending: true });
```

#### inventory_snapshots ✨
```javascript
case 'inventory_snapshots':
  query = supabase.from('inventory_snapshots')
    .select('*')
    .eq('user_id', userId)
    .eq('batch_id', batchId);
  
  // 篩選條件
  filters: material_code, plant_id, snapshot_date (EXACT)
  
  query.order('material_code', { ascending: true });
```

#### fg_financials ✨
```javascript
case 'fg_financials':
  query = supabase.from('fg_financials')
    .select('*')
    .eq('user_id', userId)
    .eq('batch_id', batchId);
  
  // 篩選條件
  filters: material_code, plant_id, currency (EXACT)
  
  query.order('material_code', { ascending: true });
```

**修改說明：**
- ✅ 所有新表都包含完整的查詢邏輯
- ✅ 支援 RLS（user_id 過濾）
- ✅ 支援 batch_id 過濾
- ✅ 支援常用欄位的篩選條件
- ✅ 適當的排序（按業務邏輯）

---

## 📊 必填欄位總結

### po_open_lines
```javascript
[
  'po_number',      // text
  'po_line',        // text
  'material_code',  // text
  'plant_id',       // text
  'open_qty'        // number >= 0
  // time_bucket 透過 week_bucket 或 date 自動填入
]
```

### inventory_snapshots
```javascript
[
  'material_code',  // text
  'plant_id',       // text
  'snapshot_date',  // date (YYYY-MM-DD)
  'onhand_qty'      // number >= 0
]
```

### fg_financials
```javascript
[
  'material_code',  // text
  'unit_margin'     // number >= 0
]
```

---

## ✅ 驗證檢查清單

### uploadSchemas.js
- [x] 新增 3 個 upload type 定義
- [x] 遵循現有風格（與 bom_edge/demand_fg 一致）
- [x] 欄位使用 snake_case
- [x] 明確標記 required fields
- [x] 數字欄位設定 min 約束
- [x] 日期欄位標記為 'date' type
- [x] po_open_lines 支援 time_bucket

### EnhancedExternalSystemsView.jsx
- [x] 更新 targetTableMap
- [x] 新增 3 個映射

### dataValidation.js
- [x] 擴充 processTimeBucket 支援
- [x] 新增 po_open_lines 條件

### importHistoryService.js
- [x] getBatchData: 新增 5 個 case
- [x] getBatchDataWithFilters: 新增 5 個完整處理
- [x] 包含適當的篩選條件
- [x] 包含適當的排序邏輯

### 文件
- [x] 創建實作總結文件
- [x] 創建 required fields 快速參考
- [x] 創建本 diff 文件

---

## 🧪 測試建議

### 1. Schema 驗證測試
```javascript
import { getRequiredFields, getAllFields } from '@/utils/uploadSchemas';

// 測試 po_open_lines
console.log(getRequiredFields('po_open_lines'));
// 預期: ['po_number', 'po_line', 'material_code', 'plant_id', 'open_qty']

// 測試 inventory_snapshots
console.log(getRequiredFields('inventory_snapshots'));
// 預期: ['material_code', 'plant_id', 'snapshot_date', 'onhand_qty']

// 測試 fg_financials
console.log(getRequiredFields('fg_financials'));
// 預期: ['material_code', 'unit_margin']
```

### 2. 上傳測試
- 使用 `templates/po_open_lines.xlsx` 測試上傳
- 使用 `templates/inventory_snapshots.xlsx` 測試上傳
- 使用 `templates/fg_financials.xlsx` 測試上傳

### 3. Time Bucket 測試
- 測試 po_open_lines 的 week_bucket 自動填入
- 測試 po_open_lines 的 date 自動填入
- 測試兩者都填的優先順序（date 優先）

### 4. 資料查詢測試
- 測試批次資料預覽
- 測試篩選功能
- 測試排序功能

---

## 📚 相關文件

- `UPLOAD_SCHEMAS_EXTENSION_SUMMARY.md` - 完整實作總結
- `UPLOAD_TYPES_REQUIRED_FIELDS.md` - 必填欄位快速參考
- `NEW_TEMPLATES_GUIDE.md` - 模板使用指南
- `database/STEP1_SCHEMA_DEPLOYMENT_GUIDE.md` - 資料庫部署指南

---

**文件版本：** 1.0  
**創建日期：** 2026-01-31  
**最後更新：** 2026-01-31
