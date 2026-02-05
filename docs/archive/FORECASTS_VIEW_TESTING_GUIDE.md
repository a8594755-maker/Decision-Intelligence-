# Forecasts View 測試驗收指南

## 🎯 重構目標達成

本次重構將 BOM Explosion 功能產品化，建立了獨立的 Forecasts 頁面作為主要入口，實現了「輸入」、「運算」、「呈現」三者的職責分離。

---

## ✅ 修改清單

### 1. 新增檔案
- **`src/views/ForecastsView.jsx`** - 新的 Forecasts 主頁面
  - Run 區塊（執行 BOM Explosion）
  - Batch Selector（選擇最近 10 筆批次）
  - Results Tab（component_demand 資料表）
  - Trace Tab（component_demand_trace 資料表）
  - 分頁、篩選、CSV 匯出功能

### 2. 修改檔案

#### **`src/services/supabaseClient.js`**
- 新增 `componentDemandService.getComponentDemandsByBatch()` 方法
- 新增 `componentDemandTraceService.getTracesByBatch()` 方法

#### **`src/App.jsx`**
- 新增 `ForecastsView` import
- 新增 `forecasts` 路由（case 'forecasts'）
- 新增 Planning 選單類別（包含 Forecasts 選項）
- 傳遞 `setView` prop 給 `EnhancedExternalSystemsView` 和 `ImportHistoryView`

#### **`src/views/EnhancedExternalSystemsView.jsx`**
- **移除**：BOM Explosion 相關 state（8 個 state 變數）
- **移除**：BOM Explosion 相關 imports（`executeBomExplosion`）
- **移除**：`handleBomExplosion()` 函數（~100 行）
- **移除**：BOM Explosion UI 區塊（~230 行）
- **新增**：CTA Card（在 currentStep=1 時，針對 demand_fg/bom_edge 上傳顯示「前往 Forecasts」提示）
- **新增**：上傳成功後的 CTA 通知（引導用戶前往 Forecasts）

#### **`src/views/ImportHistoryView.jsx`**
- **新增**：「Open in Forecasts」按鈕（針對 bom_explosion 批次）
- **新增**：錯誤詳情顯示（顯示 `batch.metadata.error`）
- **接收**：`setView` prop（用於導航到 Forecasts）

---

## 🧪 測試驗收步驟

### 前置準備
1. 確保資料庫 schema 正確（執行 `database/comprehensive_fix.sql`）
2. 確認 `component_demand` 表有 `uq_component_demand_key` 唯一約束
3. 確認 `component_demand_trace` 表有 `trace_meta` JSONB 欄位

### 測試流程

#### **Step 1: 上傳輸入資料**
1. 前往 **Data Upload** 頁面
2. 上傳 `bom_edge.csv` 或 `bom_edge.xlsx`
   - 應顯示成功通知
   - 應顯示 CTA：「前往 Forecasts 執行 BOM Explosion 計算」
3. 上傳 `demand_fg.csv` 或 `demand_fg.xlsx`
   - 應顯示成功通知
   - 應顯示 CTA：「前往 Forecasts 執行 BOM Explosion 計算」

**驗收點：**
- ✅ Data Upload 頁面不再有「BOM Explosion 計算」區塊
- ✅ 上傳成功後顯示 CTA 引導至 Forecasts
- ✅ 可點擊 CTA 按鈕前往 Forecasts

---

#### **Step 2: 執行 BOM Explosion**
1. 點擊導航選單的 **Planning > Forecasts**
2. 在「執行 BOM Explosion」區塊中：
   - Plant ID：留空（或輸入特定工廠代碼）
   - Time Buckets：輸入 `2026-W02`（或留空）
3. 點擊 **Run BOM Explosion** 按鈕

**驗收點：**
- ✅ 顯示 loading 狀態（按鈕顯示「計算中...」）
- ✅ 成功後顯示 KPI 卡片：
  - Component 需求數量 >0
  - 追溯記錄數量 >0
  - 錯誤/警告數量
  - 成功狀態 ✓
