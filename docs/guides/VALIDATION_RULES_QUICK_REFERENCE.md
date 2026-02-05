# Validation Rules Quick Reference - 驗證規則快速參考

## 📋 三種 Upload Types 驗證規則對照表

---

## 🎯 A) po_open_lines

| 欄位 | 類型 | 必填 | 驗證規則 | 預設值 | 錯誤訊息 |
|-----|------|------|---------|--------|---------|
| `po_number` | string | ✅ | - | - | 必填欄位 |
| `po_line` | string | ✅ | - | - | 必填欄位 |
| `material_code` | string | ✅ | - | - | 必填欄位 |
| `plant_id` | string | ✅ | - | - | 必填欄位 |
| `open_qty` | number | ✅ | **>= 0** | - | open_qty 不能小於 0 |
| `week_bucket` | string | 與 date 二選一 | YYYY-W## | - | 週桶格式不正確 |
| `date` | date | 與 week_bucket 二選一 | YYYY-MM-DD | - | 日期格式不正確 |
| `time_bucket` | string | 自動填入 | **必須存在** | - | 必須填寫 week_bucket 或 date |
| `uom` | string | ❌ | - | **'pcs'** | - |
| `supplier_id` | string | ❌ | - | - | - |
| `status` | string | ❌ | **open/closed/cancelled** | **'open'** | ⚠️ 自動修正為 'open' |
| `notes` | string | ❌ | - | - | - |

### 🔍 特殊處理
- **time_bucket 自動處理：** 優先使用 `date`，若無則使用 `week_bucket`
- **status 自動修正：** 無效值（如 `pending`）自動改為 `open`，產生 warning 而非 error

---

## 📦 B) inventory_snapshots

| 欄位 | 類型 | 必填 | 驗證規則 | 預設值 | 錯誤訊息 |
|-----|------|------|---------|--------|---------|
| `material_code` | string | ✅ | - | - | 必填欄位 |
| `plant_id` | string | ✅ | - | - | 必填欄位 |
| `snapshot_date` | date | ✅ | YYYY-MM-DD | - | snapshot_date 為必填欄位 / 日期格式不正確 |
| `onhand_qty` | number | ✅ | **>= 0** | - | onhand_qty 不能小於 0 |
| `allocated_qty` | number | ❌ | **>= 0** | **0** | allocated_qty 不能小於 0 |
| `safety_stock` | number | ❌ | **>= 0** | **0** | safety_stock 不能小於 0 |
| `uom` | string | ❌ | - | **'pcs'** | - |
| `notes` | string | ❌ | - | - | - |

### 🔍 特殊處理
- **空值自動轉換：** `allocated_qty` 和 `safety_stock` 空值自動設為 0
- **uom 預設值：** 空值自動設為 'pcs'

---

## 💰 C) fg_financials

| 欄位 | 類型 | 必填 | 驗證規則 | 預設值 | 錯誤訊息 |
|-----|------|------|---------|--------|---------|
| `material_code` | string | ✅ | - | - | 必填欄位 |
| `unit_margin` | number | ✅ | **>= 0** | - | unit_margin 不能小於 0 |
| `plant_id` | string | ❌ | - | - | 空值代表全球通用定價 |
| `unit_price` | number | ❌ | **>= 0** (若填) | - | unit_price 不能小於 0 |
| `currency` | string | ❌ | - | **'USD'** | - |
| `valid_from` | date | ❌ | **<= valid_to** | - | valid_from 不能晚於 valid_to |
| `valid_to` | date | ❌ | **>= valid_from** | - | - |
| `notes` | string | ❌ | - | - | - |

### 🔍 特殊處理
- **日期範圍驗證：** 若 `valid_from` 和 `valid_to` 都有填，必須 `valid_from <= valid_to`
- **currency 預設值：** 空值自動設為 'USD'
- **plant_id 空值：** 代表全球通用定價（適用所有工廠）

---

## 🔄 驗證執行順序

### 1️⃣ 基本欄位驗證（所有 upload types）
```
schema.fields.forEach(fieldDef => {
  validateAndCleanField(value, fieldDef, uploadType, row)
})
```
- 檢查必填欄位
- 類型轉換（string, number, date, boolean）
- 數值範圍檢查（min, max）

### 2️⃣ time_bucket 處理（demand_fg 和 po_open_lines）
```
processTimeBucket(cleanedRow)
```
- 從 `week_bucket` 或 `date` 自動填入 `time_bucket`
- 優先順序：date > week_bucket

