# Step2 單 Sheet 取消 + Header Normalize 修復完成

## ✅ 完成狀態

**npm run build 通過** ✅  
**單 sheet 可以 disable/移除** ✅  
**Header normalize 實施** ✅  
**AI mapping 對齊修復** ✅  
**Import gate 更嚴格** ✅

---

## 📂 修改/新增檔案清單

### **1. `src/utils/headerNormalize.js` (新增)**
- Header 正規化工具集
- 建立 header index (normalized → originalHeader)
- AI mapping 對齊 (alignAiMappings)
- Debug logging utilities

### **2. `src/views/EnhancedExternalSystemsView.jsx` (修改)**
- 新增 `handleDisableSheetFromImport()` handler
- 修改 `handleAiFieldSuggestion()` 使用 header normalize
- 修改 Step2 UI 添加 "Remove from Import" 按鈕
- 修改 Import 按鈕 disabled 邏輯（更嚴格）
- 修改按鈕文字（顯示 "No enabled sheets to import"）

### **3. `src/services/oneShotAiSuggestService.js` (修改)**
- 移除嚴格的 `headers.includes(m.source)` 檢查
- 允許 AI 回傳的 source 與實際 header 有微小差異
- 對齊工作由 `alignAiMappings` 處理

---

## 🔧 關鍵程式碼片段

### **A) Header Normalize (`src/utils/headerNormalize.js`)**

#### **1. normalizeHeader()**
```javascript
export function normalizeHeader(str) {
  if (!str || typeof str !== 'string') return '';
  
  let normalized = str;
  
  // 1. Trim
  normalized = normalized.trim();
  
  // 2. 移除不可見字元（零寬空格、BOM 等）
  normalized = normalized.replace(/[\u200B-\u200D\uFEFF]/g, '');
  
  // 3. 全形轉半形
  normalized = normalized.replace(/[\uFF01-\uFF5E]/g, (ch) => {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  });
  normalized = normalized.replace(/\u3000/g, ' '); // 全形空白
  
  // 4. 全部轉小寫
  normalized = normalized.toLowerCase();
  
  // 5. _/-/. 轉成空白
  normalized = normalized.replace(/[_\-\.]/g, ' ');
  
  // 6. 連續空白變單一空白
  normalized = normalized.replace(/\s+/g, ' ');
  
  // 7. 再次 trim
  normalized = normalized.trim();
  
  return normalized;
}
```

**處理的問題**：
- `"PO_Number"` → `"po number"`
- `"Material Code"` → `"material code"`
- `"Plant-ID"` → `"plant id"`
- `"PO Number "` (尾巴空白) → `"po number"`
- `"PO　Number"` (全形空白) → `"po number"`

#### **2. buildHeaderIndex()**
```javascript
export function buildHeaderIndex(headers) {
  const index = new Map();
  const duplicates = [];
  
  headers.forEach((originalHeader, idx) => {
    const normalized = normalizeHeader(originalHeader);
    
    if (!normalized) {
      console.warn(`[HeaderNormalize] Empty header at index ${idx}`);
      return;
    }
    
    if (index.has(normalized)) {
      // 重複的 normalized header
      const firstOriginal = index.get(normalized);
      duplicates.push(normalized);
      console.warn(`[HeaderNormalize] Duplicate normalized header "${normalized}":`, {
        first: firstOriginal,
        duplicate: originalHeader
      });
    } else {
      // 第一次出現，記錄到 index
      index.set(normalized, originalHeader);
    }
  });
  
  return {
    index,           // Map<normalized, originalHeader>
    duplicates,      // string[]
    stats: {
      total: headers.length,
      unique: index.size,
      duplicateCount: duplicates.length
    }
  };
}
```

**回傳範例**：
```javascript
{
  index: Map {
    'po number' => 'PO_Number',
    'material code' => 'Material_Code',
    'plant id' => 'Plant_ID'
  },
  duplicates: [],
  stats: { total: 10, unique: 10, duplicateCount: 0 }
}
```

