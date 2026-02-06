# 上線執行優先順序與 PR 規範

本文件定義 **4 階段執行順序**，且每個 PR 必須附：**變更摘要**、**風險點與回滾方式**、**驗收步驟（可複製貼上）**。

---

## 執行優先順序（依序進行）

| 順序 | 項目 | 說明 | 產出／依賴 |
|------|------|------|------------|
| **1** | Ingest RPC 部署 + 權限 | **Blocking**：其餘功能依賴寫入穩定 | DB migration、權限、rollback 腳本 |
| **2** | QA Gate 文件 | 先產出，避免做完才發現漏測 | `docs/QA_GO_LIVE_GATE.md` |
| **3** | Forecast Run schema + run_id 串接 | 先做可追溯（forecast_runs + 寫入帶 run_id） | Migration、服務層、`docs/FORECAST_RUNS.md` |
| **4** | 前端 P0 狀態保留 | 切分頁不回首頁、Back 按鈕、URL 保留 tab | Router/visibility/Back、`docs/UX_STATE_PERSISTENCE.md` |

---

## PR 必須附的三項

每個 PR 描述中請包含（可直接從下方各節複製）：

1. **變更摘要**：改了哪些檔案、做什麼事。  
2. **風險點與回滾方式**：可能出問題的點、如何一鍵或短步驟回滾。  
3. **驗收步驟**：可複製貼上給 QA 或 reviewer 執行的清單。

以下依 **4 個 PR** 分別給出可直接貼到 PR 的內容。

---

# PR1：Ingest RPC 部署 + 權限（Blocking）

## 變更摘要

- **新增／修改檔案**  
  - `sql/migrations/ingest_rpc.sql`：建立 `ingest_goods_receipts_v1`、`ingest_price_history_v1`（transaction、idempotency、auth.uid() 檢查）。  
  - `sql/migrations/release_ingest_rpc_permissions.sql`：GRANT EXECUTE 給 `authenticated`，REVOKE EXECUTE 給 `anon`。  
  - `sql/migrations/rollback_ingest_rpc.sql`：一鍵移除兩支 RPC。  
  - `docs/RELEASE_RPC.md`：部署步驟、權限說明、驗證與 rollback 說明。  
- **行為**：Goods Receipt / Price History 上傳時優先走 RPC；失敗時前端自動 fallback 舊寫入路徑（無需改 code）。

## 風險點與回滾方式

| 風險 | 說明 | 回滾方式 |
|------|------|----------|
| RPC 錯誤率過高或權限爭議 | 寫入失敗、延遲或 401 | 在 Supabase SQL Editor 執行 `sql/migrations/rollback_ingest_rpc.sql`（兩行 DROP FUNCTION）。前端無需改版，會自動改走舊寫入。 |
| 依賴表不存在 | suppliers / materials / goods_receipts / price_history 未建 | 先執行專案既有 schema（如 step1_supply_inventory_financials_schema.sql 等），再執行本 PR 的 migration。 |

**回滾指令（複製用）**：

```sql
DROP FUNCTION IF EXISTS public.ingest_goods_receipts_v1(UUID, UUID, JSONB);
DROP FUNCTION IF EXISTS public.ingest_price_history_v1(UUID, UUID, JSONB);
```

## 驗收步驟（可複製貼上）

1. 在 Supabase SQL Editor 依序執行：`ingest_rpc.sql` 全文 → `release_ingest_rpc_permissions.sql`。  
2. 執行驗證 SQL：  
   `SELECT routine_name FROM information_schema.routines WHERE routine_schema='public' AND routine_name IN ('ingest_goods_receipts_v1','ingest_price_history_v1');`  
   預期：2 列。  
3. 檢查權限：  
   `SELECT routine_name, grantee FROM information_schema.routine_privileges WHERE routine_schema='public' AND routine_name LIKE 'ingest_%';`  
   預期：`authenticated` 有 EXECUTE；**不得**有 `anon`。  
4. 前端：登入 → Data Upload → 選 Goods Receipt → 上傳一筆合法 CSV（含 supplier_name, material_code, actual_delivery_date, received_qty）→ 對應欄位 → 驗證 → 儲存。  
   預期：成功訊息、無 401/permission denied；Import History 可見該批次。  
5. （可選）執行 `rollback_ingest_rpc.sql` 後，再次上傳 Goods Receipt；預期：仍成功（走舊路徑），無 crash。

---

# PR2：QA Gate 文件（先產出）

