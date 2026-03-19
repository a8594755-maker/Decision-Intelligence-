# Demo Showcase Runbook

## 目的

這份 runbook 是給展示用，不是給工程回歸測試用。
目標是用一條最穩的主線，展示這個產品能把資料匯入、AI 任務、規劃、風險、審核串起來。

## Demo 資料包

### 主展示資料

- `public/sample_data/test_data.xlsx`

檔案必須存在於專案根目錄下 `public/sample_data/test_data.xlsx`。

這是一個一檔多 sheet 的工作簿，內容已經包含：
- `demand_fg`
- `bom_edge`
- `po_open_lines`
- `inventory_snapshots`
- `fg_financials`
- `price_history`

這份資料最適合拿來展示：
- upload / profiling
- forecast
- replenishment plan
- risk summary
- manager review / approval

### 紅燈風險資料（備援展示用）

以下四份檔案必須全部存在於 `public/sample_data/` 下：

| 檔案 | 路徑 |
|---|---|
| 需求 | `public/sample_data/red_light_demand_fg.csv` |
| BOM | `public/sample_data/red_light_bom_edge.csv` |
| 庫存 | `public/sample_data/red_light_inventory_snapshots.csv` |
| PO | `public/sample_data/red_light_po_open_lines.csv` |

這組資料故意做成：
- 幾乎沒庫存
- 需求很高
- inbound 太晚

用途是展示缺料、stockout risk、what-if、mitigation 建議。

## 展示前檢查

### 1. 服務確認

以下四個服務必須全部在線：

| 服務 | 確認方式 |
|---|---|
| Frontend | 瀏覽器開 `localhost:5173`，畫面出現 TopNavBar |
| ML API | `curl http://localhost:8000/healthz` 回傳 200 |
| Supabase | Supabase Dashboard 可登入，或 `supabase status` 顯示 running |
| ai-proxy | Supabase Edge Function `ai-proxy` 已 deployed |

### 2. 資料檔確認

```bash
# 預期輸出：5 個檔案全部列出，大小 > 0
ls -la public/sample_data/test_data.xlsx \
      public/sample_data/red_light_demand_fg.csv \
      public/sample_data/red_light_bom_edge.csv \
      public/sample_data/red_light_inventory_snapshots.csv \
      public/sample_data/red_light_po_open_lines.csv
```

| # | 檔案 | 用途 |
|---|---|---|
| 1 | `test_data.xlsx` | 主展示（6 sheets：demand_fg, bom_edge, po_open_lines, inventory_snapshots, fg_financials, price_history） |
| 2 | `red_light_demand_fg.csv` | 紅燈風險展示 — 高需求 |
| 3 | `red_light_bom_edge.csv` | 紅燈風險展示 — BOM 結構 |
| 4 | `red_light_inventory_snapshots.csv` | 紅燈風險展示 — 近零庫存 |
| 5 | `red_light_po_open_lines.csv` | 紅燈風險展示 — 延遲 inbound |

如果任何檔案缺失，`npm run test:v1-gate` 中的 `sample data files exist on disk` 測試會失敗。

### 3. 自動化驗證

展示前至少跑一次：

```bash
npm run ci     # 包含 lint + vitest + dw-gate + v1-gate + build
```

快速服務健檢（不跑完整測試）：

```bash
npm run healthcheck   # 確認 frontend + ML API + Supabase 在線
```

如果要在展示前最後再驗一次真 worker（需 LLM 連線）：

```bash
npm run test:live:headful
```

## 10 分鐘主展示流程

### 步驟 1：進首頁（20–30 秒）

路徑：`/`

**預期畫面**：
- 畫面出現 `TopNavBar` 元件，顯示品牌名稱和導覽連結
- 畫面出現 `NetworkStatusBanner` 元件，**不顯示**「部分服務目前離線」
- 畫面出現系統健康狀態卡片，顯示 services 狀態
- 如有最近活動，畫面出現活動列表

**失敗判定**：
- 看到 Vite error overlay → 前端編譯錯誤
- 看到「部分服務目前離線」→ 至少一個後端服務未啟動
- 白屏超過 5 秒 → 檢查 console 錯誤

### 步驟 2：進 Plan Studio 並上傳主展示資料（1–2 分鐘）

路徑：`/plan`

