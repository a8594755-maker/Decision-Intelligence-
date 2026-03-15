# B2B AI Digital Worker PRD

**產品名稱：** Decision Intelligence Digital Worker Platform  
**文件類型：** Product Requirements Document  
**文件版本：** 1.0  
**更新日期：** 2026-03-15  
**狀態：** Draft

---

## 1. 願景

打造一個可被企業正式部署、管理、審核與擴編的 `B2B AI Digital Worker` 平台。

這個產品不是聊天機器人，也不是單點 workflow automation。它應該像一位數位員工：

- 有明確職稱與角色
- 有權限邊界與可用工具
- 能從非結構化訊號中理解任務
- 能把任務拆解成可執行步驟
- 能透過公司批准的工具完成工作
- 能依公司風格與規範交付成果
- 能在高風險步驟主動停下來讓主管審核
- 能保留完整執行與決策紀錄，方便回放與追責

---

## 2. 產品定位

### 2.1 對外定位

`AI Digital Worker Platform for Enterprise Operations and Analytics`

平台讓企業部署一位或多位數位員工，而不是只提供聊天介面或自動化腳本。

### 2.2 對內定義

Digital Worker = 有角色、任務佇列、工具能力、治理規則、記憶系統、績效指標的 agentic execution unit。

### 2.3 與市場上「自動化工具」的差異

| 類型 | 核心價值 | 限制 |
|------|----------|------|
| Chatbot / Copilot | 回答問題、輔助思考 | 不擁有工作，不負責交付 |
| Workflow automation | 執行固定流程 | 對模糊任務與非結構化訊號適應差 |
| RPA | 模擬點擊與規則式流程 | 維護成本高，對知識工作弱 |
| Digital Worker | 理解任務、用工具做事、交付成果、可審計 | 需要角色邊界、治理與評估體系 |

---

## 3. 問題陳述

企業中大量知識工作其實具備以下特徵：

- 任務來源分散於 email、Slack、例會錄音、表單與排程
- 輸入常常是不完整或半結構化的描述
- 執行過程需要跨多個工具
- 成果必須符合公司風格、KPI 定義與受眾期待
- 管理者最在意的是可追蹤、可覆核、可控風險

現有 AI 產品大多只能做到以下其中一部分：

- 幫人寫文字
- 幫人查資料
- 幫人跑單一步驟自動化

但它們通常缺少：

- 任務級 ownership
- 企業權限邊界
- 審核與回放能力
- 持續學習公司做事方式的機制

這正是 Digital Worker 的產品空間。

---

## 4. 產品策略

### 4.1 平台願景

長期產品是 `Digital Worker Platform`，可支援多種 worker 類型：

- Analytics Worker
- RevOps Worker
- Supply Planning Worker
- Procurement Worker
- PMO Worker

### 4.2 v1 Beachhead

v1 不做泛用萬能員工，先做一位能正式上線的 `Analytics Digital Worker`。

原因：

- 任務高頻且價值明確
- 工具鏈相對清楚：SQL、BI、Excel、Docs、Slides、Email
- 容易切出高頻任務模板
- 容易衡量效率與品質提升
- 與現有 repo 的能力方向最接近

### 4.3 v1 對外敘事

我們賣的是 `AI Digital Worker`。

我們第一位上線的數位員工是 `Analytics Digital Worker`，可接手分析團隊的大量重複性與半結構化工作，並在企業治理要求下交付結果。

---

## 5. 目標客群與 ICP

### 5.1 企業條件

- 100 至 5000 人的中型到大型企業
- 已有基本數據基礎建設
- 依賴分析、報表、營運協調或規劃流程
- 對資料安全、審批與稽核有要求

### 5.2 優先部門

- Analytics / BI
- RevOps
- Supply Chain Planning
- Strategy / Operations

### 5.3 經濟買家

- Head of Analytics
- COO
- RevOps Lead
- Supply Chain Director
- VP Operations
- CIO / Head of AI Transformation

### 5.4 主要使用者

- Team manager：分派、審批、覆核、追蹤績效
- Individual contributor：與 worker 協作、補充上下文、修正輸出
- Admin / IT：管理權限、工具、稽核政策、部署方式

---

## 6. Jobs To Be Done

### 6.1 Functional Jobs

- 從 email、會議逐字稿、chat 訊息中辨識工作任務
- 將模糊任務轉成標準化 work order
- 執行資料拉取、清理、分析、整理與輸出
- 產出符合公司格式的報告、簡報、摘要與後續 action items
- 在必要時向人類請求審批或補充資訊
- 將每次工作結果與回饋保存，讓後續表現更穩定

### 6.2 Emotional Jobs

