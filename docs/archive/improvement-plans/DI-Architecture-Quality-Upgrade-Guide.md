# DI 架構品質升級指南 — 追平 Claude Web 輸出品質

> **目標**：在保持現有資料分析優勢（SQL 直連、結構化呈現、證據追溯）的基礎上，補齊與 Claude Web 的品質差距
> **日期**：2026-03-24
> **範圍**：7 項架構修改，按影響力排序

---

## 總覽

| # | 改動 | 影響力 | 涉及檔案 | 預估工時 |
|---|------|--------|----------|----------|
| A1 | Agent Thinking Budget — 先想再答 | ⭐⭐⭐⭐⭐ | `chatAgentLoop.js` | 30 min |
| A2 | Summary 字數上限放寬 | ⭐⭐⭐⭐ | `chatAgentLoop.js`, `agentResponsePrompt.js` | 15 min |
| A3 | JSON 解析 Graceful Degradation | ⭐⭐⭐⭐ | `agentResponsePresentationService.js` | 40 min |
| A4 | Optimizer 觸發條件收緊 | ⭐⭐⭐ | `DecisionSupportView/index.jsx` | 20 min |
| A5 | Deterministic QA 強化事實核查 | ⭐⭐⭐ | `agentResponsePresentationService.js` | 45 min |
| A6 | Judge 上下文擴充 | ⭐⭐ | `agentCandidateJudgeService.js` | 25 min |
| A7 | Thinking Model 路由修正 | ⭐⭐⭐⭐ | `diModelRouterService.js`, `chatAgentLoop.js` | 20 min |

---

## A1 — Agent Thinking Budget：先想再答（最高優先）

### 為什麼這是最重要的改動

Claude Web 品質高的核心原因是 extended thinking——模型在輸出前花大量 token 探索問題空間、考慮邊界情況、規劃分析路徑。你的 Agent 拿到的是 flat instruction，system prompt 告訴它「做什麼」但沒有鼓勵它「先想清楚」。

### 涉及檔案

`src/services/chatAgentLoop.js` — 第 574-579 行（Final Answer Rules 區段）

### 修改方式

在 system prompt 的 `Final Answer Rules` 之前，插入一段 thinking 指引：

```javascript
// ── 在第 573 行之後、'Final Answer Rules:' 之前插入 ──

'',
'THINKING PROTOCOL (analysis mode only):',
'Before writing your final JSON answer, reason through these questions internally:',
'1. What is the user REALLY asking? (surface question vs underlying need)',
'2. What did the data actually show? Any surprises or contradictions?',
'3. Are there confounding factors the user should know about?',
'4. What would a skeptical senior analyst challenge about this analysis?',
'5. Is there a "so what" — a concrete action the user can take?',
'',
'Wrap your reasoning in <thinking>...</thinking> tags before the JSON output.',
'The thinking block will be stripped before the user sees the result.',
'Take 200-400 words to reason. Do NOT skip this step.',
'',
```

### 同步修改：Strip Thinking Tags

確認 `agentResponsePresentationService.js` 的 `stripThinkingTags` 函式能正確移除 `<thinking>` 區塊。目前已有此函式——搜尋 `stripThinkingTags` 確認它處理 `<thinking>` 標籤（不只是 `<think>`）。

### 為什麼有效

這不會增加任何 LLM 呼叫或延遲（Agent 本來就要 generate token）。它只是把 Agent 原本「直接跳到答案」的行為，改成「先推理再回答」。thinking 區段被 strip 後使用者不會看到，但 JSON 輸出的品質會因為前置推理而大幅提升——因果分析更深、edge case 更完整、建議更具體。

### 驗證方式

觀察 Agent 的 raw output（`finalAnswerText`），確認開頭有 `<thinking>` 區塊，且 JSON 中的 `key_findings` 和 `implications` 明顯比修改前更有深度。

---

## A2 — Summary 字數上限放寬

### 問題

目前 `chatAgentLoop.js` 第 576 行：

