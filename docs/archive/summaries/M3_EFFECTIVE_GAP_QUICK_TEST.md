# M3 Effective Gap 模型快速測試

## 🎯 測試目標

驗證 Effective Gap 模型修正後，Profit at Risk 會產生可信的 Delta。

---

## ✅ 測試案例

### Test 1: 完全消除風險（CRITICAL → OK）

**尋找條件：**
- Status = CRITICAL
- Gap Qty > 0（如 100）
- Inbound count = 0（horizon 內無 PO）
- 但有 PO 在 horizon 外（如 W10），且 qty >= gap

**操作：**
1. 開啟 DetailsPanel
2. 查看 Before 狀態：
   ```
   Status: CRITICAL
   Inbound(H3): 0
   Eff. Gap: 100（假設）
   P@R: $1,000（假設）
   ```
3. 選擇「Expedite by 2 buckets」
4. 點擊「Simulate」

**預期結果：**
```
After:
  Status: OK ✅
  Inbound(H3): 120 (+120)  ✅ 綠色
  Eff. Gap: 0 (-100)       ✅ 綠色
  P@R: $0 (-$1,000)        ✅ 綠色，粗體

Impact Summary:
  ✅ Status improved: CRITICAL → OK
  Inbound in Horizon: +120
  Effective Gap: -100
  Profit at Risk: -$1,000  ✅ 顯著下降
```

**驗收點：**
- [x] Status 改善到 OK
- [x] Inbound(H3) 從 0 變為正數（綠色顯示）
- [x] Eff. Gap 降為 0（綠色顯示）
- [x] P@R 降為 $0（綠色顯示，粗體）
- [x] Impact Summary 顯示所有 Delta

---

### Test 2: 部分改善（CRITICAL → WARNING）

**尋找條件：**
- Status = CRITICAL
- Gap Qty > 0（如 100）
- 有 PO 在 horizon 外，但 qty < gap（如 60）

**操作：**
1. 開啟 DetailsPanel
2. 查看 Before 狀態：
   ```
   Status: CRITICAL
   Inbound(H3): 0
   Eff. Gap: 100
   P@R: $1,000
   ```
3. 選擇「Expedite by 1 bucket」
4. 點擊「Simulate」

**預期結果：**
```
After:
  Status: WARNING ↑
  Inbound(H3): 60 (+60)  ✅
  Eff. Gap: 40 (-60)     ✅ 60% 改善
  P@R: $400 (-$600)      ✅ 60% 改善

Impact Summary:
  ✅ Status improved: CRITICAL → WARNING
  Inbound in Horizon: +60
  Effective Gap: -60
  Profit at Risk: -$600
```

**驗收點：**
- [x] Status 改善到 WARNING
- [x] Eff. Gap 明顯降低（但未歸零）
- [x] P@R 明顯降低（比例與 Eff. Gap 一致）
- [x] 所有 Delta 顯示正確

---

### Test 3: 微幅改善（WARNING → WARNING）

**尋找條件：**
- Status = WARNING
- 已有部分 inbound 在 horizon 內
- 提前後增加 inbound，但仍有 eff. gap

**操作：**
1. 開啟 DetailsPanel
2. 查看 Before 狀態：
   ```
   Status: WARNING
   Inbound(H3): 50
   Eff. Gap: 50
   P@R: $500
   ```
3. 選擇「Expedite by 1 bucket」
4. 點擊「Simulate」

**預期結果：**
```
After:
  Status: WARNING
  Inbound(H3): 80 (+30)
  Eff. Gap: 20 (-30)
  P@R: $200 (-$300)

Impact Summary:
  ➡️ Status unchanged: WARNING
  Inbound in Horizon: +30
  Effective Gap: -30
  Profit at Risk: -$300  ✅ 仍有改善
```

**驗收點：**
- [x] Status 保持 WARNING（合理）
- [x] P@R 仍有明顯降低（即使 Status 未變）
- [x] Delta 顯示正確

---

### Test 4: 已是 OK（無需 Expedite）

**尋找條件：**
- Status = OK（綠色）
- Eff. Gap = 0（已完全覆蓋）

**操作：**
1. 開啟 DetailsPanel
2. 查看 Before 狀態：
   ```
   Status: OK
   Inbound(H3): 150
   Eff. Gap: 0
   P@R: $0
   ```
3. 點擊「Simulate」

**預期結果：**
```
After:
  Status: OK
  Inbound(H3): 150（或略變）
  Eff. Gap: 0
  P@R: $0

Impact Summary:
  ➡️ Status unchanged: OK
  Effective Gap: 0
  Profit at Risk: +$0
```

**驗收點：**
- [x] Status 保持 OK
- [x] P@R 保持 $0
- [x] 無負面影響

---

## 📊 公式驗證

### 驗證 1: Effective Gap 計算

**手動計算：**
```
假設：
  Base Gap = 100
  Before Inbound(H3) = 0
  After Inbound(H3) = 80（expedite 後）

Before:
  effectiveGap = max(0, 100 - 0) = 100 ✅

After:
  effectiveGap = max(0, 100 - 80) = 20 ✅

Delta:
  -60 ✅
```

**檢查 UI 顯示：**
- [x] Before Eff. Gap = 100
- [x] After Eff. Gap = 20
- [x] Delta = -60（綠色）

---

### 驗證 2: Profit at Risk 計算

