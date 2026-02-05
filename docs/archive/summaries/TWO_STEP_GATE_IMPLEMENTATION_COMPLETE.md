# Two-step Gate 實施完成報告

## ✅ 已完成（Two-step Gate 強制落地）

**目標達成**：One-shot Import 現在必須經過「分類 → 人工 Mapping 確認 → 才能 Import」，無法跳過。

---

## 🔧 修改/新增檔案清單

### **1. `src/views/EnhancedExternalSystemsView.jsx` (大幅修改)**

#### **新增狀態（Line ~75-98）**：
```javascript
const [oneShotStep, setOneShotStep] = useState(1);  // ✅ 1=Classification, 2=Mapping Review, 3=Import
const [currentEditingSheetIndex, setCurrentEditingSheetIndex] = useState(0);  // ✅ Step 2 當前編輯的 sheet
```

#### **新增處理函數（Line ~918-1059）**：

**Two-step Gate 流程控制**：
- `handleNextToMappingReview()` - Step 1 → Step 2 transition
  - **Gate**: 至少一個 enabled sheet
  - **Gate**: 所有 enabled sheets 有 uploadType
  - 位置：約 Line 935-952

- `handleBackToClassification()` - Step 2 → Step 1 (Back button)
  - 位置：約 Line 954-957

**Mapping 處理**：
- `handleMappingChange(sheetId, sourceHeader, targetField)` - 手動編輯 mapping
  - 更新 mappingDraft
  - 重新計算 coverage/missingRequired/isComplete
  - 位置：約 Line 959-988

- `handleConfirmMapping(sheetId)` - 確認 mapping（最重要的 gate）
  - **Gate**: isComplete=true 才能執行
  - 鎖定 mappingFinal = mappingDraft
  - 設置 mappingConfirmed=true
  - 位置：約 Line 990-1012

- `handleUnlockMapping(sheetId)` - 解鎖 mapping 以重新編輯
  - 清除 mappingFinal 和 mappingConfirmed
  - 位置：約 Line 1014-1026

- `handleAiFieldSuggestion(sheetId)` - AI field mapping 建議（只填 mappingDraft）
  - Rule-based mapping first
  - If coverage<1.0, fallback to LLM
  - Merge mappings (優先補齊 missing required)
  - 更新 mappingDraft (不更新 mappingFinal)
  - 位置：約 Line 1028-1108

#### **修改 resetFlow（Line ~1453-1463）**：
```javascript
const resetFlow = () => {
  // ...
  setOneShotStep(1);  // ✅ 重置到 Step 1
  setCurrentEditingSheetIndex(0);
  // ...
};
```

#### **新增 Step 1 UI（Line ~1571-2028）**：
- 標題改為 "Step 1: Sheet Classification"
- 說明文字：Mapping 將在下一步驟確認
- Import 按鈕改為 "Next: Review Mapping"
- **Gate**: disabled={sheetPlans.filter(p => p.enabled).length === 0}

#### **新增 Step 2 UI（Line ~2265-2361）**：
- 標題："Step 2: Mapping Review"
- 說明文字：所有 enabled sheets 都必須 Confirm 才能匯入
- **左側**：Enabled sheets 清單（可切換）
  - 顯示狀態：Confirmed / Ready / Incomplete
- **右側**：Mapping Panel
  - Field Mapping 表格（Excel Column → Target Field）
  - Missing Required 警告
  - Coverage % 顯示
  - AI Field Suggestion 按鈕
  - **Confirm Mapping 按鈕**（isComplete=false 時 disabled）
  - Unlock & Edit 按鈕（已 confirmed 後可解鎖）
- **Import 按鈕**：
  - **Gate**: disabled if any enabled sheet 未 mappingConfirmed
  - 按鈕文字動態顯示 unconfirmed 數量
- Progress Bar 和 Result Summary（沿用 Step 1）

---

### **2. `src/services/oneShotImportService.js` (中度修改)**

#### **generateSheetPlans（Line ~80-118）**：
```javascript
plans.push({
  // ... 原有欄位
  // ✅ Two-step Gate: 初始化 mapping 狀態
  headers: Object.keys(sheetData[0] || {}),
  mappingDraft: {},
  mappingFinal: null,
  mappingConfirmed: false,
  requiredCoverage: 0,
  missingRequired: [],
  isComplete: false
});
```

