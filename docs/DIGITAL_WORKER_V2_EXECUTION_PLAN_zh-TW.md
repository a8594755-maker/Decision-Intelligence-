# Digital Worker v2 執行計畫

## 題目

**從 ChatGPT Wrapper 升級為 Supply Chain Digital Worker：Event-Driven、Approval-Gated、ROI-Measurable 的自主供應鏈作業平台**

---

## 狀態追蹤

| Phase | 名稱 | 狀態 | 預計週數 | 開始日期 | 完成日期 |
|-------|------|------|---------|---------|---------|
| Phase 0 | 產品收斂與語言統一 | ✅ 完成 | Week 1 | 2026-03-16 | 2026-03-16 |
| Phase 1 | Decision Work Order + Lifecycle | ✅ 完成 | Week 2-3 | 2026-03-16 | 2026-03-16 |
| Phase 2 | Event-Driven Backbone | ✅ 完成 | Week 4-5 | 2026-03-16 | 2026-03-16 |
| Phase 3 | Artifact-first Decision Loop | ✅ 完成 | Week 6 | 2026-03-16 | 2026-03-16 |
| Phase 4 | KPI Continuous Monitoring | ✅ 完成 | Week 7-8 | 2026-03-16 | 2026-03-16 |
| Phase 5 | Approval Gate + Writeback | ✅ 完成 | Week 9 | 2026-03-16 | 2026-03-16 |
| Phase 6 | ROI Tracking + Dashboard | ✅ 完成 | Week 10 | 2026-03-16 | 2026-03-16 |
| Phase 7 | Integration Hardening | ✅ 完成 | Week 11-12 | 2026-03-16 | 2026-03-16 |
| Phase 8 | Multi-Worker Collaboration | 🔲 延後 (v1 後) | Week 13-14 | - | - |

---

## Phase 0：產品收斂與語言統一（Week 1）

### 目標
凍結產品敘事、功能邊界、資料 contract，避免工程做下去又改方向。

### 執行項目

| # | 任務 | 負責 | 狀態 | 備註 |
|---|------|-----|------|------|
| 0.1 | 統一產品名稱：Supply Planning Worker / Supply Chain Decision Worker / Digital Worker | Product | ✅ | UI 已全面使用 "Digital Worker" 描述 |
| 0.2 | 定義唯一 ICP | Product | ✅ | 有 ERP/Excel planning 流程、每週重複供需決策、中型製造/零售/distributor |
| 0.3 | 凍結 v1 功能邊界 | Product | ✅ | 只做 event-driven intake → planning artifact → approval → export/writeback → ROI tracking |
| 0.4 | 定義 Decision Work Order contract | Eng | ✅ | `src/contracts/decisionWorkOrderContract.js` — 18 intent types, 8 domains, 11 channels, factory + legacy converter |
| 0.5 | 定義 Artifact contract (decision_brief, evidence_pack, writeback_payload) | Eng | ✅ | `src/contracts/decisionArtifactContract.js` — 3 validators + registered in diArtifactContractV1.js |
| 0.6 | 定義 Review contract | Eng | ✅ | `src/contracts/reviewContract.js` — review resolution + approval policy + gate check logic |
| 0.7 | 更新首頁/demo/文案語言 | Product | ✅ | 殘餘 "AI employee" 用語已更新 |

### 驗收標準
- [ ] PRD、首頁文案、demo script、worker template 語言一致
- [ ] 不再把產品描述成聊天助手
- [ ] 工程團隊對 v1 scope 沒有歧義

### 涉及檔案
- `docs/DIGITAL_WORKER_PRD_zh-TW.md` — 更新
- `src/pages/HomePage.jsx` — 文案
- `src/components/chat/EmptyChatState.jsx` — 文案
- Worker template definitions

---

## Phase 1：Decision Work Order + Task Lifecycle 標準化（Week 2-3）

### 目標
把鬆散的任務輸入與 task 狀態收斂成固定規格。

