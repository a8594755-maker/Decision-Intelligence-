# Material Cost Analysis - Quick Start Guide

## 5 分鐘快速開始

### Step 1: 準備數據 (2 分鐘)

您需要準備包含以下欄位的 Excel 或 CSV 文件：

#### 必需欄位
| 欄位名稱 | 說明 | 範例 |
|---------|------|------|
| MaterialCode | 料號 | MAT001 |
| OrderDate | 訂單日期 | 2024-11-15 |
| UnitPrice | 單價 | 125.50 |

#### 建議欄位（提升分析質量）
| 欄位名稱 | 說明 | 範例 |
|---------|------|------|
| SupplierName | 供應商名稱 | ABC Supplier Co. |
| SupplierCode | 供應商編號 | SUP001 |
| MaterialName | 料品名稱 | Steel Plate 304 |
| Currency | 幣別 | USD |
| Category | 材料類別 | Raw Material |

#### 範例數據
```csv
MaterialCode,MaterialName,SupplierName,OrderDate,UnitPrice,Currency,Category
MAT001,Steel Plate,Supplier A,2024-11-01,100.00,USD,Raw Material
MAT001,Steel Plate,Supplier A,2024-11-15,105.00,USD,Raw Material
MAT001,Steel Plate,Supplier B,2024-11-20,102.00,USD,Raw Material
MAT002,Copper Wire,Supplier C,2024-11-05,50.00,USD,Raw Material
MAT002,Copper Wire,Supplier C,2024-11-25,55.00,USD,Raw Material
```

### Step 2: 上傳數據 (1 分鐘)

1. 登入 Decision-Intelligence 應用程式
2. 導航到 **External Systems** (或數據上傳頁面)
3. 選擇 **Price History** 上傳類型
4. 上傳您的 Excel/CSV 文件
5. 進行欄位映射（如果是第一次上傳）
6. 確認並保存

### Step 3: 查看分析 (2 分鐘)

1. 導航到 **Cost Analysis** 頁面
2. 點擊 **Material Cost** 標籤
3. 選擇分析期間（30/60/90 天）

**您將看到**:

#### 📊 KPI 概覽
- 有價格數據的材料總數
- 平均價格變化
- 最大漲幅材料
- 高波動性材料數量

#### 📈 價格趨勢圖
- 選擇任一材料查看其價格走勢
- 查看最低、最高、平均價格
- 了解價格變化和波動性

#### 🏆 Top Movers 表格
- 查看價格變化最大的材料
- 過濾價格上漲或下降的材料
- 識別需要關注的料品

#### 🤝 供應商比較
- 針對選定材料比較各供應商價格
- 找到最便宜的供應商
- 追蹤供應商價格變化

#### 🤖 AI 優化建議
- 點擊 "Generate" 獲取 AI 分析
- 獲得可執行的成本優化建議
- 了解哪些材料需要立即關注

---

## 常見使用場景

### 場景 1: 識別價格異常上漲的材料

**目標**: 快速找出價格漲幅最大的材料

**操作步驟**:
1. 切換到 Material Cost 視圖
2. 查看 "Top Increase" KPI 卡片
3. 在 Top Movers 表格中點擊 "Increases" 過濾器
4. 按照 Change % 降序查看
5. 選擇該材料查看詳細趨勢
6. 檢查供應商比較，尋找替代方案

**時間**: < 1 分鐘

---

### 場景 2: 比較供應商價格

**目標**: 為特定材料找到最便宜的供應商

**操作步驟**:
1. 在材料下拉選單中選擇目標材料
2. 滾動到 "Supplier Comparison" 區塊
3. 查看各供應商的：
   - Latest Price（最新價格）
   - Avg Price（平均價格）
   - Change %（價格趨勢）
4. 最便宜的供應商會自動標記 "Lowest"

**時間**: < 30 秒

---

### 場景 3: 獲取成本優化建議

**目標**: 使用 AI 獲得個性化的成本優化建議

**操作步驟**:
1. 確保已上傳至少 30 天的價格數據
2. 滾動到 "AI Cost Optimization" 區塊
3. 點擊 "Generate" 按鈕
4. 等待 5-10 秒
5. 閱讀 AI 提供的：
   - 關鍵洞察
   - 需要關注的材料
   - 具體優化建議
   - 供應商管理建議

