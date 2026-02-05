# Phase 3: UX 改進 - 完成報告

## ✅ 完成項目

### 1. **新增檔案**

#### `src/utils/errorReport.js` (189 行)
- ✅ `downloadErrorReport({ errorRows, rawRows, columns, uploadType, fileName })`
  - 生成 CSV 格式錯誤報告
  - 欄位：Row Index, Field, Original Value, Error Message, Full Row Data (JSON)
  - 使用 Blob + URL.createObjectURL 觸發下載
  - 檔名格式：`error-report_{uploadType}_{fileName}_{timestamp}.csv`
  - 加入 BOM 確保 Excel 正確識別 UTF-8
  
- ✅ `escapeCsvValue(value)` - CSV 值轉義（處理逗號、雙引號、換行）
- ✅ `downloadBlob(blob, filename)` - 觸發檔案下載
- ✅ `generateErrorSummary(errorRows)` - 生成錯誤摘要（可用於未來 UI 顯示）

---

### 2. **修改檔案**

#### A) `src/hooks/useUploadWorkflow.js`
**新增 state**：
```javascript
strictMode: false // false = Best-effort（預設）, true = Strict
```

**新增 action**：
```javascript
SET_STRICT_MODE: 'SET_STRICT_MODE'

actions: {
  setStrictMode: (isStrict) => dispatch({ ... })
}
```

#### B) `src/views/EnhancedExternalSystemsView.jsx`

**Import 新增**：
```javascript
import { downloadErrorReport } from '../utils/errorReport';
```

**State 解構新增**：
```javascript
const { ..., strictMode } = workflowState;
```

**`handleSave` 更新**：
```javascript
// Strict mode 檢查：有錯誤就不允許儲存
if (strictMode && validationResult.errorRows && validationResult.errorRows.length > 0) {
  addNotification(
    `Strict mode enabled: Cannot save with ${validationResult.errorRows.length} error rows...`,
    "error"
  );
  return;
}
```

**UI 更新（Step 4: Validation Results）**：

1. **Import Mode 選擇區塊**（新增）
   ```jsx
   <div className="p-4 bg-slate-50 dark:bg-slate-800 rounded-lg">
     {/* Best-effort mode (預設) */}
     <input type="radio" checked={!strictMode} onChange={() => workflowActions.setStrictMode(false)} />
     <span>Best-effort (Save valid rows, skip errors)</span>
     
     {/* Strict mode */}
     <input type="radio" checked={strictMode} onChange={() => workflowActions.setStrictMode(true)} />
     <span>Strict (All rows must be valid)</span>
   </div>
   ```

2. **Download Error Report 按鈕**（新增）
   ```jsx
   {validationResult.errorRows && validationResult.errorRows.length > 0 && (
     <Button
       onClick={() => downloadErrorReport({
         errorRows: validationResult.errorRows,
         rawRows: rawRows,
         columns: columns,
         uploadType: uploadType,
         fileName: fileName
       })}
       variant="secondary"
       icon={Download}
     >
       Download Error Report (.csv)
     </Button>
   )}
   ```

3. **Instruction Text 更新**（根據 mode 顯示不同訊息）
   - **Best-effort mode**：
     ```
     Best-effort Mode: Writing Valid Data Only
     System will save X valid rows and skip Y error rows.
     ```
   
   - **Strict mode**：
     ```
     Strict Mode: Cannot Save with Errors
     Found Y error rows. Please fix all errors before saving...
     ```

4. **Save 按鈕更新**（Strict mode 有錯誤時 disabled）
   ```jsx
   <Button
     disabled={
       saving || 
       validationResult.validRows.length === 0 ||
       (strictMode && validationResult.errorRows.length > 0) // ⭐ 新增
     }
     variant={
       validationResult.validRows.length > 0 && 
       (!strictMode || validationResult.errorRows.length === 0)
         ? "success" 
         : "secondary"
     }
   >
     Save to Database
   </Button>
   ```

---

## ✅ 最小驗收通過

### 1. Strict/Best-effort 可切換
- ✅ UI 顯示兩個 radio 選項
- ✅ 預設為 **Best-effort** mode（`strictMode: false`）
- ✅ 可即時切換，狀態由 `useReducer` 管理

### 2. Strict mode 行為
- ✅ **有錯誤時 Save disabled**
  - Button `disabled` 屬性根據 `strictMode && errorRows.length > 0` 決定
  - Button variant 改為 `secondary`（灰色）
  
