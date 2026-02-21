# One-shot AI Suggest 功能實作摘要

## 功能概述
在 One-shot Sheet Plans 表格中為每個 sheet 新增「AI Suggest」按鈕，提供智能推薦：
- **自動判斷 uploadType**（若未指定）
- **生成欄位 mapping**
- **計算信心度與 required fields 覆蓋率**
- **自動填入 Upload Type + 選擇性 auto-enable**
- **顯示 AI 推薦理由**

---

## 實作內容

### 新增檔案

#### 1. `src/services/oneShotAiSuggestService.js`

**功能：**
- `suggestSheetMapping({ sheetName, headers, sampleRows, currentUploadType, hasIngestKeySupport })`
  - 若無 `currentUploadType`：
    1. 先用本地 `classifySheet` 快速篩選（來自 `sheetClassifier.js`）
    2. 若本地信心度 < 0.6，呼叫 Gemini AI 推薦 uploadType
  - 若有 `currentUploadType`：直接使用
  - 呼叫 Gemini AI 生成 mapping（使用 `generateMappingPrompt` from `aiMappingHelper.js`）
  - 驗證 mapping 格式（使用 `validateMappingResponse`）
  - 計算 required fields 覆蓋率
  - 計算 overall confidence（綜合 type confidence 和 mapping confidence）
  - 決定是否 auto-enable：
    - `confidence >= 0.75` 且 `requiredCoverage >= 1.0`
    - 若 sheet rows > 1000 且 `!hasIngestKeySupport`，不 auto-enable
  - 返回：`{ suggestedUploadType, mapping, mappings, confidence, reasons, autoEnable, requiredCoverage }`

**關鍵邏輯：**
```javascript
// Step 1: 推薦 uploadType（若需要）
const classifyResult = classifySheet({ sheetName, headers, sampleRows });
if (classifyResult.confidence >= 0.6) {
  uploadType = classifyResult.suggestedType;
} else {
  // 呼叫 AI
  const typePrompt = generateUploadTypePrompt(headers, sampleRows);
  const aiTypeResponse = await callGeminiAPI(typePrompt, '', { temperature: 0.3 });
  const parsedType = extractAiJson(aiTypeResponse);
  uploadType = parsedType.suggestedType;
}

// Step 2: 生成 mapping
const mappingPrompt = generateMappingPrompt(uploadType, schema.fields, headers, limitedSampleRows);
const aiMappingResponse = await callGeminiAPI(mappingPrompt, '', { temperature: 0.3 });
const parsedMapping = extractAiJson(aiMappingResponse);

// Step 3: 計算覆蓋率與信心度
const requiredCoverage = requiredFields.filter(rf => mappedFields.includes(rf)).length / requiredFields.length;
const overallConfidence = (typeConfidence + avgMappingConfidence) / 2;

// Step 4: 決定 auto-enable
let autoEnable = overallConfidence >= 0.75 && requiredCoverage >= 1.0;
```

**Helper Functions：**
- `generateUploadTypePrompt(headers, sampleRows)`: 生成 AI prompt，要求分類到 6 種 uploadType 之一

---

### 修改檔案

#### 1. `src/views/EnhancedExternalSystemsView.jsx`

**新增狀態：**
```javascript
const [aiSuggestLoading, setAiSuggestLoading] = useState({}); // { sheetName: boolean }
```

**新增函式：`handleAiSuggest(plan)`**
- 從 workbook 讀取該 sheet 的 headers + sampleRows
- 檢查 DB 是否支援 chunk idempotency（`checkIngestKeySupport`）
- 呼叫 `suggestSheetMapping(...)`
- 更新 `sheetPlan`：
  - `uploadType`, `confidence`, `reasons`, `mapping`, `enabled`, `aiSuggested`, `requiredCoverage`
  - 若 rows > 1000 且 `!hasIngestKeySupport`：強制 `enabled = false` + 加入警告 reason
- 顯示成功/失敗通知

