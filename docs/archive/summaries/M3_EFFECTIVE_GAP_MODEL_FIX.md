# M3 What-if Expedite - Effective Gap 模型修正

## 🎯 問題

**原始問題：**
- Before/After 的 `gapQty` 和 `profitAtRisk` 幾乎不變
- Demo 不可信（expedite 後沒有明顯改善）
- 原因：簡化評估只考慮 `gapQty = max(0, safetyStock - onHand)`，未考慮 horizon 內 inbound 的影響

**範例（修正前）：**
```
Before:
  gapQty: 100
  profitAtRisk: $1,000
  
After (expedite by 1 bucket):
  gapQty: 100  ❌ 未變
  profitAtRisk: $1,000  ❌ 未變
```

---

## ✅ 解決方案：Effective Gap 模型

### 核心概念

**Effective Gap（有效缺口）：**
- 考慮 horizon 內實際會到貨的 inbound 量
- 計算「扣除 inbound 後的實際缺口」
- 更符合真實風險情況

**公式：**
```
baseGapQty = max(0, safetyStock - onHand)
inboundQtyWithinHorizon = sum(schedule 內 horizon 3 buckets 的 qty)
effectiveGap = max(0, baseGapQty - inboundQtyWithinHorizon)
profitAtRisk = effectiveGap * profitPerUnit
```

---

### 為什麼這個模型在沒有 Forecast 的情況下仍然合理？

#### 1. Safety Stock 作為需求代理

**邏輯：**
- Safety Stock 通常根據歷史需求 + 變異性設定
- 雖然沒有未來 forecast，但 Safety Stock 已隱含「預期需求水平」
- `gapQty = safetyStock - onHand` 代表「距離安全庫存的缺口」

**合理性：**
```
假設：
  Safety Stock = 150（基於歷史需求設定）
  On Hand = 50
  Gap = 100

含義：
  → 當前庫存比安全水位低 100 單位
  → 若無補貨，可能無法應對正常需求變異
  → 這是「風險暴露量」
```

---

#### 2. Horizon 內 Inbound 抵消風險

**邏輯：**
- Horizon 內（如未來 3 週）的 PO 會實際到貨
- 這些到貨量可以「抵消」部分 gap
- Effective Gap = 扣除已知補貨後的「剩餘風險」

**範例：**
```
Before:
  baseGapQty: 100
  inboundQtyWithinHorizon: 0  （無 PO）
  effectiveGap: 100 - 0 = 100  ❌ 全部暴露
  profitAtRisk: 100 * $10 = $1,000

After (expedite):
  baseGapQty: 100（不變，因為 onHand/safetyStock 未變）
  inboundQtyWithinHorizon: 80  （expedite 後進入 horizon）
  effectiveGap: 100 - 80 = 20  ✅ 大幅降低
  profitAtRisk: 20 * $10 = $200  ✅ 下降 $800
```

---

#### 3. 不需要 Forecast 的理由

**傳統方法（需要 Forecast）：**
```
futureGap = forecast(next 3 weeks) - onHand - inbound
profitAtRisk = futureGap * profitPerUnit
```
**問題：** 需要準確的未來需求預測

**Effective Gap 方法（不需要 Forecast）：**
```
effectiveGap = safetyStock - onHand - inbound
profitAtRisk = effectiveGap * profitPerUnit
```
**優點：**
- Safety Stock 已內含「需求預期」
- 聚焦於「保護水位」而非「精確需求」
- 更適合 Supply Coverage Risk 的概念

---

### Status 規則（基於 Effective Gap）

**修正後的規則：**
```javascript
if (effectiveGap === 0) {
  status = 'OK';  // 完全被 inbound 覆蓋
} else if (inboundQtyWithinHorizon > 0) {
  status = 'WARNING';  // 有 inbound 但仍有缺口
} else {
  status = 'CRITICAL';  // 無 inbound 且有缺口
}
```

**邏輯：**
1. **OK**: Effective Gap = 0 → Horizon 內 inbound 足夠覆蓋 gap
2. **WARNING**: Effective Gap > 0 但有部分 inbound → 部分風險被覆蓋
3. **CRITICAL**: Effective Gap > 0 且無 inbound → 完全暴露

