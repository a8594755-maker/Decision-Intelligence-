# AI Suggest All 功能測試指引

## 🎯 功能概述

新增「AI 一鍵建議」功能，批量為 One-shot Sheet Plans 中的所有 sheets 執行 AI 建議，同時修復 AI 回傳格式不穩定的問題。

---

## 📝 修改的檔案摘要

### 1. **新增檔案**

#### `src/utils/concurrency.js`
- 簡單的併發控制工具，避免同時執行過多 Promise
- **主要函式**：
  - `runWithConcurrency(tasks, concurrency, onProgress)` - 基本併發執行
  - `runWithConcurrencyAbortable(tasks, signal, concurrency, onProgress)` - 支援中止的併發執行

### 2. **修改檔案**

#### `src/services/oneShotAiSuggestService.js`
- **新增 Robust Parser**：
  - `parseAiMappingResponse(aiResponse)` - 支援多種回傳格式
    - 支援：`{ mappings: [...] }`, `{ mapping: [...] }`, `{ columnMappings: [...] }`, 直接陣列, JSON 字串
    - 格式錯誤時不 throw，改為回傳 `{ ok: false, mappings: [], error: "..." }`
  - `validateMappings(mappings)` - 驗證 mappings 陣列內容
  
- **修改主函式 `suggestSheetMapping`**：
  - 使用新的 robust parser 處理 AI 回傳
  - 格式錯誤時不中斷，回傳錯誤結果 (confidence=0, autoEnable=false)
  - catch 區塊改為回傳錯誤結果而非 throw（錯誤隔離）
  - 加強 `requiredCoverage < 1.0` 時不得 auto-enable 的邏輯

#### `src/views/EnhancedExternalSystemsView.jsx`
- **新增狀態**：
  - `aiSuggestAllRunning` - 批量執行中
  - `aiSuggestAllProgress` - 進度 `{ completed, total }`
  - `aiSuggestAllAbortController` - Abort 控制器
  - `includeAlreadyReady` - checkbox: 是否包含已 ready 的 sheets

- **新增函式**：
  - `handleAiSuggestAll()` - 批量 AI 建議主函式
    - 篩選需要 AI 的 sheets（預設排除已 ready + confidence >= 0.85 + coverage = 100%）
    - 使用併發控制（concurrency = 2）
    - 顯示整體進度
    - 錯誤隔離（單張 sheet 失敗不影響其他）
  - `handleCancelAiSuggestAll()` - 取消批量執行

- **修改函式**：
  - `handleAiSuggest(plan)` - 單張 sheet AI 建議
    - 增加 sampleRows 從 30 → 50
    - 支援 AI service 回傳錯誤結果（不會 crash）
    - 加強 `requiredCoverage < 1.0` 檢查
    - 改進錯誤處理與通知

- **新增 UI 元件**：
  - 「AI 一鍵建議」按鈕區塊（表格上方）
  - 進度條顯示
  - 「取消」按鈕
  - 「包含已準備好的 sheets」checkbox

---

## 🧪 手動測試步驟

### 準備測試資料
建議使用一個包含多個 sheets 的 Excel 檔案，例如：
- Sheet 1: BOM Edge (高信心度)
- Sheet 2: Demand FG (低信心度或未分類)
- Sheet 3: Supplier Master (已 ready)
- Sheet 4: Inventory (格式不完整，會導致 AI 失敗)

### 測試步驟

#### **步驟 1：啟動開發伺服器**
```powershell
npm run dev
```

#### **步驟 2：進入 Data Upload 頁面**
1. 開啟 Chrome 並前往 `http://localhost:5173`
2. 登入後點選「External Systems」或「Data Upload」
3. 開啟 Chrome DevTools Console（F12）

#### **步驟 3：上傳多 sheet Excel 檔案**
1. 開啟「One-shot Import」toggle
2. 點擊「Select File to Upload」上傳測試檔案
3. 系統會自動分析所有 sheets
4. 檢查 Console 是否有 `[One-shot] Sheet plans generated` log
5. 檢查每個 sheet 的初始分類結果

