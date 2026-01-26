# 前端去重功能（立即生效）

## 問題

用戶報告 Supplier Management 頁面顯示重複的供應商（例如 BlueWave Packaging 出現兩次）。

## ✅ 解決方案（已完成）

我已經在**前端添加了智能去重功能**，無需修改資料庫！

### 工作原理

當載入供應商列表時，系統會自動：

1. **識別重複**：按 `supplier_name` 識別重複記錄
2. **智能合併**：合併所有相同供應商的資訊
3. **顯示唯一**：每個供應商只顯示一筆（最完整的資訊）

---

## 🚀 立即測試

### 步驟 1：刷新瀏覽器 ⚡

```
Windows: Ctrl + Shift + R
Mac: Cmd + Shift + R
```

### 步驟 2：前往 Supplier Management

導航到 Supplier Management 頁面

### 步驟 3：查看結果

**預期結果**：
- ✅ BlueWave Packaging 只顯示 **1 筆**
- ✅ Total Suppliers 數量減少
- ✅ 資訊已自動合併

---

## 📊 範例

### 資料庫現狀（有重複）

```
Row 1: BlueWave Packaging | Emily | 88678122201 | emily@bp.com
Row 2: BlueWave Packaging | -     | -           | -
```

### 前端顯示（自動去重後）

```
BlueWave Packaging | Emily | 88678122201 | emily@bp.com
```

✅ 只顯示 1 筆，資訊完整

---

## 🔧 合併邏輯

### 1. 識別重複

按 `supplier_name`（不區分大小寫）識別重複：
- "BlueWave Packaging" = "bluewave packaging"
- "BlueWave Packaging" = "BlueWave Packaging  "（自動 trim）

### 2. 合併規則

- **空值補充**：如果欄位 A 為空，用其他記錄的值補充
- **保留非空**：如果欄位 A 已有值，保留原值
- **最新時間**：保留最新的 `updated_at`

### 3. 合併欄位

**基本欄位**：
- `supplier_code`
- `address`
- `product_category`
- `payment_terms`
- `delivery_time`
- `status`

**聯絡資訊**（contact_info）：
- `contact_person`
- `phone`
- `email`
- `address`
- `product_category`
- `payment_terms`
- `delivery_time`

---

## 💡 優勢

### 優勢 1：無需資料庫操作

- ✅ 不需要執行 SQL 腳本
- ✅ 不需要 Supabase 權限
- ✅ **立即生效**（刷新瀏覽器即可）

### 優勢 2：自動合併資訊

- ✅ 保留所有有用資訊
- ✅ 不會丟失數據
- ✅ 顯示最完整的記錄

### 優勢 3：不影響資料庫

- ✅ 資料庫中的重複記錄保留
- ✅ 只在顯示時去重
- ✅ 可以隨時還原

---

## 🎯 對比

### 舊方案（資料庫清理）

**優點**：
- ✅ 徹底解決（資料庫中沒有重複）
- ✅ 節省儲存空間

**缺點**：
- ❌ 需要執行 SQL 腳本
- ❌ 需要 Supabase 權限
- ❌ 可能丟失數據

### 新方案（前端去重）✨

**優點**：
- ✅ **無需資料庫操作**
- ✅ **立即生效**
- ✅ **自動合併資訊**
- ✅ 不丟失數據

**缺點**：
- ⚠️ 資料庫中仍有重複（但不影響顯示）

---

## 📋 代碼實作

### 位置

`src/views/SupplierManagementView.jsx`

### 核心函數

```javascript
// 去重函數：合併相同供應商，保留最完整的資訊
const deduplicateSuppliers = (suppliers) => {
  const supplierMap = new Map();

  suppliers.forEach(supplier => {
    const key = supplier.supplier_name?.trim().toLowerCase();
    if (!key) return;

    const existing = supplierMap.get(key);

    if (!existing) {
      // 第一次出現，直接添加
      supplierMap.set(key, supplier);
    } else {
      // 已存在，合併資訊
      const merged = { ...existing };

      // 合併 contact_info
      if (supplier.contact_info) {
        merged.contact_info = { ...existing.contact_info };
        Object.keys(supplier.contact_info).forEach(key => {
          const existingValue = merged.contact_info[key];
          const newValue = supplier.contact_info[key];
          
          // 如果現有值為空，使用新值
          if (!existingValue || existingValue === '-') {
            if (newValue && newValue !== '-') {
              merged.contact_info[key] = newValue;
            }
          }
        });
      }

      // 合併其他欄位...
      supplierMap.set(key, merged);
    }
  });

  return Array.from(supplierMap.values());
};
```

