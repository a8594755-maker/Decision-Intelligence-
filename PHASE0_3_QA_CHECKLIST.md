# Phase 0-3 上傳優化專案 - QA 驗收清單

## 📋 測試環境

- **專案**：SmartOps App (Vite + React + Supabase)
- **分支**：`feat/upload-optimization`
- **測試日期**：2026-02-05
- **測試者**：_____________

---

## ✅ Phase 0：資料一致性

### 目標
確保 `batch_id`, `upload_file_id`, `user_files.id` 一致性

### 測試項目

#### 0.1 userFilesService.saveFile 回傳 id
- [ ] 上傳任意檔案
- [ ] 檢查 Console：`fileRecord` 物件包含 `id` 欄位
- [ ] 檢查 Supabase `user_files` 表：最新記錄的 `id` 非 NULL

**驗證 SQL**：
```sql
SELECT id, filename, created_at 
FROM user_files 
WHERE user_id = auth.uid()
ORDER BY created_at DESC 
LIMIT 1;
```

#### 0.2 goods_receipts 寫入 upload_file_id 和 batch_id
- [ ] 上傳 Goods Receipt（< 10 筆測試資料）
- [ ] 成功儲存後，執行驗證 SQL
- [ ] 確認 `upload_file_id` 非 NULL
- [ ] 確認 `batch_id` 非 NULL

**驗證 SQL**：
```sql
SELECT id, upload_file_id, batch_id, created_at
FROM goods_receipts
WHERE user_id = auth.uid()
ORDER BY created_at DESC
LIMIT 10;
```

#### 0.3 price_history 寫入 upload_file_id 和 batch_id
- [ ] 上傳 Price History（< 10 筆測試資料）
- [ ] 成功儲存後，執行驗證 SQL
- [ ] 確認 `upload_file_id` 非 NULL
- [ ] 確認 `batch_id` 非 NULL

**驗證 SQL**：
```sql
SELECT id, upload_file_id, batch_id, created_at
FROM price_history
WHERE user_id = auth.uid()
ORDER BY created_at DESC
LIMIT 10;
```

#### 0.4 向後相容性測試（可選）
- [ ] 若有舊代碼呼叫 `batchInsert(userId, records, uploadFileId)`（字串參數）
- [ ] 確認仍可正常運作（adapter 正確處理）

**備註**：Phase 2 已移除舊 save 函數，此項測試可略過

---

## ✅ Phase 1：RPC Transaction + Bulk Upsert

### 目標
Goods Receipt 和 Price History 使用高效能 RPC，具交易性與 idempotency

### 測試項目

#### 1.1 RPC Function 部署檢查
- [ ] 登入 Supabase SQL Editor
- [ ] 執行測試 SQL：
  ```sql
  SELECT routine_name 
  FROM information_schema.routines 
  WHERE routine_name IN ('ingest_goods_receipts_v1', 'ingest_price_history_v1');
  ```
- [ ] 確認兩個 function 存在

#### 1.2 Goods Receipt RPC Happy Path
- [ ] 上傳 Goods Receipt（20-50 筆，< 1000）
- [ ] 檢查 Console：`[GoodsReceiptStrategy] ✓ RPC Success`
- [ ] 檢查 UI：「✓ 使用交易性寫入完成（X 筆，建立 Y 個供應商）」
- [ ] 檢查 Supabase：
  ```sql
  SELECT COUNT(*) FROM goods_receipts WHERE batch_id = '{最新 batch_id}';
  ```
- [ ] 確認 `suppliers` 和 `materials` 自動建立

#### 1.3 Price History RPC Happy Path
- [ ] 上傳 Price History（20-50 筆）
- [ ] 檢查 Console：`[PriceHistoryStrategy] ✓ RPC Success`
- [ ] 檢查 UI：「✓ 使用交易性寫入完成」
- [ ] 檢查 Supabase：資料正確寫入

