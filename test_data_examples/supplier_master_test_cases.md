# 供應商主檔測試資料範例

## 測試案例說明

本文件提供各種測試案例的範例資料，用於測試供應商主檔上傳的驗證邏輯。

---

## 測試案例 1：正常資料（全部通過）

**檔案名稱**: `supplier_master_valid.csv`

```csv
供應商代碼,供應商名稱,聯絡人,電話,Email,地址,產品類別,付款條件,交貨時間,狀態
SUP001,台灣電子零件有限公司,張小明,02-2123-4567,contact@taiwan-elec.com,台北市中山區南京東路100號,電子零件,月結30天,3-5天,active
SUP002,優質塑膠股份有限公司,李美玲,(03) 456-7890,sales@quality-plastic.com,桃園市中壢區中正路200號,塑膠原料,月結45天,7-10天,active
SUP003,精密五金企業社,王大偉,+886-4-2234-5678,info@precision-metal.com,台中市西屯區工業區15路300號,五金配件,貨到付款,1-3天,active
SUP004,環保包裝材料行,陳怡君,07-789-0123,eco@packaging.com,高雄市前鎮區中華五路400號,包裝材料,月結60天,5-7天,active
SUP005,國際物流服務公司,林志豪,02 8765 4321,service@intl-logistics.com,新北市新莊區中正路500號,物流服務,月結30天,即日,active
```

**預期結果**：
- ✅ 總行數：5
- ✅ 有效資料：5
- ✅ 錯誤資料：0
- ✅ 成功率：100%

**驗證點**：
- 所有必填欄位都有值
- 電話格式多樣但都有效（含括號、dash、空白、加號）
- 系統會自動清洗電話號碼

---

## 測試案例 2：必填欄位缺失

**檔案名稱**: `supplier_master_missing_required.csv`

```csv
供應商代碼,供應商名稱,聯絡人,電話
SUP001,正常供應商A,張三,02-1234-5678
,缺少代碼的供應商,李四,03-9876-5432
SUP003,,王五,04-2222-3333
,,趙六,07-8888-9999
SUP005,正常供應商B,錢七,
```

**預期結果**：
- 📊 總行數：5
- ✅ 有效資料：2（第 1, 5 筆）
- ❌ 錯誤資料：3（第 2, 3, 4 筆）
- 📈 成功率：40%

**錯誤詳情**：
- **第 2 筆**：`supplier_code 為必填欄位，不可為空`
- **第 3 筆**：`supplier_name 為必填欄位，不可為空`
- **第 4 筆**：`supplier_code 為必填欄位，不可為空`、`supplier_name 為必填欄位，不可為空`

**驗證點**：
- 第 5 筆電話為空但是有效（電話為選填）
- 空字串和 null 都會被視為缺失

---

## 測試案例 3：異常文字內容

**檔案名稱**: `supplier_master_abnormal_text.csv`

```csv
供應商代碼,供應商名稱,聯絡人,電話,產品類別,付款條件
SUP001,正常供應商,張三,02-1234-5678,電子零件,月結30天
SUP002,???,李四,03-9876-5432,電子零件,月結30天
SUP003,異常供應商,王五,04-2222-3333,???,月結30天
SUP004,符號供應商,趙六,07-8888-9999,---,---
SUP005,NULL標記,錢七,02-5555-6666,N/A,null
SUP006,底線符號,孫八,03-4444-5555,____,none
```

**預期結果**：
- 📊 總行數：6
- ✅ 有效資料：1（第 1 筆）
- ❌ 錯誤資料：5（第 2-6 筆）
- 📈 成功率：17%

**錯誤詳情**：
- **第 2 筆**：`supplier_name 包含異常內容：???`
- **第 3 筆**：`product_category 包含異常內容：???`
- **第 4 筆**：`product_category 包含異常內容：---`、`payment_terms 包含異常內容：---`
- **第 5 筆**：`product_category 包含異常內容：N/A`、`payment_terms 包含異常內容：null`
- **第 6 筆**：`product_category 包含異常內容：____`、`payment_terms 包含異常內容：none`

**驗證點**：
- 系統會檢測 `???`、`---`、`N/A`、`null`、`none`、`____` 等異常標記
- 異常檢測只針對 supplier_master 類型

---

## 測試案例 4：電話格式問題

**檔案名稱**: `supplier_master_phone_invalid.csv`

```csv
供應商代碼,供應商名稱,聯絡人,電話
SUP001,正常供應商A,張三,02-1234-5678
SUP002,正常供應商B,李四,(03) 987-6543
SUP003,正常供應商C,王五,+886-912-345-678
SUP004,電話太短,趙六,12345
SUP005,電話太短2,錢七,123
SUP006,非數字,孫八,abcdefg
SUP007,混合但不足,周九,abc123
SUP008,空白電話,吳十,
```

