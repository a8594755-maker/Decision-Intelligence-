# DI Pipeline Quality Fix Guide — 第三輪修正

> **基於實際執行 Trace 分析**（"Revenue & Sales Trend Analysis" 測試）
> **日期**: 2026-03-24
> **狀態**: S2/S3/S4/Failure Memory/Cache Dedup 均已生效，以下為剩餘問題

---

## 總覽

| # | 優先級 | 問題 | 涉及檔案 | 預估工時 |
|---|--------|------|----------|----------|
| 1 | **P0** | Edge Function 未部署，CORS stream 仍 fallback | 部署操作 | 5 min |
| 2 | **P0** | Direct JSON Brief 圖表 data 為空陣列 | `agentResponsePresentationService.js` | 20 min |
| 3 | **P1** | `repairBrief` 使用慢模型導致 25s 超時 | `agentResponsePresentationService.js` | 10 min |
| 4 | **P1** | `ai_employee_memory` 表不存在 | Supabase SQL + `aiEmployeeMemoryService.js` | 15 min |
| 5 | **P2** | Optimizer SQL 去重比對太嚴格 | `chatAgentLoop.js` | 20 min |

---

## Fix #1 — 部署 Edge Function（P0）

### 問題

CORS stream 修正的程式碼已經寫入 `supabase/functions/ai-proxy/index.ts`，但 Edge Function **從未重新部署**。所有 OpenAI stream 呼叫仍因 `Access-Control-Allow-Origin` 不匹配（5174 vs 5173）而 fallback 到 non-stream，浪費了首 token 延遲優化。

### Trace 證據

```
[OpenAI] Stream failed, falling back to non-stream: ...
```

### 修正方式

在終端機執行：

```bash
supabase functions deploy ai-proxy
```

部署完成後驗證：打開 DevTools Network，發起一次分析，確認 OpenAI 呼叫使用 `text/event-stream` 且無 CORS 錯誤。

### 額外確認

確保 `.env` 或 Supabase Dashboard 中的 `ALLOWED_ORIGINS` 包含你的前端 URL（通常是 `http://localhost:5173`）。如果你同時在 5173 和 5174 上開發，兩個都要加。

---

## Fix #2 — Direct JSON Brief 圖表資料回填（P0）

### 問題

S2 Direct JSON Brief 運作正常——Primary Agent 直接輸出結構化 JSON，跳過 Brief Synthesis LLM。但 Agent 輸出的 `chart_specs` 中 `data` 欄位全部為空陣列 `[]`。

原因：Agent 的 system prompt 要求它輸出圖表規格，但 Agent 無法把 tool call 返回的大量資料塞進 JSON（token 限制）。它只能給出 chart metadata（type, xKey, yKey, title），而實際資料存在 `toolCalls` 裡。

### Trace 證據

```
[Presentation] Using direct JSON brief from agent (no synthesis LLM needed)
// 但最終報告的圖表全無資料
```

### 涉及檔案

`src/services/agentResponsePresentationService.js`

### 修正位置

**第 2329–2334 行**（`buildAgentPresentationPayload` 函式內，direct JSON brief 解析後）

### 修正方式

在成功解析 direct JSON brief 之後、進入 QA 之前，檢查圖表是否有空 data，並從 toolCalls 回填：

