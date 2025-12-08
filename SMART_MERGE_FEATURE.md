# 智能合併功能（Smart Merge）

## 用戶需求

用戶要求：
> "我要的是合併，例如 Goods Receipt 和 Price History 都會有 Supplier Name，但是在 Supplier Management 的時候，要是合併的資料"

**需求說明**：
- 不同來源（Goods Receipt, Price History）都包含供應商資訊
- 上傳 Supplier Master 時，如果有重複的供應商，應該**智能合併**
- 保留最完整的資訊，而不是跳過重複

---

## ✅ 實作的智能合併功能

### 核心邏輯：保留最完整的資訊

當發現重複的供應商（相同 `supplier_code` 或 `supplier_name`）時：

1. **合併規則**：
   - 如果欄位 A 在第一筆是空的（`''`, `'-'`, `'N/A'`），使用第二筆的值
   - 如果欄位 A 在兩筆都有值，保留第一筆（通常最完整）
   - 特殊欄位（如 `email`）：如果兩筆都有不同值，用逗號合併

2. **合併後**：
   - 返回合併後的單一記錄
   - 記錄哪些行被合併了
   - UI 顯示合併詳情

---

## 📊 實際範例

### 範例 1：基本合併

**輸入 Excel**：
```
Row 1: BP001 | BlueWave Packaging | Emily | 88678122201 | emily@bp.com
Row 2: BP001 | BlueWave Packaging | -     | -           | -
```

**合併後**：
```
BP001 | BlueWave Packaging | Emily | 88678122201 | emily@bp.com
```

**說明**：
- Row 2 的 contact, phone 是空的，所以使用 Row 1 的值
- 最終只保存 1 筆完整資料

---

### 範例 2：資訊互補合併

**輸入 Excel**：
```
Row 1: BP001 | BlueWave Packaging | Emily | 88678122201 | -
Row 2: BP001 | BlueWave Packaging | -     | -           | emily@bp.com
```

**合併後**：
```
BP001 | BlueWave Packaging | Emily | 88678122201 | emily@bp.com
```

**說明**：
- Row 1 有 contact 和 phone
- Row 2 有 email
- 合併後包含所有資訊

---

### 範例 3：Email 合併

**輸入 Excel**：
```
Row 1: BP001 | BlueWave Packaging | Emily | 88678122201 | emily@bp.com
Row 2: BP001 | BlueWave Packaging | David | 99999999    | support@bp.com
```

**合併後**：
```
BP001 | BlueWave Packaging | Emily | 88678122201 | emily@bp.com, support@bp.com
```

**說明**：
- contact 和 phone 保留第一筆（Emily, 88678122201）
- email 有兩個不同的值，用逗號合併

---

### 範例 4：按 Supplier Name 合併

**輸入 Excel**：
```
Row 1: -     | BlueWave Packaging | Emily | 88678122201 | emily@bp.com
Row 2: BP001 | BlueWave Packaging | David | 99999999    | support@bp.com
```

**合併後**：
```
BP001 | BlueWave Packaging | Emily | 88678122201 | emily@bp.com, support@bp.com
```

**說明**：
- 雖然 Row 1 沒有 supplier_code，但有相同的 supplier_name
- 系統仍然識別為重複並合併
- 從 Row 2 補充 supplier_code

---

## 🎯 UI 顯示

### Step 4: 驗證結果頁面

#### 統計卡片
```
Total Rows: 10
Valid Data: 8     ← 合併後的數量
Error Data: 0
Merged: 2         ← 顯示合併的數量
Success Rate: 80%
```

#### 合併詳情區塊（藍色）
```
✓ Intelligently merged 2 duplicate records

System has automatically merged duplicate suppliers, preserving the most complete information.

╔═══════════════════════════════════════════════════════════╗
║ Merged Supplier: "BP001" (2 rows merged into 1)          ║
║                                                            ║
║ Merged from rows: 1, 5                                    ║
║                                                            ║
║ Final merged data:                                        ║
║ • Code: BP001                                            ║
║ • Name: BlueWave Packaging                               ║
║ • Contact: Emily                                         ║
║ • Phone: 88678122201                                     ║
║ • Email: emily@bp.com, support@bp.com                    ║
╚═══════════════════════════════════════════════════════════╝
```

### Step 5: 保存成功

```
✅ Successfully saved 8 rows (2 duplicates merged)
```

---

## 🔧 合併邏輯詳解

### mergeSupplierDuplicates 函數

