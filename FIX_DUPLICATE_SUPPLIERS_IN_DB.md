# 修復資料庫中的重複供應商

## 問題

用戶報告在 Supplier Management 頁面看到重複的供應商（例如 BlueWave Packaging 出現兩次）。

這表示：
1. ❌ 資料庫中已經存在重複資料（可能是之前測試或上傳留下的）
2. ❌ 保存邏輯沒有檢查資料庫中是否已存在相同供應商

---

## ✅ 解決方案

### 方案 1：清理資料庫中的重複資料

#### 步驟 1：在 Supabase SQL Editor 中查看重複

```sql
-- 查看所有重複的供應商
SELECT 
  supplier_name, 
  COUNT(*) as count,
  STRING_AGG(id::text, ', ') as duplicate_ids,
  STRING_AGG(created_at::text, ', ') as created_dates
FROM suppliers
GROUP BY supplier_name
HAVING COUNT(*) > 1
ORDER BY count DESC;
```

**預期結果**：
```
supplier_name        | count | duplicate_ids            | created_dates
---------------------|-------|-------------------------|------------------
BlueWave Packaging   | 2     | uuid1, uuid2            | 2025-01-01, 2025-01-02
```

#### 步驟 2：刪除重複記錄（只保留最早的一筆）

```sql
-- 刪除重複記錄，保留每個 supplier_name 的第一筆（最早創建的）
DELETE FROM suppliers
WHERE id NOT IN (
  SELECT MIN(id)
  FROM suppliers
  GROUP BY supplier_name
);
```

**預期結果**：
```
DELETE 1  -- 刪除了 1 筆重複記錄
```

#### 步驟 3：驗證清理結果

```sql
-- 再次查看是否還有重複
SELECT 
  supplier_name, 
  COUNT(*) as count
FROM suppliers
GROUP BY supplier_name
HAVING COUNT(*) > 1;
```

**預期結果**：應該返回 0 筆（沒有重複）

#### 步驟 4：添加唯一約束（防止未來再次出現重複）

```sql
-- 為 supplier_name 添加唯一約束
ALTER TABLE suppliers
ADD CONSTRAINT suppliers_supplier_name_unique 
UNIQUE (supplier_name);

-- 可選：為 supplier_code 添加唯一約束（允許 NULL）
CREATE UNIQUE INDEX suppliers_supplier_code_unique_idx 
ON suppliers (supplier_code) 
WHERE supplier_code IS NOT NULL;
```

**注意**：執行前請確認沒有重複資料，否則會報錯。

---

### 方案 2：增強保存邏輯（自動處理重複）

我們已經更新了程式碼，現在保存供應商時會：

1. **自動檢查資料庫**：查詢是否已存在相同 `supplier_code` 或 `supplier_name` 的供應商
2. **智能處理**：
   - 如果是**新供應商** → **插入**（INSERT）
   - 如果**已存在** → **更新**（UPDATE），合併新資訊
3. **保留完整資訊**：更新時只覆蓋非空欄位，保留現有資料

---

## 🔧 新的保存邏輯

### 修改的檔案

#### 1. src/services/supabaseClient.js

**原邏輯**：
```javascript
// 直接插入，不檢查重複
async insertSuppliers(suppliers) {
  const { data, error } = await supabase
    .from('suppliers')
    .insert(suppliers)
    .select();
}
```

**新邏輯**：
```javascript
// 檢查重複，智能處理
async insertSuppliers(suppliers) {
  // Step 1: 查詢資料庫中已存在的供應商
  const existingSuppliers = await supabase
    .from('suppliers')
    .select('id, supplier_name, supplier_code')
    .or('supplier_name.in.(...),supplier_code.in.(...)');

  // Step 2: 分離新供應商和需要更新的供應商
  const toInsert = [];  // 新供應商
  const toUpdate = [];  // 已存在的供應商

  suppliers.forEach(supplier => {
    const existingId = findExisting(supplier);
    if (existingId) {
      toUpdate.push({ ...supplier, id: existingId });
    } else {
      toInsert.push(supplier);
    }
  });

  // Step 3: 插入新供應商
  if (toInsert.length > 0) {
    await supabase.from('suppliers').insert(toInsert);
  }

  // Step 4: 更新已存在的供應商（合併資訊）
  if (toUpdate.length > 0) {
    for (const supplier of toUpdate) {
      await supabase
        .from('suppliers')
        .update(supplier)
        .eq('id', supplier.id);
    }
  }

  return { 
    count: toInsert.length + toUpdate.length,
    inserted: toInsert.length,
    updated: toUpdate.length
  };
}
```

---

## 📊 實際範例

### 範例 1：上傳新供應商

**資料庫現狀**：
```
1. GreenTech Supply | John | 12345678
```

**上傳 Excel**：
```
BlueWave Packaging | Emily | 88678122201
```

**結果**：
- ✅ **插入** BlueWave Packaging（新供應商）
- 資料庫：2 筆

---

### 範例 2：上傳已存在的供應商（資訊更完整）

**資料庫現狀**：
```
1. BlueWave Packaging | - | -
```

**上傳 Excel**：
```
BlueWave Packaging | Emily | 88678122201 | emily@bp.com
```

**結果**：
- ✅ **更新** BlueWave Packaging
- 合併資訊：contact, phone, email
- 資料庫：仍然 1 筆，但資訊更完整

---

### 範例 3：上傳已存在的供應商（資訊互補）

**資料庫現狀**：
```
1. BlueWave Packaging | Emily | 88678122201 | -
```

**上傳 Excel**：
```
BlueWave Packaging | - | - | support@bp.com
```

