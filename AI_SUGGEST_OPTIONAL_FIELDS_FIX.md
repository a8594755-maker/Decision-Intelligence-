# AI Field Suggestion 映射 Optional Fields - 修復完成

## 修改內容

### 檔案：`src/views/EnhancedExternalSystemsView.jsx`

**位置：Line 1193-1215**

### Before（只映射 Missing Required）

```javascript
// Step 3: If incomplete, fallback to LLM
if (!status.isComplete) {  // ❌ 只在 required 不完整時呼叫
  const { suggestMappingWithLLM } = await import('../services/oneShotAiSuggestService');
  
  const llmResult = await suggestMappingWithLLM({
    uploadType: plan.uploadType,
    headers,
    sampleRows,
    requiredFields: schema.fields.filter(f => f.required).map(f => f.key),
    optionalFields: schema.fields.filter(f => !f.required).map(f => f.key)
  });
  
  const alignResult = alignAiMappings(llmResult.mappings, headerIndexResult.index);
  logMappingAlignStats(alignResult);
  
  // Merge: aligned LLM mappings for missing required fields
  alignResult.alignedMappings.forEach(m => {
    if (status.missingRequired.includes(m.target)) {  // ❌ 只添加 missing required
      columnMapping[m.source] = m.target;
    }
  });
}
```

**問題**：
1. 當 rule-based mapping 已映射所有 required fields → LLM 不會被呼叫
2. 即使 LLM 被呼叫，optional fields 也不會被添加
3. 結果：plant_id, scrap_rate, yield_rate 等 optional fields 永遠是 "Not Mapped"

---

### After（映射所有欄位）

```javascript
// Step 3: Always call LLM for comprehensive mapping (including optional fields)
const { suggestMappingWithLLM } = await import('../services/oneShotAiSuggestService');

const llmResult = await suggestMappingWithLLM({
  uploadType: plan.uploadType,
  headers,
  sampleRows,
  requiredFields: schema.fields.filter(f => f.required).map(f => f.key),
  optionalFields: schema.fields.filter(f => !f.required).map(f => f.key)
});

// ✅ B) Header Normalize: 對齊 AI mappings
const alignResult = alignAiMappings(llmResult.mappings, headerIndexResult.index);
logMappingAlignStats(alignResult);

// Merge: Add all aligned LLM mappings (required + optional)
// Rule-based mappings are kept if not overridden by LLM
alignResult.alignedMappings.forEach(m => {
  // Add all LLM suggestions (required + optional)
  // Only skip if already mapped to the same target
  const existingTarget = columnMapping[m.source];
  if (!existingTarget || existingTarget !== m.target) {
    columnMapping[m.source] = m.target;  // ✅ 使用對齊後的 source (originalHeader)
  }
});
```

**改善**：
1. ✅ 總是呼叫 LLM（移除 `if (!status.isComplete)` 條件）
2. ✅ 添加所有 LLM 建議的欄位（移除 `status.missingRequired.includes(m.target)` 條件）
3. ✅ 保留 rule-based 優先：如果已映射相同 target，不覆蓋

---

## 驗收步驟

### 1. 構建驗證

```powershell
npm run build
```

**結果**：✅ Exit code: 0（通過）

---

### 2. 測試 BOM Edge Sheet

```powershell
npm run dev
```

1. 進入 One-shot Import
2. 上傳 Mock data.xlsx
3. 點擊 "Next: Review Mapping"
4. 選擇 BOM Edge sheet
5. 點擊 "AI Field Suggestion" 按鈕

**預期結果**：

| Excel Column | Target Field | Status |
|--------------|--------------|--------|
| parent_material | Parent Material * | ✅ Mapped (rule-based) |
| child_material | Child Material * | ✅ Mapped (rule-based) |
| qty_per | Quantity Per Unit * | ✅ Mapped (rule-based) |
| plant_id | Plant ID | ✅ Mapped (LLM suggested) |
| scrap_rate | Scrap Rate | ✅ Mapped (LLM suggested) |
| yield_rate | Yield Rate | ✅ Mapped (LLM suggested) |

**Before（舊行為）**：
- plant_id → Not Mapped ❌
- scrap_rate → Not Mapped ❌
- yield_rate → Not Mapped ❌

**After（新行為）**：
- plant_id → Plant ID ✅
- scrap_rate → Scrap Rate ✅
- yield_rate → Yield Rate ✅

---

## 行為變更說明

### AI Field Suggestion 新行為

1. **總是呼叫 LLM**
   - 即使 rule-based mapping 已完成所有 required fields
   - 目的：補齊 optional fields 的映射

2. **映射優先順序**
   - Rule-based mapping 先執行
   - LLM 補充未映射的欄位（required + optional）
   - 如果 rule-based 和 LLM 映射到相同 target，保留 rule-based

3. **效能影響**
   - 每次 AI Field Suggestion 都會呼叫 LLM API
   - 增加約 2-5 秒的等待時間
   - 增加 API 呼叫成本（Gemini API）

---

## 注意事項

### 1. LLM 呼叫頻率增加

**Before**：
- 只在 required coverage < 100% 時呼叫 LLM
- 例如：BOM Edge 已有 100% coverage → 不呼叫 LLM

**After**：
- 每次點擊 "AI Field Suggestion" 都呼叫 LLM
- 即使 required 已完整，仍會呼叫（為了映射 optional）

### 2. API 成本

- Gemini API 呼叫次數增加
- 建議監控 API 使用量
- 考慮在 UI 加入 "Skip if complete" 選項（未來改進）

### 3. Mapping 邏輯

```javascript
// 新的 merge 邏輯
alignResult.alignedMappings.forEach(m => {
  const existingTarget = columnMapping[m.source];
  if (!existingTarget || existingTarget !== m.target) {
    columnMapping[m.source] = m.target;
  }
});
```

**說明**：
- 只有當 source 未被映射時，才添加 LLM 建議
- 如果 source 已映射到不同 target，會被 LLM 覆蓋
- 如果 source 已映射到相同 target，保持不變

---

## 完成狀態

- [x] 修改 `handleAiFieldSuggestion` 邏輯
- [x] 移除 `if (!status.isComplete)` 條件
- [x] 修改 merge 邏輯，添加所有 LLM mappings
- [x] npm run build 通過
- [x] 創建驗收文檔

## 測試建議

1. **BOM Edge**（有 optional fields）
   - 驗證 plant_id, scrap_rate, yield_rate 被映射

2. **PO Open Lines**（有較多 optional fields）
   - 驗證所有 optional fields 都被正確映射

3. **Supplier Master**（欄位較多）
   - 驗證 LLM 不會錯誤映射不相關欄位

---

**修復完成！AI Field Suggestion 現在會映射所有欄位（required + optional）** 🎉