上傳：`public/sample_data/test_data.xlsx`

**預期畫面**：
- 畫面出現 `ChatComposer` 元件（含文字輸入區和送出按鈕）
- 拖放或選擇檔案後，畫面出現 `DataSummaryCard` 元件
- `DataSummaryCard` 顯示 6 個 dataset sheet 名稱（demand_fg, bom_edge, po_open_lines, inventory_snapshots, fg_financials, price_history）
- 如有低信心度欄位，畫面出現 `MappingReviewPanel` 元件
- 沒有出現紅色錯誤 toast 或 error overlay

**失敗判定**：
- 檔案選擇後無反應 → 檢查 file input handler
- 出現 `vite error overlay` → 前端編譯錯誤
- profiling 失敗 → 檢查 ML API 是否在線

### 步驟 3：下第一個主指令（2–4 分鐘）

建議 prompt：

```text
Use this workbook to build a demand forecast and replenishment plan. Highlight the top risks, surface any data quality concerns, and generate a manager-ready summary.
```

**預期畫面**：
- 畫面出現 `AgentExecutionPanel` 元件，顯示 worker 正在執行步驟
- 執行完成後，畫面出現以下 artifact 卡片（至少 3 張）：
  - `ForecastWidget` — 顯示 forecast_series 資料，含時間軸圖表
  - `PlanTableWidget` — 顯示 plan_table 資料，含物料/工廠/數量欄位
  - `RiskWidget` — 顯示風險摘要，含風險分數和高風險項目
- 如有資料品質問題，畫面出現 `DataQualityCard` 元件

**失敗判定**：
- 送出 prompt 後超過 60 秒無回應 → ai-proxy 可能慢，見「失敗備案」
- 只出現文字回覆但無 artifact 卡片 → worker 未正確觸發
- 出現 "error" toast → 檢查 ML API 和 ai-proxy 日誌

### 步驟 4：做一次 revision（1–2 分鐘）

建議 prompt：

```text
Revise the plan to be more conservative for high-risk materials. Explicitly call out which plants or SKUs are most exposed and what changed.
```

**預期畫面**：
- 畫面出現新的 `AgentExecutionPanel`，顯示 revision 步驟
- 完成後，畫面出現更新的 artifact 卡片：
  - `PlanTableWidget` 顯示更新後的數值（與步驟 3 不同）
  - 至少一張卡片內容有標示「高風險」物料或工廠
- 不是只新增一段聊天文字 — 必須有新的 artifact 卡片出現

**失敗判定**：
- 只有文字回覆，沒有新 artifact → revision 流程未觸發
- 卡片內容與步驟 3 完全相同 → revision 未實際執行

### 步驟 5：做一次 approval（30–60 秒）

操作：直接在 approval / review card 上按 Approve 按鈕

**預期畫面**：
- 按下 Approve 後，卡片狀態從 `pending_review` / `in_review` 變為 `approved`
- `UnifiedApprovalCard` 元件顯示 approved 狀態（綠色標記或文字）
- `AuditTimelineCard` 元件（如可見）顯示 approval 事件記錄

**失敗判定**：
- 找不到 Approve 按鈕 → 可能 worker 還在執行中或未產出 review card
- 按下後無反應 → 檢查 Supabase 連線

### 步驟 6：切去 Risk 或 Scenarios（1–2 分鐘）

建議優先：`/risk`

**預期畫面**：
- 畫面出現 `RiskDashboardViewLite` 元件
- 顯示風險分數、風險矩陣、或高風險物料列表
- 頁面不是空白

如果你想再補一個動態比較，再切 `/scenarios`。

建議 prompt：

```text
What if supplier lead times increase by 20% for the highest-risk materials? Compare the operational impact and recommend mitigations.
```

**預期畫面**：
- 畫面出現 `ScenarioWidget` 元件，顯示 what-if 比較結果
- 至少有 before/after 數據對比

## 7 分鐘快速版

如果展示時間很短，直接走這條：

1. `/plan`
2. upload `public/sample_data/test_data.xlsx`
3. 貼主 prompt
4. 展示結果卡片（確認出現 ForecastWidget + PlanTableWidget + RiskWidget）
5. 做一次 revise（確認出現新 artifact 卡片）
6. 做一次 approve（確認狀態變為 approved）

