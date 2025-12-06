# 匯入歷史 & 撤銷功能使用指南

## 功能概述

匯入歷史功能允許您追蹤所有資料上傳操作，並提供批次撤銷能力。每次資料上傳都會被記錄為一個匯入批次，您可以隨時查看、預覽或撤銷這些批次。

## 主要特性

### 1. 批次追蹤
- 每次上傳自動建立匯入批次記錄
- 記錄檔案名稱、上傳類型、目標表格
- 追蹤成功/失敗行數和狀態

### 2. 歷史查詢
- 查看所有匯入記錄
- 按狀態、類型篩選
- 搜尋檔案名稱
- 排序功能（日期升序/降序）

### 3. 資料預覽
- 點擊「眼睛」圖示預覽批次資料
- 顯示前 50 筆記錄
- 查看實際匯入的資料內容

### 4. 批次撤銷
- 單一批次撤銷
- 多選批次批量撤銷
- 撤銷後資料從資料庫永久刪除
- 批次狀態更新為「已撤銷」

## 資料庫架構

### import_batches 表格

```sql
CREATE TABLE import_batches (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  upload_type TEXT,           -- 上傳類型
  filename TEXT,              -- 檔案名稱
  target_table TEXT,          -- 目標表格
  total_rows INTEGER,         -- 總行數
  success_rows INTEGER,       -- 成功行數
  error_rows INTEGER,         -- 錯誤行數
  status TEXT,                -- pending/completed/undone
  created_at TIMESTAMPTZ,     -- 建立時間
  undone_at TIMESTAMPTZ,      -- 撤銷時間
  metadata JSONB              -- 額外元數據
);
```

### 業務表格更新

所有業務表格（suppliers, goods_receipts, price_history, materials）都新增了：
- `batch_id` - 關聯到 import_batches.id
- `user_id` - 使用者識別（如果尚未存在）

## 使用流程

### 1. 資料上傳（自動追蹤）

當您在「External Systems」上傳資料時：

1. 選擇上傳類型
2. 上傳檔案
3. 完成欄位映射
4. 驗證資料
5. **點擊「Save to Database」**

系統會自動：
- 建立 import_batches 記錄（狀態：pending）
- 插入所有有效資料（帶有 batch_id）
- 更新批次統計（成功/失敗行數）
- 將狀態更新為 completed

### 2. 查看匯入歷史

1. 從主選單選擇「Import History」
2. 查看所有匯入記錄列表
3. 使用篩選器：
   - **狀態篩選**：所有狀態 / 已完成 / 已撤銷 / 處理中
   - **類型篩選**：所有類型 / 供應商主檔 / 收貨記錄 / 價格歷史
   - **搜尋**：輸入檔案名稱或類型關鍵字

### 3. 預覽批次資料

1. 在匯入歷史列表中找到目標批次
2. 點擊「眼睛」圖示
3. 查看該批次的前 50 筆資料
4. 確認批次資訊（類型、目標表格、成功筆數等）

### 4. 撤銷批次

#### 單一批次撤銷：
1. 在匯入歷史列表中找到目標批次
2. 點擊「撤銷」圖示（僅「已完成」狀態可撤銷）
3. 確認撤銷操作
4. 系統會：
   - 刪除該批次的所有資料
   - 更新批次狀態為「已撤銷」
   - 記錄撤銷時間

#### 批量撤銷：
1. 勾選多個「已完成」狀態的批次
2. 點擊頂部的「批量撤銷」按鈕
3. 確認撤銷操作
4. 系統會依次處理所有選中的批次

### 5. 刪除記錄

對於「已撤銷」的批次，您可以：
1. 點擊「垃圾桶」圖示
2. 確認刪除
3. **注意**：這只會刪除匯入記錄，不會刪除實際資料（因為已經撤銷過了）

## 狀態說明

| 狀態 | 說明 | 可執行操作 |
|------|------|-----------|
| **pending** | 處理中 | 等待完成 |
| **completed** | 已完成 | 預覽、撤銷 |
| **undone** | 已撤銷 | 預覽、刪除記錄 |

## 注意事項

### ⚠️ 重要警告

1. **撤銷操作無法復原**
   - 撤銷會永久刪除該批次的所有資料
   - 請在撤銷前確認批次內容

2. **關聯資料影響**
   - 撤銷供應商批次時，相關的收貨記錄和價格歷史不會被刪除
   - 建議按照相反的順序撤銷（先撤銷收貨/價格，再撤銷供應商）

3. **批次完整性**
   - 每個批次是獨立的
   - 同一檔案多次上傳會產生多個批次
   - 每個批次可以獨立撤銷

### 💡 最佳實踐

1. **定期檢查匯入歷史**
   - 確認資料正確匯入
   - 及時發現和修正錯誤

2. **使用預覽功能**
   - 在撤銷前先預覽資料
   - 確認要撤銷的批次內容

3. **批量操作謹慎使用**
   - 批量撤銷前仔細檢查選中的批次
   - 確保不會誤刪重要資料

4. **保留匯入記錄**
   - 建議不要刪除已撤銷的記錄
   - 保留作為審計追蹤

## API 參考

### importBatchesService

```javascript
import { importBatchesService } from './services/importHistoryService';

// 建立批次
const batch = await importBatchesService.createBatch(userId, {
  uploadType: 'goods_receipt',
  filename: 'data.xlsx',
  targetTable: 'goods_receipts',
  totalRows: 100
});

// 更新批次
await importBatchesService.updateBatch(batchId, {
  successRows: 95,
  errorRows: 5,
  status: 'completed'
});

// 獲取所有批次
const batches = await importBatchesService.getAllBatches(userId);

// 預覽批次資料
const data = await importBatchesService.getBatchData(
  batchId, 
  'goods_receipts', 
  50
);

// 撤銷批次
const result = await importBatchesService.undoBatch(batchId, userId);

// 批量撤銷
const result = await importBatchesService.undoMultipleBatches(
  [batchId1, batchId2], 
  userId
);
```

## 資料庫函數

### undo_import_batch

撤銷單一匯入批次：

```sql
SELECT undo_import_batch(
  p_batch_id := '批次UUID',
  p_user_id := '使用者UUID'
);
```

### undo_multiple_batches

批量撤銷多個批次：

```sql
SELECT undo_multiple_batches(
  p_batch_ids := ARRAY['批次UUID1', '批次UUID2'],
  p_user_id := '使用者UUID'
);
```

## 故障排除

### 問題：撤銷失敗

**可能原因**：
- 批次不存在或已被撤銷
- 權限不足（不是批次擁有者）
- 資料庫連線問題

**解決方案**：
1. 確認批次狀態為「已完成」
2. 確認登入的使用者是批次擁有者
3. 檢查網路連線和資料庫狀態

### 問題：預覽資料為空

**可能原因**：
- 批次已被撤銷
- 目標表格資料已被手動刪除
- 批次 ID 不正確

**解決方案**：
1. 確認批次狀態
2. 檢查目標表格是否有資料
3. 重新整理頁面

### 問題：無法看到匯入歷史

**可能原因**：
- 尚未執行資料庫遷移
- RLS 政策未正確設定
- 使用者未登入

**解決方案**：
1. 執行 `database/import_batches_schema.sql`
2. 確認 RLS 政策已啟用
3. 重新登入

## 更新日誌

### Version 1.0.0 (2025-12-06)
- ✅ 初始版本發布
- ✅ 批次追蹤功能
- ✅ 匯入歷史查詢
- ✅ 資料預覽
- ✅ 單一/批量撤銷
- ✅ 篩選和搜尋功能

## 支援

如有問題或建議，請聯繫開發團隊。

