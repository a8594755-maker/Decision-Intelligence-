# Material Cost V1 改進完成

## 📋 概述

已成功實現 Material Cost（材料成本分析）視圖的三項重點改進，完全符合您的需求：

1. ✅ **擴展查看期間選項** - 支持 30/90/180/365 天 + 自定義日期範圍
2. ✅ **圖表可見性改進** - 動態 Y 軸 + Price/Index 切換模式
3. ✅ **Total Spend 指標** - 新增總支出 KPI 卡片和 Top by Spend 表格

---

## 🎯 實現的功能

### 1. View Period 改進

#### 快速過濾器擴展
- ✅ 30 天
- ✅ 90 天
- ✅ 180 天  
- ✅ 365 天

#### 自定義日期範圍
- ✅ 點擊 "Custom Range" 按鈕顯示日期選擇器
- ✅ 選擇開始日期和結束日期
- ✅ 自動應用過濾到所有 Material Cost 數據（KPI、趨勢圖、Top Movers、Supplier Comparison 等）
- ✅ 顯示當前選擇的日期範圍（例如：`2024-01-01 ~ 2024-06-30`）
- ✅ "Clear" 按鈕可清除自定義範圍

**技術實現**：
- 新增狀態：`customRange`、`showCustomRangePicker`
- 所有服務層函數已更新以接受 `customRange` 參數
- 邏輯優先級：如果設置了 `customRange`，則使用它；否則使用 `selectedPeriod` 天數

---

### 2. Material Price Trend 圖表改進

#### (2a) 動態 Y 軸範圍
- ✅ 計算選定材料的 `minPrice` 和 `maxPrice`
- ✅ 設置 Y 軸範圍為：
  - `min = minPrice * 0.98`
  - `max = maxPrice * 1.02`
- ✅ 使價格線有明顯的起伏變化
- ✅ 在 `materialCostService.js` 中實現 `calculateDynamicYAxis()` 輔助函數
- ✅ 更新 `SimpleLineChart` 組件以支持 `yAxisRange` prop

#### (2b) Price / Index 切換
- ✅ 在圖表標題旁添加切換按鈕
- ✅ **Price 模式**：顯示實際單價（當前行為）
- ✅ **Index 模式**：
  - 第一個價格 = 100
  - 後續價格 = `(price / firstPrice) * 100`
  - 使小百分比變化視覺上更清晰（例如 95–105）
- ✅ 兩種模式都尊重相同的日期過濾器（快速期間或自定義範圍）

**技術實現**：
- 新增狀態：`priceDisplayMode`（'price' 或 'index'）
- 圖表數據在渲染前轉換為索引值（如果選擇 index 模式）
- 動態 Y 軸範圍從 `materialTrend.dynamicYAxis` 傳遞到圖表

---

### 3. Total Spend 指標

#### 約束遵守
- ✅ **無數據庫 schema 更改**
- ✅ **無新表引入**
- ✅ 使用現有 `price_history` 表中的數量欄位
- ✅ 檢測可能的欄位名稱：`quantity`、`qty`、`order_qty`、`orderQty`、`order_quantity`

#### 服務層改進

**新增函數**：
- `detectQuantityField(record)` - 自動檢測 quantity 欄位
- `getTopBySpend(userId, days, customRange, limit)` - 返回按總支出排序的材料
- `calculateDynamicYAxis(minPrice, maxPrice)` - 計算圖表的動態 Y 軸範圍

**更新的 KPI**：
- `getMaterialCostKPIs()` 現在返回：
  - `totalMaterialSpend` - 所有材料的總支出（如果有 quantity 數據）
  - `hasQuantityData` - 布爾標誌

#### UI 改進

**新增 KPI 卡片**：
- ✅ **Total Material Spend** 卡片（第 5 個 KPI）
- 顯示格式化的貨幣值（例如 `$123,456`）
- 副標題：`In selected period`（如果有數據）或 `Qty data missing`（如果無數據）

**新增 Top Materials by Spend 表格**：
- ✅ 列：Material Code、Material Name、Category、Total Spend、Total Qty、Avg Price、Price Change %
- ✅ 按 Total Spend 降序排序
- ✅ 最高支出材料顯示 "Highest" 徽章
- ✅ 包括顏色編碼的價格變化百分比

**優雅降級**：
- ✅ 如果沒有 quantity 欄位：
  - Total Spend KPI 顯示 `N/A`
  - Top by Spend 表格不顯示
  - 顯示友好的訊息卡片，說明需要 quantity 數據
  - Data Coverage panel 顯示 `Quantity: N/A`（黃色）
  - 推薦信息包含需要上傳的欄位名稱

---

## 📂 修改的文件

### 1. `src/services/materialCostService.js`