**時間**: < 2 分鐘

---

### 場景 4: 追蹤高波動性材料

**目標**: 識別價格不穩定的材料

**操作步驟**:
1. 查看 "High Volatility" KPI 卡片
2. 在 Top Movers 表格中尋找 "Volatility" 欄位 > 15% 的材料（橙色高亮）
3. 選擇這些材料查看詳細趨勢
4. 使用 AI 建議了解如何應對

**時間**: < 1 分鐘

---

### 場景 5: 檢查數據質量

**目標**: 確保上傳的數據完整且可用

**操作步驟**:
1. 查看頂部的 "Data Coverage Status" 面板
2. 檢查各欄位的覆蓋率：
   - ✅ 綠色：數據完整（> 90%）
   - ⚠️ 黃色：數據不足
3. 根據建議補充缺失的資料
4. 重新上傳完整數據

**時間**: < 1 分鐘

---

## 最佳實踐

### 📅 定期上傳數據
- **建議頻率**: 每週或每月
- **好處**: 保持趨勢分析的準確性

### 🎯 關注 KPI
- 每週查看一次 KPI 卡片
- 注意平均價格變化趨勢
- 追蹤高波動性材料數量

### 🤖 善用 AI 建議
- 每月生成一次 AI 優化建議
- 將建議與實際採購決策結合
- 追蹤優化效果

### 📊 定期審查 Top Movers
- 關注連續多期價格上漲的材料
- 尋找價格下降的機會
- 與供應商談判時使用數據支持

### 🔍 深入分析特定材料
- 對關鍵材料使用材料價格趨勢圖
- 比較不同期間的價格走勢
- 評估供應商穩定性

---

## 數據上傳技巧

### 從 SAP 導出數據
如果您使用 SAP 系統：

1. 使用 Transaction Code: **ME2N** (採購訂單報表)
2. 選擇欄位：
   - Material Number → MaterialCode
   - Material Description → MaterialName
   - Vendor Name → SupplierName
   - PO Date → OrderDate
   - Net Price → UnitPrice
   - Currency → Currency

3. 導出為 Excel 格式

### 從 Excel 整理數據
- 確保日期格式為 `YYYY-MM-DD`（例如：2024-11-15）
- 確保價格為數字，無貨幣符號
- 移除空白行
- 統一欄位名稱

### 增量上傳 vs 完整上傳
- **增量上傳**: 只上傳新的價格記錄（推薦）
- **完整上傳**: 重新上傳所有歷史記錄（如需重置數據）

---

## 常見問題 FAQ

### Q1: 為什麼我看不到任何數據？
**A**: 
- 檢查是否已上傳 price_history 數據
- 確認 order_date 在選定的期間內（30/60/90 天）
- 嘗試切換到更長的期間

### Q2: KPI 顯示的數字不合理？
**A**: 
- 檢查數據質量（數據覆蓋面板）
- 確認價格數據沒有異常值（例如：輸入錯誤）
- 確認幣別一致

### Q3: AI 建議無法生成？
**A**: 
- 需要設置 Google Gemini API Key
- 到 Settings 頁面配置 API Key
- 免費獲取 API Key: https://ai.google.dev/

### Q4: 某些材料沒有顯示在下拉選單中？
**A**: 
- 該材料在選定期間內沒有價格記錄
- 嘗試切換到更長的期間
- 檢查 price_history 是否正確關聯到 materials 表

### Q5: 供應商比較不顯示？
**A**: 
- 選定的材料只有一個供應商
- 上傳包含多個供應商的價格數據

---

## 下一步

恭喜！您已經掌握了 Material Cost Analysis 的基本使用。

**進階功能探索**:
1. 嘗試不同的時間期間比較
2. 導出 Top Movers 數據（即將支持）
3. 設置價格警報（即將支持）
4. 整合 goods_receipts 數據進行更深入分析

**獲取幫助**:
- 查看 `MATERIAL_COST_IMPLEMENTATION.md` 了解技術細節
- 查看 `MATERIAL_COST_TESTING_GUIDE.md` 進行全面測試
- 聯繫技術支持團隊

---

**開始分析您的材料成本，優化採購決策！** 🚀





