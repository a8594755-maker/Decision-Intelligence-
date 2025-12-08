# Cost Analysis 沒有數據 - 診斷指南

## 問題：Cost Analysis 顯示空狀態

### 可能的原因和檢查步驟

## 📊 Material Cost 沒有數據

### 原因 1: 數據庫表不存在或結構不正確

**檢查方法**：在 Supabase SQL Editor 執行：

```sql
-- 檢查必要的表是否存在
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN ('price_history', 'materials', 'suppliers');
```

**預期結果**：應該返回 3 個表名

**如果表不存在**：
1. 前往 Supabase Dashboard > SQL Editor
2. 執行 `database/supplier_kpi_schema.sql` 文件
3. 確認所有表都創建成功

---

### 原因 2: price_history 表沒有數據

**檢查方法**：

```sql
-- 檢查是否有任何 price_history 記錄
SELECT COUNT(*) as total_records
FROM price_history;

-- 檢查當前用戶是否有記錄（替換 'your-user-id'）
SELECT COUNT(*) as user_records
FROM price_history
WHERE user_id = 'your-user-id';
```

**如果沒有記錄**：
- 您需要先在 **Data Upload (External Systems)** 頁面上傳價格歷史數據
- 上傳類型選擇 **"Price History"** 或類似選項
- 確保包含必需欄位：MaterialCode, SupplierName, OrderDate, UnitPrice

---

### 原因 3: 數據時間範圍不在選定期間內

**檢查方法**：

```sql
-- 檢查 price_history 的日期範圍
SELECT 
  MIN(order_date) as earliest_date,
  MAX(order_date) as latest_date,
  COUNT(*) as total_records
FROM price_history
WHERE user_id = 'your-user-id';

-- 檢查最近 30 天是否有記錄
SELECT COUNT(*) as records_last_30_days
FROM price_history
WHERE user_id = 'your-user-id'
  AND order_date >= CURRENT_DATE - INTERVAL '30 days';
```

**如果數據太舊**：
- Material Cost 只顯示選定期間內的數據（30/60/90天）
- 嘗試切換到更長的期間（90天）
- 或上傳更新的價格數據

---

### 原因 4: materials 或 suppliers 表關聯缺失

**檢查方法**：

```sql
-- 檢查 price_history 與 materials 的關聯
SELECT 
  ph.id,
  ph.material_id,
  m.material_code,
  m.material_name
FROM price_history ph
LEFT JOIN materials m ON ph.material_id = m.id
WHERE ph.user_id = 'your-user-id'
LIMIT 5;

-- 檢查有多少記錄缺少 material 關聯
SELECT 
  COUNT(*) as records_with_material,
  (SELECT COUNT(*) FROM price_history WHERE user_id = 'your-user-id') as total_records
FROM price_history ph
INNER JOIN materials m ON ph.material_id = m.id
WHERE ph.user_id = 'your-user-id';
```

**如果關聯缺失**：
- 確保上傳數據時正確創建了 materials 記錄
- 檢查 `material_id` 外鍵是否正確設置
- 可能需要重新上傳數據

---

### 原因 5: RLS (Row Level Security) 策略阻止訪問

**檢查方法**：

```sql
-- 檢查當前用戶 ID
SELECT auth.uid() as current_user_id;

-- 檢查是否有匹配的記錄
SELECT COUNT(*)
FROM price_history
WHERE user_id = auth.uid();
```

**如果 RLS 阻止**：
- 確認您已登入
- 確認 price_history 表的 `user_id` 與當前用戶 ID 匹配
- 檢查 RLS 策略是否正確配置

---

## 💼 Operational Cost 沒有數據

### 原因 1: operational_costs 表不存在

**檢查方法**：

```sql
-- 檢查表是否存在
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN ('operational_costs', 'cost_anomalies');
```

**如果表不存在**：
1. 前往 Supabase Dashboard > SQL Editor
2. 執行 `database/cost_analysis_schema.sql` 文件
3. 或執行快速創建腳本（見下方）

**快速創建腳本**：
```sql
-- 見之前提供的完整 SQL 腳本
-- 或執行項目中的 database/cost_analysis_schema.sql
```

---

### 原因 2: operational_costs 表沒有數據

**檢查方法**：

```sql
-- 檢查是否有記錄
SELECT COUNT(*) as total_records
FROM operational_costs;

-- 檢查當前用戶的記錄
SELECT COUNT(*) as user_records
FROM operational_costs
WHERE user_id = 'your-user-id';
```

**如果沒有記錄**：
- Operational Cost 需要從 Data Upload 頁面上傳
- 目前可能尚未配置 Operational Cost 上傳類型
- 需要添加到 External Systems View 的上傳選項中

---

## 🔍 完整診斷流程

### 步驟 1: 檢查瀏覽器控制台

