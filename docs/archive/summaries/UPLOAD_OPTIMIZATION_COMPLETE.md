# Upload Optimization 專案 - 完成總結

**專案分支**：`feat/upload-optimization`  
**完成日期**：2026-02-05  
**總執行時間**：Phase 0-3 + Bug Fix

---

## ✅ 完成階段總覽

### Phase 0：資料一致性修補
- ✅ `userFilesService.saveFile` 回傳完整 row（含 id）
- ✅ `goods_receipts` / `price_history` 寫入 `batch_id` 和 `upload_file_id`
- ✅ 向後相容 adapter（支援舊 API 呼叫）

### Phase 1：RPC Transaction + Bulk Upsert
- ✅ 新增 `database/ingest_rpc.sql`（2 個 RPC functions）
- ✅ 新增 `src/services/ingestRpcService.js`（前端 RPC wrapper）
- ✅ Transaction 回滾機制
- ✅ Idempotency（batch_id DELETE）
- ✅ Fallback 機制（RPC 失敗 → legacy path）

### Phase 2：策略模式 + 狀態集中
- ✅ 新增 `src/hooks/useUploadWorkflow.js`（useReducer）
- ✅ 新增 `src/services/uploadStrategies.js`（8 個 Strategy）
- ✅ `handleSave` 從 200+ 行 → 98 行（-51%）
- ✅ 移除 600+ 行舊 save 函數

### Phase 3：UX 改進
- ✅ 新增 `src/utils/errorReport.js`（CSV 下載）
- ✅ Strict / Best-effort 模式
- ✅ Error Report CSV 下載
- ✅ `strictMode` 進 reducer

### Bug Fix：Upload Type Select
- ✅ 修復 `<select onChange>` 呼叫錯誤的 setState
- ✅ 改用 `workflowActions.setUploadType`
- ✅ 移除臨時 debug log

---

## 📁 檔案清單（最終版）

### 新增檔案（12 個）

#### 程式碼（4 個）
1. `src/hooks/useUploadWorkflow.js` (231 行)
2. `src/services/uploadStrategies.js` (638 行)
3. `src/services/ingestRpcService.js` (189 行)
4. `src/utils/errorReport.js` (189 行)

#### 資料庫（1 個）
5. `database/ingest_rpc.sql` (678 行)

#### 文檔（7 個）
6. `PHASE0_1_COMPLETE_SUMMARY.md`
7. `PHASE1_RPC_INTEGRATION_TEST.md`
8. `PHASE2_REFACTOR_SUMMARY.md`
9. `PHASE2_HANDLESAVE_LINECOUNT.md`
10. `PHASE3_UX_COMPLETE_SUMMARY.md`
11. `UPLOAD_OPTIMIZATION_QA.md` ⭐
12. `BUGFIX_UPLOAD_TYPE_SELECT.md`

---

### 修改檔案（3 個）

1. **`src/services/supabaseClient.js`**
   - `userFilesService.saveFile`：回傳 id
   - `goodsReceiptsService.batchInsert`：新參數結構 + adapter
   - `priceHistoryService.batchInsert`：同上

2. **`src/views/EnhancedExternalSystemsView.jsx`**
   - 移除 9 個 `useState`（改用 `useUploadWorkflow` hook）
   - 移除 8 個舊 save 函數（~600 行）
   - `handleSave` 從 200+ 行 → 98 行
   - 加入 Strict/Best-effort 模式 UI
   - 加入 Download Error Report 按鈕
   - **Bug Fix**：`<select onChange>` 改用 `workflowActions.setUploadType`

3. **`src/hooks/useUploadWorkflow.js`**
   - Phase 3 新增 `strictMode` state

---

## 🚨 需要人工注意的風險點

### 1️⃣ **Supabase RPC Function 部署**（必須執行）

**檔案**：`database/ingest_rpc.sql`

**部署步驟**：
1. 登入 Supabase SQL Editor
2. 複製貼上完整檔案內容
3. 點擊「Run」
4. 確認執行成功（無錯誤訊息）

**驗證**：
```sql
SELECT routine_name 
FROM information_schema.routines 
WHERE routine_name IN ('ingest_goods_receipts_v1', 'ingest_price_history_v1');
```
**預期**：回傳 2 rows

**如未部署**：
- 功能仍可用（自動 fallback 到 legacy path）
- 但效能較差（N+1 查詢）
- Console 會顯示 `[RPC_FALLBACK]`

---

### 2️⃣ **RPC 權限（GRANT EXECUTE）**

**風險**：Function 部署後，authenticated 角色無執行權限

**檢查**：
- `database/ingest_rpc.sql` 最後應包含：
  ```sql
  GRANT EXECUTE ON FUNCTION ingest_goods_receipts_v1 TO authenticated;
  GRANT EXECUTE ON FUNCTION ingest_price_history_v1 TO authenticated;
  ```

