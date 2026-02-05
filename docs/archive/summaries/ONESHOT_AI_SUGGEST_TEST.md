# One-shot AI Suggest 功能驗收測試

## 功能概述
在 One-shot Sheet Plans 表格中為每個 sheet 新增「AI Suggest」按鈕，點擊後：
- 智能推薦 uploadType
- 生成欄位 mapping
- 計算 confidence 與 required fields 覆蓋率
- 自動填入 Upload Type dropdown
- 若符合條件（confidence >= 0.75 且 required fields 覆蓋率 >= 1.0），自動 enable
- 顯示 AI 推薦理由（reasons）

## 最小驗收標準
✅ 至少 1 個低信心度 sheet 點擊「AI Suggest」後能自動填入 uploadType + mapping
✅ AI reasons 顯示在 Status 欄位
✅ 若 confidence >= 0.75 且 required coverage >= 1.0，自動勾選 Enable
✅ 若 sheet rows > 1000 且 DB 未部署 chunk-idempotency，不 auto-enable（顯示警告）

---

## 測試環境準備

### 1. 準備測試資料

#### 測試檔案 1：`test_low_confidence_sheets.xlsx`
建立一個包含 2 個 sheets 的 Excel 檔案：

**Sheet 1: "不清楚的資料"**
- 欄位：`A欄`, `B欄`, `C欄`, `數量`, `日期`
- 資料：隨意填入 10 rows
- 預期：低信心度（< 0.75），需要 AI Suggest

**Sheet 2: "Supplier Data"**
- 欄位：`Company Name`, `Contact`, `Phone`, `Email`, `Address`
- 資料：填入 10 筆供應商資料
- 預期：AI 應能推薦為 `supplier_master`

#### 測試檔案 2：`test_mixed_confidence.xlsx`
建立一個包含 3 個 sheets 的 Excel 檔案：

**Sheet 1: "BOM Data"**
- 欄位：`parent_material`, `component_material`, `qty`, `uom`
- 資料：填入 20 rows
- 預期：高信心度，AI 應推薦為 `bom_edge` 並 auto-enable

**Sheet 2: "模糊的庫存"**
- 欄位：`料號`, `數量`, `倉庫`, `日期`
- 資料：填入 15 rows
- 預期：中低信心度，AI Suggest 後可能推薦 `inventory_snapshots`

**Sheet 3: "大量資料"**
- 欄位：`material_code`, `plant_id`, `on_hand_qty`, `available_qty`
- 資料：**填入 1200 rows**（使用 Excel 公式或腳本生成）
- 預期：即使 AI 信心度高，若 DB 未部署 chunk-idempotency，不應 auto-enable

---

## 測試案例

### Test Case 1: 低信心度 Sheet 使用 AI Suggest

**前置條件：**
- 上傳 `test_low_confidence_sheets.xlsx`
- 勾選 "One-shot Import"

**步驟：**
1. 檔案解析後，進入 Sheet Plans 頁面
2. 觀察 "不清楚的資料" sheet：
   - Confidence 應為低（< 50%）
   - Upload Type 為空或不確定
   - Status 顯示 "Low confidence - please specify type"
3. 點擊該 sheet 的「AI Suggest」按鈕
4. 等待 AI 分析（按鈕顯示 "AI 分析中..."）
5. AI 完成後，觀察變化

**預期結果：**
- ✅ Upload Type 自動填入（可能是 `supplier_master` 或其他）
- ✅ Confidence 更新為 AI 計算的信心度
- ✅ Status 欄位顯示 AI reasons（例如："Mapping confidence: 85%", "Required fields coverage: 100%"）
- ✅ 若 confidence >= 0.75 且 coverage >= 1.0，Enable 自動勾選
- ✅ Sheet Name 旁顯示 "AI Suggested" 標籤（紫色 Sparkles 圖示）

---

### Test Case 2: Supplier Master 自動推薦

**前置條件：**
- 使用 `test_low_confidence_sheets.xlsx` 的 "Supplier Data" sheet