**預期結果**：
- 📊 總行數：8
- ✅ 有效資料：5（第 1, 2, 3, 7, 8 筆）
- ❌ 錯誤資料：3（第 4, 5, 6 筆）
- 📈 成功率：63%

**錯誤詳情**：
- **第 4 筆**：`電話號碼格式不正確：12345（至少需要 6 位數字）`
- **第 5 筆**：`電話號碼格式不正確：123（至少需要 6 位數字）`
- **第 6 筆**：`電話號碼格式不正確：abcdefg（至少需要 6 位數字）`

**驗證點**：
- 電話至少要有 6 位數字
- 特殊字元（空白、括號、dash）會被自動移除
- 空白電話是有效的（選填欄位）
- `abc123` 雖然混合但有 6 位數字（1,2,3），實際上不足 6 位，應該會錯誤

**更正**：第 7 筆應該也會錯誤（只有 3 位數字）

---

## 測試案例 5：混合場景（真實世界）

**檔案名稱**: `supplier_master_mixed.csv`

```csv
供應商代碼,供應商名稱,聯絡人,電話,Email,地址,產品類別,付款條件,交貨時間,狀態
SUP001,台灣電子有限公司,張小明,02-2123-4567,contact@taiwan.com,台北市中山區南京東路100號,電子零件,月結30天,3-5天,active
SUP002,優質塑膠股份有限公司,李美玲,(03) 456-7890,sales@quality.com,桃園市中壢區中正路200號,塑膠原料,月結45天,7-10天,active
,資料不完整公司,王大偉,04-2234-5678,info@incomplete.com,台中市西屯區工業區15路300號,五金配件,貨到付款,1-3天,active
SUP004,???,陳怡君,123,eco@test.com,高雄市前鎮區中華五路400號,包裝材料,月結60天,5-7天,active
SUP005,國際物流,林志豪,02 8765 4321,service@intl.com,新北市新莊區新莊路500號,物流服務,月結30天,即日,active
SUP006,測試供應商,黃小華,,test@example.com,台北市信義區信義路600號,---,月結30天,3-5天,active
SUP007,完整供應商,劉大成,+886-7-123-4567,complete@supplier.com,高雄市苓雅區中正路700號,化工原料,月結30天,5-7天,active
```

**預期結果**：
- 📊 總行數：7
- ✅ 有效資料：4（第 1, 2, 5, 7 筆）
- ❌ 錯誤資料：3（第 3, 4, 6 筆）
- 📈 成功率：57%

**錯誤詳情**：
- **第 3 筆**：`supplier_code 為必填欄位，不可為空`
- **第 4 筆**：
  - `supplier_name 包含異常內容：???`
  - `電話號碼格式不正確：123（至少需要 6 位數字）`
- **第 6 筆**：`product_category 包含異常內容：---`

**驗證點**：
- 真實世界的混合場景
- 多種錯誤類型並存
- 第 6 筆電話為空但其他有錯誤

---

## 測試案例 6：多餘欄位處理

**檔案名稱**: `supplier_master_extra_columns.csv`

```csv
供應商代碼,供應商名稱,聯絡人,電話,備註,內部編號,舊系統ID,建檔日期,建檔人員
SUP001,測試供應商A,張三,02-1234-5678,重要客戶,X001,OLD123,2024-01-15,Admin
SUP002,測試供應商B,李四,03-9876-5432,一般客戶,X002,OLD456,2024-01-16,User1
SUP003,測試供應商C,王五,04-2222-3333,VIP客戶,X003,OLD789,2024-01-17,User2
```

**預期結果**：
- ✅ 總行數：3
- ✅ 有效資料：3
- ✅ 錯誤資料：0
- ✅ 成功率：100%

**驗證點**：
- 多餘欄位（備註、內部編號、舊系統ID、建檔日期、建檔人員）會被自動忽略
- 不影響驗證結果
- validRows 中不會包含這些欄位

**實際寫入的資料（只有 schema 定義的欄位）**：
```javascript
[
  {
    supplier_code: "SUP001",
    supplier_name: "測試供應商A",
    contact_person: "張三",
    phone: "0212345678",
    // 其他 schema 欄位...
    // 「備註」等欄位不會出現
  }
]
```

---

## 測試案例 7：邊界情況

**檔案名稱**: `supplier_master_edge_cases.csv`

```csv
供應商代碼,供應商名稱,聯絡人,電話
SUP001,   正常但有前後空白   ,   張三   ,  02-1234-5678  
SUP002,      ,李四,03-9876-5432
SUP003,正常供應商,王五,      
"SUP004","引號包圍的名稱","引號包圍的人",04-2222-3333
SUP005,very long supplier name that might be truncated in some systems but should work fine,趙六,07-8888-9999
```

