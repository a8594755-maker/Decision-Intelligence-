# One-shot Import 最終修復指引

## 🎯 修復目標完成狀態

### ✅ A) 修 DB：suppliers_status_check 導致 0 rows saved
- [x] 建立 SQL migration：`database/fix_suppliers_status.sql`
- [x] 正規化函式：`normalizeSupplierStatus()` 在 `uploadStrategies.js` 和 `supabaseClient.js`
- [x] 確保所有寫入路徑只寫 'active' 或 'inactive'

### ✅ B) One-shot：auto-mapping 改成「AI-first（保底）」
- [x] 新增 `src/utils/mappingValidation.js` - 共用 mapping 檢查 helper
- [x] `getRequiredMappingStatus()` - 計算 coverage 和 missing fields
- [x] 修改 `oneShotImportService.js` 使用新 helper
- [x] 將 status: 'SKIPPED' 改為 'NEEDS_REVIEW'（mapping 不足時）

### ✅ C) UI：「AI Suggest All」功能（已在前次實作）
- [x] 批量 AI 建議按鈕
- [x] 併發控制（concurrency = 2）
- [x] 進度顯示與取消功能
- [x] 「包含已準備好的 sheets」checkbox

### ✅ D) 匯入流程：不允許 silent skip
- [x] 新增 `needsReviewSheets` 計數
- [x] UI summary 區分 Succeeded / Needs Review / Skipped / Failed
- [x] 改進通知訊息，明確提示 needs review
- [x] Import summary 標題動態調整（「Import Requires Review」 vs 「Import Completed」）

### ✅ E) 單檔上傳：Field Mapping 缺 required 時絕對不能跳過/繼續
- [x] 修改 `validateData()` 使用 `getRequiredMappingStatus()`
- [x] UI 顯示詳細 missing fields
- [x] Next 按鈕保持 disabled（若 mapping 不完整）

### ✅ F) 驗收
- [x] `npm run build` 通過

---

## 📂 修改/新增的檔案清單

### 新增檔案（3 個）
1. **`database/fix_suppliers_status.sql`** ⭐ NEW
   - 清理現有不合法 status 資料
   - 確保 DEFAULT 'active'
   - 向後相容的 migration

2. **`src/utils/mappingValidation.js`** ⭐ NEW
   - `getRequiredMappingStatus()` - 檢查 mapping 完整度
   - `validateColumnMapping()` - 驗證 mapping 合法性
   - `formatMissingRequiredMessage()` - 格式化錯誤訊息

3. **`AI_SUGGEST_ALL_TEST_GUIDE.md`** 📖 (前次實作)
   - AI Suggest All 完整測試指引

### 修改檔案（4 個）
4. **`src/services/uploadStrategies.js`** 🔧 MODIFIED
   - 新增 `normalizeSupplierStatus()` 函式
   - `SupplierMasterStrategy.ingest()` 使用正規化函式

5. **`src/services/supabaseClient.js`** 🔧 MODIFIED
   - `batchUpsertSuppliers()` 新增 `normalizeSupplierStatus()`
   - 確保所有 upsert 寫入合法 status

6. **`src/services/oneShotImportService.js`** 🔧 MODIFIED
   - 引入 `getRequiredMappingStatus` helper
   - 將 `status: 'SKIPPED'` 改為 `status: 'NEEDS_REVIEW'`（mapping 不足時）
   - 新增 `needsReviewSheets` 計數

7. **`src/views/EnhancedExternalSystemsView.jsx`** 🔧 MODIFIED
   - 引入 `getRequiredMappingStatus`, `formatMissingRequiredMessage`
   - 單檔模式：加強 `validateData()` 檢查
   - 單檔模式：UI 顯示詳細 missing fields
   - One-shot result summary：新增 「Needs Review」欄位
   - One-shot result summary：標題動態調整
   - One-shot result summary：詳細結果支援 `NEEDS_REVIEW` 狀態
   - 改進通知訊息

---

## 🧪 最小手動驗收步驟

### 準備：執行 SQL Migration（重要！）

