# Competitive Digital Worker Strategy

**文件類型：** Product Strategy  
**版本：** 1.0  
**更新日期：** 2026-03-16  
**狀態：** Active

---

## 1. 先講結論

不要再把產品賣成泛用 `AI Employee Platform`。

在目前市場條件下，這種敘事會直接和：

- ChatGPT agent / apps / MCP
- Microsoft Copilot Studio
- Salesforce Agentforce
- Glean 類 enterprise agent

正面競爭，而這些產品在通用 agent、connector、chat、搜尋、排程、admin controls 上的商品化速度更快。

**Decision Intelligence 應該改賣：**

`Supply Chain Decision Worker`

更精準一點：

`A managed digital worker for forecast → plan → risk → review → writeback loops`

也就是不是幫使用者「聊一聊」，而是幫主管和 planner 「接手一整段高頻、可驗證、可審批的決策流程」。

---

## 2. 為什麼這樣才有競爭力

### 2.1 不能當 commodity 的層

以下能力已經快速商品化，不能當主賣點：

- chat UI
- 通用 task decomposition
- generic agent loop
- 檔案上傳與摘要
- 一般 connector 故事
- 「會用工具」這種空泛敘事

如果產品對外故事停在這裡，客戶很容易直接回：

`ChatGPT / Copilot 也能做。`

而且他們是對的。

### 2.2 還有機會形成 moat 的層

Decision Intelligence 真正有機會建立防守的，是以下這些能力的組合：

- 供應鏈專用的 forecast / plan / risk / inventory / negotiation 決策鏈
- 每一步都有 artifact，不只是一段文字答案
- human review / approval / replay completeness / trust metrics
- worker 級 autonomy，不是單輪回覆品質
- 與 ERP / Excel / BI / file intake 的企業流程整合
- 可回寫、可追責、可管理成本與政策風險

這不是 generic AI assistant，而是 `decision operations system`。

---

## 3. 建議的產品定位

### 3.1 核心一句話

`Decision Intelligence deploys digital workers that own recurring supply-chain decisions with evidence, approval gates, and system writeback.`

### 3.2 第一個 beachhead

不要先做 Analytics Worker。

先做：

`Supply Planning Worker`

原因：

- 目前 repo 最強資產本來就集中在 forecast / planning / risk / inventory
- domain engine 與 artifact 結構已經比一般聊天產品深
- buyer 比較容易算 ROI：缺料、庫存、加急、計畫偏差、planner 工時
- human approval 與 writeback 的價值更明顯

### 3.3 第二個 worker

第二位再做：

`Procurement / Supplier Risk Worker`

因為 negotiation、supplier event、risk delta、email draft 這條線已經有基礎，可以與 Supply Planning Worker 形成聯動。

---

## 4. 要賣的不是功能，而是完整 loop

### 4.1 用戶要買的成果

不是：

- AI 可以聊天
- AI 可以幫忙做分析
- AI 可以幫你生成報告

而是：

- 每週自動產出 demand / replenishment recommendation
- 對高風險 SKU 主動發起 replan
- 對低信心結論自動停在 review gate
- 核准後把 plan / workbook / evidence pack 發佈或寫回系統

### 4.2 v1 產品包裝

`Supply Planning Worker` 應該是一個有明確邊界的數位員工：

- Intake：chat / email / transcript / schedule / alert
- Plan：把 work order 轉成標準化 step plan
- Execute：forecast, plan, risk, report, workbook
- Review：AI review + manager approval
- Deliver：artifact pack + summary + writeback / distribution
- Learn：style / trust / autonomy progression

---

## 5. 我們現在應該刻意不做的事

以下應該視為 `not now`：

- 泛用跨部門 worker marketplace
- 任意部門的萬能 agent
- 大量 generic connector 擴張
- 強調模型本身比別人更聰明
- 把產品重心放在 prompt UX

這些方向會把團隊拉回紅海，而且削弱現有 repo 的真實優勢。

---

## 6. 對 repo 的明確 north star

未來 1 到 2 個月的工程決策都應該回答：

`這個改動有沒有讓某位 worker 更像一個可被管理、可被委派、可被審批、可被衡量的數位員工？`

如果答案是否定的，就不是當前優先級。

### 6.1 應優先強化的主幹

1. `Worker ownership`
每個 task、review、artifact、schedule、chat delegation 都要明確屬於某位 worker。

2. `Decision loop completeness`
intake → plan → execute → review → deliver → replay → writeback 要形成可證明的閉環。

3. `Manager console`
主管看的不是聊天紀錄，而是 workload、SLA、risk、approval queue、autonomy、cost。

4. `Worker-specific memory and policy`
不同 worker 要有不同 profile、policy、style、capability，而不是共用一個 assistant 腦。

---

## 7. 產品與工程對齊的 P0 / P1 / P2

### P0：把現有系統變成真的 worker system

- chat / assign / intake 必須可指定 worker
- task board 必須支援 worker queue 視角
- worker profile 必須顯示當前被委派的 worker
- manager console 必須有 active worker delegation 概念

### P1：把 worker 變成可交付的 decision product

- first-class work order schema 與 SLA
- replay completeness 作為 manager 信任訊號
- approval policy 與 autonomy level 真正驅動執行路徑
- evidence pack / workbook / publish / writeback 成為正式輸出

### P2：把 worker 變成 design partner 可買的 solution

- SAP / ERP customer-specific adapter contract
- benchmarkable KPI dashboard
- deployment hardening
- onboarding / template / team policy setup

---

## 8. 成功指標

不要只看 DAU 或訊息數。

應該看：

- 每位 worker 每週完成的 task 數
- forecast / plan / risk task 的 first-pass approval rate
- replay completeness
- 高風險 task 的 human escalation 準確率
- 每完成一個 task 的成本
- 每個部門節省的 planner / analyst 工時
- 被正式採納或寫回的 deliverable 比例

---

## 9. 當前 repo 對應

目前 repo 已有可沿用資產：

- intake normalization
- worker/task/step/orchestrator 主幹
- tool registry / permission / execution
- output profile / trust metrics / replay
- forecast / plan / risk / inventory 等 domain engine

因此策略上不需要重做產品。

**要做的是收斂：**

- 收斂產品敘事到單一 beachhead
- 收斂 UI 到真正的 worker delegation 模型
- 收斂工程優先級到 decision loop completeness

---

## 10. 這份策略對這個 repo 的即時要求

從現在開始，所有新功能都應該優先服務以下故事：

`Manager delegates a concrete planning or risk task to a named worker, the worker executes through controlled tools, pauses at the right review gates, produces evidence-backed artifacts, and the manager can approve, replay, and measure the outcome.`

如果功能無法強化這個故事，就降級。