### Decision Work Order Schema

```json
{
  "intent_type": "inventory_replan",
  "worker_id": "uuid",
  "business_domain": "supply_planning",
  "request_summary": "Inventory days on hand below threshold for P001",
  "source_channel": "event_queue | chat | schedule | webhook | manual",
  "entity_refs": {
    "sku": ["SKU-123"],
    "site": ["P001"],
    "supplier": ["S-001"],
    "time_bucket": "2026-W12"
  },
  "required_decision": "replenish_or_reallocate",
  "risk_level": "high",
  "due_at": "2026-03-20T12:00:00Z",
  "attachments": [],
  "input_context": {}
}
```

### 執行項目

| # | 任務 | 狀態 | 備註 |
|---|------|------|------|
| 1.1 | 建立 `DecisionWorkOrder` schema + validation | ✅ | Phase 0 已完成 `src/contracts/decisionWorkOrderContract.js` |
| 1.2 | 統一 orchestrator step model：ingest → analyze → draft_plan → review_gate → publish | ✅ | `decisionPipelineService.js` — classifyStepPhase + annotateStepsWithPhases + getPipelineProgress |
| 1.3 | 補齊 terminal states：needs_clarification, awaiting_approval, publish_failed, blocked_external_dependency | ✅ | `taskStateMachine.js` — 4 new states + 5 new events + recovery transitions |
| 1.4 | 補 decision-centric worklog taxonomy | ✅ | `worklogTaxonomy.js` — 30 event types + 7 categories + audit completeness checker |
| 1.5 | taskIntakeService 輸入轉換為 Decision Work Order | ✅ | `processIntakeAsDWO()` — bridges legacy intake → DWO |
| 1.6 | 測試：38 tests pass | ✅ | `decisionPipeline.test.js` — state machine, pipeline, worklog, intake conversion |

### 涉及檔案
- `src/services/aiEmployee/orchestrator.js` — step model + terminal states
- `src/services/taskIntakeService.js` — work order 轉換
- `src/services/aiEmployee/worklogService.js` — taxonomy
- 新增 `src/contracts/decisionWorkOrderSchema.js`

### 驗收標準
- [ ] 任何來源都能轉成統一 work order
- [ ] step lifecycle 固定 5 階段
- [ ] task state 可重播與審計

---

## Phase 2：Event-Driven Backbone（Week 4-5）

### 目標
讓 worker 不再只靠聊天啟動，而是被事件觸發。

### 資料模型

#### `event_queue`
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | uuid | PK |
| event_type | text | supplier_delay, inventory_below_threshold, forecast_accuracy_drift, po_received, manual_trigger |
| source_system | text | |
| payload | jsonb | |
| status | text | pending → matched → processed / ignored / failed |
| worker_id | uuid | FK |
| processed_task_id | uuid | FK |
| created_at | timestamptz | |
| processed_at | timestamptz | |
| error_message | text | |

#### `event_rules`
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | uuid | PK |
| name | text | |
| event_type_pattern | text | glob or regex |
| condition_json | jsonb | payload 條件 |
| target_worker_id | uuid | FK |
| task_template_id | uuid | FK |
| cooldown_seconds | int | |
| enabled | boolean | |
| priority | int | |

### 執行項目

| # | 任務 | 狀態 | 備註 |
|---|------|------|------|
| 2.1 | 建立 `event_queue` + `event_rules` Supabase migration | ✅ | `20260330_event_driven_backbone.sql` — 2 tables + indexes + RLS |
| 2.2 | 建立 `eventRuleEngine.js`：matchEventRule, checkCondition, isInCooldown | ✅ | 純函式 + glob matching + condition operators ($gt/$in/$ne) + cooldown + buildDWOFromEvent |
| 2.3 | Python `event_loop.py`：30-60s 掃 pending events → rule matching | ✅ | EventLoopProcessor class + singleton + configurable poll interval |
| 2.4 | `POST /api/v1/events/ingest` — 外部事件寫入（含 HMAC 驗證） | ✅ | main.py — HMAC validation + Supabase insert |
| 2.5 | `GET /api/v1/events/status` — queue stats + processor state | ✅ | main.py — processor status + poll stats |
| 2.6 | 修改 `SyntheticERPSandbox.jsx` 支援觸發事件 | ✅ | 5 event buttons: supplier_delay, low_inventory, demand_spike, po_overdue, forecast_drift |
| 2.7 | 前端 event client + 33 tests pass | ✅ | `eventQueueClient.js` + `eventRuleEngine.test.js` |

