# BOM Explosion Trace Tab 實作完成

## 📋 實作摘要

已成功在 `ViewDataModal` 中實作 BOM Explosion 的 Trace Tab 功能，允許用戶查看 `component_demand_trace` 表的追溯資料。

---

## 📂 修改的檔案清單

### 1. `src/services/importHistoryService.js`
- **新增方法**：`getComponentDemandTrace(userId, batchId, options)`
  - 查詢 `component_demand_trace` 表
  - 支援篩選：component_demand_id, fg_demand_id, bom_level, component_material_code, fg_material_code
  - 支援分頁（limit, offset）

- **修改方法**：`getBatchDataWithFilters()`
  - 新增 `view` 參數（'results' | 'trace'）
  - 當 `target_table='bom_explosion'` 且 `view='trace'` 時，委派給 `getComponentDemandTrace`

### 2. `src/components/ViewDataModal.jsx`
- **新增 State**：`activeTab` ('results' | 'trace')
- **新增功能**：
  - Tab 切換 UI（只在 bom_explosion 時顯示）
  - `handleTabSwitch()` 方法
  - `renderCellValue()` 方法（特殊處理 trace_meta）
  - 根據 activeTab 調整 filter fields
  - 根據 activeTab 調整顯示欄位

---

## 🔧 關鍵程式碼 Patch

### **1. importHistoryService.js - 新增 getComponentDemandTrace 方法**

```javascript
/**
 * 查詢 component_demand_trace 資料（支援篩選和分頁）
 */
async getComponentDemandTrace(userId, batchId, options = {}) {
  const { filters = {}, limit = 100, offset = 0 } = options;
  
  try {
    let query = supabase
      .from('component_demand_trace')
      .select('*')
      .eq('user_id', userId)
      .eq('batch_id', batchId);
    
    let countQuery = supabase
      .from('component_demand_trace')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('batch_id', batchId);
    
    // Apply filters
    if (filters.component_demand_id) {
      query = query.eq('component_demand_id', filters.component_demand_id);
      countQuery = countQuery.eq('component_demand_id', filters.component_demand_id);
    }
    if (filters.fg_demand_id) {
      query = query.eq('fg_demand_id', filters.fg_demand_id);
      countQuery = countQuery.eq('fg_demand_id', filters.fg_demand_id);
    }
    if (filters.bom_level) {
      const level = parseInt(filters.bom_level, 10);
      if (!isNaN(level)) {
        query = query.eq('bom_level', level);
        countQuery = countQuery.eq('bom_level', level);
      }
    }
    // Filter by material codes in trace_meta
    if (filters.component_material_code) {
      query = query.ilike('trace_meta->>component_material_code', `%${filters.component_material_code}%`);
      countQuery = countQuery.ilike('trace_meta->>component_material_code', `%${filters.component_material_code}%`);
    }
    if (filters.fg_material_code) {
      query = query.ilike('trace_meta->>fg_material_code', `%${filters.fg_material_code}%`);
      countQuery = countQuery.ilike('trace_meta->>fg_material_code', `%${filters.fg_material_code}%`);
    }
    
    query = query.order('created_at', { ascending: false });
    query = query.range(offset, offset + limit - 1);
    
    const [dataResult, countResult] = await Promise.all([query, countQuery]);
    
    if (dataResult.error) {
      return {
        data: [],
        count: 0,
        error: dataResult.error.message || JSON.stringify(dataResult.error)
      };
    }
    
    return {
      data: dataResult.data || [],
      count: countResult.count || dataResult.data?.length || 0,
      error: null
    };
  } catch (error) {
    console.error('Error in getComponentDemandTrace:', error);
    return {
      data: [],
      count: 0,
      error: error.message || JSON.stringify(error)
    };
  }
}
```

### **2. importHistoryService.js - 修改 getBatchDataWithFilters**