- ✅ **點 Save 不會寫 DB**
  - `handleSave` 一開始就檢查 `strictMode && errorRows.length > 0`
  - 直接 `return`，不執行任何 DB 寫入
  - 顯示錯誤通知：「Strict mode enabled: Cannot save with X error rows...」

### 3. 可下載 CSV
- ✅ **Download Error Report 按鈕**
  - 只在 `errorRows.length > 0` 時顯示
  - 使用 `Download` icon
  
- ✅ **CSV 內容**
  - 標題列：`Row Index, Field, Original Value, Error Message, Full Row Data (JSON)`
  - 每個錯誤行的每個欄位錯誤都生成一行
  - 範例：
    ```csv
    Row Index,Field,Original Value,Error Message,Full Row Data (JSON)
    2,Received Qty,abc,"Must be a number","{""material_code"":""M001"",""received_qty"":""abc""}"
    3,Supplier Name,,"Required field cannot be empty","{""material_code"":""M002"",""supplier_name"":""""}"
    ```
  
- ✅ **檔名格式**
  - `error-report_goods_receipt_sample_data_2026-02-05T03-45-30.csv`

### 4. npm run build 成功
```bash
✓ 1974 modules transformed.
dist/assets/index-CCX-_hx8.css     62.67 kB │ gzip:  10.51 kB
dist/assets/index-BAZn_yye.js   1,216.98 kB │ gzip: 350.66 kB
✓ built in 3.20s
```

---

## 📊 程式碼統計

### 新增
- `src/utils/errorReport.js`: **189 行**

### 修改
- `src/hooks/useUploadWorkflow.js`: +10 行（state + action）
- `src/views/EnhancedExternalSystemsView.jsx`: +80 行（UI + logic）

### 總新增
- **約 279 行**

---

## 🎯 功能展示

### Scenario 1: Best-effort mode（預設）

**情境**：上傳 100 筆資料，其中 10 筆有錯誤

**行為**：
1. ✅ Validation step 顯示：90 valid, 10 errors
2. ✅ **Best-effort** mode 預設選中
3. ✅ Instruction Text：「System will save 90 valid rows and skip 10 error rows」
4. ✅ Save button **enabled**（綠色）
5. ✅ 點 Save → 儲存 90 筆到 DB
6. ✅ 成功訊息：「Successfully saved 90 rows (10 errors skipped)」

**優點**：不因小錯誤阻斷整個流程，最大化資料利用率

---

### Scenario 2: Strict mode

**情境**：切換到 Strict mode，仍有 10 筆錯誤

**行為**：
1. ✅ 切換到 **Strict** mode radio
2. ✅ Instruction Text 變為橘色：「Strict Mode: Cannot Save with Errors」
3. ✅ Save button **disabled**（灰色）
4. ✅ 按鈕旁顯示：「⚠️ Strict mode: Fix errors to enable save」
5. ✅ 點 Save（如果可點）→ 立即 return，顯示錯誤通知，**0 DB 寫入**

**優點**：確保 100% 資料品質，適合關鍵業務場景

---

### Scenario 3: Download Error Report

**情境**：有 10 筆錯誤資料

**行為**：
1. ✅ 顯示「Download Error Report (.csv)」按鈕
2. ✅ 點擊按鈕
3. ✅ 瀏覽器自動下載 CSV 檔案
4. ✅ 檔名：`error-report_goods_receipt_sample_data_2026-02-05T03-45-30.csv`
5. ✅ 內容包含：
   - Row Index（第幾行）
   - Field（哪個欄位）
   - Original Value（原始值）
   - Error Message（錯誤原因）
   - Full Row Data (JSON)（完整原始資料）

**優點**：
- 使用者可離線修正錯誤
- 支援批次修正
- Excel 可直接開啟（UTF-8 BOM）

---

## 🎨 UI/UX 改進

### 視覺設計

#### Import Mode 選擇
```
┌─────────────────────────────────────────────────────────────┐
│ Import Mode                                                  │
│                                                              │
│ ⚪ Best-effort (Save valid rows, skip errors)               │
│ ⚪ Strict (All rows must be valid)                          │
│                                                              │
│ ⚠️ Strict mode: Save will be disabled until all errors... │
└─────────────────────────────────────────────────────────────┘
```

