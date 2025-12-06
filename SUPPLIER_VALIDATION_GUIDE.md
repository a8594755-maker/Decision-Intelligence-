# 供應商主檔驗證規則說明

## 概述

本文檔詳細說明 `supplier_master` 資料上傳時的驗證與清洗規則。系統會自動檢查資料品質，將資料分為**有效資料 (validRows)** 和**錯誤資料 (errorRows)**，只有有效資料會被寫入資料庫。

---

## 驗證規則

### 1. 必填欄位檢查

以下欄位為**必填**，不可為空：

| 欄位 | 說明 | 錯誤範例 |
|------|------|----------|
| `supplier_code` | 供應商代碼 | `""`, `null`, `"   "` (只有空白) |
| `supplier_name` | 供應商名稱 | `""`, `null`, `"   "` (只有空白) |

**錯誤訊息範例**：
```
supplier_code 為必填欄位，不可為空
supplier_name 為必填欄位，不可為空
```

### 2. 文字欄位清洗與檢查

所有文字欄位會自動進行以下處理：

#### 自動清洗
- ✅ 移除前後空白 (trim)
- ✅ 統一格式

#### 異常內容檢查

系統會檢測以下**異常內容**並加入錯誤資料：

| 異常類型 | 範例 | 說明 |
|---------|------|------|
| 問號序列 | `"??"`, `"???"`, `"?????"` | 表示資料缺失 |
| 純符號 | `"---"`, `"___"`, `"***"` | 無意義填充 |
| 無效標記 | `"N/A"`, `"NA"`, `"null"`, `"none"`, `"--"` | 常見的無效標記 |

**錯誤訊息範例**：
```
供應商名稱包含異常內容：???（例如：'??', '---' 等無效標記）
產品類別包含異常內容：N/A（例如：'??', '---' 等無效標記）
```

### 3. 電話欄位驗證

電話欄位 (`phone`) 有特殊的驗證規則：

#### 自動清洗
系統會自動移除以下字元：
- 空白 ` `
- 括號 `(` `)`
- 破折號 `-`
- 加號 `+`

#### 驗證規則
- 至少包含 **6 位數字**
- 移除特殊字元後檢查

#### 範例

| 原始值 | 清洗後 | 結果 |
|--------|--------|------|
| `"02-1234-5678"` | `"021234567`" | ✅ 通過（10 位數字）|
| `"(02) 1234-5678"` | `"0212345678"` | ✅ 通過（10 位數字）|
| `"+886-2-1234-5678"` | `"886212345678"` | ✅ 通過（12 位數字）|
| `"12345"` | `"12345"` | ❌ 錯誤（只有 5 位數字）|
| `"abc"` | `"abc"` | ❌ 錯誤（沒有數字）|
| `""` | `null` | ✅ 通過（選填欄位，允許為空）|

**錯誤訊息範例**：
```
電話號碼格式不正確：12345（至少需要 6 位數字）
```

### 4. 多餘欄位處理

如果 Excel 檔案中有**不在 schema 定義中**的欄位，系統會自動忽略，不會寫入資料庫。

#### 範例

**Excel 欄位**：
```
供應商代碼, 供應商名稱, 聯絡人, 電話, 備註, 內部欄位A, 內部欄位B
```

**Schema 定義**：
```javascript
[
  'supplier_code',
  'supplier_name',
  'contact_person',
  'phone',
  'email',
  'address',
  // ...
]
```

**處理結果**：
- ✅ `備註` 不在 schema 中 → 自動忽略
- ✅ `內部欄位A` 不在 schema 中 → 自動忽略
- ✅ `內部欄位B` 不在 schema 中 → 自動忽略
- ✅ 不影響資料驗證，其他欄位正常處理

---

## 完整驗證流程

