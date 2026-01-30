# Material Cost Analysis - Testing Guide

## 快速測試流程

### 前置準備

1. **確保數據庫 Schema 已部署**
   - 檢查 Supabase 中是否存在以下表：
     - `materials`
     - `price_history`
     - `suppliers`

2. **準備測試數據**
   - 至少上傳一些 price_history 記錄
   - 建議包含 2-3 個材料，每個材料有多個價格記錄
   - 時間範圍涵蓋至少 30 天

### 測試案例

#### 測試 1: 空狀態顯示
**目的**: 驗證無數據時的友好提示

**步驟**:
1. 使用沒有上傳任何數據的新用戶登入
2. 導航到 Cost Analysis > Material Cost
3. 應該看到：
   - "No Material Cost Data Yet" 空狀態卡片
   - "Upload Data" 按鈕
   - 數據覆蓋面板顯示 "Missing Data"

**預期結果**: ✅ 顯示友好的空狀態，引導用戶上傳數據

---

#### 測試 2: KPI 卡片計算
**目的**: 驗證 KPI 計算正確性

**測試數據範例**:
```
Material A:
- Day 1: $10
- Day 30: $12
- Change: +20%

Material B:
- Day 1: $50
- Day 30: $45
- Change: -10%
```

**步驟**:
1. 上傳包含上述數據的 price_history
2. 查看 Material Cost 頁面
3. 檢查 KPI 卡片：
   - Materials with Price Data: 應顯示 2
   - Avg Price Change: 應顯示 (+20% - 10%) / 2 = +5%
   - Top Increase: 應顯示 Material A (+20%)
   - High Volatility Count: 根據波動性計算

**預期結果**: ✅ KPI 顯示正確，數字合理

---

#### 測試 3: 期間選擇器
**目的**: 驗證期間切換功能

**步驟**:
1. 默認選擇 30 天，查看顯示的數據
2. 切換到 60 天
3. 觀察數據變化
4. 切換到 90 天
5. 再切換回 30 天

**預期結果**: 
- ✅ 期間按鈕正確高亮
- ✅ 數據根據期間正確過濾
- ✅ 切換流暢，無錯誤

---

#### 測試 4: 材料價格趨勢圖
**目的**: 驗證單一材料的價格趨勢顯示

**步驟**:
1. 在 "Material Price Trend" 區塊
2. 從下拉選單選擇一個材料
3. 檢查趨勢圖是否正確顯示
4. 檢查統計數據：
   - Min Price
   - Max Price
   - Avg Price
   - Price Change
   - Volatility

**預期結果**: 
- ✅ 趨勢圖正確顯示價格走勢
- ✅ 統計數據計算正確
- ✅ 切換材料時圖表正確更新

---

#### 測試 5: Top Movers 表格
**目的**: 驗證材料排序和過濾功能

**步驟**:
1. 查看 "Top Movers" 表格
2. 點擊 "Increases" 過濾器
   - 應只顯示價格上漲的材料
3. 點擊 "Decreases" 過濾器
   - 應只顯示價格下降的材料
4. 點擊 "All"
   - 應顯示所有材料，按絕對變化排序

**預期結果**: 
- ✅ 過濾器正確工作
- ✅ 表格數據正確顯示
- ✅ 排序邏輯正確（絕對值降序）

---

#### 測試 6: 供應商比較
**目的**: 驗證針對同一材料的供應商比較

**測試數據範例**:
```
Material A:
- Supplier X: $10, $11, $12 (Latest: $12)
- Supplier Y: $9, $10, $10 (Latest: $10)
- Supplier Z: $11, $12, $13 (Latest: $13)
```

**步驟**:
1. 選擇 Material A
2. 查看 "Supplier Comparison" 區塊
3. 檢查排序：應按 Latest Price 升序（最便宜的在前）
4. 確認 Supplier Y 被標記為 "Lowest"

**預期結果**: 
- ✅ 供應商按價格正確排序
- ✅ 最便宜的供應商有 "Lowest" 標記
- ✅ 統計數據（Latest Price, Avg Price, Change %）正確

---

#### 測試 7: 數據覆蓋面板
**目的**: 驗證數據質量檢測

**步驟**:
1. 上傳不完整的數據（例如：缺少 currency 欄位）
2. 查看 "Data Coverage Status" 面板
3. 應該看到：
   - 缺失欄位的警告
   - 覆蓋率百分比
   - 具體的改進建議

**預期結果**: 
- ✅ 正確識別缺失欄位
- ✅ 顯示覆蓋率百分比
- ✅ 提供清晰的改進建議

---

#### 測試 8: AI 優化建議
**目的**: 驗證 AI 分析功能

**前置條件**: 
- 需要有效的 Google Gemini API Key
- 已設置在 localStorage 或使用默認 key

**步驟**:
1. 確保有足夠的 price_history 數據
2. 點擊 "AI Cost Optimization" 區塊的 "Generate" 按鈕
3. 等待 AI 分析（5-10 秒）
4. 檢查 AI 回應：
   - 應使用繁體中文
   - 包含關鍵洞察
   - 提供具體建議
   - 識別需要關注的材料

**預期結果**: 
- ✅ AI 成功生成建議
- ✅ 回應使用繁體中文
- ✅ 建議具體且可執行
- ✅ 錯誤處理正確（如 API quota 超限）