**步驟：**
1. 進入 Sheet Plans 頁面
2. 觀察 "Supplier Data" sheet：
   - 可能已有初步分類（confidence 中等）
3. 點擊「AI Suggest」按鈕
4. 等待 AI 分析

**預期結果：**
- ✅ Upload Type 自動填入為 `supplier_master`
- ✅ Confidence >= 75%
- ✅ Status 顯示：
   - "Mapping confidence: XX%"
   - "Required fields coverage: 100%"
   - "Overall confidence: XX%"
- ✅ Enable 自動勾選
- ✅ 可以成功匯入（點擊 "Import Enabled Sheets"）

**驗證資料庫：**
```sql
SELECT * FROM public.suppliers WHERE batch_id = '<剛才的 batch_id>';
-- 預期：10 筆供應商資料成功寫入
```

---

### Test Case 3: 混合信心度 Sheets（批量測試）

**前置條件：**
- 上傳 `test_mixed_confidence.xlsx`

**步驟：**
1. 進入 Sheet Plans 頁面
2. 觀察初步分類結果：
   - "BOM Data": 可能已高信心度分類為 `bom_edge`
   - "模糊的庫存": 可能低信心度或未分類
   - "大量資料": 即使高信心度，若 >1000 rows，應標記為需要檢查
3. 對 "模糊的庫存" 點擊「AI Suggest」
4. 對 "大量資料" 點擊「AI Suggest」
5. 觀察結果

**預期結果（"模糊的庫存"）：**
- ✅ AI 推薦 uploadType（可能是 `inventory_snapshots`）
- ✅ Mapping confidence 顯示
- ✅ 若符合條件，auto-enable

**預期結果（"大量資料"）：**
- ✅ AI 推薦 uploadType（應為 `inventory_snapshots`）
- ✅ Confidence 可能 >= 75%
- ✅ Required coverage >= 1.0
- ❌ **但 Enable 不應自動勾選**（因為 >1000 rows）
- ✅ Status/Reasons 中顯示警告：
   - "⚠ Sheet has >1000 rows but DB chunk-idempotency not deployed. Please enable manually after reviewing."

**手動勾選後：**
- 點擊 "Import Enabled Sheets"
- 觀察進度條顯示 chunk 分批寫入（Chunk 1/3, Chunk 2/3, etc.）
- 成功匯入

---

### Test Case 4: 已有 uploadType 的 Sheet（AI 優化 Mapping）

**前置條件：**
- 上傳 `test_mixed_confidence.xlsx`
- "BOM Data" sheet 已被分類為 `bom_edge`

**步驟：**
1. 進入 Sheet Plans 頁面
2. 確認 "BOM Data" 的 Upload Type 已為 `bom_edge`
3. 點擊「AI Suggest」按鈕
4. 觀察結果

**預期結果：**
- ✅ Upload Type 保持為 `bom_edge`（不改變）
- ✅ AI 優化 mapping（內部 columnMapping 更新，但 UI 不直接顯示）
- ✅ Confidence 可能提升
- ✅ Reasons 更新為 AI 提供的詳細理由

---

### Test Case 5: AI Suggest 失敗處理

**模擬步驟：**
1. 暫時停用 Gemini API Key：
   - 打開瀏覽器 Console
   - 執行：`localStorage.removeItem('gemini_api_key')`
   - 重新整理頁面
2. 上傳測試檔案
3. 點擊「AI Suggest」按鈕

**預期結果：**
- ❌ AI Suggest 失敗
- ✅ 顯示錯誤通知：「AI 建議失敗：[錯誤訊息]」
- ✅ Upload Type 保持原樣（不改變）
- ✅ Confidence 不變
- ✅ 按鈕恢復可點擊狀態（不卡住）

**還原環境：**
- 前往 Settings 重新設定 Gemini API Key

---

## 驗收清單

