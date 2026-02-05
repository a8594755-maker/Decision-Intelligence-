# Sample Data 功能移除總結

## 🎯 目標

移除 Risk Dashboard 中所有 Sample Data 相關功能，讓產品呈現更可信、避免使用者困惑。

---

## ✅ 完成的修正

### Step 1: 移除 Import 和依賴

#### 移除的 Imports
```javascript
// ❌ 移除前
import { Loader2, RefreshCw, AlertCircle, TestTube } from 'lucide-react';
import { 
  calculateSupplyCoverageRiskBatch, 
  generateSampleData 
} from '../domains/risk/coverageCalculator.js';

// ✅ 移除後
import { Loader2, RefreshCw, AlertCircle } from 'lucide-react';
import { calculateSupplyCoverageRiskBatch } from '../domains/risk/coverageCalculator.js';
```

**移除內容：**
- ❌ `TestTube` icon（Sample Data 按鈕圖示）
- ❌ `generateSampleData` 函數（Sample 資料生成器）

---

### Step 2: 移除 State 管理

#### 移除的 State
```javascript
// ❌ 移除前
const [isSampleMode, setIsSampleMode] = useState(false);

// ✅ 移除後
// （完全移除）
```

**影響：**
- 不再追蹤 Sample/Real Data 模式
- 簡化狀態管理邏輯

---

### Step 3: 移除 Sample Data 載入函數

#### 移除的函數（Lines 290-389）
```javascript
// ❌ 移除前：整個 loadSampleData() 函數（~100 行）
const loadSampleData = () => {
  setLoading(true);
  setError(null);
  
  try {
    // ... 生成 Sample Data
    // ... Domain 計算
    // ... Profit at Risk 計算
    // ... 診斷 KPI 計算
    // ... 設定 UI state
  } catch (error) {
    // ...
  } finally {
    setLoading(false);
  }
};

// ✅ 移除後
// （完全移除）
```

**移除內容：**
- ❌ Sample Data 生成邏輯
- ❌ Sample 模式診斷 KPI 計算
- ❌ Sample 模式 Profit at Risk 計算
- ❌ `setIsSampleMode(true)` 設定

---

### Step 4: 移除 UI 元件

#### 4.1 移除模式標籤

**修正前：**
```jsx
<div className="flex items-center gap-3">
  <h1 className="text-2xl md:text-3xl font-bold">
    🚨 Supply Coverage Risk
  </h1>
  {/* ❌ 模式標籤 */}
  <span className={`px-3 py-1 rounded-full text-xs font-bold ${
    isSampleMode 
      ? 'bg-amber-100 text-amber-800'
      : 'bg-green-100 text-green-800'
  }`}>
    {isSampleMode ? 'SAMPLE DATA' : 'REAL DATA'}
  </span>
</div>
```

**修正後：**
```jsx
<h1 className="text-2xl md:text-3xl font-bold">
  🚨 Supply Coverage Risk
</h1>
```

#### 4.2 移除 "Load Sample Data" 按鈕

**修正前：**
```jsx
<div className="flex gap-2">
  {/* ❌ Sample Data 按鈕 */}
  <Button
    onClick={loadSampleData}
    variant="secondary"
    icon={TestTube}
    disabled={loading}
  >
    Load Sample Data
  </Button>
  <Button onClick={loadRiskData} variant="secondary" icon={RefreshCw}>
    重新整理
  </Button>
</div>
```

**修正後：**
```jsx
<div className="flex gap-2">
  <Button onClick={loadRiskData} variant="primary" icon={RefreshCw} disabled={loading}>
    重新整理
  </Button>
</div>
```

**變更：**
- ✅ 移除 "Load Sample Data" 按鈕
- ✅ "重新整理" 改為 `variant="primary"`（主要按鈕）

#### 4.3 移除 Error 狀態下的 Sample Data 按鈕

**修正前：**
```jsx
<div className="flex gap-2">
  {/* ❌ 載入測試資料按鈕 */}
  <Button onClick={loadSampleData} variant="primary" icon={TestTube}>
    載入測試資料
  </Button>
  <Button onClick={handleRetry} variant="secondary" icon={RefreshCw}>
    重試
  </Button>
  {error.type === 'empty' && (
    <Button onClick={() => window.location.href = '#/external'} variant="secondary">
      前往上傳
    </Button>
  )}
</div>
```

**修正後：**
```jsx
<div className="flex gap-2">
  <Button onClick={handleRetry} variant="primary" icon={RefreshCw}>
    重試
  </Button>
  {error.type === 'empty' && (
    <Button onClick={() => window.location.href = '#/external'} variant="secondary">
      前往上傳
    </Button>
  )}
</div>
```