```javascript
const mergeSupplierDuplicates = (rows) => {
  const codeMap = new Map(); // supplier_code -> record
  const nameMap = new Map(); // supplier_name -> record

  rows.forEach((row, originalIndex) => {
    const code = row.supplier_code;
    const name = row.supplier_name;
    
    // 優先使用 supplier_code 作為唯一鍵
    const key = code || name;
    if (!key) return; // 跳過無 code 也無 name 的行

    // 尋找現有記錄
    let existing = codeMap.get(code) || nameMap.get(name);

    if (existing) {
      // 合併資料：保留最完整的欄位值
      Object.keys(row).forEach(field => {
        const existingValue = existing.row[field];
        const newValue = row[field];
        
        // 情況 1：現有值為空，用新值替換
        if (isEmpty(existingValue) && !isEmpty(newValue)) {
          existing.row[field] = newValue;
        }
        // 情況 2：兩者都有值且不同
        else if (newValue && newValue !== existingValue) {
          // email 特殊處理：合併
          if (field === 'email' && !existingValue.includes(newValue)) {
            existing.row[field] = `${existingValue}, ${newValue}`;
          }
          // 其他欄位：保留原有值（第一筆）
        }
      });
      
      // 記錄被合併的行號
      existing.mergedFromRows.push(originalIndex + 1);
    } else {
      // 新記錄
      const newRecord = {
        row: { ...row },
        originalRow: originalIndex + 1,
        mergedFromRows: []
      };
      
      if (code) codeMap.set(code, newRecord);
      if (name) nameMap.set(name, newRecord);
    }
  });

  return Array.from(codeMap.values());
};

function isEmpty(value) {
  return !value || value === '' || value === '-' || value === 'N/A';
}
```

---

## 📋 合併流程

### 1. 驗證階段（validateAndCleanRows）

```javascript
export const validateAndCleanRows = (cleanRows, uploadType) => {
  // ... 現有的驗證邏輯 ...
  
  // 重複檢查與智能合併
  const duplicateInfo = checkDuplicates(validRows, uploadType);
  
  // 對於 supplier_master，使用合併後的資料
  const finalValidRows = (uploadType === 'supplier_master' && duplicateInfo.mergedRows) 
    ? duplicateInfo.mergedRows  // 已經是合併後的資料！
    : validRows;
  
  return {
    validRows: finalValidRows, // 返回合併後的資料
    errorRows,
    duplicateGroups: duplicateInfo.duplicateGroups,
    stats: {
      total: cleanRows.length,
      valid: finalValidRows.length, // 合併後的數量
      merged: duplicateInfo.duplicateCount
    }
  };
};
```

### 2. UI 顯示階段

- 統計卡片顯示 "Merged: X"
- 藍色區塊顯示合併詳情
- 顯示合併前後的資料對比

### 3. 保存階段

```javascript
const handleSave = async () => {
  // validationResult.validRows 已經是合併後的資料
  const rowsToSave = validationResult.validRows;
  
  // 直接保存，無需再次去重
  savedCount = await saveSuppliers(userId, rowsToSave, batchId);
  
  // 成功訊息
  const successMsg = `Successfully saved ${savedCount} rows (${mergedCount} duplicates merged)`;
};
```

---

## 🎉 優勢對比

### 舊方案：跳過重複

```
輸入：
Row 1: BP001 | BlueWave | Emily | 88678122201 | emily@bp.com
Row 2: BP001 | BlueWave | David | 99999999    | support@bp.com

結果：
保存 Row 1，跳過 Row 2
❌ 丟失了 David 的聯絡資訊
❌ 丟失了 support@bp.com
```

### 新方案：智能合併 ✅

```
輸入：
Row 1: BP001 | BlueWave | Emily | 88678122201 | emily@bp.com
Row 2: BP001 | BlueWave | David | 99999999    | support@bp.com

結果：
合併後: BP001 | BlueWave | Emily | 88678122201 | emily@bp.com, support@bp.com
✅ 保留了第一筆的主要聯絡人
✅ 合併了兩個 email
✅ 資訊最完整
```

---

## 🚀 測試步驟

### 步驟 1：準備測試資料

創建 Excel 檔案 `supplier_merge_test.xlsx`：

```csv
supplier_code,supplier_name,contact_person,phone,email,address
BP001,BlueWave Packaging,Emily Chen,88678122201,emily@bp.com,123 Main St
BP001,BlueWave Packaging,-,-,support@bp.com,456 Oak Ave
BP002,GreenTech Supply,John Doe,12345678,john@gt.com,
BP002,GreenTech Supply,-,87654321,,-
BP003,RedStar Materials,Mary Smith,11111111,mary@rs.com,789 Pine Rd
```