#### 1.4 RPC Idempotency 測試
- [ ] 上傳 Goods Receipt（記下 `batch_id`）
- [ ] 手動執行 RPC（相同 `batch_id`）：
  ```sql
  SELECT ingest_goods_receipts_v1(
    '{batch_id}'::uuid,
    '{upload_file_id}'::uuid,
    '[{...}]'::jsonb
  );
  ```
- [ ] 檢查 DB：相同 `batch_id` 只有一組資料（舊資料已刪除）

#### 1.5 RPC Fallback 測試
- [ ] **方法 A**：暫時註解 RPC function（或改名）
- [ ] 上傳 Goods Receipt
- [ ] 檢查 Console：`[RPC_FALLBACK] RPC failed, using legacy path`
- [ ] 檢查 UI：「⚠️ 已切換到相容模式」
- [ ] 檢查 DB：資料仍正確寫入（使用舊 N+1 邏輯）

#### 1.6 批次大小限制測試
- [ ] 上傳 > 1000 筆資料
- [ ] 檢查 UI：「批次資料過大：X 筆 (上限 1000 筆)」
- [ ] 確認 DB **無部分資料**（BatchSizeError 直接拋出，不 fallback）

#### 1.7 RPC Transaction Rollback 測試
- [ ] 在 RPC function 中故意加入 `RAISE EXCEPTION 'Test rollback'`
- [ ] 上傳資料
- [ ] 檢查 DB：**無任何部分資料**（transaction 已回滾）
- [ ] 恢復 RPC function

---

## ✅ Phase 2：策略模式 + 狀態集中

### 目標
`handleSave` < 100 行，策略模式模組化，狀態集中管理

### 測試項目

#### 2.1 策略模式 - Goods Receipt
- [ ] 上傳 Goods Receipt
- [ ] 檢查 Console：`[GoodsReceiptStrategy] Starting for X rows`
- [ ] 確認策略模式正確執行

#### 2.2 策略模式 - Price History
- [ ] 上傳 Price History
- [ ] 檢查 Console：`[PriceHistoryStrategy] Starting for X rows`
- [ ] 確認策略模式正確執行

#### 2.3 策略模式 - Supplier Master
- [ ] 上傳 Supplier Master
- [ ] 檢查 Console：`[SupplierMasterStrategy] Starting for X rows`
- [ ] 確認資料正確寫入 `suppliers` 表

#### 2.4 策略模式 - BOM Edge
- [ ] 上傳 BOM Edge
- [ ] 檢查 Console：`[BomEdgeStrategy] Starting for X rows`
- [ ] 確認資料正確寫入 `bom_edges` 表

#### 2.5 策略模式 - Demand FG
- [ ] 上傳 Demand FG
- [ ] 檢查 Console：`[DemandFgStrategy] Starting for X rows`
- [ ] 確認資料正確寫入 `demand_fg` 表

#### 2.6 策略模式 - 其他 Upload Types
- [ ] PO Open Lines：正確寫入 `po_open_lines`
- [ ] Inventory Snapshots：正確寫入 `inventory_snapshots`
- [ ] FG Financials：正確寫入 `fg_financials`

#### 2.7 狀態集中管理（useUploadWorkflow）
- [ ] 檢查檔案：`src/hooks/useUploadWorkflow.js` 存在
- [ ] 檢查 `EnhancedExternalSystemsView.jsx`：
  - `const { state, actions } = useUploadWorkflow()`
  - 使用 `workflowActions.setUploadType` 等
- [ ] 手動測試各步驟：state 正確更新

#### 2.8 handleSave 精簡驗證
- [ ] 檢查 `handleSave` 函數：
  - 總行數：< 100 行（含註解）
  - 無 if-else 分支（uploadType）
  - 使用 `getUploadStrategy(uploadType)`
- [ ] 手動測試：各 uploadType 正常儲存

---

## ✅ Phase 3：UX 改進

