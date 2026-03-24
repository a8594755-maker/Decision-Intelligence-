# Decision Intelligence — 完整修改方案

> 基於 2026-03-24 Revenue & Sales Trend Analysis 完整 trace 分析
> 涵蓋 **Part A: 9 個 Bug 修復** + **Part B: 5 項結構性改進**
> 目標：從目前品質水準提升到 ChatGPT/Claude 80-85% 水準

---

## 目錄

### Part A — Bug 修復（9 項）
1. [P0-1] CORS 修復 — 消除 Stream Fallback
2. [P0-2] InsightsHub AlertTriangle 修復
3. [P1-1] Failure Memory 系統
4. [P1-2] Brief Chart yKey 格式修復
5. [P1-3] Optimizer 防重複查詢強化
6. [P1-4] Judge 雙方不及格降級邏輯
7. [P2-1] DeepSeek Reasoner Self-QA Timeout
8. [P2-2] Dashboard Summary Agent JSON 解析
9. [P2-3] QA Dimension Scores 跨模型相容性

### Part B — 結構性改進（5 項）
10. [S1] Sandbox 模組擴展 — 解鎖高階統計能力
11. [S2] 消除 Brief Synthesis 有損壓縮 — Agent 直接輸出結構化 JSON
12. [S3] QA 系統簡化 — 從 4-6 次 LLM 呼叫降到 2 次
13. [S4] Optimizer 條件觸發 — 智慧判斷是否需要第二個 Agent
14. [S5] Streaming 體驗優化 — 先給用戶看結果，品質檢查背景執行

---

# Part A — Bug 修復

> 以下 9 項已在 `DI-Pipeline-Quality-Fix-Guide.md` 中有詳細程式碼，
> 這裡提供摘要版，完整修改請參考該文件。

---

## 1. [P0-1] CORS 修復 — 消除 Stream Fallback

**問題**：所有 `openai_chat_tools_stream` 呼叫報 CORS 錯誤，每次分析浪費 15-30 秒 fallback。

**檔案**：`supabase/functions/ai-proxy/index.ts` line 36-58

**修復**：
1. 在 `buildCorsHeaders` 加 debug log 確認 origin 是否正確傳入
2. 確認所有 response path（包含 stream response）都呼叫 `buildCorsHeaders(req.headers.get('origin'))`
3. 重新部署 Edge Function：`supabase functions deploy ai-proxy`

**預期效果**：省去 12+ roundtrip fallback，每次分析加速 15-30 秒。

---

## 2. [P0-2] InsightsHub AlertTriangle 修復

**問題**：`ReferenceError: AlertTriangle is not defined at InsightsHub.jsx:28`

**檔案**：`src/pages/InsightsHub.jsx` line 1-17

**修復**：在 import 中加入 `AlertTriangle`：

```javascript
// src/pages/InsightsHub.jsx line ~1-17
import { BarChart3, TrendingUp, TrendingDown, AlertTriangle, ... } from 'lucide-react';
```

---

## 3. [P1-1] Failure Memory 系統

**問題**：Agent 反覆嘗試已知失敗的操作（如 `import statsmodels`），浪費 iterations。

**檔案**：
- `src/services/aiEmployeeMemoryService.js` — 新增 `writeFailurePattern()`, `recallFailurePatterns()`, `attachFailureResolution()`
- `src/services/chatAgentLoop.js` line 1132 附近 — 在 tool failure 時寫入失敗記錄
- `src/services/chatAgentLoop.js` line 632-648 — **已實作** failure block 注入（代碼已存在）

**注意**：`chatAgentLoop.js` line 632-648 已經有 `recallFailurePatterns()` 的呼叫和 `failureBlock` 的組裝邏輯。但 `aiEmployeeMemoryService.js` 中 `recallFailurePatterns` 函式尚未實作，需要新增。

**新增函式**（在 `aiEmployeeMemoryService.js`）：

```javascript
// ── Failure Pattern Memory ──

export async function writeFailurePattern({
  datasetFingerprint, toolUsed, errorType, errorMessage,
  codeSnippet = null, resolution = null
}) {
  const entry = {
    id: localId(),
    type: 'failure_pattern',
    dataset_fingerprint: datasetFingerprint,
    tool_used: toolUsed,
    error_type: classifyToolError(errorMessage),
    error_message: errorMessage?.slice(0, 300),
    code_snippet: codeSnippet?.slice(0, 200),
    resolution,
    occurrence_count: 1,
    success: false,
    created_at: new Date().toISOString(),
  };
  // Supabase → localStorage fallback (同 writeQueryPattern 邏輯)
  // 如果同 fingerprint+tool+error_type 已存在，occurrence_count++
}

export async function recallFailurePatterns({ datasetFingerprint, limit = 5 }) {
  // 查詢 type='failure_pattern' AND dataset_fingerprint 匹配
  // ORDER BY occurrence_count DESC, created_at DESC
  // LIMIT limit
}

export async function attachFailureResolution(failureId, resolution) {
  // 更新指定 failure record 的 resolution 欄位
}

function classifyToolError(errorMessage) {
  if (/import\s+\w+/.test(errorMessage) && /not allowed|blocked|ModuleNotFoundError/.test(errorMessage))
    return 'BLOCKED_IMPORT';
  if (/DataFrame|Series|truth value/.test(errorMessage))
    return 'PANDAS_MISUSE';
  if (/timeout|ETIMEDOUT/i.test(errorMessage))
    return 'TIMEOUT';
  if (/0 rows|no data|empty/i.test(errorMessage))
    return 'ZERO_ROWS';
  return 'UNKNOWN';
}
```