#### **importWorkbookSheets（Line ~207-218）**：
```javascript
// ✅ Two-step Gate: 硬性門檻檢查 mappingFinal
if (!plan.mappingFinal || Object.keys(plan.mappingFinal).length === 0) {
  console.log(`[One-shot] Sheet "${sheetName}" NEEDS_REVIEW: no mappingFinal`);
  report.needsReviewSheets++;
  report.sheetReports.push({
    sheetName,
    uploadType,
    status: 'NEEDS_REVIEW',
    reason: 'No confirmed mapping (mappingFinal missing from Step 2)'
  });
  continue;  // ✅ 跳過 ingest
}

// ✅ 使用 plan.mappingFinal（來自 Step 2 人工確認）
const columnMapping = plan.mappingFinal;
```

#### **importWorkbookSheets 調用 importSingleSheet（Line ~302）**：
```javascript
const sheetResult = await importSingleSheet({
  // ...
  columnMapping: plan.mappingFinal  // ✅ 傳入 mappingFinal（不再是 plan.mapping）
});
```

#### **importSingleSheet（Line ~442-459）**：
```javascript
// ✅ Two-step Gate: 只使用 providedMapping，禁止 fallback
if (!providedMapping || Object.keys(providedMapping).length === 0) {
  console.log(`[importSingleSheet] GATE: No providedMapping for ${sheetName}`);
  return {
    sheetName,
    uploadType,
    status: 'NEEDS_REVIEW',
    reason: 'No mapping provided (mappingFinal missing from Step 2)'
  };
}

// ✅ 直接使用 providedMapping（不再 fallback 到 ruleBasedMapping）
const columnMapping = providedMapping;
console.log(`[importSingleSheet] ✅ Using mappingFinal:`, Object.keys(columnMapping).length, 'mappings');
```

---

### **3. `src/services/oneShotAiSuggestService.js` (新增函數)**

#### **suggestSheetType（Line ~147-173）**：
```javascript
/**
 * 使用 LLM 只建議 uploadType（Step 1: Classification only）
 */
export async function suggestSheetType({ headers, sampleRows }) {
  const prompt = generateUploadTypePrompt(headers, sampleRows.slice(0, 30));
  const aiResponse = await callGeminiAPI(prompt, '', { temperature: 0.3, maxOutputTokens: 500 });
  const extracted = extractAiJson(aiResponse);
  
  return {
    suggestedType: extracted.suggestedType,
    confidence: extracted.confidence || 0.5,
    reasons: extracted.reasons || []
  };
}
```

---

### **4. 單檔模式硬門檻（已存在，無需修改）**

#### **validateData（Line ~638-651）**：
```javascript
const validateData = () => {
  // ✅ 硬性 gate：檢查 mapping 完整度
  const mappingStatus = getRequiredMappingStatus({
    uploadType,
    columns,
    columnMapping
  });

  if (!mappingStatus.isComplete) {
    const message = formatMissingRequiredMessage(mappingStatus.missingRequired);
    addNotification(`Cannot proceed: ${message}`, "error");
    return;  // ✅ 硬 return
  }
  // ... 繼續 validation
};
```

#### **handleSave（Line ~678-693）**：
```javascript
const handleSave = async () => {
  // ✅ 硬性禁止：單檔模式下必須完成 required mapping
  if (!oneShotEnabled) {
    const mappingStatus = getRequiredMappingStatus({
      uploadType,
      columns,
      columnMapping
    });

    if (!mappingStatus.isComplete) {
      const message = formatMissingRequiredMessage(mappingStatus.missingRequired);
      addNotification(`Cannot save: ${message}`, "error");
      return; // ✅ 硬 return
    }
  }
  // ... 繼續 save
};
```

---

## 🔒 關鍵 Gate 位置總結

### **UI Gate（前端防呆）**

#### **Step 1 → Step 2**：
- **位置**: `EnhancedExternalSystemsView.jsx` Line ~935-952 (`handleNextToMappingReview`)
- **條件**:
  - 至少一個 enabled sheet
  - 所有 enabled sheets 有 uploadType
- **效果**: 不滿足條件無法點擊 Next

