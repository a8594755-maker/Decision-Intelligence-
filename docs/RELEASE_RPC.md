# Ingest RPC 正式上線指南（Upload Optimization）

本文說明如何將 **Upload Optimization** 的 Ingest RPC 正式部署到 Supabase，包含權限、依賴與 Rollback。

---

## 1. RPC 定義位置與規格

| 項目 | 說明 |
|------|------|
| **定義檔** | `sql/migrations/ingest_rpc.sql`（與 `database/ingest_rpc.sql` 內容一致） |
| **Schema** | `public` |
| **Extensions** | 無需額外 extension（僅使用 `plpgsql`） |

### 函式一：`ingest_goods_receipts_v1`

- **簽名**：`ingest_goods_receipts_v1(p_batch_id UUID, p_upload_file_id UUID, p_rows JSONB)`
- **回傳**：`JSONB`  
  `{ success, inserted_count, suppliers_created, suppliers_found, materials_upserted, batch_id, upload_file_id }`
- **用途**：批次寫入收貨記錄（含 supplier/material 自動建立），idempotency 依 `batch_id`。

### 函式二：`ingest_price_history_v1`

- **簽名**：`ingest_price_history_v1(p_batch_id UUID, p_upload_file_id UUID, p_rows JSONB)`
- **回傳**：同上（JSONB 統計）
- **用途**：批次寫入價格歷史（含 supplier/material 自動建立），idempotency 依 `batch_id`。

### 交易一致性

- 兩支函式皆在單一 transaction 內執行；任一步失敗會整筆回滾，**不會留下半套資料**。
- 前端任一 `uploadType` 上傳失敗時，會依策略 fallback 到舊寫入路徑（見 `uploadStrategies.js`），不會因 RPC 未部署而卡死。

---

## 2. Supabase 部署步驟

### 2.1 依賴順序（需先存在）

1. **Tables**（需已建立）  
   - `suppliers`（含 `supplier_name_norm` 等）  
   - `materials`（含 `user_id`, `material_code` 唯一）  
   - `goods_receipts`  
   - `price_history`  

2. **Auth**  
   - `auth.uid()` 可用（Supabase 預設已提供）。

3. **建議**  
   - 若專案有執行 `step1_supply_inventory_financials_schema.sql` / `supplier_kpi_schema.sql` 等，上述表通常已存在。

### 2.2 執行 SQL 順序

在 **Supabase Dashboard → SQL Editor** 依序執行：

| 順序 | 說明 | 檔案 / 動作 |
|------|------|-------------|
| 1 | 建立兩支 RPC 函式 + 註解 | 執行 `sql/migrations/ingest_rpc.sql` 全文 |
| 2 | 補齊權限（可選，若 1 已含 GRANT 則略過） | 執行 `sql/migrations/release_ingest_rpc_permissions.sql` |

不需額外建立 schema 或 extension；函式建立於 `public`。

### 2.3 權限與 RLS

- **GRANT EXECUTE**  
  - `authenticated`：**必須**。前端登入後上傳會用此角色呼叫 RPC。  
  - `service_role`：可選，若後端或 cron 需代為寫入可授予。  
  - `anon`：**不要**授予；未登入使用者不應能寫入業務資料。

- **RLS**  
  - 函式為 `SECURITY DEFINER`，執行時以定義者權限寫入，**會繞過表上 RLS**。  
  - 函式內部已強制使用 `auth.uid()`，未登入會拋出 `NOT_AUTHENTICATED`，因此不會有 RLS 阻擋合法登入用戶寫入的問題。

### 2.4 驗證

- 前端：任選 **Goods Receipt** 或 **Price History** 上傳一筆，確認無 401 / permission denied，且成功後有筆數與統計。
- 或於 SQL Editor 執行（需替換為真實 `user_id` 的 JWT 或使用 Service Role）：

```sql
-- 健康檢查（空陣列應成功、回傳 inserted_count = 0）
SELECT ingest_goods_receipts_v1(
  '00000000-0000-0000-0000-000000000000'::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  '[]'::jsonb
);
```

---

## 3. Rollback（一鍵還原）

若需暫時或永久移除 RPC（例如回歸僅用舊寫入路徑），在 **Supabase SQL Editor** 執行：

```sql
-- ============================================
-- Rollback: 移除 Ingest RPC（可讓前端自動 fallback 舊寫入）
-- ============================================
DROP FUNCTION IF EXISTS public.ingest_goods_receipts_v1(UUID, UUID, JSONB);
DROP FUNCTION IF EXISTS public.ingest_price_history_v1(UUID, UUID, JSONB);
```

- 執行後，前端 `uploadStrategies.js` 會因 RPC 不存在（或權限錯誤）觸發 fallback，改走 **N+1 舊版寫入**，不需改前端程式碼。
- 若要重新上線 RPC，再執行一次 `ingest_rpc.sql` 與權限腳本即可。

---

## 4. 檔案清單

| 檔案 | 說明 |
|------|------|
| `sql/migrations/ingest_rpc.sql` | RPC 函式定義（含 GRANT EXECUTE TO authenticated） |
| `sql/migrations/release_ingest_rpc_permissions.sql` | 權限補齊與 REVOKE anon（可選） |
| `docs/RELEASE_RPC.md` | 本說明文件 |

---

## 5. 驗收標準對照

| 項目 | 說明 |
|------|------|
| 任一 uploadType 上傳失敗不留下半套資料 | RPC 內全在單一 transaction，失敗即回滾。 |
| 前端能成功呼叫 RPC（無 401/permission denied） | 僅授予 `authenticated`（及可選 `service_role`），不授予 `anon`。 |
| Rollback 一鍵可執行 | 上述 `DROP FUNCTION` 兩行即可，前端自動 fallback。 |
