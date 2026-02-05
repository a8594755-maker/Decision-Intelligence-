# Quick Test Guide - 快速測試指南

## 🚀 快速開始：3 分鐘測試新上傳功能

---

## 📋 前置準備

1. ✅ 確認系統已啟動（`npm run dev`）
2. ✅ 確認已登入系統
3. ✅ 確認 `templates/` 目錄中有測試檔案

---

## 🧪 測試 1：Open PO Lines（2 分鐘）

### Step 1: 選擇上傳類型
```
1. 前往 Data Upload 頁面
2. 下拉選單選擇：📦 Open PO Lines
```

### Step 2: 上傳檔案
```
1. 點擊「Select File to Upload」
2. 選擇：templates/po_open_lines.xlsx
3. 等待顯示：Loaded 5 rows ✓
```

### Step 3: AI 自動映射（推薦）
```
1. 點擊「AI Field Suggestion」按鈕
2. 等待 AI 分析（約 3-5 秒）
3. 確認顯示：✓ Mapping Complete
```

### Step 4: 驗證資料
```
1. 點擊「Next: Validate Data」
2. 確認顯示：
   - Total Rows: 5
   - Valid Data: 5 ✅
   - Error Data: 0
   - Success Rate: 100%
```

### Step 5: 保存
```
1. 點擊「Save to Database」
2. 等待顯示：Successfully saved 5 rows ✓
```

### Step 6: 驗證批次
```
1. 前往「Import History」頁面
2. 確認最新批次：
   - Type: po_open_lines
   - Status: completed ✓
   - Success: 5
```

**✅ 測試完成！**

---

## 🧪 測試 2：Inventory Snapshots（1.5 分鐘）

### 快速步驟
```
1. Data Upload → 選擇：📊 Inventory Snapshots
2. 上傳：templates/inventory_snapshots.xlsx
3. AI Field Suggestion → 自動映射
4. Next: Validate Data → 確認 5 筆 valid
5. Save to Database → 成功 ✓
6. Import History → 確認批次 ✓
```

**✅ 測試完成！**

---

## 🧪 測試 3：FG Financials（1.5 分鐘）

### 快速步驟
```
1. Data Upload → 選擇：💵 FG Financials
2. 上傳：templates/fg_financials.xlsx
3. AI Field Suggestion → 自動映射
4. Next: Validate Data → 確認 6 筆 valid
5. Save to Database → 成功 ✓
6. Import History → 確認批次 ✓
```

**✅ 測試完成！**

---

## 📊 快速驗證清單

### UI 檢查
- [ ] 下拉選單顯示 3 個新上傳類型
- [ ] 每個類型有圖示、標籤、描述
- [ ] Required Fields 正確顯示

### 上傳流程
- [ ] 檔案上傳成功（5-6 筆資料）
- [ ] AI 映射正常工作
- [ ] 驗證結果正確顯示
- [ ] 成功訊息顯示

### 資料庫
- [ ] 資料成功寫入
- [ ] import_batches 記錄建立
- [ ] batch_id 正確關聯
- [ ] Import History 顯示批次

---

## 🎯 完整測試流程圖

```
Step 1: 選擇上傳類型
   ↓
Step 2: 上傳檔案
   ↓
Step 3: AI 自動映射（或手動）
   ↓
Step 4: 驗證資料
   ↓
Step 5: 保存到資料庫
   ↓
Step 6: 查看 Import History
```

**總耗時：約 5-7 分鐘（3 個測試）**

---

## 🔍 快速查詢 SQL

### 查看上傳的資料

```sql
-- PO Open Lines
SELECT * FROM po_open_lines 
ORDER BY created_at DESC 
LIMIT 10;

-- Inventory Snapshots
SELECT * FROM inventory_snapshots 
ORDER BY created_at DESC 
LIMIT 10;

-- FG Financials
SELECT * FROM fg_financials 
ORDER BY created_at DESC 
LIMIT 10;

-- Import Batches
SELECT * FROM import_batches 
WHERE upload_type IN ('po_open_lines', 'inventory_snapshots', 'fg_financials')
ORDER BY created_at DESC 
LIMIT 10;
```

---

## ⚠️ 常見問題

### Q1: AI 映射失敗？
```
A: 使用手動映射
   - 點擊每個下拉選單
   - 選擇對應的系統欄位
```

### Q2: 驗證錯誤？
```
A: 檢查錯誤訊息
   - 查看 Error Data Details
   - 修正原始檔案
   - 重新上傳
```

### Q3: 保存失敗？
```
A: 檢查 Console
   - F12 打開開發者工具
   - 查看 Console 錯誤訊息
   - 檢查網路連線
```

### Q4: Import History 看不到批次？
```
A: 重新整理頁面
   - 點擊「Refresh」按鈕
   - 或重新進入頁面
```

---

## 🎉 測試完成確認

完成所有測試後，確認：

- ✅ 3 個上傳類型都能正常上傳
- ✅ AI 映射功能正常
- ✅ 資料驗證正確
- ✅ 資料成功寫入資料庫
- ✅ Import History 顯示批次
- ✅ 成功訊息正確顯示

**🎊 恭喜！所有功能測試通過！**

---

## 📚 詳細文件

如需更多資訊，請參考：
- `DATA_UPLOAD_UI_IMPLEMENTATION.md` - 完整實作說明
- `SUPABASE_SERVICES_IMPLEMENTATION.md` - Service Layer 文件
- `NEW_TEMPLATES_GUIDE.md` - 模板使用指南

---

**版本：** 1.0  
**日期：** 2026-01-31
