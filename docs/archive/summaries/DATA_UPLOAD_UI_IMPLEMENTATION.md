# Data Upload UI Implementation - 實作總結

## ✅ 完成狀態：100%

已成功在 Data Upload 頁面新增 3 個上傳區塊/卡片，完全整合現有上傳流程。

---

## 📁 修改檔案

**檔案：** `src/views/EnhancedExternalSystemsView.jsx`

**修改內容：**
1. 新增 3 個 service import
2. 在 `handleSave` 函數中新增 3 個新類型的處理
3. 新增 3 個保存函數

**Linter 檢查：** ✅ 無錯誤

---

## 🎯 新增的 3 個上傳類型

### 1️⃣ Open PO Lines (po_open_lines)
- **圖示：** 📦
- **標籤：** Open PO Lines
- **描述：** 採購訂單未交貨明細
- **目標資料表：** `po_open_lines`

### 2️⃣ Inventory Snapshots (inventory_snapshots)
- **圖示：** 📊
- **標籤：** Inventory Snapshots
- **描述：** 庫存快照資料
- **目標資料表：** `inventory_snapshots`

### 3️⃣ FG Financials (fg_financials)
- **圖示：** 💵
- **標籤：** FG Financials
- **描述：** 成品財務資料（定價與利潤）
- **目標資料表：** `fg_financials`

---

## 📋 Diff 詳細說明

### 修改 1：新增 Service Import（Line 8-23）

**修改前：**
```javascript
import {
  suppliersService,
  materialsService,
  goodsReceiptsService,
  priceHistoryService,
  userFilesService,
  uploadMappingsService,
  bomEdgesService,
  demandFgService
} from '../services/supabaseClient';
```

**修改後：**
```javascript
import {
  suppliersService,
  materialsService,
  goodsReceiptsService,
  priceHistoryService,
  userFilesService,
  uploadMappingsService,
  bomEdgesService,
  demandFgService,
  poOpenLinesService,              // ⭐ 新增
  inventorySnapshotsService,       // ⭐ 新增
  fgFinancialsService             // ⭐ 新增
} from '../services/supabaseClient';
```

---

### 修改 2：在 handleSave 中新增處理（Line 665-689）

**修改前：**
```javascript
if (uploadType === 'goods_receipt') {
  savedCount = await saveGoodsReceipts(userId, rowsToSave, uploadFileId, batchId);
} else if (uploadType === 'price_history') {
  savedCount = await savePriceHistory(userId, rowsToSave, uploadFileId, batchId);
} else if (uploadType === 'supplier_master') {
  savedCount = await saveSuppliers(userId, rowsToSave, batchId);
} else if (uploadType === 'bom_edge') {
  savedCount = await saveBomEdges(userId, rowsToSave, batchId);
} else if (uploadType === 'demand_fg') {
  savedCount = await saveDemandFg(userId, rowsToSave, batchId);
} else {
  throw new Error(`Unsupported upload type: ${uploadType}`);
}
```

**修改後：**
```javascript
if (uploadType === 'goods_receipt') {
  savedCount = await saveGoodsReceipts(userId, rowsToSave, uploadFileId, batchId);
} else if (uploadType === 'price_history') {
  savedCount = await savePriceHistory(userId, rowsToSave, uploadFileId, batchId);
} else if (uploadType === 'supplier_master') {
  savedCount = await saveSuppliers(userId, rowsToSave, batchId);
} else if (uploadType === 'bom_edge') {
  savedCount = await saveBomEdges(userId, rowsToSave, batchId);
} else if (uploadType === 'demand_fg') {
  savedCount = await saveDemandFg(userId, rowsToSave, batchId);
} else if (uploadType === 'po_open_lines') {              // ⭐ 新增
  savedCount = await savePoOpenLines(userId, rowsToSave, batchId);
} else if (uploadType === 'inventory_snapshots') {        // ⭐ 新增
  savedCount = await saveInventorySnapshots(userId, rowsToSave, batchId);
} else if (uploadType === 'fg_financials') {             // ⭐ 新增
  savedCount = await saveFgFinancials(userId, rowsToSave, batchId);
} else {
  throw new Error(`Unsupported upload type: ${uploadType}`);
}
```

---

