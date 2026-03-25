# DI 專案自學指南 — 從你自己的 Codebase 學會真正的工程能力

> 目標：用 4 週時間，把這個 AI 幫你寫的專案變成你真正理解的東西。
> 每個題目都是：**讀懂 → 手寫筆記 → 從零重寫 → 加一個新功能**。

---

## Week 1：基礎 — 純函式與資料驗證

### 題目 1：Inventory Calculator（庫存計算器）

**檔案：** `src/domains/inventory/calculator.js`
**難度：** ⭐⭐（入門）
**預估時間：** 2–3 天

**你會學到的 CS 概念：**
- 純函式（Pure Function）— 同樣的 input 永遠回傳同樣的 output，沒有副作用
- 防禦性程式設計（Defensive Programming）— 每個參數都驗證
- 函式組合（Function Composition）— 小函式組成大函式

**要讀懂的重點：**
1. `calculateDaysToStockout()` — 最基本的計算，但注意它怎麼處理 `dailyDemand = 0`、負數庫存、`Infinity` 這些邊界情況
2. `calculateStockoutProbability()` — 用啟發式規則算機率，不是機器學習，而是簡單的數學公式加上 volatility 調整
3. `calculateInventoryRisk()` — 組合了上面兩個函式，看它怎麼把多個計算結果打包成一個 risk 物件

**你的作業：**
1. 開一個新檔案 `my-calculator.js`，**不看原始碼**，自己寫出 `calculateDaysToStockout`
2. 寫完後跟原始碼比對，看你漏掉了哪些邊界情況
3. 自己加一個新函式：`calculateReorderPoint(dailyDemand, leadTimeDays, safetyStock)` — 計算補貨點
4. 幫你寫的每個函式寫至少 3 個測試（happy path、邊界值、錯誤輸入）

**驗證方式：** `npx vitest run src/domains/inventory/my-calculator.test.js` 全部通過

---

### 題目 2：BOM Calculator（物料清單計算器）

**檔案：** `src/domains/forecast/bomCalculator.js`
**難度：** ⭐⭐⭐（中等）
**預估時間：** 2–3 天

**你會學到的 CS 概念：**
- 遞迴（Recursion）— BOM 是樹狀結構，展開需要遞迴走訪
- 環形偵測（Cycle Detection）— 如果 A 的子件是 B，B 的子件又是 A，遞迴會無窮迴圈
- 深度限制（Depth Limiting）— 用 `MAX_DEPTH` 防止堆疊溢出

**要讀懂的重點：**
1. `DEFAULTS` 和 `ERROR_MESSAGES` 常數定義 — 把所有魔法數字和錯誤訊息集中管理
2. `roundTo()` 精度控制 — 為什麼金融計算需要特別處理浮點數
3. BOM 展開的遞迴結構 — 怎麼從根節點一路展開到最底層零件

**你的作業：**
1. 在紙上畫出一個 3 層的 BOM 樹（例：腳踏車 → 車架、輪子 → 輪圈、輪胎、鏈條）
2. 手動用你畫的樹，追蹤遞迴展開的過程，寫下每一步的呼叫堆疊
3. 自己實作一個簡化版的 `explodeBom(product, bomTable, depth = 0)`
4. 加入環形偵測：用一個 `Set` 記錄已走訪的節點，遇到重複就拋錯

**驗證方式：** 你的函式能正確展開測試資料，遇到環形 BOM 會拋出錯誤而不是當掉

---

## Week 2：設計模式 — 事件驅動與服務層

### 題目 3：Event Bus（事件匯流排）

**檔案：** `src/services/governance/eventBus.js`
**難度：** ⭐⭐⭐（中等）
**預估時間：** 2 天

**你會學到的 CS 概念：**
- 觀察者模式（Observer / Pub-Sub Pattern）
- 解耦（Decoupling）— 發送事件的人不需要知道誰在聽
- 資源清理（Cleanup）— subscribe 回傳 unsubscribe 函式，避免 memory leak

**要讀懂的重點：**
1. `subscribe(eventName, callback)` — 用 `Map<string, Set<Function>>` 管理訂閱者
2. 萬用字元訂閱 `agent:*` — 怎麼實作 pattern matching
3. `once()` — 只觸發一次就自動取消訂閱

**你的作業：**
1. 自己從零寫一個 `MyEventBus` class，實作 `on(event, fn)`、`emit(event, data)`、`off(event, fn)`
2. 加上 `once()` 功能
3. 加上萬用字元支援（`*` 匹配任何事件）
4. 寫一個實際使用範例：模擬「訂單建立 → 庫存扣減 → 通知發送」的事件鏈

**延伸挑戰：** 加上事件歷史紀錄功能 — `getHistory(eventName)` 回傳該事件過去 N 次的觸發紀錄

---

### 題目 4：BOM Explosion Service（服務層模式）

**檔案：** `src/services/planning/bomExplosionService.js`
**難度：** ⭐⭐⭐（中等）
**預估時間：** 2 天