### 新增檔案
- `supabase/migrations/20260317_event_driven_backbone.sql`
- `src/services/eventLoop/eventRuleEngine.js`
- `src/ml/api/event_loop.py`

### 修改檔案
- `src/ml/api/main.py` — 啟動 background task, 新 endpoint
- `src/services/aiEmployee/orchestrator.js` — event 來源整合
- `src/pages/SyntheticERPSandbox.jsx`

### API 設計

```
POST /api/v1/events/ingest
Body: { event_type, source_system, payload, signature }
Response: { event_id, status: "accepted" }

GET /api/v1/events/status
Response: { processor_state, last_poll_at, queue_stats: { pending, processed, failed }, last_error }
```

### 驗收標準
- [ ] Synthetic event 成功寫入 queue
- [ ] Event rule 匹配後自動建 task
- [ ] Task 自動執行到 draft/review
- [ ] 使用者 0 操作完成觸發到 artifact 產生

---

## Phase 3：Artifact-first Decision Loop（Week 6）

### 目標
把結果從「回答文字」升級成「企業可審批產物」。

### 三份核心 Artifact

#### 1. `decision_brief` — 給 manager
```json
{
  "type": "decision_brief",
  "summary": "...",
  "recommended_action": "replenish_now",
  "business_impact": { "cost_delta": -5200, "service_level_impact": "+3%" },
  "risk_flags": [...],
  "confidence": 0.82,
  "assumptions": [...]
}
```

#### 2. `evidence_pack` — 給審核與 replay
```json
{
  "type": "evidence_pack",
  "source_datasets": [...],
  "timestamps": {...},
  "referenced_tables": [...],
  "engine_versions": {...},
  "calculation_logic": "...",
  "scenario_comparison": [...],
  "assumptions": [...]
}
```

#### 3. `writeback_payload` — 給 ERP adapter
```json
{
  "type": "writeback_payload",
  "target_system": "sap_mm",
  "intended_mutations": [...],
  "affected_records": [...],
  "idempotency_key": "uuid",
  "approval_metadata": { "approved_by": "...", "approved_at": "..." }
}
```

### 執行項目

| # | 任務 | 狀態 | 備註 |
|---|------|------|------|
| 3.1 | `decisionArtifactBuilder.js` — 建構 decision_brief | ✅ | 從 solver_meta + plan_table + replay_metrics + constraints 產生 summary, recommended action, business impact, risk flags, confidence |
| 3.2 | `evidencePackBuilder.js` — 建構 evidence_pack_v2 | ✅ | source datasets, timestamps, engine versions, calculation logic, artifact inventory, evidence refs |
| 3.3 | `writebackPayloadBuilder.js` — 建構 writeback_payload | ✅ | 8 mutation actions, 7 target systems, idempotency key, approval metadata, mutation summary |
| 3.4 | 註冊新 artifact types 到 `diArtifactContractV1.js` | ✅ | Phase 0 已完成（decision_brief, evidence_pack_v2, writeback_payload） |
| 3.5 | orchestrator `_completeTask` 產出三份 artifact + SSE publish | ✅ | 非阻塞 best-effort，worklog 記錄 has_decision_brief/has_evidence_pack/has_writeback_payload |
| 3.6 | `DecisionReviewPanel.jsx` — manager review UI | ✅ | Recommendation, Business Impact KPI tiles, Risk Flags, Mutations table, Evidence, Assumptions, Publish Permissions, 5 decision types |
| 3.7 | `decision_review_card` registered in MessageCardRenderer | ✅ | onResolve → handleDecisionReviewResolution |

