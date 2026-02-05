# M2 最終 PM 收斂總結

## 🎯 目標

1. 恢復 Domain 純度（移除所有 console 語句）
2. 提升 demo 觀感（預設排序改為 Profit at Risk）

---

## ✅ 完成的修正

### Step 1: Domain 純度（P0）✅

#### 問題
Domain 層包含 console.log，不符合 pure function 原則。

#### 修正
移除所有 `src/domains/risk/` 中的 console 語句：

1. **`coverageCalculator.js` (Line 232)**
   ```javascript
   // ❌ 移除前
   console.log(`📊 Domain 計算: ${itemFactorySet.size} unique pairs (PO + Inventory union)`);
   
   // ✅ 移除後
   // （直接刪除）
   ```

2. **`profitAtRiskCalculator.js` (Line 130)**
   ```javascript
   // ❌ 移除前
   console.log(`💰 Profit at Risk: ${Object.keys(financialIndex).size} items with real financials`);
   
   // ✅ 移除後
   // （直接刪除）
   ```

#### 驗收
```bash
# 搜尋確認
grep -r "console\." src/domains/risk/
# 結果：無匹配
```

#### 純度原則
- ✅ Domain 層不應有副作用（no console, no I/O）
- ✅ 若需 diagnostics，透過回傳物件字段
- ✅ View 層負責 console（diagnostics 已在 RiskDashboardView）

---

### Step 2: 預設排序 Profit at Risk（P1）✅

#### 問題
預設排序為 `urgencyScore`，用戶一進來看到的是按風險緊迫度排序，不直觀看到最大損失項。

#### 修正
**修改檔案：** `src/components/risk/RiskTable.jsx`

```javascript
// ❌ 修正前
const [sortConfig, setSortConfig] = useState({
  key: 'urgencyScore',
  direction: 'desc'
});

// ✅ 修正後
const [sortConfig, setSortConfig] = useState({
  key: 'profitAtRisk',  // M2: 預設按 Profit at Risk 排序
  direction: 'desc'      // 降序（最大損失在前）
});
```

#### 排序運作方式

1. **初始載入**
   - 預設按 `profitAtRisk` 降序排序
   - 最大損失項顯示在最上方

2. **使用者點擊欄位標題**
   ```javascript
   const handleSort = (key) => {
     setSortConfig(prev => ({
       key,
       direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
     }));
   };
   ```
   - 第一次點擊：升序
   - 第二次點擊：降序
   - 尊重使用者選擇

3. **排序邏輯**
   ```javascript
   sorted.sort((a, b) => {
     let aVal = a[sortConfig.key];
     let bVal = b[sortConfig.key];
     
     if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
     if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
     return 0;
   });
   ```

#### 驗收
- ✅ 頁面載入時，最大 Profit at Risk 項在最上方
- ✅ 欄位標題顯示降序圖示（ChevronDown）
- ✅ 點擊其他欄位可切換排序
- ✅ 點擊 Profit at Risk 可切換升/降序

---

## 📂 修改檔案清單

### 修改檔案（3 個）

1. ✅ **`src/domains/risk/coverageCalculator.js`**
   - 移除 Line 232 的 `console.log`

2. ✅ **`src/domains/risk/profitAtRiskCalculator.js`**
   - 移除 Line 130 的 `console.log`

3. ✅ **`src/components/risk/RiskTable.jsx`**
   - 修改預設 `sortConfig`
   - `key: 'urgencyScore'` → `key: 'profitAtRisk'`

### 新增檔案（1 個）
1. 📄 **`M2_PM_CONVERGENCE_FINAL.md`** - 本收斂總結

---

## 🔧 修改細節

### coverageCalculator.js
```javascript
// Line 223-232 修正前
inventorySnapshots.forEach(inv => {
  const item = normalizeItemCode(inv.material_code || inv.item || inv.material);
  const factory = normalizeFactory(inv.plant_id || inv.factory || inv.site);
  if (item && factory) {
    itemFactorySet.add(`${item}|${factory}`);
  }
});

console.log(`📊 Domain 計算: ${itemFactorySet.size} unique pairs (PO + Inventory union)`);  // ❌ 移除

// 對每個組合計算風險

// Line 223-231 修正後
inventorySnapshots.forEach(inv => {
  const item = normalizeItemCode(inv.material_code || inv.item || inv.material);
  const factory = normalizeFactory(inv.plant_id || inv.factory || inv.site);
  if (item && factory) {
    itemFactorySet.add(`${item}|${factory}`);
  }
});

// 對每個組合計算風險  // ✅ 直接繼續，無 console
```