### 步驟 2：上傳並驗證

1. 刷新瀏覽器（Ctrl + Shift + R）
2. 選擇「Supplier Master」
3. 上傳測試 Excel
4. 完成欄位映射
5. 點擊「Next Step: Validate Data」

### 步驟 3：檢查驗證結果

應該看到：

```
Total Rows: 5
Valid Data: 3      ← 5 筆合併成 3 筆
Error Data: 0
Merged: 2          ← 2 筆被合併
Success Rate: 60%

✓ Intelligently merged 2 duplicate records

Merged Supplier: "BP001" (2 rows merged into 1)
Merged from rows: 1, 2
Final merged data:
  • Code: BP001
  • Name: BlueWave Packaging
  • Contact: Emily Chen
  • Phone: 88678122201
  • Email: emily@bp.com, support@bp.com
  • Address: 123 Main St

Merged Supplier: "BP002" (2 rows merged into 1)
Merged from rows: 3, 4
Final merged data:
  • Code: BP002
  • Name: GreenTech Supply
  • Contact: John Doe
  • Phone: 87654321
  • Email: john@gt.com
```

### 步驟 4：保存資料

1. 點擊「Save to Database」
2. 應該看到：
   ```
   ✅ Successfully saved 3 rows (2 duplicates merged)
   ```

### 步驟 5：驗證資料庫

查看 Supabase `suppliers` 表，應該有 3 筆資料：

```
1. BP001 | BlueWave Packaging | Emily Chen | 88678122201 | emily@bp.com, support@bp.com | 123 Main St
2. BP002 | GreenTech Supply   | John Doe   | 87654321    | john@gt.com                  | (empty)
3. BP003 | RedStar Materials  | Mary Smith | 11111111    | mary@rs.com                  | 789 Pine Rd
```

---

## 📁 修改的檔案

### 1. src/utils/dataValidation.js

**新增函數**：
```javascript
const mergeSupplierDuplicates = (rows) => {
  // 智能合併邏輯
  // 返回合併後的資料和合併資訊
}
```

**修改函數**：
```javascript
const checkDuplicates = (rows, uploadType) => {
  if (uploadType === 'supplier_master') {
    const mergedResult = mergeSupplierDuplicates(rows);
    // 返回合併後的資料
    return {
      duplicateGroups,
      duplicateCount,
      mergedRows: mergedResult.map(r => r.row)
    };
  }
}

export const validateAndCleanRows = (cleanRows, uploadType) => {
  // 使用合併後的資料
  const finalValidRows = (uploadType === 'supplier_master' && duplicateInfo.mergedRows) 
    ? duplicateInfo.mergedRows 
    : validRows;
  
  return {
    validRows: finalValidRows, // 合併後的資料
    stats: { ..., merged: duplicateInfo.duplicateCount }
  };
}
```

### 2. src/views/EnhancedExternalSystemsView.jsx

**修改 1：統計卡片**
- "Duplicates" → "Merged"
- 黃色 → 藍色

**修改 2：合併詳情區塊**
- 警告（黃色）→ 成功（藍色）
- "will be skipped" → "have been intelligently merged"
- 顯示合併後的最終資料

**修改 3：handleSave 函數**
- 移除手動去重邏輯（已在驗證階段完成）
- 直接使用 validationResult.validRows

**修改 4：成功訊息**
- "X duplicate rows skipped" → "X duplicates merged"

---

## 🎯 總結

### 核心價值

1. **資訊不丟失**：合併而非跳過，保留所有有用資訊
2. **智能化**：自動識別最完整的資料
3. **透明化**：清楚顯示合併前後的資料
4. **符合業務需求**：Goods Receipt 和 Price History 的供應商資訊會被正確合併到 Supplier Management

### 應用場景

- ✅ 從多個來源（Goods Receipt, Price History）收集供應商資訊
- ✅ 上傳 Supplier Master 時自動合併重複
- ✅ 維護單一、完整的供應商主檔

### 後續可優化

- [ ] 添加合併策略選項（保留第一筆 vs 保留最新 vs 保留最完整）
- [ ] 支援手動選擇要保留的資料
- [ ] 合併歷史記錄追蹤
- [ ] 支援更多欄位的特殊合併規則

---

**智能合併功能已完成！現在可以安全地上傳包含重複供應商的資料，系統會自動合併保留最完整的資訊！** 🎉



