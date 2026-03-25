---
owner: di-core-team
status: active
last_reviewed: 2026-03-24
---

# One-shot Import Framework - 泛用架構文件

## 📋 實作完成總結

已將 One-shot Import 重構為**泛用、可擴充的框架**，而非針對特定檔案的 hardcode 實作。

---

## 🗂️ 檔案清單

### 新增檔案（4 個）

1. **`src/config/uploadFingerprints.js`** - 可配置的 Fingerprint 規則
   - 定義 8 種 uploadType 的辨識規則
   - 包含 required/optional/negative headers
   - 包含 field type hints 與 confidence 門檻
   - 擴充新類型：只需新增一個 rule

2. **`src/config/headerSynonyms.js`** - Header 同義字字典
   - 100+ 個常見同義字映射
   - normalizeHeader() 函數（大小寫、空白、底線）
   - mapHeaderToCanonical() 函數
   - 預留擴充點（TODO: 使用者自訂 synonyms）

3. **`src/utils/sheetClassifier.js`** (重構) - 通用 Sheet 分類器
   - Pure functions，可測試
   - classifySheet() 返回詳細 evidence
   - confidence 計算考慮 required/negative/type check
   - 支援 batch classification

4. **`src/services/oneShotImportService.js`** (重構) - One-shot 匯入服務
   - generateSheetPlans() - 分析 workbook
   - importWorkbookSheets() - 執行匯入
   - 復用既有 validation/cleaning/strategy.ingest
   - Sheet 粒度錯誤隔離

### 修改檔案（1 個）

**`src/views/EnhancedExternalSystemsView.jsx`**
- 整合新的 service API
- 顯示詳細 evidence（missing fields, reasons）
- 更好的錯誤訊息
- 支援 validation before import

---

## 🎯 Fingerprint 規則設計範例

### 1. BOM Edge
```javascript
{
  requiredHeaders: ['parent_material', 'component_material', 'qty_per'],
  optionalHeaders: ['child_material', 'uom', 'plant_id', 'bom_version', 'scrap_rate', 'yield_rate'],
  negativeHeaders: ['supplier', 'price', 'demand', 'inventory', 'receipt'],
  fieldTypeHints: {
    qty_per: 'number',
    scrap_rate: 'number',
    yield_rate: 'number'
  },
  minConfidenceToAutoEnable: 0.75
}
```

**邏輯：**
- 必須有 parent/child/qty_per 三個欄位
- 如果出現 supplier/price/demand 等欄位，大扣分（避免誤判為其他類型）
- qty_per 必須是數字

---

### 2. Demand FG
```javascript
{
  requiredHeaders: ['material_code', 'time_bucket', 'demand_qty'],
  optionalHeaders: ['plant_id', 'uom', 'week_bucket', 'date', 'source_type', 'customer_id'],
  negativeHeaders: ['supplier', 'price', 'parent', 'component', 'po_number', 'receipt'],
  fieldTypeHints: {
    demand_qty: 'number',
    time_bucket: 'string',
    date: 'date'
  },
  minConfidenceToAutoEnable: 0.75
}
```

**邏輯：**
- 必須有 material/time_bucket/demand_qty
- 如果出現 supplier/parent/component，表示可能是其他類型
- demand_qty 必須是數字

---

### 3. PO Open Lines
```javascript
{
  requiredHeaders: ['po_number', 'material_code', 'plant_id', 'open_qty'],
  optionalHeaders: ['po_line', 'supplier_id', 'time_bucket', 'date', 'delivery_date', 'uom', 'status'],
  negativeHeaders: ['parent', 'component', 'demand', 'receipt', 'price'],
  fieldTypeHints: {
    open_qty: 'number',
    po_number: 'string',
    date: 'date'
  },
  minConfidenceToAutoEnable: 0.75
}
```

---

### 4. Inventory Snapshots
```javascript
{
  requiredHeaders: ['material_code', 'plant_id', 'onhand_qty'],
  optionalHeaders: ['snapshot_date', 'on_hand_qty', 'available_qty', 'allocated_qty', 'safety_stock', 'uom'],
  negativeHeaders: ['supplier', 'po_number', 'parent', 'component', 'demand', 'price'],
  fieldTypeHints: {
    onhand_qty: 'number',
    safety_stock: 'number',
    snapshot_date: 'date'
  },
  minConfidenceToAutoEnable: 0.75
}
```

---