- 讓 manager 感到「可放心委派」
- 讓使用者感到「不是黑盒」
- 讓 IT / Security 感到「可控且可審」

### 6.3 Social Jobs

- 讓團隊在不增加 headcount 的情況下提高交付能力
- 讓主管能以「管理員工」的方式管理 AI，而不是管理一堆 prompt 與腳本

---

## 7. 核心產品原則

### 7.1 Tool-first，不是 raw-data-first

AI 以工具操作為主，盡量不直接處理完整敏感資料。

模型可見內容優先順序：

1. schema 與 metadata
2. 欄位說明與語意 mapping
3. 脫敏 sample
4. 聚合結果
5. 工具執行後的批准輸出

### 7.2 Review by default for high-risk actions

對外寄信、寫回系統、正式發布、首次新工具執行、低信心結論等高風險動作，預設進入 review gate。

### 7.3 Learn style, not blindly imitate history

產品要學會公司風格，但不能被舊文件綁死。

風格學習原則：

- 優先學結構、語氣、必備欄位、KPI 呈現方式
- 允許提出有限優化
- 偏離既有風格時要能說明原因

### 7.4 Every meaningful step must be inspectable

每個重要步驟都需要可檢視：

- 任務如何被理解
- 為何採取該計畫
- 呼叫了哪些工具
- 產生了哪些 artifacts
- 哪裡被修改過
- 誰核准了最終結果

### 7.5 Start narrow, scale via worker templates

先做單一 worker 成功，再擴展為多 worker 平台。

---

## 8. 產品範圍

### 8.1 In Scope for v1

- 單一 worker 類型：Analytics Digital Worker
- 任務來源：email、meeting transcript、手動輸入、排程
- 核心工具：SQL、BI export、Excel、Docs/Slides、Email draft
- 任務流程：辨識、分解、執行、審核、交付、記憶
- 風格學習：style guide + approved exemplars + feedback memory
- 治理：權限、審批、audit trail、artifact replay
- 管理面板：task inbox、execution timeline、review console、worker performance

### 8.2 Out of Scope for v1

- 任意職能的通用型數位員工
- 完整無人值守的高風險自動執行
- 無邊界的原始資料讀寫權
- 長期自行修改核心治理規則
- 完整取代資深分析師的判斷工作

---

## 9. 目標使用情境

### 9.1 情境 A：Weekly Business Review Prep

輸入：

- 週會錄音逐字稿
- 上週報表與本週 KPI 更新
- 主管口頭要求

輸出：

- KPI 摘要
- 異常變動分析
- 會議簡報初稿
- 待跟進 action items

### 9.2 情境 B：Recurring Report Production

輸入：

- 排程觸發
- 固定 SQL / BI 查詢
- 歷史範本

輸出：

- 標準週報 / 月報
- 指標 commentary
- 對外或對內版報告草稿

### 9.3 情境 C：Ad Hoc Analysis from Email

輸入：

- 主管 email：「幫我看這週 conversion 掉了什麼原因，下午四點前給我」

輸出：

- 任務拆解
- 需要資料來源
- 初步分析結果
- 圖表與說明
- 後續建議

### 9.4 情境 D：Post-meeting Follow-through

輸入：

- 例會錄音或 transcript

輸出：

- 任務列表
- owner / due date 建議
- 需要補資料的項目
- 下次更新所需的標準資料請求

---

## 10. 主要角色與需求

### 10.1 Manager

需求：

- 快速看懂 worker 在做什麼
- 在關鍵點批准或退回
- 追蹤任務狀態與 SLA
- 了解 worker 哪些地方做得好或常錯

成功條件：

- 願意把中低風險工作正式委派給 worker

### 10.2 Analyst / Operator

需求：

- 不必從零開始做重複性工作
- 可以接手半成品繼續修
- 可以補 context，而不是重寫一遍

成功條件：

- 覺得 worker 產出值得編輯，而不是值得重做

### 10.3 Admin / IT / Security

需求：

- 管理工具權限
- 設定資料與外部系統邊界
- 查詢所有審計事件與執行紀錄

成功條件：

- 願意讓此產品接入正式企業環境

---

## 11. 使用者旅程

### 11.1 任務生命周期

1. 系統收到任務訊號
2. Worker 建立候選任務
3. 系統判定任務類型、風險與是否需要人工確認
4. Worker 生成執行計畫
5. Worker 逐步調用工具完成作業
6. 每一步產生 artifacts 與執行紀錄
7. 高風險或低信心步驟進入 review hold
8. Manager 批准、退回或修改
9. Worker 交付最終成果
10. 系統寫入記憶、回饋、評估與績效

### 11.2 使用者體驗主軸