```javascript
case 'bom_explosion':
  // Support view parameter: 'results' or 'trace'
  if (view === 'trace') {
    return await this.getComponentDemandTrace(userId, batchId, { filters, limit, offset });
  }
  
  // Default: view='results' - query component_demand
  query = supabase.from('component_demand')...
```

### **3. ViewDataModal.jsx - 新增 State 和 Tabs**

```javascript
// State
const [activeTab, setActiveTab] = useState('results');
const showTabs = batch?.target_table === 'bom_explosion';

// Tab switch handler
const handleTabSwitch = (tab) => {
  setActiveTab(tab);
  setFilters({});
  setCurrentPage(1);
};

// Tabs UI (只在 bom_explosion 時顯示)
{showTabs && (
  <div className="border-b dark:border-slate-700 bg-white dark:bg-slate-900">
    <div className="flex px-6">
      <button onClick={() => handleTabSwitch('results')} ...>
        Forecast Results
      </button>
      <button onClick={() => handleTabSwitch('trace')} ...>
        Trace
      </button>
    </div>
  </div>
)}
```

### **4. ViewDataModal.jsx - 根據 Tab 調整 Filter Fields**

```javascript
const getFilterFields = () => {
  switch (batch?.target_table) {
    case 'bom_explosion':
      if (activeTab === 'trace') {
        return [
          { key: 'component_demand_id', label: 'Component Demand ID', placeholder: 'UUID...' },
          { key: 'fg_demand_id', label: 'FG Demand ID', placeholder: 'UUID...' },
          { key: 'bom_level', label: 'BOM Level', placeholder: '例如 1, 2, 3...' },
          { key: 'component_material_code', label: 'Component Material', placeholder: '搜尋 Component 料號...' },
          { key: 'fg_material_code', label: 'FG Material', placeholder: '搜尋 FG 料號...' }
        ];
      }
      // Results tab filters
      return [
        { key: 'material_code', label: 'Material Code', placeholder: '搜尋料號...' },
        { key: 'plant_id', label: 'Plant ID', placeholder: '搜尋工廠代碼...' },
        { key: 'time_bucket', label: 'Time Bucket', placeholder: '例如 2026-W02 或 2026-01-08' }
      ];
    ...
  }
};
```

### **5. ViewDataModal.jsx - trace_meta 特殊渲染**

```javascript
const renderCellValue = (row, col) => {
  const value = row[col];
  
  // Special handling for trace_meta (JSONB)
  if (col === 'trace_meta' && typeof value === 'object' && value !== null) {
    const meta = value;
    return (
      <div className="space-y-1 text-xs">
        {meta.path && <div className="truncate" title={JSON.stringify(meta.path)}>
          <span className="font-semibold">Path:</span> {JSON.stringify(meta.path)}
        </div>}
        {meta.fg_material_code && <div>
          <span className="font-semibold">FG:</span> {meta.fg_material_code}
        </div>}
        {meta.component_material_code && <div>
          <span className="font-semibold">Comp:</span> {meta.component_material_code}
        </div>}
        {meta.fg_qty !== undefined && <div>
          <span className="font-semibold">FG Qty:</span> {meta.fg_qty}
        </div>}
        {meta.component_qty !== undefined && <div>
          <span className="font-semibold">Comp Qty:</span> {meta.component_qty}
        </div>}
      </div>
    );
  }
  
  // Default rendering...
};
```

---

## ✅ 功能特性

### **Forecast Results Tab (預設)**
- 顯示 `component_demand` 表資料
- 篩選欄位：material_code, plant_id, time_bucket
- 顯示欄位：material_code, plant_id, time_bucket, demand_qty, uom, source_fg_material, bom_level, notes, created_at

### **Trace Tab**
- 顯示 `component_demand_trace` 表資料
- 篩選欄位：
  - `component_demand_id`（UUID 精確匹配）
  - `fg_demand_id`（UUID 精確匹配）
  - `bom_level`（數字精確匹配）
  - `component_material_code`（模糊搜尋 trace_meta）
  - `fg_material_code`（模糊搜尋 trace_meta）
