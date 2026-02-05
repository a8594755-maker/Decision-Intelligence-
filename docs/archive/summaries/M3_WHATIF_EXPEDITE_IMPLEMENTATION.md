# M3: What-if Simulator - Expedite MVP 實現總結

## 🎯 目標

在 Risk Dashboard 的 DetailsPanel 加入 What-if 模擬器，專注於「提前到貨 (Expedite)」單一情境。

---

## ✅ 完成的功能

### 核心功能
- ✅ **Expedite Simulation**: 模擬將最早一筆 PO 提前 1/2/3 buckets
- ✅ **Before vs After 對比**: 顯示 Status、Next Bucket、Profit at Risk 變化
- ✅ **Impact Summary**: 計算並顯示 Delta（狀態改善、金額變化）
- ✅ **Reset 功能**: 可恢復到原始狀態
- ✅ **Pure Function Design**: Domain 層無副作用（無 console）

---

## 📂 修改/新增檔案清單

### 新增檔案（1 個）

1. ✅ **`src/domains/risk/whatIfExpedite.js`** - Domain 層模擬器（Pure Functions）
   - `shiftBucket()` - Bucket 前移/後移工具
   - `buildInboundScheduleFromPOLines()` - 從 PO 列表建立 Schedule
   - `simulateExpediteInbound()` - 模擬提前到貨
   - `scheduleToPOLines()` - Schedule 轉 PO Lines
   - `evaluateSimulation()` - 評估 Before vs After
   - `simulateWhatIfExpedite()` - All-in-one 完整流程

### 修改檔案（1 個）

2. ✅ **`src/components/risk/DetailsPanel.jsx`** - 加入 What-if UI 區塊
   - Import `Zap` 和 `RotateCcw` icons
   - Import `simulateWhatIfExpedite` from domain
   - 新增 `expediteBuckets` state（1/2/3 buckets）
   - 新增 `simulationResult` state
   - 新增 `handleSimulate()` 函數
   - 新增 `handleReset()` 函數
   - 新增 Section 6: What-if Simulator UI 區塊
   - 更新 Footer Note（加入 whatIfExpedite.js）

### 新增文檔（1 個）

3. 📄 **`M3_WHATIF_EXPEDITE_IMPLEMENTATION.md`** - 本實現總結

---

## 🔧 實現細節

### 1. Domain 層：whatIfExpedite.js

#### 1.1 Bucket 操作工具

**功能：** 處理週別前移/後移，支援跨年

```javascript
shiftBucket("2026-W07", -1) // => "2026-W06"
shiftBucket("2026-W01", -1) // => "2025-W52"
shiftBucket("2026-W52", +1) // => "2027-W01"
```

**邊界處理：**
- 跨年處理（W01 往前 → 上一年 W52）
- 支援正負偏移
- 無法解析的格式回傳原值

---

#### 1.2 建立 Inbound Schedule

**輸入：** PO Lines（含 `timeBucket`, `qty`）

**輸出：**
```javascript
{
  schedule: Map<bucket, totalQty>,  // 如 "2026-W07" -> 150
  sortedBuckets: ["2026-W05", "2026-W07", "2026-W09"],
  totalQty: 500
}
```

**處理：**
- 合併相同 bucket 的 qty
- 按字串順序排序（YYYY-W## 格式可直接排序）
- 過濾無效資料（空 bucket 或 qty <= 0）

---

#### 1.3 模擬提前到貨

**規則：**
1. 找到最早的 inbound bucket（`sortedBuckets[0]`）
2. 將該 bucket 的**所有 qty** 移到「提前 N buckets」的新 bucket
3. 若新 bucket 已有 qty，則累加
4. 若無 inbound，回傳 `{ success: false, reason: 'NO_INBOUND' }`

**範例：**
```javascript
// Before
schedule: { "2026-W07": 150, "2026-W09": 200 }

// After (expedite by 1 bucket)
schedule: { "2026-W06": 150, "2026-W09": 200 }

// Changes
{
  fromBucket: "2026-W07",
  toBucket: "2026-W06",
  qty: 150
}
```

**注意：** 只處理最早一筆，不處理多筆

---

#### 1.4 評估模擬結果

**輸入：**
- `rowContext`（含 item, factory, onHand, safetyStock, profitPerUnit）
- `beforeSchedule` 和 `afterSchedule`
- `horizonBuckets`（如 3）

**輸出：**
```javascript
{
  before: {
    status: 'CRITICAL',
    nextBucket: 'N/A',
    inboundCount: 0,
    inboundQty: 0,
    gapQty: 100,
    profitAtRisk: 1000
  },
  after: {
    status: 'WARNING',
    nextBucket: '2026-W06',
    inboundCount: 1,
    inboundQty: 150,
    gapQty: 100,
    profitAtRisk: 1000
  },
  delta: {
    statusChanged: true,
    statusImproved: true,  // CRITICAL → WARNING
    nextBucketChanged: true,
    profitAtRiskDelta: 0,  // 簡化版未變（完整版需重算 gapQty）
    gapDelta: 0,
    inboundCountDelta: 1,
    inboundQtyDelta: 150
  }
}
```

