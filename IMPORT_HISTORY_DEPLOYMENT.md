# 匯入歷史功能 - 部署指南

## 部署步驟

### 1. 資料庫遷移

在 Supabase SQL Editor 中執行以下 SQL 檔案：

```bash
database/import_batches_schema.sql
```

這將會：
- 建立 `import_batches` 表格
- 在業務表格中新增 `batch_id` 欄位（suppliers, materials, goods_receipts, price_history）
- 建立索引以優化查詢效能
- 設定 RLS (Row Level Security) 政策
- 建立撤銷函數 `undo_import_batch` 和 `undo_multiple_batches`
- 建立視圖 `v_import_history`

### 2. 驗證資料庫變更

執行以下查詢確認表格已建立：

```sql
-- 檢查 import_batches 表格
SELECT * FROM import_batches LIMIT 1;

-- 檢查業務表格是否有 batch_id 欄位
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'suppliers' 
AND column_name = 'batch_id';

-- 檢查函數是否存在
SELECT routine_name 
FROM information_schema.routines 
WHERE routine_name IN ('undo_import_batch', 'undo_multiple_batches');
```

### 3. 前端程式碼已更新

以下檔案已自動更新，無需手動修改：

#### 新增檔案：
- ✅ `src/services/importHistoryService.js` - 匯入歷史服務
- ✅ `src/views/ImportHistoryView.jsx` - 匯入歷史 UI 元件
- ✅ `database/import_batches_schema.sql` - 資料庫架構
- ✅ `IMPORT_HISTORY_GUIDE.md` - 使用指南

#### 修改檔案：
- ✅ `src/App.jsx` - 新增 Import History 路由和選單項目
- ✅ `src/views/EnhancedExternalSystemsView.jsx` - 整合批次追蹤到上傳流程
- ✅ `src/services/supabaseClient.js` - 匯出 importBatchesService

### 4. 測試功能

#### 4.1 測試資料上傳
1. 登入系統
2. 前往「External Systems」
3. 上傳測試資料（例如：供應商主檔）
4. 完成上傳流程
5. 確認資料成功儲存

#### 4.2 測試匯入歷史
1. 前往「Import History」
2. 確認剛才的上傳記錄出現在列表中
3. 檢查批次資訊是否正確：
   - 檔案名稱
   - 上傳類型
   - 成功/失敗行數
   - 狀態（應為「已完成」）

#### 4.3 測試預覽功能
1. 在匯入歷史列表中點擊「眼睛」圖示
2. 確認預覽視窗顯示正確的資料
3. 檢查資料筆數（最多 50 筆）

#### 4.4 測試撤銷功能
1. 選擇一個測試批次
2. 點擊「撤銷」圖示
3. 確認警告訊息
4. 執行撤銷
5. 確認：
   - 批次狀態更新為「已撤銷」
   - 資料從目標表格中刪除
   - 顯示成功訊息

#### 4.5 測試批量撤銷
1. 上傳多個測試批次
2. 勾選多個批次
3. 點擊「批量撤銷」
4. 確認操作
5. 驗證所有批次都被正確撤銷

### 5. 權限檢查

確認 RLS 政策正常運作：

```sql
-- 以不同使用者身份測試
-- 使用者應該只能看到自己的批次
SELECT * FROM import_batches WHERE user_id = auth.uid();

-- 測試撤銷權限
SELECT undo_import_batch(
  '批次UUID',
  auth.uid()
);
```

### 6. 效能優化（可選）

如果有大量匯入記錄，考慮：

```sql
-- 建立額外的複合索引
CREATE INDEX idx_import_batches_user_status 
ON import_batches(user_id, status);

CREATE INDEX idx_import_batches_user_created 
ON import_batches(user_id, created_at DESC);

-- 定期清理舊的已撤銷記錄（可選）
DELETE FROM import_batches 
WHERE status = 'undone' 
AND undone_at < NOW() - INTERVAL '90 days';
```

