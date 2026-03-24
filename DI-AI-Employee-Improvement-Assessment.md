# AI Employee 框架 — 全面改進評估

> 基於 orchestrator.js（66KB）、planner.js、router.js、executors/、styleLearning/、
> selfHealingService.js、aiEmployeeMemoryService.js、ralphLoopAdapter.js 等核心代碼的深度審查。

---

## 整體評價

你的 AI Employee 架構在「企業級 AI Agent」的設計上已經做得相當完整。它具備了：狀態機驅動的任務生命週期、自主性分級（A0-A4）、能力策略（capability policy）、預算控制、治理規則、自我修復、風格學習、信任指標。這是一個認真的產品，不是玩具。

但正因為功能很全，問題也集中在**架構複雜度**和**實際使用體驗**的落差上。以下按嚴重程度排序。

---

## 一、架構層面的問題

### 1.1 orchestrator.js 過於龐大（嚴重）

**現狀**：orchestrator.js 是 66KB 的超大檔案，承擔了 13 項職責（見文件頭部註解）。`_executeStep` 一個函式就有 250+ 行，包含 7 道 gate（dataset gate → budget gate → capability policy gate → tool permission gate → governance rule gate → approval gate → 最後才真正執行）。

**問題**：
- 每次修改一個 gate 的邏輯，都要在這個巨大文件裡找位置
- 7 道 gate 的順序耦合——如果 capability policy 想在 budget 之前檢查，要大幅重排
- 所有 gate 都是 try/catch best-effort，意味著任何一個失敗都是靜默的

**建議**：把 `_executeStep` 拆成 pipeline 模式：

```javascript
// 改前：250+ 行的 _executeStep
// 改後：
const STEP_PIPELINE = [
  datasetGate,
  budgetGate,
  capabilityPolicyGate,
  toolPermissionGate,
  governanceRuleGate,
  approvalGate,
  memoryRecall,
  styleContextResolver,
  executeStep,
  aiReviewGate,
];

async function _executeStep(task, step) {
  const ctx = { task, step, inputData: {}, styleContext: null };
  for (const gate of STEP_PIPELINE) {
    const result = await gate(ctx);
    if (result?.blocked) return result;
  }
  return ctx.result;
}
```

每個 gate 獨立成一個檔案（`src/services/aiEmployee/gates/`），可以獨立測試、獨立開關。

### 1.2 「best-effort」模式過度使用（中等）

**現狀**：我數了一下，orchestrator.js 裡有 **20+ 個 `catch { /* best-effort */ }`** 區塊。worklog、SSE、budget check、capability check、governance rules、memory recall、style context 全部是 best-effort。

**問題**：
- 當 Supabase 短暫斷線時，可能同時失去 worklog + SSE + memory，但 task 繼續跑，使用者完全不知道
- 調試時很難知道「為什麼這個 task 沒有走 governance gate」——因為 gate 可能 silently failed
- 沒有任何 health check 或 degradation indicator

**建議**：
- 引入 `DegradedMode` 概念：當 N 個 best-effort 服務失敗時，在 UI 上顯示「降級模式」banner
- 對關鍵 gate（capability policy、governance rules）改為 fail-closed：失敗時 block 而不是 pass
- 非關鍵服務（worklog、SSE）保持 best-effort，但加一個失敗計數器，超過閾值觸發告警

### 1.3 Classic Tick Loop 是同步阻塞（中等）

**現狀**：`_runTickLoop` 在 classic mode 下是 `while (running)` 迴圈，每 500ms 執行一個 step。

**問題**：
- 如果跑在瀏覽器 main thread（看起來是 Vite 前端），長時間的 while loop 會阻塞 UI
- 沒有 concurrency 控制——不能並行跑獨立的 steps
- Ralph Loop mode 解決了部分問題，但 classic mode 仍然存在

**建議**：
- Classic mode 改為 `setTimeout` 遞迴或 `requestIdleCallback`，不阻塞 UI
- 支持 step 之間的依賴圖（DAG），獨立 steps 可以並行執行
- 加入 progress heartbeat，讓 UI 知道 loop 還活著

---

## 二、Planner 的問題

### 2.1 Planner 太薄（嚴重）

**現狀**：`planner.js` 只是 `chatTaskDecomposer` 的 thin wrapper，85 行代碼，幾乎沒有自己的邏輯。

**問題**：
- Task decomposition 的品質完全依賴 LLM 的一次性輸出，沒有驗證
- LLM 回傳的 step 如果引用了不存在的 `builtin_tool_id`，只是靜默 fallback 到 `python_tool`
- 沒有考慮 step 之間的依賴關係——全部是線性序列
- 沒有 cost estimation（在 plan 階段就該估算 token 消耗和執行時間）

**建議**：
- Plan validation layer：LLM 產出 plan 後，驗證每個 step 的 tool_id 是否存在、依賴是否合理
- Plan DAG：允許 steps 聲明 `depends_on: [step_name]`，orchestrator 按 DAG 拓撲序執行
- Plan cost preview：在 user approve 之前，顯示預估的 token 消耗、執行時間、API 費用
- Re-planning capability：當某個 step 失敗時，不只是 retry，而是 re-plan 剩餘的 steps