## 紅燈風險備援展示

如果主展示線上 risk 不夠戲劇化，就改用紅燈資料組。

### 上傳資料

在資料匯入流程中依序上傳：
- `public/sample_data/red_light_demand_fg.csv`
- `public/sample_data/red_light_bom_edge.csv`
- `public/sample_data/red_light_inventory_snapshots.csv`
- `public/sample_data/red_light_po_open_lines.csv`

### 建議 prompt

```text
Analyze this supply scenario, quantify the stockout risk by component and plant, explain why the shortages happen, and recommend immediate mitigation actions.
```

### 預期展示重點

- `RiskWidget` 顯示多個高風險項目（風險分數 > 70）
- `InventoryWidget` 顯示多個物料庫存接近 0
- 可以講 shortage / delayed inbound / demand spike
- 比主線更適合講風險管理與決策 trade-off

## 展示時要盯的 8 個訊號

| # | 訊號 | 正常 | 異常處理 |
|---|---|---|---|
| 1 | NetworkStatusBanner | 不顯示「部分服務目前離線」 | 檢查四個服務 |
| 2 | 登入狀態 | 停留在目標頁面 | 被導回 `/login` → 重新登入 |
| 3 | Upload 後畫面 | 出現 DataSummaryCard | 白屏或 error overlay → 檢查 console |
| 4 | Chat 送出 | prompt 成功送出，出現 loading 狀態 | 送出按鈕無反應 → 檢查 WebSocket/SSE |
| 5 | Artifact 卡片 | 至少 3 張 artifact 卡片出現 | 只有文字 → worker 未觸發 |
| 6 | Revise 結果 | 新 artifact 卡片出現，內容有更新 | 無變化 → revision 流程問題 |
| 7 | Approve 狀態 | 狀態變為 approved | 無反應 → Supabase 連線問題 |
| 8 | Risk/Scenario 頁 | 有資料顯示 | 空白 → 無已完成的 workflow 資料 |

## 失敗時的備案

### 如果 `ai-proxy` 很慢（回應超過 30 秒）

不要現場硬賭長文回答。改展示：
- upload → DataSummaryCard（不需要 LLM）
- profiling 結果
- 已產出的 artifact（從之前成功的 run）
- review / approval 結構（靜態 UI）

### 如果 ML API 慢或無回應

不要一直等。改切去：
- `/risk` — 展示 RiskDashboardViewLite
- `/scenarios` — 展示 ScenarioWidget
- 已完成的 task / artifact

### 如果聊天結果延遲

把 prompt 改短，不要一次塞太多要求。

建議短 prompt：

```text
Run forecast and create a replenishment plan for this workbook.
```

### 如果前端白屏或 crash

1. 開 DevTools Console，截圖錯誤訊息
2. 嘗試 hard refresh（Cmd+Shift+R）
3. 如果持續白屏，切到其他已知穩定頁面（`/employees`, `/employees/approvals`）

## 最低展示驗收標準

只要下面五條成立，就可以拿去展示：

1. `npm run ci` 通過
2. `npm run test:v1-gate` 通過（或因缺 server 而 skip，但 script 可執行）
3. `test_data.xlsx` 可成功上傳，畫面出現 DataSummaryCard
4. 主 prompt 可穩定跑出 ForecastWidget + PlanTableWidget + RiskWidget
5. revise 可成功走一次（出現新 artifact 卡片）
6. approve 可成功走一次（狀態變為 approved）

## CI Gate

`test:v1-gate` 已綁入 `npm run ci` pipeline：

```
ci = lint → test:run → test:dw-gate → test:v1-gate → build
```

單獨執行：

```bash
# 跑 V1 驗收門檻測試
npm run test:v1-gate
```

此命令執行以下三條 e2e 測試：

| 測試檔案 | 驗收項目 |
|---|---|
| `e2e/flows/upload-to-plan.spec.js` | 上傳 → 預測 + 計畫產出 |
| `e2e/flows/revise-output.spec.js` | 修訂 → artifact 更新 |
| `e2e/flows/approve-audit.spec.js` | 審核 → 狀態變更 + 審計軌跡 |

無 dev server 時，UI 測試自動 skip（`navigateOrSkip` helper 偵測 login redirect）。
`sample data files exist on disk` 測試不依賴 server，永遠執行。