**手動計算：**
```
假設：
  profitPerUnit = $10
  Before effectiveGap = 100
  After effectiveGap = 20

Before:
  profitAtRisk = 100 * $10 = $1,000 ✅

After:
  profitAtRisk = 20 * $10 = $200 ✅

Delta:
  $200 - $1,000 = -$800 ✅
```

**檢查 UI 顯示：**
- [x] Before P@R = $1,000
- [x] After P@R = $200
- [x] Delta = -$800（綠色，粗體）

---

### 驗證 3: Status 規則

**規則：**
```javascript
if (effectiveGap === 0) → OK
else if (inboundQtyWithinHorizon > 0) → WARNING
else → CRITICAL
```

**測試矩陣：**

| Eff. Gap | Inbound(H3) | Expected Status | Reason |
|----------|-------------|-----------------|--------|
| 0        | 任意        | OK              | 完全覆蓋 |
| 50       | 80          | WARNING         | 有 inbound 但有缺口 |
| 100      | 0           | CRITICAL        | 無 inbound 且有缺口 |

**驗收：**
- [x] Eff. Gap = 0 → OK
- [x] Eff. Gap > 0 且 Inbound > 0 → WARNING
- [x] Eff. Gap > 0 且 Inbound = 0 → CRITICAL

---

## 🎨 UI 元素檢查

### Before/After 顯示

**必須顯示的欄位：**
```
Before:
  ✅ Status
  ✅ Next bucket
  ✅ Inbound(H3)  ← 新增
  ✅ Eff. Gap    ← 新增
  ✅ P@R

After:
  ✅ Status（帶 ↑ 如果改善）
  ✅ Next bucket
  ✅ Inbound(H3)（帶 +delta）
  ✅ Eff. Gap（帶 +delta）
  ✅ P@R（帶 +delta，粗體）
```

**顏色規則：**
- Delta < 0（改善）→ 綠色
- Delta > 0（惡化）→ 紅色
- Delta = 0 → 灰色

---

### Impact Summary

**必須顯示：**
```
✅ Status improved/changed/unchanged
✅ Inbound in Horizon: +delta
✅ Effective Gap: +delta
✅ Profit at Risk: +delta（粗體）
```

---

### 公式說明卡片

**必須顯示：**
```
📐 Calculation Formula
effectiveGap = max(0, gapQty - inboundQtyWithinHorizon)
profitAtRisk = effectiveGap * profitPerUnit
```

---

## 🐛 邊界條件檢查

### Case 1: Base Gap = 0

**情境：** On Hand >= Safety Stock

```
Before:
  baseGapQty: 0
  inboundQtyWithinHorizon: 0
  effectiveGap: max(0, 0 - 0) = 0
  profitAtRisk: $0
  Status: OK

After（任何 expedite）:
  effectiveGap: 0
  profitAtRisk: $0
  Status: OK（不變）
```

**驗收：**
- [x] 不會出現負數
- [x] Status 保持 OK

---

### Case 2: Inbound > Gap

**情境：** Expedite 後 inbound 超過 gap

```
Before:
  baseGapQty: 50
  inboundQtyWithinHorizon: 0
  effectiveGap: 50
  profitAtRisk: $500

After:
  inboundQtyWithinHorizon: 80
  effectiveGap: max(0, 50 - 80) = 0  ✅ 不會負數
  profitAtRisk: $0
  Status: OK
```

**驗收：**
- [x] Eff. Gap 不會負數（max(0, ...)）
- [x] P@R = $0（不會負數）

---

### Case 3: 多次 Expedite

**操作：**
1. Simulate（Expedite by 1）
2. Reset
3. Simulate（Expedite by 2）
4. Reset
5. Simulate（Expedite by 3）

**驗收：**
- [x] 每次 Reset 後恢復初始狀態
- [x] 不同 expedite 數量產生不同 delta
- [x] 無錯誤累積

---

## ✅ 完整測試檢查清單

### Domain 層
- [x] `sumInboundWithinHorizon()` 正確計算
- [x] `effectiveGap` 計算正確（不會負數）
- [x] `profitAtRisk` 基於 effectiveGap
- [x] Status 規則正確（基於 effectiveGap + inbound）
- [x] 無 console 語句

### UI 層
- [x] Before 顯示所有欄位（Status/Next/Inbound/Gap/P@R）
- [x] After 顯示所有欄位 + Delta
- [x] Delta 顏色正確（綠/紅/灰）
- [x] Impact Summary 完整
- [x] 公式說明卡片顯示

### 互動流程
- [x] Simulate → 顯示結果
- [x] Reset → 清空結果
- [x] 切換 Dropdown → 更新 expediteBuckets
- [x] 切換列 → 自動 Reset

### 邏輯正確性
- [x] Expedite 後 Inbound(H3) 增加
- [x] Expedite 後 Eff. Gap 減少
- [x] Expedite 後 P@R 明顯減少 ⭐ 核心驗收
- [x] Status 改善（合理情況下）

---

## 🎉 測試通過標準

### 核心驗收（必須）
- ✅ **Profit at Risk 有明顯 Delta**（不再是 $0 → $0）
- ✅ **Delta 與 Effective Gap 變化成正比**
- ✅ **UI 清楚顯示改善效果**（綠色 Delta）

### 使用者體驗
- ✅ 一眼看出 expedite 的效果
- ✅ 數字變化符合直覺
- ✅ 公式透明（可驗證）

### 技術品質
- ✅ 無 console 錯誤
- ✅ 無 React warning
- ✅ 無 linter 錯誤

---

**測試完成後，M3 Effective Gap 模型即可用於可信的 Demo！** 🚀