```
上傳 Excel 檔案
    ↓
欄位映射 (Step 3)
    ↓
transformRows() - 根據 mapping 轉換資料
    ↓
validateAndCleanRows() - 驗證與清洗
    ↓
    ├─→ validRows (有效資料)
    │     - 通過所有驗證
    │     - 已完成清洗
    │     - 準備寫入資料庫
    │
    └─→ errorRows (錯誤資料)
          - 包含驗證錯誤
          - 顯示在 UI
          - 不寫入資料庫
    ↓
顯示驗證結果 (Step 4)
    ↓
正式寫入 - 只寫入 validRows
```

---

## 驗證結果格式

### validRows 格式

```javascript
[
  {
    supplier_code: "SUP001",
    supplier_name: "供應商A有限公司",
    contact_person: "張三",
    phone: "0212345678",  // 已清洗
    email: "contact@supplier-a.com",
    address: "台北市中山區...",
    product_category: "電子零件",
    payment_terms: "月結30天",
    delivery_time: "3-5天",
    status: "active"
  },
  // ... 更多有效資料
]
```

### errorRows 格式

```javascript
[
  {
    rowIndex: 3,  // 原始 Excel 行號
    originalData: {
      supplier_code: "",
      supplier_name: "???",
      phone: "123",
      // ... 原始資料
    },
    cleanedData: {
      supplier_code: null,
      supplier_name: "???",
      phone: "123",
      // ... 清洗後資料
    },
    errors: [
      {
        field: "supplier_code",
        fieldLabel: "供應商代碼",
        error: "供應商代碼為必填欄位，不可為空",
        originalValue: ""
      },
      {
        field: "supplier_name",
        fieldLabel: "供應商名稱",
        error: "供應商名稱包含異常內容：???（例如：'??', '---' 等無效標記）",
        originalValue: "???"
      },
      {
        field: "phone",
        fieldLabel: "電話",
        error: "電話號碼格式不正確：123（至少需要 6 位數字）",
        originalValue: "123"
      }
    ]
  },
  // ... 更多錯誤資料
]
```

---

## UI 顯示

### Step 4: 資料驗證結果畫面

#### 統計卡片

```
┌─────────────┬─────────────┬─────────────┬─────────────┐
│   總行數    │  有效資料   │  錯誤資料   │   成功率    │
│     100     │      95     │      5      │     95%     │
└─────────────┴─────────────┴─────────────┴─────────────┘
```

#### 成功訊息區（validRows > 0）

```
✓ 95 筆資料驗證通過
這些資料已完成類型轉換和格式清洗，可以安全地儲存到資料庫。
```

#### 錯誤資料表格（errorRows.length > 0）

```
⚠ 錯誤資料詳情（顯示前 10 筆）
以下資料存在驗證錯誤，請修正後重新上傳

┌────┬──────────┬────────────┬────────────────────────────┐
│行號│ 錯誤欄位 │  原始值    │         錯誤說明           │
├────┼──────────┼────────────┼────────────────────────────┤
│  3 │供應商代碼│    ""      │供應商代碼為必填欄位，不可為空│
│  3 │供應商名稱│   "???"    │供應商名稱包含異常內容：??? │
│  3 │  電話    │   "123"    │電話號碼格式不正確：123     │
├────┼──────────┼────────────┼────────────────────────────┤
│  7 │供應商代碼│    null    │供應商代碼為必填欄位，不可為空│
│  7 │  電話    │   "12"     │電話號碼格式不正確：12      │
└────┴──────────┴────────────┴────────────────────────────┘
```

#### 按鈕區

```
┌────────────────┬────────────────┐
│    返回修改    │   正式寫入     │
│   (可用)       │ (validRows > 0) │
└────────────────┴────────────────┘
```

---

## 實際範例

### 範例 1：全部通過

**輸入資料**：
```csv
供應商代碼,供應商名稱,聯絡人,電話
SUP001,供應商A有限公司,張三,02-1234-5678
SUP002,供應商B股份有限公司,李四,(03) 9876-5432
SUP003,供應商C企業,王五,+886-4-2222-3333
```

**驗證結果**：
- ✅ 總行數：3
- ✅ 有效資料：3
- ✅ 錯誤資料：0
- ✅ 成功率：100%

