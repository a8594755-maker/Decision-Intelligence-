# DI Round 7 修復指南

## 前情提要：你之前修的東西都有效

| 修復項 | 狀態 | 驗證結果 |
|--------|------|----------|
| `parseNumericValue` K/M/B (line 973-983) | ✅ 已修 | K/M/B suffix 正確解析 |
| `formatPillValue` 日期守衛 (line 427) | ✅ 已修 | 日期字串不再被 parseFloat |
| `detectMagnitudeMismatches` SUM/AVG (line 1404-1443) | ✅ 已修 | 加總和平均都有比對 |
| `buildJudgeRecoveryAttempts` 刪除 Anthropic fallback | ✅ 已修 | recovery 不再跳 provider |
| `getPromptProvider` / `getPromptDefaultModel` 讀 modelConfig | ✅ 已修 | router 層正確 |
| `normalizeBrief` 套用 `cleanFloatingPointInText` | ✅ 已修 | 所有文字欄位都有清理 |

**問題是：修好了 router，但 caller 繞過了 router。** 以下是剩餘的 3 個 bug。

---

## Fix 1（P0）：QA/Repair 呼叫硬編碼 Anthropic，繞過 Model Config

### 問題

`agentResponsePresentationService.js` 第 118-119 行：

```javascript
const CROSS_MODEL_REVIEW_PROVIDER = import.meta.env.VITE_DI_AGENT_QA_REVIEW_PROVIDER || 'anthropic';
const CROSS_MODEL_REVIEW_MODEL = import.meta.env.VITE_DI_AGENT_QA_REVIEW_MODEL || 'claude-sonnet-4-6';
```

這兩個常量被直接當作 `providerOverride` / `modelOverride` 傳給 `runDiPrompt`，**完全繞過**你在 `diModelRouterService.js` 修好的 `getPromptProvider` / `getPromptDefaultModel`。

受影響的呼叫點（全部傳 `providerOverride: CROSS_MODEL_REVIEW_PROVIDER`）：

| 行號 | 函數 | 用途 |
|------|------|------|
| 2960-2961 | `buildAgentPresentationPayload` | QA review |
| 2698-2699 | `repairBrief` | Repair synthesis |
| 3088-3089 | `computeQaForBrief`（optimizer 用） | Optimizer QA review |
| 2949, 2965, 2978, 3077 | circuit breaker 判斷 | 決定是否跳過 QA |

### 修法

**步驟 1：刪除第 118-119 行的兩個常量**，替換為讀取 modelConfig 的函數：

```javascript
// ---- 刪除這兩行 ----
// const CROSS_MODEL_REVIEW_PROVIDER = import.meta.env.VITE_DI_AGENT_QA_REVIEW_PROVIDER || 'anthropic';
// const CROSS_MODEL_REVIEW_MODEL = import.meta.env.VITE_DI_AGENT_QA_REVIEW_MODEL || 'claude-sonnet-4-6';

// ---- 替換為 ----
import { getModelConfig } from './modelConfigService.js';

function getCrossModelReviewConfig() {
  const envProvider = import.meta.env.VITE_DI_AGENT_QA_REVIEW_PROVIDER;
  const envModel = import.meta.env.VITE_DI_AGENT_QA_REVIEW_MODEL;
  if (envProvider && envModel) return { provider: envProvider, model: envModel };
  // 沒有環境變數 → 讀 Model Config 的 judge 角色設定
  const cfg = getModelConfig('judge');
  return { provider: cfg.provider, model: cfg.model };
}
```

> 注意：如果 `modelConfigService.js` 已經在此檔案中被 import，就不需要重複 import。搜尋檔案頂部確認。

**步驟 2：全文取代所有引用點**

用 IDE 的 Find & Replace：

| 搜尋 | 替換為 |
|------|--------|
| `CROSS_MODEL_REVIEW_PROVIDER` | `getCrossModelReviewConfig().provider` |
| `CROSS_MODEL_REVIEW_MODEL` | `getCrossModelReviewConfig().model` |

受影響行號：2949, 2960, 2961, 2965, 2698, 2699, 2978, 3077, 3088, 3089, 2640, 2641

**步驟 2 效能優化（建議）：** 為避免重複呼叫 `getCrossModelReviewConfig()`，在每個函數入口處解構一次：

```javascript
// 例如在 buildAgentPresentationPayload 函數開頭：
const { provider: reviewProvider, model: reviewModel } = getCrossModelReviewConfig();
// 然後在函數內用 reviewProvider / reviewModel
```

需要加在以下 3 個函數的開頭：
- `buildAgentPresentationPayload`（約 line 2880 附近）
- `repairBrief`（line 2664）
- `computeQaForBrief`（約 line 3069）

然後在這 3 個函數內部：
- `providerOverride: CROSS_MODEL_REVIEW_PROVIDER` → `providerOverride: reviewProvider`
- `modelOverride: CROSS_MODEL_REVIEW_MODEL` → `modelOverride: reviewModel`
- `isProviderCircuitOpen(CROSS_MODEL_REVIEW_PROVIDER)` → `isProviderCircuitOpen(reviewProvider)`

### 驗證

修完後跑任意分析，console 不應出現任何 `callAnthropicPrompt` 呼叫（除非你的 Model Config judge 本來就設 anthropic）。搜尋 console：
- ❌ 不應出現：`POST .../ai-proxy 400 (Bad Request)`
- ❌ 不應出現：`prefill`
- ✅ 應出現：`[diModelRouter] OpenAI via Edge Function OK`（QA review 和 repair）