### 新增檔案
- `src/services/artifacts/decisionArtifactBuilder.js`
- `src/services/artifacts/evidencePackBuilder.js`
- `src/services/artifacts/writebackPayloadBuilder.js`
- `src/components/review/DecisionReviewPanel.jsx`

### 驗收標準
- [ ] 每個 completed task 都有三份 artifact
- [ ] Artifact schema 完整
- [ ] Manager 只看到 reasoning summary + evidence，不看到 chain-of-thought

---

## Phase 4：KPI Continuous Monitoring（Week 7-8）

### 目標
系統從「事件觸發」升級為「主動監控」。

### 資料模型

#### `kpi_watch_rules`
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | uuid | PK |
| name | text | |
| metric_query | text | 要評估的指標 |
| entity_filter | jsonb | SKU/site/supplier 過濾 |
| threshold_type | text | below, above, drift |
| threshold_value | numeric | |
| severity | text | low, medium, high, critical |
| worker_id | uuid | FK |
| check_interval_minutes | int | |
| cooldown_minutes | int | |
| enabled | boolean | |

### Metric Evaluators
- `inventoryDaysOnHand()` — 庫存天數
- `openPoAging()` — 開立 PO 老化
- `supplierOnTimeRate()` — 供應商準時率
- `forecastAccuracy()` — 預測準確度

### 執行項目

| # | 任務 | 狀態 | 備註 |
|---|------|------|------|
| 4.1 | `kpi_watch_rules` + `kpi_breach_log` Supabase migration | ✅ | `20260331_kpi_monitoring.sql` — 2 tables, indexes, RLS |
| 4.2 | `metricEvaluators.js` — 4 core evaluators + threshold checker | ✅ | inventory_days_on_hand, open_po_aging, supplier_on_time_rate, forecast_accuracy + entity filter |
| 4.3 | `kpiMonitorService.js` — JS monitor daemon, breach→event_queue | ✅ | pollOnce, evaluateRule, cooldown, injectable dataProvider |
| 4.4 | `kpiWatchClient.js` — CRUD + breach history + stats | ✅ | listWatchRules, createWatchRule, toggleWatchRule, listBreaches, resolveBreach, getBreachStats |
| 4.5 | `KpiWatchPanel.jsx` — rule CRUD + breach history UI | ✅ | CreateRuleForm, MonitorStatusBadge, SeverityBadge, expandable rule details, breach resolution |
| 4.6 | 測試 | ✅ | 29 tests — 4 evaluators, threshold checking, registry, entity filter |

### 新增檔案
- `supabase/migrations/20260320_kpi_monitoring.sql`
- `src/services/metricEvaluators.js`
- `src/ml/api/kpi_monitor.py`
- `src/components/monitor/KpiWatchPanel.jsx`

### 驗收標準
- [ ] KPI 規則可 CRUD
- [ ] Breach 自動轉成 event
- [ ] Event 進一步建立 task
- [ ] 全程不需人工手動發問

---

## Phase 5：Approval Gate + Writeback 準備（Week 9）

### 目標
做成「可批准的行動閉環」。

### v1 只做兩種輸出
1. `spreadsheet_export` — Excel/CSV 匯出
2. `erp_adapter_payload` — JSON 結構化 payload（先不直連 ERP）

### Review Contract
```json
{
  "decision": "approved | rejected | revision_requested",
  "review_notes": "...",
  "approved_actions": [...],
  "rejected_actions": [...],
  "publish_permission": { "export": true, "writeback": false }
}
```

### Approval Policy（per worker template）
- 哪些 action 需要 approval
- 金額/風險閾值 → 升級審批
- 哪些 channel 可自動發送
- 哪些 target 不能直寫

### 執行項目