- `Task Inbox`：看到有哪些工作待處理
- `Execution Timeline`：看到 worker 做了哪些步驟
- `Review Console`：看到需要批的內容與差異
- `Knowledge / Style Vault`：管理風格與範本
- `Worker Performance Dashboard`：看任務完成率、審批率、常見錯誤

---

## 12. 核心模組

### 12.1 Worker Identity Layer

定義每位 worker 的：

- 角色名稱
- 所屬部門
- 可處理任務類型
- 可使用工具集合
- 權限等級
- review policy
- KPI

### 12.2 Task Intake Layer

負責：

- 接收 email / transcript / chat / schedule / API webhook
- 做任務抽取
- 做優先級與截止時間判定
- 建立 work order

### 12.3 Planner / Manager Brain

負責：

- 任務分類
- 步驟拆解
- 工具選擇
- success criteria 定義
- 風險判定
- 是否要求人工審批

### 12.4 Tool Gateway

受控工具層，提供標準能力介面：

- SQL runner
- Python analysis runner
- BI export bridge
- Spreadsheet ops
- Docs / Slides writer
- Email draft / send
- Internal API connectors

所有工具需要：

- 明確 I/O schema
- 權限控制
- timeout / retry policy
- execution log

### 12.5 Execution Loop

負責：

- 按步驟執行
- 鏈接前一步 artifacts
- 寫入 step state
- 在 review hold 暫停
- 支援 retry / revise / replay

### 12.6 Style and Memory Layer

由三種記憶構成：

- `Policy memory`：名詞表、禁語、KPI 定義、格式規則
- `Exemplar memory`：已批准輸出範本
- `Execution memory`：歷史任務結果、修改與 feedback

### 12.7 Review and Governance Layer

提供：

- approval / reject / revise
- step diff
- artifact replay
- audit logs
- permission policy
- worker activity records

### 12.8 Evaluation Layer

評估：

- 任務理解是否正確
- 工具是否選對
- artifacts 是否完整
- 輸出是否符合風格與品質要求
- manager 修改量是否下降

---

## 13. 功能需求

### 13.1 任務辨識

系統必須能從下列來源抽取候選任務：

- email thread
- meeting transcript
- chat message
- schedule trigger
- manual instruction

系統必須輸出：

- 任務標題
- 任務摘要
- 任務類型
- 期望輸出
- deadline
- 風險等級
- 需要人工確認與否

### 13.2 任務分解

系統必須能將任務轉為多步驟執行計畫，每步驟應包含：

- step name
- step type
- input context
- tool requirement
- expected output
- review gate requirement

### 13.3 工具使用

系統必須：

- 僅能使用已註冊與批准工具
- 在高風險場景要求額外批准
- 為每次執行保留 tool call trace
- 記錄輸入參數摘要與輸出 artifact

### 13.4 風格控制

系統必須能根據：

- 受眾類型
- 報告類型
- 公司語氣規範
- 部門模板

產出符合 house style 的內容。

### 13.5 審批與修正

Manager 必須可以：

- approve
- request revision
- reject
- 回看每一步 artifact
- 比對前後版本差異

### 13.6 記憶與學習

系統必須能保存：

- 成功與失敗案例
- manager feedback
- 常見修正類型
- 常用工具組合
- 任務完成 KPI

### 13.7 稽核與回放

系統必須能查詢：

- 任務何時建立
- 如何被理解
- 用了哪些工具
- 生成了哪些 artifacts
- 哪一步被暫停或修正
- 誰做出最後批准

---

## 14. 非功能需求

### 14.1 Security

- 支援細粒度角色與權限控制
- 盡量以工具代理模式存取資料
- 高敏感資料不直接暴露給模型
- 所有對外整合必須有可撤銷 credential

### 14.2 Reliability

- 任務執行可中斷後恢復
- 每步驟皆有狀態持久化
- 失敗步驟可重試或改寫後重跑

### 14.3 Explainability

- 每個關鍵決策與工具執行皆保留 trace
- 可快速切回人工作業

### 14.4 Observability

- 任務吞吐量
- step latency
- tool success rate
- retry rate
- approval rate
- revision rate

### 14.5 Extensibility

- 新 worker 類型應能重用共用 orchestration 與 governance 基礎設施
- 新工具應能以 registry 方式接入

---

## 15. Autonomy Model

為避免一開始就陷入全自動風險，worker 自主等級分為四層：

| 等級 | 名稱 | 行為 |
|------|------|------|
| A1 | Suggest | 只提議任務與執行計畫 |
| A2 | Assist | 執行低風險步驟，交由人類完成最終交付 |
| A3 | Execute with approval | 完成大部分工作，高風險步驟需要審批 |
| A4 | Controlled autonomy | 在明確邊界下可自主完成固定類型任務 |

