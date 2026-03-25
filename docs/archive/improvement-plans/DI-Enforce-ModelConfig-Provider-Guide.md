# 實作指南：強制 Model Config Provider — 不准偷換

> 原則：使用者在 Model Config 裡設定哪個 provider/model，所有 prompt 就走那個 provider/model。
> 任何 hardcoded override 和 silent fallback 都必須移除。

---

## 問題清單

掃描 `diModelRouterService.js` 後找到 **4 個違規點**：

| # | 位置 | 類型 | 行為 | 影響 |
|---|------|------|------|------|
| V1 | line 111 | **寫死 provider** | `AGENT_QA_CROSS_REVIEW` 強制回傳 `'anthropic'` | 忽略 judge config |
| V2 | line 118 | **寫死 model** | `AGENT_QA_CROSS_REVIEW` 強制回傳 `'claude-sonnet-4-6'` | 忽略 judge config |
| V3 | line 99 + 308-309 | **Fallback 偷換** | `buildJudgeRecoveryAttempts` 最後一個 attempt 強制用 `anthropic/claude-sonnet-4-6` | 主 provider 失敗後偷換到 Claude |
| V4 | line 296-304 + 332-340 | **Gemini 候選偷換** | recovery attempts 在 Gemini 失敗後試其他 Gemini 候選 model | 雖然 provider 沒變，但 model 被換掉 |

---

## 修法

### Fix 1：移除 `getPromptProvider` 的寫死覆蓋

**檔案**：`src/services/diModelRouterService.js`
**行號**：109-114

```javascript
// ❌ 現狀
function getPromptProvider(promptId) {
  // Cross-review uses Claude Sonnet for better instruction-following and scoring calibration
  if (promptId === DI_PROMPT_IDS.AGENT_QA_CROSS_REVIEW) return 'anthropic';
  const role = JUDGE_PROMPT_IDS.has(promptId) ? 'judge' : 'primary';
  return getModelConfig(role).provider;
}

// ✅ 改為
function getPromptProvider(promptId) {
  const role = JUDGE_PROMPT_IDS.has(promptId) ? 'judge' : 'primary';
  return getModelConfig(role).provider;
}
```

### Fix 2：移除 `getPromptDefaultModel` 的寫死覆蓋

**檔案**：`src/services/diModelRouterService.js`
**行號**：116-121

```javascript
// ❌ 現狀
function getPromptDefaultModel(promptId) {
  // Cross-review uses Claude Sonnet for better instruction-following and scoring calibration
  if (promptId === DI_PROMPT_IDS.AGENT_QA_CROSS_REVIEW) return 'claude-sonnet-4-6';
  const role = JUDGE_PROMPT_IDS.has(promptId) ? 'judge' : 'primary';
  return getModelConfig(role).model;
}

// ✅ 改為
function getPromptDefaultModel(promptId) {
  const role = JUDGE_PROMPT_IDS.has(promptId) ? 'judge' : 'primary';
  return getModelConfig(role).model;
}
```

### Fix 3：移除 `buildJudgeRecoveryAttempts` 的跨 provider fallback

**檔案**：`src/services/diModelRouterService.js`
**行號**：290-320