```javascript
// ── 原始程式碼（第 2326-2334 行）──
let initialBrief;
if (mode === 'analysis') {
  try {
    const directBrief = JSON.parse(finalAnswerText);
    if (directBrief.headline && directBrief.summary) {
      initialBrief = directBrief;
      console.info('[Presentation] Using direct JSON brief from agent (no synthesis LLM needed)');
    }
  } catch { /* not valid JSON — fallback below */ }
}

// ── 在上方 if (mode === 'analysis') 區塊的結尾大括號之後，
// ── if (!initialBrief) 之前，插入以下程式碼 ──

// Backfill empty chart data from tool calls (agent can't embed full data in JSON)
if (initialBrief?.chart_specs) {
  const toolCharts = buildChartsFromToolCalls(toolCalls, { brevity: 'analysis' });
  const hasEmptyCharts = (initialBrief.chart_specs || []).some(
    c => !Array.isArray(c.data) || c.data.length === 0
  );
  if (hasEmptyCharts && toolCharts.length > 0) {
    // Strategy: match by chart type + title, fall back to positional matching
    const filledCharts = (initialBrief.chart_specs || []).map((agentChart, idx) => {
      if (Array.isArray(agentChart.data) && agentChart.data.length > 0) return agentChart;
      // Try type+title match first
      const match = toolCharts.find(
        tc => tc.type === agentChart.type && tc.title === agentChart.title
      ) || toolCharts[idx]; // positional fallback
      if (match) {
        return {
          ...agentChart,
          data: match.data,
          xKey: agentChart.xKey || match.xKey,
          yKey: agentChart.yKey || match.yKey,
          ...(match.series && !agentChart.series ? { series: match.series } : {}),
        };
      }
      return agentChart;
    }).filter(c => Array.isArray(c.data) && c.data.length > 0);

    // If agent had more chart specs than tool results, supplement with tool charts
    if (filledCharts.length < toolCharts.length) {
      const usedTypes = new Set(filledCharts.map(c => `${c.type}:${c.title}`));
      for (const tc of toolCharts) {
        if (!usedTypes.has(`${tc.type}:${tc.title}`)) {
          filledCharts.push(tc);
        }
      }
    }

    initialBrief.chart_specs = filledCharts;
    console.info(`[Presentation] Backfilled ${filledCharts.length} charts from tool calls`);
  }
}
```

### 同步修正 normalizeBrief

`normalizeBrief`（第 756 行）處理 `charts` 欄位時讀取的是 `source.charts`。但 Direct JSON brief 的圖表欄位名稱是 `chart_specs`（Agent prompt 裡定義的），需要欄位名稱對齊。

在 `normalizeBrief` 函式內，第 758 行 `const source = ...` 之後加入：

```javascript
// Map agent's chart_specs field to charts for normalization
if (!source.charts && Array.isArray(source.chart_specs)) {
  source.charts = source.chart_specs;
}
```

### 驗證方式

執行一次分析，確認 console 出現：
```
[Presentation] Backfilled X charts from tool calls
```
且 UI 上的圖表有實際資料顯示。

---

## Fix #3 — repairBrief 使用快速模型（P1）

### 問題

`repairBrief()` 呼叫 `runDiPrompt` 時沒有指定 `providerOverride` / `modelOverride`，導致 model router 選擇了預設模型（在 trace 中是 `gpt-5.4` thinking model），結果 25 秒超時失敗。

相比之下，同檔案中的 `requestQaReview`（第 2368-2369 行）和 `runBackgroundQa`（第 2496-2497 行）都正確使用了 `CROSS_MODEL_REVIEW_PROVIDER` / `CROSS_MODEL_REVIEW_MODEL`（定義於第 116-117 行）。

### Trace 證據

```
[agentResponsePresentation] Repair synthesis fallback: openai/gpt-5.4: Edge Function timed out after 25000ms
```

### 涉及檔案

`src/services/agentResponsePresentationService.js`

### 修正位置

**第 2254–2270 行**（`repairBrief` 函式內的 `runDiPrompt` 呼叫）

### 修正方式

在 `runDiPrompt` 呼叫中加入 provider/model override，與其他 QA 呼叫保持一致：

```javascript
// ── 修改前（第 2255-2270 行）──
const result = await runDiPrompt({
  promptId: DI_PROMPT_IDS.AGENT_QA_REPAIR_SYNTHESIS,
  input: {
    userMessage,
    answerContract,
    brief,
    toolCalls: summarizeToolCallsForPrompt(toolCalls),
    finalAnswerText: clamp(stripThinkingTags(finalAnswerText), 3000),
    deterministicQa,
    qaScorecard,
    artifactSummary,
    mode,
  },
  temperature: 0.1,
  maxOutputTokens: 4096,
});

// ── 修改後 ──
const result = await runDiPrompt({
  promptId: DI_PROMPT_IDS.AGENT_QA_REPAIR_SYNTHESIS,
  input: {
    userMessage,
    answerContract,
    brief,
    toolCalls: summarizeToolCallsForPrompt(toolCalls),
    finalAnswerText: clamp(stripThinkingTags(finalAnswerText), 3000),
    deterministicQa,
    qaScorecard,
    artifactSummary,
    mode,
  },
  temperature: 0.1,
  maxOutputTokens: 4096,
  providerOverride: CROSS_MODEL_REVIEW_PROVIDER,
  modelOverride: CROSS_MODEL_REVIEW_MODEL,
});
```