### 功能驗收
- [ ] 表格新增「Actions」欄位，包含「AI Suggest」按鈕
- [ ] 按鈕點擊後顯示 loading 狀態（"AI 分析中..."）
- [ ] AI 完成後，Upload Type 自動填入
- [ ] Confidence 更新為 AI 計算值
- [ ] Status/Reasons 欄位顯示 AI 推薦理由（至少 3 條）
- [ ] 若 confidence >= 0.75 且 required coverage >= 1.0，auto-enable
- [ ] Sheet Name 旁顯示 "AI Suggested" 標籤
- [ ] 顯示 Required fields 覆蓋率百分比

### 邊界條件驗收
- [ ] Sheet rows > 1000 且 DB 未部署 chunk-idempotency：不 auto-enable，顯示警告
- [ ] Sheet rows > 1000 且 DB 已部署 chunk-idempotency：可 auto-enable
- [ ] AI Suggest 失敗時，顯示錯誤通知且不破壞現有資料
- [ ] 多個 sheets 同時點擊 AI Suggest：各自獨立處理，互不干擾

### UI/UX 驗收
- [ ] AI Suggest 按鈕樣式正確（紫色主題，Sparkles 圖示）
- [ ] Loading 狀態清晰（按鈕 disabled，顯示 spinner）
- [ ] AI Suggested 標籤樣式正確（紫色，Sparkles 圖示）
- [ ] Reasons 顯示區域不破壞表格排版（最多顯示 3 條，超過顯示 "+X more..."）
- [ ] 長 reasons 文字自動截斷（hover 顯示完整內容）

### 靜態驗收
- [ ] `npm run build` 成功
- [ ] Console 無 critical errors（允許 info/warning）

---

## 常見問題排查

### 問題 1: 點擊 AI Suggest 後無反應
**可能原因：**
- Gemini API Key 未設定或過期
- 網路連線問題

**解決方式：**
1. 檢查 Console 錯誤訊息
2. 前往 Settings 確認 API Key
3. 測試網路連線

---

### 問題 2: AI 推薦的 uploadType 不正確
**可能原因：**
- 資料欄位過於模糊
- 樣本資料不足（< 10 rows）

**解決方式：**
1. 手動修改 Upload Type dropdown
2. 提供更清晰的欄位名稱（例如：`material_code` 而非 `料號`）

---

### 問題 3: Confidence 很高但未 auto-enable
**可能原因：**
- Required fields 覆蓋率 < 100%
- Sheet rows > 1000 且 DB 未部署 chunk-idempotency

**解決方式：**
1. 檢查 Status/Reasons 中的警告訊息
2. 若是欄位覆蓋率問題，檢查 "Missing: ..." 提示
3. 若是 >1000 rows 問題，執行 `database/one_shot_chunk_idempotency.sql`

---

## 成功標準

✅ **必須通過所有 Test Cases**  
✅ **至少 1 個低信心度 sheet 成功使用 AI Suggest**  
✅ **AI reasons 清晰顯示**  
✅ **Auto-enable 邏輯正確運作**  
✅ **錯誤處理穩定，不 crash**  

驗收完成後，功能可投入生產使用。

---

## 相關檔案

### 新增檔案
- `src/services/oneShotAiSuggestService.js` - AI Suggest 核心邏輯

### 修改檔案
- `src/views/EnhancedExternalSystemsView.jsx` - UI 整合，新增 AI Suggest 按鈕與狀態管理

---

## 後續優化建議

1. **批量 AI Suggest**：允許一次對所有低信心度 sheets 執行 AI Suggest
2. **AI Suggest 快取**：相同 headers 的 sheet 可重用之前的 AI 結果
3. **手動調整 Mapping**：在 Sheet Plans 頁面直接編輯欄位映射（類似單 sheet 的 mapping step）
4. **AI Suggest 歷史**：記錄每次 AI Suggest 的結果，供使用者比對
5. **信心度閾值調整**：允許使用者設定 auto-enable 的 confidence 門檻（預設 0.75）