**預期結果**：
- ✅ 所有 sheets 都顯示在表格中
- ✅ 每個 sheet 有唯一的 `sheetId`（Console log 可見）
- ✅ 初始分類有 confidence 和 uploadType

#### **步驟 4：測試「AI 一鍵建議」（預設模式）**
1. 點擊「AI 一鍵建議」按鈕
2. 觀察進度條與進度文字（X / N 完成）
3. 觀察 Console logs

**預期結果**：
- ✅ 只對低信心度/未分類的 sheets 執行 AI（已 ready 的會被跳過）
- ✅ 進度條正常更新
- ✅ Console 顯示 `[AI Suggest All] Processing: ...` 逐一執行
- ✅ 執行期間單顆「AI Suggest」按鈕為 disabled
- ✅ 完成後顯示通知：「批量 AI 建議完成：X 成功, Y 失敗」

#### **步驟 5：測試「包含已準備好的 sheets」**
1. 勾選「包含已準備好的 sheets」checkbox
2. 再次點擊「AI 一鍵建議」

**預期結果**：
- ✅ 所有 sheets 都會執行 AI 建議（包含已 ready 的）
- ✅ 進度條顯示 total 數量增加

#### **步驟 6：測試中途取消**
1. 點擊「AI 一鍵建議」
2. 在執行過程中（進度 2/5 時）點擊「取消」按鈕

**預期結果**：
- ✅ 批量執行立即停止
- ✅ 顯示通知：「批量 AI 建議已取消」
- ✅ 已完成的 sheets 保留 AI 建議結果
- ✅ 未執行的 sheets 維持原狀
- ✅ 所有 loading 狀態清除

#### **步驟 7：測試 AI 格式錯誤處理**
1. 使用一個會導致 AI 回傳格式錯誤的 sheet（例如：欄位很少、內容很亂）
2. 對該 sheet 執行單顆「AI Suggest」或包含在批量執行中

**預期結果**：
- ✅ 不會出現「missing mappings array」錯誤導致頁面 crash
- ✅ 該 sheet 顯示錯誤原因（例如：「AI 回傳格式不正確」）
- ✅ 該 sheet 的 confidence 設為 0
- ✅ 該 sheet 不會被 auto-enable
- ✅ 其他 sheets 照常執行（錯誤隔離）

#### **步驟 8：測試 requiredCoverage < 1.0 不 auto-enable**
1. 找一個 AI 建議後 `requiredCoverage < 100%` 的 sheet
2. 執行 AI 建議

**預期結果**：
- ✅ 該 sheet 不會被自動 enabled（即使 confidence 很高）
- ✅ Status 欄位顯示：「⚠ Required fields coverage < 100%」
- ✅ 使用者需要手動勾選 Enable checkbox

#### **步驟 9：測試併發控制**
1. 上傳包含 6+ sheets 的 Excel
2. 點擊「AI 一鍵建議」（包含所有 sheets）
3. 觀察 Console logs 的時間戳記

**預期結果**：
- ✅ 同時最多只有 2 個 sheets 在執行 AI（concurrency = 2）
- ✅ Console logs 顯示每 2 個 sheets 一組完成
- ✅ 不會一次打爆 AI API

#### **步驟 10：測試單顆「AI Suggest」仍可用**
1. 批量執行完成後
2. 點擊某一列的單顆「AI Suggest」按鈕

**預期結果**：
- ✅ 單顆按鈕正常執行
- ✅ 只有該列顯示 loading
- ✅ 完成後更新該列資料

---

## 🐛 已知問題與修復

### 問題 1：AI 回傳格式不穩定
**症狀**：Console 顯示 `missing "mappings" array`，導致整個流程失敗