**你會學到的 CS 概念：**
- 服務層模式（Service Layer Pattern）— 在 UI 和 API 之間加一層抽象
- 優雅降級（Graceful Degradation）— Edge Function 掛了就改用本地計算
- 輪詢模式（Polling）— 對長時間執行的任務，定時檢查是否完成

**要讀懂的重點：**
1. 呼叫 Supabase Edge Function → 如果失敗 → fallback 到本地計算
2. 兩階段非同步操作：啟動任務 + 輪詢結果
3. 錯誤上下文萃取 — 不是只拋 "failed"，而是告訴使用者哪裡失敗、為什麼

**你的作業：**
1. 寫一個簡化版的 service，用 `fetch` 呼叫任意一個公開 API（例如 JSONPlaceholder）
2. 加上 fallback：如果 API 失敗，回傳本地的假資料
3. 加上 retry 機制：失敗後等 1 秒再試，最多試 3 次
4. 加上 timeout：超過 5 秒就放棄，直接走 fallback

**驗證方式：** 故意把 API URL 改錯，確認 fallback 有正確運作

---

## Week 3：進階非同步 — 並發控制與容錯

### 題目 5：AI Proxy Service（Semaphore + Circuit Breaker）

**檔案：** `src/services/ai-infra/aiProxyService.js`
**難度：** ⭐⭐⭐⭐⭐（進階）
**預估時間：** 3–4 天

**你會學到的 CS 概念：**
- 信號量（Semaphore）— 控制同時只能有 N 個請求在執行
- 斷路器（Circuit Breaker）— 下游服務掛了就暫停送請求，過一段時間再試
- 狀態機（State Machine）— CLOSED → OPEN → HALF_OPEN 三個狀態的轉換
- 背壓（Backpressure）— 系統過載時自動降低並發數

**要讀懂的重點：**
1. `AsyncSemaphore` class（約 80 行）— 用 Promise queue 實作 FIFO 排隊
2. `CircuitBreaker` class（約 60 行）— 三態狀態機，追蹤連續失敗次數
3. 兩者怎麼組合使用：請求先過 Semaphore（排隊），再過 Circuit Breaker（是否允許通過）

**你的作業：**

**Part A — Semaphore：**
1. 自己寫一個 `MySemaphore` class，建構子接受 `maxConcurrent`
2. 實作 `acquire()` — 回傳 Promise，當有空位時 resolve
3. 實作 `release()` — 釋放一個空位，讓排隊的下一個 resolve
4. 測試：同時發射 10 個請求，限制 3 個並發，用 `console.log` 印出同時在執行的數量

```javascript
// 你的測試程式碼應該長這樣
const sem = new MySemaphore(3);

async function task(id) {
  await sem.acquire();
  console.log(`Task ${id} 開始（並發中）`);
  await sleep(1000);  // 模擬 API 呼叫
  console.log(`Task ${id} 完成`);
  sem.release();
}

// 同時發射 10 個
await Promise.all(Array.from({length: 10}, (_, i) => task(i)));
```

**Part B — Circuit Breaker：**
1. 自己寫一個 `MyCircuitBreaker` class
2. 三個狀態：`CLOSED`（正常）、`OPEN`（斷路）、`HALF_OPEN`（試探）
3. 規則：連續失敗 3 次 → 進入 OPEN → 等 10 秒 → 進入 HALF_OPEN → 成功一次 → 回 CLOSED / 失敗 → 回 OPEN
4. 測試：用一個會隨機失敗的假 API，觀察狀態轉換

**Part C — 組合：**
1. 把 Semaphore 和 Circuit Breaker 組合起來
2. 寫一個 `protectedCall(fn)` 函式，先檢查 Circuit Breaker 狀態，再排隊通過 Semaphore

---

### 題目 6：Risk Score Service（多來源資料整合）

**檔案：** `src/services/risk/riskScoreService.js`
**難度：** ⭐⭐⭐⭐（中高）
**預估時間：** 2 天

**你會學到的 CS 概念：**
- 服務編排（Service Orchestration）— 從多個資料來源取資料，合併計算
- 批次處理（Batch Processing）— 一次處理多筆資料的效能考量
- 審計日誌（Audit Trail）— 每次計算都記錄，事後可追溯

**要讀懂的重點：**
1. `runRiskScoreCalculation()` 的流程：載入資料 → 合併 → 計算分數 → 寫入審計紀錄
2. 怎麼從多個來源（機率資料、營收資料、外部信號）合併成一個 risk score
3. 版本化設計 — 每次計算都標記版本號，讓結果可重現

**你的作業：**
1. 設計一個「學生成績風險評估」系統：
   - 來源 1：出席率資料
   - 來源 2：作業成績
   - 來源 3：考試成績
2. 寫一個 `calculateStudentRisk()` 函式，合併三個來源算出一個風險分數
3. 加上審計日誌：每次計算記錄 timestamp、input hash、output
4. 加上批次處理：一次計算全班 30 個學生的風險分數

