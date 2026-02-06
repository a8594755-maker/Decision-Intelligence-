# Two-step Gate 驗收清單

## ✅ 已完成項目（本次工作）

### **1. 核心基礎設施修復**
- [x] **UUID 欄位修復**（前次修復已完成）
  - 檔案: `src/services/uploadStrategies.js`
  - 所有策略已補齊 `user_id` 和 `batch_id`
  
- [x] **錯誤診斷改進**（前次修復已完成）
  - 檔案: `src/services/chunkIngestService.js`
  - extractErrorDetails() 提取完整 Postgres error 資訊
  
- [x] **自動補齊功能**（前次修復已完成）
  - 檔案: `src/utils/dataAutoFill.js`
  - autoFillRows() 自動補齊常見缺漏
  
- [x] **Suppliers Status Check 修復**
  - 檔案: `database/fix_suppliers_status.sql`
  - 清理不合法 status 值，設定 DEFAULT 'active'
  
- [x] **Required Mapping Status Helper**（已存在）
  - 檔案: `src/utils/requiredMappingStatus.js`
  - getRequiredMappingStatus() 檢查 required fields coverage

### **2. AI Suggest 函數**
- [x] **suggestSheetType()** - 只建議 uploadType（本次新增）
  - 檔案: `src/services/oneShotAiSuggestService.js`
  - 實現 Step 1 所需的 type-only classification
  
- [x] **suggestMappingWithLLM()** - 只建議 mapping（已存在）
  - 檔案: `src/services/oneShotAiSuggestService.js`
  - 實現 Step 2 所需的 field mapping suggestion

### **3. 文件與計劃**
- [x] **實施計劃**
  - 檔案: `TWO_STEP_GATE_IMPLEMENTATION_PLAN.md`
  - 詳細的 Phase-by-Phase 實施計劃
  
- [x] **最終總結**
  - 檔案: `TWO_STEP_GATE_FINAL_SUMMARY.md`
  - 包含完整的 UI 代碼片段和實施指南
  
- [x] **驗收清單**
  - 檔案: `TWO_STEP_GATE_VERIFICATION_CHECKLIST.md`（本文件）

### **4. 構建驗證**
- [x] **npm run build 通過**
  - 所有修改已通過構建測試
  - 無語法錯誤，無 import 問題

---

## ⏳ 待實施項目（大型 UI 重構）

### **Phase A: UI State Management**
檔案: `src/views/EnhancedExternalSystemsView.jsx`

- [ ] 新增 `currentStep` 狀態（1: Classification, 2: Mapping Review, 3: Import）
- [ ] 新增 `currentSheetIndex` 狀態（在 Mapping Review 中當前編輯的 sheet）
- [ ] 修改 `sheetPlans` 結構，新增以下欄位：
  - [ ] `typeConfirmed: boolean`
  - [ ] `headers: string[]`
  - [ ] `mappingDraft: {}`
  - [ ] `mappingFinal: null`
  - [ ] `mappingConfirmed: boolean`
  - [ ] `requiredCoverage: number`
  - [ ] `missingRequired: string[]`
  - [ ] `isComplete: boolean`

### **Phase B: Step 1 UI - Sheet Classification**
檔案: `src/views/EnhancedExternalSystemsView.jsx`

- [ ] 實現 Sheet Plans 表格 UI
  - [ ] Enabled checkbox
  - [ ] Sheet Name
  - [ ] Upload Type dropdown
  - [ ] Confidence %
  - [ ] Reasons (前 2 + "+X more")
  - [ ] AI Suggest Type 按鈕（單個）
- [ ] 實現 AI Suggest All Types 按鈕（批量）
  - [ ] 顯示 overall progress (X/N)
  - [ ] 支援 Abort/Cancel
  - [ ] 使用 runWithConcurrencyAbortable (concurrency 2)
- [ ] 實現 handleAiSuggestType()
- [ ] 實現 handleAiSuggestAllTypes()
- [ ] 實現 handleNextToMappingReview()
  - [ ] Gate: 至少一個 enabled sheet
  - [ ] Gate: 所有 enabled sheets 有 uploadType

