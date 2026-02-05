# 批次 Upsert 快速啟動指南

## ⚡ 3 步驟開始使用

### 第 1 步：執行 DB Migration（5 分鐘）

```sql
-- 在 Supabase SQL Editor 執行此檔案：
database/patch_goods_receipt_batch_upsert.sql
```

**檢查輸出**：
- ✅ 看到「沒有發現重複資料」→ 完成！
- ⚠️ 看到「發現重複資料」→ 先清理（執行 migration 顯示的查詢）

---

### 第 2 步：重啟應用程式

```bash
npm run dev
```

---

### 第 3 步：測試上傳（3 個測試）

#### ✅ 測試 A：50 rows（驗證功能）
- 上傳 50 筆測試資料
- 預期：1-2 秒完成

#### ✅ 測試 B：500 rows（驗證分批）
- 上傳 500 筆測試資料
- 預期：3-5 秒完成

#### ✅ 測試 C：8845 rows（驗證穩定性）⭐
- 上傳您的 Mock data.xlsx
- 預期：10-20 秒完成
- **不會卡死！**

---

## 🎯 預期改善

### 效能提升

```
8845 rows：
  修改前：17,690 次 DB 請求，15 分鐘 ❌
  修改後：~20 次 DB 請求，15 秒 ✅
  
  改善：99.9% 請求減少，98% 時間節省
```

### UI 體驗

**修改前**：
- ❌ 卡在「Saving...」
- ❌ 無進度顯示
- ❌ 容易當機/超時

**修改後**：
- ✅ 流暢進度條
- ✅ 四階段顯示
- ✅ 不會卡死

---

## 📋 進度條顯示

上傳時會看到：

```
1️⃣ 📊 正在分析資料...
2️⃣ 🏢 正在處理 X 個供應商...
3️⃣ 📦 正在處理 Y 個物料...
4️⃣ ✍️ 正在寫入收貨記錄 (current/total)...
```

---

## 🐛 常見問題

### Q1: Migration 執行失敗？

**A**: 可能有重複資料。執行 migration 會顯示重複資料查詢，先清理後重試。

### Q2: 上傳時出現「無法找到供應商 ID」？

**A**: 
1. 檢查 Console 是否有 upsert 錯誤
2. 確認 DB migration 成功
3. 確認唯一約束已建立

### Q3: 仍然很慢？

**A**: 
1. 檢查 Network 標籤，計算 DB 請求數量
2. 如果請求數量仍然很多 → 可能 upsert 沒有生效
3. 檢查 Console log 確認是否使用了新的 batchUpsert 方法

---

## 📞 需要協助？

提供以下資訊：
1. Supabase migration 執行結果（截圖）
2. 瀏覽器 Console 的完整 log
3. Chrome DevTools → Network 的請求數量
4. 上傳的資料筆數和耗時

---

**完整文檔**：請參考 `BATCH_UPSERT_IMPLEMENTATION_GUIDE.md`
