# Digital Worker 系統架構差距分析

**對照文件：** [DIGITAL_WORKER_PRD_zh-TW.md](./DIGITAL_WORKER_PRD_zh-TW.md)  
**文件類型：** Architecture Gap Analysis  
**文件版本：** 1.0  
**更新日期：** 2026-03-15  
**狀態：** Draft

---

## 1. 結論摘要

從目前 repo 來看，你已經不是從零開始做 Digital Worker。

現有系統已具備幾個非常重要的骨架：

- 多步驟執行與 step state 持久化
- 人工 review hold / revise / retry
- 工具註冊、動態工具、權限控管
- 任務記憶、audit trail、artifact export
- 基礎的 employee / tasks / review / tools UI

這代表你距離 `Digital Worker demo` 已經不遠。

但距離 `可正式部署的 B2B Digital Worker 平台`，還有幾個架構級缺口。

最大問題不是功能少，而是：

**目前 repo 同時存在兩套 AI Employee 主幹架構，造成狀態模型、任務流、UI 與資料層沒有真正收斂。**

如果不先定主幹，後面再加 email、style、governance、worker template，只會讓系統越來越難收斂。

---

## 2. 當前架構現況

### 2.1 已存在的主要 Digital Worker 能力

| 能力 | 現況 | 代表模組 |
|------|------|----------|
| Worker 資料模型 | 已有基礎 | `src/services/aiEmployeeService.js`, `src/services/aiEmployee/persistence/employeeRepo.js` |
| Task / Step / Run | 已有 | `src/services/agentLoopService.js`, `src/services/aiEmployee/orchestrator.js`, `src/services/aiEmployeeExecutor.js` |
| Planner / Task decomposition | 已有 | `src/services/chatTaskDecomposer.js`, `src/services/aiEmployee/planner.js` |
| Tool registry / dynamic tools | 已有 | `src/services/toolRegistryService.js`, `src/services/dynamicToolExecutor.js` |
| Tool permission guard | 已有 | `src/services/toolPermissionGuard.js` |
| Review center | 已有初版 | `src/pages/EmployeeReviewPage.jsx`, `src/services/approvalWorkflowService.js` |
| Task board / employee workspace | 已有初版 | `src/pages/EmployeesPage.jsx`, `src/pages/EmployeeTasksPage.jsx` |
| Memory / worklog / KPI | 已有部分 | `src/services/aiEmployeeMemoryService.js`, `src/services/dailySummaryService.js` |
| Audit trail | 已有部分 | `src/services/auditService.js` |
| Scheduled / proactive tasks | 已有部分 | `src/services/scheduledTaskService.js`, `src/services/proactiveTaskGenerator.js` |

### 2.2 當前產品本質

現在的 repo 本質上比較像：

`AI Employee for supply-chain and analysis workflows`

而不是：

`General-purpose Digital Worker Platform`

這不是壞事。這代表你已有一個可收斂為第一位 worker 的基礎。

但要升級成 PRD 中定義的產品，必須補齊平台層概念與治理主幹。

---

## 3. PRD 對照矩陣

狀態定義：

- `Strong`：已有清楚骨架，可直接延伸
- `Partial`：有零件，但尚未形成完整產品能力
- `Missing`：目前缺少第一級架構或產品面

| PRD 能力區塊 | 現有 repo 映射 | 狀態 | 差距摘要 |
|--------------|----------------|------|----------|
| Worker Identity Layer | `aiEmployeeService`, `employeeRepo`, `EmployeesPage` | Partial | 目前幾乎等於單一 Aiden 實作，沒有 worker template 與多角色模型 |
| Task Intake Layer | `DecisionSupportView`, `chatTaskDecomposer`, `scheduledTaskService`, `proactiveTaskGenerator` | Partial | 有 chat、schedule、alert intake，沒有 first-class email / meeting / queue ingestion |
| Work Order Normalization | `chatTaskDecomposer`, `planner.js` | Partial | 可拆步，但缺少統一 work order schema 與 task source normalization pipeline |
| Planner / Manager Brain | `chatTaskDecomposer`, `aiEmployee/planner.js` | Partial | 已能分解任務，但仍偏 workflow decomposition，不是真正 manager-grade planning layer |
| Tool Gateway | `toolRegistryService`, `dynamicToolExecutor`, `toolPermissionGuard`, builtin executors | Strong | 受控工具與權限骨架已存在，但仍缺資料政策層與 capability abstraction |
| Execution Loop | `agentLoopService`, `aiEmployee/orchestrator.js`, `AgentExecutionPanel` | Strong | 多步執行、review hold、artifact chaining 已具備，但主幹尚未收斂到單一 stack |
| Review / Governance | `EmployeeReviewPage`, `approvalWorkflowService`, `planGovernanceService` | Partial | 有多個 review 機制，但分散於不同 flow，尚未形成統一 manager console |
| Style / Memory Layer | `aiEmployeeMemoryService` | Partial | 有 outcome memory，缺 company policy memory、exemplar vault、style retrieval |
| Audit / Replay | `auditService`, artifact refs, review UI | Partial | 有 trace 與 artifact，但不是完整任務級 replay 與 cross-system audit spine |
| Worker Performance | `EmployeesPage`, `dailySummaryService`, `modelRoutingService` | Partial | 有 KPI 與 cost，但缺 trust metrics、autonomy metrics、quality scorecard |
| Multi-worker Platform | 局部命名存在，但實作上沒有 | Missing | 當前仍是單 employee product，不是 worker template platform |