```sql
-- 在 Supabase SQL Editor 執行
-- c:\Users\a8594\decision-intelligence\database\fix_suppliers_status.sql
```

複製檔案內容並在 Supabase Dashboard → SQL Editor 執行。

---

### 步驟 1：啟動開發伺服器
```powershell
cd c:\Users\a8594\decision-intelligence
npm run dev
```

開啟 Chrome DevTools Console（F12）

---

### 步驟 2：測試單檔上傳 - Field Mapping 禁止邏輯

#### 2.1 選擇一個 uploadType
進入 Data Upload → 選擇「BOM Edge」

#### 2.2 上傳測試檔案
上傳任意 Excel/CSV（確保欄位名稱與標準不完全相同）

#### 2.3 Field Mapping 頁面
- 故意不 map 某個 required field（例如：`parent_material`）
- 觀察 UI

**預期結果**：
- ✅ UI 顯示紅色警告：「Required fields must be mapped to continue」
- ✅ 下方顯示：「Missing: parent_material, component_material, ...」
- ✅ 「Next: Validate Data」按鈕為 **disabled**（無法點擊）
- ✅ 點擊按鈕後 Console 顯示：「Cannot proceed: Missing required field...」

#### 2.4 完成 mapping
- Map 所有 required fields
- 觀察 UI

**預期結果**：
- ✅ UI 顯示綠色：「Mapping Complete (100%)」
- ✅ 「Next: Validate Data」按鈕變為 **enabled**（可點擊）
- ✅ 可正常進入下一步

---

### 步驟 3：測試 One-shot Import - Supplier Master status 修復

#### 3.1 準備測試資料
創建一個 Excel 檔案（例如：`Test Suppliers.xlsx`），Sheet1: Supplier Master

| supplier_code | supplier_name | status  |
|---------------|---------------|---------|
| SUP001        | Supplier A    | Active  |
| SUP002        | Supplier B    | ENABLED |
| SUP003        | Supplier C    | yes     |
| SUP004        | Supplier D    |         |

#### 3.2 上傳並執行 One-shot Import
1. 開啟「One-shot Import」toggle
2. 上傳測試檔案
3. 勾選 Supplier Master sheet 的 Enable
4. 點擊「Import Enabled Sheets」

**預期結果**：
- ✅ Supplier Master 顯示 **IMPORTED**（不是 savedCount=0）
- ✅ Console **不再** 出現：「suppliers_status_check」錯誤
- ✅ savedCount > 0（例如：4 rows）
- ✅ 在 Supabase Dashboard → Suppliers 表可看到資料
- ✅ 所有 status 欄位值為 `'active'` 或 `'inactive'`

#### 3.3 驗證 status 正規化
在 Supabase SQL Editor 執行：
```sql
SELECT supplier_code, supplier_name, status
FROM suppliers
WHERE user_id = auth.uid()
ORDER BY created_at DESC
LIMIT 10;
```

**預期結果**：
- ✅ 所有 status 值為 `'active'` 或 `'inactive'`
- ✅ 原始值 'Active', 'ENABLED', 'yes', null 都被正規化為 `'active'`

---

### 步驟 4：測試 One-shot Import - NEEDS_REVIEW 狀態

#### 4.1 準備測試資料
創建 Excel 檔案，包含一個 header 名稱很奇怪的 sheet（例如：Sheet1: BOM Data）

| Column A | Column B | Column C |
|----------|----------|----------|
| Mat-1    | Comp-1   | 5        |
| Mat-2    | Comp-2   | 10       |

注意：故意使用非標準 header 名稱

#### 4.2 上傳並檢查 Sheet Plans
1. 開啟「One-shot Import」toggle
2. 上傳測試檔案
3. 觀察 Sheet Plans 表格

**預期結果**：
- ✅ Sheet 的 confidence 很低（< 0.75）
- ✅ 預設 enabled = false
- ✅ Status 欄位顯示：「Missing required fields: ...」

#### 4.3 點擊「AI Suggest」
點擊該 sheet 的「AI Suggest」按鈕

**預期結果**：
- ✅ AI 嘗試建議 uploadType 和 mapping
- ✅ 若 AI 仍無法達到 coverage = 100%：
  - enabled 仍為 false
  - Status 顯示：「⚠ Required fields coverage < 100%」

