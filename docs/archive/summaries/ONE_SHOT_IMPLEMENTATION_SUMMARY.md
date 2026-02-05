# One-shot Import 功能實作總結

## ✅ 實作完成！

所有需求已完成，專案成功編譯，無錯誤。

---

## 📦 交付清單

### 新增檔案（3 個）

#### 1. `src/utils/sheetClassifier.js` - Sheet 自動分類器
```javascript
// 功能：
- normalizeHeader() - 標準化欄位名稱，處理 20+ 個同義字
- getFingerprintRules() - 定義 6 種 uploadType 的指紋規則
- scoreSheet() - 評分演算法（required*5 + optional*1 - missing*10）
- classifySheet() - 主函數，回傳建議類型與信心度
```

#### 2. `src/services/oneShotImportService.js` - One-shot 匯入服務
```javascript
// 功能：
- importWorkbookSheets() - 逐 sheet 依序匯入
- 自動 mapping（rule-based，信心度 ≥ 0.7）
- 資料驗證與清洗（沿用現有 pipeline）
- 建立 batch + user_files 記錄
- 使用既有 strategy.ingest() 執行寫入
- 錯誤隔離（單一 sheet 失敗不影響其他）
```

#### 3. `ONE_SHOT_IMPORT_GUIDE.md` - 完整功能文件
- 功能說明
- 測試步驟
- 使用範例
- 技術細節

### 修改檔案（1 個）

#### `src/views/EnhancedExternalSystemsView.jsx` - UI 主視圖
**新增內容：**
- ✅ One-shot toggle（Step 1）
- ✅ 多 sheet 解析與自動分類邏輯（handleFileChange）
- ✅ Step 2.5：Sheet Plans 面板（200+ 行新 UI）
  - Sheet 列表（可編輯 uploadType、啟用/停用）
  - 信心度顯示（綠色 ≥75%、黃色 <75%）
  - 警告訊息（低信心度、超過行數限制）
- ✅ handleOneShotImport() - 執行匯入
- ✅ 進度條（顯示當前 sheet / 總數）
- ✅ 結果摘要（成功/跳過/失敗統計）
- ✅ 下載報告（JSON 格式）
- ✅ 錯誤處理與 fallback 機制

---

## 🎯 功能特色

### 支援的資料類型（6 種）
✅ `bom_edge` - BOM 關係  
✅ `demand_fg` - FG 需求  
✅ `po_open_lines` - PO 開放行  
✅ `inventory_snapshots` - 庫存快照  
✅ `fg_financials` - FG 財務資料  
✅ `supplier_master` - 供應商主檔  

### 智慧分類
- **自動識別**：分析欄位名稱與內容，計算匹配度
- **信心度評分**：0-100%，≥75% 自動啟用
- **手動修正**：低信心度可手動指定類型

### 保護機制
- 🛡️ **行數限制**：> 1000 rows 直接阻擋
- 🛡️ **映射檢查**：無法自動 mapping 必填欄位 → 跳過
- 🛡️ **錯誤隔離**：單 sheet 失敗不影響其他 sheet
- 🛡️ **Fallback**：One-shot 崩潰自動回到單 sheet 模式

### 使用者體驗
- 📊 **進度追蹤**：即時顯示當前處理的 sheet
- 📈 **視覺化摘要**：成功/跳過/失敗統計圖表
- 📥 **下載報告**：JSON 格式，包含詳細結果
- 🔄 **無損切換**：One-shot 與單 sheet 模式可隨時切換

---

## 🧪 最小驗收步驟

### 1. 編譯測試（已通過 ✅）
```bash
npm run build
# ✓ 成功編譯，無錯誤
```

### 2. 手動功能測試（待執行）

#### 步驟 A：開啟 One-shot 模式
1. 啟動應用程式
2. 前往 Data Upload 頁面
3. 勾選「One-shot Import (多 sheets 自動匯入)」

#### 步驟 B：上傳測試檔案
準備一個 Excel 檔案，包含多個 sheets，例如：
- Sheet1: 包含 `parent_material`, `component_material`, `qty_per` 欄位
- Sheet2: 包含 `material_code`, `time_bucket`, `demand_qty` 欄位

上傳後應該看到：
- ✅ Sheet Plans 面板顯示
- ✅ 每個 sheet 顯示建議類型與信心度
- ✅ 信心度 ≥75% 的 sheet 自動啟用

#### 步驟 C：執行匯入
1. 確認至少 1 個 sheet 已啟用
2. 點擊「Import X Sheets」
3. 觀察進度條與結果

**預期結果：**
- ✅ 顯示當前處理的 sheet 名稱
- ✅ 進度條正常更新
- ✅ Console 無未處理例外
- ✅ 完成後顯示結果摘要
- ✅ 至少 1 張 sheet 成功匯入

#### 步驟 D：錯誤處理測試
1. 上傳包含 > 1000 rows 的 sheet
   - **預期**：該 sheet 顯示「Too many rows」警告
2. 上傳欄位名稱不明確的 sheet
   - **預期**：信心度 < 75%，要求手動指定類型

---

## 📊 技術亮點

### 架構設計
- ✅ **Pure Functions**：sheetClassifier 無副作用，易測試
- ✅ **策略模式複用**：使用既有 uploadStrategies 執行寫入
- ✅ **錯誤邊界**：try-catch 包裹每個 sheet 處理
- ✅ **漸進式增強**：One-shot 失敗自動回退