### 5. FG Financials
```javascript
{
  requiredHeaders: ['material_code', 'unit_margin'],
  optionalHeaders: ['plant_id', 'unit_price', 'currency', 'valid_from', 'valid_to', 'profit_per_unit'],
  negativeHeaders: ['supplier', 'po_number', 'parent', 'component', 'demand', 'inventory'],
  fieldTypeHints: {
    unit_margin: 'number',
    unit_price: 'number',
    valid_from: 'date',
    valid_to: 'date'
  },
  minConfidenceToAutoEnable: 0.75
}
```

---

### 6. Supplier Master
```javascript
{
  requiredHeaders: ['supplier_name'],
  optionalHeaders: ['supplier_code', 'contact_person', 'phone', 'email', 'address', 'country', 'lead_time_days', 'status'],
  negativeHeaders: ['material', 'demand', 'inventory', 'po_number', 'parent', 'component'],
  fieldTypeHints: {
    lead_time_days: 'number',
    phone: 'string',
    email: 'string'
  },
  minConfidenceToAutoEnable: 0.70  // 降低門檻，因為只有 1 個必填欄位
}
```

---

### 7. Goods Receipt
```javascript
{
  requiredHeaders: ['supplier_name', 'material_code', 'actual_delivery_date', 'received_qty'],
  optionalHeaders: ['supplier_code', 'po_number', 'receipt_number', 'planned_delivery_date', 'rejected_qty', 'uom'],
  negativeHeaders: ['parent', 'component', 'demand', 'inventory', 'price_history'],
  fieldTypeHints: {
    received_qty: 'number',
    rejected_qty: 'number',
    actual_delivery_date: 'date',
    planned_delivery_date: 'date'
  },
  minConfidenceToAutoEnable: 0.80  // 較高門檻，因為交易性資料
}
```

---

### 8. Price History
```javascript
{
  requiredHeaders: ['supplier_name', 'material_code', 'order_date', 'unit_price'],
  optionalHeaders: ['supplier_code', 'currency', 'quantity', 'is_contract_price'],
  negativeHeaders: ['parent', 'component', 'demand', 'inventory', 'receipt'],
  fieldTypeHints: {
    unit_price: 'number',
    quantity: 'number',
    order_date: 'date'
  },
  minConfidenceToAutoEnable: 0.80  // 較高門檻，因為交易性資料
}
```

---

## ✅ 如何驗收泛用性 - Checklist

### A) 架構泛用性驗證

- [ ] **新增 uploadType 不需修改分類邏輯**
  - 在 `src/config/uploadFingerprints.js` 新增一個 rule
  - 不需要修改 `sheetClassifier.js` 或 `oneShotImportService.js`
  - 測試：新增一個假的 `test_type` rule，確認能被分類

- [ ] **Synonym 可擴充**
  - 在 `src/config/headerSynonyms.js` 新增同義字
  - 測試：加入 "item_no" -> "material_code"，上傳含 "item_no" 的檔案，確認能映射

- [ ] **Type hints 正確運作**
  - 測試：上傳 qty_per 欄位包含文字的 BOM sheet
  - 預期：confidence 降低，typeCheckPassRate < 0.7

- [ ] **Negative headers 避免誤判**
  - 測試：上傳 BOM sheet 但包含 "supplier_name" 欄位
  - 預期：不會被誤判為 supplier_master，confidence 降低

---

### B) 功能完整性驗證

- [ ] **編譯測試**
  ```bash
  npm run build
  # 預期：✓ built in 3-4s，無錯誤
  ```

- [ ] **Dev server 啟動**
  ```bash
  npm run dev
  # 預期：無紅色錯誤，能正常訪問
  ```

- [ ] **One-shot toggle 功能**
  - 預設關閉（保持原有單檔流程）
  - 開啟後，能上傳 Excel 檔案

---

### C) 多 Sheet 測試（泛用性）

#### 測試 1：空白 Sheet
- **操作：** 上傳包含空白 sheet 的 Excel
- **預期：** 
  - Sheet plan 顯示 "Sheet is empty (0 rows)"
  - 預設 disabled
  - 不影響其他 sheet

#### 測試 2：超過 1000 行
- **操作：** 上傳包含 >1000 rows 的 sheet
- **預期：**
  - Sheet plan 顯示 "Too many rows (1234 > 1000)"
  - 預設 disabled
  - 不影響其他 sheet

#### 測試 3：高信心度分類
- **操作：** 上傳標準的 BOM sheet（含 parent_material, component_material, qty_per）
- **預期：**
  - suggestedType = "bom_edge"
  - confidence >= 0.75
  - enabled = true
  - 顯示 "✓ Matched X required fields"