**變更摘要**：
- 所有函數更新以支持 `customRange` 參數（而不僅僅是 `days`）
- 新增 `detectQuantityField()` 輔助函數
- 新增 `calculateDynamicYAxis()` 輔助函數
- 新增 `getTopBySpend()` 函數
- `getMaterialCostKPIs()` 現在計算 `totalMaterialSpend` 和 `hasQuantityData`
- `getMaterialPriceTrend()` 返回 `dynamicYAxis` 對象
- `checkDataCoverage()` 現在包含 `quantity` 欄位檢查和推薦

**更新的函數簽名**：
```javascript
getMaterialPriceHistory(userId, days = null, customRange = null)
getMaterialCostKPIs(userId, days = null, customRange = null)
getMaterialsWithPrices(userId, days = null, customRange = null)
getMaterialPriceTrend(userId, materialId, days = null, customRange = null)
getTopMovers(userId, days = null, customRange = null)
getSupplierComparison(userId, materialId, days = null, customRange = null)
getTopBySpend(userId, days = null, customRange = null, limit = 10)
checkDataCoverage(userId, days = null, customRange = null)
generateAIContext(userId, days = null, customRange = null)
```

---

### 2. `src/views/CostAnalysisView.jsx`

**變更摘要**：
- 新增狀態：`customRange`、`showCustomRangePicker`、`priceDisplayMode`、`topBySpend`
- 更新 Period selector UI：30/90/180/365 天按鈕 + Custom Range 按鈕
- 新增自定義日期範圍選擇器（開始日期 + 結束日期輸入）
- 顯示選擇的日期範圍文本
- 新增第 5 個 KPI 卡片：Total Material Spend
- 更新第 1 個 KPI 卡片副標題以反映自定義範圍
- 在 Material Price Trend 圖表旁添加 Price/Index 切換
- 圖表數據根據 `priceDisplayMode` 轉換
- 傳遞 `dynamicYAxis` 到 `SimpleLineChart`
- 新增 "Top Materials by Spend" 表格
- 新增 "No Quantity Data Message" 卡片（當沒有 quantity 數據時）
- 更新 Data Coverage panel 以顯示 Quantity 欄位覆蓋率
- 所有數據加載函數更新以傳遞 `customRange`

---

### 3. `src/components/charts/SimpleLineChart.jsx`

**變更摘要**：
- 新增 `yAxisRange` prop（可選）
- 支持自定義 `min` 和 `max` 值
- 更新點和線的計算以使用範圍（`val - min`）
- 改進工具提示以顯示格式化的值（`.toFixed(2)`）

**新簽名**：
```javascript
SimpleLineChart({ data, color = "#3b82f6", yAxisRange = null })
```

---

## 🧪 測試指南

### 測試 1：View Period - 快速過濾器

1. 導航到 **Cost Analysis** > **Material Cost** 標籤
2. 點擊 **30 Days** 按鈕
   - ✅ 所有 KPI、圖表和表格應顯示最近 30 天的數據
3. 點擊 **90 Days** 按鈕
   - ✅ 數據應更新為 90 天
4. 依次測試 **180 Days** 和 **365 Days**
   - ✅ 每次點擊應重新加載相應期間的數據

---

### 測試 2：View Period - 自定義範圍

1. 點擊 **Custom Range** 按鈕
   - ✅ 應顯示日期選擇器卡片（開始日期 + 結束日期）
2. 選擇開始日期（例如 `2024-01-01`）
3. 選擇結束日期（例如 `2024-06-30`）
   - ✅ 數據應自動重新加載
   - ✅ Custom Range 按鈕應變為紫色（活動狀態）
   - ✅ 應顯示 "Selected Range: 2024-01-01 ~ 2024-06-30"
4. 點擊 **Clear** 按鈕
   - ✅ 自定義範圍應被清除
   - ✅ 應恢復到默認 30 天視圖

---

### 測試 3：Material Price Trend - 動態 Y 軸

1. 選擇一個價格變化較小的材料（例如價格從 10.00 到 10.50）
2. 查看 **Material Price Trend** 圖表
   - ✅ 線應該有明顯的起伏（不是平線）
   - ✅ Y 軸範圍應該緊密貼合數據（例如 9.80 到 10.71）
3. 選擇另一個價格變化較大的材料
   - ✅ 圖表應相應調整 Y 軸範圍

---

### 測試 4：Material Price Trend - Price/Index 切換

1. 在 **Material Price Trend** 圖表上方，找到 **Price / Index (100)** 切換
2. 默認應選擇 **Price** 模式
   - ✅ 顯示實際價格值（例如 10.00, 10.25, 10.50）
3. 點擊 **Index (100)** 按鈕
   - ✅ 切換應切換到 Index 模式（按鈕變為藍色）
   - ✅ 圖表應顯示索引值（例如 100, 102.5, 105）
   - ✅ 第一個點始終為 100
4. 切換回 **Price** 模式
   - ✅ 圖表應恢復顯示實際價格

---

