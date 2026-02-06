# Two-step Gate Implementation Plan

## 🎯 目標
實現 One-shot Import 的 Two-step Gate 流程：
1. **Step 1: Sheet Classification** - 只決定 uploadType + enable
2. **Step 2: Mapping Review** - 人工確認 required mapping
3. **Step 3: Import** - 只使用 mappingFinal，禁止 fallback

## 📋 現有狀態檢查

### ✅ 已存在的基礎設施
1. **`src/utils/requiredMappingStatus.js`** - getRequiredMappingStatus() 已實現
2. **`src/services/oneShotAiSuggestService.js`** - suggestMappingWithLLM() 已實現
3. **`database/fix_suppliers_status.sql`** - suppliers_status_check 修復 SQL
4. **`src/services/chunkIngestService.js`** - 錯誤診斷已改進（前次修復）
5. **`src/utils/dataAutoFill.js`** - 自動補齊功能已實現（前次修復）

### ❌ 需要新增/修改
1. **UI State Management** - 新增 currentStep, mappingDraft, mappingFinal, mappingConfirmed
2. **Step 1 UI** - Sheet Plans (只做 type + enable)
3. **Step 2 UI** - Mapping Review (人工確認 mapping)
4. **Import Logic** - 只使用 mappingFinal，禁止 fallback
5. **單檔模式硬門檻** - Field Mapping 頁必須 isComplete=true 才能 Next/Save

---

## 🔧 實施步驟

### **Phase 1: UI State Management（新增狀態機）**

#### **修改檔案**: `src/views/EnhancedExternalSystemsView.jsx`

新增狀態：
```javascript
const [currentStep, setCurrentStep] = useState(1); // 1: Classification, 2: Mapping Review, 3: Import

const [sheetPlans, setSheetPlans] = useState([
  {
    sheetId,
    sheetName,
    uploadType,
    enabled,
    confidence,
    reasons,
    // Step 1 only (type classification)
    typeConfirmed: false,
    
    // Step 2 (mapping review)
    mappingDraft: {},       // AI/rule 建議的 mapping（可編輯）
    mappingFinal: null,     // 確認後的 mapping（鎖定）
    mappingConfirmed: false, // 是否已 Confirm Mapping
    requiredCoverage: 0,
    missingRequired: [],
    isComplete: false
  }
]);
```

狀態切換邏輯：
- Step 1 → Step 2: 需要至少一個 sheet enabled=true
- Step 2 → Step 3 (Import): 所有 enabled sheets 都必須 mappingConfirmed=true
- 禁止跳步

---

### **Phase 2: Step 1 UI - Sheet Classification**

#### **UI 需求**：
1. 顯示 sheetPlans 表格（sheetName, uploadType dropdown, enabled checkbox, confidence, reasons）
2. 每列 **AI Suggest Type** 按鈕（只建議 uploadType，不做 mapping）
3. 表格上方 **AI Suggest All Types** 按鈕（批量 type 建議）
4. **Next: Review Mappings** 按鈕（disabled if no enabled sheets）

#### **修改內容**：
```javascript
// AI Suggest Type (單個 sheet)
const handleAiSuggestType = async (sheetId) => {
  setAiSuggestLoading(prev => ({ ...prev, [sheetId]: true }));
  
  try {
    const plan = sheetPlans.find(p => p.sheetId === sheetId);
    const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[plan.sheetName]);
    const headers = Object.keys(sheetData[0]);
    const sampleRows = sheetData.slice(0, 50);
    
    // 只要求 uploadType，不要 mapping
    const result = await suggestSheetType({ headers, sampleRows });
    
    setSheetPlans(prev => prev.map(p => 
      p.sheetId === sheetId 
        ? { 
            ...p, 
            uploadType: result.suggestedType, 
            confidence: result.confidence,
            reasons: result.reasons,
            typeConfirmed: true 
          } 
        : p
    ));
    
    addNotification('success', `AI suggested: ${result.suggestedType}`);
  } catch (error) {
    console.error('[AI Suggest Type] Error:', error);
    addNotification('error', `AI suggestion failed: ${error.message}`);
  } finally {
    setAiSuggestLoading(prev => ({ ...prev, [sheetId]: false }));
  }
};

// AI Suggest All Types (批量)
const handleAiSuggestAllTypes = async () => {
  const sheetsToSuggest = sheetPlans.filter(p => p.enabled || p.confidence < 0.75);
  
  setAiSuggestAllRunning(true);
  setAiSuggestAllProgress({ current: 0, total: sheetsToSuggest.length });
  
  const abortController = new AbortController();
  setAiSuggestAllAbortController(abortController);
  
  try {
    await runWithConcurrencyAbortable(
      sheetsToSuggest,
      async (plan, index) => {
        setAiSuggestAllProgress(prev => ({ ...prev, current: index + 1 }));
        await handleAiSuggestType(plan.sheetId);
      },
      2, // concurrency
      abortController.signal
    );
    
    addNotification('success', `AI suggestions completed for ${sheetsToSuggest.length} sheets`);
  } catch (error) {
    if (error.message !== 'ABORTED') {
      addNotification('error', `AI suggestions failed: ${error.message}`);
    }
  } finally {
    setAiSuggestAllRunning(false);
    setAiSuggestAllAbortController(null);
  }
};

// Next: Review Mappings
const handleNextToMappingReview = () => {
  const enabledSheets = sheetPlans.filter(p => p.enabled);
  if (enabledSheets.length === 0) {
    addNotification('error', 'Please enable at least one sheet');
    return;
  }
  setCurrentStep(2);
};
```

