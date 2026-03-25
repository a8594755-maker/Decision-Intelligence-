# Decision Intelligence — Round 8 Fix Guide

> **前置狀態**：Round 7 三項修復已全部正確實作並驗證通過。
> **當前 QA 分數**：6.5 / 8.0（目標 ≥ 7.0）
> **測試題目**：巴西賣家年營收趨勢（含 CAGR、分佈、風險因子）
> **日期**：2026-03-24

---

## Round 7 驗證結果

| Fix | 狀態 | 驗證位置 |
|-----|------|----------|
| Fix 1: `getCrossModelReviewConfig()` 取代硬編碼常量 | ✅ 已實作 | `agentResponsePresentationService.js` line 119-125 |
| Fix 2: pill evidence 使用 `parseNumericValue` | ✅ 已實作 | `agentResponsePresentationService.js` line 1540 |
| Fix 3: CJK-aware tokenization for contradiction dedup | ✅ 已實作 | `agentResponsePresentationService.js` line 1592-1600 |

**效果對比**：

| 維度 | Round 6 | Round 7 後 | 變化 |
|------|---------|-----------|------|
| Correctness | 0.0 | 5.0 | +5.0 |
| Evidence | 2.0 | 5.5 | +3.5 |
| Overall | ~4.0 | 6.5 | +2.5 |
| Claude 400 errors | 8 次 | 0 次 | 消除 |
| Tool 404 errors | 37 個 | 0 個 | 消除 |

---

## 本輪剩餘問題（2 個）

### Fix 4（P0）：DeepSeek Repair Synthesis Timeout

**症狀**：
```
[agentResponsePresentation] Repair synthesis fallback: deepseek/deepseek-chat: Edge Function timed out after 55000ms
```
Repair 連續 2 次 timeout，最終 fallback 回原始 brief（等於 repair 完全沒做）。

**根本原因**：

`repairBrief` 呼叫 `runDiPrompt` 時，repair prompt 的 input payload 遠大於 review prompt：

| 欄位 | clamp 上限 |
|------|-----------|
| userMessage | 2,500 chars |
| answerContract | 1,800 chars |
| brief (JSON) | 5,000 chars |
| finalAnswerText | 3,000 chars |
| deterministicQa (JSON) | 3,500 chars |
| qaScorecard (JSON) | 4,500 chars |
| artifactSummary | 3,500 chars |
| toolCalls summary | 4,500 chars |
| system instructions + schema | ~2,500 chars |
| **Total** | **~31,300 chars ≈ 10K-12K tokens input** |

加上 `maxOutputTokens: 4096`，DeepSeek 在 Edge Function 的 55 秒硬限制內來不及完成。
（對比：review prompt 只需回傳 `{ score, issues[] }`，output 很小，16 秒就完成。）

**檔案**：`src/services/agent-core/agentResponsePresentationService.js`

**修法 A — 縮減 repair prompt input（推薦，改動最小）**：

修改 `src/prompts/agentResponsePrompt.js` 中的 `buildAgentQaRepairSynthesisPrompt` 函數（line 457），縮減 clamp 參數：

```javascript
// ── 修改前（line 481-488）──
- Current brief: ${clampText(JSON.stringify(brief || {}), 5000)}
- Raw final narrative: "${clampText(finalAnswerText, 3000)}"
- Deterministic QA: ${clampText(JSON.stringify(deterministicQa || {}), 3500)}
- Current QA scorecard: ${clampText(JSON.stringify(qaScorecard || {}), 4500)}
- Artifact summary:
${clampText(artifactSummary || 'No artifacts summarized.', 3500)}
- Tool evidence:
${clampText(summarizeToolCalls(toolCalls), 4500)}

// ── 修改後 ──
- Current brief: ${clampText(JSON.stringify(brief || {}), 3500)}
- Raw final narrative: "${clampText(finalAnswerText, 2000)}"
- Deterministic QA: ${clampText(JSON.stringify(deterministicQa || {}), 2500)}
- Current QA scorecard: ${clampText(JSON.stringify(qaScorecard || {}), 2500)}
- Artifact summary:
${clampText(artifactSummary || 'No artifacts summarized.', 2000)}
- Tool evidence:
${clampText(summarizeToolCalls(toolCalls), 3000)}
```

同時在 `repairBrief`（agentResponsePresentationService.js line 2714-2715）縮減 output：

```javascript
// ── 修改前 ──
temperature: 0.1,
maxOutputTokens: 4096,

// ── 修改後 ──
temperature: 0.1,
maxOutputTokens: 3000,
```

**預期效果**：input 從 ~31K chars 降到 ~20K chars（~7K tokens），output 從 4096 降到 3000 tokens。總處理量減少 ~40%，應可在 55 秒內完成。

**修法 B — Deterministic fallback repair（加強安全網）**：

即使縮減 prompt 後仍可能偶爾 timeout。目前 timeout 時的 fallback（line 2720-2722）只做 `normalizeBrief`，完全不修任何 QA 問題。改為加入 deterministic repair：

```javascript
// ── 修改前（line 2720-2722）──
catch (error) {
  console.warn('[agentResponsePresentation] Repair synthesis fallback:', error?.message);
  return normalizeBrief(brief, fallbackBrief, { brevity: answerContract?.brevity });
}

// ── 修改後 ──
catch (error) {
  console.warn('[agentResponsePresentation] Repair synthesis fallback:', error?.message);
  // Apply deterministic-only repairs when LLM repair times out
  const patched = applyDeterministicRepairs(brief, deterministicQa);
  return normalizeBrief(patched, fallbackBrief, { brevity: answerContract?.brevity });
}
```