**關鍵實作：**
```javascript
const handleAiSuggest = async (plan) => {
  const { sheetName } = plan;
  
  try {
    setAiSuggestLoading(prev => ({ ...prev, [sheetName]: true }));
    
    // 讀取 sheet 資料
    const sheet = workbook.Sheets[sheetName];
    const sheetData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    const headers = sheetData[0] || [];
    const sampleRows = sheetData.slice(1, 31).map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] || ''; });
      return obj;
    });
    
    // 檢查 chunk idempotency 支援
    const { checkIngestKeySupport } = await import('../services/sheetRunsService');
    const hasIngestKeySupport = await checkIngestKeySupport();
    
    // 呼叫 AI Suggest
    const result = await suggestSheetMapping({
      sheetName, headers, sampleRows,
      currentUploadType: plan.uploadType || null,
      hasIngestKeySupport
    });
    
    // 更新 sheet plan
    const updates = {
      uploadType: result.suggestedUploadType,
      confidence: result.confidence,
      reasons: result.reasons,
      mapping: result.mapping,
      enabled: result.autoEnable,
      aiSuggested: true,
      requiredCoverage: result.requiredCoverage
    };
    
    // 若 >1000 rows 且無 ingest key support，強制不 auto-enable
    if (plan.rowCount > 1000 && !hasIngestKeySupport) {
      updates.enabled = false;
      updates.reasons = [
        ...result.reasons,
        '⚠ Sheet has >1000 rows but DB chunk-idempotency not deployed. Please enable manually after reviewing.'
      ];
    }
    
    updateSheetPlan(sheetName, updates);
    addNotification(`AI 建議完成：${result.suggestedUploadType} (信心度: ${Math.round(result.confidence * 100)}%)`, 'success');
    
  } catch (error) {
    addNotification(`AI 建議失敗：${error.message}`, 'error');
  } finally {
    setAiSuggestLoading(prev => ({ ...prev, [sheetName]: false }));
  }
};
```

**UI 更新：**

1. **新增 Actions 欄位**（表格 header）：
```jsx
<th className="px-4 py-3 text-left text-sm font-semibold w-32">Actions</th>
```

2. **新增 AI Suggest 按鈕**（表格 body）：
```jsx
<td className="px-4 py-3">
  <button
    onClick={() => handleAiSuggest(plan)}
    disabled={aiSuggestLoading[plan.sheetName] || saving}
    className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-purple-700 bg-purple-100 rounded-md hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:hover:bg-purple-900/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
  >
    {aiSuggestLoading[plan.sheetName] ? (
      <>
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>AI 分析中...</span>
      </>
    ) : (
      <>
        <Sparkles className="w-3.5 h-3.5" />
        <span>AI Suggest</span>
      </>
    )}
  </button>
</td>
```

3. **顯示 AI Suggested 標籤**（Sheet Name 欄位）：
```jsx
<td className="px-4 py-3">
  <div className="flex flex-col gap-1">
    <span className="font-medium">{plan.sheetName}</span>
    {plan.aiSuggested && (
      <span className="text-xs text-purple-600 dark:text-purple-400 flex items-center gap-1">
        <Sparkles className="w-3 h-3" />
        AI Suggested
      </span>
    )}
  </div>
</td>
```

4. **顯示 Required Coverage**（Confidence 欄位）：
```jsx
<td className="px-4 py-3">
  {plan.confidence > 0 ? (
    <div className="flex flex-col gap-1">
      <span className={`px-2 py-1 rounded text-xs font-semibold inline-block ...`}>
        {Math.round(plan.confidence * 100)}%
      </span>
      {plan.requiredCoverage !== undefined && (
        <span className="text-xs text-slate-500">
          覆蓋率: {Math.round(plan.requiredCoverage * 100)}%
        </span>
      )}
    </div>
  ) : (
    <span className="text-slate-400 text-xs">-</span>
  )}
</td>
```