### **Phase C: Step 2 UI - Mapping Review**
檔案: `src/views/EnhancedExternalSystemsView.jsx`

- [ ] 實現左側 Sheet 清單
  - [ ] 顯示 enabled sheets
  - [ ] 可切換當前編輯的 sheet
  - [ ] 顯示 Confirmed/Ready/Incomplete 狀態
- [ ] 實現中間/右側 Mapping Panel
  - [ ] 顯示 Field Mapping 表格（Excel Column → Target Field）
  - [ ] 可手動編輯 mappingDraft
  - [ ] 顯示 Required Coverage % 和 Missing Required
  - [ ] AI Field Suggestion 按鈕（單個）
  - [ ] Confirm Mapping 按鈕（isComplete=false 時 disabled）
  - [ ] Unlock & Edit 按鈕（已 confirmed 後可解鎖）
- [ ] 實現 AI Suggest All Mappings 按鈕（批量）
- [ ] 實現 handleAiFieldSuggestion()
  - [ ] Rule-based mapping first
  - [ ] If coverage<1.0, fallback to LLM
  - [ ] Merge mappings (prioritize missing required)
  - [ ] Update mappingDraft (not mappingFinal)
- [ ] 實現 handleMappingChange()（手動編輯 mapping）
- [ ] 實現 handleConfirmMapping()
  - [ ] Gate: isComplete=true
  - [ ] Lock mappingFinal = mappingDraft
  - [ ] Set mappingConfirmed=true
- [ ] 實現 handleUnlockMapping()
- [ ] 實現 handleNextToImport()
  - [ ] Gate: 所有 enabled sheets 都 mappingConfirmed=true

### **Phase D: Import Logic - 只使用 mappingFinal**
檔案: `src/services/oneShotImportService.js`

- [ ] 修改 importWorkbookSheets()
  - [ ] 接收 sheetPlans (含 mappingFinal)
  - [ ] Hard gate 1: 必須有 mappingFinal
  - [ ] Hard gate 2: 必須 isComplete (coverage=1.0)
  - [ ] 傳入 columnMapping: plan.mappingFinal 到 importSingleSheet
- [ ] 修改 importSingleSheet()
  - [ ] 只使用 providedMapping（不允許 fallback）
  - [ ] 若無 providedMapping → NEEDS_REVIEW
  - [ ] Double check: getRequiredMappingStatus
  - [ ] 若 coverage<1.0 → NEEDS_REVIEW
  - [ ] 移除內部 ruleBasedMapping 和 LLM fallback

### **Phase E: 單檔模式硬門檻**
檔案: `src/views/EnhancedExternalSystemsView.jsx`

- [ ] 新增 canProceedToValidation useMemo
  - [ ] One-shot mode: return true (使用 Two-step gate)
  - [ ] 單檔模式: 檢查 getRequiredMappingStatus().isComplete
- [ ] 新增 missingRequiredFields useMemo
- [ ] 顯示 missing required fields 警告（單檔模式）
- [ ] Next/Save 按鈕 disabled 條件
  - [ ] disabled={!canProceedToValidation || loading}
  - [ ] 按鈕文字動態顯示 missing fields
- [ ] handleValidateData() 加入 guard
  - [ ] if (!canProceedToValidation) return
- [ ] handleSave() 加入 guard
  - [ ] if (!canProceedToValidation) return

---

## 🧪 完整驗收步驟（待 UI 實施完成後）

### **前置準備**
1. [ ] 在 Supabase SQL Editor 執行 `database/fix_suppliers_status.sql`
2. [ ] 準備測試檔案 `Mock data.xlsx`（包含 BOM, Demand, Inventory, FG Financials, Supplier Master）
3. [ ] npm run dev 啟動開發伺服器

### **驗收 A: Suppliers Status Check**
1. [ ] 上傳 Supplier Master sheet
2. [ ] 匯入後檢查 savedCount > 0（不再是 0）
3. [ ] Console 無 `suppliers_status_check` violation