**在 chatAgentLoop.js 中寫入失敗**（line ~1132，tool failure 偵測之後）：

```javascript
// 在 if (!toolResult.success) 區塊內加入：
try {
  const fp = toolContext.datasetProfileRow?.profile_json?.global?.fingerprint;
  if (fp) {
    writeFailurePattern({
      datasetFingerprint: fp,
      toolUsed: toolName,
      errorType: toolResult.error?.type || 'UNKNOWN',
      errorMessage: toolResult.error?.message || JSON.stringify(toolResult.error)?.slice(0, 300),
      codeSnippet: toolArgs?.code?.slice(0, 200) || toolArgs?.sql?.slice(0, 200),
    });
  }
} catch { /* non-critical */ }
```

---

## 4. [P1-2] Brief Chart yKey 格式修復

**問題**：Brief Synthesis LLM 輸出 `yKey: "orders,revenue"` 而非使用 `series` 陣列。

**檔案**：`src/components/chat/ChartRenderer.jsx` line 275-284

**修復**：在 `renderChartByType()` 中加入 auto-fix：

```javascript
// ChartRenderer.jsx — renderChartByType() 開頭
let { yKey, series, ...rest } = chart;
if (typeof yKey === 'string' && yKey.includes(',')) {
  const parts = yKey.split(',').map(s => s.trim()).filter(Boolean);
  yKey = parts[0];
  series = parts; // 將所有 key 放入 series
  console.warn('[ChartRenderer] Auto-fixed comma-separated yKey:', chart.yKey, '→', { yKey, series });
}
```

---

## 5. [P1-3] Optimizer 防重複查詢強化

**問題**：Optimizer（DeepSeek Reasoner）忽略 "不要重新查詢" 指令，對相同 SQL 發起重複呼叫。

**檔案**：
- `src/services/analysisDomainEnrichment.js` line 661-748 `buildOptimizerInstruction()`
- `src/services/chatAgentLoop.js` line 1066-1078 — 已有 cache dedup

**修復 A — 強化 Prompt**（在 `buildOptimizerInstruction` 最頂部）：

```javascript
const instruction = [
  '═══ ABSOLUTE RULE: DO NOT RE-QUERY ═══',
  'The Primary Agent already executed all necessary data queries.',
  'You have FULL ACCESS to all query results below.',
  'If you call query_sap_data or run_python_analysis with the same parameters,',
  'it is a CRITICAL ERROR that wastes time and resources.',
  'YOUR JOB: Fix the narrative, charts, and interpretation — NOT re-collect data.',
  '═══════════════════════════════════════',
  '',
  // ... 現有內容
].join('\n');
```

**修復 B — SQL 正規化比對**（在 chatAgentLoop.js cache dedup 邏輯中）：

```javascript
// 現有 line 1066 的比對邏輯加入 SQL 正規化
function normalizeSql(sql) {
  return (sql || '').replace(/\s+/g, ' ').replace(/;\s*$/, '').trim().toLowerCase();
}

// 比對時使用正規化：
const isDuplicate = primaryToolCalls?.some(pc =>
  pc.name === toolName &&
  normalizeSql(pc.args?.sql) === normalizeSql(toolArgs?.sql)
);
```

---

## 6. [P1-4] Judge 雙方不及格降級邏輯

**問題**：兩個候選者都低於 QA 門檻時，Judge 回傳 confidence=0.00。

**檔案**：`src/services/agentCandidateJudgeService.js` line 55-120

**現況**：檢查程式碼後發現 **此修復已部分實作**。line 97-119 已有 `bothBelowThreshold` 偵測，confidence 設為 0.3，且有 `degraded: true`。

**仍需改進**：
1. 在 winner 的 brief 中注入警告（目前只在 judge summary 中有，用戶可能看不到）
2. 考慮在 UI 層面顯示降級警告

```javascript
// 在 DecisionSupportView/index.jsx，judge 決定後加入：
if (judgeDecision?.degraded) {
  // 在最終 brief 的 caveats 中加入品質警告
  const winnerBrief = selectedCandidate?.presentation?.brief;
  if (winnerBrief) {
    winnerBrief.caveats = [
      ...(winnerBrief.caveats || []),
      '⚠️ Both analysis candidates scored below the quality threshold. Results should be independently verified.',
    ];
  }
}
```

---

## 7. [P2-1] DeepSeek Reasoner Self-QA Timeout

**問題**：Reasoning model 做 QA review 太慢（25s timeout）。

**檔案**：`src/services/agentResponsePresentationService.js` line 2342-2357

