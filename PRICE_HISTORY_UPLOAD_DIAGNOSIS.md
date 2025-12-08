# Price History 上傳問題診斷

## 問題：已上傳但 price_history 表為空

### 可能原因和解決方案

## 🔍 診斷步驟

### 1. 檢查上傳類型選擇

**問題**：您可能選擇了錯誤的上傳類型

**檢查方法**：
- 在 Data Upload (External Systems) 頁面
- "Select Type" 下拉選單中，您選擇的是什麼？
- **必須選擇**: `price_history` 或 `Price History`

**如果選錯了**：
- 數據可能保存到了其他表（如 user_files, goods_receipts, suppliers）
- 需要重新上傳並選擇正確的類型

---

### 2. 檢查是否有 price_history 上傳類型

**檢查方法**：
查看 Data Upload 頁面的 "Select Type" 下拉選單中是否有 `price_history` 選項

**可能的上傳類型**：
- `goods_receipt` - 收貨記錄
- `price_history` - 價格歷史 ✅ (需要這個)
- `supplier_master` - 供應商主檔

**如果沒有 price_history 選項**：
需要在 `EnhancedExternalSystemsView.jsx` 中添加配置

---

### 3. 檢查數據驗證是否通過

**問題**：數據可能因為驗證錯誤而沒有保存

**檢查方法**：
1. 重新上傳文件
2. 在 Validation Results 步驟查看：
   - ✅ Valid Rows: 應該 > 0
   - ❌ Error Rows: 檢查錯誤原因
3. 如果所有行都是 Error Rows，數據不會被保存

**常見驗證錯誤**：
- 缺少必需欄位
- 日期格式不正確
- 數字格式不正確
- 欄位映射錯誤

---

### 4. 檢查欄位映射

**必需欄位**（price_history）：
- `supplier_name` ✅ 必需
- `material_code` ✅ 必需  
- `order_date` ✅ 必需
- `unit_price` ✅ 必需

**可選欄位**：
- `supplier_code`
- `material_name`
- `currency`
- `quantity`
- `is_contract_price`

**檢查您的映射**：
```
Excel 欄位 → 系統欄位
------------------------
供應商名稱    → supplier_name ✅
料號         → material_code ✅
訂單日期     → order_date ✅
單價         → unit_price ✅
```

---

### 5. 檢查數據格式

**order_date 格式**：
- ✅ 正確: `2024-12-01`, `2024/12/01`
- ❌ 錯誤: `01-Dec-2024`, `12/1/24`

**unit_price 格式**：
- ✅ 正確: `125.50`, `100`
- ❌ 錯誤: `$125.50`, `125.50 USD`

**範例數據**：
```csv
supplier_name,material_code,order_date,unit_price,currency
ABC Supplier,MAT001,2024-12-01,125.50,USD
ABC Supplier,MAT002,2024-12-02,98.00,USD
XYZ Supplier,MAT001,2024-12-03,120.00,USD
```

---

### 6. 檢查瀏覽器控制台錯誤

**步驟**：
1. 打開開發者工具 (F12)
2. 切換到 Console 標籤
3. 重新上傳文件
4. 查看是否有紅色錯誤訊息

**常見錯誤**：
- "supplier_id is required" - 供應商創建失敗
- "material_id is required" - 材料創建失敗
- "Foreign key violation" - 關聯錯誤
- "permission denied" - RLS 策略問題

---

### 7. 檢查 Import History

**步驟**：
1. 導航到 **Import History** 頁面
2. 查看最近的上傳記錄
3. 檢查：
   - Status: 應該是 "completed" ✅
   - Success Rows: 應該 > 0
   - Error Rows: 查看錯誤數量

**如果 Status 是 "pending" 或 "error"**：
- 上傳失敗
- 查看錯誤原因

---

### 8. 檢查其他表是否有數據

**可能數據保存在錯誤的表中**：

```sql
-- 檢查 user_files 表（原始上傳文件）
SELECT COUNT(*), MAX(created_at) 
FROM user_files 
WHERE user_id = auth.uid();

-- 檢查 suppliers 表
SELECT COUNT(*) 
FROM suppliers 
WHERE user_id = auth.uid();

-- 檢查 materials 表
SELECT COUNT(*) 
FROM materials 
WHERE user_id = auth.uid();

-- 檢查 goods_receipts 表（可能選錯了類型）
SELECT COUNT(*) 
FROM goods_receipts 
WHERE user_id = auth.uid();

-- 檢查 import_batches 表
SELECT 
  id,
  upload_type,
  target_table,
  status,
  success_rows,
  error_rows,
  created_at
FROM import_batches 
WHERE user_id = auth.uid()
ORDER BY created_at DESC
LIMIT 5;
```

---

## ✅ 正確的上傳流程

### Step 1: 準備數據文件

**Excel 或 CSV 格式**：

| supplier_name | material_code | material_name | order_date | unit_price | currency |
|---------------|---------------|---------------|------------|------------|----------|
| ABC Supplier  | MAT001        | Steel Plate   | 2024-12-01 | 125.50     | USD      |
| ABC Supplier  | MAT002        | Copper Wire   | 2024-12-01 | 98.00      | USD      |
| XYZ Supplier  | MAT001        | Steel Plate   | 2024-12-02 | 120.00     | USD      |

### Step 2: 上傳到 Data Upload 頁面

