# One-shot Import 快速驗收測試

## 🎯 目標：驗證泛用性（不針對特定檔案）

---

## ✅ 測試 1：編譯與啟動

```bash
# 編譯
npm run build
# ✓ 預期：built in 3-4s，無錯誤

# 啟動
npm run dev
# ✓ 預期：VITE ready，無紅色錯誤

# 開啟瀏覽器
# http://localhost:5173 (或提示的 port)
```

---

## ✅ 測試 2：泛用分類（不同檔案類型）

### 準備測試檔案

建立一個 Excel 檔案，包含 4 個 sheets：

#### Sheet1: "BOM_Data"
| parent_material | component_material | qty_per |
|---|---|---|
| FG001 | RM001 | 2 |
| FG001 | RM002 | 3.5 |

**預期分類：** bom_edge，confidence >= 75%

---

#### Sheet2: "Demand"
| material_code | time_bucket | demand_qty |
|---|---|---|
| FG001 | 2024-W01 | 100 |
| FG002 | 2024-W02 | 200 |

**預期分類：** demand_fg，confidence >= 75%

---

#### Sheet3: "Suppliers"
| supplier_name | contact_person | phone |
|---|---|---|
| ABC Corp | John Doe | 123-456 |
| XYZ Ltd | Jane Smith | 789-012 |

**預期分類：** supplier_master，confidence >= 70%

---

#### Sheet4: "Random"
| Column A | Column B | Column C |
|---|---|---|
| 1 | 2 | 3 |
| 4 | 5 | 6 |

**預期分類：** No match，confidence < 50%

---

### 執行測試

1. 前往 Data Upload 頁面
2. 勾選 "One-shot Import" toggle
3. 上傳上述 Excel 檔案

**預期結果：**

| Sheet | Suggested Type | Confidence | Enabled | Status |
|---|---|---|---|---|
| BOM_Data | bom_edge | 85%+ | ✓ | Ready (2 rows) |
| Demand | demand_fg | 85%+ | ✓ | Ready (2 rows) |
| Suppliers | supplier_master | 75%+ | ✓ | Ready (2 rows) |
| Random | null | <50% | ✗ | Low confidence |

✅ **泛用性驗證：** 不同類型的 sheet 都被正確分類

---

## ✅ 測試 3：同義字映射（Header Synonyms）

### 準備測試檔案

建立 Excel，Sheet1: "BOM_Synonyms"

| Parent Part | Child Part | Usage |
|---|---|---|
| FG001 | RM001 | 2 |

**預期：**
- "Parent Part" → 映射為 parent_material
- "Child Part" → 映射為 component_material  
- "Usage" → 映射為 qty_per
- 正確分類為 bom_edge
- confidence >= 75%

✅ **同義字驗證：** 不同名稱的欄位被正確映射

---

## ✅ 測試 4：Negative Headers（避免誤判）

### 準備測試檔案

建立 Excel，Sheet1: "BOM_With_Supplier"

| parent_material | component_material | qty_per | supplier_name |
|---|---|---|---|
| FG001 | RM001 | 2 | ABC Corp |

**預期：**
- 仍分類為 bom_edge（因為 required 都命中）
- 但 confidence 降低（因為 matchedNegative）
- evidence 顯示 "Contains unexpected fields: supplier"

✅ **Negative 驗證：** 不應該出現的欄位會降低信心度

---

## ✅ 測試 5：Missing Required Fields

### 準備測試檔案

建立 Excel，Sheet1: "BOM_Incomplete"

| parent_material | component_material |
|---|---|
| FG001 | RM001 |

（缺少 qty_per）

**預期：**
- suggestedType = bom_edge
- confidence <= 50%（被 cap）
- enabled = false
- Status 顯示 "Missing: qty_per"

✅ **Missing Fields 驗證：** 缺少必填欄位會被阻擋

---

## ✅ 測試 6：行數限制