### 2.2 chatTaskDecomposer 的 fallback 太依賴 keyword（輕微）

**現狀**：`chatTaskDecomposer.js` 有大量的 keyword lists（GENERAL_ANALYSIS_SIGNALS_EN、GENERAL_ANALYSIS_SIGNALS_ZH），用於在 LLM 不可用時做 fallback。

**問題**：keyword 匹配無法處理語義相近但措辭不同的需求，而且隨著功能增長，keyword list 會越來越難維護。

**建議**：把 keyword fallback 改為 embedding-based matching——把所有 builtin tools 的描述 embed 一次，user message 來時做 cosine similarity。

---

## 三、Memory 與 Learning 的問題

### 3.1 Memory 的 localStorage fallback 是個隱患（嚴重）

**現狀**：`aiEmployeeMemoryService.js` 使用 `localStorage` 作為 Supabase 不可用時的 fallback，上限 200 條。

**問題**：
- `localStorage` 是 per-origin、per-browser 的，不跨設備同步
- 多個 tab 同時操作可能導致 race condition
- 如果使用者清瀏覽器快取，所有 local memory 就沒了
- 200 條上限太低，沒有 LRU 或 relevance-based eviction

**建議**：
- 移除 localStorage fallback，改為 IndexedDB（支援更大容量、transaction）
- 或更好：把 memory 當作 Supabase 的核心功能，沒有 Supabase 就沒有 memory（而不是用一個不可靠的 fallback 給使用者錯誤的信心）
- Memory recall 加入 relevance scoring（不只是 workflow type 和 dataset fingerprint，還要考慮 recency 和 outcome quality）

### 3.2 Style Learning 太碎片化（中等）

**現狀**：`styleLearning/` 資料夾有 18 個檔案，涵蓋 outputProfile、styleProfile、exemplar、policy ingestion、trust metrics、feedback extraction、company output profile 等。

**問題**：
- 命名混亂：`outputProfileService` vs `companyOutputProfileService` vs `styleProfileService` vs `styleExtractionService` — 很難知道該用哪個
- `outputProfileService.js` 的 fallback chain 有四層（company_output_profiles → style_profiles → style_exemplars → style_policies），邏輯複雜
- Trust metrics 的 autonomy thresholds 是硬編碼的（A2: 50% first-pass rate @ 10 tasks, A3: 70% @ 30 tasks），不同行業/場景可能需要不同閾值

**建議**：
- 統一命名為「Output Profile」：合併 styleProfile 和 companyOutputProfile 為一個 service
- Autonomy thresholds 移到 DB/config，讓管理者可以調整
- 加入 A/B testing 機制：同一個 task 用不同 autonomy level 跑，比較結果品質

---

## 四、Error Handling 與 Self-Healing

### 4.1 Self-Healing 的策略選擇太靜態（中等）

**現狀**：`selfHealingService.js` 用 regex 匹配 error message 來分類錯誤，然後選擇策略（escalate_model / revise_prompt / simplify_task / skip_with_fallback）。

**問題**：
- Regex-based 分類容易 miss edge cases（特別是不同 LLM provider 的 error format 不統一）
- 策略選擇沒有考慮歷史：同一個 task 如果連續 escalate_model 都失敗了，應該換策略而不是繼續 escalate
- 沒有 circuit breaker：如果某個 provider 連續失敗 N 次，還是會繼續嘗試

**建議**：
- 加入策略狀態追蹤：記錄每次 self-healing 的策略和結果，避免重複使用已失敗的策略
- 引入 circuit breaker pattern：provider 連續失敗 3 次就暫時跳過
- 考慮用 LLM 來分類錯誤（而不是 regex）——更靈活但更慢，可以作為 fallback

### 4.2 MAX_RETRIES = 3 不夠靈活（輕微）

**現狀**：所有 step 統一用 `MAX_RETRIES = 3`。

**建議**：不同類型的 step 應該有不同的 retry 策略：
- `python_tool`（code generation）：3-5 次（每次 revise prompt 可能有進展）
- `llm_call`（純文字生成）：2 次就夠（文字品質問題 retry 效果有限）
- `builtin_tool`（forecast/plan）：1 次（引擎計算失敗通常是資料問題，retry 沒用）

---

## 五、Ralph Loop（自主 Agent 模式）

### 5.1 Ralph Loop 的可觀測性不足（嚴重）

**現狀**：`ralphLoopAdapter.js` 把整個 tick loop 交給 `ralph-loop-agent` 庫來驅動，有 max iterations（30）和 max cost（$5.00）的限制。

**問題**：
- 使用者無法看到 Ralph Loop 內部的決策過程（「為什麼它決定執行這個 step 而不是那個？」）
- abort 後沒有 cleanup 機制——如果 step 已經在執行中，abort 只是標記而不是真的中斷
- 沒有 intermediate result reporting——使用者要等整個 loop 跑完才能看到結果

**建議**：
- 加入 thought log：Ralph Loop 每次迭代的決策理由要記錄並透過 SSE 推送到 UI
- 實現 graceful abort：在 step execution 層面支援 AbortSignal
- Streaming intermediate results：每完成一個 step 就更新 UI，不用等全部完成

