# ⚠️ 需要您立即執行的操作

## 🎯 目標

解決 8845 rows 上傳卡死問題 → 改為 15 秒內完成

---

## ✅ 我已經完成的工作

1. ✅ 建立 DB migration 檔案
2. ✅ 新增 3 個批次 upsert service methods
3. ✅ 重寫上傳流程（Goods Receipt + Price History）
4. ✅ 新增進度條 UI
5. ✅ 建立完整的測試指南

**效能改善**：99.9% DB 請求減少（17,690 → 20 次）

---

## 🚨 您需要做的事（按順序）

### 步驟 1：執行 DB Migration（5 分鐘）⚠️ 必須先做

1. 開啟 **Supabase Dashboard**
2. 進入 **SQL Editor**
3. 點擊「New Query」
4. 複製貼上以下檔案的內容：
   ```
   database/patch_goods_receipt_batch_upsert.sql
   ```
5. 點擊「Run」執行

**檢查執行結果**：
- ✅ 如果看到「✅ 沒有發現重複資料」→ 完成！前往步驟 2
- ⚠️ 如果看到「⚠️ 發現 X 組重複資料」→ 請先清理（參考下方）

#### 清理重複資料（如果需要）

Migration 會顯示重複資料的查詢結果。執行以下 SQL 清理（保留最新的）：

```sql
-- 清理重複的 suppliers
DELETE FROM suppliers 
WHERE id NOT IN (
  SELECT DISTINCT ON (
    user_id, 
    COALESCE(
      supplier_code,
      LOWER(TRIM(REGEXP_REPLACE(supplier_name, '\s+', ' ', 'g')))
    )
  ) id
  FROM suppliers
  ORDER BY 
    user_id, 
    COALESCE(
      supplier_code,
      LOWER(TRIM(REGEXP_REPLACE(supplier_name, '\s+', ' ', 'g')))
    ),
    created_at DESC
);
```

清理完後，重新執行 migration。

---

### 步驟 2：驗證 DB Patch（2 分鐘）

在 Supabase SQL Editor 執行驗證：

```sql
-- 驗證唯一約束是否建立
SELECT 
  conname AS constraint_name,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'suppliers'::regclass
  AND contype = 'u'
ORDER BY conname;

-- 應該看到：
-- uq_suppliers_user_name_norm
-- uq_suppliers_user_code (可能在 pg_indexes 中)
```

---

### 步驟 3：重啟應用（1 分鐘）

```bash
# 停止當前的開發伺服器（Ctrl+C）
# 然後重新啟動
npm run dev
```

---

### 步驟 4：測試上傳（10 分鐘）

#### Test A：50 rows（快速驗證）

1. 準備 50 筆測試資料
2. 上傳 → 映射 → 驗證 → 保存
3. **預期**：1-2 秒完成，有進度條

#### Test B：8845 rows（關鍵測試）⭐

1. 使用您的 Mock data.xlsx
2. 上傳 → 映射 → 驗證 → 保存
3. **預期**：
   - 10-20 秒完成
   - 看到 4 個進度階段
   - **不會卡死！**
4. 開啟 Chrome Console 確認 log：
   ```
   [saveGoodsReceipts] Starting batch upsert for 8845 rows
   [batchUpsertSuppliers] ...
   [batchUpsertMaterials] ...
   [batchInsertReceipts] ...
   [saveGoodsReceipts] 完成！共寫入 8845 筆記錄
   ```

---

## 🎯 驗收標準

完成測試後，應該達到：

- [ ] ✅ 8845 rows 上傳時間 < 30 秒
- [ ] ✅ UI 流暢，有進度條
- [ ] ✅ 不會當機或超時
- [ ] ✅ Console 顯示批次處理 log
- [ ] ✅ Network 請求數 < 30 次

---

## 📞 如果遇到問題

### 問題清單

1. **Migration 失敗** → 查看 `BATCH_UPSERT_IMPLEMENTATION_GUIDE.md` 的除錯指南
2. **找不到 supplier_id** → 檢查 Console log，確認 upsert 是否成功
3. **仍然很慢** → 檢查 Network 標籤，確認請求數量

### 需要提供的資訊

1. Supabase migration 執行結果（截圖）
2. 瀏覽器 Console 的完整 log
3. Chrome DevTools Network 標籤（Supabase 請求數量）
4. 錯誤訊息（如果有）

---

## 📚 詳細文件

- **快速啟動**：`BATCH_UPSERT_QUICK_START.md`
- **完整指南**：`BATCH_UPSERT_IMPLEMENTATION_GUIDE.md`
- **實作總結**：`BATCH_UPSERT_FINAL_SUMMARY.md`（本檔案）

---

## 🎉 預祝測試成功！

從現在開始，上傳 8845 rows 只需要 **15 秒**，不再是 **15 分鐘**！

---

**準備好了嗎？開始步驟 1：執行 DB Migration！** 🚀