#### 4.4 強制勾選 Enable 並嘗試匯入
勾選該 sheet 的 Enable checkbox，點擊「Import Enabled Sheets」

**預期結果**：
- ✅ 該 sheet 狀態顯示為 **「NEEDS_REVIEW」**（不是 SKIPPED）
- ✅ Import summary 標題顯示：「Import Requires Review」（黃色/橘色背景）
- ✅ Summary 統計顯示：
  - Succeeded: 0
  - **Needs Review: 1** （新欄位）
  - Skipped: 0
  - Failed: 0
- ✅ 通知訊息：「⚠ No sheets imported. 1 need review, 0 skipped, 0 failed.」

---

### 步驟 5：測試 AI Suggest All

#### 5.1 上傳多 sheet Excel
使用 Mock data.xlsx 或任何包含 3+ sheets 的 Excel

#### 5.2 點擊「AI 一鍵建議」
1. 觀察預設只對低信心 sheets 執行
2. 勾選「包含已準備好的 sheets」
3. 再次點擊「AI 一鍵建議」

**預期結果**：
- ✅ 顯示進度：「進度: X / N」
- ✅ 進度條正常更新
- ✅ 完成後通知：「批量 AI 建議完成：X 成功, Y 失敗」
- ✅ 所有 sheets 的 uploadType 和 mapping 都已填入
- ✅ Console 無「missing mappings array」錯誤

#### 5.3 測試中途取消
1. 點擊「AI 一鍵建議」
2. 在進度 2/5 時點擊「取消」

**預期結果**：
- ✅ 批量執行立即停止
- ✅ 已完成的保留結果
- ✅ 未執行的維持原狀

---

### 步驟 6：完整 One-shot 流程驗收

使用一個包含以下 sheets 的 Excel：
- BOM Edge（標準欄位）
- Demand FG（標準欄位）
- Supplier Master（含各種 status 值）
- Inventory Snapshots（標準欄位）
- FG Financials（標準欄位）

#### 6.1 上傳並執行
1. 開啟 One-shot Import
2. 上傳檔案
3. 點擊「AI 一鍵建議」（等待完成）
4. 檢查所有 enabled sheets
5. 點擊「Import Enabled Sheets」

**預期結果**：
- ✅ **Supplier Master 不再** savedCount=0
- ✅ **BOM Edge / Demand FG / Inventory / FG Financials 不再** 因 auto-mapping 不足而 SKIPPED
- ✅ 大部分 sheets 顯示 「IMPORTED」
- ✅ 若有 sheets 仍然 coverage < 100%，顯示 「NEEDS_REVIEW」（不是 SKIPPED）
- ✅ Import summary 清楚區分：
  - Succeeded（綠色）
  - Needs Review（橘色）
  - Skipped（黃色）
  - Failed（紅色）

#### 6.2 驗證資料庫
在 Supabase 分別檢查各表：
```sql
-- BOM Edges
SELECT COUNT(*) FROM bom_edges WHERE user_id = auth.uid();

-- Demand FG
SELECT COUNT(*) FROM demand_fg WHERE user_id = auth.uid();

-- Suppliers
SELECT COUNT(*), status FROM suppliers 
WHERE user_id = auth.uid() 
GROUP BY status;

-- Inventory Snapshots
SELECT COUNT(*) FROM inventory_snapshots WHERE user_id = auth.uid();

-- FG Financials
SELECT COUNT(*) FROM fg_financials WHERE user_id = auth.uid();
```

**預期結果**：
- ✅ 所有表都有資料（COUNT > 0）
- ✅ Suppliers status 只有 'active' 或 'inactive'

---

### 步驟 7：下載報告並檢查
點擊「Download Report (JSON)」

**預期結果**：
- ✅ JSON 檔案包含 `needsReviewSheets` 欄位
- ✅ sheetReports 中有 `status: "NEEDS_REVIEW"` 的 sheets
- ✅ 每個 NEEDS_REVIEW sheet 都有 `missingFields`, `coverage`, `reason`