### 目標
Strict/Best-effort 模式，錯誤報告 CSV 下載

### 測試項目

#### 3.1 Best-effort Mode（預設）
- [ ] 上傳包含錯誤的資料（例如：100 筆，10 筆錯誤）
- [ ] 檢查 Validation step：
  - 顯示「90 valid, 10 errors」
  - **Best-effort** 預設選中
  - Instruction Text：「System will save 90 valid rows and skip 10 error rows」
- [ ] Save button **enabled**（綠色）
- [ ] 點 Save
- [ ] 檢查 DB：儲存 90 筆
- [ ] 檢查 UI：「Successfully saved 90 rows (10 errors skipped)」

#### 3.2 Strict Mode 切換
- [ ] 在 Validation step，切換到 **Strict** mode
- [ ] 檢查 UI：
  - Instruction Text 變為橘色：「Strict Mode: Cannot Save with Errors」
  - Save button **disabled**（灰色）
  - 按鈕旁顯示：「⚠️ Strict mode: Fix errors to enable save」

#### 3.3 Strict Mode 阻擋儲存
- [ ] 保持 Strict mode，點 Save（如果可點）
- [ ] 檢查 Console：無 DB 寫入相關 log
- [ ] 檢查 UI：「Strict mode enabled: Cannot save with X error rows...」
- [ ] 檢查 DB：**0 筆新增**（未執行 `strategy.ingest`）

#### 3.4 Download Error Report
- [ ] 上傳包含錯誤的資料
- [ ] 檢查 Validation step：顯示「Download Error Report (.csv)」按鈕
- [ ] 點擊按鈕
- [ ] 檢查：瀏覽器自動下載 CSV
- [ ] 檢查檔名格式：`error-report_{uploadType}_{fileName}_{timestamp}.csv`

#### 3.5 Error Report 內容驗證
- [ ] 開啟下載的 CSV（Excel 或文字編輯器）
- [ ] 檢查標題列：
  ```
  Row Index,Field,Original Value,Error Message,Full Row Data (JSON)
  ```
- [ ] 檢查資料行：
  - `Row Index`：正確行號（從 1 開始）
  - `Field`：錯誤欄位名稱
  - `Original Value`：原始值
  - `Error Message`：錯誤原因
  - `Full Row Data (JSON)`：完整原始資料（JSON 格式）
- [ ] 檢查特殊字元處理：
  - 包含逗號的值：用雙引號包裹
  - 包含雙引號的值：轉義為 `""`
  - 包含換行的值：正確處理

#### 3.6 Strict Mode 狀態持久性
- [ ] 切換到 Strict mode
- [ ] 回到 Mapping step（goBack）
- [ ] 再前進到 Validation step
- [ ] 檢查：Strict mode 仍選中（state 保持）

#### 3.7 Strict Mode 與全部有效資料
- [ ] 上傳全部有效資料（0 errors）
- [ ] 切換到 Strict mode
- [ ] 檢查：Save button **enabled**（綠色）
- [ ] 點 Save：正常儲存

---

## ✅ 整合測試

### 測試項目

#### I.1 完整流程：Goods Receipt（Best-effort）
1. [ ] Select Type：Goods Receipt
2. [ ] Upload：包含錯誤的 Excel/CSV（100 筆，10 筆錯誤）
3. [ ] Mapping：完成欄位映射
4. [ ] Validation：90 valid, 10 errors
5. [ ] Mode：保持 Best-effort
6. [ ] Save：成功儲存 90 筆
7. [ ] DB 驗證：
   - `goods_receipts`：90 筆
   - `suppliers`：自動建立
   - `materials`：自動建立
   - `batch_id` 非 NULL
   - `upload_file_id` 非 NULL

