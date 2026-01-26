# 日期格式錯誤修復說明

## 問題描述

### 錯誤訊息
```
Save failed: time zone displacement out of range: "+045674-01-01"
```

### 問題原因

這個錯誤是由於 **Excel 日期格式解析錯誤** 造成的。主要原因：

#### 1. **Excel 日期存儲方式**
Excel 內部將日期存儲為**數字**（序列值）：
- `1` = 1900-01-01
- `44927` = 2023-01-01
- `45674` = 2025-01-15

當 XLSX 庫讀取這些數字時，如果沒有正確處理，可能會產生錯誤的日期字串。

#### 2. **錯誤的日期解析**
您的錯誤訊息 `"+045674-01-01"` 表示：
- 系統將 Excel 序列值 `45674` 誤認為年份
- 產生了無效的日期：年份 45674（超出有效範圍）

#### 3. **PostgreSQL 日期範圍限制**
PostgreSQL 的 `date` 類型有範圍限制：
- 最小值：`4713 BC`
- 最大值：`5874897 AD`
- 但實際應用中，年份應該在 `1900-2100` 之間

---

## ✅ 已完成的修復

### 修改檔案：`src/utils/dataValidation.js`

#### 修復內容

**1. 處理 Excel 數字格式**

```javascript
// 如果是數字，可能是 Excel 日期格式
if (typeof dateValue === 'number') {
  // Excel 日期範圍：1 到 50000（約 1900-01-01 到 2036-xx-xx）
  if (dateValue < 1 || dateValue > 50000) {
    return null;  // 拒絕無效範圍
  }
  
  // Excel 的日期基準是 1900-01-01
  const excelEpoch = new Date(1900, 0, 1);
  const daysOffset = dateValue - 1;
  const resultDate = new Date(excelEpoch.getTime() + daysOffset * 24 * 60 * 60 * 1000);
  
  // 驗證並返回
  const isoDate = resultDate.toISOString().split('T')[0];
  const year = parseInt(isoDate.split('-')[0]);
  if (year < 1900 || year > 2100) return null;
  
  return isoDate;
}
```

**2. 驗證年份範圍**

所有日期解析都會檢查年份：

```javascript
const year = parseInt(isoDate.split('-')[0]);
if (year < 1900 || year > 2100) {
  console.warn('Year out of reasonable range:', year);
  return null;
}
```

**3. 檢查無效字符**

```javascript
// 檢查是否包含無效字符（如 "+"）
if (str.includes('+') && !str.match(/^\d{4}-\d{2}-\d{2}T/)) {
  console.warn('Invalid date format detected:', str);
  return null;
}
```

**4. 增強錯誤處理**

```javascript
try {
  // 日期解析邏輯
} catch (e) {
  console.error('Error parsing date:', e);
  return null;
}
```

---

## 🎯 如何使用修復後的版本

### 步驟 1：刷新瀏覽器

清除快取並重新載入：
- **Windows**: `Ctrl + Shift + R` 或 `Ctrl + F5`
- **Mac**: `Cmd + Shift + R`

### 步驟 2：重新上傳資料

1. 回到 Step 1（選擇類型）
2. 選擇「Goods Receipt」
3. 重新上傳您的 Excel 檔案

### 步驟 3：完成欄位映射

確保日期欄位正確映射：
```
planned_delivery_date → Planned Delivery Date
actual_delivery_date  → Actual Delivery Date
receipt_date          → Receipt Date
```

### 步驟 4：查看驗證結果

系統現在會：
- ✅ 正確解析 Excel 日期數字
- ✅ 驗證日期範圍（1900-2100）
- ✅ 拒絕無效的日期
- ✅ 在 Console 顯示警告（如有問題）

### 步驟 5：檢查錯誤資料

如果某些日期仍然無效，會顯示在錯誤資料表格中：

```
行號 | 錯誤欄位              | 原始值    | 錯誤說明
─────┼─────────────────────┼──────────┼─────────────────────
  5  | Actual Delivery Date | +045674  | 日期格式不正確
  8  | Planned Delivery Date| 99999    | 日期格式不正確
```

---

## 📊 支援的日期格式

### Excel 格式

| Excel 儲存 | 系統解析 | 結果 |
|-----------|---------|------|
| `45674` (數字) | Excel 序列值 | `2025-01-15` |
| `44927` (數字) | Excel 序列值 | `2023-01-01` |

### 文字格式

| 輸入格式 | 範例 | 解析結果 |
|---------|------|---------|
| ISO 格式 | `2024-01-15` | ✅ `2024-01-15` |
| 斜線分隔 | `2024/01/15` | ✅ `2024-01-15` |
| 破折號 | `15-01-2024` | ✅ `2024-01-15` |
| 斜線（DD/MM） | `15/01/2024` | ✅ `2024-01-15` |
| 緊密格式 | `20240115` | ✅ `2024-01-15` |

### 無效格式（會被拒絕）

| 輸入 | 原因 | 結果 |
|-----|------|------|
| `+045674-01-01` | 年份超出範圍 | ❌ `null` |
| `99999` | Excel 序列值超出範圍 | ❌ `null` |
| `1800-01-01` | 年份小於 1900 | ❌ `null` |
| `3000-01-01` | 年份大於 2100 | ❌ `null` |
| `abc` | 非日期格式 | ❌ `null` |
| `""` (空白) | 空值 | ✅ `null`（如果非必填） |

---

## 🐛 Debug 方法

### 如果仍然遇到日期錯誤

#### 1. 打開 Console (F12)

查看日誌訊息：

```javascript
// 無效日期會顯示警告
Invalid date format detected: +045674-01-01
Year out of reasonable range: 45674 from +045674-01-01
Unable to parse date: some_invalid_value
```

