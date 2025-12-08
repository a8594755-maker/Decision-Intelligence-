# Data Upload 完整上傳指南

## 問題：以為已上傳但實際沒有

如果 `import_batches` 表返回 "No rows returned"，表示**上傳流程從未完成**。

## ✅ 正確的完整上傳流程（5 個步驟）

### 📋 Step 1: 選擇上傳類型

1. 導航到 **Data Upload (External Systems)** 頁面
2. 在 **"Select Type"** 下拉選單中選擇 **`price_history`**
3. 應該看到類型描述和必需欄位說明

**如果沒有 price_history 選項**：
- 可能需要向下滾動查看更多選項
- 或者這個上傳類型尚未配置

---

### 📂 Step 2: 選擇文件

1. 點擊 **"Choose File"** 或 **"Upload"** 按鈕
2. 選擇您的 Excel 或 CSV 文件
3. 等待文件上傳（會顯示進度）

**必須等到**：
- ✅ 文件名稱顯示在按鈕旁邊
- ✅ 看到欄位列表出現

---

### 🔗 Step 3: 欄位映射（重要！）

這一步很關鍵，必須將 Excel 欄位映射到系統欄位：

**必需映射**：
```
您的 Excel 欄位    →    系統欄位
------------------------------------
供應商名稱          →    supplier_name
料號/物料編號       →    material_code
訂單日期            →    order_date
單價/價格           →    unit_price
```

**可選映射**：
```
物料名稱            →    material_name
供應商編號          →    supplier_code
幣別                →    currency
數量                →    quantity
```

**檢查點**：
- ✅ 所有必需欄位都已映射（有綠色勾選）
- ✅ 沒有紅色錯誤提示

---

### ✔️ Step 4: 驗證數據

映射完成後，系統會自動驗證數據。

**查看驗證結果**：
- **Valid Rows**: 應該 > 0（綠色）✅
- **Error Rows**: 最好 = 0（或很少）

**如果 Valid Rows = 0**：
- 檢查欄位映射是否正確
- 檢查數據格式（日期、數字）
- 查看錯誤詳情並修正

---

### 💾 Step 5: 保存數據（最重要！）

**這是最關鍵的一步**：

1. 確認驗證通過（Valid Rows > 0）
2. 點擊 **"Save"** 或 **"儲存"** 按鈕
3. 等待保存完成（可能需要幾秒到幾分鐘）

**成功標誌**：
- ✅ 看到綠色成功訊息："Successfully saved X rows"
- ✅ 頁面自動重置或返回初始狀態
- ✅ 可以在 Import History 看到上傳記錄

**如果沒有看到成功訊息**：
- 打開瀏覽器控制台 (F12) 查看錯誤
- 數據可能沒有保存

---

## 🎯 驗證上傳成功

### 方法 1: 檢查 Import History

1. 導航到 **Import History** 頁面
2. 應該看到您的上傳記錄
3. 檢查：
   - Status: **completed** ✅
   - Success Rows: **> 0**

### 方法 2: SQL 查詢

```sql
-- 檢查 import_batches（應該有記錄）
SELECT COUNT(*) FROM import_batches WHERE user_id = auth.uid();

-- 檢查 price_history（應該有數據）
SELECT COUNT(*) FROM price_history WHERE user_id = auth.uid();
```

兩個都應該 > 0。

---

## 📊 測試數據範例

如果您想快速測試，創建這個 CSV 文件：

**test_prices.csv**:
```csv
supplier_name,material_code,material_name,order_date,unit_price,currency
ABC Supplier,MAT001,Steel Plate 304,2024-12-01,125.50,USD
ABC Supplier,MAT001,Steel Plate 304,2024-12-05,128.00,USD
ABC Supplier,MAT002,Copper Wire,2024-12-02,95.00,USD
XYZ Supplier,MAT001,Steel Plate 304,2024-12-03,120.00,USD
XYZ Supplier,MAT002,Copper Wire,2024-12-04,92.00,USD
```

**重要注意事項**：
- 日期格式必須是 **YYYY-MM-DD** (例如：2024-12-01)
- 價格不要包含貨幣符號（例如：125.50，不是 $125.50）
- 確保所有行都有完整的數據