#### I.2 完整流程：Price History（Strict）
1. [ ] Select Type：Price History
2. [ ] Upload：包含錯誤的資料
3. [ ] Mapping：完成欄位映射
4. [ ] Validation：X valid, Y errors
5. [ ] Mode：切換到 **Strict**
6. [ ] 嘗試 Save：**阻擋**
7. [ ] Download Error Report
8. [ ] 手動修正錯誤，重新上傳
9. [ ] 全部有效（0 errors）
10. [ ] Save：成功儲存

#### I.3 完整流程：Supplier Master
1. [ ] Select Type：Supplier Master
2. [ ] Upload：包含重複供應商的資料
3. [ ] Mapping：完成欄位映射
4. [ ] Validation：檢查 merge 資訊
5. [ ] Save：成功儲存（使用 `insertSuppliers`）
6. [ ] DB 驗證：
   - 重複供應商已合併
   - `batch_id` 非 NULL

#### I.4 RPC + Strict Mode 整合
1. [ ] 上傳 Goods Receipt（< 1000 筆，包含錯誤）
2. [ ] Validation：切換到 Strict mode
3. [ ] 嘗試 Save：阻擋
4. [ ] 切換回 Best-effort
5. [ ] Save：RPC 成功執行（僅儲存有效資料）

#### I.5 RPC Fallback + Error Report
1. [ ] 暫時讓 RPC 失敗（如權限不足）
2. [ ] 上傳 Goods Receipt（包含錯誤）
3. [ ] 檢查 Console：`[RPC_FALLBACK]`
4. [ ] 檢查 UI：「⚠️ 已切換到相容模式」
5. [ ] Download Error Report
6. [ ] Save：使用 legacy path 成功儲存

---

## ✅ 錯誤處理測試

### 測試項目

#### E.1 檔案格式錯誤
- [ ] 上傳 `.txt` 檔案
- [ ] 檢查：「Invalid file type. Please upload CSV or Excel files」

#### E.2 檔案過大
- [ ] 上傳 > 10MB 檔案
- [ ] 檢查：「File too large. Maximum size is 10MB」

#### E.3 未選擇 Upload Type
- [ ] 未選擇 Type，直接點 Upload
- [ ] 檢查：「Please select upload type before choosing file」

#### E.4 欄位映射不完整
- [ ] 跳過必填欄位映射
- [ ] 點 Validate
- [ ] 檢查：「Please complete required field mapping first」

#### E.5 無有效資料
- [ ] 上傳全部錯誤的資料（0 valid rows）
- [ ] Validation：「No valid data to save」
- [ ] Save button disabled

#### E.6 未登入
- [ ] 登出
- [ ] 嘗試上傳資料
- [ ] 檢查：適當的錯誤訊息

---

## ✅ 效能測試

### 測試項目

#### P.1 小批次（< 100 筆）
- [ ] 上傳 50 筆 Goods Receipt
- [ ] 測量時間：從 Save 點擊到成功訊息
- [ ] 預期：< 3 秒（RPC 路徑）

#### P.2 中批次（100-500 筆）
- [ ] 上傳 300 筆 Goods Receipt
- [ ] 測量時間
- [ ] 預期：< 10 秒（RPC 路徑）

#### P.3 大批次（500-1000 筆）
- [ ] 上傳 800 筆 Goods Receipt
- [ ] 測量時間
- [ ] 預期：< 30 秒（RPC 路徑）

#### P.4 RPC vs Legacy 效能對比
- [ ] 上傳 500 筆 Goods Receipt（RPC 路徑）
- [ ] 記錄時間 T1
- [ ] 暫時停用 RPC，重新上傳相同資料（Legacy 路徑）
- [ ] 記錄時間 T2
- [ ] 比較：T1 < T2（預期 RPC 快 3-10 倍）

---

## ✅ 瀏覽器相容性測試

### 測試項目

#### B.1 Chrome（最新版）
- [ ] 完整流程：上傳 → 映射 → 驗證 → 儲存
- [ ] Download Error Report：正常下載

#### B.2 Firefox（最新版）
- [ ] 完整流程：正常運作
- [ ] Download Error Report：正常下載

