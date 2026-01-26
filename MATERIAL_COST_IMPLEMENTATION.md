# Material Cost Analysis Implementation

## 概述

已成功實現 **Material Cost Analysis (材料成本分析)** 功能，作為 SmartOps 應用程式 Cost Analysis 模組的一部分。

## 實現的功能

### 1. ✅ 期間選擇器 (Period Selector)
- 支援 30/60/90 天的時間窗口選擇
- 所有查詢和分析都基於選定的期間
- 一鍵刷新數據

### 2. ✅ KPI 汇總卡片 (KPI Summary Cards)
實現了 4 個關鍵 KPI 卡片：

- **Materials with Price Data**: 有價格記錄的材料總數
- **Average Price Change**: 所有材料的平均價格變化百分比
- **Top Increase Material**: 價格漲幅最大的材料及其變化百分比
- **High Volatility Count**: 高波動性材料數量 (波動性 > 15%)

### 3. ✅ 材料價格趨勢圖 (Material Price Trend Chart)
- 可搜尋的下拉選單，選擇特定材料
- 使用 SimpleLineChart 顯示價格走勢
- 顯示詳細統計：
  - 最低價格
  - 最高價格
  - 平均價格
  - 價格變化百分比
  - 波動性指標

### 4. ✅ Top Movers 表格 (Top Movers Table)
顯示價格變化最大的材料，包含以下欄位：
- Material Code & Name
- Category
- Old Price (期間開始價格)
- Latest Price (期間結束價格)
- Change % (變化百分比)
- Volatility (波動性)
- Supplier Count (供應商數量)

**功能特點**：
- 可按 "All", "Increases", "Decreases" 過濾
- 可搜尋材料編號或名稱
- 按價格變化絕對值降序排列
- 顯示前 20 條記錄

### 5. ✅ 供應商比較 (Supplier Comparison)
針對選定的材料，顯示各供應商的比較：
- Supplier Name & Code
- Latest Price (最新價格)
- Average Price (平均價格)
- Change % (價格變化)
- Last Date (最後價格日期)
- 自動標記最便宜的供應商

### 6. ✅ 原始價格歷史表格 (Raw Price History)
整合在 Top Movers 表格中，顯示：
- 所有價格記錄的詳細信息
- 可過濾、搜尋
- 前 20 條記錄展示

### 7. ✅ AI 優化建議 (AI Optimization)
利用 Google Gemini AI 提供智能成本優化建議：
- 分析 Top Movers（價格上漲/下跌材料）
- 識別高波動性材料
- 提供可執行的優化建議
- 供應商管理建議
- 使用繁體中文回應

**AI 上下文包含**：
- 選定期間
- KPI 摘要
- Top 5 價格上漲材料
- Top 5 價格下降材料
- Top 5 高波動性材料

### 8. ✅ 數據需求面板 (Data Requirements Panel)
智能檢測數據覆蓋度並提供建議：

**當無數據時**：
- 顯示清晰的提示信息
- 說明需要上傳的欄位：MaterialCode, SupplierName, OrderDate, UnitPrice, Currency
- 提供上傳入口連結

**當有數據時**：
- 顯示各欄位的覆蓋率百分比
- 識別缺失或覆蓋率低的欄位
- 提供具體的數據質量建議
- 總記錄數統計

**檢查的欄位**：
- material_code (料號覆蓋率)
- supplier_name (供應商覆蓋率)
- order_date (訂單日期，必須 100%)
- unit_price (單價，必須 100%)
- currency (幣別覆蓋率)

### 9. ✅ 空狀態處理 (Empty State)
- **無數據時**: 顯示友好的空狀態，引導用戶上傳數據
- **期間無記錄**: 提示嘗試更長的期間或上傳更多數據
- 一鍵跳轉到數據上傳頁面

## 技術架構

### 新增文件

#### 1. `src/services/materialCostService.js`
核心服務層，包含以下函數：

- `getMaterialPriceHistory(userId, days)` - 獲取價格歷史
- `getMaterialCostKPIs(userId, days)` - 計算 KPI
- `getMaterialsWithPrices(userId, days)` - 獲取有價格的材料列表
- `getMaterialPriceTrend(userId, materialId, days)` - 獲取單一材料趨勢
- `getTopMovers(userId, days)` - 獲取 Top Movers
- `getSupplierComparison(userId, materialId, days)` - 供應商比較
- `checkDataCoverage(userId, days)` - 檢查數據覆蓋度
- `generateAIContext(userId, days)` - 生成 AI 分析上下文

#### 2. `src/views/CostAnalysisView.jsx` (更新)
- 添加 Material Cost 和 Operational Cost 的標籤切換
- 整合 Material Cost 的完整 UI
- 狀態管理和數據加載邏輯

### 數據流