變動只有兩行：加入 `providerOverride` 和 `modelOverride`。

### 驗證方式

觸發一次 QA score < 5.0 的分析（或暫時把 `needsRepair` 閾值調高到 8.0 來強制觸發），確認 repair 呼叫使用 Gemini 且在 5 秒內完成，不再出現 25s timeout。

---

## Fix #4 — 建立 ai_employee_memory 資料表（P1）

### 問題

Failure Memory 系統（`aiEmployeeMemoryService.js`）嘗試寫入 Supabase 的 `ai_employee_memory` 表，但該表不存在，console 出現：

```
Could not find the table 'public.ai_employee_memory' in the schema cache
```

系統 fallback 到 localStorage，功能正常但資料不持久、不跨裝置。

### 修正方式

**選項 A — 建立 Supabase 表（推薦）**

在 Supabase SQL Editor 執行：

```sql
-- Failure Memory table for AI Employee learning
CREATE TABLE IF NOT EXISTS public.ai_employee_memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Memory classification
  memory_type TEXT NOT NULL DEFAULT 'failure_pattern',
  category TEXT,              -- e.g. 'tool_error', 'sql_error', 'analysis_error'

  -- Pattern details
  pattern_key TEXT NOT NULL,  -- dedupe key (hash of error signature)
  tool_name TEXT,
  error_message TEXT,
  error_context JSONB,       -- structured context (SQL, args, etc.)

  -- Resolution
  resolution TEXT,            -- how the error was resolved (if known)
  resolved_at TIMESTAMPTZ,

  -- Frequency tracking
  occurrence_count INTEGER DEFAULT 1,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),

  -- Standard timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Prevent duplicate patterns per project
  UNIQUE(project_id, pattern_key)
);

-- Index for fast recall during agent loops
CREATE INDEX idx_ai_employee_memory_project
  ON public.ai_employee_memory(project_id, memory_type, last_seen_at DESC);

CREATE INDEX idx_ai_employee_memory_pattern
  ON public.ai_employee_memory(pattern_key);

-- RLS policies
ALTER TABLE public.ai_employee_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own project memories"
  ON public.ai_employee_memory FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own project memories"
  ON public.ai_employee_memory FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own project memories"
  ON public.ai_employee_memory FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own project memories"
  ON public.ai_employee_memory FOR DELETE
  USING (auth.uid() = user_id);
```

> **注意**：請確認你的 schema 中 `projects` 表是否存在且有 `id` 欄位。如果表名不同（如 `di_projects`），請相應修改 `REFERENCES` 語句。

**選項 B — 抑制 console 噪音（最小改動）**

如果暫時不想建表，在 `aiEmployeeMemoryService.js` 中把 Supabase 失敗的 `console.warn` 改為只在首次觸發時輸出：

```javascript
let _memoryTableWarned = false;
// 在每個 Supabase 操作的 catch 區塊中：
if (!_memoryTableWarned) {
  console.warn('[FailureMemory] Supabase table not found, using localStorage fallback');
  _memoryTableWarned = true;
}
```

### 驗證方式

選項 A：執行一次會觸發 tool error 的分析，確認 Supabase 中 `ai_employee_memory` 表出現新記錄。
選項 B：確認 console 只出現一次警告，不再重複刷屏。

---

## Fix #5 — Optimizer SQL Cache Dedup 比對優化（P2）

### 問題

目前的 SQL 正規化只做了基本的空白 + 分號清理（第 1079 行）：

```javascript
const norm = s => (s || '').replace(/\s+/g, ' ').replace(/\s*;\s*$/, '').trim().toLowerCase();
```

