# AI 自動欄位映射功能說明

## 概述

為了進一步提升上傳效率，系統現在提供 **AI 自動欄位映射建議**功能。使用 Google Gemini AI 分析 Excel 欄位名稱和樣本資料，自動建議最合適的系統欄位對應關係。

---

## 功能特點

### ✨ 智能分析
- 分析欄位名稱的語意（中英文）
- 參考樣本資料的內容和格式
- 提供信心度評分（0.0 - 1.0）

### 🎯 精準建議
- 只套用高信心度（≥ 0.6）的建議
- 不會覆蓋使用者已經手動設定的映射
- 自動跳過不確定的欄位

### 🚀 一鍵完成
- 點擊「AI 欄位建議」按鈕
- 等待 AI 分析（通常 3-5 秒）
- 自動套用建議的映射
- 使用者可以再微調

---

## 使用流程

### Step 1: 上傳檔案
選擇上傳類型並上傳 Excel/CSV 檔案

### Step 2: 進入欄位映射頁面
系統會顯示所有 Excel 欄位

### Step 3: 點擊「AI 欄位建議」
在右上角點擊「AI 欄位建議」按鈕

### Step 4: AI 分析中
- 按鈕變為「AI 分析中...」並顯示 loading 動畫
- 此時按鈕會被停用

### Step 5: 查看結果
- 成功：顯示「已套用 AI 欄位建議（X 個欄位）」
- AI 會自動填入建議的映射
- 使用者可以檢查並微調

### Step 6: 確認並繼續
檢查映射是否正確，然後進行資料驗證

---

## AI 分析邏輯

### 輸入資訊

AI 會收到以下資訊：

1. **上傳類型** (`uploadType`)
   - 例如：`goods_receipt`, `price_history`, `supplier_master`

2. **系統欄位定義** (從 `UPLOAD_SCHEMAS`)
   ```javascript
   [
     {
       key: "supplier_name",
       label: "供應商名稱",
       type: "string",
       required: true
     },
     // ... 其他欄位
   ]
   ```

3. **原始 Excel 欄位**
   ```javascript
   ["供應商", "料號", "收貨日期", "數量"]
   ```

4. **樣本資料** (前 20 筆)
   ```javascript
   [
     {
       "供應商": "供應商A",
       "料號": "MAT001",
       "收貨日期": "2024-01-15",
       "數量": "100"
     },
     // ... 更多樣本
   ]
   ```

### AI 回應格式

```json
{
  "mappings": [
    {
      "source": "供應商",
      "target": "supplier_name",
      "confidence": 0.95,
      "reason": "欄位名稱明確對應供應商名稱"
    },
    {
      "source": "料號",
      "target": "material_code",
      "confidence": 0.90,
      "reason": "料號對應物料代碼"
    },
    {
      "source": "收貨日期",
      "target": "actual_delivery_date",
      "confidence": 0.85,
      "reason": "樣本資料顯示為日期格式"
    },
    {
      "source": "數量",
      "target": "received_qty",
      "confidence": 0.80,
      "reason": "數量欄位對應收貨數量"
    }
  ]
}
```

### 信心度等級

| 信心度 | 說明 | 處理方式 |
|-------|------|---------|
| 0.9 - 1.0 | 非常確定 | 自動套用 |
| 0.7 - 0.9 | 很有信心 | 自動套用 |
| 0.6 - 0.7 | 中等信心 | 自動套用 |
| 0.0 - 0.6 | 低信心 | 不套用，需手動 |

### 套用邏輯

```javascript
// 只套用信心度 ≥ 0.6 且有 target 的建議
if (confidence >= 0.6 && target !== null) {
  // 只更新尚未手動設定的欄位
  if (!currentMapping[source] || currentMapping[source] === '') {
    newMapping[source] = target; // 套用
  } else {
    // 已有映射，跳過（不覆蓋使用者設定）
  }
}
```

---

## 實際範例

### 範例 1：收貨記錄

**Excel 欄位**：
```
供應商名稱, 物料代碼, 交貨日期, 收到數量, 不良數
```

**AI 建議**：
```javascript
{
  "供應商名稱": "supplier_name",     // confidence: 0.95
  "物料代碼": "material_code",       // confidence: 0.90
  "交貨日期": "actual_delivery_date", // confidence: 0.85
  "收到數量": "received_qty",        // confidence: 0.85
  "不良數": "rejected_qty"           // confidence: 0.80
}
```

**結果**：全部自動套用 ✓

### 範例 2：部分確定的情況

**Excel 欄位**：
```
廠商, 料號, Date, Qty, 備註
```