1. 導航到 **Data Upload (External Systems)**
2. **Select Type**: 選擇 `price_history` 📋
3. **Choose File**: 選擇您的 Excel/CSV 文件
4. 點擊 **Upload**

### Step 3: 欄位映射

將 Excel 欄位映射到系統欄位：

```
supplier_name    → supplier_name (必需)
material_code    → material_code (必需)
order_date       → order_date (必需)
unit_price       → unit_price (必需)
material_name    → material_name (可選)
currency         → currency (可選)
```

### Step 4: 驗證數據

查看 Validation Results：
- ✅ Valid Rows: 應該等於您的數據行數
- ❌ Error Rows: 應該為 0 或很少

如果有錯誤，點擊查看詳細錯誤訊息並修正

### Step 5: 保存數據

點擊 **Save** 按鈕

**成功訊息**：
```
Successfully saved X rows
```

### Step 6: 驗證數據已保存

在 Supabase SQL Editor 執行：

```sql
-- 應該返回 > 0
SELECT COUNT(*) FROM price_history WHERE user_id = auth.uid();

-- 查看前 5 條記錄
SELECT 
  ph.*,
  m.material_code,
  s.supplier_name
FROM price_history ph
LEFT JOIN materials m ON ph.material_id = m.id
LEFT JOIN suppliers s ON ph.supplier_id = s.id
WHERE ph.user_id = auth.uid()
ORDER BY ph.order_date DESC
LIMIT 5;
```

---

## 🔧 快速修復方案

### 方案 1: 檢查上傳類型選項

如果 Data Upload 頁面沒有 `price_history` 選項，需要添加：

**檢查文件**: `src/views/EnhancedExternalSystemsView.jsx`

**查找**:
```javascript
const uploadTypes = [
  { value: 'goods_receipt', label: 'Goods Receipt', ... },
  { value: 'price_history', label: 'Price History', ... }, // 需要這個
  { value: 'supplier_master', label: 'Supplier Master', ... }
];
```

如果缺少，請告訴我，我會幫您添加。

---

### 方案 2: 使用測試數據驗證

**創建測試 CSV 文件** (`test_price_history.csv`):

```csv
supplier_name,material_code,material_name,order_date,unit_price,currency
Test Supplier A,TEST001,Test Material 1,2024-12-01,100.00,USD
Test Supplier A,TEST001,Test Material 1,2024-12-05,105.00,USD
Test Supplier B,TEST002,Test Material 2,2024-12-02,50.00,USD
Test Supplier B,TEST002,Test Material 2,2024-12-06,52.00,USD
```

上傳這個測試文件，看是否能成功保存。

---

### 方案 3: 直接插入測試數據

在 Supabase SQL Editor 執行：

```sql
-- 1. 插入測試 supplier
INSERT INTO suppliers (user_id, supplier_code, supplier_name, status)
VALUES (auth.uid(), 'TEST001', 'Test Supplier A', 'active')
ON CONFLICT (user_id, supplier_code) DO NOTHING
RETURNING id;

-- 記下返回的 supplier_id

-- 2. 插入測試 material
INSERT INTO materials (user_id, material_code, material_name, category, uom)
VALUES (auth.uid(), 'TEST001', 'Test Material 1', 'Test', 'pcs')
ON CONFLICT (user_id, material_code) DO NOTHING
RETURNING id;

-- 記下返回的 material_id

-- 3. 插入測試 price_history
-- 將 'supplier-uuid' 和 'material-uuid' 替換為上面返回的 ID
INSERT INTO price_history (
  user_id,
  supplier_id,
  material_id,
  order_date,
  unit_price,
  currency,
  quantity
)
VALUES 
  (auth.uid(), 'supplier-uuid', 'material-uuid', CURRENT_DATE - 5, 100.00, 'USD', 1000),
  (auth.uid(), 'supplier-uuid', 'material-uuid', CURRENT_DATE - 10, 105.00, 'USD', 1000),
  (auth.uid(), 'supplier-uuid', 'material-uuid', CURRENT_DATE - 15, 98.00, 'USD', 1000);

-- 4. 驗證
SELECT COUNT(*) FROM price_history WHERE user_id = auth.uid();
```

執行後應該返回 3。

然後返回 Cost Analysis 頁面，應該能看到數據了。

---

## 📋 請提供以下信息

為了更準確地診斷問題，請告訴我：

1. **您選擇的上傳類型是什麼？** 
   - goods_receipt
   - price_history
   - supplier_master
   - 其他？

2. **Validation Results 顯示了什麼？**
   - Valid Rows: ?
   - Error Rows: ?
   - 有錯誤訊息嗎？

3. **執行以下 SQL 的結果**：
   ```sql
   -- 檢查 import_batches
   SELECT upload_type, target_table, status, success_rows, error_rows
   FROM import_batches 
   WHERE user_id = auth.uid()
   ORDER BY created_at DESC
   LIMIT 3;
   
   -- 檢查 suppliers 和 materials
   SELECT 
     (SELECT COUNT(*) FROM suppliers WHERE user_id = auth.uid()) as suppliers_count,
     (SELECT COUNT(*) FROM materials WHERE user_id = auth.uid()) as materials_count;
   ```

4. **瀏覽器 Console 有錯誤訊息嗎？**

---

**最可能的原因**: 選擇了錯誤的上傳類型，或數據驗證失敗導致沒有 Valid Rows。

請告訴我上述檢查的結果，我會幫您解決！



