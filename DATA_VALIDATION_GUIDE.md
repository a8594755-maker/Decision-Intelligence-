# 資料驗證與清洗功能說明

## 概述

系統提供完整的資料驗證與清洗功能，確保上傳的資料符合格式要求後才能儲存到資料庫。

## 驗證流程

### Step 1: 選擇上傳類型
選擇資料類型（收貨記錄、價格歷史、供應商主檔）

### Step 2: 上傳檔案
上傳 Excel 或 CSV 檔案

### Step 3: 欄位映射
將 Excel 欄位映射到系統欄位

### Step 4: 資料驗證與清洗 ⭐ 新功能
系統會自動進行以下檢查：

#### 1. **必填欄位檢查**
- 檢查所有必填欄位是否有值
- 空值會被標記為錯誤

#### 2. **資料類型轉換與驗證**

##### 數字 (number)
- 自動移除逗號、空格、貨幣符號
- 轉換為數字格式
- 檢查數值範圍（min/max）
- 範例：`"1,234.56"` → `1234.56`

##### 日期 (date)
支援多種日期格式自動轉換：
- `YYYY-MM-DD` → ISO 格式
- `YYYY/MM/DD` → ISO 格式
- `DD-MM-YYYY` → ISO 格式
- `DD/MM/YYYY` → ISO 格式
- `YYYYMMDD` → ISO 格式
- 範例：`"2024/01/15"` → `"2024-01-15"`

##### 布林值 (boolean)
自動識別多種表示方式：
- True: `true`, `yes`, `1`, `y`, `是`, `t`
- False: `false`, `no`, `0`, `n`, `否`, `f`

##### 字串 (string)
- 自動去除前後空白

#### 3. **預設值處理**
- 選填欄位若為空，會套用 schema 定義的預設值
- 例如：`uom` 預設為 `"pcs"`

### Step 5: 檢視驗證結果

驗證完成後會顯示：

#### 統計資訊
- **總行數**：上傳的總資料筆數
- **有效資料**：通過驗證的筆數
- **錯誤資料**：存在錯誤的筆數
- **成功率**：有效資料的百分比

#### 錯誤詳情表格
顯示前 10 筆錯誤資料，包含：
- 行號
- 錯誤欄位名稱
- 原始值
- 詳細錯誤說明

範例錯誤訊息：
- `供應商名稱為必填欄位，不可為空`
- `收貨數量必須是數字，但得到：abc`
- `實際交貨日期的日期格式不正確：2024-13-45`

## 驗證規則範例

### 收貨記錄 (Goods Receipt)

| 欄位 | 類型 | 必填 | 驗證規則 |
|------|------|------|----------|
| supplier_name | string | ✓ | 不可為空 |
| material_code | string | ✓ | 不可為空 |
| actual_delivery_date | date | ✓ | 必須是有效日期格式 |
| received_qty | number | ✓ | 必須是數字且 ≥ 0 |
| rejected_qty | number | ✗ | 必須是數字且 ≥ 0，預設 0 |
| uom | string | ✗ | 預設 "pcs" |

### 價格歷史 (Price History)

| 欄位 | 類型 | 必填 | 驗證規則 |
|------|------|------|----------|
| supplier_name | string | ✓ | 不可為空 |
| material_code | string | ✓ | 不可為空 |
| order_date | date | ✓ | 必須是有效日期格式 |
| unit_price | number | ✓ | 必須是數字且 ≥ 0 |
| currency | string | ✗ | 預設 "USD" |

### 供應商主檔 (Supplier Master)

| 欄位 | 類型 | 必填 | 驗證規則 |
|------|------|------|----------|
| supplier_name | string | ✓ | 不可為空 |
| status | string | ✗ | 預設 "active" |

## 常見錯誤與解決方法

### 1. 必填欄位為空
**錯誤訊息**：`供應商名稱為必填欄位，不可為空`

**解決方法**：確保 Excel 中該欄位有填入值

### 2. 數字格式錯誤
**錯誤訊息**：`收貨數量必須是數字，但得到：abc`

**解決方法**：確保數字欄位只包含數字（可以有逗號和小數點）

### 3. 日期格式錯誤
**錯誤訊息**：`實際交貨日期的日期格式不正確：2024-13-45`

**解決方法**：使用正確的日期格式，如：
- `2024-01-15`
- `2024/01/15`
- `15/01/2024`
- `20240115`

### 4. 數值超出範圍
**錯誤訊息**：`收貨數量不能小於 0`

**解決方法**：確保數值符合欄位的範圍限制

## 技術實作

### 核心函數

#### `validateAndCleanData(rawRows, uploadType, columnMapping)`
完整的驗證流程，包含：
1. 根據 mapping 轉換資料結構
2. 驗證並清洗每個欄位
3. 返回 validRows 和 errorRows

#### `validateAndCleanRows(cleanRows, uploadType)`
驗證和清洗已轉換的資料

#### `transformRows(rawRows, columnMapping)`
將原始資料根據映射轉換為系統欄位結構

### 返回結構

```javascript
{
  validRows: [
    {
      supplier_name: "供應商A",
      material_code: "MAT001",
      actual_delivery_date: "2024-01-15",
      received_qty: 100,
      rejected_qty: 0
    }
  ],
  errorRows: [
    {
      rowIndex: 3,
      originalData: { ... },
      cleanedData: { ... },
      errors: [
        {
          field: "received_qty",
          fieldLabel: "收貨數量",
          error: "收貨數量必須是數字，但得到：abc",
          originalValue: "abc"
        }
      ]
    }
  ],
  stats: {
    total: 100,
    valid: 97,
    invalid: 3,
    successRate: 97
  }
}
```

## 最佳實務

1. **上傳前檢查**：確保 Excel 資料格式正確
2. **分批上傳**：大量資料建議分批上傳，每批 1000 筆以內
3. **錯誤修正**：發現錯誤後，修正 Excel 重新上傳
4. **欄位映射**：仔細檢查欄位映射是否正確
5. **日期格式**：統一使用 YYYY-MM-DD 格式最保險

## 檔案位置

- 驗證函數：`src/utils/dataValidation.js`
- Schema 定義：`src/utils/uploadSchemas.js`
- UI 介面：`src/views/EnhancedExternalSystemsView.jsx`