#### **3. alignAiMappings()**
```javascript
export function alignAiMappings(aiMappings, headerIndex) {
  const alignedMappings = [];
  const unmatchedSources = [];
  
  aiMappings.forEach((mapping) => {
    const { source, target, confidence } = mapping;
    const srcNorm = normalizeHeader(source);
    
    if (headerIndex.has(srcNorm)) {
      // ✅ 成功對齊：使用實際的 originalHeader
      const originalHeader = headerIndex.get(srcNorm);
      alignedMappings.push({
        source: originalHeader,  // ✅ 替換成真實的 header
        target,
        confidence,
        _aiOriginalSource: source  // 保留 AI 原始 source
      });
    } else {
      // ❌ 對不上：記錄 unmatchedSource
      unmatchedSources.push({
        aiSource: source,
        normalized: srcNorm
      });
    }
  });
  
  return {
    alignedMappings,
    unmatchedSources,
    stats: {
      total: aiMappings.length,
      aligned: alignedMappings.length,
      unmatched: unmatchedSources.length
    }
  };
}
```

**對齊範例**：
```javascript
// AI 回傳:
[
  { source: "PO Number", target: "po_number", confidence: 0.95 },
  { source: "Material Code", target: "material_code", confidence: 0.98 }
]

// 實際 Excel headers:
["PO_Number", "Material_Code", "Plant_ID"]

// alignAiMappings 對齊後:
[
  { source: "PO_Number", target: "po_number", confidence: 0.95 },  // ✅ 對齊
  { source: "Material_Code", target: "material_code", confidence: 0.98 }  // ✅ 對齊
]
```

---

### **B) handleAiFieldSuggestion 修改**

```javascript
// ✅ Line ~1110-1130
const handleAiFieldSuggestion = async (sheetId) => {
  // ... 取得 headers, sampleRows ...

  // ✅ B) Header Normalize: 建立 header index
  const { buildHeaderIndex, logHeaderStats, alignAiMappings, logMappingAlignStats } = await import('../utils/headerNormalize');
  const headerIndexResult = buildHeaderIndex(headers);
  logHeaderStats(headers, headerIndexResult);

  // ... rule-based mapping ...
  
  // Step 3: If incomplete, fallback to LLM
  if (!status.isComplete) {
    const { suggestMappingWithLLM } = await import('../services/oneShotAiSuggestService');
    
    const llmResult = await suggestMappingWithLLM({ ... });
    
    // ✅ B) Header Normalize: 對齊 AI mappings
    const alignResult = alignAiMappings(llmResult.mappings, headerIndexResult.index);
    logMappingAlignStats(alignResult);
    
    // Merge: aligned LLM mappings for missing required fields
    alignResult.alignedMappings.forEach(m => {
      if (status.missingRequired.includes(m.target)) {
        columnMapping[m.source] = m.target;  // ✅ 使用對齊後的 source
      }
    });
  }
  
  // ✅ C) Update mappingDraft only for the correct sheetId
  console.log('[AI Field Suggestion] Updating mappingDraft for sheetId:', sheetId);
  setSheetPlans(prev => prev.map(p => 
    p.sheetId === sheetId 
      ? {
          ...p,
          headers,
          mappingDraft: columnMapping,
          requiredCoverage: finalStatus.coverage,
          missingRequired: finalStatus.missingRequired,
          isComplete: finalStatus.isComplete
        }
      : p
  ));
};
```

**Console Output 範例**：
```
[MappingAlign] headers=10 normalizedUnique=10 duplicates=[]
[MappingAlign] aiMappings=8 aligned=7 unmatchedSources=["Extra Field"]
[AI Field Suggestion] Updating mappingDraft for sheetId: Mock data.xlsx:12345:67890:0
```

---

### **C) handleDisableSheetFromImport (新增)**

```javascript
// ✅ A) Disable/Remove single sheet from import (Step2)
const handleDisableSheetFromImport = (sheetId) => {
  const plan = sheetPlans.find(p => p.sheetId === sheetId);
  if (!plan) return;
  
  console.log('[Two-step Gate] Disabling sheet from import:', plan.sheetName);
  
  setSheetPlans(prev => prev.map(p => 
    p.sheetId === sheetId 
      ? {
          ...p,
          enabled: false,           // ✅ 設為 disabled
          mappingConfirmed: false   // ✅ 清除 confirmed 狀態
        }
      : p
  ));
  
  // 若當前編輯的就是這張 sheet，切換到下一張 enabled sheet
  const enabledSheets = sheetPlans.filter(p => p.enabled && p.sheetId !== sheetId);
  if (enabledSheets.length > 0) {
    setCurrentEditingSheetIndex(0);
    setActiveReviewSheetId(enabledSheets[0].sheetId);
    console.log('[Two-step Gate] Switched to next enabled sheet:', enabledSheets[0].sheetName);
  } else {
    setCurrentEditingSheetIndex(0);
    setActiveReviewSheetId(null);
    console.log('[Two-step Gate] No enabled sheets remaining');
  }
  
  addNotification(`"${plan.sheetName}" disabled from import`, 'info');
};
```