---

## 🔍 常見錯誤

### 錯誤 1: 只選了文件但沒有點 Save

**症狀**：
- 選擇了文件
- 看到了欄位列表
- 但沒有繼續操作就離開了頁面

**解決**：必須完成所有 5 個步驟，特別是最後的 **Save** 按鈕

---

### 錯誤 2: 欄位映射不正確

**症狀**：
- Valid Rows = 0
- 所有行都是 Error Rows

**解決**：
- 重新檢查欄位映射
- 確保 supplier_name, material_code, order_date, unit_price 都已正確映射

---

### 錯誤 3: 日期格式不正確

**症狀**：
- 大部分行是 Error Rows
- 錯誤訊息提到日期

**解決**：
- 確保日期格式是 YYYY-MM-DD
- 在 Excel 中將日期列格式化為 "2024-12-01" 格式

---

### 錯誤 4: 沒有等待保存完成

**症狀**：
- 點了 Save 但立即離開頁面
- 沒有看到成功訊息

**解決**：
- 點擊 Save 後**必須等待**成功訊息出現
- 不要在保存過程中刷新或離開頁面

---

## 🚀 現在就開始正確上傳

### 立即行動清單：

1. ⬜ 前往 Data Upload (External Systems) 頁面
2. ⬜ Select Type: 選擇 `price_history`
3. ⬜ 選擇您的文件（或使用上面的測試數據）
4. ⬜ 完成欄位映射（4 個必需欄位）
5. ⬜ 檢查 Valid Rows > 0
6. ⬜ 點擊 **Save** 按鈕
7. ⬜ 等待看到 "Successfully saved X rows" 訊息
8. ⬜ 驗證：執行 `SELECT COUNT(*) FROM price_history WHERE user_id = auth.uid();`
9. ⬜ 返回 Cost Analysis 查看數據

---

## 💡 快速測試方案

如果您想立即看到 Cost Analysis 有數據，可以手動插入測試數據：

```sql
-- 1. 插入測試供應商
INSERT INTO suppliers (user_id, supplier_code, supplier_name, status)
VALUES 
  (auth.uid(), 'SUP001', 'Test Supplier A', 'active'),
  (auth.uid(), 'SUP002', 'Test Supplier B', 'active')
ON CONFLICT (user_id, supplier_code) DO NOTHING;

-- 2. 插入測試材料
INSERT INTO materials (user_id, material_code, material_name, category, uom)
VALUES 
  (auth.uid(), 'MAT001', 'Test Material 1', 'Raw Material', 'kg'),
  (auth.uid(), 'MAT002', 'Test Material 2', 'Raw Material', 'pcs')
ON CONFLICT (user_id, material_code) DO NOTHING;

-- 3. 獲取 supplier 和 material 的 ID
WITH supplier_ids AS (
  SELECT id, supplier_code FROM suppliers WHERE user_id = auth.uid() AND supplier_code IN ('SUP001', 'SUP002')
),
material_ids AS (
  SELECT id, material_code FROM materials WHERE user_id = auth.uid() AND material_code IN ('MAT001', 'MAT002')
)
-- 4. 插入測試 price_history
INSERT INTO price_history (user_id, supplier_id, material_id, order_date, unit_price, currency, quantity)
SELECT 
  auth.uid(),
  s.id,
  m.id,
  date_series,
  (100 + (RANDOM() * 20))::DECIMAL(10,2),
  'USD',
  1000
FROM supplier_ids s
CROSS JOIN material_ids m
CROSS JOIN generate_series(
  CURRENT_DATE - INTERVAL '25 days',
  CURRENT_DATE,
  INTERVAL '5 days'
) AS date_series;

-- 5. 驗證
SELECT 
  COUNT(*) as total_records,
  MIN(order_date) as earliest_date,
  MAX(order_date) as latest_date
FROM price_history 
WHERE user_id = auth.uid();
```

執行後應該會插入約 20-30 條測試記錄，然後返回 Cost Analysis 就能看到數據了！

---

**關鍵提醒**：上傳數據不是選擇文件就完成了，**必須點擊 Save 按鈕並等待成功訊息**！