**風險評估邏輯（簡化版）：**
```javascript
// 與 coverageCalculator 邏輯一致
if (inboundCount === 0) {
  status = 'CRITICAL';
} else if (inboundCount === 1 || inboundQty < 10) {
  status = 'WARNING';
} else {
  status = 'OK';
}
```

**簡化點：**
- Gap Qty：使用原始值（未考慮 expedite 後的實際到貨時間影響）
- Profit at Risk：使用原始 profitPerUnit（未考慮時間折現）
- 完整版需呼叫 `coverageCalculator` 重算

---

#### 1.5 All-in-one 完整流程

**功能：** 一次性完成所有步驟

```javascript
const result = simulateWhatIfExpedite({
  poLines: details.poDetails,          // PO 明細
  rowContext: {                         // 當前列上下文
    item: details.item,
    factory: details.plantId,
    onHand: details.onHand,
    safetyStock: details.safetyStock,
    profitPerUnit: details.profitPerUnit
  },
  expediteBuckets: 1,                   // 提前 1 bucket
  horizonBuckets: 3                     // Horizon 3 buckets
});
```

---

### 2. DetailsPanel UI

#### 2.1 State 管理

```javascript
const [expediteBuckets, setExpediteBuckets] = useState(1);     // 提前 N buckets
const [simulationResult, setSimulationResult] = useState(null); // 模擬結果
```

**特點：**
- State 只存在於 DetailsPanel（不污染全局）
- 切換不同列時，simulationResult 自動清空
- Reset 時清空 simulationResult

---

#### 2.2 UI 區塊結構

```
┌─────────────────────────────────────────────────┐
│ ⚡ What-if Simulator [MVP]                     │
├─────────────────────────────────────────────────┤
│ Scenario: Expedite earliest inbound             │
│ [Dropdown: Expedite by 1/2/3 buckets]          │
│ [Simulate Button] 或 [Reset Button]            │
├─────────────────────────────────────────────────┤
│ 📦 Simulated Change:                            │
│   • Move 2026-W07 → 2026-W06                   │
│   • Qty: 150                                    │
├─────────────────────────────────────────────────┤
│ Before          │ After                         │
│ ─────────────── │ ───────────────               │
│ Status: CRITICAL│ Status: WARNING ↑             │
│ Next: N/A       │ Next: 2026-W06                │
│ P@R: $1,000     │ P@R: $1,000                   │
├─────────────────────────────────────────────────┤
│ 📊 Impact Summary                               │
│ ✅ Status improved: CRITICAL → WARNING         │
│ Profit at Risk: +$0                             │
├─────────────────────────────────────────────────┤
│ 💡 This is a simplified simulation.            │
│    Actual results may vary.                     │
└─────────────────────────────────────────────────┘
```

---

#### 2.3 互動流程

**步驟 1：初始狀態**
```
[Dropdown: Expedite by 1 bucket]
[Simulate Button]
```

**步驟 2：點擊 Simulate**
```javascript
handleSimulate() {
  const result = simulateWhatIfExpedite({ ... });
  setSimulationResult(result);
}
```

**步驟 3：顯示結果**
- Dropdown 變為 disabled
- Simulate 按鈕變為 Reset 按鈕
- 顯示 Before vs After 對比
- 顯示 Impact Summary

**步驟 4：點擊 Reset**
```javascript
handleReset() {
  setSimulationResult(null);
}
```
- 清空模擬結果
- Dropdown 恢復可編輯
- 按鈕變回 Simulate

---

#### 2.4 錯誤處理

**情境 1：無 PO（NO_INBOUND）**
```jsx
⚠️ No inbound to expedite
This item has no PO within available horizon.
```

**情境 2：成功模擬**
- 顯示完整 Before vs After
- 顯示 Impact Summary

---

### 3. 風險評估邏輯

#### 3.1 Status 改善判定

```javascript
delta.statusImproved = (
  (before.status === 'CRITICAL' && after.status === 'WARNING') ||
  (before.status === 'CRITICAL' && after.status === 'OK') ||
  (before.status === 'WARNING' && after.status === 'OK')
);
```

**顯示：**
- ✅ Status improved: CRITICAL → WARNING
- ⚠️ Status changed: WARNING → CRITICAL（退化）
- ➡️ Status unchanged: CRITICAL

---

#### 3.2 Profit at Risk Delta

```javascript
delta.profitAtRiskDelta = after.profitAtRisk - before.profitAtRisk;
```

**顏色：**
- 綠色：Delta < 0（風險下降）
- 紅色：Delta > 0（風險上升）
- 灰色：Delta = 0（無變化）

---

## 📊 邊界條件處理

### 1. Bucket Shift 跨年

```javascript
shiftBucket("2026-W01", -1) // => "2025-W52"
shiftBucket("2026-W52", +1) // => "2027-W01"
```

**處理邏輯：**
- 簡化版假設每年 52 週
- 支援多年偏移（如 -60 buckets）

---

### 2. 無 Inbound

**情境：** 當前列在 horizon 內無 PO

**處理：**
```javascript
{
  success: false,
  reason: 'NO_INBOUND',
  before: null,
  after: null,
  delta: null,
  changes: null
}
```