---

## Week 4：系統設計 — Agent 架構與 API Gateway

### 題目 7：Chat Agent Loop（ReAct Agent）

**檔案：** `src/services/agent-core/chatAgentLoop.js`
**難度：** ⭐⭐⭐⭐⭐（進階）
**預估時間：** 3–4 天

**你會學到的 CS 概念：**
- ReAct 迴圈（Reasoning + Acting）— LLM Agent 的核心運作模式
- 工具呼叫（Tool Calling）— LLM 決定要用哪個工具、傳什麼參數
- 迭代預算（Iteration Budget）— 防止 Agent 無限循環
- Prompt Engineering — 怎麼用 system prompt 控制 LLM 行為

**要讀懂的重點：**
1. 迴圈結構：`思考 → 選工具 → 執行工具 → 觀察結果 → 決定是否繼續`
2. 動態迭代預算：根據問題複雜度決定最多跑幾輪
3. 步驟大綱生成：在跑迴圈之前先規劃要做哪些步驟
4. Provider 抽象：同一套邏輯可以接不同的 LLM（Gemini、DeepSeek 等）

**你的作業：**
1. 自己實作一個極簡版 ReAct Agent（不需要真的接 LLM，用硬編碼模擬）：

```javascript
// 虛擬碼
async function miniAgent(question) {
  const tools = {
    search: (query) => `搜尋結果：${query} 相關資料...`,
    calculate: (expr) => eval(expr),  // 注意：eval 只用於學習，生產環境不要用
  };

  let context = question;
  for (let i = 0; i < 5; i++) {  // 最多 5 輪
    const thought = await thinkAboutNextStep(context);
    if (thought.done) return thought.answer;

    const toolResult = tools[thought.tool](thought.input);
    context += `\n工具結果：${toolResult}`;
  }
  return '超過最大迭代次數';
}
```

2. 加上工具註冊機制：`registerTool(name, description, fn)` — Agent 可以查詢有哪些工具可用
3. 加上迭代日誌：記錄每一步的思考、工具選擇、工具結果
4. 加上終止條件：Agent 回答「我不知道」也算結束

---

### 題目 8：AI Proxy Edge Function（API Gateway）

**檔案：** `supabase/functions/ai-proxy/index.ts`
**難度：** ⭐⭐⭐⭐（中高）
**預估時間：** 2 天

**你會學到的 CS 概念：**
- API Gateway 模式 — 統一入口，路由到不同的後端服務
- CORS（Cross-Origin Resource Sharing）— 瀏覽器安全策略
- 環境變數管理 — 敏感資訊（API key）不寫死在程式碼裡
- 多 Provider 抽象 — 同一個介面對接 Gemini、DeepSeek、Anthropic 等

**要讀懂的重點：**
1. CORS 設定 — 哪些 origin 被允許、preflight request 怎麼處理
2. `ProxyMode` 型別 — TypeScript 怎麼用 union type 做安全路由
3. 根據 request body 的 `mode` 欄位決定轉發給哪個 LLM provider
4. API key 從環境變數讀取，不是 hardcode

**你的作業：**
1. 用 Express.js（或 Hono）寫一個簡單的 API Gateway：
   - `POST /api/proxy` 接受 `{ provider: "openai" | "gemini", prompt: "..." }`
   - 根據 provider 轉發到對應的 API（用假的 URL 就好）
2. 加上 CORS middleware
3. 加上 API key 驗證（從 header 讀取，跟環境變數比對）
4. 加上 request logging — 記錄每個請求的 provider、timestamp、response time

---

## 每週自我檢查清單

完成每個題目後，問自己這三個問題：

1. **如果面試官問「這段程式碼在做什麼」，我能不看 code 用白板解釋嗎？**
2. **如果要我改一個需求（例如 Semaphore 改成可動態調整 maxConcurrent），我知道要改哪裡嗎？**
3. **如果這段 code 出了 bug（例如 Circuit Breaker 卡在 OPEN 不恢復），我能 debug 出來嗎？**

如果三個都能回答「是」，這個題目就真的學會了。

---

## 附錄：推薦補充學習資源

| 概念 | 推薦資源 | 為什麼需要 |
|------|---------|-----------|
| JavaScript Async | [javascript.info/async](https://javascript.info/async) | 理解 Promise、async/await 的底層機制 |
| Design Patterns | 《JavaScript Design Patterns》— Addy Osmani | 理解 Observer、Factory、Strategy 等模式 |
| React 原理 | [react.dev/learn](https://react.dev/learn) | 理解 re-render、hooks、state 管理 |
| 系統設計 | 《Designing Data-Intensive Applications》Ch.1-4 | 理解分散式系統基礎 |
| LLM Agent | Lilian Weng 的 "LLM Powered Autonomous Agents" 部落格 | 理解 ReAct、Tool Use 的學術背景 |