#### **Step 2: Confirm Mapping**：
- **位置**: `EnhancedExternalSystemsView.jsx` Line ~990-1012 (`handleConfirmMapping`)
- **條件**: isComplete=true (required coverage=100%)
- **效果**: 不滿足條件 Confirm 按鈕 disabled

#### **Step 2 → Import**：
- **位置**: `EnhancedExternalSystemsView.jsx` Line ~2344 (Import 按鈕)
- **條件**: 所有 enabled sheets 都 mappingConfirmed=true
- **UI 顯示**: 
  ```javascript
  disabled={
    saving || 
    sheetPlans.filter(p => p.enabled).length === 0 ||
    sheetPlans.filter(p => p.enabled && !p.mappingConfirmed).length > 0  // ✅ 關鍵 gate
  }
  ```
- **按鈕文字**: 未 confirmed 時顯示 "Cannot Import (X Unconfirmed)"

---

### **Backend Gate（後端防呆）**

#### **importWorkbookSheets（Gate 1）**：
- **位置**: `oneShotImportService.js` Line ~207-218
- **條件**: plan.mappingFinal 存在且非空
- **效果**: 無 mappingFinal → NEEDS_REVIEW + continue (跳過 ingest)
```javascript
if (!plan.mappingFinal || Object.keys(plan.mappingFinal).length === 0) {
  report.needsReviewSheets++;
  report.sheetReports.push({
    sheetName,
    uploadType,
    status: 'NEEDS_REVIEW',
    reason: 'No confirmed mapping (mappingFinal missing from Step 2)'
  });
  continue;  // ✅ 跳過 ingest
}
```

#### **importWorkbookSheets（Gate 2）**：
- **位置**: `oneShotImportService.js` Line ~220-258
- **條件**: mappingFinal 的 coverage=100%
- **效果**: coverage<1.0 → NEEDS_REVIEW + continue
```javascript
const mappingStatus = getRequiredMappingStatus({
  uploadType,
  columns: headers,
  columnMapping: plan.mappingFinal
});

if (!mappingStatus.isComplete) {
  report.needsReviewSheets++;
  report.sheetReports.push({
    sheetName,
    uploadType,
    status: 'NEEDS_REVIEW',
    reason: formatMissingRequiredMessage(mappingStatus.missingRequired),
    coverage: mappingStatus.coverage
  });
  continue;  // ✅ 跳過 ingest
}
```

#### **importSingleSheet（Gate 3）**：
- **位置**: `oneShotImportService.js` Line ~442-451
- **條件**: providedMapping 存在且非空
- **效果**: 無 providedMapping → NEEDS_REVIEW (不進行任何 ingest)
```javascript
if (!providedMapping || Object.keys(providedMapping).length === 0) {
  return {
    sheetName,
    uploadType,
    status: 'NEEDS_REVIEW',
    reason: 'No mapping provided (mappingFinal missing from Step 2)'
  };
}

// ✅ 禁止 fallback：不再跑 ruleBasedMapping 或 suggestMappingWithLLM
const columnMapping = providedMapping;
```

#### **importSingleSheet（Gate 4）**：
- **位置**: `oneShotImportService.js` Line ~462-480
- **條件**: columnMapping 的 coverage=100%
- **效果**: coverage<1.0 → NEEDS_REVIEW
```javascript
const mappingStatus = getRequiredMappingStatus({
  uploadType,
  columns: headers,
  columnMapping
});

if (!mappingStatus.isComplete) {
  return {
    sheetName,
    uploadType,
    status: 'NEEDS_REVIEW',
    reason: `Required field mapping incomplete...`,
    coverage: mappingStatus.coverage
  };
}
```

---

### **單檔模式 Gate（已存在）**

#### **validateData（Gate 1）**：
- **位置**: `EnhancedExternalSystemsView.jsx` Line ~640-651
- **條件**: mappingStatus.isComplete=true
- **效果**: 不滿足條件 → addNotification + return (不進入 validation)

#### **handleSave（Gate 2）**：
- **位置**: `EnhancedExternalSystemsView.jsx` Line ~680-693
- **條件**: 單檔模式下 mappingStatus.isComplete=true
- **效果**: 不滿足條件 → addNotification + return (不寫 DB)