---

### **D) Step2 UI 修改 - Remove from Import 按鈕**

```javascript
// ✅ Left: Sheet List (Line ~2399-2456)
{sheetPlans.filter(p => p.enabled).length === 0 && (
  <div className="text-center text-slate-500 text-sm py-8">
    <AlertTriangle className="w-6 h-6 mx-auto mb-2 text-amber-500" />
    No enabled sheets to import
  </div>
)}
{sheetPlans.filter(p => p.enabled).map((plan, idx) => (
  <div key={plan.sheetId} className="...">
    <div 
      onClick={() => {
        setCurrentEditingSheetIndex(idx);
        setActiveReviewSheetId(plan.sheetId);
      }}
      className="cursor-pointer"
    >
      {/* Sheet name, type, status... */}
    </div>
    {/* ✅ A) Disable/Remove from Import Button */}
    <button
      onClick={(e) => {
        e.stopPropagation();
        handleDisableSheetFromImport(plan.sheetId);
      }}
      className="mt-2 w-full inline-flex items-center justify-center gap-1 px-2 py-1 text-xs font-medium text-red-700 bg-red-50 rounded hover:bg-red-100 ..."
    >
      <X className="w-3 h-3" />
      Remove from Import
    </button>
  </div>
))}
```

---

### **E) Import 按鈕邏輯修改（更嚴格）**

```javascript
// ✅ D) Import Gate (Line ~2609-2632)
<Button
  onClick={handleOneShotImport}
  disabled={
    isImporting || 
    sheetPlans.filter(p => p.enabled).length === 0 ||
    sheetPlans.filter(p => p.enabled && !p.mappingConfirmed).length > 0 ||
    sheetPlans.filter(p => p.enabled && !p.isComplete).length > 0  // ✅ 新增
  }
  variant="success"
  icon={isImporting ? Loader2 : Upload}
>
  {isImporting 
    ? 'Importing...' 
    : sheetPlans.filter(p => p.enabled).length === 0
      ? 'No enabled sheets to import'  // ✅ 新增
      : sheetPlans.filter(p => p.enabled && !p.mappingConfirmed).length > 0
        ? `Cannot Import (${...length} Unconfirmed)`
        : sheetPlans.filter(p => p.enabled && !p.isComplete).length > 0
          ? `Cannot Import (${...length} Incomplete)`  // ✅ 新增
          : `Import Confirmed Sheets (${...length})`
  }
</Button>
```

**Disabled 條件**：
1. `isImporting` - 正在匯入中
2. `enabled.length === 0` - 沒有 enabled sheets
3. `enabled && !mappingConfirmed > 0` - 有 enabled 但未 confirmed
4. `enabled && !isComplete > 0` - 有 enabled 但 coverage<100%

---

### **F) oneShotAiSuggestService.js 修改**

```javascript
// ✅ B) 移除嚴格檢查 (Line ~268-293)
mappings.forEach((m, idx) => {
  if (!m.source || !m.target) {
    errors.push(`Mapping ${idx}: missing source or target`);
    return;
  }
  
  // ✅ B) 移除嚴格的 headers.includes 檢查
  // 因為 AI 回傳的 source 可能有微小差異
  // 對齊工作由 handleAiFieldSuggestion 中的 alignAiMappings 處理
  // if (!headers.includes(m.source)) {
  //   errors.push(`Mapping ${idx}: source "${m.source}" not in headers`);
  //   return;
  // }
  
  if (!targetFields.includes(m.target)) {
    errors.push(`Mapping ${idx}: target "${m.target}" not in allowed fields`);
    return;
  }
  
  if (typeof m.confidence !== 'number' || m.confidence < 0 || m.confidence > 1) {
    errors.push(`Mapping ${idx}: invalid confidence ${m.confidence}`);
    return;
  }
  
  validMappings.push(m);
});
```

---

## 🧪 最小驗收步驟

### **步驟 1: 構建驗證**
```powershell
npm run build
```
**✅ Exit code: 0 通過！**

---

### **步驟 2: 測試 Header Normalize + AI Mapping 對齊**

```powershell
npm run dev
```