**現況**：檢查程式碼後發現 **此修復已實作**。line 2355-2356 已改用 `CROSS_MODEL_REVIEW_PROVIDER` / `CROSS_MODEL_REVIEW_MODEL`（Gemini）來做 self-review，不再用 agent 自己的 provider。

**但注意** line 2437-2438 **repair 後的 self-review 仍然使用 `agentProvider` / `agentModel`**：

```javascript
// line 2427-2438 — 修復後重新 review 仍用原始 provider！
const repairedSelfReview = await requestQaReview({
  // ...
  providerOverride: agentProvider,   // ← 這裡需要改
  modelOverride: agentModel,         // ← 這裡需要改
});

// 改為：
const repairedSelfReview = await requestQaReview({
  // ...
  providerOverride: CROSS_MODEL_REVIEW_PROVIDER,
  modelOverride: CROSS_MODEL_REVIEW_MODEL,
});
```

---

## 8. [P2-2] Dashboard Summary Agent JSON 解析

**問題**：LLM 回傳 JSON 前帶有散文文字，3 層 fallback 解析全失敗。

**檔案**：`src/services/dashboardSummaryAgent.js` line 145-222

**修復 A — 強化 prompt**（line 145-170）：

```javascript
const SUMMARY_SYSTEM_PROMPT = `You are a JSON generator. Output ONLY a valid JSON object.
CRITICAL: Your ENTIRE response must be valid JSON.
No text before the opening {. No text after the closing }.
No explanations, no markdown, no code fences.

${/* 現有 schema 定義 */}`;
```

**修復 B — 第 4 層 fallback**（line 176-222 `tryLLMSummary` 中）：

```javascript
// 在現有 3 層 fallback 之後加入第 4 層：
// Layer 4: 找到第一個 { 和最後一個 }，取中間部分
const firstBrace = raw.indexOf('{');
const lastBrace = raw.lastIndexOf('}');
if (firstBrace !== -1 && lastBrace > firstBrace) {
  try {
    return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
  } catch { /* fall through */ }
}
```

---

## 9. [P2-3] QA Dimension Scores 跨模型相容性

**問題**：Gemini cross-review 只回傳 3-4 個維度（共 9 個），缺失的以 5.0 填充，拉低加權分數。

**檔案**：`src/services/agentResponsePresentationService.js` — `mergeQaResults` 或 `normalizeQaReview` 中的維度填充邏輯

**修復**：改善 imputation 策略：

```javascript
// 將缺失維度的填充邏輯從 flat 5.0 改為基於已有維度的加權平均 × 0.8
function imputeMissingDimensions(dimensionScores) {
  const present = {};
  const missing = [];

  for (const key of QA_DIMENSION_KEYS) {
    if (dimensionScores[key] != null && !isNaN(dimensionScores[key])) {
      present[key] = Number(dimensionScores[key]);
    } else {
      missing.push(key);
    }
  }

  if (missing.length === 0) return dimensionScores;

  // 計算已有維度的加權平均
  let weightedSum = 0, weightTotal = 0;
  for (const [key, val] of Object.entries(present)) {
    const w = QA_DIMENSION_WEIGHTS[key] || 0;
    weightedSum += val * w;
    weightTotal += w;
  }
  const imputedValue = weightTotal > 0
    ? Math.round((weightedSum / weightTotal) * 0.8 * 10) / 10  // 打 8 折
    : 5.0; // 完全沒有數據時的 fallback

  const result = { ...dimensionScores };
  for (const key of missing) {
    result[key] = imputedValue;
  }
  return result;
}
```

---

# Part B — 結構性改進

> 這 5 項改動是讓系統品質從「能用」提升到「接近 ChatGPT/Claude」的關鍵。
> Bug 修復只能到 50-60% 水準，加上結構性改進可到 80-85%。

---

## 10. [S1] Sandbox 模組擴展 — 解鎖高階統計能力

### 為什麼需要

目前 `tool_executor.py` 的 `_ALLOWED_MODULES`（line 699-712）不包含 `statsmodels`、`sklearn`、`calendar`。Agent 嘗試 `import statsmodels.tsa.seasonal` 會直接被 sandbox 攔截，迫使它用 pandas 手動實作分解（結果品質差、容易出 bug）。ChatGPT 和 Claude 的 Code Interpreter 都支持這些庫。

### 影響範圍

**檔案**：`src/ml/api/tool_executor.py` line 699-712

### 修改方案

```python
# tool_executor.py line 699-712
_ALLOWED_MODULES = frozenset({
    "pandas", "numpy", "json", "re", "math", "datetime", "time",
    "collections", "statistics", "itertools", "functools",
    "decimal", "fractions", "copy", "string", "textwrap",
    "operator", "numbers", "hashlib", "base64", "uuid",
    "scipy", "scipy.stats", "scipy.interpolate", "scipy.optimize",
    # ── 新增：高階統計與 ML ──
    "statsmodels", "statsmodels.api", "statsmodels.tsa",
    "statsmodels.tsa.seasonal", "statsmodels.tsa.holtwinters",
    "statsmodels.tsa.stattools", "statsmodels.formula.api",
    "sklearn", "sklearn.cluster", "sklearn.preprocessing",
    "sklearn.linear_model", "sklearn.ensemble", "sklearn.metrics",
    "sklearn.decomposition",
    "calendar",
    # ── 原有 ──
    "openpyxl", "openpyxl.styles", "openpyxl.utils", "openpyxl.chart",
    "openpyxl.chart.series", "openpyxl.chart.label", "openpyxl.chart.reference",
    "openpyxl.formatting", "openpyxl.formatting.rule",
    "_strptime", "zoneinfo", "dateutil", "dateutil.parser",
    "pytz", "warnings", "typing", "abc", "enum",
})
```