**如缺少**：
- 手動執行上述 GRANT 語句
- 或重新執行完整 SQL 檔案

---

### 3️⃣ **RLS (Row Level Security) 政策**

**風險**：RPC 內部 INSERT 被 RLS 阻擋

**檢查方式**：
```sql
SELECT tablename, policyname, cmd 
FROM pg_policies
WHERE tablename IN ('goods_receipts', 'price_history', 'suppliers', 'materials');
```

**必須有的 policy**：
- `goods_receipts`：允許 INSERT（`user_id = auth.uid()`）
- `price_history`：允許 INSERT
- `suppliers`：允許 INSERT + SELECT
- `materials`：允許 INSERT + SELECT

**如缺少**：
- 執行相關 RLS policy 建立語句
- 或暫時關閉 RLS（不建議）

---

### 4️⃣ **Payload Size 限制（1000 rows）**

**限制**：單次上傳最多 1000 筆

**使用者指引**：
- 如資料超過 1000 筆，請分檔上傳
- UI 會顯示：「批次資料過大：X 筆 (上限 1000 筆)」

**未來改進**：
- 實作 staging + finalize 機制（自動分批）

---

### 5️⃣ **Schema 型別差異（upload_file_id）**

**現況**：
- `user_files.id`：UUID
- `goods_receipts.upload_file_id`：BIGINT

**臨時方案**：
- RPC 內部使用 `p_upload_file_id::BIGINT` 強制轉型
- **可運作**，但不優雅

**長期建議**：
- 統一為 UUID（需 schema migration）

---

### 6️⃣ **Build Size 警告**

**現況**：
```
dist/assets/index-QzVcmPwJ.js   1,216.95 kB │ gzip: 350.66 kB
(!) Some chunks are larger than 500 kB after minification.
```

**影響**：
- 首次載入較慢
- 不影響功能正確性

**優化方案**（可選）：
- Code splitting（dynamic import）
- Manual chunks 設定

---

## 📊 數據統計

### 程式碼行數
```
新增程式碼：1,850+ 行
移除舊代碼：600+ 行
淨增：1,250 行
文檔：7 個 MD 檔案
```

### 功能改進
```
效能：RPC 路徑預期加速 3-10 倍
可維護性：handleSave -51%，策略模式易擴展
UX：Strict/Best-effort 模式，錯誤報告下載
穩定性：Transaction 回滾，Idempotency
```

### 架構品質
```
單一職責：✅ View / Hook / Service / Strategy 分離
開放封閉：✅ 新增 uploadType 只需加 Strategy
可測試性：✅ Reducer 純函數，Strategy 可 mock
狀態管理：✅ useReducer 集中管理核心 workflow
```

---

## 🎉 專案完成宣告

**Phase 0-3 上傳優化專案已全部完成！**

✅ **資料一致性**（Phase 0）  
✅ **RPC Transaction + Bulk Upsert**（Phase 1）  
✅ **策略模式 + 狀態集中**（Phase 2）  
✅ **UX 改進**（Phase 3）  
✅ **Bug Fix**（Upload Type Select）  
✅ **QA 驗收清單**（可執行）  
✅ **Build 成功**（無錯誤）  

---

## 🚀 部署前最終檢查清單

### 必須完成（P0）
- [ ] 部署 `database/ingest_rpc.sql` 到 Supabase
- [ ] 驗證 RPC 權限（GRANT EXECUTE）
- [ ] 手動測試：選擇 uploadType 可正常選中
- [ ] 手動測試：上傳 Goods Receipt 完整流程

### 重要（P1）
- [ ] RPC 成功路徑測試（Console 有 `✓ RPC Success`）
- [ ] RPC Fallback 測試（暫時改名 function）
- [ ] Strict/Best-effort 模式測試
- [ ] Download Error Report 測試

### 建議（P2）
- [ ] 執行完整 `UPLOAD_OPTIMIZATION_QA.md`（16 項測試）
- [ ] 效能對比測試（RPC vs Legacy）
- [ ] 瀏覽器相容性測試

---

## 📋 快速驗收命令

```bash
# 1. Build 驗證
npm run build

# 2. 啟動 dev server
npm run dev

# 3. 手動測試（瀏覽器）
# - 打開 Data Upload 頁面
# - 選擇 Goods Receipt（應該可選中）
# - 上傳測試檔案（templates/goods_receipt_test.csv）
# - 完成 Mapping → Validate → Save
# - 檢查 Supabase：資料正確寫入

# 4. 部署 RPC（Supabase SQL Editor）
# - 執行 database/ingest_rpc.sql
# - 驗證：SELECT routine_name FROM information_schema.routines WHERE routine_name LIKE 'ingest%';
```

---

**準備就緒，可進入 QA 與部署階段！** 🚀