---

## Fix 2（P0）：Pill Evidence 比對不認 K/M/B，導致 Evidence 分數被錯殺

### 問題

`agentResponsePresentationService.js` 第 1531-1537 行，`collectContradictoryClaims` 上方的 pill evidence matching：

```javascript
// 目前的寫法（line 1534-1536）：
const numMatch = rawVal.match(/([\d,.]+)/);
if (!numMatch) continue;
const pillNum = parseFloat(numMatch[1].replace(/,/g, ''));
```

對 pill `"R$4.53M"`：
- regex 抓到 `"4.53"`
- parseFloat → `4.53`
- 拿 `4.53` 和 SQL 的 `4,530,547` 比對 → ratio = 0.000001 → **no match**
- 結果：`"Metric pill '整體年平均營收: R$4.53M' has no matching value (±5%) in tool call evidence"`

### 修法

把第 1534-1536 行替換為使用已修好的 `parseNumericValue`：

```javascript
// ---- 刪除 ----
// const numMatch = rawVal.match(/([\d,.]+)/);
// if (!numMatch) continue;
// const pillNum = parseFloat(numMatch[1].replace(/,/g, ''));

// ---- 替換為 ----
const pillNum = parseNumericValue(rawVal);
if (pillNum == null || pillNum === 0) continue;
```

就這樣，3 行換 2 行。`parseNumericValue` 已經有 K/M/B 處理。

### 驗證

修完後，pill `"R$4.53M"` 應被解析為 `4,530,000`，和 SQL 的 `4,530,547` 比對 ratio = 0.9999 → 在 5% tolerance 內 → **match**。

Evidence 分數應從 2.0 提升到 8.0+。

---

## Fix 3（P1）：中文標籤的矛盾偵測 — 空格切詞失效

### 問題

`collectContradictoryClaims` 第 1586-1593 行的 dedup 邏輯：

```javascript
const wordsA = new Set(descA.split(/\s+/).filter(Boolean));
const wordsB = new Set(descB.split(/\s+/).filter(Boolean));
const uniqueA = [...wordsA].filter((w) => !wordsB.has(w));
const uniqueB = [...wordsB].filter((w) => !wordsA.has(w));
if (uniqueA.length >= 2 || uniqueB.length >= 2) continue;
```

對英文有效：`"Revenue Std Dev"` vs `"Sales Volume Std Dev"` → 3 個 / 4 個 word → 能比對 unique words。

對中文失效：`"整體年平均營收"` vs `"平均月營收"` → split 後各只有 **1 個 token**（中文沒空格）→ `uniqueA.length = 1, uniqueB.length = 1` → 都 < 2 → **不跳過** → 被錯誤標記為矛盾。

結果：「整體年平均營收 R$4.53M」和「平均月營收 R$543.67K」被認為是同一指標的矛盾值 → correctness = 0。

### 修法

在第 1586 行之前，加入 CJK 字符級切分：

```javascript
// ---- 在 if (descA && descB) { 之後，wordsA 定義之前加入 ----

// CJK-aware tokenization: split on individual characters for CJK text
const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf\uF900-\uFAFF]/;
const tokenize = (s) => {
  const tokens = [];
  for (const part of s.split(/\s+/).filter(Boolean)) {
    if (CJK_RANGE.test(part)) {
      // Split CJK into individual characters as tokens
      tokens.push(...[...part].filter(ch => CJK_RANGE.test(ch)));
    } else {
      tokens.push(part);
    }
  }
  return tokens;
};

// ---- 然後把原本的兩行替換 ----
// const wordsA = new Set(descA.split(/\s+/).filter(Boolean));
// const wordsB = new Set(descB.split(/\s+/).filter(Boolean));
const wordsA = new Set(tokenize(descA));
const wordsB = new Set(tokenize(descB));
```

修完後：
- `"整體年平均營收"` → tokens: `["整", "體", "年", "平", "均", "營", "收"]`
- `"平均月營收"` → tokens: `["平", "均", "月", "營", "收"]`
- uniqueA = `["整", "體", "年"]` → length = 3 ≥ 2 → **跳過，不標記矛盾** ✅

### 驗證

修完後，correctness 分數不應因為「年平均 vs 月平均」這類不同口徑的指標而被錯殺為 0。

---

## 修復順序與預估時間

| 順序 | Fix | 影響 | 時間 |
|------|-----|------|------|
| 1 | Fix 1（CROSS_MODEL_REVIEW → modelConfig） | QA + Repair 完全失效 → 恢復運作 | 10 分鐘 |
| 2 | Fix 2（pill evidence 用 parseNumericValue） | Evidence = 2.0 → 8.0+ | 2 分鐘 |
| 3 | Fix 3（CJK tokenization） | Correctness 假陽性消除 | 5 分鐘 |

**總計：約 17 分鐘，改完跑同一題立刻驗證。**

---

## 修完後的預期結果

| 指標 | 修前 | 修後預期 |
|------|------|----------|
| Claude 400 錯誤 | 8 次 | 0 次 |
| Correctness | 0.0 | 7.0+ |
| Evidence | 2.0 | 8.0+ |
| QA Score | 6.2（僅 deterministic） | 7.5+（deterministic + LLM review） |
| Repair 可用 | ❌ 全部 fallback | ✅ 正常執行 |