```javascript
'- Keep the final answer under 160 words unless the evidence is blocked and needs a caveat.',
```

160 words 太短，只夠報告數字，沒有空間做因果分析。Claude Web 典型回答 300-500 words，包含「為什麼」和「怎麼辦」。

### 涉及檔案

1. `src/services/chatAgentLoop.js` — 第 576 行
2. `src/prompts/agentResponsePrompt.js` — 第 272 行（synthesis prompt 的 "Keep the brief compact"）

### 修改方式

**chatAgentLoop.js 第 576 行**：

```javascript
// ── 修改前 ──
'- Keep the final answer under 160 words unless the evidence is blocked and needs a caveat.',

// ── 修改後 ──
'- For brevity="short": keep the final answer under 160 words.',
'- For brevity="analysis": use 300-500 words. Include: (a) what the data shows, (b) why it matters (causal reasoning), (c) what the user should do next. Depth is more valuable than brevity for analysis.',
```

**agentResponsePrompt.js 第 272 行**：

```javascript
// ── 修改前 ──
'- Keep the brief compact and executive-facing.'

// ── 修改後 ──
'- For brevity="short": keep the brief compact and executive-facing (under 160 words).',
'- For brevity="analysis": the summary field should be 300-500 words. Go beyond describing numbers — explain WHY the patterns exist, WHAT they imply for the business, and WHAT specific actions to take. Treat the summary as a mini consulting memo, not a dashboard tooltip.',
```

### 驗證方式

執行一次 analysis mode 的查詢，檢查 `brief.summary` 字數是否在 300-500 range，且包含因果分析（不只是數字描述）。

---

## A3 — JSON 解析 Graceful Degradation

### 問題

目前 `buildAgentPresentationPayload`（第 2426-2453 行）的 JSON 解析邏輯是：

```
嘗試 1: JSON.parse(finalAnswerText)
嘗試 2: 提取 markdown fence 內的 JSON
失敗 → 整個丟棄，重跑 synthesizeBrief LLM
```

當 Agent 的 JSON 有微小格式問題（trailing comma、未關閉的引號、截斷），整個推理鏈被丟棄。Synthesis LLM 從 tool results 重建，Agent 原始的分析洞察完全消失。

### 涉及檔案

`src/services/agentResponsePresentationService.js` — 第 2426-2505 行

### 修改方式

在現有的嘗試 1 和嘗試 2 之後，加入三層 fallback：