### 同步更新工具描述

**檔案**：`src/services/builtinToolCatalog.js` line 1155-1179（`run_python_analysis` 的 description）

將 "NOT AVAILABLE: statsmodels, sklearn, matplotlib" 改為：

```
"Available: pandas, numpy, scipy, statsmodels (seasonal_decompose, Holt-Winters, ADF test),
 sklearn (KMeans, LinearRegression, StandardScaler), calendar.
 NOT AVAILABLE: matplotlib, plotly (use generate_chart tool for visualization)."
```

### 同步更新 Code Gen Prompt

**檔案**：`src/ml/api/tool_executor.py` line 474-520（`ANALYSIS_CODE_GEN_SYSTEM_PROMPT`）

在 line 481 的 Available libraries 加入：

```python
# line 481 改為：
"2. Available libraries: pandas, numpy, json, re, math, datetime, collections, "
"statistics, itertools, functools, scipy, scipy.stats, "
"statsmodels (statsmodels.tsa.seasonal.seasonal_decompose, "
"statsmodels.tsa.holtwinters.ExponentialSmoothing, statsmodels.tsa.stattools.adfuller), "
"sklearn (sklearn.cluster.KMeans, sklearn.linear_model.LinearRegression, "
"sklearn.preprocessing.StandardScaler), calendar"
```

### 新增分析模式範例

在 `ANALYSIS_CODE_GEN_SYSTEM_PROMPT` 的 ANALYSIS PATTERNS 區塊末尾加入：

```python
"""
F. TIME SERIES DECOMPOSITION (statsmodels):
   ```python
   from statsmodels.tsa.seasonal import seasonal_decompose
   ts = df.set_index('date')['revenue'].asfreq('M')
   result = seasonal_decompose(ts, model='additive', period=12)
   trend_data = result.trend.dropna().reset_index()
   ```

G. CUSTOMER SEGMENTATION (sklearn KMeans):
   ```python
   from sklearn.cluster import KMeans
   from sklearn.preprocessing import StandardScaler
   features = df[['total_revenue', 'order_count', 'avg_review']].dropna()
   scaled = StandardScaler().fit_transform(features)
   km = KMeans(n_clusters=4, random_state=42, n_init=10).fit(scaled)
   df.loc[features.index, 'segment'] = km.labels_
   ```
"""
```

### 安全考量

- `statsmodels` 和 `sklearn` 本身不含 IO 操作，安全性與 scipy 相當
- 仍然被 `_DANGEROUS_PATTERNS` 保護（不能 import os/sys/subprocess）
- 建議在 Python 環境中確認 `statsmodels` 和 `sklearn` 已安裝：`pip install statsmodels scikit-learn`

### 預期效果

- 時間序列分析品質從「手動 pandas 近似」提升到「專業統計水準」
- 客戶分群從「pd.cut 手動分檔」提升到「K-Means 自動聚類」
- 消除因 blocked import 導致的 Failure Memory 噪音

---

## 11. [S2] 消除 Brief Synthesis 有損壓縮 — Agent 直接輸出結構化 JSON

### 為什麼需要

目前的 pipeline：
```
Agent 原始回答 (narrative text)
  → buildAgentBriefSynthesisPrompt() [另一個 LLM 呼叫]
  → JSON brief
```

這個「有損壓縮」步驟是品質損失最大的地方：
- 數字會被改錯（如 $12.3M → $123M）
- yKey 格式不對（`"orders,revenue"` 而非 `series` 陣列）
- 重要 caveats 被遺漏
- 方法論公式被簡化消失
- **額外消耗 1 次 LLM 呼叫（~3-5 秒）**

### 目標架構

```
Agent 直接輸出 JSON brief（在同一個 LLM 呼叫中）
  → 前端直接渲染
  → 省掉 1 次 LLM 呼叫 + 消除轉換損失
```

### 修改方案

#### Step 1：修改 Agent System Prompt 的輸出指令

**檔案**：`src/services/chatAgentLoop.js` line 468-555（`importantInstructions` 陣列）

在 analysis mode 的指令中加入 JSON brief 輸出規範：

