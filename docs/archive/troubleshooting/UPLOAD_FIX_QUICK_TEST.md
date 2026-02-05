# 上傳失敗修復 - 快速測試指南

## 🎯 測試目標

驗證以下修復是否生效：
1. ✅ 上傳失敗時狀態顯示為「失敗」而非「處理中」
2. ✅ 查詢 goods_receipts 不會出現 400 錯誤
3. ✅ 處理中的記錄不會顯示在列表中

---

## 📋 快速測試步驟

### 測試 1：驗證查詢修復（最重要）

**目的**：確認不再出現 400 錯誤

1. 開啟應用程式並登入
2. 前往 **Import History** 頁面
3. 查看是否有之前上傳的 goods_receipts 記錄
4. 點擊任一 goods_receipts 記錄查看詳情

**預期結果**：
- ✅ 不會出現 400 錯誤
- ✅ 可以正常顯示 goods_receipts 資料
- ✅ 瀏覽器控制台沒有錯誤訊息

**如果失敗**：
- 檢查 Supabase 資料庫中 `goods_receipts` 表是否有 `receipt_date` 欄位
- 如果欄位名稱不同，需要修改 `src/services/importHistoryService.js` 第 391 行

---

### 測試 2：驗證失敗狀態正確設置

**目的**：確認上傳失敗時狀態為 `failed`

1. 前往 **Data Upload** 頁面
2. 選擇 **Goods Receipt** 類型
3. 準備一個故意有錯誤的測試檔案（例如：缺少必填欄位）
4. 上傳該檔案
5. 等待上傳完成（應該會失敗）

**預期結果**：
- ✅ 看到錯誤提示訊息
- ✅ 前往 Import History 頁面，該記錄狀態為「失敗」（不是「處理中」）
- ✅ 可以看到失敗原因

**批次記錄應該包含**：
```json
{
  "status": "failed",
  "success_rows": 0,
  "error_rows": [總行數],
  "metadata": {
    "error": "[錯誤訊息]",
    "failedAt": "[時間戳]",
    "originalFileName": "[檔案名稱]",
    "uploadType": "goods_receipt"
  }
}
```

---

### 測試 3：驗證處理中的記錄不顯示

**目的**：確認只顯示完成/失敗/已撤銷的記錄

**手動測試**（不建議）：
1. 理論上，`pending` 狀態的記錄不應該出現在列表中
2. 如果之前有卡在 `pending` 的記錄，它們將不再顯示

**資料庫驗證**（建議）：
1. 開啟 Supabase Dashboard
2. 進入 SQL Editor
3. 執行以下查詢：

```sql
-- 查看所有批次記錄及其狀態
SELECT 
  id,
  filename,
  upload_type,
  status,
  success_rows,
  error_rows,
  created_at
FROM import_batches
ORDER BY created_at DESC
LIMIT 20;
```

4. 確認 `status = 'pending'` 的記錄（如果有）不會出現在前端列表中

---

## 🔧 如何清理舊的失敗記錄

如果有舊的 `pending` 或 `failed` 記錄需要清理：

### 方法 1：使用 SQL（快速）

在 Supabase SQL Editor 中執行：

```sql
-- 清理所有失敗和處理中的記錄
DELETE FROM import_batches
WHERE status IN ('failed', 'pending')
  AND user_id = '[您的 user_id]';
```

### 方法 2：使用 API（推薦，已實作）

在瀏覽器控制台執行：

```javascript
// 假設您已經登入
const userId = 'your-user-id-here';

// 調用批量刪除 API
const { data, error } = await importBatchesService.deleteFailedBatches(userId);

if (error) {
  console.error('清理失敗:', error);
} else {
  console.log(`成功清理 ${data.deletedCount} 筆記錄`);
}
```

### 方法 3：等待 UI 實作（未來）

未來將在 Import History 頁面新增「清理失敗記錄」按鈕。

---

## ✅ 驗收標準

所有測試通過後，應該滿足以下條件：

- [ ] 查詢 goods_receipts 不會出現 400 錯誤
- [ ] 上傳失敗時，批次狀態為 `failed`（不是 `pending`）
- [ ] Import History 列表中不會顯示 `pending` 狀態的記錄
- [ ] 失敗記錄包含詳細的錯誤資訊
- [ ] 可以正常查看和撤回成功的記錄

---

## 🐛 如果遇到問題

### 問題 1：仍然出現 400 錯誤

**可能原因**：`goods_receipts` 表的欄位名稱不是 `receipt_date`

**解決方法**：
1. 檢查資料庫 schema
2. 修改 `src/services/importHistoryService.js` 第 391 行
3. 改為正確的欄位名稱（例如：`actual_delivery_date` 或其他）

### 問題 2：上傳失敗但狀態仍是 `pending`

**可能原因**：瀏覽器快取或代碼未重新載入

**解決方法**：
1. 重新整理頁面（Ctrl+Shift+R 強制重新載入）
2. 清除瀏覽器快取
3. 重新啟動開發伺服器

### 問題 3：舊的失敗記錄仍然顯示

**原因**：之前的失敗記錄狀態是 `pending`，現在被過濾掉了

**這不是問題**：這正是預期行為！舊的 `pending` 記錄不會顯示。

如需清理，請使用上述「清理舊的失敗記錄」方法。

---

## 📞 需要協助？

如果測試過程中遇到任何問題，請提供以下資訊：

1. 瀏覽器控制台的完整錯誤訊息
2. 上傳的檔案內容（前幾行即可）
3. Supabase 資料庫中 `goods_receipts` 表的 schema
4. `import_batches` 表中相關記錄的 `metadata` 欄位內容

---

**修復版本**：2026-01-31  
**測試預估時間**：10-15 分鐘