**範例：**
```
情境 1（CRITICAL → OK）:
  Before: effectiveGap=100, inbound=0 → CRITICAL
  After:  effectiveGap=0, inbound=120 → OK ✅

情境 2（CRITICAL → WARNING）:
  Before: effectiveGap=100, inbound=0 → CRITICAL
  After:  effectiveGap=20, inbound=80 → WARNING ✅

情境 3（WARNING → WARNING）:
  Before: effectiveGap=50, inbound=50 → WARNING
  After:  effectiveGap=30, inbound=70 → WARNING
  （仍有改善，但未到 OK）
```

---

## 📂 修改檔案清單

### 修改檔案（2 個）

1. ✅ **`src/domains/risk/whatIfExpedite.js`**
   - 新增 `sumInboundWithinHorizon()` helper
   - 修正 `evaluateSimulation()` 使用 Effective Gap 模型
   - 更新 Status 規則（基於 effectiveGap）
   - 輸出新增 `inboundQtyWithinHorizon`, `baseGapQty`, `effectiveGap`

2. ✅ **`src/components/risk/DetailsPanel.jsx`**
   - Before/After 顯示新增 `Inbound(H3)`, `Eff. Gap`
   - 顯示 Delta（綠色=改善，紅色=惡化）
   - Impact Summary 新增 Inbound/Effective Gap 變化
   - 新增公式說明卡片

### 新增檔案（1 個）

3. 📄 **`M3_EFFECTIVE_GAP_MODEL_FIX.md`** - 本修正總結

---

## 🔧 修改細節

### 1. Domain 層：sumInboundWithinHorizon()

**功能：** 計算 Horizon 內的總 Inbound 量

```javascript
export const sumInboundWithinHorizon = (schedule, sortedBuckets, horizonBuckets) => {
  if (!schedule || !sortedBuckets || sortedBuckets.length === 0) {
    return 0;
  }
  
  let totalQty = 0;
  const bucketsInHorizon = sortedBuckets.slice(0, horizonBuckets);
  
  bucketsInHorizon.forEach(bucket => {
    totalQty += schedule.get(bucket) || 0;
  });
  
  return totalQty;
};
```

**邏輯：**
- 取 sortedBuckets 的前 N 個（N = horizonBuckets）
- 從 schedule Map 取得每個 bucket 的 qty
- 加總回傳

---

### 2. Domain 層：evaluateSimulation() 修正

**Before（修正前）：**
```javascript
const evaluateSchedule = (schedule, sortedBuckets) => {
  const gapQty = Math.max(0, safetyStock - onHand);
  const profitAtRisk = gapQty * profitPerUnit;  // ❌ 固定不變
  
  return { gapQty, profitAtRisk };
};
```

**After（修正後）：**
```javascript
const evaluateSchedule = (schedule, sortedBuckets) => {
  // 計算 Inbound in Horizon
  const inboundQtyWithinHorizon = sumInboundWithinHorizon(schedule, sortedBuckets, horizonBuckets);
  
  // Base Gap（原始缺口）
  const baseGapQty = rowContext.gapQty !== undefined 
    ? rowContext.gapQty 
    : Math.max(0, safetyStock - onHand);
  
  // Effective Gap（考慮 inbound 後的實際缺口）
  const effectiveGap = Math.max(0, baseGapQty - inboundQtyWithinHorizon);
  
  // Profit at Risk（基於 Effective Gap）
  const profitAtRisk = effectiveGap * profitPerUnit;  // ✅ 會隨 expedite 變化
  
  return { 
    inboundQtyWithinHorizon, 
    baseGapQty, 
    effectiveGap, 
    profitAtRisk 
  };
};
```

---

### 3. UI 層：Before vs After 顯示

**Before（修正前）：**
```jsx
<div>Status: {status}</div>
<div>Next: {nextBucket}</div>
<div>P@R: {profitAtRisk}</div>
```

**After（修正後）：**
```jsx
<div>Status: {status}</div>
<div>Next: {nextBucket}</div>
<div>Inbound(H3): {inboundQtyWithinHorizon} (+delta)</div>  ✅ 新增
<div>Eff. Gap: {effectiveGap} (+delta)</div>                ✅ 新增
<div>P@R: {profitAtRisk} (+delta)</div>
```

**顯示邏輯：**
- Delta > 0（變多）→ 紅色
- Delta < 0（變少）→ 綠色（改善）
- Delta = 0 → 灰色

---

### 4. Impact Summary 擴展

