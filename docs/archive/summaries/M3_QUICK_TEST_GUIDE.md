# M3 What-if Expedite 快速測試指南

## 🎯 測試目標

驗證 What-if Simulator（Expedite）功能正常運作。

---

## 📋 測試前準備

### 1. 確認資料
```sql
-- 檢查 PO 資料
SELECT material_code, plant_id, time_bucket, open_qty, po_number
FROM po_open_lines
WHERE user_id = 'YOUR_USER_ID'
ORDER BY time_bucket
LIMIT 10;

-- 檢查 Inventory 資料
SELECT material_code, plant_id, on_hand_qty, safety_stock
FROM inventory_snapshots
WHERE user_id = 'YOUR_USER_ID'
LIMIT 10;
```

### 2. 啟動應用
```bash
npm run dev
```

### 3. 進入 Risk Dashboard
- 點擊側邊欄「Risk Dashboard」
- 等待載入完成

---

## ✅ 測試案例

### Test 1: 基本 Expedite（CRITICAL → WARNING）

**步驟：**
1. 找一個 Status = CRITICAL 的列（紅色）
2. 點擊該列，開啟 DetailsPanel
3. 滾動到底部，找到「What-if Simulator」區塊
4. 確認 Dropdown 預設為「Expedite by 1 bucket」
5. 點擊「Simulate」按鈕

**預期結果：**
```
✅ 顯示 "Simulated Change"
   • Move 2026-W07 → 2026-W06
   • Qty: 150

✅ 顯示 Before vs After 對比
   Before: Status CRITICAL, Next: N/A
   After:  Status WARNING ↑, Next: 2026-W06

✅ 顯示 Impact Summary
   ✅ Status improved: CRITICAL → WARNING
   Profit at Risk: +$0（簡化版未變）
```

**驗收點：**
- [x] Dropdown 變為 disabled
- [x] Simulate 按鈕變為 Reset 按鈕
- [x] Before 顯示正確的原始狀態
- [x] After 顯示 Status 改善（帶 ↑ 圖示）
- [x] Impact Summary 顯示「Status improved」

---

### Test 2: Expedite by 2/3 Buckets

**步驟：**
1. 開啟任一 CRITICAL 列的 DetailsPanel
2. 在 What-if Simulator 區塊選擇「Expedite by 2 buckets」
3. 點擊「Simulate」

**預期結果：**
```
✅ Simulated Change 顯示正確的 from/to bucket
   • Move 2026-W08 → 2026-W06（提前 2 buckets）
```

**步驟（續）：**
4. 點擊「Reset」
5. 選擇「Expedite by 3 buckets」
6. 點擊「Simulate」

**預期結果：**
```
✅ Simulated Change 顯示正確的 from/to bucket
   • Move 2026-W08 → 2026-W05（提前 3 buckets）
```

**驗收點：**
- [x] Expedite by 2 buckets 正確計算
- [x] Expedite by 3 buckets 正確計算
- [x] Reset 正確清空結果

---

### Test 3: Reset 功能

**步驟：**
1. 開啟任一列的 DetailsPanel
2. 執行 Simulate
3. 確認顯示模擬結果
4. 點擊「Reset」按鈕

**預期結果：**
```
✅ 模擬結果消失
✅ Dropdown 恢復可編輯
✅ Reset 按鈕變回 Simulate 按鈕
```

**驗收點：**
- [x] Reset 正確清空 simulationResult
- [x] Dropdown 恢復可編輯
- [x] 可以再次 Simulate

---

### Test 4: 無 Inbound（NO_INBOUND）

**步驟：**
1. 找一個 Status = CRITICAL 且 Inbound count = 0 的列
2. 開啟 DetailsPanel
3. 確認 PO 列表顯示「未來 3 buckets 內無 PO」
4. 在 What-if Simulator 點擊「Simulate」

**預期結果：**
```
⚠️ No inbound to expedite
This item has no PO within available horizon.
```

**驗收點：**
- [x] 顯示錯誤訊息（而非 crash）
- [x] 可以點擊 Reset
- [x] Reset 後可以切換 Dropdown

---

### Test 5: 切換不同列

**步驟：**
1. 開啟列 A 的 DetailsPanel
2. 執行 Simulate，確認有模擬結果
3. 不要 Reset，直接點擊列 B
4. 確認 DetailsPanel 切換到列 B

**預期結果：**
```
✅ DetailsPanel 顯示列 B 的資訊
✅ What-if Simulator 恢復初始狀態（無模擬結果）
✅ Dropdown 可編輯
```

**驗收點：**
- [x] 切換列時 simulationResult 自動清空
- [x] 不會保留上一列的模擬結果

---

### Test 6: Bucket Shift 跨年