#### 測試 4：低信心度分類
- **操作：** 上傳欄位名稱不明確的 sheet（例如只有 A, B, C）
- **預期：**
  - confidence < 0.75
  - enabled = false
  - 顯示 "Low confidence - please specify type"
  - 使用者可手動選擇 uploadType

#### 測試 5：包含 Negative headers
- **操作：** 上傳 BOM sheet 但加入 "supplier_name" 欄位
- **預期：**
  - confidence 降低
  - evidence.matchedNegative 包含 "supplier"
  - reasons 顯示 "Contains unexpected fields"

#### 測試 6：Missing required fields
- **操作：** 上傳 BOM sheet 但缺少 "qty_per" 欄位
- **預期：**
  - confidence <= 0.5（被 cap）
  - evidence.missingRequired = ["qty_per"]
  - enabled = false
  - Status 顯示 "Missing: qty_per"

---

### D) 匯入流程驗證

#### 測試 7：成功匯入
- **操作：** 
  1. 上傳包含 2 個 valid sheets 的 Excel
  2. 確認都 enabled
  3. 點擊 "Import X Sheets"
- **預期：**
  - 顯示進度條（Sheet 1/2, Sheet 2/2）
  - 結果摘要：2 imported, 0 skipped, 0 failed
  - 每個 sheet 顯示 savedCount

#### 測試 8：部分匯入
- **操作：**
  1. 上傳包含 1 個 valid + 1 個 invalid sheet
  2. 只 enable valid sheet
  3. 點擊 Import
- **預期：**
  - 1 imported, 0 skipped, 0 failed
  - Invalid sheet 不在結果中

#### 測試 9：錯誤隔離
- **操作：**
  1. 上傳包含 3 個 sheets：Sheet1(valid), Sheet2(會失敗), Sheet3(valid)
  2. Enable 全部
  3. 點擊 Import
- **預期：**
  - Sheet1 成功
  - Sheet2 失敗（記錄錯誤原因）
  - Sheet3 **仍然成功**（錯誤隔離）
  - 結果：2 imported, 0 skipped, 1 failed

#### 測試 10：Validation before import
- **操作：**
  1. Enable 一個 sheet 但不指定 uploadType
  2. 點擊 Import
- **預期：**
  - 顯示錯誤："No upload type specified"
  - 不執行匯入

---

### E) Edge Cases 驗證

#### 測試 11：同義字映射
- **操作：** 上傳 BOM sheet，欄位名稱為 "Parent Part", "Child Part", "Usage"
- **預期：**
  - 正確映射為 parent_material, component_material, qty_per
  - confidence >= 0.75
  - 能成功匯入

#### 測試 12：大小寫不敏感
- **操作：** 上傳欄位名稱為 "MATERIAL_CODE", "Material Code", "material-code"
- **預期：**
  - 都正確映射為 material_code
  - normalizeHeader() 正常運作

#### 測試 13：Type checking
- **操作：** 上傳 demand_fg sheet，但 demand_qty 欄位包含 50% 文字
- **預期：**
  - typeCheckPassRate 降低
  - confidence 降低
  - 可能被 disable（取決於門檻）

#### 測試 14：Multiple candidates
- **操作：** 上傳一個模糊的 sheet（同時符合多個類型）
- **預期：**
  - suggestedType 是最高分的
  - candidates 列出其他可能（confidence > 0.1）
  - 使用者可從 dropdown 選擇

---

### F) 下載報告驗證

#### 測試 15：JSON 報告
- **操作：** 匯入完成後，點擊 "Download Report (JSON)"
- **預期：**
  - 下載 JSON 檔案
  - 包含所有 sheetResults（status, savedCount, reason, error）
  - 格式正確（可用 JSON validator 驗證）

---

### G) 不同檔案類型驗證（泛用性核心）

#### 測試 16：製造業 BOM 檔案
- **欄位：** Assembly, Component, Qty, UOM
- **預期：** 自動分類為 bom_edge

#### 測試 17：ERP 導出的需求檔案
- **欄位：** SKU, Week, Forecast Quantity, Plant
- **預期：** 自動分類為 demand_fg

#### 測試 18：供應商主檔
- **欄位：** Vendor Name, Vendor Code, Contact, Phone
- **預期：** 自動分類為 supplier_master

#### 測試 19：完全不認識的檔案
- **欄位：** Random1, Random2, Random3
- **預期：** 
  - 所有 uploadType confidence 都很低
  - 不自動 enable
  - 顯示 "No matching upload type found"

---

## 🚀 驗收指令與預期結果

### 最小驗收流程