### **驗收 B: One-shot Two-step Gate**

#### **Step 1: Sheet Classification**
1. [ ] 上傳 Mock data.xlsx（One-shot mode）
2. [ ] 進入 Sheet Classification 頁面
3. [ ] 點擊單個 sheet 的 "AI Suggest Type"
   - [ ] Loading 狀態顯示
   - [ ] AI 回傳後 uploadType 自動填入
   - [ ] Confidence % 顯示
   - [ ] Reasons 顯示（前 2 + "+X more"）
4. [ ] 點擊 "AI Suggest All Types"
   - [ ] Progress 顯示 (X/N)
   - [ ] 可中途 Cancel
   - [ ] 所有 enabled/low confidence sheets 完成建議
5. [ ] 嘗試點擊 "Next: Review Mappings"
   - [ ] 無 enabled sheets → 顯示錯誤
   - [ ] Enable 至少一個 sheet → 可進入 Step 2

#### **Step 2: Mapping Review**
1. [ ] 左側顯示 enabled sheets 清單
   - [ ] 可切換當前編輯的 sheet
   - [ ] 顯示狀態（Confirmed/Ready/Incomplete）
2. [ ] 中間顯示 Field Mapping UI
   - [ ] 顯示 Excel Column → Target Field 對應
   - [ ] Required Coverage % 正確
   - [ ] Missing Required 正確顯示
3. [ ] 點擊 "AI Field Suggestion"
   - [ ] Rule-based mapping 先執行
   - [ ] 若 coverage<1.0，自動 fallback LLM
   - [ ] mappingDraft 更新
   - [ ] Coverage % 更新
4. [ ] 手動編輯 mapping（修改 dropdown）
   - [ ] Coverage % 即時更新
   - [ ] Missing Required 即時更新
5. [ ] 點擊 "Confirm Mapping"
   - [ ] isComplete=false 時 disabled
   - [ ] isComplete=true 時可點擊
   - [ ] 點擊後狀態變為 "Confirmed"
   - [ ] mappingFinal 被鎖定
   - [ ] 按鈕變為 disabled 且文字 "Confirmed"
6. [ ] 點擊 "Unlock & Edit"
   - [ ] mappingConfirmed 變為 false
   - [ ] 可重新編輯
7. [ ] 點擊 "AI Suggest All Mappings"
   - [ ] 批量處理所有 enabled sheets
   - [ ] Progress 顯示
   - [ ] 可 Cancel
8. [ ] 嘗試點擊 "Next: Import"
   - [ ] 任一 enabled sheet 未 confirmed → 顯示錯誤
   - [ ] 所有 enabled sheets confirmed → 進入 Step 3（開始匯入）

#### **Step 3: Import**
1. [ ] Import 自動開始
2. [ ] 顯示進度（X/N sheets, chunk progress）
3. [ ] Console 檢查：
   - [ ] 每個 sheet 使用 mappingFinal
   - [ ] 無內部 ruleBasedMapping 或 LLM fallback
   - [ ] Auto-fill logs 顯示（若有補齊）
4. [ ] Import Summary 顯示
   - [ ] Succeeded: X
   - [ ] Failed: X
   - [ ] Needs Review: X（無 mappingFinal 或 coverage<1.0）
   - [ ] Skipped: X（empty sheet or idempotency）
   - [ ] 若 Needs Review>0 → 標題 "Import Requires Review"
   - [ ] 否則 → 標題 "Import Completed"
5. [ ] Download Report (JSON)
   - [ ] 包含每個 sheet 的 status, reason, coverage, mappingFinal

### **驗收 C: 單檔模式硬門檻**
1. [ ] 關閉 One-shot mode（單檔上傳）
2. [ ] 上傳單個檔案（例如 BOM.xlsx）
3. [ ] 進入 Field Mapping 頁面
4. [ ] 故意不 map 某個 required field
   - [ ] "Next: Validate Data" 按鈕 disabled
   - [ ] 顯示警告：Missing required fields: xxx