v1 目標是讓核心情境達到 `A2 -> A3`，而不是全面追求 A4。

---

## 16. 資料與風格學習策略

### 16.1 資料策略

不以「把所有檔案丟給模型」作為預設方案，而以分層 context 為原則：

- schema 與欄位定義
- 脫敏樣本
- 指標定義
- 歷史 approved artifacts
- policy / glossary / formatting rules

### 16.2 風格學習策略

先做：

- style guide retrieval
- exemplar retrieval
- output rubric
- manager feedback tagging
- evals

只有在固定高頻輸出任務已證明有穩定樣式需求時，才評估 fine-tuning。

### 16.3 輸出策略

對於重要內容，系統可同時產出兩種版本：

- `House-style draft`
- `Suggested improvement version`

讓使用者在保持一致性的同時，仍有優化空間。

---

## 17. 成功指標

### 17.1 North Star

`每位 Digital Worker 每週成功交付且被接受的任務數`

### 17.2 Product Metrics

- 任務自動完成率
- 首次交付接受率
- 平均人工介入次數
- 平均 turnaround time
- Manager approval rate
- Revision rate
- Artifact completeness rate
- 工具調用成功率
- 重複任務成本下降幅度

### 17.3 Trust Metrics

- 可回放任務比例
- 有完整 trace 的步驟比例
- 高風險任務誤自動執行率
- 使用者對輸出信任度

### 17.4 Business Metrics

- Team-level seat expansion
- Cross-team expansion
- 90 天留存
- 每帳戶每月活躍任務量

---

## 18. v1 核心交付

### 18.1 Product Deliverables

- Analytics Digital Worker 基礎角色
- Task inbox
- Intake from email / transcript / manual instruction
- Multi-step execution timeline
- Approved tool registry
- Review console
- Style vault
- Audit trail and replay
- Worker performance dashboard

### 18.2 系統交付

- Worker identity model
- Task / step / run data model
- Tool registry and permission model
- Style / exemplar retrieval path
- Review hold and approval flow
- Task memory and manager feedback loop

### 18.3 上線標準

- 至少 3 個高頻情境可穩定執行
- 任務與步驟皆有 trace
- 高風險動作皆可被 gating
- Manager 能在單一介面完成覆核
- 可量化回報節省時間與加速交付

---

## 19. Non-goals

- 不以聊天互動本身作為主要產品價值
- 不追求一開始就取代所有知識工作角色
- 不承諾在沒有 review 的情況下處理高風險任務
- 不允許 agent 無限制讀寫企業資料
- 不將歷史文件當作唯一正確答案

---

## 20. 風險與應對

| 風險 | 說明 | 應對 |
|------|------|------|
| 任務範圍過寬 | 產品容易變成泛用 agent demo | 先鎖定單一 worker 與 3 個核心情境 |
| 企業不信任 | 無法正式導入高價值工作 | 先把 review、audit、permissions 做完整 |
| 風格學習失真 | 輸出看似合理但不符合公司慣例 | 用 exemplar + rubric + feedback loop 控制 |
| 工具失控 | agent 做出未授權動作 | 工具白名單、分級權限、policy gate |
| 評估不足 | 看似能跑 demo，但無法規模化 | 建立任務級與 trace 級 evals |

---

## 21. Roadmap

### 21.1 0-30 天

- 定義 `Analytics Digital Worker` 角色
- 鎖定 3 個高頻情境
- 建立 task intake schema
- 建立 review console 最小版本
- 建立 style vault 與 exemplar ingestion 規格

### 21.2 31-60 天

- 接入 email / transcript intake
- 接入 SQL / BI / Excel / Docs 工具
- 建立 task memory 與 feedback loop
- 完成 audit trail 與 artifact replay
- 建立 v1 KPI dashboard

### 21.3 61-90 天

- 在設計夥伴帳戶上線
- 驗證 A2 / A3 autonomy 模式
- 收集 manager revision data
- 優化 style retrieval 與 task routing
- 決定下一位 worker 或下一個部門模板

---

## 22. 與現有系統方向的對齊

若以目前 repo 能力來看，以下方向可直接延伸為 Digital Worker 基礎設施：

- agent loop orchestration
- review hold / revise / retry
- tool registry
- dynamic / registered tool execution
- task memory
- audit trail
- artifact export

因此，現有系統不是需要推倒重來，而是需要從「AI 功能集合」進一步收斂為「有角色、任務入口、治理與績效系統的 Digital Worker 平台」。

---

## 23. 一句話總結

**Decision Intelligence Digital Worker Platform 是一個讓企業部署可管理、可審核、可擴編的數位員工系統；v1 以 Analytics Digital Worker 為第一位正式上線的數位員工。**