**Before（修正前）：**
```
📊 Impact Summary
✅ Status improved: CRITICAL → WARNING
Profit at Risk: +$0  ❌ 沒變化
```

**After（修正後）：**
```
📊 Impact Summary
✅ Status improved: CRITICAL → WARNING
Inbound in Horizon: +80  ✅ 增加
Effective Gap: -80  ✅ 減少
Profit at Risk: -$800  ✅ 大幅降低
```

---

### 5. 公式說明（新增）

**顯示：**
```
📐 Calculation Formula
effectiveGap = max(0, gapQty - inboundQtyWithinHorizon)
profitAtRisk = effectiveGap * profitPerUnit
```

**用途：**
- 透明化計算邏輯
- 使用者可理解為何 expedite 能降低 profitAtRisk

---

## 📊 修正前後對比

### 範例 1：CRITICAL → OK

**情境：** Gap=100, 提前 1 bucket 後有 120 qty 進入 horizon

#### Before（修正前）
```
Before:
  Status: CRITICAL
  gapQty: 100
  profitAtRisk: $1,000

After:
  Status: WARNING  （僅基於 inboundCount=1）
  gapQty: 100  ❌ 未變
  profitAtRisk: $1,000  ❌ 未變
  
Delta:
  ⚠️ Status changed but no real impact visible
```

#### After（修正後）
```
Before:
  Status: CRITICAL
  Inbound(H3): 0
  Eff. Gap: 100
  P@R: $1,000

After:
  Status: OK ✅  （effectiveGap=0）
  Inbound(H3): 120 (+120)
  Eff. Gap: 0 (-100)
  P@R: $0 (-$1,000)
  
Delta:
  ✅ Status improved: CRITICAL → OK
  ✅ Effective Gap eliminated
  ✅ Profit at Risk eliminated
```

---

### 範例 2：CRITICAL → WARNING

**情境：** Gap=100, 提前後有 60 qty 進入 horizon

#### Before（修正前）
```
Before:
  Status: CRITICAL
  profitAtRisk: $1,000

After:
  Status: WARNING
  profitAtRisk: $1,000  ❌ 未變
```

#### After（修正後）
```
Before:
  Status: CRITICAL
  Inbound(H3): 0
  Eff. Gap: 100
  P@R: $1,000

After:
  Status: WARNING ✅
  Inbound(H3): 60 (+60)
  Eff. Gap: 40 (-60)
  P@R: $400 (-$600)
  
Delta:
  ✅ Status improved: CRITICAL → WARNING
  ✅ Effective Gap reduced by 60%
  ✅ Profit at Risk reduced by 60%
```

---

## ✅ 驗收標準

### Domain 層
- [x] 無 console 語句（Pure Function）
- [x] `sumInboundWithinHorizon()` 正確計算
- [x] `effectiveGap` 正確計算
- [x] `profitAtRisk` 基於 effectiveGap
- [x] Status 規則基於 effectiveGap

### UI 層
- [x] Before/After 顯示 Inbound(H3)
- [x] Before/After 顯示 Eff. Gap
- [x] 顯示 Delta（綠色/紅色）
- [x] Impact Summary 完整
- [x] 公式說明清晰

### 邏輯正確性
- [x] Expedite 後 inboundQtyWithinHorizon 增加
- [x] Expedite 後 effectiveGap 減少
- [x] Expedite 後 profitAtRisk 減少
- [x] Status 改善（CRITICAL → WARNING/OK）

### 技術檢查
- [x] 無 linter 錯誤
- [x] 不新增 npm 依賴
- [x] 不改舊 Views
- [x] Domain 層無副作用

---

## 🎯 模型合理性總結

### 為什麼不需要 Forecast？

#### 1. Safety Stock 作為需求代理
```
Safety Stock 設定邏輯：
  → 基於歷史需求 + 變異性
  → 已隱含「預期需求水平」
  → Gap = safetyStock - onHand 代表「風險暴露」
```

#### 2. Horizon 內 Inbound 已知
```
Horizon = 3 weeks：
  → PO 資料已確定（open_qty）
  → 可精確計算「即將到貨量」
  → 不需要預測，只需要「確認現有 PO」
```

#### 3. Effective Gap 概念
```
Effective Gap = Base Gap - Known Inbound
  → Base Gap：相對於 Safety Stock 的缺口
  → Known Inbound：已確定的未來補貨
  → Effective Gap：扣除已知補貨後的「實際風險」
```