### 修改 3：新增 3 個保存函數（Line 977-1088）

#### savePoOpenLines()

```javascript
/**
 * Save PO Open Lines to database
 * @param {string} userId - User ID
 * @param {Array} validRows - Validated valid data
 * @param {string} batchId - Import batch ID
 * @returns {number} Number of records successfully saved
 */
const savePoOpenLines = async (userId, validRows, batchId) => {
  const poLines = validRows.map(row => ({
    po_number: row.po_number,
    po_line: row.po_line,
    material_code: row.material_code,
    plant_id: row.plant_id,
    time_bucket: row.time_bucket, // Already processed in validation
    open_qty: row.open_qty,
    uom: row.uom || 'pcs',
    supplier_id: row.supplier_id || null,
    status: row.status || 'open',
    notes: row.notes || null
  }));

  // Batch insert PO Open Lines
  const result = await poOpenLinesService.batchInsert(userId, poLines, batchId);
  
  console.log(`PO Open Lines saved: ${result.count} records`);
  
  return result.count;
};
```

---

#### saveInventorySnapshots()

```javascript
/**
 * Save Inventory Snapshots to database
 * @param {string} userId - User ID
 * @param {Array} validRows - Validated valid data
 * @param {string} batchId - Import batch ID
 * @returns {number} Number of records successfully saved
 */
const saveInventorySnapshots = async (userId, validRows, batchId) => {
  const snapshots = validRows.map(row => ({
    material_code: row.material_code,
    plant_id: row.plant_id,
    snapshot_date: row.snapshot_date,
    onhand_qty: row.onhand_qty,
    allocated_qty: row.allocated_qty !== null && row.allocated_qty !== undefined ? row.allocated_qty : 0,
    safety_stock: row.safety_stock !== null && row.safety_stock !== undefined ? row.safety_stock : 0,
    uom: row.uom || 'pcs',
    notes: row.notes || null
  }));

  // Batch insert Inventory Snapshots
  const result = await inventorySnapshotsService.batchInsert(userId, snapshots, batchId);
  
  console.log(`Inventory Snapshots saved: ${result.count} records`);
  
  return result.count;
};
```

---

#### saveFgFinancials()

```javascript
/**
 * Save FG Financials to database
 * @param {string} userId - User ID
 * @param {Array} validRows - Validated valid data
 * @param {string} batchId - Import batch ID
 * @returns {number} Number of records successfully saved
 */
const saveFgFinancials = async (userId, validRows, batchId) => {
  const financials = validRows.map(row => ({
    material_code: row.material_code,
    unit_margin: row.unit_margin,
    plant_id: row.plant_id || null, // null = global pricing
    unit_price: row.unit_price !== null && row.unit_price !== undefined ? row.unit_price : null,
    currency: row.currency || 'USD',
    valid_from: row.valid_from || null,
    valid_to: row.valid_to || null,
    notes: row.notes || null
  }));

  // Batch insert FG Financials
  const result = await fgFinancialsService.batchInsert(userId, financials, batchId);
  
  console.log(`FG Financials saved: ${result.count} records`);
  
  return result.count;
};
```

---

## 🎨 UI 整合說明

### 上傳流程（沿用現有 UI 風格）

**Step 1: 選擇上傳類型**
- 在下拉選單中會顯示新增的 3 個上傳類型
- 每個類型都有圖示、標籤、描述
- 自動顯示 Required Fields

**Step 2: 上傳檔案**
- 支援 Excel (.xlsx, .xls) 和 CSV (.csv)
- 最大 10MB
- 自動讀取檔案內容

**Step 3: 欄位映射**
- AI 智能映射建議（使用 Gemini API）
- 手動選擇系統欄位
- 即時預覽映射結果
- 必填欄位檢查

**Step 4: 資料驗證**
- 自動驗證資料格式
- 顯示成功/失敗筆數
- 詳細錯誤訊息

**Step 5: 保存**
- 寫入資料庫
- 建立 import_batch 記錄
- 自動保存欄位映射模板

---

## 📊 在頁面中的位置

### 下拉選單順序（Line 1089-1094）

```javascript
<select value={uploadType} onChange={(e) => setUploadType(e.target.value)}>
  <option value="">-- Please select data type --</option>
  {Object.entries(UPLOAD_SCHEMAS).map(([key, config]) => (
    <option key={key} value={key}>
      {config.icon} {config.label}
    </option>
  ))}
</select>
```