### 準備測試檔案

建立 Excel，Sheet1: "Large_Data"（>1000 rows）

**預期：**
- enabled = false
- disabledReason = "Too many rows (1234 > 1000). Please split the data."

✅ **限制驗證：** 超過 1000 rows 被阻擋

---

## ✅ 測試 7：空白 Sheet

### 準備測試檔案

建立 Excel，Sheet1: "Empty"（0 rows）

**預期：**
- enabled = false
- disabledReason = "Sheet is empty (0 rows)"

✅ **Edge Case 驗證：** 空白 sheet 被跳過

---

## ✅ 測試 8：手動介入

### 步驟

1. 上傳包含 "Random" sheet 的檔案
2. 觀察到 confidence < 75%，disabled
3. 手動從 dropdown 選擇 uploadType（例如 supplier_master）
4. 勾選 enabled
5. 點擊 "Import X Sheets"

**預期：**
- 允許手動指定 uploadType
- 能成功匯入（如果資料符合 schema）

✅ **人工介入驗證：** 低信心度 sheet 可手動修正

---

## ✅ 測試 9：錯誤隔離

### 準備測試檔案

建立 Excel，包含 3 個 sheets：
- Sheet1: Valid BOM data
- Sheet2: Invalid data（會導致 validation 失敗）
- Sheet3: Valid Demand data

### 步驟

1. Enable 全部 3 個 sheets
2. 點擊 Import

**預期結果：**
- Sheet1: ✓ Imported (X rows saved)
- Sheet2: ✗ Failed (reason: validation error)
- Sheet3: ✓ Imported (X rows saved)
- 總計：2 imported, 0 skipped, 1 failed

✅ **錯誤隔離驗證：** Sheet2 失敗不影響 Sheet1 和 Sheet3

---

## ✅ 測試 10：下載報告

### 步驟

1. 完成任意匯入
2. 點擊 "Download Report (JSON)"

**預期：**
- 下載 JSON 檔案
- 包含完整結果（status, savedCount, reason, error）
- JSON 格式正確

✅ **報告驗證：** 結果可下載並查看

---

## 🎯 泛用性總驗證

### Checklist

- [ ] ✅ 測試 1：編譯與啟動
- [ ] ✅ 測試 2：泛用分類（4 種不同類型）
- [ ] ✅ 測試 3：同義字映射
- [ ] ✅ 測試 4：Negative headers
- [ ] ✅ 測試 5：Missing required fields
- [ ] ✅ 測試 6：行數限制
- [ ] ✅ 測試 7：空白 sheet
- [ ] ✅ 測試 8：手動介入
- [ ] ✅ 測試 9：錯誤隔離
- [ ] ✅ 測試 10：下載報告

### 如果全部通過

**✓ 框架泛用性驗證完成！**

可以處理：
- 不同欄位名稱（同義字）
- 不同資料類型（8 種 uploadType）
- 不同檔案結構（自動分類）
- 邊界情況（空白、超大、錯誤）
- 錯誤恢復（隔離、人工介入）

---

## 📝 額外驗證（進階）

### 驗證擴充性

1. 在 `src/config/uploadFingerprints.js` 新增一個測試 rule：
```javascript
test_type: {
  requiredHeaders: ['test_field_1', 'test_field_2'],
  optionalHeaders: ['test_field_3'],
  negativeHeaders: [],
  fieldTypeHints: {},
  minConfidenceToAutoEnable: 0.75,
  description: 'Test type for validation'
}
```

2. 建立包含 test_field_1, test_field_2 的 Excel

3. 上傳

**預期：** 自動分類為 test_type（不需修改任何分類邏輯）

✅ **擴充性驗證：** 新增類型只需新增 config

---

**快速驗收完成時間：** 約 15-20 分鐘  
**通過標準：** 全部 10 項測試通過  
**泛用性確認：** ✅ 不針對特定檔案