**UI 顯示：**
```jsx
⚠️ No inbound to expedite
This item has no PO within available horizon.
```

---

### 3. Expedite 到負數週別

**範例：** 當前是 2026-W02，提前 3 buckets

```javascript
shiftBucket("2026-W02", -3) // => "2025-W51"
```

**處理：** 自動跨年，無需特殊處理

---

### 4. 相同 Bucket 累加

**範例：** Expedite 後新 bucket 已有 PO

```javascript
// Before
schedule: { "2026-W06": 50, "2026-W07": 150 }

// Expedite W07 by 1 bucket
schedule: { "2026-W06": 200, "2026-W07": 0 }
//                      ^^^^ 累加 50 + 150
```

---

## ✅ 驗收標準

### Domain 層
- [x] 無 console 語句（Pure Function）
- [x] Bucket shift 支援跨年
- [x] 正確處理無 inbound 情境
- [x] 正確評估 Before vs After
- [x] 正確計算 Delta

### UI 層
- [x] Dropdown 選擇提前 buckets 數量
- [x] Simulate 按鈕觸發模擬
- [x] Reset 按鈕清空結果
- [x] 顯示 Before vs After 對比
- [x] 顯示 Impact Summary
- [x] 錯誤處理（NO_INBOUND）
- [x] State 只在 DetailsPanel（不污染全局）

### 技術檢查
- [x] 無 linter 錯誤
- [x] 不新增 npm 依賴
- [x] 不改舊 Views
- [x] Domain 層無副作用

---

## 🎯 限制與假設

### 當前限制
1. **只處理最早一筆 PO**
   - 不支援批量 expedite
   - 不支援選擇特定 PO

2. **簡化風險評估**
   - Gap Qty 使用原始值（未考慮提前到貨的實際影響）
   - Profit at Risk 未考慮時間折現
   - 完整版需呼叫 `coverageCalculator` 重算

3. **只做 Expedite**
   - 不支援取消 PO
   - 不支援減量
   - 不支援新增 PO
   - 不支援改需求

### 假設
- 每年 52 週（簡化版）
- Bucket 格式：YYYY-W##
- Profit per unit 固定（不考慮時間因素）

---

## 📈 未來擴展方向

### Phase 2: 完整評估
- 呼叫 `coverageCalculator` 重算完整風險
- 考慮提前到貨對 Gap Qty 的實際影響
- 考慮時間折現（Profit at Risk 隨時間衰減）

### Phase 3: 多情境支援
- 取消 PO
- 減量 PO
- 新增 PO
- 調整需求

### Phase 4: 批量模擬
- 選擇多筆 PO 同時 expedite
- 跨 item 批量模擬
- 全局優化建議

---

## 🎉 M3 完成狀態

### 完整功能清單
- ✅ **M1: Supply Coverage Risk (Bucket-Based)**
- ✅ **M2: Profit at Risk (Monetization)**
- ✅ **M3: What-if Simulator (Expedite MVP)**
- ✅ **Diagnostics (Inv/PO/Union/Matched/Inbound)**
- ✅ **Transparency (Assumption 標示)**
- ✅ **Domain 純度（無副作用）**
- ✅ **Sample Data Removed（Production-ready）**

### Demo 準備度
- 🚀 **Always Demo-able**: Expedite 模擬永遠可用
- 📈 **Interactive**: 使用者可自由調整參數
- 💡 **Transparent**: 清楚顯示 Before/After/Delta
- 🔧 **Professional**: Domain 純度 + 合理簡化

---

## 📝 使用範例

### 範例 1：改善 CRITICAL 狀態

**Before:**
```
Status: CRITICAL
Next bucket: N/A
Inbound count: 0
Profit at Risk: $12,500
```

**操作：** Expedite by 1 bucket

**After:**
```
Status: WARNING ↑
Next bucket: 2026-W06
Inbound count: 1
Profit at Risk: $12,500
```

**Impact:**
```
✅ Status improved: CRITICAL → WARNING
Profit at Risk: +$0
```

---

### 範例 2：無改善（WARNING → WARNING）

**Before:**
```
Status: WARNING
Next bucket: 2026-W08
Inbound count: 1
Profit at Risk: $5,000
```

**操作：** Expedite by 2 buckets

**After:**
```
Status: WARNING
Next bucket: 2026-W06
Inbound count: 1
Profit at Risk: $5,000
```

**Impact:**
```
➡️ Status unchanged: WARNING
Profit at Risk: +$0
```

**原因：** Inbound count 仍為 1（仍觸發 WARNING）

---

### 範例 3：無 Inbound

**Before:**
```
Status: CRITICAL
Next bucket: N/A
Inbound count: 0
Profit at Risk: $20,000
```

**操作：** Expedite by 1 bucket

**結果：**
```
⚠️ No inbound to expedite
This item has no PO within available horizon.
```

---

**實現完成時間：** 2026-02-04  
**版本：** M3 - What-if Simulator (Expedite MVP)  
**測試狀態：** ✅ 通過 linter 檢查  
**Demo 狀態：** ✅ Ready for interactive demo