**顯示順序（按 UPLOAD_SCHEMAS 定義）：**
1. 🚚 Goods Receipt
2. 💰 Price History
3. 👥 Supplier Master
4. 🔗 BOM Edge
5. 📊 Demand FG
6. **📦 Open PO Lines** ⭐ 新增
7. **📊 Inventory Snapshots** ⭐ 新增
8. **💵 FG Financials** ⭐ 新增

---

## 🔄 完整資料流

```
1. 用戶選擇上傳類型（如 po_open_lines）
   ↓
2. 上傳 Excel/CSV 檔案
   ↓
3. 系統讀取檔案並顯示欄位
   ↓
4. 用戶進行欄位映射（手動或 AI）
   - Excel 欄位 → 系統欄位
   ↓
5. 系統驗證資料
   - dataValidation.js: validatePoOpenLinesRules()
   - 檢查必填欄位、數值範圍、日期格式等
   ↓
6. 顯示驗證結果
   - ✅ 成功：X 筆
   - ❌ 錯誤：Y 筆（顯示詳細錯誤）
   ↓
7. 用戶點擊「Save to Database」
   ↓
8. 後端處理
   a. 建立 import_batch 記錄（importBatchesService）
   b. 呼叫 savePoOpenLines(userId, validRows, batchId)
   c. 呼叫 poOpenLinesService.batchInsert(...)
   d. 寫入 po_open_lines 資料表
   e. 更新 import_batch 狀態為 'completed'
   f. 儲存欄位映射模板
   ↓
9. 顯示成功訊息
   - "Successfully saved X rows"
   - 可在 Import History 查看批次記錄
   ↓
10. 自動重置流程，可繼續上傳
```

---

## ✅ 功能確認

### 所有功能已完整整合：

1. ✅ **上傳檔案**
   - 支援 Excel (.xlsx, .xls) 和 CSV
   - 檔案大小限制 10MB
   - 自動讀取多個工作表

2. ✅ **欄位映射**
   - 手動映射
   - AI 智能映射（使用 Gemini API）
   - 自動載入先前儲存的映射模板
   - 即時預覽映射結果

3. ✅ **資料驗證**
   - 自動驗證必填欄位
   - 數值範圍檢查
   - 日期格式驗證
   - 業務規則驗證
   - 詳細錯誤訊息

4. ✅ **資料清理**
   - 自動類型轉換
   - 預設值填充
   - 自動修正（如 status 欄位）

5. ✅ **批次管理**
   - 建立 import_batch 記錄
   - 儲存批次 ID 到每筆資料
   - 可在 Import History 查看
   - 支援批次撤銷（undo）

6. ✅ **錯誤處理**
   - 友善的錯誤訊息
   - 詳細的錯誤列表
   - 錯誤資料不會寫入資料庫

7. ✅ **UI/UX**
   - 進度條顯示
   - 步驟指示器
   - 成功/失敗通知
   - 響應式設計

---

## 🧪 測試指南

### 測試步驟（使用 templates/ 內的檔案）

#### 測試 1：Open PO Lines

**檔案：** `templates/po_open_lines.xlsx`

1. **前往 Data Upload 頁面**
   - 登入系統
   - 點擊 "Data Upload" 導航

2. **選擇上傳類型**
   - 下拉選單選擇：**📦 Open PO Lines**
   - 確認顯示描述：「採購訂單未交貨明細」
   - 確認顯示 Required Fields

3. **上傳檔案**
   - 點擊「Select File to Upload」
   - 選擇 `templates/po_open_lines.xlsx`
   - 確認顯示：「Loaded 5 rows」

4. **欄位映射**
   - **選項 A（自動）：** 點擊「AI Field Suggestion」
     - 系統自動映射欄位
   - **選項 B（手動）：** 手動選擇每個欄位
     - `po_number` → PO Number
     - `po_line` → PO Line
     - `material_code` → Material Code
     - `plant_id` → Plant ID
     - `time_bucket` → Time Bucket
     - `open_qty` → Open Quantity
     - ... 其他欄位
   - 確認顯示：「✓ Mapping Complete」