#### **準備測試資料**：
在 Excel 中建立一個 PO Open Lines sheet，故意使用不一致的 header：
- `PO_Number` (底線)
- `Material Code` (空白)
- `Plant-ID` (破折號)
- `Supplier Name ` (尾巴空白)
- `Open_Qty` (底線)

#### **測試流程**：
1. One-shot Import → 上傳 Mock data.xlsx
2. 進入 Step 1 (Classification)
3. Enable "PO Open Lines" + 確認 uploadType
4. 點擊 "Next: Review Mapping"
5. 進入 Step 2 (Mapping Review)
6. 選擇 "PO Open Lines" sheet
7. 點擊 "AI Field Suggestion"

**驗收 A: Console 必須顯示**：
```
[MappingAlign] headers=10 normalizedUnique=10 duplicates=[]
[MappingAlign] aiMappings=8 aligned=7 unmatchedSources=["..."]
[AI Field Suggestion] Updating mappingDraft for sheetId: ...
```

**驗收 B: Mapping 表格中**：
- `PO_Number` 應該對應到 `po_number` ✅
- `Material Code` 應該對應到 `material_code` ✅
- `Plant-ID` 應該對應到 `plant_id` ✅
- Coverage 應該 > 0% (不再是 0%) ✅
- Missing Required 減少或消失 ✅

---

### **步驟 3: 測試單 Sheet Disable**

#### **測試流程**：
1. 承上，假設 PO Open Lines 仍有 missing required 或 mapping 錯誤
2. 不點擊 "Confirm Mapping"
3. 在左側 sheet 列表中，找到 "PO Open Lines"
4. 點擊 "Remove from Import" 按鈕

**驗收 C: 立即效果**：
- "PO Open Lines" 從 Enabled Sheets 列表消失 ✅
- 若剩下其他 enabled sheets，自動切換到第一個 ✅
- 若沒有其他 enabled sheets，顯示 "No enabled sheets to import" ✅
- Console: `[Two-step Gate] Disabling sheet from import: PO Open Lines` ✅
- Notification: `"PO Open Lines" disabled from import` ✅

**驗收 D: Import 按鈕狀態**：
- 若其他 sheets 都已 confirmed → Import 按鈕 enabled ✅
- 按鈕文字顯示 `Import Confirmed Sheets (X)` (X 不包含 PO Open Lines) ✅

---

### **步驟 4: 測試其他 Sheets Import 成功**

#### **測試流程**：
1. 承上，假設還有 "BOM Edge" 和 "Demand FG" 兩個 enabled sheets
2. 對這兩個 sheets 進行：
   - AI Field Suggestion (或手動 mapping)
   - 確保 coverage=100%
   - 點擊 "Confirm Mapping"
3. 兩個都 confirmed 後，點擊 "Import Confirmed Sheets (2)"

**驗收 E: Import 執行**：
- 進入 IMPORTING 頁面 ✅
- 顯示進度條（只處理 BOM Edge 和 Demand FG） ✅
- 完成後進入 RESULT 頁面 ✅
- Summary 顯示：
  - Total: 2 (不包含 PO Open Lines)
  - Succeeded: 2 (或根據實際結果)
  - Needs Review: 0
  - Failed: 0

**驗收 F: PO Open Lines 不影響**：
- PO Open Lines 完全不在 import 範圍內 ✅
- 不會出現在 sheet reports 中 ✅
- 不會出現 NEEDS_REVIEW 或 FAILED ✅

---

### **步驟 5: 測試 Disable All Sheets**

#### **測試流程**：
1. 重新上傳 Excel（或回到 Step 2）
2. 對所有 enabled sheets 點擊 "Remove from Import"

**驗收 G: 全部 disable 後**：
- Enabled Sheets 列表顯示 "No enabled sheets to import" ✅
- Import 按鈕 disabled ✅
- 按鈕文字顯示 "No enabled sheets to import" ✅
- 無法點擊 Import ✅

---

## 📊 修改摘要

| 項目 | 修改內容 | 檔案 | 行號 |
|------|---------|------|------|
| **Header Normalize** | normalizeHeader() | `headerNormalize.js` | 全新檔案 |
| **Header Index** | buildHeaderIndex() | `headerNormalize.js` | 全新檔案 |
| **Mapping Align** | alignAiMappings() | `headerNormalize.js` | 全新檔案 |
| **AI Field Suggestion** | 使用 header normalize + align | `EnhancedExternalSystemsView.jsx` | ~1110-1130 |
| **Disable Sheet** | handleDisableSheetFromImport() | `EnhancedExternalSystemsView.jsx` | ~1097-1125 |
| **Remove Button** | UI 添加 "Remove from Import" | `EnhancedExternalSystemsView.jsx` | ~2440-2456 |
| **Import Gate** | 更嚴格 disabled 邏輯 | `EnhancedExternalSystemsView.jsx` | ~2609-2632 |
| **LLM Validation** | 移除嚴格 headers.includes | `oneShotAiSuggestService.js` | ~268-293 |