```javascript
// 在 importantInstructions 的 analysis mode 區塊加入：
'── OUTPUT FORMAT: STRUCTURED JSON BRIEF ──',
'When you have gathered all evidence and completed your analysis,',
'your FINAL message must be a valid JSON object (no markdown, no code fences)',
'following this exact schema:',
JSON.stringify({
  headline: "string — one sentence conclusion",
  executive_summary: "string — one sentence with 1-2 key numbers",
  summary: "string — markdown narrative (the main answer)",
  metric_pills: [{ label: "string", value: "string", source: "string" }],
  data_lineage: [{ metric: "string", sql_ref: "string", row_count: 0, confidence: "high" }],
  tables: [{ title: "string", columns: ["string"], rows: [["value"]] }],
  charts: [{ type: "bar", title: "string", xKey: "string", yKey: "string", series: ["string"], data: [{}] }],
  key_findings: ["string"],
  implications: ["string"],
  caveats: ["string"],
  next_steps: ["string"],
  methodology_note: "string"
}, null, 2),
'CRITICAL: yKey must be a SINGLE column name. Multi-series goes in "series" array.',
'CRITICAL: metric_pills are NUMERIC KPIs only. Max 6 pills.',
'CRITICAL: Do not include debug logs, SQL text, or tool execution details in the brief.',
'',
```

#### Step 2：修改 Presentation 層的 Brief 取得方式

**檔案**：`src/services/agentResponsePresentationService.js` line 2288-2294（`synthesizeBrief` 呼叫處）

```javascript
// 現有：
const initialBrief = await synthesizeBrief({
  userMessage, answerContract, toolCalls, finalAnswerText, mode,
});

// 改為：先嘗試直接解析 finalAnswerText 為 JSON brief
let initialBrief;
try {
  const directBrief = JSON.parse(finalAnswerText);
  if (directBrief.headline && directBrief.summary) {
    // Agent 已直接輸出 JSON brief，跳過 synthesis LLM
    initialBrief = directBrief;
    console.info('[Presentation] Using direct JSON brief from agent (no synthesis LLM needed)');
  } else {
    throw new Error('Missing required fields');
  }
} catch {
  // Fallback: Agent 未輸出有效 JSON，走原流程
  console.info('[Presentation] Agent output is not valid JSON brief, falling back to synthesis LLM');
  initialBrief = await synthesizeBrief({
    userMessage, answerContract, toolCalls, finalAnswerText, mode,
  });
}
```

#### Step 3：保留向後相容

- `buildAgentBriefSynthesisPrompt()` 不刪除，作為 fallback
- 如果 Agent 輸出不是 valid JSON（例如舊 model 或 default mode），自動走原路徑
- 逐步觀察 JSON 直接輸出的成功率，當 > 90% 時可考慮移除 synthesis step

### 預期效果

- **消除數字轉換錯誤**：Agent 自己產生的數字不會被另一個 LLM 改錯
- **省 1 次 LLM 呼叫**：減少 3-5 秒延遲
- **caveats 不再遺漏**：Agent 在分析過程中自然累積 caveats
- **方法論公式完整保留**：不經過壓縮

### 風險

- Agent 可能不遵守 JSON 格式（需要 Failure Memory 記錄並學習）
- JSON 直接輸出可能比 synthesis 更大（token cost 略增）
- 建議先在 GPT-5.4-thinking 測試，確認 JSON 遵從率再推廣

---

## 12. [S3] QA 系統簡化 — 從 4-6 次 LLM 呼叫降到 2 次

### 為什麼需要

目前 complex tier 的 QA 流程：

```
1. synthesizeBrief           → LLM 呼叫 #1
2. computeDeterministicQa    → 無 LLM（規則引擎）
3. requestQaReview (self)    → LLM 呼叫 #2（Gemini）
4. requestQaReview (cross)   → LLM 呼叫 #3（Gemini，可能與 #2 parallel）
5. repairBrief               → LLM 呼叫 #4（如果 QA status=warning）
6. requestQaReview (repaired self)  → LLM 呼叫 #5
7. requestQaReview (repaired cross) → LLM 呼叫 #6
```

問題：
- 6 次 LLM 呼叫 ≈ 20-40 秒，用戶等太久
- 修復循環（repair cycle）效益有限——多數情況分數只提升 0.3-0.8
- Self-review 和 Cross-review 用同一個 model（Gemini）做兩次，冗餘
- 整個 QA 系統的 overhead 可能比 Agent 本身還慢

### 目標架構

```
1. computeDeterministicQa → 無 LLM（規則引擎）— 保留
2. requestQaReview (single fast model) → LLM 呼叫 #1
3. repairBrief (只在 score < 5.0 時) → LLM 呼叫 #2（條件性）
```

從 4-6 次降到 **1-2 次**。

### 修改方案

**檔案**：`src/services/agentResponsePresentationService.js` line 2315-2460