### profitAtRiskCalculator.js
```javascript
// Line 127-132 修正前
export const calculateProfitAtRiskBatch = ({
  riskRows = [],
  financials = [],
  useFallback = true
}) => {
  // 建立 financial index
  const financialIndex = buildFinancialIndex(financials);
  
  console.log(`💰 Profit at Risk: ${Object.keys(financialIndex).size} items with real financials`);  // ❌ 移除
  
  // 计算每行

// Line 127-131 修正後
export const calculateProfitAtRiskBatch = ({
  riskRows = [],
  financials = [],
  useFallback = true
}) => {
  // 建立 financial index
  const financialIndex = buildFinancialIndex(financials);
  
  // 计算每行  // ✅ 直接繼續，無 console
```

### RiskTable.jsx
```javascript
// 修正前
const [sortConfig, setSortConfig] = useState({
  key: 'urgencyScore',  // ❌ 預設按緊迫度
  direction: 'desc'
});

// 修正後
const [sortConfig, setSortConfig] = useState({
  key: 'profitAtRisk',  // ✅ M2: 預設按 Profit at Risk 排序
  direction: 'desc'      // ✅ 降序（最大損失在前）
});
```

---

## 📊 預設排序運作方式

### 初始狀態
```
頁面載入
  ↓
sortConfig = { key: 'profitAtRisk', direction: 'desc' }
  ↓
表格排序（最大 Profit at Risk 在最上方）
  ↓
欄位標題顯示降序圖示（ChevronDown）
```

### 使用者互動
```
使用者點擊 "Profit at Risk" 欄位標題
  ↓
第一次點擊：切換為升序（asc）
  ↓
第二次點擊：切換為降序（desc）
  ↓
持續在 asc/desc 之間切換
```

### 點擊其他欄位
```
使用者點擊 "料號" 欄位標題
  ↓
sortConfig = { key: 'materialCode', direction: 'asc' }
  ↓
表格按料號升序排序
  ↓
尊重使用者選擇（不再回到 profitAtRisk）
```

### 排序優先級（實際效果）
```
頁面載入
  ↓
自動排序：Profit at Risk (desc)
  ↓
顯示順序：
1. PART-B202  $25,000  🔴
2. PART-A101  $15,000  🔴
3. PART-C303   $8,500  🟡
4. PART-D404   $3,200  🟡
5. PART-E505     $500  🟢
```

---

## 🎯 Demo 觀感提升

### Before（修正前）
```
預設排序：urgencyScore (desc)
  ↓
顯示順序：
1. PART-A101  $15,000  🔴  urgencyScore: 100
2. PART-B202  $25,000  🔴  urgencyScore: 100
3. PART-C303   $8,500  🟡  urgencyScore: 60
```
**問題：** 同等級風險項順序隨機，不突顯最大損失

### After（修正後）
```
預設排序：profitAtRisk (desc)
  ↓
顯示順序：
1. PART-B202  $25,000  🔴
2. PART-A101  $15,000  🔴
3. PART-C303   $8,500  🟡
```
**優點：** 
- ✅ 最大損失項優先顯示
- ✅ 使用者一眼看到關鍵風險
- ✅ 更符合業務優先級

---

## ✅ 驗收標準

### Domain 純度
- [x] `src/domains/risk/coverageCalculator.js` 無 console
- [x] `src/domains/risk/profitAtRiskCalculator.js` 無 console
- [x] Grep 搜尋確認無 console 語句

### 預設排序
- [x] 頁面載入時按 Profit at Risk 降序
- [x] 最大損失項在最上方
- [x] 欄位標題顯示降序圖示
- [x] 點擊其他欄位可切換排序
- [x] 尊重使用者選擇

### 技術檢查
- [x] 無 linter 錯誤
- [x] 不新增 npm 依賴
- [x] 不改舊 Views
- [x] 保留 diagnostics 與藍色提示框

---

## 🎉 M2 PM 收斂完成

### 完成的優化
- ✅ **Domain 純度**：移除所有 console（pure function）
- ✅ **Demo 觀感**：預設按金額排序（突顯關鍵風險）
- ✅ **保持透明**：diagnostics 與 assumption 說明保留
- ✅ **技術穩健**：無 linter 錯誤

### 業務價值
- 💰 **優先級明確**：最大損失項優先處理
- 👀 **一目了然**：進入頁面立即看到關鍵風險
- 🎯 **決策支持**：按金額排序更符合商業邏輯

### Demo 準備度
- 🚀 **Always Demo-able**：fallback assumption 確保永遠可展示
- 📈 **Progressive Enhancement**：有 financials 時自動升級
- 💡 **Self-explanatory**：UI 透明標示假設
- 🔧 **Professional**：Domain 純度 + 合理預設排序

---

**實現完成時間：** 2026-02-04  
**版本：** M2 - Profit at Risk (Final)  
**測試狀態：** ✅ 通過 linter 檢查  
**Demo 狀態：** ✅ Ready for production demo