**validRows**：
```javascript
[
  {
    supplier_code: "SUP001",
    supplier_name: "供應商A有限公司",
    contact_person: "張三",
    phone: "021234567`8"  // 已清洗
  },
  {
    supplier_code: "SUP002",
    supplier_name: "供應商B股份有限公司",
    contact_person: "李四",
    phone: "0398765432"  // 已清洗
  },
  {
    supplier_code: "SUP003",
    supplier_name: "供應商C企業",
    contact_person: "王五",
    phone: "886422223333"  // 已清洗
  }
]
```

### 範例 2：部分錯誤

**輸入資料**：
```csv
供應商代碼,供應商名稱,聯絡人,電話
SUP001,供應商A有限公司,張三,02-1234-5678
,供應商B股份有限公司,李四,(03) 9876-5432
SUP003,???,王五,123
SUP004,供應商D企業,趙六,
```

**驗證結果**：
- 📊 總行數：4
- ✅ 有效資料：2 (第 1, 4 筆)
- ❌ 錯誤資料：2 (第 2, 3 筆)
- 📈 成功率：50%

**validRows** (2 筆)：
```javascript
[
  {
    supplier_code: "SUP001",
    supplier_name: "供應商A有限公司",
    contact_person: "張三",
    phone: "0212345678"
  },
  {
    supplier_code: "SUP004",
    supplier_name: "供應商D企業",
    contact_person: "趙六",
    phone: null  // 電話選填，允許為空
  }
]
```

**errorRows** (2 筆)：
```javascript
[
  {
    rowIndex: 2,
    originalData: {
      supplier_code: "",
      supplier_name: "供應商B股份有限公司",
      contact_person: "李四",
      phone: "(03) 9876-5432"
    },
    errors: [
      {
        field: "supplier_code",
        fieldLabel: "供應商代碼",
        error: "供應商代碼為必填欄位，不可為空",
        originalValue: ""
      }
    ]
  },
  {
    rowIndex: 3,
    originalData: {
      supplier_code: "SUP003",
      supplier_name: "???",
      contact_person: "王五",
      phone: "123"
    },
    errors: [
      {
        field: "supplier_name",
        fieldLabel: "供應商名稱",
        error: "供應商名稱包含異常內容：???（例如：'??', '---' 等無效標記）",
        originalValue: "???"
      },
      {
        field: "phone",
        fieldLabel: "電話",
        error: "電話號碼格式不正確：123（至少需要 6 位數字）",
        originalValue: "123"
      }
    ]
  }
]
```

**寫入結果**：
```
成功儲存 2 筆有效資料，2 筆錯誤資料已略過
```

### 範例 3：包含多餘欄位

**輸入資料**：
```csv
供應商代碼,供應商名稱,聯絡人,電話,備註,內部編號,舊系統ID
SUP001,供應商A有限公司,張三,02-1234-5678,重要客戶,X001,OLD123
SUP002,供應商B股份有限公司,李四,(03) 9876-5432,一般客戶,X002,OLD456
```

**處理**：
- ✅ 「備註」欄位不在 schema 中 → **自動忽略**
- ✅ 「內部編號」欄位不在 schema 中 → **自動忽略**
- ✅ 「舊系統ID」欄位不在 schema 中 → **自動忽略**

**validRows** (只包含 schema 定義的欄位)：
```javascript
[
  {
    supplier_code: "SUP001",
    supplier_name: "供應商A有限公司",
    contact_person: "張三",
    phone: "0212345678",
    // 「備註」、「內部編號」、「舊系統ID」不會出現在這裡
  },
  {
    supplier_code: "SUP002",
    supplier_name: "供應商B股份有限公司",
    contact_person: "李四",
    phone: "0398765432"
  }
]
```

---

## 技術實作

### 核心函數

#### 1. transformRows()
將原始資料根據 columnMapping 轉換為系統欄位結構

```javascript
const transformRows = (rawRows, columnMapping) => {
  return rawRows.map((rawRow, rowIndex) => {
    const transformed = { _originalRowIndex: rowIndex + 1 };

    Object.entries(columnMapping).forEach(([excelColumn, systemFieldKey]) => {
      if (systemFieldKey && systemFieldKey !== '') {
        transformed[systemFieldKey] = rawRow[excelColumn];
      }
    });

    return transformed;
  });
};
```

#### 2. validateAndCleanRows()
驗證並清洗資料

```javascript
export const validateAndCleanRows = (cleanRows, uploadType) => {
  const schema = UPLOAD_SCHEMAS[uploadType];
  const validRows = [];
  const errorRows = [];

  cleanRows.forEach((row, index) => {
    const cleanedRow = {};
    const rowErrors = [];

    // 只處理 schema 中定義的欄位（自動忽略多餘欄位）
    schema.fields.forEach(fieldDef => {
      const fieldKey = fieldDef.key;
      const originalValue = row[fieldKey];

      const { value, errors } = validateAndCleanField(
        originalValue, 
        fieldDef, 
        uploadType
      );

      cleanedRow[fieldKey] = value;

      if (errors.length > 0) {
        errors.forEach(error => {
          rowErrors.push({
            field: fieldKey,
            fieldLabel: fieldDef.label,
            error,
            originalValue
          });
        });
      }
    });

    // 判斷這一行是否有效
    if (rowErrors.length === 0) {
      validRows.push(cleanedRow);
    } else {
      errorRows.push({
        rowIndex: row._originalRowIndex || index + 1,
        originalData: row,
        cleanedData: cleanedRow,
        errors: rowErrors
      });
    }
  });

  return {
    validRows,
    errorRows,
    stats: {
      total: cleanRows.length,
      valid: validRows.length,
      invalid: errorRows.length,
      successRate: Math.round((validRows.length / cleanRows.length) * 100)
    }
  };
};
```

#### 3. validateAndCleanField()
驗證並清洗單一欄位

```javascript
const validateAndCleanField = (value, fieldDef, uploadType) => {
  const errors = [];
  let cleanedValue = value;

  // 檢查必填欄位
  if (fieldDef.required) {
    if (value === null || value === undefined || value === '' || 
        (typeof value === 'string' && value.trim().length === 0)) {
      errors.push(`${fieldDef.label}為必填欄位，不可為空`);
      return { value: null, errors };
    }
  }

  // 如果是空值且非必填，返回預設值或 null
  if (value === null || value === undefined || value === '') {
    return { 
      value: fieldDef.default !== undefined ? fieldDef.default : null, 
      errors: [] 
    };
  }

  // 根據類型進行轉換和驗證
  switch (fieldDef.type) {
    case 'string':
      cleanedValue = String(value).trim();
      
      // 檢查異常文字內容（針對 supplier_master）
      if (uploadType === 'supplier_master' && isAbnormalText(cleanedValue)) {
        errors.push(
          `${fieldDef.label}包含異常內容：${cleanedValue}（例如：'??', '---' 等無效標記）`
        );
      }
      
      // 特殊處理：電話欄位
      if (fieldDef.key === 'phone' && cleanedValue) {
        const phoneResult = parsePhone(cleanedValue);
        cleanedValue = phoneResult.value;
        if (phoneResult.errors.length > 0) {
          errors.push(...phoneResult.errors);
        }
      }
      break;

    // ... 其他類型處理
  }

  return { value: cleanedValue, errors };
};
```

#### 4. isAbnormalText()
檢查異常文字內容

```javascript
const isAbnormalText = (value) => {
  if (!value || value === '') return false;
  
  const str = String(value).trim();
  
  // 檢查是否為問號序列
  if (/^\?+$/.test(str)) return true;
  
  // 檢查是否只包含符號
  if (/^[^\w\u4e00-\u9fa5]+$/.test(str)) return true;
  
  // 檢查常見無效標記
  const invalidMarkers = ['n/a', 'na', 'null', 'none', '--', '---', '____'];
  if (invalidMarkers.includes(str.toLowerCase())) return true;
  
  return false;
};
```

#### 5. parsePhone()
電話號碼清洗與驗證

```javascript
const parsePhone = (value) => {
  if (value === null || value === undefined || value === '') {
    return { value: null, errors: [] };
  }

  // 移除空白、括號、dash、加號
  let cleaned = String(value)
    .replace(/[\s\(\)\-\+]/g, '')
    .trim();

  // 檢查是否至少有 6 位數字
  const digitCount = (cleaned.match(/\d/g) || []).length;
  
  if (digitCount < 6) {
    return {
      value: cleaned,
      errors: [`電話號碼格式不正確：${value}（至少需要 6 位數字）`]
    };
  }

  return { value: cleaned, errors: [] };
};
```

---

## 常見問題

### Q1: 為什麼我的資料被標記為錯誤？

**A**: 檢查錯誤訊息中的具體原因：
- 必填欄位是否為空？
- 是否包含 `???` 或 `---` 等異常標記？
- 電話號碼是否至少有 6 位數字？

### Q2: 電話欄位為空可以嗎？

**A**: 可以。電話欄位是**選填**的，允許為空或 null。

### Q3: 多餘的欄位會影響驗證嗎？

**A**: 不會。系統會自動忽略不在 schema 定義中的欄位，不影響驗證結果。

### Q4: 所有供應商都要有供應商代碼嗎？

**A**: 是的。`supplier_code` 和 `supplier_name` 都是**必填欄位**，不可為空。

### Q5: 如果有錯誤資料，會全部不儲存嗎？

**A**: 不會。系統只會儲存**有效資料 (validRows)**，錯誤資料會被略過。例如：
- 100 筆資料，95 筆有效，5 筆錯誤
- → 只儲存 95 筆有效資料
- → 顯示訊息：「成功儲存 95 筆有效資料，5 筆錯誤資料已略過」

### Q6: 可以下載錯誤資料嗎？

**A**: 目前 UI 會顯示錯誤資料的詳情（前 10 筆），未來可以考慮增加「下載錯誤報告」功能。

---

## 測試建議

### 測試案例 1：正常資料
```csv
供應商代碼,供應商名稱,聯絡人,電話
SUP001,測試供應商A,測試人員,02-1234-5678
```
預期：✅ 全部通過

### 測試案例 2：必填欄位缺失
```csv
供應商代碼,供應商名稱,聯絡人,電話
,測試供應商B,測試人員,02-1234-5678
```
預期：❌ 錯誤「供應商代碼為必填欄位，不可為空」

### 測試案例 3：異常文字
```csv
供應商代碼,供應商名稱,聯絡人,電話
SUP003,???,測試人員,02-1234-5678
```
預期：❌ 錯誤「供應商名稱包含異常內容：???」

### 測試案例 4：電話格式錯誤
```csv
供應商代碼,供應商名稱,聯絡人,電話
SUP004,測試供應商D,測試人員,123
```
預期：❌ 錯誤「電話號碼格式不正確：123（至少需要 6 位數字）」

### 測試案例 5：多餘欄位
```csv
供應商代碼,供應商名稱,聯絡人,電話,備註,內部編號
SUP005,測試供應商E,測試人員,02-1234-5678,測試,X001
```
預期：✅ 通過（備註和內部編號自動忽略）

---

## 相關文檔

- **UPLOAD_WORKFLOW_GUIDE.md** - 完整上傳流程
- **DATA_VALIDATION_GUIDE.md** - 驗證規則詳解
- **DATABASE_SCHEMA_GUIDE.md** - 資料庫 schema
- **src/utils/uploadSchemas.js** - Schema 定義
- **src/utils/dataValidation.js** - 驗證邏輯實作

---

## 總結

供應商主檔驗證系統提供：

- ✅ **嚴格驗證**：必填欄位檢查
- 🧹 **自動清洗**：trim、格式統一
- 🔍 **異常檢測**：`???`、`---` 等無效標記
- 📞 **電話驗證**：格式標準化
- 🗑️ **忽略多餘**：自動忽略 schema 外的欄位
- 📊 **清晰報告**：詳細的錯誤訊息
- 💾 **部分儲存**：只寫入有效資料

確保資料品質，提升系統穩定性！