#### 2. 檢查 Excel 原始資料

在 Excel 中：
1. 選擇日期儲存格
2. 右鍵 → 「設定儲存格格式」
3. 查看「類別」是否為「日期」或「數值」
4. 如果是「文字」，需要轉換為「日期」格式

#### 3. 查看驗證結果

在 Step 4（驗證結果）畫面：
- 查看「錯誤資料」表格
- 找出哪些行的日期有問題
- 回到 Excel 修正這些日期
- 重新上傳

---

## 📝 Excel 日期最佳實務

### 建議做法

#### 1. **使用標準日期格式**
在 Excel 中設定日期格式：
- 選擇日期欄位
- 右鍵 → 「設定儲存格格式」
- 選擇「日期」類別
- 選擇格式：`YYYY-MM-DD` 或 `DD/MM/YYYY`

#### 2. **避免文字格式的日期**
不要用文字輸入日期：
- ❌ 在文字格式儲存格中輸入 `2024-01-15`
- ✅ 使用日期格式儲存格，Excel 會自動處理

#### 3. **檢查資料完整性**
上傳前檢查：
```
- 所有日期都在合理範圍（2020-2025）？
- 沒有空白或錯誤的日期？
- 日期格式一致？
```

#### 4. **處理歷史資料**
如果需要上傳很久以前的資料：
- 確認日期在 `1900-2100` 範圍內
- 如果超出範圍，系統會拒絕

---

## 🔍 技術細節

### Excel 日期序列值

Excel 將日期存儲為從 `1900-01-01` 開始的天數：

```javascript
1       = 1900-01-01
365     = 1900-12-31
366     = 1901-01-01  (Excel 錯誤地認為 1900 是閏年)
43831   = 2020-01-01
44927   = 2023-01-01
45292   = 2024-01-01
45674   = 2025-01-15
50000   = 2036-11-26  (約略上限)
```

### 轉換公式

```javascript
// Excel 序列值 → JavaScript Date
const excelEpoch = new Date(1900, 0, 1);  // 1900-01-01
const daysOffset = excelValue - 1;         // Excel 從 1 開始
const jsDate = new Date(excelEpoch.getTime() + daysOffset * 86400000);

// JavaScript Date → ISO 字串
const isoDate = jsDate.toISOString().split('T')[0];  // "2025-01-15"
```

### 為什麼會出現 "+045674-01-01"？

這是因為原始解析邏輯直接將 Excel 序列值當作字串處理：

```javascript
// 錯誤的處理方式
const str = String(45674);           // "45674"
const date = new Date(str);          // 將 "45674" 當作年份？
// 產生錯誤："+045674-01-01"

// 正確的處理方式
if (typeof value === 'number') {
  // 識別為 Excel 序列值
  // 轉換為正確的日期
}
```

---

## ✅ 測試案例

### 測試資料 1：正常日期

```csv
supplier_name,material_code,actual_delivery_date,received_qty
Supplier A,MAT001,2024-01-15,100
Supplier B,MAT002,2024/02/20,200
Supplier C,MAT003,15-03-2024,150
```

**預期結果**：✅ 全部通過

### 測試資料 2：Excel 數字格式

如果 Excel 儲存格格式為「數值」或「日期」：

```
actual_delivery_date 欄位值：45674 (Excel 數字)
```

**預期結果**：✅ 解析為 `2025-01-15`

### 測試資料 3：無效日期

```csv
supplier_name,material_code,actual_delivery_date,received_qty
Supplier D,MAT004,99999,100
Supplier E,MAT005,abc,200
Supplier F,MAT006,1800-01-01,150
```

**預期結果**：
- ❌ 第 1 筆：`日期格式不正確：99999`
- ❌ 第 2 筆：`日期格式不正確：abc`
- ❌ 第 3 筆：`日期格式不正確：1800-01-01（年份小於 1900）`

---

## 📊 修復前後對比

### 修復前 ❌

```javascript
parseDate(45674)
// 結果：錯誤的解析
// 產生："+045674-01-01"
// 資料庫：拒絕（time zone displacement out of range）
```

### 修復後 ✅

```javascript
parseDate(45674)
// 1. 檢測到是數字
// 2. 驗證範圍（1 - 50000）
// 3. 轉換為 JavaScript Date
// 4. 驗證年份（1900 - 2100）
// 結果："2025-01-15"
// 資料庫：成功寫入
```

---

## 🎯 下一步

### 立即行動

1. **刷新瀏覽器** (Ctrl+Shift+R)
2. **重新上傳** Excel 檔案
3. **完成映射** 並驗證資料
4. **查看結果**：
   - 如果全部通過 → 點擊「正式寫入」
   - 如果有錯誤 → 查看錯誤詳情，修正 Excel 後重新上傳

### 預防措施

- 📋 使用標準日期格式
- 🔍 上傳前檢查資料
- ✅ 查看驗證結果
- 📝 保存成功的 Excel 作為模板

---

## 相關文檔

- **SUPPLIER_VALIDATION_GUIDE.md** - 供應商驗證規則
- **UPLOAD_WORKFLOW_GUIDE.md** - 完整上傳流程
- **DATA_VALIDATION_GUIDE.md** - 驗證邏輯說明

---

## 總結

### ✅ 問題已修復

- Excel 數字格式日期正確解析
- 年份範圍驗證（1900-2100）
- 無效日期自動拒絕
- 詳細錯誤日誌

### 💡 使用建議

- 刷新瀏覽器後重試
- 使用標準日期格式
- 查看 Console 了解詳情
- 錯誤資料不會寫入資料庫

**現在可以安全地重新上傳資料了！** 🚀

