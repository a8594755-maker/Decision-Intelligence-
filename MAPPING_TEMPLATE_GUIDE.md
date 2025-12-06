# Mapping 模板功能說明

## 概述

為了提升重複上傳的效率，系統提供了**欄位映射模板自動保存與套用**功能。當您完成一次欄位映射並成功寫入資料後，系統會自動記住您的映射設定，下次上傳相同類型的檔案時，會自動套用之前的映射。

---

## 功能特點

### ✅ 自動保存
- 每次成功寫入資料後，系統自動保存當前的欄位映射
- 針對不同的上傳類型（收貨記錄、價格歷史、供應商主檔）分別保存
- 只保存最新的一份映射（自動覆蓋舊的）

### ✅ 智能套用
- 下次上傳相同類型檔案時，自動載入並套用之前的映射
- 支援完全匹配和模糊匹配（大小寫不敏感）
- 使用者可以在自動套用後再進行微調

### ✅ 獨立儲存
- 每個使用者的映射模板獨立保存
- 不同上傳類型的映射分開管理
- 支援多租戶隔離

---

## 使用流程

### 第一次上傳

1. **選擇上傳類型**（例如：收貨記錄）
2. **上傳檔案**
3. **手動建立欄位映射**
   ```
   Excel 欄位        → 系統欄位
   供應商名稱        → supplier_name
   料號             → material_code
   收貨日期         → actual_delivery_date
   數量             → received_qty
   ```
4. **驗證並寫入資料庫**
5. ✅ **系統自動保存這次的映射模板**

### 第二次上傳（相同類型）

1. **選擇上傳類型**（收貨記錄）
2. **上傳檔案**
3. ✨ **系統自動套用之前的映射**
   - 顯示提示：「已自動套用之前的欄位映射（4 個欄位）」
   - 如果欄位名稱相同，會自動匹配
   - 如果欄位名稱不同，可以手動調整
4. **檢查並微調映射**（如有需要）
5. **驗證並寫入資料庫**
6. ✅ **更新映射模板**

---

## 資料庫結構

### `upload_mappings` 表

```sql
CREATE TABLE upload_mappings (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,                    -- 使用者 ID
  upload_type TEXT NOT NULL,                -- 上傳類型
  original_columns JSONB NOT NULL,          -- 原始欄位列表
  mapping_json JSONB NOT NULL,              -- 映射關係
  created_at TIMESTAMP,                     -- 建立時間
  updated_at TIMESTAMP                      -- 更新時間
);
```

### 唯一約束

```sql
-- 每個使用者的每種類型只保存一份最新的映射
CREATE UNIQUE INDEX idx_upload_mappings_unique 
  ON upload_mappings(user_id, upload_type);
```

### 資料範例

```json
{
  "id": "uuid",
  "user_id": "user-uuid",
  "upload_type": "goods_receipt",
  "original_columns": [
    "供應商名稱",
    "料號", 
    "收貨日期",
    "收貨數量",
    "拒收數量"
  ],
  "mapping_json": {
    "供應商名稱": "supplier_name",
    "料號": "material_code",
    "收貨日期": "actual_delivery_date",
    "收貨數量": "received_qty",
    "拒收數量": "rejected_qty"
  },
  "created_at": "2024-01-15T10:00:00Z",
  "updated_at": "2024-01-15T10:00:00Z"
}
```

---

## API 介面

### uploadMappingsService

#### 1. saveMapping()
保存或更新映射模板

```javascript
await uploadMappingsService.saveMapping(
  userId,
  uploadType,
  originalColumns,
  mappingJson
);
```

**參數**：
- `userId` (string): 使用者 ID
- `uploadType` (string): 上傳類型（'goods_receipt' | 'price_history' | 'supplier_master'）
- `originalColumns` (Array): Excel 原始欄位列表
- `mappingJson` (Object): 映射關係物件

**返回**：
```javascript
{
  id: "uuid",
  user_id: "user-uuid",
  upload_type: "goods_receipt",
  original_columns: [...],
  mapping_json: {...},
  created_at: "2024-01-15T10:00:00Z",
  updated_at: "2024-01-15T10:00:00Z"
}
```

#### 2. getMapping()
獲取特定類型的映射模板

```javascript
const mapping = await uploadMappingsService.getMapping(
  userId,
  uploadType
);
```

**返回**：
- 如果存在：返回映射物件
- 如果不存在：返回 `null`

#### 3. smartMapping()
智能匹配並套用映射