5. **資料驗證**
   - 點擊「Next: Validate Data」
   - 確認顯示驗證結果：
     - Total Rows: 5
     - Valid Data: 5
     - Error Data: 0
     - Success Rate: 100%

6. **保存資料**
   - 點擊「Save to Database」
   - 確認顯示成功訊息：「Successfully saved 5 rows」
   - 系統自動重置流程

7. **驗證批次記錄**
   - 前往「Import History」頁面
   - 確認最新批次：
     - Type: po_open_lines
     - Status: completed
     - Success: 5
     - Error: 0
   - 點擊「View Data」查看資料

**預期結果：**
```
✅ 5 筆 PO Open Lines 成功寫入資料庫
✅ import_batches 記錄建立
✅ batch_id 正確關聯
✅ 可在 Import History 查看
```

---

#### 測試 2：Inventory Snapshots

**檔案：** `templates/inventory_snapshots.xlsx`

1. **選擇上傳類型**
   - 下拉選單選擇：**📊 Inventory Snapshots**

2. **上傳檔案**
   - 選擇 `templates/inventory_snapshots.xlsx`
   - 確認顯示：「Loaded 5 rows」

3. **欄位映射**
   - 使用 AI 自動映射或手動映射
   - 必填欄位：
     - material_code
     - plant_id
     - snapshot_date
     - onhand_qty
   - 確認 allocated_qty 和 safety_stock 預設為 0

4. **資料驗證**
   - 確認驗證通過
   - 檢查 snapshot_date 格式為 YYYY-MM-DD

5. **保存資料**
   - 點擊「Save to Database」
   - 確認成功訊息

6. **驗證批次記錄**
   - 前往 Import History
   - 確認 Type: inventory_snapshots
   - 確認 Success: 5

**預期結果：**
```
✅ 5 筆 Inventory Snapshots 成功寫入
✅ allocated_qty 預設為 0（如果原始資料為空）
✅ safety_stock 預設為 0（如果原始資料為空）
✅ uom 預設為 'pcs'（如果原始資料為空）
```

---

#### 測試 3：FG Financials

**檔案：** `templates/fg_financials.xlsx`

1. **選擇上傳類型**
   - 下拉選單選擇：**💵 FG Financials**

2. **上傳檔案**
   - 選擇 `templates/fg_financials.xlsx`
   - 確認顯示：「Loaded 6 rows」

3. **欄位映射**
   - 必填欄位：
     - material_code
     - unit_margin
   - 選填欄位：
     - plant_id（null = global pricing）
     - unit_price
     - currency（預設 USD）
     - valid_from
     - valid_to

4. **資料驗證**
   - 確認 unit_margin >= 0
   - 確認 unit_price >= 0（如果有值）
   - 確認 valid_from <= valid_to（如果兩者都有值）

5. **保存資料**
   - 點擊「Save to Database」
   - 確認成功訊息

6. **驗證批次記錄**
   - 前往 Import History
   - 確認 Type: fg_financials
   - 確認 Success: 6

**預期結果：**
```
✅ 6 筆 FG Financials 成功寫入
✅ plant_id 可為 null（代表 global pricing）
✅ currency 預設為 'USD'
✅ UNIQUE constraint 正確處理（含 COALESCE）
```

---

### 測試錯誤處理

#### 測試 4：上傳錯誤資料

1. **建立測試檔案**（po_open_lines_error.xlsx）
   - 複製 `templates/po_open_lines.xlsx`
   - 修改第 2 行：
     - open_qty 改為 `-5`（錯誤：負數）
   - 修改第 3 行：
     - time_bucket 改為空白（錯誤：必填）

2. **上傳並驗證**
   - 選擇上傳類型：Open PO Lines
   - 上傳修改後的檔案
   - 進行欄位映射
   - 點擊「Next: Validate Data」

3. **確認錯誤顯示**
   - Total Rows: 5
   - Valid Data: 3
   - Error Data: 2
   - Success Rate: 60%
   - 錯誤列表顯示：
     - Row 2: open_qty - "open_qty 必須 >= 0"
     - Row 3: time_bucket - "time_bucket 欄位必須存在"

4. **保存資料**
   - 點擊「Save to Database」
   - 確認只有 3 筆成功寫入
   - 顯示：「Successfully saved 3 rows (2 errors skipped)」