**手動測試（需要特定資料）：**

**情境 1：W01 往前**
```javascript
// 準備資料：2026-W01 的 PO
// Expedite by 1 bucket
// 預期：2025-W52
```

**情境 2：W52 往後（反向測試）**
```javascript
// 準備資料：2025-W52 的 PO
// 若要測試往後，需修改 domain 函數（當前只支援 expedite 往前）
```

**驗收點：**
- [x] 跨年正確處理（W01 → W52）
- [x] 不會出現 W00 或 W53

---

### Test 7: Status 改善邏輯

**測試矩陣：**

| Before    | After     | Expected Delta                    |
|-----------|-----------|-----------------------------------|
| CRITICAL  | WARNING   | ✅ Status improved                |
| CRITICAL  | OK        | ✅ Status improved                |
| WARNING   | OK        | ✅ Status improved                |
| WARNING   | WARNING   | ➡️ Status unchanged               |
| WARNING   | CRITICAL  | ⚠️ Status changed（退化，理論上不會）|

**驗收點：**
- [x] 改善顯示 ✅ + 綠色
- [x] 不變顯示 ➡️ + 灰色
- [x] 退化顯示 ⚠️ + 紅色

---

## 🐛 已知限制與預期行為

### 1. Profit at Risk 不變

**現象：**
```
Before: Profit at Risk: $12,500
After:  Profit at Risk: $12,500
Delta:  +$0
```

**原因：** 簡化版評估，Gap Qty 使用原始值

**預期：** 這是正常的（MVP 階段）

---

### 2. 只處理最早一筆 PO

**現象：** 只有最早的 bucket 被移動

**原因：** MVP 只支援單筆 expedite

**預期：** 這是設計如此

---

### 3. Status 改善但 P@R 不變

**現象：**
```
✅ Status improved: CRITICAL → WARNING
Profit at Risk: +$0
```

**原因：** 簡化版未重算 Gap Qty

**預期：** Phase 2 會完整重算

---

## 🔍 Debug 工具

### 1. Console Log（開發用）

**在 DetailsPanel.jsx 的 handleSimulate() 中加入：**
```javascript
const handleSimulate = () => {
  const result = simulateWhatIfExpedite({ ... });
  console.log('📊 Simulation Result:', result);  // Debug
  setSimulationResult(result);
};
```

### 2. 檢查 Domain 輸出

**在 Browser Console：**
```javascript
import { simulateWhatIfExpedite } from './src/domains/risk/whatIfExpedite.js';

const result = simulateWhatIfExpedite({
  poLines: [
    { timeBucket: '2026-W07', qty: 150, poNumber: 'PO-001', poLine: '001' }
  ],
  rowContext: {
    item: 'PART-A101',
    factory: 'FAC-TW01',
    onHand: 50,
    safetyStock: 100,
    profitPerUnit: 10
  },
  expediteBuckets: 1,
  horizonBuckets: 3
});

console.log(result);
```

---

## ✅ 完整測試檢查清單

### Domain 層
- [x] `shiftBucket()` 正確處理跨年
- [x] `buildInboundScheduleFromPOLines()` 正確合併 qty
- [x] `simulateExpediteInbound()` 正確移動最早 bucket
- [x] `evaluateSimulation()` 正確計算 Before/After/Delta
- [x] 無 console 語句

### UI 層
- [x] Dropdown 選擇 1/2/3 buckets
- [x] Simulate 按鈕觸發模擬
- [x] Reset 按鈕清空結果
- [x] Before vs After 正確顯示
- [x] Impact Summary 正確顯示
- [x] NO_INBOUND 錯誤處理
- [x] 切換列時自動清空

### 互動流程
- [x] Simulate → 顯示結果
- [x] Reset → 清空結果
- [x] 切換 Dropdown → 更新 expediteBuckets
- [x] 切換列 → 自動 Reset

### 邊界條件
- [x] 無 inbound（NO_INBOUND）
- [x] Bucket shift 跨年
- [x] Status 改善/不變/退化

---

## 🎉 測試通過標準

### 基本功能
- ✅ 所有測試案例通過
- ✅ 無 console 錯誤
- ✅ 無 React warning
- ✅ UI 響應正常（無卡頓）

### 使用者體驗
- ✅ 互動流暢（Simulate/Reset）
- ✅ 錯誤訊息清晰（NO_INBOUND）
- ✅ Before/After 對比直觀
- ✅ Impact Summary 易懂

### 技術品質
- ✅ 無 linter 錯誤
- ✅ Domain 層無副作用
- ✅ State 管理正確（不污染全局）
- ✅ 邊界條件處理完善

---

**測試完成後，What-if Simulator (Expedite MVP) 即可 Demo！** 🚀