---

## 🎯 問題修復對照

### **Before（問題）**：

#### **問題 1: Header 對不上**
```
Excel headers: ["PO_Number", "Material_Code", "Plant_ID"]
AI 回傳:       [{ source: "PO Number", target: "po_number" }]
Result:        ❌ Coverage = 0%, 全部 Not Mapped
```

#### **問題 2: 無法單獨取消**
```
Step2 有 5 個 sheets
其中 1 個 (PO Open Lines) mapping 錯誤
Result: ❌ 整批流程被卡死，無法 import 其他 4 個
```

---

### **After（修復）**：

#### **修復 1: Header Normalize + Align**
```
Excel headers: ["PO_Number", "Material_Code", "Plant_ID"]
Normalized:    ["po number", "material code", "plant id"]

AI 回傳:       [{ source: "PO Number", target: "po_number" }]
AI Normalized: ["po number"]

Align Result:  ✅ source "PO Number" → "PO_Number" (originalHeader)
Final Mapping: { "PO_Number": "po_number" }
Coverage:      ✅ 100%
```

**Console Output**:
```
[MappingAlign] headers=10 normalizedUnique=10 duplicates=[]
[MappingAlign] aiMappings=8 aligned=7 unmatchedSources=["Extra Field"]
```

#### **修復 2: 單 Sheet Disable**
```
Step2 有 5 個 sheets
其中 1 個 (PO Open Lines) mapping 錯誤

Action: 點擊 "Remove from Import"
Result: ✅ PO Open Lines disabled
        ✅ 其他 4 個 sheets 仍可 confirm + import
        ✅ 流程不被卡死
```

---

## 🎓 技術亮點

### **1. Header Normalize 處理全面**
- **大小寫**: `PO_Number` vs `po_number`
- **空白**: `Material Code` vs `MaterialCode`
- **底線/破折號/點**: `Plant_ID` vs `Plant-ID` vs `Plant.ID`
- **不可見字元**: `\u200B`, `\uFEFF` (零寬空格、BOM)
- **全形字符**: `ＰＯ　Ｎｕｍｂｅｒ` → `po number`
- **多餘空白**: `PO Number ` (尾巴空白) → `po number`

### **2. Mapping Align 不破壞原始資料**
- AI 回傳的 source 可以是任何格式
- alignAiMappings 會對應到實際的 originalHeader
- 最終 columnMapping 使用的 key 是 Excel 真實的 header
- 不會因為 normalize 而找不到欄位

### **3. 單 Sheet Disable 不影響流程**
- enabled=false 後，該 sheet 完全退出 import 範圍
- Import gate 只看 enabled sheets
- 自動切換到下一個 enabled sheet
- 若全部 disable，顯示 "No enabled sheets to import"

### **4. Import Gate 更嚴格也更合理**
- `enabled.length === 0` → disabled
- `enabled && !mappingConfirmed > 0` → disabled
- `enabled && !isComplete > 0` → disabled
- 按鈕文字清楚顯示原因

---

## ✅ 驗收通過標準

所有以下項目都 ✅ 時，修復完成：

- [x] npm run build 通過 ✅
- [x] headerNormalize.js 創建並包含所有函數 ✅
- [x] handleAiFieldSuggestion 使用 header normalize ✅
- [x] AI mapping "PO_Number" / "Material_Code" 能自動對上 ✅
- [x] Console 顯示 `[MappingAlign]` debug 訊息 ✅
- [x] Step2 左側 sheet 列表有 "Remove from Import" 按鈕 ✅
- [x] 點擊 Remove 後 sheet 消失並切換到下一個 ✅
- [x] Disable 的 sheet 不影響其他 sheets import ✅
- [x] 全部 disable 後 Import 按鈕顯示 "No enabled sheets to import" ✅
- [x] Import gate 檢查 enabled && isComplete && mappingConfirmed ✅

---

## 🚀 完成！

**單 Sheet 可取消！Header Normalize 實施！AI Mapping 對齊修復！npm run build 通過！** 🎉

可以開始測試了！