```bash
# 1. 編譯測試
npm run build
# 預期：✓ built in 3-4s，無錯誤

# 2. 啟動 dev server
npm run dev
# 預期：VITE v7.x.x ready，無紅色錯誤

# 3. 開啟瀏覽器
# 訪問：http://localhost:5173 (或提示的 port)

# 4. 前往 Data Upload 頁面

# 5. 勾選 "One-shot Import" toggle

# 6. 上傳任意多 sheet Excel 檔案
# 預期：
#   - 顯示 Sheet Plans 表格
#   - 每個 sheet 顯示 suggestedType, confidence, status
#   - 高信心度 sheet 自動 enabled
#   - 低信心度 sheet disabled，可手動選擇 uploadType

# 7. 手動調整（如需要）
#   - 修改 uploadType（dropdown）
#   - 勾選/取消 enabled

# 8. 點擊 "Import X Sheets"
# 預期：
#   - 顯示進度條
#   - 完成後顯示結果摘要
#   - 成功的 sheet 顯示 savedCount
#   - 失敗的 sheet 顯示原因
#   - 頁面不 crash

# 9. 檢查 Console
# 預期：
#   - 無 500 錯誤
#   - 無未捕獲的例外
#   - 可能有正常的 log（[One-shot] 開頭）

# 10. 下載報告
# 點擊 "Download Report (JSON)"
# 預期：
#   - 下載 JSON 檔案
#   - 包含完整結果
```

---

## 📈 泛用性擴充範例

### 如何新增一個 uploadType（例如：Material Master）

#### Step 1：定義 Fingerprint（1 個檔案）
```javascript
// src/config/uploadFingerprints.js

material_master: {
  requiredHeaders: ['material_code', 'material_name'],
  optionalHeaders: ['category', 'uom', 'unit_weight', 'abc_class', 'lead_time'],
  negativeHeaders: ['supplier', 'parent', 'component', 'demand', 'po_number'],
  fieldTypeHints: {
    unit_weight: 'number',
    lead_time: 'number'
  },
  minConfidenceToAutoEnable: 0.75,
  description: 'Material master data'
}
```

#### Step 2：新增 Schema（如果需要）
```javascript
// src/utils/uploadSchemas.js

material_master: {
  label: 'Material Master',
  description: 'Material master data',
  icon: '📦',
  fields: [
    { key: 'material_code', label: 'Material Code', type: 'string', required: true },
    { key: 'material_name', label: 'Material Name', type: 'string', required: true },
    // ... 其他欄位
  ]
}
```

#### Step 3：新增 Strategy（如果需要）
```javascript
// src/services/uploadStrategies.js

class MaterialMasterStrategy {
  async ingest({ userId, rows, batchId }) {
    // 實作匯入邏輯
  }
}

const strategies = {
  // ... 其他
  material_master: new MaterialMasterStrategy()
};
```

#### Step 4：測試
- 上傳包含 Material Master 的 Excel
- 預期：自動分類為 material_master
- 完成！不需要修改分類器或 UI

---

## 🎯 框架優勢總結

### ✅ 泛用性
- 不針對特定檔案 hardcode
- 新增類型只需新增 config
- Synonym dictionary 可擴充

### ✅ 可測試性
- Pure functions（classifySheet）
- Config-driven 邏輯
- 清晰的 input/output

### ✅ 錯誤隔離
- Sheet 粒度錯誤處理
- 任何一張 sheet 失敗不影響其他
- 詳細的錯誤原因

### ✅ 復用既有流程
- 使用既有 validation
- 使用既有 cleaning
- 使用既有 strategy.ingest
- 不重複造輪子

### ✅ 使用者友善
- 詳細的 evidence 顯示
- 允許人工介入
- 清楚的錯誤訊息
- 下載報告

---

## 📝 TODO: 未來擴充點

1. **使用者自訂 Synonyms**
   - 允許使用者在 UI 新增自訂同義字
   - 儲存到 DB，與系統 synonyms 合併

2. **Machine Learning 增強**
   - 記錄使用者修正的 uploadType
   - 用於訓練分類模型
   - 提高自動分類準確度

3. **更多 Type Hints**
   - 支援 enum 驗證（例如 status: 'open'|'closed'）
   - 支援 regex pattern（例如 email, phone）

4. **批次大小動態調整**
   - 根據 sheet 資料量自動調整批次大小
   - 避免超過 DB 限制

5. **更詳細的進度顯示**
   - 顯示當前處理的 row
   - 顯示 validation/cleaning 進度

---

**實作完成日期：** 2026-02-05  
**Framework Version：** 1.0.0  
**可擴充性：** ✅ 高  
**測試覆蓋：** ✅ 完整驗收清單