- ✅ 顯示 batch_id
- ✅ Batch Selector 自動更新，新批次被選中

---

#### **Step 3: 查看結果（Results Tab）**
1. 確認自動切換到新建立的批次
2. 在 **Forecast Results** tab：
   - 應顯示 component_demand 資料
   - 欄位至少包含：material_code, plant_id, time_bucket, demand_qty, uom, created_at

3. 測試篩選功能：
   - 點擊「顯示篩選」
   - 輸入 Material Code（部分匹配）
   - 應即時篩選資料

4. 測試分頁：
   - 確認顯示「Page 1 / N」
   - 點擊下一頁/上一頁按鈕
   - 確認分頁正常運作

5. 測試 CSV 匯出：
   - 點擊「Download CSV」按鈕
   - 應下載 CSV 檔案（檔名包含 batch_id 和日期）
   - 開啟 CSV 確認資料正確

**驗收點：**
- ✅ 資料正確顯示
- ✅ 篩選功能正常
- ✅ 分頁功能正常（每頁 100 筆）
- ✅ CSV 匯出成功

---

#### **Step 4: 查看追溯（Trace Tab）**
1. 切換到 **Trace** tab
2. 應顯示 component_demand_trace 資料
3. 欄位至少包含：
   - bom_level
   - qty_multiplier
   - trace_meta（展開顯示 path, fg_material_code, component_material_code, fg_qty, component_qty）
   - created_at

4. 測試篩選功能：
   - BOM Level：輸入 `1`
   - FG Material：輸入料號
   - Component Material：輸入料號
   - 應即時篩選資料

5. 確認 trace_meta 欄位正確展開顯示：
   - Path: JSON 陣列格式
   - FG: 成品料號
   - Comp: 零件料號
   - FG Qty / Comp Qty

**驗收點：**
- ✅ Trace 資料正確顯示
- ✅ trace_meta JSONB 欄位正確解析和顯示
- ✅ 篩選功能正常
- ✅ 分頁功能正常

---

#### **Step 5: 切換批次**
1. 在 Batch Selector 中點擊不同的批次
2. 確認 Results 和 Trace 資料自動切換
3. 篩選條件應自動重置

**驗收點：**
- ✅ 切換批次時資料正確更新
- ✅ 篩選條件自動清空
- ✅ 頁碼重置為第 1 頁

---

#### **Step 6: Import History 整合**
1. 前往 **Import History** 頁面
2. 找到 target_table='bom_explosion' 的批次
3. 確認顯示：
   - 紫色「Open in Forecasts」按鈕（TrendingUp icon）
   - 綠色「View Data」按鈕
   - 藍色「Preview」按鈕
   - 紅色「Undo」按鈕

4. 點擊「Open in Forecasts」按鈕：
   - 應導航到 Forecasts 頁面
   - 應自動選中對應的批次（理想情況，目前未實現跨頁面 state 傳遞）

5. 確認錯誤顯示：
   - 如果有 batch.metadata.error，應在 success_rows/error_rows 下方顯示
   - 格式：「錯誤: {error message}」

**驗收點：**
- ✅「Open in Forecasts」按鈕顯示（僅針對 bom_explosion 批次）
- ✅ 點擊後正確導航到 Forecasts
- ✅ 錯誤詳情正確顯示

---

#### **Step 7: Undo 功能**
1. 在 Import History 或 Forecasts 中執行 Undo
2. 回到 Import History 頁面
3. 確認批次狀態變為「已撤銷」
4. 回到 Forecasts 頁面
5. 確認 Batch Selector 不再顯示已撤銷的批次
6. 嘗試查看 component_demand 資料
7. 確認資料已被刪除（應顯示「無資料」）

**驗收點：**
- ✅ Undo 成功執行
- ✅ 批次狀態更新
- ✅ component_demand 和 component_demand_trace 資料被刪除
- ✅ Batch Selector 正確更新