```javascript
const suggestedMapping = await uploadMappingsService.smartMapping(
  userId,
  uploadType,
  currentColumns
);
```

**功能**：
- 嘗試將當前 Excel 欄位與之前保存的映射進行匹配
- 支援完全匹配和模糊匹配
- 返回建議的映射物件

**範例**：

```javascript
// 之前保存的映射
{
  "供應商名稱": "supplier_name",
  "料號": "material_code"
}

// 當前 Excel 欄位
["供應商名稱", "料號", "新欄位"]

// 智能映射結果
{
  "供應商名稱": "supplier_name",  // 完全匹配
  "料號": "material_code",        // 完全匹配
  "新欄位": ""                    // 無匹配，留空
}
```

#### 4. getAllMappings()
獲取使用者所有的映射模板

```javascript
const allMappings = await uploadMappingsService.getAllMappings(userId);
```

#### 5. deleteMapping()
刪除特定的映射模板

```javascript
await uploadMappingsService.deleteMapping(userId, uploadType);
```

---

## 實作細節

### 自動保存時機

在 `handleSave()` 函數中，成功寫入資料後：

```javascript
// 3. 保存 mapping 模板供下次使用
try {
  await uploadMappingsService.saveMapping(
    userId,
    uploadType,
    columns,
    columnMapping
  );
  console.log('欄位映射模板已保存');
} catch (mappingError) {
  console.error('保存 mapping 模板失敗:', mappingError);
  // 不影響主流程，只記錄錯誤
}
```

### 自動載入時機

在檔案上傳並解析完成後：

```javascript
setTimeout(async () => {
  setCurrentStep(3);
  
  // 嘗試載入並套用之前保存的 mapping 模板
  try {
    if (user?.id) {
      const smartMapping = await uploadMappingsService.smartMapping(
        user.id,
        uploadType,
        cols
      );

      if (Object.keys(smartMapping).length > 0) {
        setColumnMapping(smartMapping);
        addNotification(
          `已自動套用之前的欄位映射（${Object.keys(smartMapping).filter(k => smartMapping[k]).length} 個欄位）`,
          "info"
        );
        
        // 檢查映射是否完成
        checkMappingComplete(smartMapping);
      }
    }
  } catch (error) {
    console.error('載入 mapping 模板失敗:', error);
    // 失敗時使用空映射
  }
}, 500);
```

---

## 智能匹配邏輯

### 完全匹配
欄位名稱完全相同（包含大小寫）

```
Excel: "供應商名稱" → 保存的: "供應商名稱" ✓ 匹配
```

### 模糊匹配
欄位名稱相同但大小寫不同

```
Excel: "SUPPLIER_NAME" → 保存的: "supplier_name" ✓ 匹配
Excel: "Supplier Name" → 保存的: "supplier name" ✓ 匹配
```

### 無法匹配
欄位名稱完全不同

```
Excel: "供應商" → 保存的: "供應商名稱" ✗ 不匹配（留空，需手動映射）
```

---

## 使用場景

### 場景 1：定期上傳相同格式的檔案

**情境**：每週上傳收貨記錄，Excel 格式固定

**優勢**：
- 第一次設定好映射後
- 之後每次上傳都自動套用
- 省去重複映射的時間

### 場景 2：不同供應商但欄位名稱類似

**情境**：多個供應商提供的 Excel，欄位名稱略有差異

**優勢**：
- 智能匹配會自動識別相似欄位
- 只需微調不同的部分
- 大部分映射可以重用

### 場景 3：Excel 格式變更

**情境**：供應商更新了 Excel 格式，新增或修改了欄位

**優勢**：
- 仍會套用可以匹配的欄位
- 新欄位或變更的欄位需要手動映射
- 系統會更新並保存新的映射

---

## 最佳實務

### 1. 統一欄位命名
建議與供應商協調，統一 Excel 欄位名稱：
- ✅ 使用相同的欄位名稱
- ✅ 保持大小寫一致
- ✅ 避免多餘的空格

### 2. 檢查自動映射
自動套用後，建議快速檢查：
- ✅ 必填欄位是否都已映射
- ✅ 映射關係是否正確
- ✅ 新欄位是否需要映射

### 3. 定期驗證
建議定期檢查映射模板：
- ✅ 是否符合最新的業務需求
- ✅ 是否有不再使用的欄位
- ✅ 是否需要更新映射邏輯