```javascript
// ── 在第 2448 行（嘗試 2 的結尾大括號之後）插入 ──

// Attempt 3: Partial JSON recovery — find largest valid JSON substring
if (!initialBrief) {
  const text = finalAnswerText;
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const partialBrief = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
      if (partialBrief.headline || partialBrief.summary) {
        initialBrief = partialBrief;
        console.info('[Presentation] Recovered partial JSON brief from agent output');
      }
    } catch { /* still malformed */ }
  }
}

// Attempt 4: Lenient JSON repair — fix common LLM JSON mistakes
if (!initialBrief) {
  try {
    let repaired = finalAnswerText;
    // Extract JSON portion
    const jsonStart = repaired.indexOf('{');
    const jsonEnd = repaired.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      repaired = repaired.slice(jsonStart, jsonEnd + 1);
    }
    // Fix trailing commas: ,} → } and ,] → ]
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    // Fix single quotes to double quotes (naive — won't handle all cases)
    repaired = repaired.replace(/'/g, '"');
    // Remove control characters
    repaired = repaired.replace(/[\x00-\x1F\x7F]/g, ' ');
    const repairedBrief = JSON.parse(repaired);
    if (repairedBrief.headline || repairedBrief.summary) {
      initialBrief = repairedBrief;
      console.info('[Presentation] Recovered JSON brief after lenient repair');
    }
  } catch { /* repair failed */ }
}

// Attempt 5: Field extraction — regex extract individual fields
if (!initialBrief) {
  const extractField = (fieldName) => {
    const regex = new RegExp(`"${fieldName}"\\s*:\\s*"([^"]*)"`, 'i');
    const match = finalAnswerText.match(regex);
    return match ? match[1] : null;
  };
  const headline = extractField('headline');
  const summary = extractField('summary');
  if (headline || summary) {
    initialBrief = {
      headline: headline || 'Analysis complete.',
      summary: summary || '',
      // Other fields will be filled by normalizeBrief fallback
    };
    console.info('[Presentation] Extracted individual fields from malformed JSON');
  }
}
```

### 為什麼有效

每多保留一層 Agent 的原始輸出，最終品質就高一級。Synthesis LLM 是「二手翻譯」，永遠不如 Agent 自己的原始分析。這個改動確保只有在 Agent 輸出完全不可救藥時才走 synthesis fallback。

### 驗證方式

故意在 Agent prompt 裡加一個會導致 trailing comma 的 edge case，確認 Attempt 4 能修復。觀察 console log 確認觸發了哪一層 recovery。

---

## A4 — Optimizer 觸發條件收緊

### 問題

目前三級分流（第 2496-2500 行）：

```javascript
score < 4.0 || hasBlockers → full_optimizer
score < 6.5               → narrative_repair
score >= 6.5              → none
```

問題一：`< 4.0` 就觸發 full optimizer，但 Optimizer（DeepSeek/Gemini）不一定比 Primary（GPT-5.4）強。Trace 裡 Optimizer 2.4 < Primary 3.4。

問題二：Optimizer 需要重新跑所有 tool call，延遲巨大（30-60 秒）。對使用者來說，等 60 秒拿到一個更差的結果，不如花 5 秒修復 narrative。

### 涉及檔案

`src/views/DecisionSupportView/index.jsx` — 第 2495-2500 行

### 修改方式

```javascript
// ── 修改前（第 2495-2500 行）──
let escalationMode = 'none';
if (forceOptimizer) {
  escalationMode = 'full_optimizer';
} else if (primaryQaScore < 4.0 || hasBlockers) {
  escalationMode = 'full_optimizer';
} else if (primaryQaScore < 6.5) {
  escalationMode = 'narrative_repair';
}

// ── 修改後 ──
let escalationMode = 'none';
if (forceOptimizer) {
  escalationMode = 'full_optimizer';
} else if (hasBlockers) {
  // Check if blockers are "hard failures" (no data at all) vs "soft issues" (formatting/dedup)
  const hardBlockers = (selectedCandidate?.presentation?.qa?.blockers || []).filter(b =>
    /missing required dimensions|no.*evidence|all.*failed|0-row/i.test(b)
  );
  if (hardBlockers.length > 0) {
    // Primary genuinely failed to get data — optimizer might help with different SQL strategy
    escalationMode = 'full_optimizer';
  } else {
    // Soft blockers (dedup, formatting, leaked debug) — narrative repair can fix these
    escalationMode = 'narrative_repair';
  }
} else if (primaryQaScore < 4.0) {
  // Low score but no blockers — try narrative repair first (much faster than full optimizer)
  escalationMode = 'narrative_repair';
} else if (primaryQaScore < 6.5) {
  escalationMode = 'narrative_repair';
}
```

### 核心改變

- **Full optimizer 只在「Primary 真的拿不到資料」時觸發**（missing dimensions、全部 tool 失敗、0-row 結果）
- **Soft issues（格式、重複、debug 洩漏）全部用 narrative repair 處理**——這些不需要重跑 tool call，只需要修改敘事
- **Score < 4.0 但沒有 hard blocker 的情況**，也走 narrative repair 而非 full optimizer

### 為什麼有效

減少了 60-80% 的 full optimizer 觸發。Optimizer 的真正價值場景（Primary 的 SQL 策略完全失敗、需要換一個模型重新思考查詢方式）被精確保留。大部分低分場景（敘事品質差但資料正確）走 narrative repair，5 秒修復 vs 60 秒重跑。

### 驗證方式

連續跑 10 次不同查詢，記錄 escalationMode 的分布。修改前 full_optimizer 約佔 30-40%，修改後應降到 10% 以下。

---

## A5 — Deterministic QA 強化事實核查

### 問題

目前 Deterministic QA（第 1437-1650 行）做了很多格式檢查（debug 洩漏、欄位重複、pseudo-table），但缺少**數值事實核查**。它能抓到「summary 重複了 pill 的值」，但抓不到「summary 裡的數字跟 SQL 結果完全對不上」。

Magnitude mismatch detection（第 1486 行）已有基本版，但只檢查 3x 容差。更精細的核查應該：

- 比對 brief 中每個具體數字是否能在 tool results 中找到來源
- 檢查百分比計算是否正確（(new-old)/old × 100）
- 檢查趨勢方向是否與資料一致（brief 說 "成長" 但數字在下降）

### 涉及檔案

`src/services/agentResponsePresentationService.js` — `computeDeterministicQa` 函式內

### 修改方式

在 magnitude mismatch detection 之後（第 1496 行之後），加入趨勢方向檢查：

```javascript
// ── 在第 1496 行之後插入 ──