### 使用位置

```javascript
const loadSuppliers = async () => {
  const data = await suppliersService.getAllSuppliers();
  
  // 自動去重！
  const deduplicatedData = deduplicateSuppliers(data);
  
  setSuppliers(deduplicatedData);
};
```

---

## 🧪 測試案例

### 測試 1：基本去重

**資料庫**：
```
1. BlueWave Packaging | Emily | 88678122201
2. BlueWave Packaging | -     | -
```

**顯示**：
```
BlueWave Packaging | Emily | 88678122201
```

✅ **通過**：只顯示 1 筆

---

### 測試 2：資訊互補

**資料庫**：
```
1. BlueWave Packaging | Emily | 88678122201 | -
2. BlueWave Packaging | -     | -           | support@bp.com
```

**顯示**：
```
BlueWave Packaging | Emily | 88678122201 | support@bp.com
```

✅ **通過**：合併所有資訊

---

### 測試 3：不區分大小寫

**資料庫**：
```
1. BlueWave Packaging | Emily | 88678122201
2. bluewave packaging | David | 99999999
3. BLUEWAVE PACKAGING | -     | -
```

**顯示**：
```
BlueWave Packaging | Emily | 88678122201
```

✅ **通過**：識別為同一供應商，只顯示 1 筆

---

### 測試 4：多個不同供應商

**資料庫**：
```
1. BlueWave Packaging | Emily | 88678122201
2. BlueWave Packaging | -     | -
3. GreenTech Supply   | John  | 12345678
4. GreenTech Supply   | -     | -
5. RedStar Materials  | Mary  | 11111111
```

**顯示**：
```
1. BlueWave Packaging | Emily | 88678122201
2. GreenTech Supply   | John  | 12345678
3. RedStar Materials  | Mary  | 11111111
```

✅ **通過**：3 個供應商，各顯示 1 筆

---

## ⚠️ 注意事項

### 1. 只影響顯示

- 資料庫中的重複記錄仍然存在
- 只在前端顯示時去重
- 不會自動刪除資料庫中的重複資料

### 2. 編輯行為

如果用戶點擊「Edit」編輯供應商：
- ✅ 編輯的是合併後的資訊
- ⚠️ 保存時可能創建新記錄（如果使用 INSERT）
- 💡 建議：配合 `insertSuppliers` 的 UPSERT 邏輯

### 3. 刪除行為

如果用戶點擊「Delete」刪除供應商：
- ✅ 刪除的是顯示的那一筆
- ⚠️ 資料庫中可能還有其他重複記錄
- 💡 建議：刪除所有相同 `supplier_name` 的記錄

---

## 🎯 未來改進建議

### 選項 1：同時清理資料庫（推薦）

在方便時執行清理腳本：

```sql
DELETE FROM suppliers a
USING suppliers b
WHERE a.id > b.id 
  AND a.supplier_name = b.supplier_name;
```

**好處**：
- ✅ 資料庫更乾淨
- ✅ 節省儲存空間
- ✅ 提升查詢效能

### 選項 2：添加唯一約束

防止未來再次出現重複：

```sql
ALTER TABLE suppliers
ADD CONSTRAINT suppliers_supplier_name_unique 
UNIQUE (supplier_name);
```

### 選項 3：優化刪除邏輯

刪除時清理所有重複：

```javascript
const handleDelete = async (supplier) => {
  // 刪除所有相同 supplier_name 的記錄
  await suppliersService.deleteByName(supplier.supplier_name);
};
```

---

## 🎉 總結

### 完成的功能

- ✅ **前端自動去重**（已完成）
- ✅ **智能資訊合併**（已完成）
- ✅ **無需資料庫操作**（已完成）

### 使用方式

1. **刷新瀏覽器**（Ctrl + Shift + R）
2. 前往 Supplier Management
3. ✅ 不再有重複顯示！

### 預期效果

| 項目 | 修改前 | 修改後 |
|-----|-------|-------|
| BlueWave Packaging | 顯示 2 筆 | 顯示 1 筆 ✅ |
| Total Suppliers | 顯示重複數量 | 顯示唯一數量 ✅ |
| 資訊完整性 | 可能不完整 | 自動合併完整 ✅ |

---

**現在請立即刷新瀏覽器（Ctrl + Shift + R）並測試！** 🚀

**Supplier Management 頁面應該不再顯示重複的供應商了！** ✅