### 3️⃣ 業務規則驗證（各 upload type）
```
if (uploadType === 'po_open_lines') {
  validatePoOpenLinesRules(cleanedRow)
}
if (uploadType === 'inventory_snapshots') {
  validateInventorySnapshotsRules(cleanedRow)
}
if (uploadType === 'fg_financials') {
  validateFgFinancialsRules(cleanedRow)
}
```

---

## ✅ 驗證結果類型

### 錯誤（Error）
- 阻止資料上傳
- 必須修正才能繼續
- 顯示紅色錯誤訊息

**範例：**
```javascript
{
  field: 'open_qty',
  fieldLabel: 'Open Quantity',
  error: 'open_qty 不能小於 0',
  originalValue: -100
}
```

### 警告（Warning）
- 不阻止資料上傳
- 資料已自動修正
- 顯示黃色警告訊息

**範例：**
```javascript
{
  field: 'status',
  fieldLabel: 'Status',
  error: 'status 值「pending」不在允許範圍內，已自動設為 \'open\'',
  originalValue: 'pending',
  type: 'warning'
}
```

---

## 🧪 測試矩陣

### ✅ 通過測試

| Upload Type | 欄位 | 測試值 | 結果 |
|------------|------|--------|------|
| po_open_lines | open_qty | 5000 | ✅ |
| po_open_lines | status | OPEN | ✅ 自動轉為 `open` |
| po_open_lines | week_bucket | 2026-W05 | ✅ time_bucket = `2026-W05` |
| inventory_snapshots | onhand_qty | 15000 | ✅ |
| inventory_snapshots | allocated_qty | (空) | ✅ 自動設為 0 |
| fg_financials | unit_margin | 25.50 | ✅ |
| fg_financials | plant_id | (空) | ✅ 全球定價 |
| fg_financials | currency | (空) | ✅ 自動設為 USD |

### ❌ 失敗測試

| Upload Type | 欄位 | 測試值 | 錯誤訊息 |
|------------|------|--------|---------|
| po_open_lines | open_qty | -100 | open_qty 不能小於 0 |
| po_open_lines | time_bucket | - | 必須填寫 week_bucket 或 date |
| inventory_snapshots | onhand_qty | -50 | onhand_qty 不能小於 0 |
| inventory_snapshots | safety_stock | -10 | safety_stock 不能小於 0 |
| fg_financials | unit_margin | -5 | unit_margin 不能小於 0 |
| fg_financials | valid_from/to | 2026-06-01 / 2026-01-01 | valid_from 不能晚於 valid_to |

### ⚠️ 警告測試

| Upload Type | 欄位 | 測試值 | 警告訊息 | 修正值 |
|------------|------|--------|---------|-------|
| po_open_lines | status | pending | 不在允許範圍內 | open |
| po_open_lines | status | Processing | 不在允許範圍內 | open |
| po_open_lines | status | CANCELLED | - | cancelled（小寫） |

---

## 📊 驗證覆蓋率

| Upload Type | 必填欄位驗證 | 數值範圍驗證 | 日期格式驗證 | 業務規則驗證 | 自動修正 |
|------------|------------|------------|------------|------------|---------|
| **po_open_lines** | ✅ 5 個 | ✅ open_qty | ✅ date | ✅ time_bucket<br>✅ status | ✅ status → open |
| **inventory_snapshots** | ✅ 4 個 | ✅ 3 個數量欄位 | ✅ snapshot_date | ✅ 預設值設定 | ✅ 空值 → 0 或 'pcs' |
| **fg_financials** | ✅ 2 個 | ✅ 2 個金額欄位 | ✅ valid_from/to | ✅ 日期範圍 | ✅ currency → USD |

---

## 💡 使用建議

### 1. 上傳前檢查
- 確保必填欄位都有值
- 檢查數值欄位是否為負數
- 確認日期格式正確（YYYY-MM-DD）

### 2. 理解自動修正
- `status` 無效值會自動改為 `open`（產生 warning）
- 空值會自動填入預設值（不產生錯誤）
- 大小寫會自動標準化

### 3. 錯誤處理
- 紅色錯誤必須修正
- 黃色警告可以忽略（已自動修正）
- 查看 originalValue 了解原始輸入

---

## 📚 相關文件

- `DATA_VALIDATION_RULES_SUMMARY.md` - 完整驗證規則說明
- `UPLOAD_TYPES_REQUIRED_FIELDS.md` - 必填欄位清單
- `UPLOAD_SCHEMAS_EXTENSION_SUMMARY.md` - Schema 定義總結
- `src/utils/dataValidation.js` - 驗證邏輯原始碼

---

**文件版本：** 1.0  
**創建日期：** 2026-01-31