---

### **Phase 3: Step 2 UI - Mapping Review**

#### **UI 需求**：
1. 左側：enabled sheets 清單（可切換當前編輯的 sheet）
2. 中間：Field Mapping UI（顯示 mappingDraft，可編輯）
3. 右側/底部：
   - missing required fields
   - requiredCoverage %
   - **AI Field Suggestion** 按鈕（只建議 mapping，不放行）
   - **Confirm Mapping** 按鈕（isComplete=false 時 disabled）
4. 表格上方：**AI Suggest All Mappings** 按鈕（批量 mapping 建議）
5. **Next: Import** 按鈕（disabled if any enabled sheet 未 mappingConfirmed）

#### **修改內容**：
```javascript
const [currentSheetIndex, setCurrentSheetIndex] = useState(0);

// AI Field Suggestion (單個 sheet)
const handleAiFieldSuggestion = async (sheetId) => {
  const plan = sheetPlans.find(p => p.sheetId === sheetId);
  const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[plan.sheetName]);
  const headers = Object.keys(sheetData[0]);
  const sampleRows = sheetData.slice(0, 50);
  
  try {
    // Step 1: Rule-based mapping
    const ruleMappings = ruleBasedMapping(headers, plan.uploadType, UPLOAD_SCHEMAS[plan.uploadType].fields);
    let columnMapping = {};
    ruleMappings.forEach(m => {
      if (m.target && m.confidence >= 0.7) {
        columnMapping[m.source] = m.target;
      }
    });
    
    // Step 2: Check coverage
    const status = getRequiredMappingStatus({
      uploadType: plan.uploadType,
      columns: headers,
      columnMapping
    });
    
    // Step 3: If incomplete, fallback to LLM
    if (!status.isComplete) {
      const llmResult = await suggestMappingWithLLM({
        uploadType: plan.uploadType,
        headers,
        sampleRows,
        requiredFields: UPLOAD_SCHEMAS[plan.uploadType].fields.filter(f => f.required),
        optionalFields: UPLOAD_SCHEMAS[plan.uploadType].fields.filter(f => !f.required)
      });
      
      // Merge: LLM mappings for missing required fields
      llmResult.mappings.forEach(m => {
        if (status.missingRequired.includes(m.target)) {
          columnMapping[m.source] = m.target;
        }
      });
    }
    
    // Final status check
    const finalStatus = getRequiredMappingStatus({
      uploadType: plan.uploadType,
      columns: headers,
      columnMapping
    });
    
    // Update mappingDraft (不更新 mappingFinal)
    setSheetPlans(prev => prev.map(p => 
      p.sheetId === sheetId 
        ? {
            ...p,
            mappingDraft: columnMapping,
            requiredCoverage: finalStatus.coverage,
            missingRequired: finalStatus.missingRequired,
            isComplete: finalStatus.isComplete
          }
        : p
    ));
    
    addNotification('success', `AI mapping suggestion completed (${Math.round(finalStatus.coverage * 100)}% coverage)`);
  } catch (error) {
    console.error('[AI Field Suggestion] Error:', error);
    addNotification('error', `AI mapping suggestion failed: ${error.message}`);
  }
};

// Confirm Mapping (人工確認)
const handleConfirmMapping = (sheetId) => {
  const plan = sheetPlans.find(p => p.sheetId === sheetId);
  
  if (!plan.isComplete) {
    addNotification('error', 'Cannot confirm: required fields mapping incomplete');
    return;
  }
  
  setSheetPlans(prev => prev.map(p => 
    p.sheetId === sheetId 
      ? {
          ...p,
          mappingFinal: { ...p.mappingDraft },  // 鎖定 mapping
          mappingConfirmed: true
        }
      : p
  ));
  
  addNotification('success', 'Mapping confirmed and locked');
};

// AI Suggest All Mappings (批量)
const handleAiSuggestAllMappings = async () => {
  const enabledSheets = sheetPlans.filter(p => p.enabled);
  
  // ... (類似 handleAiSuggestAllTypes，但呼叫 handleAiFieldSuggestion)
};

// Next: Import
const handleNextToImport = () => {
  const enabledSheets = sheetPlans.filter(p => p.enabled);
  const unconfirmed = enabledSheets.filter(p => !p.mappingConfirmed);
  
  if (unconfirmed.length > 0) {
    addNotification('error', `${unconfirmed.length} sheets have unconfirmed mappings`);
    return;
  }
  
  setCurrentStep(3);
  handleImportAllSheets(); // 開始匯入
};
```

