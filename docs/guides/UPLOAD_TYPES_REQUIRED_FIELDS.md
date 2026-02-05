# Upload Types - Required Fields 快速參考

## 📋 所有 Upload Types 必填欄位清單

---

### 1. goods_receipt（收貨記錄）
```javascript
[
  'supplier_name',         // 供應商名稱
  'material_code',         // 物料代碼
  'actual_delivery_date',  // 實際交貨日期
  'received_qty'           // 收貨數量
]
```

---

### 2. price_history（價格歷史）
```javascript
[
  'supplier_name',  // 供應商名稱
  'material_code',  // 物料代碼
  'order_date',     // 訂單日期
  'unit_price'      // 單價
]
```

---

### 3. supplier_master（供應商主檔）
```javascript
[
  'supplier_code',  // 供應商代碼
  'supplier_name'   // 供應商名稱
]
```

---

### 4. bom_edge（BOM 關係）
```javascript
[
  'parent_material',  // 父件料號
  'child_material',   // 子件料號
  'qty_per'           // 單位用量
]
```

---

### 5. demand_fg（成品需求）
```javascript
[
  'material_code',  // 成品料號
  'plant_id',       // 工廠代碼
  'demand_qty'      // 需求數量
  // 注意：必須填寫 week_bucket 或 date 其中一個
]
```

---

### 6. po_open_lines（採購訂單未交貨）✨ 新增
```javascript
[
  'po_number',      // 採購訂單號碼
  'po_line',        // 訂單行號
  'material_code',  // 物料代碼
  'plant_id',       // 工廠代碼
  'open_qty'        // 未交貨數量
  // 注意：必須填寫 week_bucket 或 date 其中一個
]
```

**特殊說明：**
- 支援 `week_bucket`（YYYY-W##）或 `date`（YYYY-MM-DD）
- 系統會自動填入 `time_bucket`

---

### 7. inventory_snapshots（庫存快照）✨ 新增
```javascript
[
  'material_code',  // 物料代碼
  'plant_id',       // 工廠代碼
  'snapshot_date',  // 快照日期（YYYY-MM-DD）
  'onhand_qty'      // 在庫數量
]
```

---

### 8. fg_financials（成品財務）✨ 新增
```javascript
[
  'material_code',  // 成品代碼
  'unit_margin'     // 單位利潤
]
```

**特殊說明：**
- `plant_id` 為選填，空值代表全球通用定價

---

## 🔢 數字欄位驗證規則

### goods_receipt
- `received_qty` ≥ 0
- `rejected_qty` ≥ 0 (選填)

### price_history
- `unit_price` ≥ 0
- `quantity` ≥ 0 (選填)

### bom_edge
- `qty_per` > 0 (必須大於 0)
- `scrap_rate`: 0 ≤ x < 1 (選填)
- `yield_rate`: 0 < x ≤ 1 (選填)
- `priority` ≥ 1 (選填)
- `mix_ratio`: 0 < x ≤ 1 (選填)

### demand_fg
- `demand_qty` ≥ 0
- `priority` ≥ 1 (選填)

### po_open_lines ✨
- `open_qty` ≥ 0

### inventory_snapshots ✨
- `onhand_qty` ≥ 0
- `allocated_qty` ≥ 0 (選填)
- `safety_stock` ≥ 0 (選填)

### fg_financials ✨
- `unit_margin` ≥ 0
- `unit_price` ≥ 0 (選填)

---

## 📅 日期欄位格式要求

### 統一格式：YYYY-MM-DD

**範例：**
- `2026-01-31` ✅ 正確
- `2026/01/31` ❌ 錯誤
- `01-31-2026` ❌ 錯誤
- `31/01/2026` ❌ 錯誤

### 週別格式：YYYY-W##

**範例：**
- `2026-W05` ✅ 正確
- `2026-W5` ✅ 正確（單位數可以不補零）
- `2026W05` ❌ 錯誤（缺少連字號）
- `W05-2026` ❌ 錯誤（順序錯誤）

---

## 🎯 Time Bucket 特殊處理

### 支援的 Upload Types
- `demand_fg`
- `po_open_lines`

### 填寫規則
**二選一（至少填一個）：**
1. `week_bucket` - 週別格式（YYYY-W##）
2. `date` - 日期格式（YYYY-MM-DD）

**系統行為：**
- 優先使用 `date`（如果有填寫）
- 如果沒有 `date`，則使用 `week_bucket`
- 自動填入 `time_bucket` 欄位
- 兩者都沒填會報錯：「必須填寫 week_bucket 或 date 其中一個欄位」

**範例：**
```csv
# 使用週別
material_code,plant_id,week_bucket,demand_qty
FG-001,PLANT-01,2026-W05,1000

# 使用日期
material_code,plant_id,date,demand_qty
FG-001,PLANT-01,2026-02-10,1000

# 兩者都填（date 優先）
material_code,plant_id,week_bucket,date,demand_qty
FG-001,PLANT-01,2026-W05,2026-02-10,1000
# → time_bucket = 2026-02-10
```

---

## 📊 完整對照表

| Upload Type | Required Fields Count | 數字欄位 | 日期欄位 | 特殊處理 |
|------------|----------------------|---------|---------|---------|
| goods_receipt | 4 | 1 | 1 | - |
| price_history | 4 | 1 | 1 | - |
| supplier_master | 2 | 0 | 0 | - |
| bom_edge | 3 | 1 | 0 | - |
| demand_fg | 3 | 1 | 0 | time_bucket |
| **po_open_lines** | **5** | **1** | **0** | **time_bucket** |
| **inventory_snapshots** | **4** | **1** | **1** | - |
| **fg_financials** | **2** | **1** | **0** | - |

---

## 💡 使用技巧

### 1. 檢查必填欄位
```javascript
import { getRequiredFields } from '@/utils/uploadSchemas';

const required = getRequiredFields('po_open_lines');
console.log(required);
// ['po_number', 'po_line', 'material_code', 'plant_id', 'open_qty']
```

### 2. 驗證數據完整性
- 確保所有必填欄位都有值
- 空字串、NULL、undefined 都視為未填寫
- 數字 0 是有效值（如果符合 min 條件）

### 3. 日期格式檢查
- 使用 `YYYY-MM-DD` 格式
- Excel 日期會自動轉換
- 手動輸入請確認格式正確

---

## 🚨 常見錯誤

### 1. 必填欄位未填寫
```
❌ 錯誤：material_code 欄位為空
✅ 解決：確保該欄位有值
```

### 2. 數字欄位格式錯誤
```
❌ 錯誤：open_qty = "abc"（非數字）
✅ 解決：填入有效數字，例如：5000
```

### 3. 日期格式錯誤
```
❌ 錯誤：snapshot_date = "2026/01/31"
✅ 解決：使用正確格式 "2026-01-31"
```

### 4. Time Bucket 未填寫
```
❌ 錯誤：week_bucket 和 date 都沒填
✅ 解決：至少填寫其中一個
```

### 5. 數字範圍錯誤
```
❌ 錯誤：open_qty = -100（負數）
✅ 解決：填入 >= 0 的數字
```

---

## 📚 相關文件

- `UPLOAD_SCHEMAS_EXTENSION_SUMMARY.md` - 完整實作說明
- `NEW_TEMPLATES_GUIDE.md` - 模板使用指南
- `src/utils/uploadSchemas.js` - Schema 定義原始碼

---

**最後更新：** 2026-01-31