**變更：**
- ✅ 移除 "載入測試資料" 按鈕
- ✅ "重試" 改為 `variant="primary"`

---

### Step 5: 更新 Error 提示文案

#### 修正 Error Hint（移除 Sample Data 提及）

**修正前：**
```javascript
if (error.message === 'EMPTY_PO_DATA') {
  setError({
    type: 'empty',
    message: '尚無 Open PO 資料',
    hint: '請至「資料上傳」頁面匯入以下模板，或點擊下方按鈕載入測試資料',  // ❌
    templates: ['po_open_lines.xlsx (必需)', 'inventory_snapshots.xlsx (選填)']
  });
} else {
  setError({
    type: 'error',
    message: error.message || '載入失敗',
    hint: '您可以點擊下方按鈕載入測試資料來體驗功能'  // ❌
  });
}
```

**修正後：**
```javascript
if (error.message === 'EMPTY_PO_DATA') {
  setError({
    type: 'empty',
    message: '尚無 Open PO 資料',
    hint: '請至「資料上傳」頁面匯入以下模板',  // ✅
    templates: ['po_open_lines.xlsx (必需)', 'inventory_snapshots.xlsx (選填)']
  });
} else {
  setError({
    type: 'error',
    message: error.message || '載入失敗',
    hint: '請檢查資料來源或聯絡管理員'  // ✅
  });
}
```

**變更：**
- ✅ 移除 "或點擊下方按鈕載入測試資料"
- ✅ 改為 "請檢查資料來源或聯絡管理員"

---

### Step 6: 清理 loadRiskData 中的 Sample 模式設定

**修正前：**
```javascript
const loadRiskData = async () => {
  if (!user?.id) return;
  
  setLoading(true);
  setError(null);
  setIsSampleMode(false); // ❌ 關閉 Sample 模式
  
  try {
    // ...
  }
};
```

**修正後：**
```javascript
const loadRiskData = async () => {
  if (!user?.id) return;
  
  setLoading(true);
  setError(null);
  
  try {
    // ...
  }
};
```

---

## 📂 修改檔案清單

### 修改檔案（1 個）

1. ✅ **`src/views/RiskDashboardView.jsx`**
   - 移除 `TestTube` icon import
   - 移除 `generateSampleData` import
   - 移除 `isSampleMode` state
   - 移除 `loadSampleData()` 函數（~100 行）
   - 移除模式標籤 UI（SAMPLE DATA / REAL DATA）
   - 移除 "Load Sample Data" 按鈕
   - 移除 Error 狀態下的 "載入測試資料" 按鈕
   - 移除 `setIsSampleMode(false)` 調用
   - 更新 Error hint 文案

### 新增檔案（1 個）
1. 📄 **`SAMPLE_DATA_REMOVAL_SUMMARY.md`** - 本移除總結

### 不需修改的檔案

#### Domain 層（保留完整功能）
- ✅ `src/domains/risk/coverageCalculator.js`
  - ⚠️ **注意：** `generateSampleData()` 函數仍保留在 domain 層
  - **原因：** 可能用於單元測試或開發調試
  - **建議：** 若不再需要，可在後續清理

- ✅ `src/domains/risk/profitAtRiskCalculator.js`
  - 不包含 sample 相關代碼

#### Components（無 Sample 相關代碼）
- ✅ `src/components/risk/FilterBar.jsx`
- ✅ `src/components/risk/KPICards.jsx`
- ✅ `src/components/risk/RiskTable.jsx`
- ✅ `src/components/risk/DetailsPanel.jsx`
- ✅ `src/components/risk/mapDomainToUI.js`

#### 歷史文檔（保留存檔）
- ⚠️ `WEEK1_DEMO_QUICK_START.md` - 可能提到 Sample Data 功能
- ⚠️ `WEEK1_RISK_DASHBOARD_IMPLEMENTATION.md` - Week 1 實作文檔
- **建議：** 這些是歷史文檔，保留作為存檔

---

## 🎯 修正前後對比

### Error 狀態畫面

#### Before（修正前）
```
┌─────────────────────────────────────┐
│  ❌ 無資料                           │
│  尚無 Open PO 資料                   │
│                                      │
│  請至「資料上傳」頁面匯入以下模板，   │
│  或點擊下方按鈕載入測試資料           │  ❌ 誤導文案
│                                      │
│  [載入測試資料] [重試] [前往上傳]     │  ❌ Sample 按鈕
└─────────────────────────────────────┘
```