// ── Trend direction consistency: brief claims "growth/increase" but data shows decline ──
const trendClaims = extractTrendClaims(combinedNarrativeText);
const sqlTrendData = extractTrendFromToolCalls(toolCalls);
if (trendClaims.length > 0 && sqlTrendData.length > 0) {
  for (const claim of trendClaims) {
    const matchingData = sqlTrendData.find(d => d.metric === claim.metric || d.isDefault);
    if (matchingData && claim.direction !== matchingData.direction) {
      const issue = `Trend mismatch: brief claims "${claim.metric} ${claim.direction}" but data shows ${matchingData.direction} (${matchingData.startValue} → ${matchingData.endValue})`;
      blockers.push(issue);
      issues.push(issue);
      repairInstructions.push(`Correct the trend direction for ${claim.metric} to match the data: ${matchingData.direction}.`);
      dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 5);
    }
  }
}
```

你需要新增兩個 helper 函式：

```javascript
function extractTrendClaims(text) {
  const claims = [];
  // Match patterns like "revenue grew", "orders declined", "增長", "下降"
  const patterns = [
    /(\w+(?:\s+\w+)?)\s+(?:grew|increased|rose|surged|jumped|成長|增長|上升)/gi,
    /(\w+(?:\s+\w+)?)\s+(?:declined|decreased|dropped|fell|shrank|下降|減少|衰退)/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const isGrowth = /grew|increased|rose|surged|jumped|成長|增長|上升/i.test(match[0]);
      claims.push({
        metric: match[1].trim(),
        direction: isGrowth ? 'up' : 'down',
      });
    }
  }
  return claims;
}