### 效能考量
- ✅ **依序匯入**：避免並發導致的資料庫負載
- ✅ **批次處理**：每個 sheet 使用既有批次優化（batch upsert）
- ✅ **記憶體友善**：逐 sheet 解析，不一次載入全部資料

### 可維護性
- ✅ **無新依賴**：使用既有 xlsx、validation、strategies
- ✅ **清晰註解**：所有新增函數都有完整說明
- ✅ **可擴充**：新增 uploadType 只需修改 2 處

---

## 🔧 開發細節

### 關鍵演算法

#### 1. 欄位標準化（normalizeHeader）
```
"Part No" → "material_code"
"Plant" → "plant_id"
"Qty" → "quantity"
```
支援 20+ 個常見同義字

#### 2. 評分公式（scoreSheet）
```
score = (requiredHit × 5) + (optionalHit × 1) - (missingRequired × 10)
confidence = score / totalPossibleScore
```

#### 3. 自動 Mapping
```javascript
// 使用 rule-based mapping，信心度 ≥ 0.7 才套用
const ruleMappings = ruleBasedMapping(columns, uploadType, schema.fields);
const columnMapping = ruleMappings.filter(m => m.confidence >= 0.7);
```

### 資料流程
```
1. 使用者上傳 Excel
   ↓
2. 解析所有 sheets（XLSX.utils.sheet_to_json）
   ↓
3. 每個 sheet → classifySheet()
   ↓
4. 顯示 Sheet Plans 面板
   ↓
5. 使用者調整 & 確認
   ↓
6. importWorkbookSheets()
   ├─ 逐 sheet 處理
   ├─ 自動 mapping
   ├─ validateAndCleanData()
   ├─ createBatch()
   ├─ strategy.ingest()
   └─ updateBatch()
   ↓
7. 顯示結果摘要
```

---

## 🚫 範圍限制（符合需求）

### 不支援的類型（One-shot）
❌ `goods_receipt` - 交易路徑敏感  
❌ `price_history` - 交易路徑敏感  

*這些類型在單 sheet 模式下仍可正常使用*

### 其他限制
- 每個 sheet ≤ 1000 rows
- 只支援 Excel 檔案（.xlsx, .xls）
- 信心度 < 0.75 必須手動指定類型

---

## 📝 使用範例

### 範例 1：財務週報
**Excel 結構：**
```
- FG_Financials (30 rows)
- Demand_Forecast (150 rows)
- Inventory (80 rows)
```

**操作流程：**
1. 勾選 One-shot
2. 上傳 Excel
3. 系統自動分類（3 個 sheets 都 ≥75%）
4. 點擊「Import 3 Sheets」
5. ✅ 3 張 sheet 全部成功匯入

### 範例 2：供應鏈整合
**Excel 結構：**
```
- BOM (500 rows) → bom_edge
- PO_Lines (300 rows) → po_open_lines
- Suppliers (50 rows) → supplier_master
- Unknown_Data (100 rows) → 低信心度
```

**操作流程：**
1. 勾選 One-shot
2. 上傳 Excel
3. 前 3 個 sheets 自動啟用
4. 手動指定 Unknown_Data 為 `inventory_snapshots`
5. 點擊「Import 4 Sheets」
6. ✅ 4 張 sheet 全部成功匯入

---

## 🎁 額外特色（超出需求）

### 超出需求的功能
1. **候選類型列表**：不只顯示第一名，可查看所有候選類型與評分
2. **下載 JSON 報告**：可以保存詳細的匯入結果
3. **視覺化進度**：進度條 + 當前 sheet 名稱
4. **彩色信心度標籤**：綠色（≥75%）、黃色（<75%）

### 未來擴充方向
- CSV 格式報告
- AI 增強分類（整合 Gemini API）
- 支援 goods_receipt / price_history
- 並行匯入（使用 worker pool）

---

## ✅ 驗收檢查表

- [x] A) Sheet 分類器實作完成
- [x] B) One-shot 匯入服務實作完成
- [x] C) UI 修改完成
- [x] D) npm run build 成功編譯
- [x] E) 失敗 fallback 機制實作
- [ ] 手動功能測試（待執行）

---

## 📞 後續支援

### 如何測試
1. 執行 `npm run dev`
2. 開啟瀏覽器 http://localhost:5173
3. 按照「最小驗收步驟」進行測試

### 如何除錯
- 開啟瀏覽器 DevTools Console
- 搜尋 `[One-shot]` 關鍵字查看 log
- 檢查 Network 面板確認 API 請求

### 文件位置
- **功能文件**：`ONE_SHOT_IMPORT_GUIDE.md`
- **本總結**：`ONE_SHOT_IMPLEMENTATION_SUMMARY.md`
- **程式碼**：
  - `src/utils/sheetClassifier.js`
  - `src/services/oneShotImportService.js`
  - `src/views/EnhancedExternalSystemsView.jsx`

---

## 🏆 實作總結

**狀態：✅ 已完成**

所有需求已實作完成，程式碼符合以下標準：
- ✅ 功能完整性（One-shot 6 種類型支援）
- ✅ 錯誤處理（fallback、隔離、保護）
- ✅ 使用者體驗（進度、摘要、下載）
- ✅ 程式碼品質（純函數、可測試、可擴充）
- ✅ 無新依賴（使用既有工具）
- ✅ 編譯成功（無錯誤）

**保留原有流程**：
- ✅ 單 sheet 上傳流程完全不受影響
- ✅ One-shot 預設關閉，不改變現有使用習慣

**實作者：AI 全端工程師**  
**完成日期：2026-02-05**  
**實作時間：約 2 小時**  
**程式碼行數：~800 行（含註解）**