5. **顯示 AI Reasons**（Status 欄位）：
```jsx
{plan.enabled ? (
  <div className="flex flex-col gap-1">
    <div className="flex items-center gap-2">
      <Check className="w-4 h-4 text-green-600" />
      <span className="text-xs text-green-600 dark:text-green-400">Ready ({plan.rowCount} rows)</span>
    </div>
    {plan.reasons && plan.reasons.length > 0 && (
      <div className="text-xs text-slate-500 ml-6 mt-1">
        {plan.reasons.slice(0, 3).map((reason, i) => (
          <div key={i} className="truncate" title={reason}>
            {reason}
          </div>
        ))}
        {plan.reasons.length > 3 && (
          <div className="text-slate-400 italic">+{plan.reasons.length - 3} more...</div>
        )}
      </div>
    )}
  </div>
) : (
  <span className="text-xs text-slate-400">Disabled</span>
)}
```

**新增 Import：**
```javascript
import { suggestSheetMapping } from '../services/oneShotAiSuggestService';
```

---

## 技術架構

### 流程圖

```
User clicks "AI Suggest" button
  ↓
handleAiSuggest(plan)
  ↓
Read sheet data from workbook (headers + 30 sample rows)
  ↓
Check DB ingest_key support (checkIngestKeySupport)
  ↓
Call suggestSheetMapping({ sheetName, headers, sampleRows, currentUploadType, hasIngestKeySupport })
  ↓
  [oneShotAiSuggestService.js]
  ↓
  ├─ Has currentUploadType?
  │  ├─ Yes → Use it directly
  │  └─ No → 
  │     ├─ Try local classifySheet (from sheetClassifier.js)
  │     │  ├─ Confidence >= 0.6 → Use result
  │     │  └─ Confidence < 0.6 → Call Gemini AI for uploadType
  │     └─ Use AI result
  ↓
  Generate mapping prompt (generateMappingPrompt)
  ↓
  Call Gemini AI for mapping (callGeminiAPI)
  ↓
  Parse & validate mapping (extractAiJson, validateMappingResponse)
  ↓
  Calculate required coverage (matched required fields / total required fields)
  ↓
  Calculate overall confidence ((type confidence + avg mapping confidence) / 2)
  ↓
  Decide auto-enable (confidence >= 0.75 && coverage >= 1.0)
  ↓
  Return { suggestedUploadType, mapping, mappings, confidence, reasons, autoEnable, requiredCoverage }
  ↓
[Back to handleAiSuggest]
  ↓
Update sheetPlan (uploadType, confidence, reasons, mapping, enabled, aiSuggested, requiredCoverage)
  ↓
If (rowCount > 1000 && !hasIngestKeySupport):
  ├─ Force enabled = false
  └─ Add warning to reasons
  ↓
Show success notification
  ↓
UI updates (Upload Type dropdown filled, Confidence updated, Reasons displayed, AI Suggested badge shown)
```

---

## 關鍵決策與實作細節

### 1. Confidence 計算方式
- **Type Confidence**（uploadType 推薦信心度）：
  - 本地分類器：基於 fingerprint rules 匹配
  - AI 推薦：由 AI 提供（`parsedType.confidence`）
- **Mapping Confidence**（欄位映射平均信心度）：
  - 所有 mappings 的 confidence 平均值
- **Overall Confidence**：
  - `(typeConfidence + avgMappingConfidence) / 2`

### 2. Auto-enable 條件
```javascript
confidence >= 0.75 && requiredCoverage >= 1.0
```
- **特例**：若 `rowCount > 1000` 且 DB 未部署 `chunk-idempotency`，強制 `enabled = false`
- **Reason**：避免 >1000 rows 的 sheet 在無 chunk 支援時被誤匯入導致失敗

### 3. AI Prompt 設計
- **Temperature: 0.3**（低溫度，提高確定性）
- **maxOutputTokens: 500**（uploadType 推薦）/ **2000**（mapping 生成）
- **Prompt 格式**：極簡 JSON-only 輸出（參考 `aiMappingHelper.js` 的 `generateMappingPrompt`）

### 4. 錯誤處理
- **try-catch 包裹整個流程**
- **失敗時**：
  - 顯示錯誤通知（`addNotification`）
  - 保持原有 sheetPlan 狀態不變
  - 按鈕恢復可點擊（`setAiSuggestLoading({ [sheetName]: false })`）