**AI 建議**：
```javascript
{
  "廠商": "supplier_name",           // confidence: 0.75
  "料號": "material_code",           // confidence: 0.85
  "Date": "actual_delivery_date",    // confidence: 0.70
  "Qty": "received_qty",             // confidence: 0.65
  "備註": null                       // confidence: 0.40 (不確定)
}
```

**結果**：
- ✓ 「廠商」→ `supplier_name`
- ✓ 「料號」→ `material_code`
- ✓ 「Date」→ `actual_delivery_date`
- ✓ 「Qty」→ `received_qty`
- ✗ 「備註」→ 留空（需手動映射）

### 範例 3：已有手動映射

**現有映射**：
```javascript
{
  "供應商": "supplier_name",  // 使用者已手動設定
  "料號": "",                 // 未設定
  "日期": ""                  // 未設定
}
```

**AI 建議**：
```javascript
{
  "供應商": "supplier_code",         // AI 建議（但信心度高）
  "料號": "material_code",           
  "日期": "actual_delivery_date"
}
```

**結果**：
- ✗ 「供應商」→ 保持 `supplier_name`（不覆蓋）
- ✓ 「料號」→ `material_code`（套用）
- ✓ 「日期」→ `actual_delivery_date`（套用）

---

## 技術實作

### 檔案結構

```
src/
├── views/
│   └── EnhancedExternalSystemsView.jsx  ⭐ UI 和主邏輯
├── utils/
│   └── aiMappingHelper.js               ⭐ AI 輔助函數
└── services/
    └── geminiAPI.js                     📡 Gemini API 呼叫
```

### 核心函數

#### 1. runAiMappingSuggestion()
主要的 AI 分析函數

```javascript
const runAiMappingSuggestion = async () => {
  // 1. 前置條件檢查
  if (!uploadType || !rawRows.length || !columns.length) {
    addNotification("錯誤訊息", "error");
    return;
  }

  // 2. 開始分析
  setMappingAiStatus('analyzing');

  try {
    // 3. 生成 prompt
    const prompt = generateMappingPrompt(...);

    // 4. 呼叫 Gemini API
    const aiResponse = await callGeminiAPI(prompt);

    // 5. 解析回應
    const parsedResponse = extractAiJson(aiResponse);

    // 6. 驗證格式
    if (!validateMappingResponse(parsedResponse)) {
      throw new Error('格式不正確');
    }

    // 7. 合併映射
    const { mapping, appliedCount } = mergeMappings(
      columnMapping,
      parsedResponse.mappings
    );

    // 8. 更新狀態
    setColumnMapping(mapping);
    setMappingAiStatus('ready');

    // 9. 顯示通知
    addNotification(`已套用 ${appliedCount} 個欄位`, "success");

  } catch (error) {
    setMappingAiStatus('error');
    addNotification("AI 分析失敗", "error");
  }
};
```

#### 2. generateMappingPrompt()
生成 AI prompt

```javascript
export const generateMappingPrompt = (
  uploadType,
  schemaFields,
  originalColumns,
  sampleRows
) => {
  return `
你是資料映射專家...
[詳細 prompt 內容]
  `;
};
```

#### 3. extractAiJson()
從 AI 回應提取 JSON

```javascript
export const extractAiJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    // 嘗試提取第一個 {...} 區塊
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    return {};
  }
};
```

#### 4. mergeMappings()
合併 AI 建議和現有映射

```javascript
export const mergeMappings = (
  currentMapping,
  aiMappings,
  minConfidence = 0.6
) => {
  const newMapping = { ...currentMapping };
  let appliedCount = 0;

  aiMappings.forEach(({ source, target, confidence }) => {
    if (confidence >= minConfidence && target !== null) {
      if (!currentMapping[source] || currentMapping[source] === '') {
        newMapping[source] = target;
        appliedCount++;
      }
    }
  });

  return { mapping: newMapping, appliedCount };
};
```

---

## UI 狀態管理

### mappingAiStatus

| 狀態 | 說明 | UI 顯示 |
|-----|------|---------|
| `idle` | 初始狀態 | 按鈕顯示「AI 欄位建議」 |
| `analyzing` | AI 分析中 | 按鈕 disabled，顯示「AI 分析中...」+ loading icon |
| `ready` | 分析完成 | 按鈕恢復正常 |
| `error` | 分析失敗 | 按鈕恢復正常，顯示錯誤訊息 |

### mappingAiError

儲存錯誤訊息，供 debug 使用

---

## 最佳實務

### 1. 何時使用 AI 建議？