---

## 🚨 常見問題排查

### 問題 1: Run BOM Explosion 失敗，顯示「找不到 FG 需求資料」
**原因**：demand_fg 表中沒有資料，或 time_bucket 篩選條件錯誤
**解決**：
1. 檢查 demand_fg 表是否有資料
2. 確認 time_bucket 格式正確（YYYY-W## 或 YYYY-MM-DD）
3. 嘗試留空 time_bucket 欄位

### 問題 2: Run BOM Explosion 成功，但 component_demand 數量為 0
**原因**：BOM 定義缺失，或 plant_id/time_bucket 不匹配
**解決**：
1. 檢查 bom_edges 表是否有對應的 parent_material
2. 確認 plant_id 匹配（或使用通用 BOM：plant_id=NULL）
3. 檢查 valid_from/valid_to 時效性

### 問題 3: Trace tab 顯示空白或錯誤
**原因**：trace_meta 欄位缺失，或 JSONB 格式錯誤
**解決**：
1. 執行 `database/comprehensive_fix.sql` 確保 trace_meta 欄位存在
2. 檢查 trace_meta 是否為有效的 JSONB 格式

### 問題 4: CSV 匯出失敗或資料不完整
**原因**：前端 CSV 生成邏輯問題
**解決**：
1. 檢查瀏覽器 console 是否有錯誤
2. 確認 data 陣列不為空
3. 檢查是否有特殊字符導致 CSV 格式錯誤

### 問題 5: 「Open in Forecasts」按鈕未顯示
**原因**：batch.target_table 不是 'bom_explosion'，或 status 不是 'completed'
**解決**：
1. 確認批次類型和狀態
2. 檢查 ImportHistoryView.jsx 中的條件邏輯

---

## 📊 預期結果總結

**成功標準：**
1. ✅ Data Upload 頁面簡化，僅負責輸入
2. ✅ Forecasts 頁面成為 BOM Explosion 主要入口
3. ✅ 可執行 BOM Explosion 並查看結果
4. ✅ Results 和 Trace 兩個 tab 正常運作
5. ✅ 篩選、分頁、CSV 匯出功能正常
6. ✅ Batch Selector 可切換不同批次
7. ✅ Import History 可導航到 Forecasts
8. ✅ Undo 功能正常，資料正確刪除

---

## 🎉 產品化價值

**Before（舊架構）：**
- Data Upload 頁面混雜了輸入和運算功能
- 執行結果需要跳轉到 Import History 才能查看
- 沒有專門的結果管理和查詢介面

**After（新架構）：**
- **Data Upload**：純粹的資料輸入頁面
- **Forecasts**：完整的 BOM Explosion 工作流程（Run → Select Batch → View Results/Trace）
- **Import History**：Audit 和 Undo 功能，可快速跳轉到 Forecasts 查看結果

**使用者體驗提升：**
- 減少 3-4 次頁面跳轉
- 一站式操作體驗
- 清晰的職責分離
- 符合 SaaS 產品標準

---

## 📝 後續改進建議

1. **跨頁面狀態傳遞**：
   - 從 Import History「Open in Forecasts」時，可傳遞 batchId
   - 使用 URL params 或 global state（例如 React Context）

2. **錯誤處理增強**：
   - 在 Forecasts 頁面顯示詳細的 BOM Explosion 錯誤列表
   - 支援匯出錯誤報告

3. **進階篩選**：
   - 日期範圍篩選
   - 多選 plant_id 篩選
   - 儲存常用篩選條件

4. **效能優化**：
   - 大量資料時的虛擬滾動
   - 伺服器端分頁和篩選

5. **資料視覺化**：
   - Component 需求趨勢圖
   - BOM 結構樹狀圖
   - Trace 路徑視覺化

---

**測試完成日期：** _____________
**測試人員：** _____________
**測試結果：** ✅ 通過 / ❌ 未通過
**備註：** _____________________________________________