---

#### 測試 9: 視圖切換
**目的**: 驗證 Material Cost 和 Operational Cost 之間的切換

**步驟**:
1. 在 Material Cost 視圖
2. 點擊 "Operational Cost" 標籤
3. 應切換到營運成本視圖
4. 點擊 "Material Cost" 標籤
5. 應切換回材料成本視圖

**預期結果**: 
- ✅ 標籤正確切換
- ✅ 視圖內容正確更新
- ✅ 數據不會混淆
- ✅ 無控制台錯誤

---

#### 測試 10: 響應式設計
**目的**: 驗證在不同螢幕尺寸下的顯示

**步驟**:
1. 在桌面瀏覽器查看（>1024px）
2. 調整視窗到平板尺寸（768px - 1024px）
3. 調整視窗到手機尺寸（< 768px）
4. 檢查：
   - KPI 卡片排列
   - 表格是否可滾動
   - 按鈕和控制項是否可用

**預期結果**: 
- ✅ 各尺寸下佈局合理
- ✅ 無元素重疊或溢出
- ✅ 所有功能可用

---

### 錯誤處理測試

#### 測試 11: 網路錯誤處理
**步驟**:
1. 斷開網路連接
2. 嘗試刷新數據
3. 應顯示錯誤提示

**預期結果**: ✅ 友好的錯誤訊息，不會崩潰

---

#### 測試 12: API 錯誤處理
**步驟**:
1. 清除 Gemini API Key（或使用無效的 key）
2. 點擊 "Generate" AI 建議
3. 應顯示 API 錯誤訊息

**預期結果**: ✅ 顯示清晰的錯誤提示，引導用戶設置 API key

---

### 性能測試

#### 測試 13: 大數據集
**測試數據**:
- 100+ 材料
- 1000+ price_history 記錄

**步驟**:
1. 上傳大量數據
2. 切換到 Material Cost 視圖
3. 測量頁面加載時間
4. 測試各功能的響應速度

**預期結果**: 
- ✅ 初始加載 < 3 秒
- ✅ 期間切換 < 2 秒
- ✅ 材料選擇即時響應
- ✅ 無明顯卡頓

---

## 常見問題排查

### 問題 1: KPI 卡片顯示 0
**可能原因**:
- 選定期間內無 price_history 記錄
- price_history 記錄的 order_date 超出期間範圍

**解決方案**:
- 檢查數據庫中的 order_date 是否在最近 30 天內
- 嘗試切換到更長的期間（60 或 90 天）

---

### 問題 2: 材料下拉選單為空
**可能原因**:
- price_history 表中沒有記錄
- material_id 外鍵無法關聯到 materials 表

**解決方案**:
- 檢查 price_history 表是否有記錄
- 檢查 material_id 是否正確關聯
- 確認 materials 表中存在對應的記錄

---

### 問題 3: AI 建議無法生成
**可能原因**:
- API Key 無效或過期
- API quota 已用完
- 網路連接問題

**解決方案**:
- 檢查 localStorage 中的 gemini_api_key
- 到 https://ai.google.dev/ 獲取新的 API key
- 檢查瀏覽器控制台的錯誤訊息

---

### 問題 4: 供應商比較不顯示
**可能原因**:
- 選定材料只有一個供應商
- 供應商資料未正確關聯

**解決方案**:
- 確認該材料有多個供應商的價格記錄
- 檢查 supplier_id 外鍵是否正確

---

## 測試清單 Checklist

複製以下清單，逐項測試：

```
□ 測試 1: 空狀態顯示
□ 測試 2: KPI 卡片計算
□ 測試 3: 期間選擇器
□ 測試 4: 材料價格趨勢圖
□ 測試 5: Top Movers 表格
□ 測試 6: 供應商比較
□ 測試 7: 數據覆蓋面板
□ 測試 8: AI 優化建議
□ 測試 9: 視圖切換
□ 測試 10: 響應式設計
□ 測試 11: 網路錯誤處理
□ 測試 12: API 錯誤處理
□ 測試 13: 大數據集性能
```

## 測試數據範例

如果需要測試數據，可以使用以下 SQL 插入語句（修改 user_id 為您的用戶 ID）：

```sql
-- 插入測試材料
INSERT INTO materials (user_id, material_code, material_name, category, uom)
VALUES 
  ('your-user-id', 'MAT001', 'Steel Plate', 'Raw Material', 'kg'),
  ('your-user-id', 'MAT002', 'Copper Wire', 'Raw Material', 'm'),
  ('your-user-id', 'MAT003', 'Plastic Resin', 'Raw Material', 'kg');

-- 插入測試供應商（如果尚未存在）
INSERT INTO suppliers (user_id, supplier_code, supplier_name)
VALUES 
  ('your-user-id', 'SUP001', 'Supplier A'),
  ('your-user-id', 'SUP002', 'Supplier B'),
  ('your-user-id', 'SUP003', 'Supplier C');

-- 插入測試價格記錄（過去 30 天）
-- 需要先獲取 material_id 和 supplier_id
```

## 報告問題

如果發現任何問題，請記錄：
1. 重現步驟
2. 預期行為
3. 實際行為
4. 瀏覽器控制台錯誤訊息
5. 螢幕截圖（如適用）

---

**測試完成後，請確認所有核心功能正常運作，然後即可部署到生產環境。**