---

## 4. 核心優勢

以下部分已經非常接近 PRD 所需能力，應視為可沿用資產，而不是重做：

### 4.1 Execution Spine 已成形

你已有：

- `review_hold`
- `_prior_step_artifacts`
- step-level 狀態
- retry / revise / continue
- artifact refs

這些正是 Digital Worker 的 execution spine。

代表模組：

- `src/services/agentLoopService.js`
- `src/services/aiEmployee/orchestrator.js`
- `src/components/chat/AgentExecutionPanel.jsx`

### 4.2 Tooling Spine 已成形

你已經不是單純 prompt-based AI。

你有：

- approved tool registry
- dynamic tool sandbox
- builtin tools
- python tools
- workflow permission guard

代表模組：

- `src/services/toolRegistryService.js`
- `src/services/dynamicToolExecutor.js`
- `src/services/toolPermissionGuard.js`
- `src/services/aiEmployee/executors/*`

### 4.3 管理者工作台雛形已存在

你已有：

- employee overview
- tasks page
- review page
- tool library

代表模組：

- `src/pages/EmployeesPage.jsx`
- `src/pages/EmployeeTasksPage.jsx`
- `src/pages/EmployeeReviewPage.jsx`
- `src/pages/ToolRegistryPage.jsx`

### 4.4 Memory / KPI / Cost 已有最小基礎

你已經開始把 worker 視為一個要被管理與衡量的執行單位，而不只是一次性 conversation。

代表模組：

- `src/services/aiEmployeeMemoryService.js`
- `src/services/dailySummaryService.js`
- `src/services/modelRoutingService.js`

---

## 5. P0 架構缺口

以下是最先要解決的結構性問題。

### 5.1 兩套 AI Employee 主幹並存

**現象**

repo 內同時存在：

- 舊主幹：`aiEmployeeService + aiEmployeeExecutor + agentLoopService`
- 新主幹：`aiEmployee/orchestrator + planner + state machines + repos`

而且兩者都還在被使用：

- `DecisionSupportView` 已導入 `aiEmployee/index.js`
- `EmployeeTasksPage` 仍使用 `aiEmployeeService.createTask()` 與 `executeTaskWithLoop()`
- `EmployeeReviewPage` 仍直接操作 `agentLoopService`

**影響**

- 狀態模型不一致
- Review 行為不一致
- UI 與資料層耦合到不同主幹
- 後續要加 email intake / style vault / worker template 時，會不知道該掛哪一條主幹

**判斷**

這是目前最大的架構風險。

**建議**

選定 `aiEmployee/orchestrator` 為唯一主幹，逐步收斂以下能力到同一套狀態機與 repo：

- task creation
- plan approval
- step execution
- review continuation
- task retry / cancel
- manager console 資料讀取

### 5.2 Worker Identity 仍是單一 Aiden 實作

**現象**

`aiEmployeeService.getOrCreateAiden()` 會直接建立一位名為 `Aiden` 的員工，角色描述仍偏 supply chain analyst。

**影響**

- 產品無法支援多 worker template
- 無法正式定義 `Analytics Worker / RevOps Worker / Supply Planning Worker`
- 權限與 KPI 只能長在單一 employee instance 上

**建議**

新增 `worker_templates` 或等價設定層，將以下內容模板化：

- role
- description
- capability set
- default tools
- policy profile
- autonomy level
- KPI package

### 5.3 任務模型仍偏 dataset-profile-first，而不是 task-first

**現象**

`EmployeeTasksPage` 建立任務時要求 `dataset_profile_id`，`aiEmployeeExecutor` 也大量以 `dataset_profile_id` 為核心前提。

**影響**

- 難以支援 email / meeting / chat 原生任務
- 任務入口被限制成「先有資料集，再派任務」
- 不符合 PRD 中「從非結構化訊號理解任務」的產品方向

**建議**

改成：

- `task-first`
- `source-aware`
- `context gradually attached`

也就是任務先建立成 work order，再逐步補齊 dataset、artifact、schema、tool context。

---

## 6. P1 架構缺口

### 6.1 沒有真正的 Intake Orchestration Layer

目前存在的入口有：

- chat 指令
- schedule
- proactive alerts

但缺少一層統一 intake：

- email connector
- meeting transcript ingestion
- message normalization
- dedup / merge
- priority / SLA / owner extraction
- clarification workflow

PRD 中的 `Task Intake Layer` 目前只完成一半。

### 6.2 Review / Governance 分散

