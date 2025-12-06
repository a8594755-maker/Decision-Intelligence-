# 如何重置所有業務資料

## 📋 這個操作會做什麼？

**會刪除：**
- ✅ 所有供應商資料（422 筆）
- ✅ 所有物料資料
- ✅ 所有收貨記錄
- ✅ 所有價格歷史
- ✅ 所有匯入歷史記錄

**會保留：**
- ✅ 所有表格結構
- ✅ 所有欄位（包括 batch_id）
- ✅ 所有索引
- ✅ 所有 RLS 政策
- ✅ 所有函數（撤銷功能）
- ✅ 使用者帳號和認證

## 🚀 執行步驟

### 步驟 1：開啟 Supabase SQL Editor

1. 前往：https://supabase.com/dashboard
2. 登入並選擇您的專案
3. 點擊左側選單的 **「SQL Editor」**
4. 點擊 **「+ New query」**

### 步驟 2：複製並執行 SQL

1. 開啟檔案：`database/reset_all_data.sql`
2. 複製整個檔案內容
3. 貼到 Supabase SQL Editor
4. 點擊 **「Run」** 或按 `Ctrl + Enter`

### 步驟 3：查看執行結果

執行後您會看到類似以下的訊息：

```
NOTICE:  ========================================
NOTICE:  當前資料筆數：
NOTICE:  ----------------------------------------
NOTICE:  suppliers (供應商): 422
NOTICE:  materials (物料): 150
NOTICE:  goods_receipts (收貨記錄): 0
NOTICE:  price_history (價格歷史): 0
NOTICE:  import_batches (匯入批次): 0
NOTICE:  ========================================
NOTICE:  
NOTICE:  ⚠️  準備清空所有資料...
NOTICE:  
NOTICE:  ========================================
NOTICE:  ✅ 清理完成！
NOTICE:  ----------------------------------------
NOTICE:  清理後資料筆數：
NOTICE:  suppliers (供應商): 0
NOTICE:  materials (物料): 0
NOTICE:  goods_receipts (收貨記錄): 0
NOTICE:  price_history (價格歷史): 0
NOTICE:  import_batches (匯入批次): 0
NOTICE:  ----------------------------------------
NOTICE:  總計: 0 筆資料
NOTICE:  ========================================
NOTICE:  
NOTICE:  🎉 所有資料已成功清空！
NOTICE:  📝 表格結構和功能完好保留
NOTICE:  🚀 現在可以重新開始上傳測試資料
```

### 步驟 4：驗證結果

在 SQL Editor 中執行以下查詢確認：

```sql
SELECT 
  'suppliers' as table_name, 
  COUNT(*) as count 
FROM suppliers
UNION ALL
SELECT 'materials', COUNT(*) FROM materials
UNION ALL
SELECT 'goods_receipts', COUNT(*) FROM goods_receipts
UNION ALL
SELECT 'price_history', COUNT(*) FROM price_history
UNION ALL
SELECT 'import_batches', COUNT(*) FROM import_batches;
```

所有表格的 count 都應該是 0。

### 步驟 5：重新載入應用程式

1. 回到您的應用程式
2. 按 `Ctrl + Shift + R` 強制重新載入
3. 前往「Supplier Management」
4. 確認供應商列表為空（Total Suppliers: 0）

## ✅ 現在可以做什麼？

資料清空後，您可以：

1. **測試匯入歷史功能**
   - 前往 External Systems
   - 上傳測試資料
   - 查看 Import History
   - 測試預覽和撤銷功能

2. **重新匯入乾淨的資料**
   - 準備新的測試資料檔案
   - 使用 External Systems 上傳
   - 所有新上傳的資料都會有 batch_id
   - 可以在 Import History 中追蹤和管理

## ⚠️ 重要提醒

- **此操作無法復原！** 所有資料會永久刪除
- 如果您有重要資料，請先備份
- 使用者帳號不會受影響，您不需要重新登入
- 匯入歷史功能會繼續正常運作

## 🔄 如果需要再次重置

只要重新執行 `database/reset_all_data.sql` 即可。

## ❓ 常見問題

### Q: 執行後還看到舊資料？
A: 請按 `Ctrl + Shift + R` 強制重新載入頁面，清除瀏覽器快取。

### Q: 執行後出現錯誤？
A: 請確認：
1. 您已登入正確的 Supabase 專案
2. 您有執行 SQL 的權限
3. 表格都已建立（之前已執行 `import_batches_schema.sql`）

### Q: 可以只清空某個表格嗎？
A: 可以！在 SQL Editor 中單獨執行：
```sql
TRUNCATE TABLE suppliers CASCADE;
-- 或
TRUNCATE TABLE goods_receipts CASCADE;
```

### Q: 清空後匯入歷史功能還能用嗎？
A: 可以！所有功能都完好保留，只是資料被清空了。新上傳的資料會正常建立批次記錄。

## 📞 需要協助？

如果遇到問題：
1. 檢查 Supabase SQL Editor 的錯誤訊息
2. 查看瀏覽器控制台是否有錯誤
3. 確認網路連線正常

---

**檔案位置**: `database/reset_all_data.sql`  
**建立日期**: 2025-12-06  
**用途**: 清空所有業務資料，保留表格結構和功能