```
User selects period (30/60/90 days)
         ↓
materialCostService.getMaterialCostKPIs() 
         ↓
Supabase: Query price_history table
         ↓
Join with materials & suppliers tables
         ↓
Calculate KPIs, trends, statistics
         ↓
Display in UI components
```

### 數據庫結構

使用現有的 Supabase 表：

**materials**:
- material_code
- material_name
- category
- uom (Unit of Measure)
- user_id

**price_history**:
- supplier_id
- material_id
- order_date (作為 price_date)
- unit_price
- currency
- quantity
- user_id

**suppliers**:
- supplier_code
- supplier_name

## 使用方式

### 1. 查看 Material Cost 分析
1. 登入應用程式
2. 導航到 "Cost Analysis" 頁面
3. 點擊 "Material Cost" 標籤
4. 選擇分析期間 (30/60/90 天)

### 2. 分析特定材料
1. 在 "Material Price Trend" 區塊使用下拉選單選擇材料
2. 查看價格走勢圖和統計數據
3. 檢視該材料的供應商比較

### 3. 識別問題材料
1. 查看 KPI 卡片了解整體情況
2. 在 "Top Movers" 表格中：
   - 點擊 "Increases" 查看價格上漲的材料
   - 點擊 "Decreases" 查看價格下降的材料
   - 關注高波動性材料

### 4. 獲取 AI 建議
1. 點擊 "AI Cost Optimization" 區塊的 "Generate" 按鈕
2. 等待 AI 分析完成（使用 Google Gemini）
3. 閱讀 AI 提供的優化建議

### 5. 檢查數據質量
1. 查看頂部的 "Data Coverage Status" 面板
2. 確認各欄位的覆蓋率
3. 根據建議補充缺失的數據

## 數據要求

為了獲得最佳分析效果，請確保上傳的數據包含：

### 必需欄位
- **MaterialCode** (料號)
- **OrderDate** (訂單日期 / 價格日期)
- **UnitPrice** (單價)

### 建議欄位
- **SupplierName** (供應商名稱)
- **SupplierCode** (供應商編號)
- **Currency** (幣別，如 USD, TWD)
- **MaterialName** (料品名稱)
- **Category** (材料類別)
- **Quantity** (數量)
- **PriceUnit** (價格單位，如 per PCS, per KG)

## 性能優化

### 數據庫查詢優化
- 使用索引：`user_id`, `material_id`, `order_date`
- 一次性加載所有數據，在前端進行分組和計算
- 使用 Supabase RLS (Row Level Security) 確保數據安全

### 前端優化
- 條件渲染，只加載當前視圖的數據
- 使用 React hooks 進行狀態管理
- 避免不必要的重新渲染

## 已知限制和未來改進

### 目前限制
1. Top Movers 表格顯示前 20 條記錄（可添加分頁）
2. 不支持多幣別轉換（假設同一材料使用相同幣別）
3. AI 分析依賴 Google Gemini API（需要 API key）

### 未來改進計劃
1. 添加匯出功能（CSV/Excel）
2. 添加材料組比較
3. 添加價格預測功能
4. 支持多幣別自動轉換
5. 添加價格警報功能
6. 整合 goods_receipts 數據進行更深入的分析

## 測試建議

### 功能測試
1. **空狀態測試**: 無數據時是否正確顯示空狀態
2. **KPI 計算測試**: 驗證 KPI 計算是否正確
3. **過濾和搜尋測試**: 測試 Top Movers 的過濾功能
4. **期間切換測試**: 切換 30/60/90 天是否正確重新加載數據
5. **材料選擇測試**: 選擇不同材料是否正確更新趨勢圖

### 數據質量測試
1. 上傳不完整的數據，檢查數據覆蓋面板是否正確識別
2. 上傳完整數據，確認所有功能正常運作
3. 測試邊界情況（只有 1 個價格記錄的材料）

### AI 功能測試
1. 測試 AI 建議生成
2. 驗證 AI 回應的質量
3. 測試 API 錯誤處理

## 相關文件

- `database/supplier_kpi_schema.sql` - 數據庫 schema
- `src/services/supabaseClient.js` - Supabase 客戶端配置
- `src/services/geminiAPI.js` - Google Gemini AI 集成
- `src/components/charts/` - 圖表組件

## 總結

Material Cost Analysis 功能已完全實現，包含所有 9 個要求的功能點。該功能：

✅ 使用用戶已上傳到 Supabase 的真實數據  
✅ 支持可配置的時間期間（30/60/90 天）  
✅ 提供全面的 KPI 和視覺化分析  
✅ 整合 AI 提供智能優化建議  
✅ 主動檢測和報告數據質量問題  
✅ 提供友好的空狀態和錯誤處理  
✅ 過濾數據僅顯示當前用戶的記錄  
✅ 與現有應用程式無縫整合  

用戶現在可以全面了解材料成本趨勢，識別問題材料，比較供應商，並獲得 AI 驅動的優化建議。