**預期結果：**
```
✅ 錯誤資料正確識別
✅ 顯示詳細錯誤訊息
✅ 只有 valid rows 寫入資料庫
✅ Error rows 不會寫入
```

---

### 測試批次撤銷

#### 測試 5：Undo 功能

1. **上傳資料**
   - 上傳 `po_open_lines.xlsx`（5 筆）
   - 確認成功保存

2. **前往 Import History**
   - 找到剛才的批次記錄
   - 記下 Batch ID

3. **點擊 Undo**
   - 點擊批次記錄的「Undo」按鈕
   - 確認顯示：「Successfully deleted 5 rows」

4. **驗證資料已刪除**
   - 使用 Supabase SQL Editor 查詢：
     ```sql
     SELECT * FROM po_open_lines WHERE batch_id = 'your-batch-id';
     ```
   - 確認返回 0 筆資料

**預期結果：**
```
✅ Undo 功能正常
✅ 資料完整刪除
✅ batch_id 正確追蹤
```

---

## 📚 相關文件

### Service Layer
- `SUPABASE_SERVICES_IMPLEMENTATION.md` - Service 完整說明
- `SUPABASE_SERVICES_API_REFERENCE.md` - API 文件
- `SERVICES_PUBLIC_API_METHODS.md` - 方法清單

### Database Layer
- `database/step1_supply_inventory_financials_schema.sql` - Schema
- `database/STEP1_SCHEMA_DEPLOYMENT_GUIDE.md` - 部署指南

### Upload Layer
- `src/utils/uploadSchemas.js` - Schema 定義
- `src/utils/dataValidation.js` - 驗證邏輯
- `UPLOAD_SCHEMAS_EXTENSION_SUMMARY.md` - Upload 總結
- `DATA_VALIDATION_RULES_SUMMARY.md` - 驗證規則

### Templates
- `templates/po_open_lines.xlsx` / `.csv`
- `templates/inventory_snapshots.xlsx` / `.csv`
- `templates/fg_financials.xlsx` / `.csv`
- `NEW_TEMPLATES_GUIDE.md` - 模板指南

### UI
- `src/views/EnhancedExternalSystemsView.jsx` - UI 實作
- `DATA_UPLOAD_UI_IMPLEMENTATION.md` - 本文件

---

## 🎉 完成狀態

**✅ 所有需求 100% 完成！**

### UI 整合完成度

- ✅ 新增 3 個上傳類型到下拉選單
- ✅ UI 風格完全沿用現有 bom_edge / demand_fg
- ✅ 上傳成功後寫入 import_batches
- ✅ 可在 Import History 查看批次
- ✅ 顯示成功/失敗筆數
- ✅ 顯示詳細錯誤訊息
- ✅ 沿用現有通知系統
- ✅ 沒有任何計算邏輯（保持 Data Upload 頁面單純）

### 完整資料流打通

```
✅ Templates (xlsx/csv)
   ↓
✅ UI Upload (EnhancedExternalSystemsView)
   ↓
✅ Upload Schemas (uploadSchemas.js)
   ↓
✅ Data Validation (dataValidation.js)
   ↓
✅ Service Layer (supabaseClient.js)
   ↓
✅ Database (Supabase)
   ↓
✅ Import History (可查看與撤銷)
```

**🚀 系統已準備就緒，可立即開始上傳測試！**

---

## 📝 使用注意事項

### 1. 欄位映射
- 使用 AI 映射時，請先確認映射是否正確
- 必填欄位必須映射才能繼續
- 可儲存映射模板供下次使用

### 2. 資料驗證
- 錯誤資料不會寫入資料庫
- 詳細錯誤訊息會顯示在驗證結果中
- 建議修正錯誤後重新上傳

### 3. 批次管理
- 每次上傳都會建立新的批次記錄
- 可在 Import History 查看所有批次
- 支援批次撤銷（Undo）

### 4. Plant Fallback（僅 fg_financials）
- `plant_id` 為 null 代表全球定價
- 查詢時會優先使用工廠特定定價
- 找不到時自動 fallback 到全球定價

---

**文件版本：** 1.0  
**創建日期：** 2026-01-31  
**最後更新：** 2026-01-31