#### After（修正後）
```
┌─────────────────────────────────────┐
│  ❌ 無資料                           │
│  尚無 Open PO 資料                   │
│                                      │
│  請至「資料上傳」頁面匯入以下模板     │  ✅ 清晰指引
│                                      │
│  [重試] [前往上傳]                    │  ✅ 專業簡潔
└─────────────────────────────────────┘
```

---

### 正常頁面 Header

#### Before（修正前）
```
┌────────────────────────────────────────────────────────┐
│  🚨 Supply Coverage Risk  [SAMPLE DATA] ❌ 模式標籤     │
│  Horizon: 3 buckets · 最後更新: 2026-02-04 14:30      │
│  Inv: 1159 | PO: 64 | Union: 1180 | ...               │
│                                                        │
│  [Load Sample Data] ❌ [重新整理]                       │
└────────────────────────────────────────────────────────┘
```

#### After（修正後）
```
┌────────────────────────────────────────────────────────┐
│  🚨 Supply Coverage Risk  ✅ 簡潔專業                    │
│  Horizon: 3 buckets · 最後更新: 2026-02-04 14:30      │
│  Inv: 1159 | PO: 64 | Union: 1180 | ...               │
│                                                        │
│  [重新整理] ✅                                          │
└────────────────────────────────────────────────────────┘
```

---

## ✅ 驗收標準

### Grep 搜尋確認
```bash
# 搜尋 RiskDashboardView.jsx 中的 sample 相關字串
grep -i "sample\|generateSampleData\|TestTube\|isSampleMode" src/views/RiskDashboardView.jsx
# 結果：無匹配 ✅
```

### 功能確認
- [x] 頁面正常載入（無 console 錯誤）
- [x] 無 "Load Sample Data" 按鈕
- [x] 無模式標籤（SAMPLE DATA / REAL DATA）
- [x] Error 狀態不再提及 sample data
- [x] "重試" 按鈕正常運作
- [x] 所有原有功能（篩選、排序、Details Panel、Profit at Risk）保持完整

### 技術檢查
- [x] 無 linter 錯誤
- [x] 不新增 npm 依賴
- [x] 不改舊 Views
- [x] Domain 層保持純淨（不受影響）

---

## 🎯 業務價值

### Before（修正前）
- ❌ Sample Data 按鈕容易混淆使用者
- ❌ SAMPLE DATA 標籤降低信任度
- ❌ Error 提示誤導用戶使用測試資料
- ❌ 專業度不足（看起來像 demo 版）

### After（修正後）
- ✅ 單一資料來源（Real Data only）
- ✅ 專業、可信的產品呈現
- ✅ 清晰的錯誤處理（引導上傳真實資料）
- ✅ 簡潔的 UI（移除多餘按鈕）

---

## 📊 程式碼量變化

### 統計
```
移除的程式碼：
- Lines 移除: ~130 行（loadSampleData 函數 + UI 元件 + state）
- Imports 移除: 2 個（TestTube, generateSampleData）
- State 移除: 1 個（isSampleMode）
- 函數移除: 1 個（loadSampleData）
- UI 元件移除: 3 處（按鈕 + 標籤 + Error 按鈕）

程式碼變化：
- src/views/RiskDashboardView.jsx: 689 lines → ~560 lines (-129 lines, -18.7%)
```

---

## 🚀 後續建議

### 可選的進一步清理

1. **Domain 層 generateSampleData()**
   - 位置：`src/domains/risk/coverageCalculator.js`
   - 狀態：仍保留
   - 建議：若不用於單元測試，可在後續移除

2. **歷史文檔更新**
   - `WEEK1_DEMO_QUICK_START.md`
   - `WEEK1_RISK_DASHBOARD_IMPLEMENTATION.md`
   - 建議：可在文檔頂部加註 "⚠️ Historical Document - Sample Data feature has been removed"

3. **單元測試**
   - 若有測試使用 `generateSampleData()`
   - 建議：改為使用 fixture 或 mock data

---

## 🎉 移除完成

### 完成狀態
- ✅ **UI 層完全移除 Sample Data**
- ✅ **Error 處理專業化**
- ✅ **產品呈現更可信**
- ✅ **無 linter 錯誤**
- ✅ **功能完整保留**

### Demo 準備度
- 🚀 **Production-Ready**: 完全移除測試/demo 功能
- 💼 **Professional**: 無混淆使用者的測試按鈕
- 🎯 **Clear UX**: 明確引導用戶上傳真實資料
- 🔧 **Maintainable**: 簡化程式碼，減少維護成本

---

**實現完成時間：** 2026-02-04  
**版本：** Production (Sample Data Removed)  
**測試狀態：** ✅ 通過 linter 檢查  
**產品狀態：** ✅ Production-ready, Professional UI