5. [ ] 點擊 disabled 的 Next 按鈕
   - [ ] 不會進入下一步
   - [ ] Console 無錯誤
6. [ ] Map 所有 required fields
   - [ ] "Next: Validate Data" 按鈕 enabled
   - [ ] 警告消失
7. [ ] 點擊 Next
   - [ ] 成功進入 Validation 頁面

### **驗收 D: Build & Compatibility**
1. [ ] npm run build
   - [ ] Exit code: 0
   - [ ] 無語法錯誤
2. [ ] 既有功能正常
   - [ ] Chunk ingest
   - [ ] Abort（One-shot import 可中途取消）
   - [ ] Progress bars
   - [ ] Download report
   - [ ] Auto-fill

---

## 📊 當前狀態總結

### **✅ 已就緒（可立即使用）**
1. UUID 欄位修復（All chunks no longer fail due to missing user_id/batch_id）
2. 錯誤診斷改進（Clear error messages with column/row details）
3. 自動補齊功能（Auto-fill common missing fields）
4. Suppliers status check 修復 SQL
5. suggestSheetType() API（Step 1 type-only classification）
6. suggestMappingWithLLM() API（Step 2 field mapping suggestion）
7. npm run build 通過

### **⏳ 待實施（大型 UI 重構）**
1. Two-step Gate UI（Step 1: Classification, Step 2: Mapping Review, Step 3: Import）
   - 預計修改量：`EnhancedExternalSystemsView.jsx` 500+ 行
2. Import Logic 改用 mappingFinal（禁止 fallback）
   - 預計修改量：`oneShotImportService.js` 100+ 行
3. 單檔模式硬門檻（Field Mapping gate）
   - 預計修改量：`EnhancedExternalSystemsView.jsx` 50+ 行

### **📦 交付物**
- ✅ `TWO_STEP_GATE_IMPLEMENTATION_PLAN.md` - 詳細實施計劃
- ✅ `TWO_STEP_GATE_FINAL_SUMMARY.md` - 完整代碼片段與實施指南
- ✅ `TWO_STEP_GATE_VERIFICATION_CHECKLIST.md` - 本驗收清單
- ✅ `ONESHOT_UUID_BUGFIX.md` - UUID 欄位修復報告（前次）
- ✅ `ONESHOT_CHUNKS_FINAL_FIX.md` - Chunks 全掛修復報告（前次）
- ✅ `database/fix_suppliers_status.sql` - DB 修復 SQL

---

## 🎯 建議執行順序

### **立即執行（無需程式修改）**
1. 在 Supabase SQL Editor 執行 `database/fix_suppliers_status.sql`
2. 驗證 npm run build（✅ 已通過）

### **Phase 1: Step 1 UI（預計 2-3 小時）**
1. 新增 currentStep 狀態管理
2. 實現 Sheet Classification UI
3. 實現 handleAiSuggestType()
4. 實現 handleAiSuggestAllTypes()
5. 測試 Step 1 → Step 2 transition

### **Phase 2: Step 2 UI（預計 3-4 小時）**
1. 實現 Mapping Review UI（左側清單 + 中間 mapping panel）
2. 實現 handleAiFieldSuggestion()
3. 實現 handleConfirmMapping() / handleUnlockMapping()
4. 測試 Step 2 → Step 3 transition

### **Phase 3: Import Logic（預計 1-2 小時）**
1. 修改 importWorkbookSheets()（使用 mappingFinal）
2. 修改 importSingleSheet()（禁止 fallback）
3. 測試完整 import flow

### **Phase 4: 單檔模式硬門檻（預計 1 小時）**
1. 新增 canProceedToValidation gate
2. 修改 Next/Save 按鈕 disabled 條件
3. 測試單檔 Field Mapping gate

### **總預計時間: 7-10 小時**

---

**所有基礎設施已就緒！詳細實施指南已提供！可以開始 UI 重構了！** 🚀
