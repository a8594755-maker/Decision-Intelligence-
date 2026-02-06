# SmartOps 上線流程（Staging → Production）

本文件為**可執行的上線流程**，含 DB / RPC 部署、權限檢查、前端環境變數、Smoke Test、回滾方案與監控指標。  
**任何人照此 checklist 可完成 Staging 部署，回滾不依賴原作者。**

---

## 目錄

1. [Staging 部署流程](#1-staging-部署流程)
2. [DB Migration / RPC 部署步驟](#2-db-migration--rpc-部署步驟)
3. [權限檢查（GRANT / RLS）](#3-權限檢查grant--rls)
4. [前端環境變數](#4-前端環境變數)
5. [Smoke Test 清單（最少 10 條）](#5-smoke-test-清單最少-10-條)
6. [回滾方案](#6-回滾方案)
7. [監控指標（最小集）](#7-監控指標最小集)

---

## 1. Staging 部署流程

| 階段 | 負責 | 動作 | 驗證 |
|------|------|------|------|
| 1.1 | DevOps/Backend | 在 **Staging Supabase** 依序執行 DB migrations（見 §2） | SQL 無錯誤、必要表/函式存在 |
| 1.2 | DevOps/Backend | 執行權限檢查（見 §3） | GRANT/RLS 符合預期 |
| 1.3 | DevOps/Frontend | 建置前端並部署至 Staging（Vite build），設定 Staging 環境變數（見 §4） | 可開啟 Staging URL、登入成功 |
| 1.4 | QA | 執行 Smoke Test（見 §5） | 至少 10 條全過 |
| 1.5 | 簽核 | Staging 簽核通過後，再進行 Production 相同步驟（換成 Production Supabase + Production 前端 URL/Env） | - |

**Production 與 Staging 差異**：僅替換 Supabase Project（URL/Key）與前端部署目標；Migration 順序與權限邏輯一致。

---

## 2. DB Migration / RPC 部署步驟

在 **Supabase Dashboard → SQL Editor** 依下表順序執行（**先 Staging，再 Production**）。

### 2.1 依賴順序（需已存在）

以下表需已建立（若專案曾跑過初版 schema，通常已存在）：

- `auth.users`（Supabase 內建）
- `suppliers`、`materials`、`goods_receipts`、`price_history`
- `import_batches`、`user_files`（若使用 Import History / 上傳）
- `bom_edges`、`demand_fg`、`component_demand`、`component_demand_trace`（若使用 BOM/Forecast）

若尚未建立，請先執行（依專案既有順序）：

- `sql/migrations/step1_supply_inventory_financials_schema.sql`（或等同的 supply/inventory 建表）
- `sql/migrations/import_batches_schema.sql`
- `sql/migrations/bom_forecast_schema.sql`

### 2.2 Migration 執行順序

| 序 | 檔案 | 說明 |
|----|------|------|
| 1 | `sql/migrations/ingest_rpc.sql` | 建立 `ingest_goods_receipts_v1`、`ingest_price_history_v1` |
| 2 | `sql/migrations/release_ingest_rpc_permissions.sql` | GRANT EXECUTE 給 authenticated、REVOKE anon |
| 3 | `sql/migrations/one_shot_chunk_idempotency.sql` | 選用：One-shot 大檔 idempotency（ingest_sheet_runs、ingest_key） |
| 4 | `sql/migrations/forecast_runs_and_run_id.sql` | 選用：forecast_runs 表與 component_demand/trace 的 forecast_run_id |

**注意**：

- 1、2 為 **Ingest RPC 上線必做**。
- 3 為 One-shot 大檔／chunk 匯入所需，若未用 One-shot 可略。
- 4 為 Forecast Run 版本化所需，若未用 BOM Explosion 可略。

### 2.3 驗證 DB 部署結果

在 SQL Editor 執行：

```sql
-- 檢查 RPC 是否存在
SELECT routine_name, routine_schema
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN ('ingest_goods_receipts_v1', 'ingest_price_history_v1');

-- 預期：2 列

-- （選用）檢查 forecast_runs 表
SELECT EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'forecast_runs'
);
-- 預期：t（若已跑 forecast_runs migration）
```

---

## 3. 權限檢查（GRANT / RLS）

### 3.1 RPC 執行權限

在 SQL Editor 執行：

```sql
SELECT routine_name, grantee
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND routine_name IN ('ingest_goods_receipts_v1', 'ingest_price_history_v1')
ORDER BY routine_name, grantee;
```

**預期**：

- `authenticated` 有 EXECUTE。
- **不得**出現 `anon`（若有，執行 `release_ingest_rpc_permissions.sql` 內 REVOKE）。

### 3.2 RLS 與表權限（業務表）

確認業務表已啟用 RLS 且政策為「僅限本人」：

```sql
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('suppliers', 'materials', 'goods_receipts', 'price_history', 'import_batches');
-- rowsecurity 應為 t

SELECT schemaname, tablename, policyname
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('suppliers', 'materials', 'goods_receipts', 'price_history');
-- 應有 FOR SELECT/INSERT/UPDATE/DELETE 且 USING (auth.uid() = user_id) 或等效
```

若專案有額外表（bom_edges, demand_fg, component_demand 等），同上方式檢查其 RLS 與政策。

---

## 4. 前端環境變數

建置與執行前端時，需提供下列變數（Vite 需 `VITE_` 前綴才會暴露給客戶端）。

| 變數 | 必填 | 說明 | Staging 範例 | Production |
|------|------|------|--------------|------------|
| `VITE_SUPABASE_URL` | 是 | Supabase Project URL | `https://<project-ref>.supabase.co` | 換成 Production Project URL |
| `VITE_SUPABASE_ANON_KEY` | 是 | Supabase anon (public) key | 從 Staging 專案 API 設定取得 | 從 Production 專案取得 |
| `VITE_GEMINI_API_KEY` | 否 | Gemini API Key（AI 建議／決策用） | 若 Staging 要測 AI 再填 | 依需求 |

**建置範例**（依實際 CI 調整）：

```bash
# Staging
VITE_SUPABASE_URL=https://xxx.supabase.co VITE_SUPABASE_ANON_KEY=eyJ... npm run build

# 或使用 .env.staging / .env.production（勿提交含 key 的 .env）
```

**驗證**：部署後開啟 App → 登入 → 若出現「Missing Supabase environment variables」則表示變數未正確注入。

---

## 5. Smoke Test 清單（最少 10 條）

部署完成後，由任何人依序執行並打勾。

| # | 項目 | 步驟 | 預期 | P0 |
|---|------|------|------|-----|
| S1 | 登入 | 開啟 Staging URL → 輸入測試帳密 → 登入 | 進入首頁、無白屏 | ✓ |
| S2 | 導航 | 依序點：Data → Data Upload、Data → Import History、Planning → Forecasts、Planning → Risk Dashboard | 各頁可開啟、無 404/紅錯 | ✓ |
| S3 | 單檔上傳（Goods Receipt 或 Price History） | Data Upload → 選 Goods Receipt → 上傳一筆含 supplier_name, material_code, actual_delivery_date, received_qty 的 CSV → 對應欄位 → 驗證 → 儲存 | 成功訊息、Import History 可見該批次 | ✓ |
| S4 | RPC 路徑（若已部署 RPC） | 同上，上傳後觀察是否出現「使用交易性寫入完成」或類似；或開啟 DevTools Console 無 RPC 42883/權限錯誤 | 成功寫入且無 permission denied | ✓ |
| S5 | 單檔上傳（BOM） | Data Upload → 選 BOM Edge → 上傳 `templates/bom_edge.csv` → 儲存 | 成功；BOM Data 頁可見資料 | ✓ |
| S6 | 單檔上傳（Demand FG） | 選 Demand FG → 上傳 `templates/demand_fg.csv` → 儲存 | 成功；BOM Data → FG 需求 tab 可見 | ✓ |
| S7 | 驗證與 Error Report | 上傳一檔其中一列缺必填 → 進入驗證步驟 → 點「Download Error Report (.csv)」 | 下載 CSV、內含 Row Index / Error Message 等欄位 | ✓ |
| S8 | Strict / Best-effort | 同一有錯檔：切換 Best-effort 可儲存（僅有效列）；切 Strict 則儲存按鈕 disabled | 行為符合規格 | ✓ |
| S9 | One-shot（若已啟用） | Data Upload → 勾選 One-shot → 上傳多 sheet 的 xlsx → 為每 sheet 選 Type → 執行匯入 | 匯入完成、結果頁顯示成功/失敗 sheet | ✓ |
| S10 | BOM Explosion（若已啟用） | Planning → Forecasts → 輸入 Plant ID / Time Buckets → Run BOM Explosion | 計算完成、可選批次看 Results / Trace | ✓ |
| S11 | 權限隔離 | 用另一測試帳號登入 → 進 Import History 或 BOM Data | 僅見該帳號自己的資料 | ✓ |
| S12 | 上一頁與 URL | 進入任子頁（如 Data Upload）→ 點「上一頁」→ 再重新整理 | 上一頁回到前頁；重整後 route 保留 | ✓ |

**通過標準**：S1～S10 必過；S11、S12 建議過。任一 P0 失敗則阻擋上線。

---

## 6. 回滾方案

### 6.1 DB 回滾

#### A. Ingest RPC 回滾（Safe stopgap）

若上線後 RPC 異常（錯誤率過高、權限爭議），可**僅移除 RPC**，前端會自動改走舊寫入路徑（無需改程式碼）。

**執行腳本**：`sql/migrations/rollback_ingest_rpc.sql`

```sql
DROP FUNCTION IF EXISTS public.ingest_goods_receipts_v1(UUID, UUID, JSONB);
DROP FUNCTION IF EXISTS public.ingest_price_history_v1(UUID, UUID, JSONB);
```

**步驟**：

1. 在 Supabase SQL Editor 貼上上述兩行（或執行 `rollback_ingest_rpc.sql`）。
2. Run。
3. 通知前端/QA：Goods Receipt、Price History 會改走「相容模式」（舊 N+1 寫入），功能仍可用。

**恢復 RPC**：重新執行 `ingest_rpc.sql` + `release_ingest_rpc_permissions.sql` 即可。

#### B. Schema 變更回滾（forecast_runs / forecast_run_id）

- **不建議**對已上線的 `forecast_runs`、`component_demand.forecast_run_id` 做 DROP COLUMN / DROP TABLE（會破壞既有資料）。
- 若僅是「新功能有問題」：前端可選擇不呼叫 `forecastRunsService.createRun`（需一版 hotfix）；DB 維持不動。
- 若**從未**在 Production 跑過 `forecast_runs_and_run_id.sql`，則無需回滾該 migration。

#### C. One-shot idempotency（ingest_sheet_runs / ingest_key）

- 若僅停用 One-shot 大檔邏輯，可不動 DB；前端改為不依賴 `ingest_key` 或 chunk idempotency 即可。
- 若必須移除表：先確認無應用依賴再 `DROP TABLE`；順序建議先刪依賴 `ingest_key` 的邏輯再考慮刪表（通常保留表也無害）。

### 6.2 前端回滾（Feature-flag / 舊流程）

目前**沒有**獨立的 feature flag 開關；行為為：

- **RPC**：先呼叫 RPC，失敗則自動 fallback 舊寫入。因此 **DB 端移除 RPC 即等於「強制舊流程」**，無需改前端。
- 若未來要加「強制只用舊路徑」開關，可新增環境變數（例如 `VITE_USE_LEGACY_UPLOAD=true`）並在 `uploadStrategies.js` 內若為 true 則直接走 legacy、不呼叫 RPC；本版未實作，回滾以 **DB 回滾 RPC** 為主。

**部署回滾**：若前端新版本有嚴重問題，由 CI/CD 或主機回退到上一版前端 build 即可（依你們發版方式）。

---

## 7. 監控指標（最小集）

以下為上線後**建議**收集的最小監控集；實作方式依你們現有系統（Sentry、Supabase Logs、自建後端日誌）選擇。

### 7.1 Upload 成功率 / 失敗率

- **定義**：單次「儲存」操作（單檔或 One-shot 一次）若寫入成功且回傳成功訊息視為成功，否則為失敗。
- **建議收集方式**：
  - 前端：在儲存成功時送一筆 event（例如 `upload_success`，含 uploadType、rowCount）；儲存失敗時送 `upload_failed`（含 uploadType、errorCode 或 message 前 100 字）。
  - 或後端：若 Supabase 有 logging，可從 `import_batches` 的 status / error 統計。
- **指標**：成功率 = 成功次數 / (成功+失敗)；失敗率 = 1 - 成功率。可依 uploadType 維度拆開。

### 7.2 RPC Latency（p50 / p95）

- **定義**：自前端發起 `supabase.rpc('ingest_goods_receipts_v1', ...)` 到收到回應的時間（毫秒）。
- **建議收集方式**：
  - 前端在呼叫 RPC 前後打時間戳，成功/失敗皆上報一筆（例如 `rpc_latency_ms`、`rpc_name`、`success`）。
  - 或 Supabase Dashboard → Logs → API 篩選 Postgres 或 RPC 請求，看 response time。
- **指標**：同一 RPC 的 p50、p95 延遲（ms）。可設告警：p95 > 10s 或 15s。

### 7.3 Error Report 下載率

- **定義**：有驗證錯誤的 session 中，觸發「Download Error Report」的比例。
- **建議收集方式**：前端在按下「Download Error Report」時送一筆 event（例如 `error_report_downloaded`）；另可送「驗證有錯誤但未下載」的 event 以便算比例。
- **指標**：下載次數 / 有錯誤的驗證次數（或改為「有錯誤的 session 數」）。用於觀察使用者是否善用錯誤報告除錯。

### 7.4 前端 Error Boundary / Console Error 記錄點

- **現狀**：專案內有 `console.warn` / `console.error`（例如 RPC fallback、載入失敗），目前**未**見 Sentry 或統一 error reporting。
- **建議**：
  - 若有 **Sentry**（或類似）：在 App 根層包一層 Error Boundary，在 `componentDidCatch` / `onError` 中呼叫 `Sentry.captureException`；並在關鍵路徑（例如 `uploadStrategies.js` 的 catch、`ingestRpcService` 的 RpcError）呼叫 `Sentry.captureException(error)` 或 `Sentry.captureMessage`，並帶上 context（uploadType、stage）。
  - 若無 Sentry：至少保留現有 `console.error`，並建議在 Staging/Production 開啟「保留 console 輸出」或轉發到日誌服務，以便事後排查。

### 7.5 最小告警建議

| 指標 | 建議閾值 | 動作 |
|------|-----------|------|
| Upload 失敗率（整體或單一 type） | > 10% 持續 15 分鐘 | 檢查 Supabase 狀態、RLS、近期部署 |
| RPC p95 latency | > 15s | 檢查 DB 負載、RPC 邏輯 |
| 5xx / 401 比例（API） | 明顯上升 | 檢查權限與服務健康 |

---

## 附錄 A：快速指令參考

```bash
# 建置（需預先設定環境變數）
npm ci
npm run build

# 本機預覽 build
npm run preview
```

```sql
-- 回滾 RPC（貼到 Supabase SQL Editor）
DROP FUNCTION IF EXISTS public.ingest_goods_receipts_v1(UUID, UUID, JSONB);
DROP FUNCTION IF EXISTS public.ingest_price_history_v1(UUID, UUID, JSONB);
```

---

## 附錄 B：文件對照

| 主題 | 文件 |
|------|------|
| RPC 規格與權限細節 | `docs/RELEASE_RPC.md` |
| Forecast Run 版本化 | `docs/FORECAST_RUNS.md` |
| 回歸測試矩陣 | `docs/QA_GO_LIVE_GATE.md` |
| UX 狀態持久化 | `docs/UX_STATE_PERSISTENCE.md` |