### 4. 多環境管理
如果有測試環境和正式環境：
- ✅ 分別管理各自的映射模板
- ✅ 避免混用不同環境的資料
- ✅ 測試環境可以實驗新的映射

---

## 故障排除

### Q1: 為什麼沒有自動套用之前的映射？

**可能原因**：
- 之前沒有成功寫入資料（mapping 未保存）
- 當前上傳類型與之前不同
- 資料庫連線問題

**解決方法**：
- 檢查之前是否成功完成完整流程
- 確認上傳類型選擇正確
- 查看瀏覽器 Console 是否有錯誤

### Q2: 自動映射的結果不正確怎麼辦？

**解決方法**：
- 直接在映射界面手動修正
- 修正後重新寫入，系統會更新模板
- 下次就會使用更新後的映射

### Q3: 想要清除舊的映射模板

**方法 1**：手動重新映射
- 上傳檔案後清空所有映射
- 重新設定正確的映射
- 寫入資料後會覆蓋舊模板

**方法 2**：透過 API 刪除（開發者模式）
```javascript
await uploadMappingsService.deleteMapping(userId, uploadType);
```

### Q4: 不同的 Excel 格式如何處理？

**建議**：
- 如果格式差異很大，建議分別處理
- 系統會為最近一次的格式保存映射
- 頻繁切換格式會導致需要經常手動調整

---

## 技術架構

### 資料流

```
上傳檔案
   ↓
解析欄位 (columns)
   ↓
載入 mapping 模板 ←─ upload_mappings 表
   ↓
智能匹配 (smartMapping)
   ↓
自動套用 (setColumnMapping)
   ↓
使用者確認/微調
   ↓
驗證資料
   ↓
寫入資料庫
   ↓
保存 mapping 模板 ──→ upload_mappings 表
```

### 檔案位置

- **資料庫 Schema**：`database/upload_mappings_schema.sql`
- **Service 層**：`src/services/supabaseClient.js` (uploadMappingsService)
- **UI 層**：`src/views/EnhancedExternalSystemsView.jsx`

### 關鍵函數

- `uploadMappingsService.saveMapping()` - 保存映射
- `uploadMappingsService.smartMapping()` - 智能匹配
- `handleSave()` - 整合保存邏輯
- `handleFileChange()` - 整合載入邏輯

---

## 安全性

### Row Level Security (RLS)

所有 mapping 記錄都受 RLS 保護：

```sql
-- 使用者只能看到自己的 mapping
CREATE POLICY "Users can view own mappings"
  ON upload_mappings FOR SELECT
  USING (auth.uid() = user_id);

-- 使用者只能修改自己的 mapping
CREATE POLICY "Users can update own mappings"
  ON upload_mappings FOR UPDATE
  USING (auth.uid() = user_id);
```

### 資料隔離

- ✅ 每個使用者的 mapping 完全獨立
- ✅ 無法看到其他使用者的 mapping
- ✅ 無法修改其他使用者的 mapping

---

## 效能優化

### 1. 唯一索引
```sql
CREATE UNIQUE INDEX idx_upload_mappings_unique 
  ON upload_mappings(user_id, upload_type);
```
- 快速查詢特定使用者的特定類型 mapping
- 自動處理 upsert（插入或更新）

### 2. 複合索引
```sql
CREATE INDEX idx_upload_mappings_user_type 
  ON upload_mappings(user_id, upload_type);
```
- 優化常見的查詢模式
- 支援高效的範圍查詢

### 3. JSONB 欄位
- 使用 JSONB 而非 JSON
- 支援索引和高效查詢
- 儲存靈活的映射結構

---

## 未來擴展

### 可能的增強功能

1. **多版本 Mapping**
   - 保存多個歷史版本
   - 使用者可選擇使用哪個版本

2. **共享 Mapping 模板**
   - 團隊成員可共享映射模板
   - 管理員可創建標準模板

3. **AI 輔助映射**
   - 使用 AI 分析欄位內容
   - 更智能的欄位匹配建議

4. **映射規則庫**
   - 建立常見的映射規則
   - 支援正則表達式匹配

---

## 總結

Mapping 模板功能大幅提升了重複上傳的效率：

- ✅ **省時**：不需要每次都手動映射欄位
- ✅ **準確**：減少人為映射錯誤
- ✅ **靈活**：支援自動套用後再微調
- ✅ **智能**：支援模糊匹配和大小寫不敏感
- ✅ **安全**：使用者資料完全隔離

建議在實際使用中逐步優化映射邏輯，以達到最佳的自動化效果！