**建議使用**：
- ✅ 第一次上傳某種類型的檔案
- ✅ Excel 欄位名稱清晰明確
- ✅ 欄位數量較多（> 10 個）
- ✅ 想要快速完成映射

**建議手動**：
- ⚠️ 欄位名稱很模糊或不標準
- ⚠️ 已經有保存的 mapping 模板
- ⚠️ 只有少數幾個欄位
- ⚠️ 特殊的自定義欄位

### 2. 檢查 AI 建議

即使使用 AI 建議，也建議檢查：
- ✅ 所有必填欄位都有映射
- ✅ 映射關係是否正確
- ✅ 資料類型是否匹配

### 3. 結合使用

最有效的方式：
1. 先使用「AI 欄位建議」快速完成大部分映射
2. 檢查並微調不確定的欄位
3. 補充 AI 未映射的欄位
4. 進行資料驗證

### 4. 提高準確度

讓 AI 更準確的技巧：
- ✅ 使用標準的欄位名稱
- ✅ 保持欄位命名一致
- ✅ 確保樣本資料有代表性
- ✅ 避免過於簡化的欄位名（如「A」、「B」）

---

## 故障排除

### Q1: AI 建議失敗怎麼辦？

**可能原因**：
- API key 未設定或失效
- 網路連線問題
- 樣本資料格式異常

**解決方法**：
- 檢查 Gemini API key 設定
- 重新嘗試
- 改用手動映射

### Q2: AI 建議的映射不準確？

**解決方法**：
- 直接在映射界面手動修正
- AI 只是建議，最終決定權在使用者手上
- 修正後重新驗證

### Q3: AI 沒有建議某些欄位？

**原因**：
- 信心度低於閾值（< 0.6）
- AI 無法判斷對應關係

**解決方法**：
- 手動映射這些欄位
- 這是正常的，表示 AI 保守不亂猜

### Q4: 想要重新跑 AI 建議？

**方法**：
- 清空想要重新建議的欄位映射
- 再次點擊「AI 欄位建議」
- AI 只會填入空的欄位

---

## 效能考量

### API 呼叫成本

- 每次 AI 分析會呼叫一次 Gemini API
- 建議在確定需要時才使用
- 不要頻繁點擊按鈕

### 分析時間

- 通常 3-5 秒
- 取決於：
  - 欄位數量
  - 樣本資料大小
  - API 回應速度

### 優化建議

- 只傳送前 20 筆樣本資料
- 簡化 schema 欄位定義
- 使用快取（未來改進）

---

## 與其他功能的整合

### 與 Mapping 模板的關係

```
第一次上傳
   ↓
AI 欄位建議 ←─────┐
   ↓              │
手動微調           │
   ↓              │
驗證並寫入         │
   ↓              │
保存 mapping 模板 ─┘
   
第二次上傳
   ↓
自動載入模板 (優先)
   ↓
AI 建議 (補充)
```

**優先順序**：
1. 使用者手動設定
2. 保存的 mapping 模板
3. AI 建議

### 與資料驗證的關係

AI 映射 → 使用者確認 → 資料驗證 → 寫入資料庫

AI 只是建議映射關係，不會影響後續的驗證邏輯。

---

## 安全性

### 資料隱私

- 只傳送前 20 筆樣本資料給 AI
- 不會傳送完整的資料集
- API key 儲存在本地瀏覽器

### 錯誤處理

- 所有 API 呼叫都有 try-catch
- 失敗不影響主流程
- 可以降級到手動映射

---

## 未來改進

### 可能的增強

1. **學習功能**
   - 記錄使用者修正的映射
   - 改進 AI 建議準確度

2. **批次模式**
   - 支援多個檔案
   - 共用 AI 建議

3. **自訂規則**
   - 使用者定義映射規則
   - 優先於 AI 建議

4. **視覺化信心度**
   - 顯示每個映射的信心度
   - 標示低信心度的映射

---

## 總結

AI 自動欄位映射功能：

- 🚀 **快速**：3-5 秒完成大部分映射
- 🎯 **準確**：高信心度建議（通常 > 80%）
- 🛡️ **安全**：不覆蓋手動設定
- 💡 **智能**：分析欄位名稱和資料內容
- 🔄 **可調**：支援手動微調

建議作為輔助工具使用，與 mapping 模板和手動映射結合，達到最佳效果！

---

## 相關文檔

- **MAPPING_TEMPLATE_GUIDE.md** - Mapping 模板功能
- **UPLOAD_WORKFLOW_GUIDE.md** - 完整上傳流程
- **src/utils/aiMappingHelper.js** - AI 輔助函數原始碼