新增 `applyDeterministicRepairs` 函數（建議放在 `normalizeBrief` 附近，line ~880）：

```javascript
/**
 * Lightweight deterministic repair: fixes the most common QA failures
 * without requiring an LLM call. Used as fallback when LLM repair times out.
 */
function applyDeterministicRepairs(brief, deterministicQa) {
  if (!brief || typeof brief !== 'object') return brief;
  const patched = JSON.parse(JSON.stringify(brief)); // deep clone

  // 1. Fix floating-point residuals in all text fields
  //    (normalizeBrief already does this, but we also fix table cells here)

  // 2. Add missing proxy/limitation caveat if flagged
  const flags = deterministicQa?.flags || {};
  if (flags.missing_proxy_caveat || flags.missing_limitation_caveat) {
    const caveats = Array.isArray(patched.caveats) ? patched.caveats : [];
    const hasProxy = caveats.some(c => /proxy|surrogate|approximat/i.test(c));
    if (!hasProxy) {
      caveats.push('Analysis uses proxy metrics where direct measurements are unavailable; interpret trends directionally rather than as precise values.');
      patched.caveats = caveats;
    }
  }

  // 3. Strip metric pills that have no matching evidence
  if (flags.unmatched_pills && Array.isArray(patched.metric_pills)) {
    const unmatchedLabels = new Set(
      (deterministicQa.trace || [])
        .filter(t => /pill.*no matching evidence/i.test(t))
        .map(t => {
          const m = t.match(/pill "([^"]+)"/i);
          return m ? m[1].toLowerCase() : null;
        })
        .filter(Boolean)
    );
    if (unmatchedLabels.size > 0) {
      patched.metric_pills = patched.metric_pills.filter(
        p => !unmatchedLabels.has(String(p?.label || '').toLowerCase())
      );
    }
  }

  return patched;
}
```

**建議 A + B 組合使用**：A 解決根本問題（prompt 太大），B 提供安全網。

---

### Fix 5（P1）：CAGR Pill 單位轉換 Mismatch

**症狀**：
```
pill "整體 CAGR" value "1118.02%" → no matching evidence
```

**根本原因**：

SQL 回傳的 CAGR 是乘數格式 `11.180156730638245`（即 1118%），LLM 在 brief synthesis 時正確轉換為百分比 `1118.02%`。但 pill evidence matching 用 `parseNumericValue("1118.02%")` 得到 `1118.02`，而 evidence 裡只有 `11.18`。兩者差 100 倍，超過 5% tolerance。

**檔案**：`src/services/agent-core/agentResponsePresentationService.js`

**修法**：在 `verifyPillEvidence` 的 matching loop 中（目前在 line ~1545 附近），增加百分比 ↔ 小數的轉換嘗試：

```javascript
// ── 找到目前的 matching 邏輯（大約 line 1546-1555）──
// 在現有的 tolerance check 之後，加入：

if (!matched && rawVal.includes('%')) {
  // Percentage pill might correspond to a ratio/multiplier in evidence
  // e.g., pill "1118.02%" ↔ evidence 11.18 (ratio × 100 = percentage)
  const asRatio = pillNum / 100;
  for (const evNum of evidenceNumbers) {
    if (evNum === 0) continue;
    const ratio = Math.abs(asRatio - evNum) / Math.abs(evNum);
    if (ratio < 0.05) { matched = true; break; }
  }
}
if (!matched && !rawVal.includes('%')) {
  // Ratio/multiplier pill might correspond to a percentage in evidence
  // e.g., pill "11.18" ↔ evidence that was stored as 1118.02
  const asPct = pillNum * 100;
  for (const evNum of evidenceNumbers) {
    if (evNum === 0) continue;
    const ratio = Math.abs(asPct - evNum) / Math.abs(evNum);
    if (ratio < 0.05) { matched = true; break; }
  }
}
```

**預期效果**：`1118.02%` → `asRatio = 11.1802` → 與 evidence `11.18` 比較 → ratio < 0.05 → matched。消除這個 false negative。

---

## 優先級總覽

| # | Fix | 優先級 | 預期分數影響 | 改動範圍 |
|---|-----|--------|-------------|---------|
| 4A | 縮減 repair prompt input | P0 | 間接（讓 repair 能完成） | `agentResponsePrompt.js` line 481-488 + `agentResponsePresentationService.js` line 2714 |
| 4B | Deterministic fallback repair | P0 | +0.3~0.5（補 caveat、去 unmatched pill） | `agentResponsePresentationService.js` ~line 880, 2720-2722 |
| 5 | CAGR % ↔ ratio matching | P1 | +0.2~0.3（消除 CAGR false negative） | `agentResponsePresentationService.js` ~line 1546-1555 |

**預期總分**：6.5 + 0.5~0.8 → **7.0~7.3**（達標）

---

## 測試驗證

修完後用同一題測試：

> **問題**：「分析巴西賣家過去三年的年營收趨勢，包括 CAGR 計算、營收分佈（中位數與四分位距），以及影響營收波動的主要風險因子。請用繁體中文回答。」

**驗證 checklist**：

- [ ] QA review 不再 timeout（console 無 "Repair synthesis fallback" 訊息）
- [ ] 如果 repair 仍 timeout，fallback 有補 proxy caveat（看 brief 的 caveats 欄位）
- [ ] CAGR pill 不再顯示 "no matching evidence"
- [ ] Overall score ≥ 7.0
- [ ] 無 magnitude mismatch（或僅剩 1-2 個邊界案例）
- [ ] 無 Claude 400 errors
- [ ] 所有 tool calls 成功（無 404）