1. 打開瀏覽器開發者工具 (F12)
2. 切換到 Console 標籤
3. 查看是否有紅色錯誤訊息
4. 常見錯誤：
   - "Could not find the table 'public.price_history'"
   - "Could not find the table 'public.operational_costs'"
   - "No rows returned"

### 步驟 2: 檢查 Network 標籤

1. 打開 Network 標籤
2. 刷新 Cost Analysis 頁面
3. 查找對 Supabase 的 API 請求
4. 檢查請求是否成功（200 狀態碼）
5. 查看響應內容是否為空數組 `[]`

### 步驟 3: 驗證用戶 ID

在瀏覽器 Console 執行：

```javascript
// 獲取當前用戶 ID
supabase.auth.getUser().then(({ data }) => {
  console.log('Current User ID:', data.user?.id);
});
```

### 步驟 4: 手動測試查詢

在 Supabase SQL Editor 執行：

```sql
-- 替換 'your-user-id' 為上一步獲得的用戶 ID
SELECT 
  ph.*,
  m.material_code,
  m.material_name,
  s.supplier_name
FROM price_history ph
LEFT JOIN materials m ON ph.material_id = m.id
LEFT JOIN suppliers s ON ph.supplier_id = s.id
WHERE ph.user_id = 'your-user-id'
  AND ph.order_date >= CURRENT_DATE - INTERVAL '30 days'
ORDER BY ph.order_date DESC
LIMIT 10;
```

---

## ✅ 解決方案摘要

### 如果是新系統（從未上傳過數據）

1. **創建必要的表**
   ```bash
   # 在 Supabase SQL Editor 執行
   database/supplier_kpi_schema.sql
   database/cost_analysis_schema.sql
   ```

2. **上傳測試數據**
   - 前往 Data Upload (External Systems)
   - 選擇 "Price History" 上傳類型
   - 上傳包含以下欄位的 Excel/CSV：
     - MaterialCode
     - MaterialName
     - SupplierName
     - OrderDate (格式: YYYY-MM-DD)
     - UnitPrice
     - Currency

3. **驗證數據**
   ```sql
   SELECT COUNT(*) FROM price_history WHERE user_id = auth.uid();
   ```

4. **返回 Cost Analysis**
   - 刷新頁面
   - 選擇 Material Cost 標籤
   - 應該看到 KPI 卡片和數據

---

### 如果已有數據但不顯示

1. **檢查日期範圍**
   - 確認數據的 `order_date` 在最近 30/60/90 天內
   - 嘗試切換到更長的期間

2. **檢查關聯**
   - 確認 `material_id` 和 `supplier_id` 正確關聯
   - 檢查 materials 和 suppliers 表是否有對應記錄

3. **清除緩存**
   - Ctrl+Shift+R 強制刷新
   - 清除瀏覽器緩存

4. **重新登入**
   - 登出再登入
   - 確保 session 正確

---

## 📋 測試數據範例

如果需要快速測試，可以在 Supabase SQL Editor 執行：

```sql
-- 先獲取當前用戶 ID
SELECT auth.uid();

-- 插入測試 supplier
INSERT INTO suppliers (user_id, supplier_code, supplier_name, status)
VALUES (auth.uid(), 'TEST001', 'Test Supplier', 'active')
RETURNING id;

-- 使用返回的 supplier_id 插入測試 material
INSERT INTO materials (user_id, material_code, material_name, category, uom)
VALUES (auth.uid(), 'MAT001', 'Test Material', 'Raw Material', 'kg')
RETURNING id;

-- 使用上述兩個 ID 插入測試 price_history
-- 注意：替換 'supplier-uuid' 和 'material-uuid' 為實際的 UUID
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
  (auth.uid(), 'supplier-uuid', 'material-uuid', CURRENT_DATE - 10, 95.00, 'USD', 1000),
  (auth.uid(), 'supplier-uuid', 'material-uuid', CURRENT_DATE - 15, 105.00, 'USD', 1000),
  (auth.uid(), 'supplier-uuid', 'material-uuid', CURRENT_DATE - 20, 98.00, 'USD', 1000);
```

---

## 🆘 還是沒有數據？

請提供以下信息：

1. **瀏覽器 Console 錯誤截圖**
2. **Supabase 查詢結果**：
   ```sql
   SELECT COUNT(*) FROM price_history WHERE user_id = auth.uid();
   ```
3. **當前用戶 ID**：
   ```sql
   SELECT auth.uid();
   ```
4. **Cost Analysis 頁面截圖**
5. **Network 標籤截圖** (顯示 Supabase API 請求)

---

**最常見的原因**: 用戶還沒有上傳任何 price_history 數據。

**最快的解決方案**: 前往 Data Upload 頁面上傳價格歷史數據。

---

**最後更新**: 2024年12月7日