```javascript
// ── Complex tier: simplified pipeline ──

// Step 1: Brief (或直接用 agent JSON output — 見 S2)
const initialBrief = /* ... 同 S2 的邏輯 ... */;

// Step 2: Deterministic QA (保留，零 LLM 成本)
const deterministicQa = computeDeterministicQa({
  userMessage, answerContract, brief: initialBrief, toolCalls, finalAnswerText,
});

// Step 3: 單次 LLM review（合併 self + cross 為一次）
const singleReview = await requestQaReview({
  promptId: DI_PROMPT_IDS.AGENT_QA_SELF_REVIEW,
  stage: 'unified',
  userMessage, answerContract,
  brief: initialBrief,
  toolCalls, finalAnswerText,
  deterministicQa,
  artifactSummary,
  providerOverride: CROSS_MODEL_REVIEW_PROVIDER,
  modelOverride: CROSS_MODEL_REVIEW_MODEL,
});

const qa = mergeQaResults({
  deterministicQa,
  selfReview: singleReview,
  crossReview: null,  // 不再做 cross-review
  repairAttempted: false,
});

// Step 4: 條件性修復（只在嚴重問題時）
const needsRepair = qa.score < 5.0
  || (deterministicQa?.blockers || []).length > 0;

if (needsRepair && !isProviderCircuitOpen('gemini')) {
  const repairedBrief = await repairBrief({
    userMessage, answerContract, brief: initialBrief,
    toolCalls, finalAnswerText, mode,
    deterministicQa, qaScorecard: qa, artifactSummary,
  });
  const repairedDeterministicQa = computeDeterministicQa({
    userMessage, answerContract, brief: repairedBrief, toolCalls, finalAnswerText,
  });
  const repairedQa = mergeQaResults({
    deterministicQa: repairedDeterministicQa,
    selfReview: singleReview, // 不重新 review
    crossReview: null,
    repairAttempted: true,
  });
  return { brief: repairedBrief, trace: repairedDeterministicQa.trace, answerContract, review: buildCompatReview({ qa: repairedQa, deterministicQa: repairedDeterministicQa }), qa: repairedQa, skippedSteps: ['cross_review', 'repaired_review'] };
}

return {
  brief: initialBrief,
  trace: deterministicQa.trace,
  answerContract,
  review: buildCompatReview({ qa, deterministicQa }),
  qa,
  skippedSteps: ['cross_review', 'repair'],
};
```

### Repair 門檻調整

| 分數範圍 | 行為 | LLM 呼叫數 |
|----------|------|-----------|
| ≥ 8.0 | Pass，無修復 | 1 |
| 5.0 - 7.9 | Warning，但不修復（可加 UI 警告） | 1 |
| < 5.0 | 修復 + deterministic re-QA | 2 |
| Blockers | 強制修復 | 2 |

### 預期效果

- 多數分析從 6 次 LLM 呼叫 → 1 次（省 15-30 秒）
- 保留 deterministic QA 的全部檢查能力
- 只在真正需要時才觸發修復
- 整體用戶感知速度提升 50-70%

---

## 13. [S4] Optimizer 條件觸發 — 智慧判斷是否需要第二個 Agent

### 為什麼需要

目前的觸發條件（`DecisionSupportView/index.jsx` line 2494-2497）：

```javascript
const shouldEscalate = selectedCandidate?.status === 'completed'
  && (primaryQaScore < 8.0 || forceOptimizer)
  && !chatAbortRef.current?.signal?.aborted;
```

問題：`< 8.0` 的門檻太低——幾乎所有分析都會觸發 Optimizer。在 trace 中，Primary 得分 3.8，Optimizer 得分 3.0——Optimizer 反而更差。

Optimizer 的完整成本：
- Agent loop（DeepSeek Reasoner）：20-40 秒
- Presentation pipeline：再 15-30 秒
- Judge decision：5-10 秒
- **總計：40-80 秒的額外等待，多數時候沒有改善**

### 修改方案

**檔案**：`src/views/DecisionSupportView/index.jsx` line 2494-2497

```javascript
// 三級觸發邏輯取代二元判斷
const primaryQaScore = Number(selectedCandidate?.presentation?.qa?.score || 0);
const hasBlockers = (selectedCandidate?.presentation?.qa?.blockers || []).length > 0;
const hasCriticalFlags = selectedCandidate?.presentation?.qa?.flags?.contradictions
  || selectedCandidate?.presentation?.qa?.flags?.empty_evidence;

let escalationMode = 'none';

if (forceOptimizer) {
  escalationMode = 'full_optimizer';  // 用戶強制
} else if (primaryQaScore < 4.0 || hasBlockers) {
  escalationMode = 'full_optimizer';  // 嚴重問題，需要完整重做
} else if (primaryQaScore < 6.5 || hasCriticalFlags) {
  escalationMode = 'narrative_repair'; // 中等問題，只修文字
} else {
  escalationMode = 'none';  // 品質足夠
}

const shouldEscalate = escalationMode === 'full_optimizer'
  && selectedCandidate?.status === 'completed'
  && !chatAbortRef.current?.signal?.aborted;
```

### Narrative-Only Repair（新模式）

當 `escalationMode === 'narrative_repair'` 時，不啟動 Optimizer Agent，而是用快速 LLM 修復 brief：