目前 review 能力散在多處：

- `EmployeeReviewPage`
- `approvalWorkflowService`
- `planGovernanceService`
- `agentLoopService` 的 review hold
- `aiEmployee/orchestrator` 的 task state

問題不是沒有 review，而是 review 不在同一個治理框架內。

你需要一個統一的 `Review and Governance Layer`，把以下概念收斂：

- plan approval
- step approval
- output approval
- revision request
- escalation reason
- deadline / SLA
- approval policy

### 6.3 Style / Knowledge Vault 尚未存在

`aiEmployeeMemoryService` 目前保存的是 execution outcome memory：

- success / failure
- KPI
- params
- feedback

但缺少 PRD 所需的三種核心記憶：

- company policy memory
- approved exemplars
- style retrieval context

這意味著系統可以記住「上次跑得好不好」，但還不會真正學會「這家公司怎麼交付東西」。

### 6.4 目前 UI 還不是完整的 Manager Console

現在頁面更像：

- task board
- execution inspector
- review queue

而不是完整的：

- worker dashboard
- queue ownership
- SLA management
- approval inbox
- policy management
- worker performance and trust dashboard

這是產品體驗層的 gap，不是只有 UI 美化問題。

---

## 7. P2 架構缺口

### 7.1 Capability Model 還沒有抽象成平台層

現有系統有多種 tool / workflow 類型：

- builtin_tool
- registered_tool
- dynamic_tool
- python_tool
- report
- export

但它們比較像 executor 類型，而不是平台級 capability model。

Digital Worker 平台更需要的是：

- capability catalog
- policy by capability
- tool binding by worker type
- data access policy by capability

### 7.2 Audit / Replay 還未形成任務級真相來源

你已有 audit event 與 artifact refs，但目前 audit 還沒有成為所有任務 lifecycle 的單一事實來源。

缺的是：

- task-level canonical timeline
- intake source trace
- planning decisions trace
- approval chain trace
- final delivery trace

### 7.3 Metrics 還偏 execution / cost，不夠 product-grade

目前已有：

- tasks completed
- review pass rate
- cost
- daily summary

但還缺少 PRD 中更關鍵的 trust / autonomy 指標：

- first-pass acceptance rate
- manager edit distance
- autonomy level by task type
- replay completeness
- policy violation rate

---

## 8. 推薦目標架構

### 8.1 單一主幹

將 `aiEmployee/orchestrator` 定為唯一任務生命週期 owner。

舊 stack 的功能逐步遷移進去：

- `agentLoopService` 的 review / artifact chaining 能力
- `aiEmployeeService` 的 task / worklog / KPI 讀寫能力
- `aiEmployeeExecutor` 的 executor dispatch

### 8.2 新增 Worker Template Layer

新增平台級實體：

- `worker_templates`
- `worker_capability_profiles`
- `worker_policy_profiles`

把「Aiden」從 hardcoded 員工變成 template 實例。

### 8.3 新增 Intake Layer

新增統一 intake service，專責：

- email / transcript / chat / schedule / alert ingestion
- normalization
- dedup
- work order creation
- clarification state

### 8.4 新增 Style and Knowledge Vault

新增以下實體或服務：

- company style guide store
- approved exemplar index
- retrieval composer
- feedback tagging pipeline

這一層應該在 planner 與 final output generation 之間被使用。

### 8.5 新增 Governance Spine

把所有 approval / review / policy gate 收斂到單一治理層：

- review policies
- approval workflows
- escalation rules
- autonomy ceilings
- audit schema

### 8.6 將 UI 收斂為真正的 Worker Console

由目前四個頁面整併為一個概念完整的 Digital Worker workspace：

- worker dashboard
- task inbox
- execution timeline
- review console
- style vault
- tool and policy admin

---

## 9. 建議實作順序

### Phase 1：定主幹

先解：

1. 選定 `aiEmployee/orchestrator` 為唯一任務生命週期主幹
2. 將 `EmployeeTasksPage`、`EmployeeReviewPage` 接到同一套 state 與 repo
3. 移除對 `executeTaskWithLoop()` 的依賴

### Phase 2：定平台概念

再做：

1. worker template model
2. unified intake layer
3. style / exemplar vault
4. unified governance schema

### Phase 3：補產品價值

最後做：

1. email / meeting transcript 真正接入
2. manager-grade performance dashboard
3. autonomy levels
4. 多 worker 擴張

---

## 10. 最終判斷

如果只看 repo 現況，你已經有能力做出：

**一位可執行、多步驟、可審核、可回放的 AI Employee**

但還沒有真正做到：

**一個可管理、可擴編、可定義多角色的 B2B Digital Worker Platform**

差距的核心不是模型能力，也不是缺少某個工具。

差距的核心是：

- 主幹架構未收斂
- worker identity 未平台化
- task intake 未一級化
- style / governance 未形成正式系統層

只要先把這四件事定下來，後面的 email、meeting、公司風格學習、審批與績效，才會變成系統化擴張，而不是一直加功能。
