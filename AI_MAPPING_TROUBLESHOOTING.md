# AI 欄位映射故障排除指南

## 常見錯誤：AI response format is incorrect

### 問題描述

當您點擊「AI Field Suggestion」按鈕時，可能會看到以下錯誤：

```
AI field suggestion failed: AI response format is incorrect
```

### 原因分析

這個錯誤通常由以下原因造成：

#### 1. **AI 回應包含額外文字**
Gemini AI 可能會在 JSON 之前或之後添加說明文字：

```
好的，我來分析這些欄位...

{
  "mappings": [...]
}

這是我的分析結果。
```

#### 2. **AI 回應使用 Markdown 格式**
AI 可能會用 markdown 代碼塊包裹 JSON：

```markdown
```json
{
  "mappings": [...]
}
```
```

#### 3. **Schema 語言不一致**
如果 prompt 使用中文但 schema 標籤是英文（或相反），AI 可能會混淆。

#### 4. **JSON 格式錯誤**
AI 生成的 JSON 可能有語法錯誤（缺少逗號、引號等）。

---

## 已實作的修復

### 1. **更新 Prompt 為英文** ✅

**檔案**: `src/utils/aiMappingHelper.js`

將 prompt 改為英文，與您的英文 schema 標籤一致：

```javascript
const prompt = `You are a data mapping expert. Please analyze Excel columns and suggest corresponding system fields.

**Upload Type**: ${uploadType}

**System Field Definitions**:
${JSON.stringify(simplifiedSchema, null, 2)}

...

**CRITICAL: Return ONLY valid JSON, no explanatory text before or after**:
{
  "mappings": [...]
}

Return the JSON now:`;
```

### 2. **增強 JSON 提取邏輯** ✅

改進 `extractAiJson()` 函數以處理各種格式：

```javascript
export const extractAiJson = (text) => {
  // 1. 嘗試直接解析
  try {
    return JSON.parse(text);
  } catch (_) {
    // 2. 移除 markdown 格式
    let cleaned = text
      .replace(/```json\s*/gi, '')  // 移除 ```json
      .replace(/```\s*/g, '')        // 移除 ```
      .trim();
    
    try {
      return JSON.parse(cleaned);
    } catch (_err) {
      // 3. 提取 { ... } 區塊
      const startIdx = cleaned.indexOf('{');
      const endIdx = cleaned.lastIndexOf('}');
      
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        const jsonStr = cleaned.substring(startIdx, endIdx + 1);
        return JSON.parse(jsonStr);
      }
      
      return {};
    }
  }
};
```

### 3. **增強錯誤日誌** ✅

在 `EnhancedExternalSystemsView.jsx` 中添加詳細日誌：

```javascript
// Call Gemini API
const aiResponse = await callGeminiAPI(prompt);
console.log('AI Raw Response:', aiResponse);

// Parse AI response
const parsedResponse = extractAiJson(aiResponse);
console.log('Parsed Response:', parsedResponse);

// Validate response format
if (!validateMappingResponse(parsedResponse)) {
  console.error('Invalid response structure:', parsedResponse);
  throw new Error('AI response format is incorrect. The AI may have returned explanatory text instead of pure JSON. Please try again or use manual mapping.');
}
```

### 4. **改進驗證函數** ✅

`validateMappingResponse()` 現在會記錄詳細錯誤：

```javascript
export const validateMappingResponse = (aiResponse) => {
  if (!aiResponse || typeof aiResponse !== 'object') {
    console.error('AI response is not an object:', typeof aiResponse);
    return false;
  }

  if (!Array.isArray(aiResponse.mappings)) {
    console.error('AI response missing "mappings" array:', aiResponse);
    return false;
  }

  if (aiResponse.mappings.length === 0) {
    console.warn('AI response has empty mappings array');
    return false;
  }

  // 檢查每個 mapping
  const isValid = aiResponse.mappings.every((m, index) => {
    const valid = 
      typeof m === 'object' &&
      typeof m.source === 'string' &&
      (m.target === null || typeof m.target === 'string') &&
      typeof m.confidence === 'number' &&
      m.confidence >= 0 &&
      m.confidence <= 1;
    
    if (!valid) {
      console.error(`Invalid mapping at index ${index}:`, m);
    }
    
    return valid;
  });

  return isValid;
};
```

---

## 如何使用

### 步驟 1：嘗試 AI 建議

1. 上傳 Excel 檔案
2. 進入欄位映射頁面（Step 3）
3. 點擊右上角的「AI Field Suggestion」按鈕
4. 等待 AI 分析（3-5 秒）

### 步驟 2：如果遇到錯誤

打開瀏覽器開發者工具（F12），查看 Console 日誌：

#### 檢查 AI Raw Response
```javascript
AI Raw Response: "Here is my analysis...\n\n{\"mappings\": [...]}\n\nHope this helps!"
```

如果看到 JSON 之外的文字，說明 AI 添加了額外說明。

#### 檢查 Parsed Response
```javascript
Parsed Response: { mappings: [...] }
```

如果這裡是空物件 `{}`，說明 JSON 提取失敗。

#### 檢查驗證錯誤
```javascript
Invalid mapping at index 2: { source: "supplier", target: 123, confidence: "high" }
```

如果看到這類錯誤，說明 AI 回應的資料格式不正確（例如 target 應該是 string 但是 number）。

### 步驟 3：降級到手動映射

如果 AI 建議失敗，可以：

1. **手動映射所有欄位**
   - 逐個選擇每個 Excel 欄位對應的系統欄位
   - 確保所有必填欄位都有映射

2. **部分使用 AI，部分手動**
   - 如果 AI 成功映射了部分欄位
   - 手動補充未映射的欄位

3. **重試 AI 建議**
   - 有時重試會成功
   - AI 的回應可能每次不同

---

## 為什麼不是 Sheet 的問題？

從您的截圖可以看到：

```
Data Preview (First 3 rows)