#### B.3 Edge（最新版）
- [ ] 完整流程：正常運作
- [ ] Download Error Report：正常下載

#### B.4 Safari（最新版，如適用）
- [ ] 完整流程：正常運作
- [ ] Download Error Report：正常下載

---

## ✅ Build 與部署測試

### 測試項目

#### D.1 Build 成功
- [ ] 執行 `npm run build`
- [ ] 檢查：無 error
- [ ] 檢查：dist 資料夾生成

#### D.2 Linter 檢查
- [ ] 執行 `npm run lint`（如有設定）
- [ ] 檢查：無 critical errors

#### D.3 型別檢查（如使用 TypeScript）
- [ ] 執行型別檢查
- [ ] 檢查：無 type errors

---

## 📊 最終驗收結果

### Phase 0：資料一致性
- **通過項目**：___ / 4
- **狀態**：[ ] ✅ 完全通過  [ ] ⚠️ 部分通過  [ ] ❌ 未通過

### Phase 1：RPC Transaction
- **通過項目**：___ / 7
- **狀態**：[ ] ✅ 完全通過  [ ] ⚠️ 部分通過  [ ] ❌ 未通過

### Phase 2：策略模式
- **通過項目**：___ / 8
- **狀態**：[ ] ✅ 完全通過  [ ] ⚠️ 部分通過  [ ] ❌ 未通過

### Phase 3：UX 改進
- **通過項目**：___ / 7
- **狀態**：[ ] ✅ 完全通過  [ ] ⚠️ 部分通過  [ ] ❌ 未通過

### 整合測試
- **通過項目**：___ / 5
- **狀態**：[ ] ✅ 完全通過  [ ] ⚠️ 部分通過  [ ] ❌ 未通過

### 錯誤處理
- **通過項目**：___ / 6
- **狀態**：[ ] ✅ 完全通過  [ ] ⚠️ 部分通過  [ ] ❌ 未通過

### 效能測試
- **通過項目**：___ / 4
- **狀態**：[ ] ✅ 完全通過  [ ] ⚠️ 部分通過  [ ] ❌ 未通過

### 瀏覽器相容性
- **通過項目**：___ / 4
- **狀態**：[ ] ✅ 完全通過  [ ] ⚠️ 部分通過  [ ] ❌ 未通過

### Build 與部署
- **通過項目**：___ / 3
- **狀態**：[ ] ✅ 完全通過  [ ] ⚠️ 部分通過  [ ] ❌ 未通過

---

## 🐛 Issue Tracking

### 已發現問題

| ID | Phase | 嚴重性 | 描述 | 狀態 |
|----|-------|--------|------|------|
| 001 | | | | |
| 002 | | | | |
| 003 | | | | |

**嚴重性等級**：
- 🔴 Critical：阻斷性問題，必須修復
- 🟠 High：重要功能受影響，應盡快修復
- 🟡 Medium：次要功能受影響，可延後修復
- 🟢 Low：美觀或優化建議，可選修復

---

## 📝 測試備註

**測試環境**：
- OS: ______________
- Browser: ______________
- Node.js: ______________
- Supabase Project: ______________

**特殊測試場景**：
- [ ] 多人同時上傳（併發測試）
- [ ] 長時間 session（> 1 小時）
- [ ] 網路不穩定場景
- [ ] 大檔案（接近 10MB）

**測試數據**：
- [ ] 使用真實業務資料
- [ ] 使用生成的測試資料
- [ ] 包含邊界值測試

---

## ✅ 最終簽核

**開發者簽核**：
- 姓名：______________
- 日期：______________
- 簽名：______________

**測試者簽核**：
- 姓名：______________
- 日期：______________
- 簽名：______________

**專案負責人簽核**：
- 姓名：______________
- 日期：______________
- 簽名：______________

---

**Phase 0-3 上傳優化專案完成！** 🎉