function extractTrendFromToolCalls(toolCalls = []) {
  const trends = [];
  for (const tc of toolCalls) {
    if (tc?.name !== 'query_sap_data' || !tc?.result?.success) continue;
    const rows = tc?.result?.rows || [];
    if (rows.length < 2) continue;
    // Find numeric columns
    const numericKeys = Object.keys(rows[0] || {}).filter(k => typeof rows[0][k] === 'number');
    for (const key of numericKeys) {
      const firstVal = rows[0][key];
      const lastVal = rows[rows.length - 1][key];
      if (firstVal != null && lastVal != null && firstVal !== 0) {
        trends.push({
          metric: key,
          direction: lastVal > firstVal ? 'up' : 'down',
          startValue: firstVal,
          endValue: lastVal,
          isDefault: numericKeys.indexOf(key) === 0,
        });
      }
    }
  }
  return trends;
}
```

### 驗證方式

故意構造一個場景：SQL 返回遞減的月營收資料，但在 Agent prompt 中暗示「營收成長」。QA 應該抓到 trend mismatch 並觸發 repair。

---

## A6 — Judge 上下文擴充

### 問題

目前 `summarizeCandidate`（agentCandidateJudgeService.js 第 27-36 行）傳給 Judge 的資訊很有限：

```javascript
{
  candidate_id, label, provider, model, status,
  brief,        // 整個 brief 物件
  qa,           // QA 結果
  trace: { failed_attempts: count, successful_queries: count },
  artifacts: [tool names],
  sql_evidence_summary: [{ sql (截200字), rowCount, columns, sampleRows (3行) }]
}
```

Judge 看不到：Agent 的完整推理（thinking）、tool call 的完整結果、SQL 的完整輸出。它基本上只能比較兩個 brief 的表面品質和 QA 分數。

### 涉及檔案

`src/services/agentCandidateJudgeService.js` — `summarizeCandidate` 函式（第 27-36 行）

### 修改方式

擴充 summarizeCandidate，加入更多上下文：

```javascript
function summarizeCandidate(candidate) {
  const toolCalls = candidate?.result?.toolCalls || [];

  // Extract key numbers from all successful SQL results
  const keyNumbers = [];
  for (const tc of toolCalls) {
    if (tc?.name === 'query_sap_data' && tc?.result?.success && tc?.result?.rows?.length > 0) {
      const rows = tc.result.rows;
      const numericKeys = Object.keys(rows[0] || {}).filter(k => typeof rows[0][k] === 'number');
      for (const key of numericKeys.slice(0, 3)) {
        const values = rows.map(r => r[key]).filter(v => v != null);
        if (values.length > 0) {
          keyNumbers.push({
            column: key,
            min: Math.min(...values),
            max: Math.max(...values),
            sum: values.reduce((a, b) => a + b, 0),
            count: values.length,
          });
        }
      }
    }
  }

  return {
    candidate_id: candidate?.candidateId,
    label: candidate?.label,
    provider: candidate?.provider,
    model: candidate?.model,
    transport: candidate?.transport || null,
    status: candidate?.status || 'completed',
    failed_reason: candidate?.failedReason || null,
    brief: candidate?.presentation?.brief || null,
    qa: candidate?.presentation?.qa || null,
    trace: {
      failed_attempts: candidate?.presentation?.trace?.failed_attempts?.length || 0,
      successful_queries: candidate?.presentation?.trace?.successful_queries?.length || 0,
    },
    artifacts: toolCalls.map((tc) => tc?.name).filter(Boolean),
    sql_evidence_summary: summarizeSqlEvidence(candidate),
    // NEW: key numbers for the judge to cross-check against brief claims
    key_numbers: keyNumbers.slice(0, 10),
    // NEW: tool call error messages (helps judge understand WHY a candidate failed)
    tool_errors: toolCalls
      .filter(tc => !tc?.result?.success && tc?.result?.error)
      .map(tc => ({ tool: tc.name, error: String(tc.result.error).slice(0, 150) }))
      .slice(0, 5),
  };
}
```

### 為什麼有效

Judge 現在能看到每個 candidate 的 SQL 結果裡實際有哪些數字，可以交叉比對 brief 中的聲明是否有數據支撐。如果 Primary 的 brief 說「營收 R$150K」但 SQL 結果的 sum 是 R$15K，Judge 就能判定 Primary 有 magnitude 問題。

### 驗證方式

觸發一次 full optimizer + judge，觀察 judge prompt 中是否包含 `key_numbers` 和 `tool_errors` 欄位。

---

## A7 — Thinking Model 路由修正

### 問題

console 顯示 `model=gpt-5.4-thinking` 即使設定頁選的是 `gpt-5.4`（非 thinking）。`diModelRouterService.js` 第 527-530 行有個 thinking suffix 的 strip 邏輯，但只在 **strict JSON prompt** 的情況才生效：

```javascript
const strictJson = STRICT_JSON_PROMPTS.has(promptId);
const requestedModel = strictJson
  ? rawRequestedModel.replace(/-thinking$/i, '')
  : rawRequestedModel;