### 5.2 Classic Mode 和 Ralph Mode 的切換缺乏彈性（輕微）

**現狀**：只能透過環境變數 `VITE_RALPH_LOOP_ENABLED` 或 per-task flag 切換。

**建議**：根據 task 複雜度自動選擇——simple tasks（1-2 steps）用 classic mode，complex tasks（3+ steps）用 Ralph Loop。

---

## 六、產品層面的缺失

### 6.1 沒有 Task 取消後的回滾（嚴重）

**現狀**：`cancelTask` 只是改狀態，不清理已執行 step 的副作用。

**問題**：如果前兩個 step 已經執行（比如修改了資料庫、發了 email），取消 task 不會 undo 這些操作。

**建議**：
- 每個 executor 實現 `rollback()` 方法
- 取消時按逆序呼叫 rollback
- 對於不可逆操作（email、publish），在 cancel 時至少 log 一個 warning

### 6.2 使用者輸入的 UI 通路不存在（嚴重）

**現狀**：orchestrator.js 第 525 行明確寫了：

```
// NOTE: No UI path currently exists for users to provide step input interactively.
```

`provideStepInput` 和 `skipWaitingInputStep` 有 API，但沒有對應的 UI。

**問題**：當 step 需要使用者提供資料時（如缺少 dataset），task 就會被 block，使用者無法在 chat 介面內提供。只能靠 `skipWaitingInputStep` 跳過。

**建議**：在 chat UI 裡加入 step input 的互動元件——當 task 進入 `waiting_input` 狀態時，顯示一個檔案上傳 / 選擇 dataset 的 card。

### 6.3 Plan Approval UI 的資訊量不足（中等）

**現狀**：使用者在 approve plan 時只能看到 step 名稱列表。

**問題**：使用者沒有足夠資訊判斷 plan 是否合理——不知道每個 step 要做什麼、用什麼模型、預計花多少時間/費用。

**建議**：Plan approval card 應該包含：
- 每個 step 的 tool 類型和預估執行時間
- 整體預估 token 消耗和 API 費用
- 哪些 step 有 review checkpoint
- 哪些 step 需要 dataset（如果沒有會 block）

### 6.4 Cross-Task Learning 太弱（中等）

**現狀**：Memory recall 只用 workflow type 和 dataset fingerprint 匹配，`DEFAULT_RECALL_LIMIT = 5`。

**問題**：
- 不同 dataset 上的相似 task 無法互相受益
- 沒有 negative learning（「上次用這個方法失敗了，這次應該避免」）
- 5 條 memory 上限太少，特別是 dataset fingerprint 不同時可能完全匹配不到

**建議**：
- 引入 semantic memory：用 embedding 匹配任務語義，不只靠 fingerprint
- 加入 failure memory：記錄失敗的策略和原因，recall 時帶上 negative examples
- Memory 與 style learning 整合：某個 reviewer 反覆修改某類輸出格式 → 自動調整 output profile

---

## 七、優先級排序

| 優先級 | 項目 | 影響面 | 預估工時 |
|--------|------|--------|----------|
| P0 | 6.2 使用者輸入 UI 通路 | 使用者會被 block 住 | 1 週 |
| P0 | 1.1 orchestrator 拆分（pipeline 模式） | 可維護性 | 2 週 |
| P1 | 2.1 Planner 加驗證和 cost preview | Plan 品質 | 1 週 |
| P1 | 6.3 Plan Approval UI 資訊量 | 使用者信心 | 3 天 |
| P1 | 1.2 best-effort 改為分級處理 | 可靠性 | 1 週 |
| P1 | 5.1 Ralph Loop 可觀測性 | 用戶體驗 | 1 週 |
| P2 | 3.1 移除 localStorage fallback | 數據可靠性 | 3 天 |
| P2 | 3.2 Style Learning 統一命名 | 可維護性 | 1 週 |
| P2 | 4.1 Self-Healing 策略狀態追蹤 | 修復成功率 | 3 天 |
| P2 | 6.4 Cross-Task Learning 增強 | 長期品質提升 | 2 週 |
| P3 | 1.3 Tick Loop 非阻塞化 | UI 流暢度 | 3 天 |
| P3 | 6.1 Task 取消回滾 | 安全性 | 2 週 |
| P3 | 5.2 Auto mode 選擇 | 便利性 | 2 天 |

---

## 總結

你的 AI Employee 架構在功能廣度上已經是業界頂級水準——autonomy levels、capability policies、governance rules、self-healing、style learning、trust metrics 這些概念很多商業產品都沒做到。

核心問題不是「缺少什麼功能」，而是：

1. **orchestrator.js 太肥大**——需要拆成 pipeline + gates
2. **使用者互動通路不完整**——waiting_input 沒有 UI、plan approval 資訊不足
3. **可觀測性不足**——best-effort 靜默失敗、Ralph Loop 黑盒
4. **Planner 太薄**——需要驗證、cost preview、re-planning 能力

修這四個方向，產品會有質的飛躍。