| # | 任務 | 狀態 | 備註 |
|---|------|------|------|
| 5.1 | `approvalGateService.js` — review gate enforcement + publish guard | ✅ | enforceApprovalGate, submitResolution, policy registry, autonomy-gated auto-approve |
| 5.2 | `publishService.js` — export + writeback dispatch with idempotency | ✅ | publishSpreadsheetExport, publishWriteback, deduplication, approval metadata application |
| 5.3 | orchestrator review_gate — publish-phase steps blocked until approved | ✅ | classifyStepPhase→PUBLISH → enforceApprovalGate → AWAITING_APPROVAL if blocked |
| 5.4 | writeback payload idempotency key validation | ✅ | validateIdempotencyKey, _publishedKeys dedup registry |
| 5.5 | publish_failed terminal state + retry (Phase 1 already added) | ✅ | PUBLISH_FAILED state + RETRY transition in taskStateMachine.js |
| 5.6 | Review contract (Phase 0 already built) + approval policy factory | ✅ | reviewContract.js: createApprovalPolicy, checkApprovalGate, getDefaultApprovalRules |

### 驗收標準
- [ ] 未批准時不可 publish/writeback
- [ ] 批准後由 orchestrator 唯一推進
- [ ] Writeback payload 含 idempotency key
- [ ] Writeback 失敗進入 publish_failed

---

## Phase 6：ROI Tracking + Dashboard（Week 10）

### 目標
把「有幫助」變成「有價值證明」。

### 資料模型

#### `value_events`
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | uuid | PK |
| task_id | uuid | FK |
| worker_id | uuid | FK |
| value_type | text | stockout_prevented, cost_saved, time_saved_hours |
| value_amount | numeric | |
| confidence | numeric | 0-1 |
| calculation_method | text | |
| baseline_reference | jsonb | |
| created_at | timestamptz | |

### ROI Calculators
- `estimateStockoutPreventionValue(atRiskUnits, margin, probability, avoidedDays)`
- `estimateCostSavings(optimizedCost, baselineCost)`
- `estimateTimeSaved(workflowType, standardManualHours, completionConfidence)`

### 執行項目

| # | 任務 | 狀態 | 備註 |
|---|------|------|------|
| 6.1 | `value_events` Supabase migration | ✅ | `20260401_value_events.sql` — 7 value types, confidence, baseline_reference, evidence_refs |
| 6.2 | `roiCalculators.js` — 4 calculators + aggregate extractor + summary | ✅ | stockout_prevented, cost_saved, time_saved_hours, revenue_protected + extractValueEvents + summarizeValueEvents |
| 6.3 | `valueTrackingService.js` — 掛在 _completeTask() 後 | ✅ | recordTaskValue → extractValueEvents → supabase insert; getWorkerROISummary (MTD/YTD/all) |
| 6.4 | `ROIDashboard.jsx` — MTD/YTD value, trend, per-task detail | ✅ | TotalValueCard, ValueBreakdown (bar), RecentEventsList with drill-down |
| 6.5 | orchestrator wiring: _completeTask → recordTaskValue | ✅ | best-effort, non-blocking |

### 驗收標準
- [ ] 特定 workflow 完成後寫入 value_event
- [ ] ROI dashboard 與 task detail 可互相 drill-down
- [ ] 銷售/demo 可直接展示 value evidence

---

## Phase 7：Integration Hardening（Week 11-12）

### 執行項目

| # | 任務 | 狀態 | 備註 |
|---|------|------|------|
| 7.1 | spreadsheet_export schema 穩定化 | ✅ | `exportSchemaValidator.js` — 10 canonical columns, validation, normalization, CSV export |
| 7.2 | erp_adapter_payload schema 固定化 | ✅ | `erpAdapterPayload.js` — SAP MM IDoc, Oracle SCM, generic REST + SAP IDoc fixtures |
| 7.3 | Idempotency 機制（完整） | ✅ | `idempotencyService.js` — composite key registry, lock acquisition, stale detection (>5min), status tracking |
| 7.4 | Retry / failure recovery | ✅ | `publishRecoveryService.js` — exponential backoff (max 3×, 1s→30s), idempotency-protected, non-retryable error detection |
| 7.5 | Audit log 完整化 | ✅ | `auditTrailService.js` — 16 event types, full trail builder, completeness scoring |
| 7.6 | Integration hardening tests | ✅ | `hardening.test.js` — 69 tests covering all 5 services |
| 7.7 | Execution plan + memory updated | ✅ | |