---

## ⚠️ 常見問題排查

### Q1: Supplier Master 仍然 savedCount=0
**檢查**：
1. 是否執行了 `fix_suppliers_status.sql`？
2. Console 是否仍有 `suppliers_status_check` 錯誤？
3. 原始資料的 status 欄位值是什麼？（查看 debug log）

**解決**：
- 執行 SQL migration
- 重新啟動 dev server
- 檢查 `normalizeSupplierStatus()` 是否正確處理你的 status 值

### Q2: Sheets 仍被標記為 SKIPPED（而非 NEEDS_REVIEW）
**檢查**：
1. 是否使用最新的 `oneShotImportService.js`？
2. Console log 是否顯示使用 `getRequiredMappingStatus`？

**解決**：
- 確認 build 成功
- 清除瀏覽器快取（Ctrl+Shift+Delete）
- Hard refresh（Ctrl+F5）

### Q3: 單檔上傳的 Next 按鈕仍可點擊（即使 mapping 不完整）
**檢查**：
1. 是否有 Console 錯誤？
2. `mappingComplete` state 是否正確？

**解決**：
- 檢查 `getRequiredMappingStatus` 是否被正確呼叫
- 檢查 Button disabled 屬性是否綁定

### Q4: AI Suggest All 沒有執行
**檢查**：
1. Console 是否有錯誤？
2. 是否有 sheets enabled=true？

**解決**：
- 確認至少有一個 sheet 需要 AI（低信心度或未分類）
- 或勾選「包含已準備好的 sheets」

---

## 🎉 驗收完成標誌

當所有以下項目都 ✅ 時，功能完成：

### 單檔上傳
- [ ] Mapping 不完整時 Next 按鈕 disabled
- [ ] UI 顯示 missing fields
- [ ] Console 顯示錯誤訊息
- [ ] 無法進入 validation step

### One-shot Import - Supplier Master
- [ ] status 正確正規化為 'active' 或 'inactive'
- [ ] savedCount > 0
- [ ] Console 無 `suppliers_status_check` 錯誤
- [ ] DB 中 status 值合法

### One-shot Import - NEEDS_REVIEW 狀態
- [ ] Mapping 不足的 sheets 標記為 NEEDS_REVIEW（不是 SKIPPED）
- [ ] Import summary 區分 Succeeded / Needs Review / Skipped / Failed
- [ ] 標題顯示「Import Requires Review」（若有 needs review）
- [ ] 通知訊息明確提示

### One-shot Import - AI Suggest All
- [ ] 批量執行正常
- [ ] 進度顯示正常
- [ ] 可中途取消
- [ ] Console 無「missing mappings array」錯誤
- [ ] 單張失敗不影響其他

### 整體
- [ ] npm run build 通過
- [ ] 所有測試步驟通過
- [ ] DB 資料正確寫入
- [ ] 無 Console 錯誤

---

## 📞 技術細節

### Status 正規化邏輯
```javascript
normalizeSupplierStatus(status):
  null / undefined / '' → 'active'
  'active' / 'inactive' → 保持不變
  'enabled', 'enable', 'yes', '1' → 'active'
  'disabled', 'disable', 'no', '0', 'suspended' → 'inactive'
  其他未知值 → 'active'（+ console.warn）
```

### Mapping 完整度檢查
```javascript
getRequiredMappingStatus({ uploadType, columns, columnMapping }):
  返回 {
    missingRequired: string[],  // 缺少的 required fields
    isComplete: boolean,         // coverage >= 1.0
    coverage: number,            // 0.0 ~ 1.0
    mappedRequired: string[]     // 已 map 的 required fields
  }
```

### One-shot 狀態流程
```
generateSheetPlans → rule-based mapping
  ↓
若 coverage < 1.0 → 等待 AI Suggest（手動或批量）
  ↓
importWorkbookSheets → 再次檢查 coverage
  ↓
若仍 < 1.0 → status: 'NEEDS_REVIEW'（不允許匯入）
若 >= 1.0 → 執行 ingest → status: 'IMPORTED'
```

---

所有功能已實作並通過 build 驗收！🚀