---

### **Phase 4: Import Logic - 只使用 mappingFinal**

#### **修改檔案**: `src/services/oneShotImportService.js`

```javascript
// importWorkbookSheets 傳入 sheetPlans（含 mappingFinal）
export async function importWorkbookSheets({
  userId,
  workbook,
  fileName,
  sheetPlans,  // ✅ 包含 mappingFinal
  strictMode,
  chunkSize,
  onProgress,
  signal,
  hasIngestKeySupport,
  forceRerun
}) {
  const enabledPlans = sheetPlans.filter(p => p.enabled);
  
  for (const plan of enabledPlans) {
    // ✅ Hard gate: 必須有 mappingFinal 且 isComplete
    if (!plan.mappingFinal) {
      report.needsReviewSheets++;
      report.sheetResults.push({
        sheetName: plan.sheetName,
        uploadType: plan.uploadType,
        status: 'NEEDS_REVIEW',
        reason: 'No confirmed mapping (mappingFinal missing)'
      });
      continue;
    }
    
    const finalStatus = getRequiredMappingStatus({
      uploadType: plan.uploadType,
      columns: plan.headers,
      columnMapping: plan.mappingFinal
    });
    
    if (!finalStatus.isComplete) {
      report.needsReviewSheets++;
      report.sheetResults.push({
        sheetName: plan.sheetName,
        uploadType: plan.uploadType,
        status: 'NEEDS_REVIEW',
        reason: formatMissingRequiredMessage(finalStatus.missingRequired)
      });
      continue;
    }
    
    // ✅ 傳入 mappingFinal（不允許 importSingleSheet 自行 fallback）
    const result = await importSingleSheet({
      userId,
      workbook,
      sheetName: plan.sheetName,
      uploadType: plan.uploadType,
      fileName,
      strictMode,
      chunkSize,
      onProgress,
      signal,
      hasIngestKeySupport,
      forceRerun,
      columnMapping: plan.mappingFinal  // ✅ 強制使用 mappingFinal
    });
    
    // ... 處理結果
  }
}

// importSingleSheet 禁止 fallback
async function importSingleSheet({
  // ...
  columnMapping: providedMapping = null
}) {
  // ✅ 只使用 providedMapping，禁止 ruleBasedMapping 或 LLM fallback
  if (!providedMapping || Object.keys(providedMapping).length === 0) {
    return {
      sheetName,
      uploadType,
      status: 'NEEDS_REVIEW',
      reason: 'No mapping provided (mappingFinal missing)'
    };
  }
  
  // Final gate (double check)
  const mappingStatus = getRequiredMappingStatus({
    uploadType,
    columns: headers,
    columnMapping: providedMapping
  });
  
  if (!mappingStatus.isComplete) {
    return {
      sheetName,
      uploadType,
      status: 'NEEDS_REVIEW',
      reason: formatMissingRequiredMessage(mappingStatus.missingRequired)
    };
  }
  
  // ✅ 直接使用 providedMapping（不再 fallback）
  const columnMapping = providedMapping;
  
  // ... 繼續 validation/cleaning/ingest
}
```