### 新增檔案
- `src/services/hardening/exportSchemaValidator.js`
- `src/services/hardening/erpAdapterPayload.js`
- `src/services/hardening/idempotencyService.js`
- `src/services/hardening/publishRecoveryService.js`
- `src/services/hardening/auditTrailService.js`
- `src/services/hardening/hardening.test.js`

### 驗收標準
- [x] Export schema 穩定 — 10 canonical columns + validation + normalization
- [x] Payload 可回放 — SAP IDoc + Oracle SCM + generic transforms
- [x] 失敗可重試且不重複寫入 — idempotency + exponential backoff
- [x] 完整審計紀錄 — 16 event types + completeness scoring

---

## Phase 8：Multi-Worker Collaboration（v1 後，延後）

### 模式
1. **Sequential handoff**：Planning → Risk → Procurement
2. **Parallel fan-out**：同事件派多 worker 平行分析
3. **Escalation**：低層 worker 升級到 coordinator

### 資料表：`task_delegations`
- parent_task_id, parent_worker_id, child_task_id, child_worker_id
- delegation_type (handoff | fan_out | escalation)
- context_json, status

> ⚠️ 單 worker 閉環未穩定前不應開始此 phase

---

## 前端介面規劃

| 介面 | 用途 | Phase |
|------|------|-------|
| **Task Board** | event-triggered tasks, stage, approval queue | Phase 1-2 |
| **Monitor Dashboard** | KPI watches, breaches, events, auto-created tasks | Phase 4 |
| **Decision Review Panel** | recommended action, scenario, risk, evidence, approve/reject | Phase 3 |
| **ROI Dashboard** | MTD/YTD value, stockouts prevented, hours saved, trend | Phase 6 |
| **Synthetic ERP Sandbox** | demo/QA/regression: generate events, replay scenarios | Phase 2 |

---

## 核心原則（必讀）

1. **不動既有護城河** — MILP solver, BOM explosion, quantile forecast, constraint checker, inventory replay, CFR 不重寫。LLM 只負責理解任務、組裝流程、解釋結果。
2. **不造新模型** — 差異化來自 domain engine，不來自自訓 LLM。
3. **單一 task owner** — `orchestrator.js` 保持為 task state 唯一擁有者。
4. **先 approval，再自動化** — v1 對外發送與 writeback 預設都要 approval。
5. **Chat 降級為次要介面** — 主介面為 Task Board / Monitor / ROI Dashboard / Review Panel。

---

## 風險與避坑

| # | 風險 | 對策 |
|---|------|------|
| 1 | 太早做 multi-worker | 單 worker 閉環穩定前不開始 Phase 8 |
| 2 | Chat 繼續主導產品 | 首頁/demo 必須展示 Task Board + Monitor，不是聊天框 |
| 3 | 只做 alert 不做 action | 必須產出 decision_brief + writeback_payload，不只是通知 |
| 4 | 先做真 ERP 深整合 | 先做 payload schema + approval + idempotency，再接真 ERP |
| 5 | ROI 只做外表 | 任務完成時就要寫 value_event，不是事後補 |
| 6 | Evidence 缺失 | 每個建議都要有來源、版本、計算邏輯、影響範圍 |

---

## v1 不做清單

- ❌ Fully autonomous external action
- ❌ 複雜 multi-worker mesh
- ❌ 大規模 ERP connector framework
- ❌ No-code workflow builder
- ❌ Chat-only product experience (product is task-driven digital worker)