**根因**：AI 有時回傳 `{ mapping: [...] }` 或 `{ columnMappings: [...] }` 而非 `{ mappings: [...] }`

**修復**：
- 新增 `parseAiMappingResponse` robust parser
- 支援 6+ 種格式變體
- 格式錯誤時不 throw，改為回傳錯誤結果

### 問題 2：單張 sheet AI 失敗影響其他 sheets
**症狀**：某一張 sheet AI 失敗，導致批量執行中斷

**根因**：`suggestSheetMapping` 遇到錯誤會 throw

**修復**：
- `suggestSheetMapping` 改為回傳錯誤結果而非 throw
- 每個 sheet 的 task 使用 try-catch 包裝
- 使用 `Promise.allSettled` 模式處理結果

### 問題 3：requiredCoverage < 1.0 仍被 auto-enable
**症狀**：mapping 不完整的 sheet 被自動啟用，導致匯入失敗

**根因**：原邏輯只檢查 `confidence >= 0.75`，未檢查 coverage

**修復**：
- `handleAiSuggest` 中新增 `requiredCoverage < 1.0` 檢查
- 強制設為 `enabled: false`
- 顯示警告訊息

---

## 📊 驗收標準

### 功能驗收
- ✅ 點擊「AI 一鍵建議」會批量執行 AI
- ✅ 預設只對需要 AI 的 sheets 執行
- ✅ 勾選 checkbox 後包含所有 sheets
- ✅ 顯示整體進度（X / N）
- ✅ 可中途取消（Abort）
- ✅ 併發限制為 2（不會同時執行過多）

### 錯誤處理驗收
- ✅ AI 格式錯誤不會 crash 頁面
- ✅ 單張 sheet 失敗不影響其他
- ✅ 所有錯誤都有清楚的訊息顯示在 Status 欄位
- ✅ Console 不再出現「missing mappings array」錯誤

### 構建驗收
- ✅ `npm run build` 通過（已驗證）
- ✅ 無 TypeScript/ESLint 錯誤

---

## 🔍 除錯技巧

### Console Logs 關鍵字
搜尋這些關鍵字快速定位問題：
- `[AI Suggest All]` - 批量執行相關
- `[Robust Parser]` - 格式解析相關
- `[Concurrency]` - 併發控制相關
- `[AI Suggest]` - 單張 sheet AI 相關

### 常見問題

#### Q1: 點擊「AI 一鍵建議」沒反應
**檢查**：
1. Console 是否有錯誤
2. `sheetPlans` 是否為空
3. 是否有需要 AI 的 sheets（預設會跳過已 ready 的）

#### Q2: 進度條不更新
**檢查**：
1. `onProgress` callback 是否被正確呼叫（Console log）
2. `aiSuggestAllProgress` state 是否更新
3. 是否被 React 重新渲染

#### Q3: 取消後仍在執行
**檢查**：
1. `AbortController.signal.aborted` 是否為 true
2. 每個 task 是否檢查 signal
3. Console 是否顯示 `[Concurrency] Aborted at task ...`

---

## 🎉 完成標誌

當以下所有項目都 ✅ 時，功能完成：
- [ ] npm run build 通過
- [ ] 上傳多 sheet Excel 後可看到「AI 一鍵建議」按鈕
- [ ] 點擊按鈕會批量執行，顯示進度
- [ ] 可中途取消，已完成的保留結果
- [ ] AI 格式錯誤不會 crash，顯示錯誤訊息
- [ ] 單張 sheet 失敗不影響其他
- [ ] requiredCoverage < 100% 不會被 auto-enable
- [ ] 單顆「AI Suggest」按鈕仍可正常使用
- [ ] Console 無「missing mappings array」錯誤

---

## 📞 支援

若測試過程遇到問題，請提供：
1. Console 完整 log（從 `[One-shot]` 開始）
2. 測試的 Excel 檔案結構（sheet names + headers）
3. 預期行為 vs 實際行為
4. 錯誤截圖