---

## 🎯 Two-step Gate 流程圖

```
上傳 Excel
    ↓
[Step 1: Sheet Classification]
- 顯示 sheetPlans 表格
- 選擇 uploadType + enabled
- AI Suggest Type (optional)
- ❌ 不允許 Import
    ↓
Next: Review Mapping
    ↓ (Gate: 至少一個 enabled + 所有 enabled 有 type)
    ↓
[Step 2: Mapping Review]
- 左側：enabled sheets 清單
- 右側：Field Mapping UI
- AI Field Suggestion → 填 mappingDraft
- 手動編輯 → 更新 mappingDraft
- ✅ Confirm Mapping → 鎖定 mappingFinal
    ↓
Import Confirmed Sheets
    ↓ (Gate: 所有 enabled sheets 都 mappingConfirmed)
    ↓
[Import Execution]
- 只使用 plan.mappingFinal
- 無 mappingFinal → NEEDS_REVIEW
- coverage<1.0 → NEEDS_REVIEW
    ↓
Result Summary
```

---

## 🧪 最小手動驗收步驟（5 分鐘）

### **步驟 1：啟動並準備測試**
```powershell
npm run build  # ✅ 已通過
npm run dev
```
準備 Mock data.xlsx

---

### **步驟 2：測試 Step 1 (Sheet Classification)**

1. 上傳 Mock data.xlsx（One-shot mode 開啟）
2. 進入 Sheet Plans 頁面

**✅ 驗收點 A1**: 標題顯示 "Step 1: Sheet Classification"
**✅ 驗收點 A2**: 說明文字提到 "Mapping 將在下一步驟確認"
**✅ 驗收點 A3**: 表格下方按鈕為 "Next: Review Mapping"（不是 "Import"）
**✅ 驗收點 A4**: 未 enable 任何 sheet 時 Next 按鈕 disabled

3. Enable 至少一個 sheet（例如 BOM Edge）
4. 確保該 sheet 有 uploadType（手動選或 AI Suggest）

**✅ 驗收點 A5**: Next 按鈕變為 enabled

5. 點擊 "Next: Review Mapping"

**✅ 驗收點 A6**: 成功進入 Step 2

---

### **步驟 3：測試 Step 2 (Mapping Review)**

**✅ 驗收點 B1**: 標題顯示 "Step 2: Mapping Review"
**✅ 驗收點 B2**: 左側顯示 enabled sheets 清單（可點選切換）
**✅ 驗收點 B3**: 右側顯示當前 sheet 的 Field Mapping 表格

**測試 Mapping 編輯**：
1. 查看 Missing Required 警告（若有）
2. 點擊 "AI Field Suggestion"

**✅ 驗收點 B4**: mappingDraft 自動填入，Coverage % 更新

3. 手動修改某個 mapping（下拉選單）

**✅ 驗收點 B5**: Coverage % 即時更新

**測試 Confirm Gate**：
4. 若 isComplete=false（coverage<100%）

**✅ 驗收點 B6**: "Confirm Mapping" 按鈕顯示為 disabled，文字 "Incomplete - Cannot Confirm"

5. 確保所有 required fields 都已 mapped（coverage=100%）
6. 點擊 "Confirm Mapping"

**✅ 驗收點 B7**: 按鈕變為 "Confirmed"，狀態圖示從 "Incomplete/Ready" → "✓ Confirmed"

**測試 Unlock**：
7. 點擊 "Unlock & Edit"

**✅ 驗收點 B8**: mappingConfirmed 變為 false，可重新編輯

8. 重新點擊 "Confirm Mapping"

---

### **步驟 4：測試 Import Gate**

**測試未 Confirmed 阻擋**：
1. 確保至少一個 enabled sheet 未 confirmed

**✅ 驗收點 C1**: Import 按鈕 disabled
**✅ 驗收點 C2**: 按鈕文字顯示 "Cannot Import (X Unconfirmed)"

**測試 Import**：
2. Confirm 所有 enabled sheets
3. 點擊 "Import Confirmed Sheets"

**✅ 驗收點 C3**: Import 開始執行，顯示進度
**✅ 驗收點 C4**: Console log 顯示 "✅ Using mappingFinal"
**✅ 驗收點 C5**: Console 無 "using rule-based" 或 "No provided mapping"（代表沒有 fallback）