```javascript
if (escalationMode === 'narrative_repair') {
  // 直接用現有 repairBrief 函式，不需要第二個 agent
  const repairedBrief = await repairBrief({
    userMessage: query,
    answerContract,
    brief: selectedCandidate.presentation.brief,
    toolCalls: selectedCandidate.result.toolCalls,
    finalAnswerText: selectedCandidate.result.finalAnswerText,
    mode: 'analysis',
    deterministicQa: selectedCandidate.presentation.qa.deterministicQa,
    qaScorecard: selectedCandidate.presentation.qa,
    artifactSummary: summarizeToolCallsForPrompt(selectedCandidate.result.toolCalls),
  });

  // 更新 brief 而不重跑整個 pipeline
  selectedCandidate.presentation.brief = repairedBrief;
  setStreamingContent(prev => prev + '\n✏️ Narrative refined based on QA feedback\n');
}
```

### 門檻對照表

| Primary QA Score | 行為 | 額外時間 |
|-----------------|------|---------|
| ≥ 6.5 | 直接使用，不觸發任何修復 | 0s |
| 4.0 - 6.4 | Narrative-only repair（快速 LLM 修文字） | 3-5s |
| < 4.0 或有 blockers | Full optimizer（完整第二 agent） | 40-80s |
| forceOptimizer | Full optimizer（用戶強制） | 40-80s |

### 預期效果

- 60-70% 的分析不再觸發 Optimizer（從 "幾乎每次" 到 "只有嚴重問題時"）
- 中等品質問題用 3-5 秒修文字取代 40-80 秒重做
- 用戶平均等待時間從 80-120 秒 → 30-50 秒

---

## 14. [S5] Streaming 體驗優化 — 先給用戶看結果，品質檢查背景執行

### 為什麼需要

目前用戶看到的時間線：

```
0s    ─ 用戶送出問題
5s    ─ Agent 開始思考（streaming 文字）
30s   ─ Agent 完成所有 tool calls + narrative
31s   ─ Brief Synthesis LLM 開始（用戶看到 spinner）
35s   ─ Brief 完成 → Deterministic QA 開始
36s   ─ Self-review LLM 開始
45s   ─ Cross-review LLM 開始
55s   ─ QA score < 8.0 → Repair LLM 開始
60s   ─ Repair 完成 → Re-QA
70s   ─ Optimizer Agent 開始
100s  ─ Optimizer 完成 → Judge
110s  ─ 用戶終於看到結果
```

ChatGPT 的時間線：
```
0s    ─ 用戶送出問題
2s    ─ 開始 streaming 回答
15s   ─ 完整回答顯示完畢
```

### 目標架構

```
0s    ─ 用戶送出問題
5s    ─ Agent 開始 streaming narrative
30s   ─ Agent 完成 → 立即顯示 brief（Agent 直接 JSON 或快速 synthesis）
31s   ─ 背景啟動 QA + 條件性 Optimizer
60s   ─ 如果品質有問題，顯示小通知 "Analysis quality updated ✓"
      ─ 如果品質 OK，不干擾用戶
```

### 修改方案

#### Step 1：拆分 Presentation 為「即時」和「背景」兩階段

**檔案**：`src/services/agentResponsePresentationService.js`

新增一個輕量函式：

```javascript
/**
 * Immediate presentation: brief only, no QA.
 * Returns in < 5 seconds for instant user feedback.
 */
export async function buildImmediatePresentation({
  userMessage, answerContract, toolCalls, finalAnswerText, mode,
  agentProvider, agentModel, complexityTier = 'complex',
}) {
  const ac = answerContract
    ? normalizeAnswerContract(answerContract, userMessage, mode)
    : await deriveAnswerContract({ userMessage, mode });

  // 嘗試直接解析 JSON brief（見 S2）
  let brief;
  try {
    const parsed = JSON.parse(finalAnswerText);
    if (parsed.headline && parsed.summary) {
      brief = parsed;
    } else {
      throw new Error('not a brief');
    }
  } catch {
    brief = await synthesizeBrief({ userMessage, answerContract: ac, toolCalls, finalAnswerText, mode });
  }

  return {
    brief,
    answerContract: ac,
    qa: { status: 'pending', score: null, message: 'Quality check in progress...' },
  };
}

/**
 * Background QA: runs after user has already seen the brief.
 * Returns updated QA result for optional UI update.
 */
export async function runBackgroundQa({
  userMessage, answerContract, brief, toolCalls, finalAnswerText, mode,
  agentProvider, agentModel,
}) {
  const deterministicQa = computeDeterministicQa({
    userMessage, answerContract, brief, toolCalls, finalAnswerText,
  });

  const review = await requestQaReview({
    stage: 'unified',
    userMessage, answerContract, brief, toolCalls, finalAnswerText,
    deterministicQa,
    artifactSummary: summarizeArtifacts(toolCalls),
    providerOverride: CROSS_MODEL_REVIEW_PROVIDER,
    modelOverride: CROSS_MODEL_REVIEW_MODEL,
  });

  return mergeQaResults({
    deterministicQa,
    selfReview: review,
    crossReview: null,
    repairAttempted: false,
  });
}
```

#### Step 2：修改 DecisionSupportView 的流程

**檔案**：`src/views/DecisionSupportView/index.jsx` — `runSettledCandidatePass` 附近