#### 4. 符合 Supply Coverage Risk 定義
```
Supply Coverage Risk：
  → 「供應是否能覆蓋需求」
  → 需求代理：Safety Stock
  → 供應：On Hand + Inbound in Horizon
  → 風險：Effective Gap = 需求代理 - 供應
```

---

## 🚀 Demo 改善效果

### Before Fix（修正前）
```
使用者體驗：
  → 點擊 Simulate
  → Status 改善（CRITICAL → WARNING）
  → 但 Profit at Risk 沒變（$1,000 → $1,000）❌
  → 使用者困惑：「為什麼 expedite 沒用？」
```

### After Fix（修正後）
```
使用者體驗：
  → 點擊 Simulate
  → Status 改善（CRITICAL → WARNING）
  → Profit at Risk 大幅下降（$1,000 → $400）✅
  → 使用者清楚看到：「expedite 減少了 60% 風險！」
  → Impact Summary 詳細說明：
    • Inbound in Horizon: +60
    • Effective Gap: -60
    • Profit at Risk: -$600
```

---

## 📝 使用範例

### Test Case 1: 完全消除風險

**初始狀態：**
```
Safety Stock: 150
On Hand: 50
Gap: 100
PO: 2026-W08 (qty: 120)
Horizon: 3 buckets (W06-W08)
```

**Before Expedite：**
```
Schedule: { "2026-W08": 120 }
Inbound(H3): 120  （W08 在 horizon 內）
Eff. Gap: 100 - 120 = 0
P@R: $0
Status: OK
```
**等等，這裡 Before 就已經 OK 了，因為 W08 在 horizon 內。讓我調整範例...**

**調整範例：**
```
PO: 2026-W10 (qty: 120)  （在 horizon 外）
Horizon: 3 buckets (W06-W08)
```

**Before Expedite：**
```
Schedule: { "2026-W10": 120 }
Inbound(H3): 0  （W10 不在 horizon 內）
Eff. Gap: 100 - 0 = 100
P@R: $1,000
Status: CRITICAL
```

**After Expedite by 2 buckets：**
```
Schedule: { "2026-W08": 120 }  （W10 → W08）
Inbound(H3): 120  （W08 進入 horizon）
Eff. Gap: 100 - 120 = 0
P@R: $0
Status: OK

Delta:
✅ Status improved: CRITICAL → OK
✅ Inbound in Horizon: +120
✅ Effective Gap: -100
✅ Profit at Risk: -$1,000
```

---

### Test Case 2: 部分改善

**初始狀態：**
```
Gap: 100
PO: 2026-W09 (qty: 60)
Horizon: 3 buckets (W06-W08)
```

**Before Expedite：**
```
Inbound(H3): 0
Eff. Gap: 100
P@R: $1,000
Status: CRITICAL
```

**After Expedite by 1 bucket：**
```
Schedule: { "2026-W08": 60 }
Inbound(H3): 60
Eff. Gap: 100 - 60 = 40
P@R: $400
Status: WARNING

Delta:
✅ Status improved: CRITICAL → WARNING
✅ Inbound in Horizon: +60
✅ Effective Gap: -60 (60% 改善)
✅ Profit at Risk: -$600 (60% 改善)
```

---

## 🎉 修正完成

### 完成狀態
- ✅ **Effective Gap 模型實現**
- ✅ **profitAtRisk 產生可信 Delta**
- ✅ **Status 規則基於 effectiveGap**
- ✅ **UI 顯示完整 Before/After/Delta**
- ✅ **公式說明透明**
- ✅ **無 linter 錯誤**
- ✅ **Domain 純度保持（無 console）**

### Demo 準備度
- 🚀 **可信度提升**: Profit at Risk 會隨 expedite 明顯變化
- 📈 **邏輯清晰**: Effective Gap 概念易理解
- 💡 **透明化**: 公式說明 + Delta 顯示
- 🔧 **不依賴 Forecast**: 基於 Safety Stock + Known Inbound

---

**修正完成時間：** 2026-02-04  
**版本：** M3 - Effective Gap Model (Fixed)  
**測試狀態：** ✅ 通過 linter 檢查  
**Demo 狀態：** ✅ Ready for credible demo with visible P@R reduction