supplier_name | supplier_code | material_code | material_name | ...
Formosa Prec...| FP1003       | RM-87423     | Stainless ...  | ...
```

資料已經成功讀取並顯示，證明：

✅ Excel 檔案已正確上傳
✅ Sheet 已正確讀取
✅ 欄位已正確解析
✅ 資料已正確顯示

**問題出在 AI 分析階段，與 Excel 讀取無關。**

---

## 測試建議

### 測試案例 1：手動映射（保證成功）

不使用 AI，手動映射每個欄位：

```
supplier_name  → Supplier Name
supplier_code  → Supplier Code
material_code  → Material Code
material_name  → Material Name
...
```

### 測試案例 2：AI 建議（需要 API）

使用 AI 自動建議：
- 確保 Gemini API key 有效
- 檢查網路連線
- 查看 Console 日誌

### 測試案例 3：混合模式

1. 先嘗試 AI 建議
2. 如果部分成功，手動補充剩餘欄位
3. 檢查並修正 AI 錯誤的映射

---

## 常見問題

### Q1: 為什麼 AI 建議有時成功，有時失敗？

**A**: Gemini AI 的回應可能每次不同：
- 有時嚴格遵循 JSON 格式
- 有時會添加額外說明
- 網路延遲或 API 問題

### Q2: 可以完全不使用 AI 嗎？

**A**: 可以！AI 建議只是輔助功能：
- 手動映射完全可行
- Mapping 模板功能也很強大
- AI 失敗不影響主流程

### Q3: 如何提高 AI 成功率？

**A**: 
- ✅ 使用標準的欄位名稱
- ✅ 確保樣本資料清晰
- ✅ Excel 欄位名稱明確（不要用 A, B, C）
- ✅ 重試幾次

### Q4: 錯誤日誌在哪裡？

**A**: 
1. 按 F12 打開開發者工具
2. 切換到 Console 標籤
3. 查看紅色錯誤訊息
4. 複製給開發者或用於 debug

---

## 聯絡支援

如果問題持續發生：

1. **提供 Console 日誌**
   - AI Raw Response
   - Parsed Response
   - 錯誤訊息

2. **提供截圖**
   - 錯誤通知
   - 欄位映射畫面
   - Excel 預覽

3. **描述步驟**
   - 上傳了什麼類型的資料
   - Excel 欄位名稱
   - 期望的映射結果

---

## 總結

### ✅ 已修復

- Prompt 改為英文（與 schema 一致）
- JSON 提取更穩健（處理 markdown 和額外文字）
- 錯誤日誌更詳細（便於 debug）
- 驗證邏輯更完善（記錄錯誤詳情）

### 💡 建議

- 優先使用手動映射（保證成功）
- AI 建議作為輔助（提升效率）
- 遇到錯誤時查看 Console（理解問題）
- 重試幾次（AI 回應可能不同）

### 🎯 下一步

1. 刷新瀏覽器頁面
2. 重新上傳 Excel
3. 再次嘗試 AI 建議
4. 如果失敗，查看 Console 日誌
5. 降級到手動映射完成任務

AI 建議是輔助功能，失敗不影響核心流程！



