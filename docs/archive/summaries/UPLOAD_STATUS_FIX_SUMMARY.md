# 上傳失敗處理和狀態管理修復總結

## 🎯 修復目標

解決以下問題：
1. 上傳失敗時狀態顯示為「處理中」而非「失敗」
2. 處理中/失敗的記錄出現在 Supplier Management 列表
3. 查詢 goods_receipts 時出現 400 錯誤（`gr_date` 欄位不存在）
4. 失敗的記錄無法清理

---

## ✅ 已完成的修復

### 1. 修復 `gr_date` 欄位錯誤
**檔案**：`src/services/importHistoryService.js`  
**位置**：第 386 行  
**變更**：
```javascript
// 修改前
query = query.order('gr_date', { ascending: false });

// 修改後
query = query.order('receipt_date', { ascending: false });
```
**說明**：`goods_receipts` 表中沒有 `gr_date` 欄位，改用 `receipt_date` 進行排序。

---

### 2. 修正失敗狀態設置
**檔案**：`src/views/EnhancedExternalSystemsView.jsx`  
**位置**：第 763-773 行  
**變更**：
```javascript
// 修改前
await importBatchesService.updateBatch(batchId, {
  status: 'pending',  // ❌ 錯誤
  metadata: { error: errorMsg }
});

// 修改後
await importBatchesService.updateBatch(batchId, {
  status: 'failed',  // ✅ 正確
  successRows: 0,
  errorRows: rawRows.length,
  metadata: { 
    error: errorMsg,
    failedAt: new Date().toISOString(),
    originalFileName: fileName,
    uploadType: uploadType
  }
});
```
**說明**：當上傳失敗時，正確地將狀態設為 `'failed'` 而不是 `'pending'`，並記錄詳細的錯誤資訊。

---

### 3. 過濾處理中的記錄
**檔案**：`src/services/importHistoryService.js`  
**位置**：第 85-121 行  
**變更**：
```javascript
// 新增 includeStatuses 選項，預設只顯示完成/失敗/已撤銷的記錄
async getAllBatches(userId, options = {}) {
  const { 
    limit = 100, 
    offset = 0, 
    uploadType = null, 
    status = null,
    includeStatuses = ['completed', 'failed', 'undone']  // 新增
  } = options;
  
  // ... 省略部分代碼 ...
  
  // 修改狀態篩選邏輯
  if (status) {
    query = query.eq('status', status);
  } else {
    query = query.in('status', includeStatuses);  // 預設過濾掉 pending
  }
}
```
**說明**：預設情況下，查詢匯入歷史時會過濾掉 `pending` 狀態的記錄，避免處理中的記錄出現在列表中。

---

### 4. 新增批量刪除失敗記錄功能
**檔案**：`src/services/importHistoryService.js`  
**位置**：第 790-804 行（新增）  
**變更**：
```javascript
/**
 * 批量刪除失敗的批次記錄
 * @param {string} userId - 使用者 ID
 * @returns {Promise<Object>} 刪除結果
 */
async deleteFailedBatches(userId) {
  const { data, error } = await supabase
    .from('import_batches')
    .delete()
    .eq('user_id', userId)
    .in('status', ['failed', 'pending'])
    .select();

  if (error) throw error;
  return { success: true, deletedCount: data?.length || 0 };
}
```
**說明**：新增方法可以一次性刪除所有失敗和處理中的批次記錄。

---

## 📝 狀態說明

修復後，系統會正確管理以下批次狀態：

| 狀態 | 說明 | 是否顯示在列表 | 可用操作 |
|------|------|--------------|---------|
| `pending` | 處理中（上傳剛開始） | ❌ 否 | 刪除記錄 |
| `completed` | 已完成 | ✅ 是 | 撤回資料 |
| `failed` | 失敗 | ✅ 是 | 刪除記錄 |
| `undone` | 已撤銷 | ✅ 是 | - |

---

## 🧪 測試步驟

### 測試案例 1：正常上傳（應該正常運作）
1. 上傳有效的 `goods_receipts` 資料
2. ✅ 驗證批次狀態為 `completed`
3. ✅ 驗證記錄顯示在匯入歷史列表中
4. ✅ 驗證可以查看上傳的資料（不會出現 400 錯誤）

### 測試案例 2：上傳失敗（修復後行為）
1. 上傳無效資料（例如：故意輸入錯誤格式）
2. ✅ 驗證批次狀態為 `failed`（而非 `pending`）
3. ✅ 驗證記錄顯示在匯入歷史列表中
4. ✅ 驗證顯示失敗原因
5. ✅ 驗證可以刪除失敗記錄

### 測試案例 3：查詢歷史記錄（修復後不會出錯）
1. 在 Import History 頁面查看記錄
2. ✅ 驗證查詢 goods_receipts 資料時不會出現 400 錯誤
3. ✅ 驗證只顯示完成/失敗/已撤銷的記錄
4. ✅ 驗證不會看到處理中的記錄

---

## 🔄 後續建議（第二輪優化）

### UI 層面的改進（需要額外實作）

以下功能已經在 Service 層實作，但 UI 還需要相應的按鈕和介面：

1. **顯示失敗原因**
   - 在列表中顯示 `batch.metadata?.error` 的內容
   
2. **區分操作按鈕**
   - `completed` 狀態：顯示「撤回資料」按鈕
   - `failed` 狀態：顯示「刪除記錄」按鈕
   
3. **批量清理按鈕**
   - 使用新增的 `deleteFailedBatches()` 方法
   - 範例：
   ```javascript
   const handleCleanupFailed = async () => {
     if (confirm('確定要清理所有失敗的記錄嗎？')) {
       try {
         const result = await importBatchesService.deleteFailedBatches(user.id);
         addNotification(`已清理 ${result.deletedCount} 筆記錄`, 'success');
         loadBatches();
       } catch (error) {
         addNotification(`清理失敗: ${error.message}`, 'error');
       }
     }
   };
   ```

---

## 📊 變更檔案清單

- ✅ `src/services/importHistoryService.js` - 修復查詢欄位、過濾狀態、新增批量刪除
- ✅ `src/views/EnhancedExternalSystemsView.jsx` - 修正失敗狀態設置

---

## 🚀 部署注意事項

1. **資料庫欄位確認**
   - 確認 `goods_receipts` 表確實有 `receipt_date` 欄位
   - 如果使用不同的欄位名稱，需要相應調整第 386 行的排序欄位

2. **現有失敗記錄**
   - 部署後，之前狀態為 `pending` 的失敗記錄仍會保留
   - 可以使用新的 `deleteFailedBatches()` 方法清理

3. **向後相容性**
   - `getAllBatches()` 的預設行為已改變（會過濾 pending）
   - 如果有其他地方需要查詢 pending 記錄，可以傳入 `includeStatuses: ['pending', 'completed', 'failed', 'undone']`

---

## ✅ 修復確認

- [x] 修復 `gr_date` 欄位錯誤
- [x] 修正失敗狀態設置
- [x] 過濾處理中的記錄
- [x] 新增批量刪除功能
- [ ] UI 顯示失敗原因（待實作）
- [ ] UI 區分操作按鈕（待實作）
- [ ] UI 批量清理按鈕（待實作）

---

**修復日期**：2026-01-31  
**修復人員**：AI Assistant  
**影響範圍**：上傳失敗處理、匯入歷史查詢