## 變更摘要

- **新增檔案**  
  - `docs/QA_GO_LIVE_GATE.md`：Go-live 回歸測試矩陣。  
- **內容**  
  - 每種 uploadType：成功、缺必填、欄位同義字、重複資料四類案例。  
  - One-shot：多 sheet 分類／映射、任一 sheet 失敗時 Best-effort vs All-or-nothing。  
  - Strict vs Best-effort 差異、Error Report 下載與 Row # 對應、權限／RLS、5k～20k 筆壓力測試。  
  - 每測項：測試資料來源、步驟、預期結果、P0/P1。  
  - P0 覆蓋總表。

## 風險點與回滾方式

| 風險 | 說明 | 回滾方式 |
|------|------|----------|
| 文件與實作不同步 | 測項過時或漏列 | 純文件 PR，回滾 = 還原 `docs/QA_GO_LIVE_GATE.md` 或後續 PR 修正文件。 |

## 驗收步驟（可複製貼上）

1. 開啟 `docs/QA_GO_LIVE_GATE.md`，確認目錄存在：Upload Type 矩陣、One-shot、Strict/Best-effort、Error Report、權限、效能、P0 覆蓋總表。  
2. 確認每個 P0 測項均含：測試資料來源、步驟、預期結果、優先級標記。  
3. 抽 3 條測項（例如 U1-1、O2-1、E2）照文件執行；預期：步驟可執行、預期結果與實際一致或可依文件調整。

---

# PR3：Forecast Run schema + run_id 串接（可追溯）

## 變更摘要

- **DB**  
  - `sql/migrations/forecast_runs_and_run_id.sql`：建立 `forecast_runs` 表；`component_demand` / `component_demand_trace` 新增 `forecast_run_id`；舊資料 backfill 到 legacy run；唯一約束改為含 `forecast_run_id`。  
- **前端／服務**  
  - `src/services/supabaseClient.js`：新增 `forecastRunsService`（createRun, getRun, listRuns）；`componentDemandService.upsertComponentDemand`、`componentDemandTraceService.insertComponentDemandTrace` 支援 `forecast_run_id`。  
  - `src/services/bomExplosionService.js`：執行前先建立 `forecast_run`，將 `forecast_run_id` 帶入 component_demand / component_demand_trace 寫入；回傳增加 `forecastRunId`。  
- **文件**  
  - `docs/FORECAST_RUNS.md`：表結構、追溯鏈、寫入流程、部署順序。  
- **其他**  
  - `sql/migrations/reset_all_data.sql`：truncate 清單加入 `forecast_runs`。

## 風險點與回滾方式

| 風險 | 說明 | 回滾方式 |
|------|------|----------|
| 唯一約束或 backfill 失敗 | Migration 執行報錯 | 先修正資料（如重複 key）或略過本 migration；前端尚未依賴 run_id 時可先不部署此 PR。 |
| 新 code 依賴 forecast_runs 表 | 未跑 migration 時 createRun 失敗 | 現有 code 已 catch，該次 BOM Explosion 仍會執行，僅該次結果無 forecast_run_id。 |
| 已上線後要還原 run_id 邏輯 | 不建議刪表/欄 | 回滾以「前端 hotfix」為主：改為不呼叫 `forecastRunsService.createRun`、不傳 `forecast_run_id`；DB 保留不動。 |

**回滾（僅前端）**：移除或繞過建立 forecast_run 與傳入 forecast_run_id 的邏輯；DB 不執行 DROP。

## 驗收步驟（可複製貼上）

1. 在 Supabase SQL Editor 執行 `sql/migrations/forecast_runs_and_run_id.sql`；預期：無錯誤，NOTICE 顯示完成。  
2. 驗證表與欄位：  
   `SELECT column_name FROM information_schema.columns WHERE table_name='forecast_runs' ORDER BY ordinal_position;`  
   `SELECT column_name FROM information_schema.columns WHERE table_name='component_demand' AND column_name='forecast_run_id';`  
   預期：`forecast_runs` 有 id, created_at, created_by, scenario_name, parameters, input_batch_ids；`component_demand` 有 `forecast_run_id`。  
3. 前端：登入 → Planning → Forecasts → 輸入 Plant ID 與 Time Buckets → Run BOM Explosion。  
   預期：計算完成；可選批次看 Results/Trace。  