## 回滾計畫

如果需要回滾此功能：

### 1. 移除前端路由

在 `src/App.jsx` 中：
```javascript
// 移除這一行
case 'import-history': return <ImportHistoryView addNotification={addNotification} user={session?.user} />;
```

### 2. 移除選單項目

在 `src/App.jsx` 的 `dataModules` 中移除：
```javascript
{ 
  id: 'import-history', 
  title: "Import History", 
  // ...
}
```

### 3. 還原上傳流程

在 `src/views/EnhancedExternalSystemsView.jsx` 中：
- 移除 `importBatchesService` 的引用
- 移除 `handleSave` 函數中的批次建立和更新邏輯
- 移除 `batchId` 參數傳遞

### 4. 資料庫回滾（謹慎！）

```sql
-- 移除 batch_id 欄位
ALTER TABLE suppliers DROP COLUMN IF EXISTS batch_id;
ALTER TABLE materials DROP COLUMN IF EXISTS batch_id;
ALTER TABLE goods_receipts DROP COLUMN IF EXISTS batch_id;
ALTER TABLE price_history DROP COLUMN IF EXISTS batch_id;

-- 刪除函數
DROP FUNCTION IF EXISTS undo_import_batch(UUID, UUID);
DROP FUNCTION IF EXISTS undo_multiple_batches(UUID[], UUID);

-- 刪除視圖
DROP VIEW IF EXISTS v_import_history;

-- 刪除表格
DROP TABLE IF EXISTS import_batches;
```

**⚠️ 警告**：資料庫回滾會永久刪除所有匯入歷史記錄！

## 常見問題

### Q: 舊的資料會有 batch_id 嗎？
A: 不會。只有新上傳的資料才會有 batch_id。舊資料的 batch_id 為 NULL。

### Q: 可以撤銷沒有 batch_id 的資料嗎？
A: 不可以。只有通過新的上傳流程建立的批次才能被撤銷。

### Q: 撤銷會影響其他使用者的資料嗎？
A: 不會。RLS 政策確保使用者只能撤銷自己的批次。

### Q: 批次記錄會佔用多少空間？
A: 每個批次記錄約 1-2 KB。即使有 10,000 個批次，也只佔用約 10-20 MB。

## 監控建議

建議監控以下指標：

1. **批次建立速率**
   ```sql
   SELECT DATE(created_at), COUNT(*) 
   FROM import_batches 
   GROUP BY DATE(created_at) 
   ORDER BY DATE(created_at) DESC;
   ```

2. **撤銷操作頻率**
   ```sql
   SELECT DATE(undone_at), COUNT(*) 
   FROM import_batches 
   WHERE status = 'undone' 
   GROUP BY DATE(undone_at) 
   ORDER BY DATE(undone_at) DESC;
   ```

3. **失敗率**
   ```sql
   SELECT 
     upload_type,
     AVG(error_rows::float / NULLIF(total_rows, 0) * 100) as avg_error_rate
   FROM import_batches 
   WHERE status = 'completed'
   GROUP BY upload_type;
   ```

## 完成檢查清單

部署前確認：

- [ ] 資料庫 SQL 已執行
- [ ] import_batches 表格已建立
- [ ] 業務表格已新增 batch_id 欄位
- [ ] RLS 政策已啟用
- [ ] 撤銷函數已建立
- [ ] 前端程式碼已更新
- [ ] 測試資料上傳功能
- [ ] 測試匯入歷史查詢
- [ ] 測試預覽功能
- [ ] 測試撤銷功能
- [ ] 測試批量撤銷
- [ ] 權限測試通過
- [ ] 使用者文件已準備

## 支援

如有部署問題，請檢查：
1. Supabase 連線狀態
2. 資料庫 SQL 執行日誌
3. 瀏覽器控制台錯誤訊息
4. 網路請求狀態

---

**部署日期**: 2025-12-06  
**版本**: 1.0.0  
**負責人**: AI Assistant