**預期結果**：
- 📊 總行數：5
- ✅ 有效資料：4（第 1, 3, 4, 5 筆）
- ❌ 錯誤資料：1（第 2 筆）
- 📈 成功率：80%

**錯誤詳情**：
- **第 2 筆**：`supplier_name 為必填欄位，不可為空`（只有空白會被 trim 後視為空）

**驗證點**：
- 前後空白會被 trim
- 只有空白的字串會被視為空值
- 引號包圍的內容會被正確解析
- 超長名稱可以正常處理
- 空白電話（第 3 筆）是有效的

---

## 測試案例 8：特殊字元與編碼

**檔案名稱**: `supplier_master_special_chars.csv`

```csv
供應商代碼,供應商名稱,聯絡人,電話,Email,地址
SUP001,台灣電子 (股) 公司,張小明,02-1234-5678,contact@test.com,台北市中山區
SUP002,A&B 供應商,John Smith,+886-3-456-7890,john@ab.com,Taipei City
SUP003,Société Française,Marie Dupont,03-321-4567,marie@societe.fr,Paris Branch
SUP004,测试供应商,李明,04-789-0123,test@cn.com,深圳市
SUP005,テスト会社,山田太郎,07-111-2222,yamada@test.jp,東京都
```

**預期結果**：
- ✅ 總行數：5
- ✅ 有效資料：5
- ✅ 錯誤資料：0
- ✅ 成功率：100%

**驗證點**：
- 括號、&、特殊字元可以正常處理
- 英文名稱可以正常處理
- 法文特殊字元可以正常處理
- 簡體中文可以正常處理
- 日文可以正常處理
- 多國語言支援

---

## 測試執行步驟

### 步驟 1：準備測試資料
將上述範例儲存為 CSV 檔案

### 步驟 2：上傳測試
1. 選擇「供應商主檔」類型
2. 上傳測試 CSV 檔案
3. 完成欄位映射

### 步驟 3：驗證結果
檢查驗證結果是否符合預期：
- 總行數
- 有效資料筆數
- 錯誤資料筆數
- 成功率
- 錯誤訊息詳情

### 步驟 4：檢查寫入
只有有效資料應該被寫入資料庫

---

## 自動化測試建議

```javascript
describe('Supplier Master Validation', () => {
  test('測試案例 1：正常資料全部通過', () => {
    const result = validateAndCleanRows(normalData, 'supplier_master');
    expect(result.stats.valid).toBe(5);
    expect(result.stats.invalid).toBe(0);
    expect(result.stats.successRate).toBe(100);
  });

  test('測試案例 2：必填欄位缺失', () => {
    const result = validateAndCleanRows(missingRequiredData, 'supplier_master');
    expect(result.stats.valid).toBe(2);
    expect(result.stats.invalid).toBe(3);
    expect(result.errorRows[0].errors).toContainEqual(
      expect.objectContaining({
        field: 'supplier_code',
        error: expect.stringContaining('必填欄位')
      })
    );
  });

  test('測試案例 3：異常文字內容', () => {
    const result = validateAndCleanRows(abnormalTextData, 'supplier_master');
    expect(result.errorRows).toContainEqual(
      expect.objectContaining({
        errors: expect.arrayContaining([
          expect.objectContaining({
            error: expect.stringContaining('異常內容：???')
          })
        ])
      })
    );
  });

  test('測試案例 4：電話格式問題', () => {
    const result = validateAndCleanRows(invalidPhoneData, 'supplier_master');
    expect(result.errorRows).toContainEqual(
      expect.objectContaining({
        errors: expect.arrayContaining([
          expect.objectContaining({
            field: 'phone',
            error: expect.stringContaining('至少需要 6 位數字')
          })
        ])
      })
    );
  });

  test('測試案例 6：多餘欄位處理', () => {
    const result = validateAndCleanRows(extraColumnsData, 'supplier_master');
    expect(result.validRows[0]).not.toHaveProperty('備註');
    expect(result.validRows[0]).not.toHaveProperty('內部編號');
    expect(result.validRows[0]).toHaveProperty('supplier_code');
    expect(result.validRows[0]).toHaveProperty('supplier_name');
  });
});
```

---

## 總結

這些測試案例涵蓋：

- ✅ **正常流程**：標準資料驗證
- ❌ **錯誤處理**：必填欄位、異常文字、格式錯誤
- 🧹 **資料清洗**：空白 trim、電話格式化
- 🗑️ **多餘欄位**：自動忽略
- 🌏 **國際化**：多語言支援
- 🔤 **邊界情況**：空白、引號、超長內容

確保系統的穩定性和資料品質！