4. 等待 Import 完成

**✅ 驗收點 C6**: Import Summary 顯示
**✅ 驗收點 C7**: Succeeded > 0（至少一個 sheet 成功）
**✅ 驗收點 C8**: 若有 needs_review，標題顯示 "Import Requires Review"（不是 "Import Completed"）

---

### **步驟 5：測試單檔模式硬門檻**

1. 關閉 One-shot mode（單檔上傳）
2. 上傳單個檔案（例如 BOM.csv）
3. 選擇 Upload Type = BOM Edge
4. 進入 Field Mapping 頁面
5. 故意不 map 某個 required field（例如 child_material）

**✅ 驗收點 D1**: "Next: Validate Data" 按鈕依然可點（mappingComplete 機制）
**但是點擊後**：

6. 點擊 "Next: Validate Data"

**✅ 驗收點 D2**: 顯示錯誤通知 "Cannot proceed: Missing required field: child_material"
**✅ 驗收點 D3**: 未進入 Validation 頁面（validateData 中 return）

7. Map 所有 required fields
8. 再次點擊 Next

**✅ 驗收點 D4**: 成功進入 Validation 頁面

9. 在 Validation 頁面點擊 "Save Data"（故意不 map 完整，測試 handleSave gate）

**✅ 驗收點 D5**: 若 mapping 不完整，顯示 "Cannot save: ..." 且不寫 DB

---

## 🎓 關鍵技術點總結

### **1. 狀態結構**
```javascript
sheetPlans[i] = {
  sheetId,           // 穩定唯一 ID
  sheetName,
  uploadType,
  enabled,
  confidence,
  
  // ✅ Two-step Gate 新增
  headers,           // 原始 Excel headers
  mappingDraft,      // AI/手動建議的 mapping（可編輯）
  mappingFinal,      // Confirm 後鎖定的 mapping（用於 import）
  mappingConfirmed,  // 人工確認標記
  requiredCoverage,  // 0.0-1.0
  missingRequired,   // string[]
  isComplete         // boolean
}
```

### **2. 流程控制**
- `oneShotStep`: 1 (Classification) → 2 (Mapping Review) → 3 (Import/Results)
- `currentEditingSheetIndex`: 在 Step 2 中當前編輯的 sheet（對應 enabledSheets[index]）

### **3. Mapping 三態**
1. **mappingDraft**: AI/rule 建議 + 手動編輯（可修改）
2. **Confirm**: mappingFinal = mappingDraft，mappingConfirmed = true
3. **Import**: 只使用 mappingFinal（禁止 fallback）

### **4. Gate 層級**
- **UI Gate**: 按鈕 disabled
- **Handler Gate**: addNotification + return
- **Backend Gate**: NEEDS_REVIEW + continue/return

### **5. No Silent Skip**
- coverage<1.0 → **NEEDS_REVIEW**（不是 SKIPPED）
- SKIPPED 只用於：sheet 空白、idempotency 已成功

---

## ✅ 驗收通過標準

所有以下項目都 ✅ 時，Two-step Gate 實施完成：

- [x] npm run build 通過 ✅
- [x] Step 1 只能 Next，不能 Import ✅
- [x] Step 2 顯示 Mapping Review UI ✅
- [x] isComplete=false 時 Confirm Mapping disabled ✅
- [x] 任一 enabled sheet 未 confirmed 時 Import disabled ✅
- [x] Import 時只使用 mappingFinal（Console log 確認）✅
- [x] 無 mappingFinal → NEEDS_REVIEW（不是 IMPORTED/SKIPPED）✅
- [x] 單檔模式：validateData 和 handleSave 都有 gate ✅

---

## 📦 交付文件

1. ✅ `TWO_STEP_GATE_IMPLEMENTATION_COMPLETE.md` - 本檔案（實施完成報告）
2. ✅ 修改後的程式碼：
   - `src/views/EnhancedExternalSystemsView.jsx`
   - `src/services/oneShotImportService.js`
   - `src/services/oneShotAiSuggestService.js`

---

**Two-step Gate 已強制落地！無法繞過！npm run build 通過！** 🚀