```javascript
// ❌ 現狀
function buildJudgeRecoveryAttempts({ provider, model, promptText }) {
  const attempts = [
    { provider, model, prompt: promptText },
    { provider, model, prompt: buildSchemaRepairPrompt(promptText) },
  ];

  if (provider === 'gemini') {
    for (const candidateModel of DI_GEMINI_MODEL_CANDIDATES) {
      if (candidateModel === model) continue;
      attempts.push({
        provider: 'gemini',
        model: candidateModel,
        prompt: buildSchemaRepairPrompt(promptText),
      });
    }
  }

  // ↓↓↓ 這裡偷換到 anthropic ↓↓↓
  attempts.push({
    provider: 'anthropic',
    model: ANTHROPIC_JSON_FALLBACK_MODEL,
    prompt: buildSchemaRepairPrompt(promptText),
  });

  const seen = new Set();
  return attempts.filter((attempt) => {
    const key = `${attempt.provider}:${attempt.model}:${attempt.prompt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ✅ 改為：只在同一個 provider 內重試，不跨 provider
function buildJudgeRecoveryAttempts({ provider, model, promptText }) {
  const attempts = [
    { provider, model, prompt: promptText },
    { provider, model, prompt: buildSchemaRepairPrompt(promptText) },
  ];

  // 同 provider 內的候選 model fallback（僅 Gemini 有多候選）
  if (provider === 'gemini') {
    for (const candidateModel of DI_GEMINI_MODEL_CANDIDATES) {
      if (candidateModel === model) continue;
      attempts.push({
        provider: 'gemini',
        model: candidateModel,
        prompt: buildSchemaRepairPrompt(promptText),
      });
    }
  }

  // ❌ 已移除：不再偷換到 anthropic
  // 如果使用者設定的 provider 全部失敗，就讓它失敗，由上層處理

  const seen = new Set();
  return attempts.filter((attempt) => {
    const key = `${attempt.provider}:${attempt.model}:${attempt.prompt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

### Fix 4：移除 `buildStrictJsonRecoveryAttempts` 的跨 model fallback（可選）

**檔案**：`src/services/diModelRouterService.js`
**行號**：322-350

目前這個函數在非 judge prompt（self-review、repair 等）只做同 provider 同 model 的 retry，
**沒有跨 provider**，所以不違反原則。

但 Gemini 分支（line 332-340）會試其他 Gemini model。
如果你認為「同 provider 內換 model」也不接受，可以同步移除：

```javascript
// ✅ 嚴格版：完全不換 model
function buildStrictJsonRecoveryAttempts({ provider, model, promptText, promptId }) {
  if (JUDGE_PROMPT_IDS.has(promptId)) {
    return buildJudgeRecoveryAttempts({ provider, model, promptText });
  }

  // 只做同 provider + 同 model 的 prompt repair retry
  return [
    { provider, model, prompt: promptText },
    { provider, model, prompt: buildSchemaRepairPrompt(promptText) },
  ];
}
```

### Fix 5：清理 `ANTHROPIC_JSON_FALLBACK_MODEL` 常量

Fix 3 移除了唯一使用 `ANTHROPIC_JSON_FALLBACK_MODEL` 的地方。
如果 Fix 3 完成，這個常量就沒用了：

**行號**：99

```javascript
// ❌ 移除（Fix 3 完成後不再被引用）
// const ANTHROPIC_JSON_FALLBACK_MODEL = 'claude-sonnet-4-6';
```

---

## 驗證清單

修完後，在 console 搜尋以下 pattern 確認沒有殘留：

```bash
# 在 diModelRouterService.js 中搜尋，不應該有任何 match
grep -n "return 'anthropic'" src/services/diModelRouterService.js
# 預期：0 結果

grep -n "claude-sonnet" src/services/diModelRouterService.js
# 預期：0 結果

grep -n "ANTHROPIC_JSON_FALLBACK" src/services/diModelRouterService.js
# 預期：0 結果
```

## 測試方式

1. Model Config 設為 `primary: openai/gpt-5.4`，`judge: openai/gpt-5.4`
2. 跑一次分析查詢
3. 在 console 搜尋 `callAnthropicPrompt` — **不應該出現**
4. 所有 `[diModelRouter]` log 應該只顯示 `OpenAI via Edge Function OK`
5. QA score 不再是 0.0（因為 review 用 OpenAI 正常跑了）

---

## 修改摘要

| 修改 | 行號 | 動作 | 影響範圍 |
|------|------|------|---------|
| Fix 1 | 111 | 刪除 1 行 if | `getPromptProvider` |
| Fix 2 | 118 | 刪除 1 行 if | `getPromptDefaultModel` |
| Fix 3 | 307-311 | 刪除 4 行 push | `buildJudgeRecoveryAttempts` |
| Fix 4 | 332-340 | 刪除 7 行 if block（可選） | `buildStrictJsonRecoveryAttempts` |
| Fix 5 | 99 | 刪除 1 行 const（可選） | 清理死碼 |

**必做**：Fix 1 + Fix 2 + Fix 3（共刪 6 行）
**可選**：Fix 4 + Fix 5（額外刪 8 行）