---

### **Phase 5: 單檔模式硬門檻**

#### **修改檔案**: `src/views/EnhancedExternalSystemsView.jsx`

```javascript
// 在 Field Mapping 階段（單檔模式）
const canProceedToValidation = useMemo(() => {
  if (oneShotEnabled) return true; // One-shot 有自己的 gate
  
  // 單檔模式：必須 isComplete
  const status = getRequiredMappingStatus({
    uploadType,
    columns,
    columnMapping
  });
  
  return status.isComplete;
}, [oneShotEnabled, uploadType, columns, columnMapping]);

// Next/Save 按鈕
<button
  disabled={!canProceedToValidation || loading}
  onClick={handleNext}
>
  {canProceedToValidation 
    ? 'Next: Validate Data' 
    : `Missing required fields: ${missingRequired.join(', ')}`}
</button>

// handleNext / handleSave 的 guard
const handleNext = () => {
  if (!canProceedToValidation) {
    addNotification('error', 'Required fields must be mapped to continue');
    return;
  }
  // ... 繼續
};
```

---

## 🧪 驗收標準

### **A) Suppliers Status Check**
- [ ] 執行 `database/fix_suppliers_status.sql` 在 Supabase
- [ ] 匯入 Supplier Master 時 savedCount > 0
- [ ] 不再出現 `suppliers_status_check` violation

### **B) Two-step Gate (One-shot)**
- [ ] Step 1: Sheet Classification
  - [ ] 可單獨 AI Suggest Type
  - [ ] 可批量 AI Suggest All Types
  - [ ] 未 enabled 任何 sheet 不能 Next
- [ ] Step 2: Mapping Review
  - [ ] 可單獨 AI Field Suggestion
  - [ ] 可批量 AI Suggest All Mappings
  - [ ] isComplete=false 時 Confirm Mapping disabled
  - [ ] 未 Confirm Mapping 不能 Next to Import
- [ ] Step 3: Import
  - [ ] 只使用 mappingFinal
  - [ ] 無 mappingFinal 或 coverage<1.0 → NEEDS_REVIEW
  - [ ] Import Summary 正確顯示 imported/failed/needs_review/skipped

### **C) 單檔模式硬門檻**
- [ ] Field Mapping 頁面 required fields 未完整時：
  - [ ] Next / Save 按鈕 disabled
  - [ ] 顯示提示訊息
  - [ ] handleNext/handleSave 直接 return

### **D) Build & Compatibility**
- [ ] npm run build 通過
- [ ] 既有功能不受影響（chunk ingest, abort, progress, download report）

---

## 📝 修改檔案清單

### **新增檔案**:
- `TWO_STEP_GATE_IMPLEMENTATION_PLAN.md` (本檔案)

### **修改檔案**:
1. **`src/views/EnhancedExternalSystemsView.jsx`** (大量修改)
   - 新增 currentStep, mappingDraft, mappingFinal, mappingConfirmed 狀態
   - 實現 Step 1, 2, 3 UI
   - 實現 AI Suggest All Types / Mappings
   - 單檔模式硬門檻

2. **`src/services/oneShotImportService.js`** (中度修改)
   - importWorkbookSheets 接收 sheetPlans (含 mappingFinal)
   - importSingleSheet 禁止 fallback，只使用 providedMapping
   - Hard gate: 無 mappingFinal 或 coverage<1.0 → NEEDS_REVIEW

3. **`src/services/oneShotAiSuggestService.js`** (輕度修改)
   - 新增 suggestSheetType()（只 suggest uploadType，不 mapping）
   - suggestMappingWithLLM() 已存在，確保回傳格式正確

---

## ⚠️ 重要約束

1. **Import 時只使用 mappingFinal**
   - 禁止 importSingleSheet 自行 fallback 到 ruleBasedMapping 或 LLM
   - 只能在 Mapping Review (Step 2) 做建議

2. **不要 silent skip**
   - coverage<1.0 或無 mappingFinal → NEEDS_REVIEW（不是 SKIPPED）
   - SKIPPED 只用於「sheet 空白」或「idempotency 已成功」

3. **不要假裝 Import Completed**
   - needs_review > 0 → 顯示 "Import Requires Review"
   - 否則才顯示 "Import Completed"

4. **保留既有功能**
   - chunk ingest
   - abort
   - progress
   - download report

---

開始實施！🚀