```javascript
// 現有：等 presentation pipeline 全部完成才顯示
// const presentation = await buildAgentPresentationPayload({ ... });

// 改為：先顯示 brief，再背景 QA
const immediate = await buildImmediatePresentation({
  userMessage: query, answerContract, toolCalls: agentResult.toolCalls,
  finalAnswerText: agentResult.finalAnswerText, mode: 'analysis',
});

// 立即更新 UI — 用戶可以開始閱讀
setCurrentPresentation(immediate);

// 背景 QA（不 block UI）
runBackgroundQa({
  userMessage: query, answerContract, brief: immediate.brief,
  toolCalls: agentResult.toolCalls, finalAnswerText: agentResult.finalAnswerText,
  mode: 'analysis',
}).then(qa => {
  // 更新 QA 狀態
  setCurrentPresentation(prev => ({
    ...prev,
    qa,
    review: buildCompatReview({ qa, deterministicQa: qa.deterministicQa }),
  }));

  // 如果品質有問題，顯示通知
  if (qa.score < 6.5) {
    showQaNotification(`Quality score: ${qa.score.toFixed(1)}/10 — some findings may need verification`);
  }

  // 條件性觸發 Optimizer（見 S4 的三級邏輯）
  if (qa.score < 4.0) {
    // 啟動 optimizer...
  }
}).catch(err => {
  console.warn('[BackgroundQA] Failed:', err);
  // QA 失敗不影響已顯示的結果
});
```

#### Step 3：UI 通知組件

在 `DecisionSupportView` 中加入一個小型通知元素：

```jsx
{presentation?.qa?.status === 'pending' && (
  <div className="text-xs text-gray-400 animate-pulse">
    Quality check in progress...
  </div>
)}
{presentation?.qa?.status === 'pass' && presentation?.qa?.score >= 6.5 && (
  <div className="text-xs text-green-500">
    ✓ Quality verified ({presentation.qa.score.toFixed(1)}/10)
  </div>
)}
{presentation?.qa?.status !== 'pending' && presentation?.qa?.score < 6.5 && (
  <div className="text-xs text-amber-500">
    ⚠ Quality: {presentation.qa.score.toFixed(1)}/10 — treat with caution
  </div>
)}
```

### 預期效果

- 用戶看到結果的時間：從 60-110 秒 → **30-35 秒**
- QA 在背景完成，不影響用戶閱讀體驗
- 品質問題以非阻塞方式通知
- 體驗接近 ChatGPT 的即時回應感

---

# 實施順序建議

## 第一波（1-2 天）— 立即見效

| 序號 | 項目 | 預估時間 | 效果 |
|------|------|---------|------|
| 1 | [P0-1] CORS 修復 | 30 min | 消除 15-30s 浪費 |
| 2 | [P0-2] AlertTriangle | 5 min | 消除 console error |
| 4 | [P1-2] yKey auto-fix | 15 min | 圖表正確渲染 |
| 8 | [P2-2] JSON 第 4 層 fallback | 15 min | Dashboard 不再白屏 |

## 第二波（3-5 天）— 核心品質提升

| 序號 | 項目 | 預估時間 | 效果 |
|------|------|---------|------|
| 10 | [S1] Sandbox 擴展 | 2 hr | 解鎖 statsmodels/sklearn |
| 11 | [S2] 直接 JSON brief | 4 hr | 消除數字轉換錯 |
| 3 | [P1-1] Failure Memory | 3 hr | Agent 學習避錯 |
| 7 | [P2-1] Repair review provider | 10 min | 修復 timeout |

## 第三波（1 週）— 速度革命

| 序號 | 項目 | 預估時間 | 效果 |
|------|------|---------|------|
| 12 | [S3] QA 簡化 | 4 hr | 省 4-5 次 LLM 呼叫 |
| 13 | [S4] Optimizer 條件觸發 | 3 hr | 省 40-80s/次 |
| 14 | [S5] Streaming 體驗 | 6 hr | 用戶 30s 內看到結果 |

## 第四波（收尾）

| 序號 | 項目 | 預估時間 | 效果 |
|------|------|---------|------|
| 5 | [P1-3] Optimizer SQL dedup | 1 hr | 消除重複查詢 |
| 6 | [P1-4] Judge 降級 UI | 1 hr | 品質警告可見 |
| 9 | [P2-3] Dimension imputation | 1 hr | QA 分數更準 |

---

# 預期整體效果

| 指標 | 修復前 | Bug Fix 後 | 結構改進後 |
|------|--------|-----------|-----------|
| 回應時間 | 60-110s | 50-90s | **30-35s** |
| 數字準確率 | ~60% | ~75% | **~95%** |
| 圖表渲染率 | ~50% | ~80% | **~90%** |
| 統計分析能力 | 基礎 pandas | 基礎 pandas | **statsmodels + sklearn** |
| LLM 呼叫次數/分析 | 10-15 | 8-12 | **4-6** |
| 與 ChatGPT 品質對比 | ~30% | ~50-60% | **~80-85%** |

---

> ⚠️ 本文件為修改方案，**不包含實際程式碼修改**。所有檔案路徑和行號基於 2026-03-24 版本。