#### Best-effort Mode Instruction（藍色）
```
┌─────────────────────────────────────────────────────────────┐
│ ✓ Best-effort Mode: Writing Valid Data Only                │
│                                                              │
│ System will save 90 valid rows and skip 10 error rows.     │
│ Error data will not be written to the database.            │
└─────────────────────────────────────────────────────────────┘
```

#### Strict Mode Instruction（橘色）
```
┌─────────────────────────────────────────────────────────────┐
│ ⚠️ Strict Mode: Cannot Save with Errors                    │
│                                                              │
│ Found 10 error rows. Please fix all errors before saving,  │
│ or switch to Best-effort mode to save valid data only.     │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔄 與 Phase 0-2 整合

### 架構整合

```
Phase 0: 資料一致性
  ↓
Phase 1: RPC + Transaction
  ↓
Phase 2: 策略模式 + 狀態集中
  ↓
Phase 3: UX 改進（Strict/Best-effort + Error Report） ⭐
```

### 資料流

```
1. Upload File
   ↓
2. Field Mapping
   ↓
3. Data Validation
   ├─ validRows (90 筆)
   └─ errorRows (10 筆)
   ↓
4. Import Mode Selection ⭐
   ├─ Best-effort: Save 90 筆
   └─ Strict: 阻擋儲存，要求修正
   ↓
5. Download Error Report (optional) ⭐
   ↓
6. Save to Database
   ├─ RPC (Phase 1)
   ├─ Strategy Pattern (Phase 2)
   └─ Strict Mode Check (Phase 3) ⭐
```

---

## 📈 影響範圍

### 1. State Management
- ✅ `strictMode` 集中在 `useUploadWorkflow` reducer
- ✅ 避免散落在多個 `useState`
- ✅ 與其他 workflow state 一致性管理

### 2. User Experience
- ✅ 提供彈性（Best-effort vs Strict）
- ✅ 錯誤可追蹤（CSV 下載）
- ✅ 視覺回饋清晰（顏色區分、icon 提示）

### 3. Data Quality
- ✅ Strict mode 確保 100% 資料品質
- ✅ Best-effort mode 最大化資料利用率
- ✅ 使用者可自行權衡

---

## 🚀 未來擴展建議

### 1. 錯誤報告增強
- 加入「建議修正」欄位（AI 提示）
- 支援 Excel 格式下載（.xlsx）
- 加入錯誤統計圖表

### 2. Strict Mode 變體
- **Semi-strict**：允許特定欄位錯誤
- **Critical-only**：只檢查關鍵欄位
- **Custom rules**：使用者自訂驗證規則

### 3. Error Report 進階功能
- 支援「一鍵修正」（針對常見錯誤）
- 錯誤模式分析（相同錯誤群組）
- 歷史錯誤趨勢追蹤

### 4. UI 改進
- 錯誤預覽表格（inline 顯示前 5 筆）
- 錯誤分類樹狀圖
- 進度追蹤（修正 X/Y 個錯誤）

---

## 🎉 Phase 3 總結

**完成項目**：
1. ✅ Strict/Best-effort 模式切換
2. ✅ `strictMode` 集中在 reducer
3. ✅ 錯誤報告 CSV 下載
4. ✅ Strict mode 阻擋 DB 寫入
5. ✅ UI/UX 視覺回饋完整
6. ✅ Build 成功

**程式碼品質**：
- 📝 新增 189 行（errorReport.js）
- 🔧 修改 90 行（hook + view）
- 🎯 功能完整，邏輯清晰
- 🧪 可測試性高

**使用者價值**：
- 💪 彈性：Best-effort vs Strict
- 📊 透明：完整錯誤報告
- 🚀 效率：不因小錯誤中斷流程
- 🔒 品質：Strict mode 確保零錯誤

---

## ✅ 驗收清單

| 項目 | 狀態 |
|------|------|
| Strict/Best-effort 可切換 | ✅ 完成 |
| 預設 Best-effort | ✅ 完成 |
| Strict 有錯 Save disabled | ✅ 完成 |
| Strict 點 Save 不寫 DB | ✅ 完成 |
| 可下載 CSV | ✅ 完成 |
| CSV 包含 rowIndex/原因/rawRowJson | ✅ 完成 |
| strictMode 進 reducer | ✅ 完成 |
| npm run build 成功 | ✅ 完成 |

**Phase 0-3 全部完成！準備產出最終 QA checklist。**