### 5. 性能優化
- **樣本資料限制**：最多 30 rows（避免 prompt 過長）
- **本地分類器優先**：信心度 >= 0.6 時直接使用，避免 AI 調用
- **Per-sheet Loading 狀態**：允許多個 sheets 同時執行 AI Suggest（各自獨立）

---

## 驗收狀態

### 靜態驗收
✅ `npm run build` 成功（0 errors）

### 手動驗收（待測試）
⏳ Test Case 1: 低信心度 sheet 使用 AI Suggest  
⏳ Test Case 2: Supplier Master 自動推薦  
⏳ Test Case 3: 混合信心度 sheets（批量測試）  
⏳ Test Case 4: 已有 uploadType 的 sheet（AI 優化 mapping）  
⏳ Test Case 5: AI Suggest 失敗處理  

詳細測試指引請參考：`ONESHOT_AI_SUGGEST_TEST.md`

---

## 相關檔案

### 新增檔案 (2)
1. `src/services/oneShotAiSuggestService.js` - AI Suggest 核心邏輯
2. `ONESHOT_AI_SUGGEST_TEST.md` - 完整測試指引
3. `ONESHOT_AI_SUGGEST_SUMMARY.md` - 本文件

### 修改檔案 (1)
1. `src/views/EnhancedExternalSystemsView.jsx` - UI 整合與狀態管理

### 依賴檔案（既有）
- `src/services/geminiAPI.js` - Gemini AI API 調用
- `src/utils/aiMappingHelper.js` - AI prompt 生成與 response 解析
- `src/utils/sheetClassifier.js` - 本地分類器（fingerprint matching）
- `src/services/sheetRunsService.js` - DB ingest_key support 檢查
- `src/utils/uploadSchemas.js` - Schema 定義

---

## 未來優化建議

### 短期（Phase 2）
1. **批量 AI Suggest**：
   - 新增「Suggest All」按鈕
   - 一次對所有低信心度 sheets 執行 AI Suggest
   - 顯示整體進度（"Processing 3/5 sheets..."）

2. **手動調整 Mapping**：
   - 在 Sheet Plans 頁面展開每個 sheet
   - 顯示 AI 推薦的 mapping（source → target）
   - 允許手動修改 mapping

3. **AI Reasons 展開/收合**：
   - 預設只顯示 1-2 條最重要的 reason
   - 點擊「展開」顯示所有 reasons
   - 改善表格排版

### 中期（Phase 3）
1. **AI Suggest 快取**：
   - 對相同 headers 的 sheet 重用之前的 AI 結果
   - 快取到 localStorage（有效期 7 天）
   - 節省 API 調用成本

2. **AI 模型選擇**：
   - 允許使用者在 Settings 中選擇 AI 模型：
     - gemini-3.1-pro（預設）
     - gemini-1.5-pro（準確、較貴）
   - 顯示預估成本

3. **AI Confidence 可視化**：
   - 使用顏色漸層顯示信心度（綠→黃→紅）
   - Hover 顯示詳細的 confidence breakdown

### 長期（Phase 4）
1. **自訂 Fingerprint Rules**：
   - 允許使用者在 Settings 中新增/修改 fingerprint rules
   - 提升本地分類器準確度

2. **AI Learning from Feedback**：
   - 記錄使用者手動修改的 uploadType/mapping
   - 提供「Report AI Mistake」功能
   - 定期 fine-tune AI 模型（若有資源）

3. **多語言支援**：
   - 自動偵測 Excel 欄位語言（中文/英文/日文）
   - 調整 AI prompt 語言
   - 提升非英文欄位的辨識準確度

---

## 結論

✅ **功能已完整實作**  
✅ **`npm run build` 成功**  
✅ **測試指引已提供**  

請依照 `ONESHOT_AI_SUGGEST_TEST.md` 進行手動驗收測試。驗收通過後，功能即可投入生產使用。