- 顯示欄位：
  - component_demand_id
  - fg_demand_id
  - bom_edge_id
  - qty_multiplier
  - bom_level
  - **trace_meta**（特殊渲染，顯示 path, fg_material_code, component_material_code, fg_qty, component_qty）
  - created_at

### **共同功能**
- ✅ 分頁（每頁 100 筆）
- ✅ 篩選（即時查詢）
- ✅ 清除篩選
- ✅ 錯誤顯示（Supabase error.message）
- ✅ 載入中狀態
- ✅ 空資料提示

---

## 🧪 手動驗收流程

### **前置條件**
1. 確保資料庫有 `component_demand` 和 `component_demand_trace` 資料
2. 確保有至少一筆 `import_batches` 記錄，且 `target_table='bom_explosion'`

### **測試步驟**

#### **Step 1：進入 Import History**
```bash
npm run dev  # 啟動應用
```
- 登入應用
- 導航到 **Import History** 頁面
- 找到一筆 `target_table = 'bom_explosion'` 的批次

#### **Step 2：開啟 View Data Modal**
- 點擊該批次的 **View Data** 按鈕（Database icon 🗄️）
- 確認 Modal 開啟
- **預期結果**：
  - ✅ 看到兩個 Tabs：「Forecast Results」和「Trace」
  - ✅ 預設 Tab 是「Forecast Results」
  - ✅ 顯示 component_demand 資料

#### **Step 3：測試 Forecast Results Tab**
- **篩選測試**：
  - 點擊「顯示篩選」
  - 輸入 `material_code`（例如：`COMP-`）
  - **預期結果**：只顯示包含該料號的資料
  - 輸入 `time_bucket`（例如：`2026-W02`）
  - **預期結果**：只顯示該週的資料
  - 點擊「清除篩選」
  - **預期結果**：恢復所有資料

- **分頁測試**：
  - 如果資料超過 100 筆，檢查分頁按鈕
  - 點擊「Next」
  - **預期結果**：跳到第 2 頁

#### **Step 4：切換到 Trace Tab**
- 點擊「Trace」Tab
- **預期結果**：
  - ✅ 表格內容切換為 `component_demand_trace` 資料
  - ✅ 篩選欄位變更為：Component Demand ID, FG Demand ID, BOM Level, Component Material, FG Material
  - ✅ 表格欄位變更為：component_demand_id, fg_demand_id, bom_edge_id, qty_multiplier, bom_level, trace_meta, created_at

#### **Step 5：測試 Trace Tab 篩選**
- **BOM Level 篩選**：
  - 輸入 `bom_level = 1`
  - **預期結果**：只顯示 Level 1 的資料

- **Component Material 篩選**：
  - 輸入 `component_material_code`（例如：`COMP-10`）
  - **預期結果**：只顯示該 Component 的 trace 記錄

- **FG Material 篩選**：
  - 輸入 `fg_material_code`（例如：`FG-001`）
  - **預期結果**：只顯示該 FG 的 trace 記錄

#### **Step 6：測試 trace_meta 顯示**
- 檢查 `trace_meta` 欄位
- **預期結果**：
  - ✅ 顯示多行格式化資訊
  - ✅ 包含：Path, FG, Comp, FG Qty, Comp Qty
  - ✅ Path 顯示為 JSON array（可能被截斷，hover 顯示完整）

#### **Step 7：切換回 Forecast Results**
- 點擊「Forecast Results」Tab
- **預期結果**：
  - ✅ 表格內容切換回 `component_demand`
  - ✅ 篩選欄位恢復為：Material Code, Plant ID, Time Bucket

#### **Step 8：測試錯誤處理**
- 在 Trace Tab 輸入不存在的 `component_demand_id`（隨機 UUID）
- **預期結果**：顯示「無資料」