4. 在 Supabase 查詢：  
   `SELECT id, created_at, scenario_name FROM forecast_runs ORDER BY created_at DESC LIMIT 3;`  
   `SELECT id, forecast_run_id, material_code FROM component_demand WHERE forecast_run_id IS NOT NULL LIMIT 3;`  
   預期：有剛執行的 run 與對應的 component_demand 列，且 `forecast_run_id` 不為 null。

---

# PR4：前端 P0 狀態保留（切分頁 / Back）

## 變更摘要

- **Router / URL**  
  - `src/utils/router.js`：新增 `getSearchParams()`、`updateUrlSearch(params)`。  
  - `src/hooks/useUrlTabState.js`：新增 hook，將 tab 與 URL query 雙向同步，並訂閱 `popstate`。  
- **App**  
  - `src/App.jsx`：新增 `useVisibilitySync`（切回分頁時依 pathname 還原 view）；main 區塊新增「上一頁」按鈕（history.back() 或 setView('home')）。  
- **Views**  
  - `src/views/BOMDataView.jsx`：tab 改用 `useUrlTabState('bom_edges', 'tab', ['bom_edges','demand_fg'])`。  
  - `src/views/ForecastsView.jsx`：tab 改用 `useUrlTabState('results', 'tab', ['results','trace'])`。  
  - `src/views/EnhancedExternalSystemsView.jsx`：One-shot 與單檔模式與 `?tab=upload` / `?tab=oneshot` 雙向同步。  
- **Upload 韌性**  
  - `EnhancedExternalSystemsView.jsx`：>1000 rows 僅警告、不預設 disabled；移除因「rows」而 disable type 下拉的邏輯。  
- **文件**  
  - `docs/UX_STATE_PERSISTENCE.md`：決策、實作、驗收、至少 5 個手動測試步驟（含切分頁）。

## 風險點與回滾方式

| 風險 | 說明 | 回滾方式 |
|------|------|----------|
| URL 或 history 與現有書籤／分享不相容 | 舊連結少一層 query 或行為不同 | 可還原 `useUrlTabState` 改回純 useState，並移除 visibility 與 Back 相關改動；router.js 新增的 getSearchParams/updateUrlSearch 保留也無害。 |
| 上一頁在無 history 時行為異常 | 例如開新分頁直接進子頁 | 目前實作：`history.length > 1` 才 back()，否則 setView('home')；若有邊緣情況再補判斷。 |

**回滾**：還原 App.jsx、BOMDataView、ForecastsView、EnhancedExternalSystemsView、router.js、useUrlTabState 相關改動至本 PR 前版本。

## 驗收步驟（可複製貼上）

1. 登入後進入 Data → BOM Data → 切到「FG 需求」tab；確認 URL 為 `/data/bom-data?tab=demand_fg`。  
2. 開新分頁（例如 about:blank），約 30 秒後切回 SmartOps；預期：仍為 BOM Data 頁且為 FG 需求 tab。  
3. 在 Planning → Forecasts 切到 Trace tab，按 F5 重新整理；預期：仍為 Forecasts 頁且為 Trace tab。  
4. 進入 Data → Data Upload，點「上一頁」；預期：回到前一頁（或首頁）。在非首頁再點一次「上一頁」；預期：無報錯、不關閉分頁。  
5. Data Upload 勾選 One-shot，確認 URL 含 `?tab=oneshot`；重新整理後預期：仍為 Data Upload 且 One-shot 仍勾選。  
6. 上傳 >1000 筆的 sheet（或現有 template 複製多行），確認僅出現警告、該 sheet **可**勾選啟用（不預設 disabled）。

---

## 總表：PR 與文件對照

| PR | 主要檔案 | 參考文件 |
|----|----------|----------|
| PR1 | ingest_rpc.sql, release_ingest_rpc_permissions.sql, rollback_ingest_rpc.sql | RELEASE_RPC.md, RELEASE_CHECKLIST.md §2 |
| PR2 | docs/QA_GO_LIVE_GATE.md | （本文件驗收步驟） |
| PR3 | forecast_runs_and_run_id.sql, supabaseClient.js, bomExplosionService.js | FORECAST_RUNS.md |
| PR4 | router.js, useUrlTabState.js, App.jsx, BOMDataView, ForecastsView, EnhancedExternalSystemsView | UX_STATE_PERSISTENCE.md, RELEASE_CHECKLIST.md §5 |

---

**使用方式**：開 PR 時將對應小節的「變更摘要」「風險點與回滾方式」「驗收步驟」複製到 PR 描述即可。