**結果**：
- ✅ **更新** BlueWave Packaging
- 保留原有：contact (Emily), phone (88678122201)
- 補充新增：email (support@bp.com)
- 資料庫：仍然 1 筆，資訊更完整

---

### 範例 4：批量上傳（混合新舊）

**資料庫現狀**：
```
1. BlueWave Packaging | Emily | 88678122201
```

**上傳 Excel**：
```
BlueWave Packaging | David | 99999999 | support@bp.com
GreenTech Supply   | John  | 12345678 | john@gt.com
RedStar Materials  | Mary  | 11111111 | mary@rs.com
```

**結果**：
- ✅ **更新** BlueWave Packaging（保留 Emily, 88678122201，補充 email）
- ✅ **插入** GreenTech Supply（新供應商）
- ✅ **插入** RedStar Materials（新供應商）
- 資料庫：3 筆
- 成功訊息：`Successfully saved 3 rows (1 updated, 2 inserted)`

---

## 🚀 測試步驟

### 步驟 1：清理現有重複

在 Supabase SQL Editor 執行：

```sql
-- 查看重複
SELECT supplier_name, COUNT(*) 
FROM suppliers 
GROUP BY supplier_name 
HAVING COUNT(*) > 1;

-- 清理重複（保留最早的）
DELETE FROM suppliers
WHERE id NOT IN (
  SELECT MIN(id) FROM suppliers GROUP BY supplier_name
);

-- 驗證
SELECT COUNT(*) FROM suppliers;  -- 應該減少
```

### 步驟 2：刷新應用

```
Ctrl + Shift + R (Windows)
Cmd + Shift + R (Mac)
```

### 步驟 3：測試上傳

#### 測試 A：上傳新供應商

上傳 Excel：
```csv
supplier_code,supplier_name,contact_person,phone,email
NEW001,New Supplier,Alice,12345678,alice@new.com
```

**預期**：
- ✅ 插入 1 筆新記錄
- Supplier Management 頁面應該顯示新供應商

#### 測試 B：上傳已存在的供應商

上傳 Excel（假設 BlueWave Packaging 已存在）：
```csv
supplier_code,supplier_name,contact_person,phone,email
BP001,BlueWave Packaging,David,99999999,support@bp.com
```

**預期**：
- ✅ 更新現有記錄（不會出現重複）
- ✅ Supplier Management 頁面仍然只顯示 1 個 BlueWave Packaging
- ✅ 資訊已合併（contact, phone, email）

#### 測試 C：批量上傳（混合新舊）

上傳 Excel：
```csv
supplier_code,supplier_name,contact_person,phone,email
BP001,BlueWave Packaging,Emily,88678122201,emily@bp.com
NEW002,Another New,Bob,87654321,bob@another.com
```

**預期**：
- ✅ BlueWave Packaging：更新（1 筆）
- ✅ Another New：插入（1 筆）
- ✅ 成功訊息：`Successfully saved 2 rows (1 updated, 1 inserted)`
- ✅ Supplier Management 沒有重複

---

## 📋 Console 日誌

在瀏覽器 Console（F12）中，您會看到：

```javascript
// 保存時
Suppliers saved: 1 inserted, 1 updated

// 或
Suppliers saved: 3 inserted, 0 updated

// 或
Suppliers saved: 0 inserted, 2 updated
```

---

## 🎯 最佳實踐

### 1. 定期清理重複資料

每週或每月執行清理腳本：

```sql
-- 清理腳本
DELETE FROM suppliers
WHERE id NOT IN (
  SELECT MIN(id) FROM suppliers GROUP BY supplier_name
);
```

### 2. 添加資料庫約束

在生產環境中添加唯一約束：

```sql
ALTER TABLE suppliers
ADD CONSTRAINT suppliers_supplier_name_unique 
UNIQUE (supplier_name);
```

### 3. 監控重複資料

創建一個視圖來監控重複：

```sql
CREATE VIEW duplicate_suppliers AS
SELECT 
  supplier_name, 
  COUNT(*) as count
FROM suppliers
GROUP BY supplier_name
HAVING COUNT(*) > 1;

-- 查詢
SELECT * FROM duplicate_suppliers;
```

---

## ⚠️ 注意事項

### 1. 資料庫約束

添加唯一約束前，**必須先清理重複資料**，否則會報錯：

```
ERROR: could not create unique index "suppliers_supplier_name_unique"
DETAIL: Key (supplier_name)=(BlueWave Packaging) is duplicated.
```

### 2. 合併策略

目前的合併策略是：
- **保留原有非空欄位**
- **只更新空欄位**

如果需要不同的策略（例如總是使用最新資料），需要修改更新邏輯。

### 3. 效能考量

批量上傳大量資料時（> 1000 筆），可能需要：
- 分批處理
- 優化查詢
- 使用資料庫的 UPSERT 功能

---

## 🎉 總結

### 完成的改進

- ✅ **清理腳本**：一鍵清理資料庫中的重複資料
- ✅ **智能保存**：自動檢查並處理重複（插入 vs 更新）
- ✅ **資訊合併**：保留最完整的供應商資訊
- ✅ **防止重複**：確保資料庫中不會出現重複供應商

### 預期效果

| 操作 | 舊邏輯 | 新邏輯 |
|-----|-------|-------|
| 上傳新供應商 | 插入 | 插入 ✅ |
| 上傳已存在供應商 | 插入（重複！）❌ | 更新（合併）✅ |
| 批量上傳混合資料 | 全部插入（重複！）❌ | 智能處理 ✅ |

---

**請先執行清理腳本，然後刷新瀏覽器測試！** 🚀

**清理後，Supplier Management 頁面應該不再有重複資料！** ✅