---

## 🔍 驗收檢查清單

### **UI 檢查**
- [ ] Tab 切換按鈕顯示正確（只在 bom_explosion 時顯示）
- [ ] Active Tab 有藍色底線標示
- [ ] 篩選欄位根據 Tab 動態變更
- [ ] trace_meta 欄位格式化顯示（多行、有 label）
- [ ] 分頁控制正常運作

### **功能檢查**
- [ ] Forecast Results Tab 查詢 component_demand
- [ ] Trace Tab 查詢 component_demand_trace
- [ ] 所有篩選條件正常運作
- [ ] 清除篩選恢復所有資料
- [ ] 切換 Tab 時清除篩選和重置頁碼

### **資料檢查**
- [ ] component_demand 資料完整顯示
- [ ] component_demand_trace 資料完整顯示
- [ ] trace_meta.path 正確顯示 JSON array
- [ ] trace_meta.fg_material_code 正確顯示
- [ ] trace_meta.component_material_code 正確顯示
- [ ] qty_multiplier, bom_level 數值正確

### **錯誤處理檢查**
- [ ] 空資料顯示「無資料」提示
- [ ] Supabase 錯誤顯示紅色錯誤框
- [ ] 載入中顯示 spinner

---

## 🚀 後續優化建議

### **短期優化**
1. **trace_meta 展開功能**：添加「展開/收合」按鈕，查看完整 trace_meta
2. **關聯查詢**：在 Trace Tab 顯示關聯的 component_demand 和 fg_demand 資料（JOIN）
3. **路徑可視化**：將 trace_meta.path 顯示為圖形化路徑（樹狀結構）

### **中期優化**
1. **匯出功能**：允許匯出 Trace 資料為 CSV/Excel
2. **進階篩選**：支援日期範圍、數量範圍篩選
3. **排序功能**：允許按任意欄位排序

### **長期優化**
1. **BOM Tree 可視化**：整合 D3.js 或 React Flow 顯示 BOM 結構
2. **即時追溯**：從 Forecast Results 點擊某個 component，直接跳到 Trace Tab 並自動篩選
3. **效能優化**：虛擬滾動（react-window）支援大量資料

---

## 📝 技術細節

### **資料庫 Schema 依賴**
- `component_demand_trace` 表必須有：
  - `user_id`, `batch_id`, `component_demand_id`, `fg_demand_id`
  - `bom_edge_id`, `qty_multiplier`, `bom_level`
  - `trace_meta` (JSONB)，包含：
    - `path` (array)
    - `fg_material_code`, `component_material_code`
    - `fg_qty`, `component_qty`
    - `plant_id`, `time_bucket`, `source_type`, `source_id`

### **API 調用流程**
```
ViewDataModal
  └─ loadData()
      └─ importBatchesService.getBatchDataWithFilters(userId, batchId, targetTable, { view: activeTab })
          └─ if view='trace':
              └─ getComponentDemandTrace(userId, batchId, { filters, limit, offset })
                  └─ Supabase: SELECT * FROM component_demand_trace WHERE user_id=? AND batch_id=? [+ filters]
          └─ else (view='results'):
              └─ Supabase: SELECT * FROM component_demand WHERE user_id=? AND batch_id=? [+ filters]
```

---

## ✅ 完成狀態

**實作完成日期**：2026-01-30

**實作者**：AI Assistant (Claude Sonnet 4.5)

**狀態**：✅ 所有功能已實作完成，等待測試驗收

---

## 📞 問題回報

如遇到問題，請檢查：
1. **資料庫**：確認 `component_demand_trace` 表有資料且有 `trace_meta` 欄位
2. **Supabase RLS**：確認 Row Level Security 政策允許查詢
3. **Console**：檢查瀏覽器 Console 是否有 JavaScript 錯誤
4. **Network**：檢查 Network Tab 的 Supabase API 請求是否成功

---

**祝測試順利！🎉**