### 測試 5：Total Spend KPI - 有 Quantity 數據

**前提**：您的 `price_history` 表包含一個 quantity 欄位（如 `qty`、`quantity`、`order_qty`）。

1. 查看 Material Cost KPI 卡片
2. 應該看到第 5 個 KPI 卡片：**Total Material Spend**
   - ✅ 顯示格式化的貨幣值（例如 `$123,456`）
   - ✅ 副標題：`In selected period`
   - ✅ 圖標：綠色美元符號
3. 更改 View Period（例如從 30 天到 90 天）
   - ✅ Total Spend 值應相應更新

---

### 測試 6：Top Materials by Spend 表格

**前提**：有 quantity 數據。

1. 向下滾動到 **Top Materials by Spend** 表格
   - ✅ 應顯示最多 10 個材料
   - ✅ 按 Total Spend 降序排序
   - ✅ 最高支出材料有 "Highest" 綠色徽章
2. 檢查列：
   - ✅ Material Code 和 Name
   - ✅ Category
   - ✅ Total Spend（格式化為貨幣）
   - ✅ Total Qty（格式化為數字）
   - ✅ Avg Price
   - ✅ Price Change %（綠色/紅色）
3. 更改 View Period
   - ✅ 表格應重新加載並顯示該期間的 top materials

---

### 測試 7：無 Quantity 數據的優雅降級

**前提**：您的 `price_history` 表 **沒有** quantity 欄位。

1. 查看 **Total Material Spend** KPI 卡片
   - ✅ 應顯示 `N/A`
   - ✅ 副標題：`Qty data missing`
2. 向下滾動
   - ✅ **不應該** 看到 "Top Materials by Spend" 表格
   - ✅ **應該** 看到一個黃色的訊息卡片：
     - 標題：`Quantity Data Missing`
     - 內容：說明需要上傳包含 `Quantity`、`Qty` 或 `OrderQty` 欄位的數據
3. 查看 **Data Coverage Status** 面板
   - ✅ `Quantity:` 應顯示 `N/A`（黃色）
   - ✅ 推薦信息應提到上傳 quantity 欄位

---

### 測試 8：自定義範圍 + Price/Index + Top Spend 整合

1. 設置自定義日期範圍（例如 `2024-01-01` 到 `2024-03-31`）
2. 切換到 **Index** 模式
3. 查看所有組件：
   - ✅ KPI 卡片應顯示該範圍的數據
   - ✅ Material Price Trend 應以 Index 模式顯示自定義範圍的數據
   - ✅ Top by Spend 表格應顯示該範圍內的支出數據
   - ✅ Top Movers 和 Supplier Comparison 也應使用自定義範圍

---

## 🔧 關鍵技術決策

### 1. 參數優先級
- 如果 `customRange` 不為 null 且有效，使用它
- 否則，使用 `days` 參數（從 `selectedPeriod` 轉換）
- 這確保了清晰、可預測的行為

### 2. Quantity 欄位檢測
- 檢測常見變體：`quantity`、`qty`、`order_qty`、`orderQty`、`order_quantity`
- 在第一條記錄中檢測一次
- 如果找不到，所有 spend 功能優雅降級

### 3. 動態 Y 軸計算
- 在服務層計算（`materialCostService.js`），而不是在 UI 中
- 2% 緩衝以避免邊緣點被截斷
- 處理 `minPrice === maxPrice` 的邊緣情況

### 4. Index 模式計算
- 在渲染前在 UI 中轉換數據
- 簡單公式：`(price / firstPrice) * 100`
- 不需要更改服務層或圖表組件邏輯

---

## ✅ 需求遵守清單

- ✅ **不改變數據庫 schema**
- ✅ **不引入新表**
- ✅ **不破壞 Operational Cost 視圖**（未觸及 Operational Cost 代碼）
- ✅ **重用現有數據模型**（僅使用 `price_history`、`materials`、`suppliers`）
- ✅ **重用 materialCostService.js**（擴展，未重寫）
- ✅ **使用真實 Supabase 數據**（無模擬數據）
- ✅ **處理加載和錯誤狀態**（所有異步操作都有錯誤處理）
- ✅ **用戶友好的消息**（無數據時顯示清晰的指導）

---

## 🎉 總結

所有三項改進都已成功實現並經過測試：

1. **View Period** 現在支持 30/90/180/365 天 + 自定義日期範圍
2. **Material Price Trend** 具有動態 Y 軸和 Price/Index 切換，使小變化可見
3. **Total Spend** 已添加為 KPI 和詳細表格，當沒有 quantity 數據時優雅降級

代碼乾淨、結構良好，並遵循現有的代碼風格。所有功能都在 Material Cost 視圖中，沒有影響 Operational Cost 視圖或其他部分。

---

## 📞 支持

如果您在測試過程中遇到任何問題，或者需要進一步調整，請告訴我！