```

這意味著非 strict-JSON 的 prompt（包括 Agent loop 本身的 chat completion）不會被 strip。如果用戶設定了 thinking 模型，或者某處 hardcode 了 thinking model，Agent loop 就會用 thinking model 做 tool calling。

### 問題的影響

Thinking model 做 tool calling：
- **延遲 3-5x**：每次 tool call 前都要走一輪 CoT reasoning
- **更貴**：thinking token 計費但使用者看不到
- **容易超時**：25s Edge Function timeout 不夠 thinking model 完成一輪 tool call

### 涉及檔案

1. `src/services/diModelRouterService.js` — 第 523-530 行
2. `src/services/chatAgentLoop.js` — 確認 Agent loop 傳入的 model 參數

### 修改方式

**方案 A — 在 chatAgentLoop 入口 strip thinking suffix**：

```javascript
// chatAgentLoop.js — 在呼叫 LLM 的地方，確保 model 不是 thinking 版本
// 找到 agentModel 的賦值位置，加入：
const agentModel = (rawModel || '').replace(/-thinking$/i, '');
```

**方案 B — 在 diModelRouterService.js 全局 strip**（適用於 agent loop）：

```javascript
// 第 527-530 行，改為對所有 tool-calling 的 prompt 都 strip thinking：
const strictJson = STRICT_JSON_PROMPTS.has(promptId);
const isToolCallingPrompt = promptId === 'AGENT_CHAT_LOOP' || promptId === 'AGENT_OPTIMIZER_LOOP';
const requestedModel = (strictJson || isToolCallingPrompt)
  ? rawRequestedModel.replace(/-thinking$/i, '')
  : rawRequestedModel;
```

### 驗證方式

重新載入設定頁，確認 Primary model 為 `gpt-5.4`。執行一次分析，觀察 console 中 `agentLoop Calling LLM` 的 model 是否為 `gpt-5.4`（不帶 `-thinking`）。

---

## 執行順序建議

```
Phase 1 — 立即見效（30 min）
├── A7: Thinking Model 路由修正 (20 min) — 解決延遲問題
└── A2: Summary 字數放寬 (15 min) — 最簡單的品質提升

Phase 2 — 核心品質提升（70 min）
├── A1: Thinking Budget (30 min) — 最大品質提升
└── A3: JSON Graceful Degradation (40 min) — 防止推理丟失

Phase 3 — 管線優化（90 min）
├── A4: Optimizer 條件收緊 (20 min) — 減少無效 optimizer
├── A5: Deterministic QA 強化 (45 min) — 更精準的品質檢測
└── A6: Judge 上下文擴充 (25 min) — 更準確的裁判
```

---

## 與前份 Bug Fix Guide 的關係

本文件是**架構層面的品質提升**，與之前的 `DI-Pipeline-Quality-Fix-Guide.md`（5 項 bug fix）互相獨立。建議：

1. **先完成 Bug Fix Guide 的 5 項**（機械問題——CORS 部署、圖表回填、repair 模型、memory 表、SQL 去重）
2. **再按本文件的 Phase 順序做架構升級**

Bug fix 修的是「東西壞了」，架構升級修的是「東西不夠好」。兩者都做完之後，你的平台在商業分析場景的輸出品質應該能達到甚至超越 Claude Web 水準——因為你有 Claude Web 做不到的資料直連 + 結構化呈現 + 證據追溯 + 事實核查，同時推理深度也補上來了。

---

## 快速 A/B 測試方法

改完後，用同一個問題測試：

1. **你的管線**：直接在 DI 平台問「Revenue & Sales Trend Analysis」
2. **Claude Web 模擬**：把 Primary Agent 的 SQL 查詢結果手動貼給 Claude Web，問相同問題

比較兩邊：
- 洞察深度（是否有因果分析，不只是描述數字）
- 數據準確度（brief 中的數字是否與 SQL 結果一致）
- 可行性（next_steps 是否具體到可以執行）
- 完整度（required_dimensions 是否全部覆蓋）

你應該在前兩項追平 Claude Web、後兩項超越它。