Optimizer 產生的 SQL 可能使用不同的 table alias、column alias、或微小格式差異，導致語義相同的 SQL 無法命中 cache。在 trace 中，Optimizer 執行了 9 次成功 + 1 次失敗的 tool call，其中多數可能是重複查詢。

### 涉及檔案

`src/services/chatAgentLoop.js`

### 修正位置

**第 1078–1081 行**

### 修正方式

增強 SQL 正規化函式，移除常見的語義無關差異：

```javascript
// ── 修改前（第 1078-1081 行）──
if (toolName === 'query_sap_data') {
  const norm = s => (s || '').replace(/\s+/g, ' ').replace(/\s*;\s*$/, '').trim().toLowerCase();
  return norm(ptc.args?.sql) === norm(toolArgs?.sql);
}

// ── 修改後 ──
if (toolName === 'query_sap_data') {
  const normSql = s => {
    let q = (s || '').toLowerCase().trim();
    // Remove trailing semicolons
    q = q.replace(/\s*;\s*$/, '');
    // Collapse whitespace
    q = q.replace(/\s+/g, ' ');
    // Strip table aliases: "FROM orders AS o" → "FROM orders"
    q = q.replace(/\b(from|join)\s+(\w+)\s+(?:as\s+)?\w+\b/gi, '$1 $2');
    // Strip column aliases in SELECT: "col AS alias" → "col"
    q = q.replace(/\b(\w+(?:\.\w+)?)\s+as\s+\w+\b/gi, '$1');
    // Remove table prefixes: "o.order_date" → "order_date"
    q = q.replace(/\b\w+\.(\w+)/g, '$1');
    // Normalize quotes
    q = q.replace(/[`"]/g, '');
    // Final trim
    return q.trim();
  };
  return normSql(ptc.args?.sql) === normSql(toolArgs?.sql);
}
```

### 注意事項

這個正規化有 false positive 風險（兩個語義不同的 SQL 被誤判為相同）。目前 trade-off 可接受——即使偶爾 cache hit 錯誤，影響只是 Optimizer 少跑一次查詢而使用 Primary 的結果，而 Primary 結果已通過 QA。

如果後續遇到 false positive 問題，可考慮改用 SQL AST parser（如 `node-sql-parser`）進行語法樹比對。

### 驗證方式

執行一次觸發 Optimizer 的分析（QA score < 4.0），觀察 console：
```
[agentLoop] Optimizer: returning cached primary result for query_sap_data
```
出現次數應明顯增加（相比修改前）。

---

## 執行順序建議

```
Step 1 (5 min)  → Fix #1: 部署 Edge Function
Step 2 (20 min) → Fix #2: 圖表資料回填
Step 3 (10 min) → Fix #3: repairBrief 模型修正
Step 4 (15 min) → Fix #4: 建立 memory 表
Step 5 (20 min) → Fix #5: SQL 正規化
                   ─────────────
                   Total: ~70 min
```

Fix #1 和 #2 是 P0，直接影響使用者體驗（stream 延遲 + 空圖表），建議優先處理。Fix #3 和 #4 影響管線穩定性。Fix #5 是效能優化，不急。

---

## 已確認完成的項目（不需再改）

以下項目在原始修改計畫中列出，但在 code review 中確認已正確實作：

- ✅ Default mode prompt 已包含 statsmodels/sklearn/calendar（chatAgentLoop.js 第 568 行）
- ✅ Dashboard JSON 第四層 fallback 已加入（dashboardSummaryAgent.js 第 222-226 行）
- ✅ AlertTriangle 已 import（InsightsHub.jsx 第 9 行）
- ✅ `buildImmediatePresentation` 已正確限制 JSON parse 僅 analysis mode（第 2452 行）
- ✅ S2 Direct JSON Brief — 運作中
- ✅ S3 Simplified QA — 運作中（單次 unified review）
- ✅ S4 Three-level Optimizer Escalation — 運作中
- ✅ Failure Memory System — 運作中（localStorage fallback）
- ✅ SQL Cache Dedup — 基本功能運作中
- ✅ Sandbox Module Expansion — 運作中
