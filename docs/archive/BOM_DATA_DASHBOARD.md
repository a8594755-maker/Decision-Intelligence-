# BOM Data Dashboard - 實作說明

## 📋 功能概述

新增 BOM Data Dashboard 頁面，提供簡潔的 Tab 介面查看和搜尋 BOM Edges 和 Demand FG 資料。

## ✨ 主要特性

### 1️⃣ **雙 Tab 切換**
- **BOM Edges Tab**: 查看 BOM 關係資料
- **Demand FG Tab**: 查看成品需求資料
- 自動顯示各 Tab 的資料筆數

### 2️⃣ **預設排序**
- 按 `created_at DESC` 排序
- 最新資料優先顯示

### 3️⃣ **動態搜尋條件**

**BOM Edges 篩選欄位**：
- `batch_id` - 批次 ID
- `plant_id` - 工廠代碼
- `parent_material` - 父件料號
- `child_material` - 子件料號

**Demand FG 篩選欄位**：
- `batch_id` - 批次 ID
- `plant_id` - 工廠代碼
- `material_code` - 料號
- `time_bucket` - 時間桶

### 4️⃣ **Server-side Pagination**
- 每頁顯示 100 筆資料
- 使用 Supabase `.range(offset, offset + limit - 1)`
- 顯示當前頁碼和總頁數
- 上一頁/下一頁按鈕

### 5️⃣ **最小可用 UI**
- 無複雜圖表
- 清晰的表格顯示
- 簡潔的篩選介面
- Responsive 設計

## 📁 新增檔案

### `src/views/BOMDataView.jsx` ✅

完整的 BOM Data Dashboard 元件：

```javascript
const BOMDataView = ({ user, addNotification })
```

**核心功能**：
- Tab 切換（bom_edges / demand_fg）
- 動態篩選器
- Server-side 分頁
- 即時搜尋

**State 管理**：
```javascript
const [activeTab, setActiveTab] = useState('bom_edges');
const [data, setData] = useState([]);
const [totalCount, setTotalCount] = useState(0);
const [loading, setLoading] = useState(false);
const [currentPage, setCurrentPage] = useState(1);
const [filters, setFilters] = useState({});
const [showFilters, setShowFilters] = useState(true);
```

## 🔧 修改檔案

### `src/App.jsx` ✅

**修改內容**：

1. **Import 新 View**：
```javascript
import BOMDataView from './views/BOMDataView';
```

2. **添加路由**：
```javascript
case 'bom-data': return <BOMDataView addNotification={addNotification} user={session?.user} />;
```

3. **更新導航配置** (Data 下拉選單)：
```javascript
{
  key: 'data',
  label: 'Data',
  icon: Database,
  children: [
    { key: 'bom-data', label: 'BOM Data', icon: Database, view: 'bom-data' }, // 新增
    { key: 'external', label: 'External Systems', icon: Database, view: 'external' },
    { key: 'import-history', label: 'Import History', icon: History, view: 'import-history' },
    // ...
  ]
}
```

4. **更新首頁模組卡片**：
```javascript
const dataModules = [
  { 
    id: 'bom-data', 
    title: "BOM Data Dashboard", 
    description: "View and search BOM edges and demand FG data with filtering", 
    icon: Database, 
    color: "text-blue-500" 
  },
  // ... 其他模組
];
```

## 🚀 使用說明

### 訪問頁面

**方式 1：從導航列**
```
導航列 → Data 下拉選單 → BOM Data
```

**方式 2：從首頁**
```
首頁 → Data Management 區塊 → BOM Data Dashboard 卡片
```

### 基本操作

#### 1️⃣ **切換 Tab**
```
點擊頂部的 "BOM Edges" 或 "Demand FG" Tab
自動清空篩選條件並重新載入資料
```

#### 2️⃣ **使用篩選**
```
1. 確保篩選器已展開（預設展開）
2. 在對應欄位輸入搜尋關鍵字
3. 支援部分匹配（ILIKE 模糊搜尋）
4. 自動重置到第 1 頁
```

#### 3️⃣ **翻頁瀏覽**
```
使用底部的 "上一頁" / "下一頁" 按鈕
查看當前頁碼和總頁數
每頁固定顯示 100 筆資料
```

#### 4️⃣ **清除篩選**
```
點擊篩選器右上角的 "清除篩選" 按鈕
恢復預設狀態（無篩選）
```

#### 5️⃣ **重新整理**
```
點擊右上角的 "重新整理" 按鈕
重新載入當前頁面的資料
```

## 📊 SQL 查詢邏輯

### BOM Edges 查詢範例

```sql
-- 無篩選
SELECT * FROM bom_edges
WHERE user_id = '<user_id>'
ORDER BY created_at DESC
LIMIT 100 OFFSET 0;

-- 有篩選
SELECT * FROM bom_edges
WHERE user_id = '<user_id>'
  AND parent_material ILIKE '%FG%'
  AND plant_id ILIKE '%P01%'
ORDER BY created_at DESC
LIMIT 100 OFFSET 0;

-- 計算總筆數
SELECT COUNT(*) FROM bom_edges
WHERE user_id = '<user_id>'
  AND parent_material ILIKE '%FG%';
```

### Demand FG 查詢範例

```sql
-- 無篩選
SELECT * FROM demand_fg
WHERE user_id = '<user_id>'
ORDER BY created_at DESC
LIMIT 100 OFFSET 0;

-- 有篩選
SELECT * FROM demand_fg
WHERE user_id = '<user_id>'
  AND material_code ILIKE '%FG%'
  AND time_bucket ILIKE '%2026-W05%'
ORDER BY created_at DESC
LIMIT 100 OFFSET 100;  -- 第 2 頁

-- 計算總筆數
SELECT COUNT(*) FROM demand_fg
WHERE user_id = '<user_id>'
  AND material_code ILIKE '%FG%';
```

## 🎨 UI 結構

```
BOM Data Dashboard
├─ Header（標題 + 重新整理按鈕）
├─ Tabs（BOM Edges / Demand FG）
├─ Filters（可摺疊篩選器）
│  ├─ 顯示/隱藏篩選按鈕
│  ├─ 4 個搜尋欄位（根據 Tab 動態調整）
│  └─ 清除篩選按鈕
├─ Data Table
│  ├─ 表頭（欄位名稱）
│  ├─ 表格內容（最多 12 欄）
│  └─ 空狀態提示
└─ Pagination（分頁控制）
   ├─ 顯示範圍（1-100 / 共 1000 筆）
   ├─ 上一頁按鈕
   ├─ 頁碼指示
   └─ 下一頁按鈕
```

## 📝 範例場景

### 場景 1：查看所有 BOM Edges

```
1. 進入 BOM Data Dashboard
2. 預設在 BOM Edges Tab
3. 查看前 100 筆最新資料
4. 翻頁查看更多
```

### 場景 2：搜尋特定批次的 BOM 資料

```
1. 在 BOM Edges Tab
2. 在 "Batch ID" 欄位輸入：abc-123
3. 自動篩選並顯示結果
4. 查看該批次的所有 BOM 關係
```

### 場景 3：查看特定料號的需求

```
1. 切換到 Demand FG Tab
2. 在 "Material Code" 欄位輸入：FG001
3. 在 "Time Bucket" 欄位輸入：2026-W
4. 查看 2026 年所有週次的 FG001 需求
```

### 場景 4：查看特定工廠的資料

```
1. 選擇任一 Tab
2. 在 "Plant ID" 欄位輸入：P01
3. 查看 P01 工廠的所有相關資料
```

## 🔍 效能考量

### 索引優化

**建議索引**（如果尚未建立）：

```sql
-- bom_edges 表
CREATE INDEX IF NOT EXISTS idx_bom_edges_user_created 
  ON bom_edges(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bom_edges_parent 
  ON bom_edges(parent_material);

CREATE INDEX IF NOT EXISTS idx_bom_edges_child 
  ON bom_edges(child_material);

-- demand_fg 表
CREATE INDEX IF NOT EXISTS idx_demand_fg_user_created 
  ON demand_fg(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_demand_fg_material 
  ON demand_fg(material_code);

CREATE INDEX IF NOT EXISTS idx_demand_fg_time 
  ON demand_fg(time_bucket);
```

### 分頁策略

- **Server-side Pagination**: 每次只載入 100 筆
- **適合大數據集**: 可處理 10,000+ 筆資料
- **查詢效能**: 使用 LIMIT/OFFSET，配合索引快速查詢

### 搜尋效能

- **ILIKE 模糊搜尋**: 支援部分匹配
- **索引支援**: 欄位索引加速查詢
- **即時篩選**: 輸入即搜尋，無需按按鈕

## 🧪 測試建議

### 功能測試

1. **Tab 切換**
   - [ ] 切換到 BOM Edges Tab
   - [ ] 切換到 Demand FG Tab
   - [ ] Tab 切換時清空篩選
   - [ ] Tab 顯示正確的資料筆數

2. **篩選功能**
   - [ ] 單一欄位篩選
   - [ ] 多欄位組合篩選
   - [ ] 模糊搜尋正常運作
   - [ ] 清除篩選恢復預設

3. **分頁功能**
   - [ ] 下一頁按鈕
   - [ ] 上一頁按鈕
   - [ ] 頁碼顯示正確
   - [ ] 第一頁時「上一頁」disabled
   - [ ] 最後一頁時「下一頁」disabled

4. **資料顯示**
   - [ ] 預設按 created_at DESC 排序
   - [ ] 表格顯示最多 12 欄
   - [ ] 空狀態顯示正確提示
   - [ ] Loading 狀態顯示 spinner

### 效能測試

1. **小數據集（< 1000 筆）**
   - 查詢時間 < 100ms
   - 翻頁流暢

2. **中數據集（1000-10000 筆）**
   - 查詢時間 < 200ms
   - 分頁正常

3. **大數據集（> 10000 筆）**
   - 查詢時間 < 500ms
   - 使用索引優化

## 📈 後續優化建議

### Phase 2 功能

1. **排序功能**
   - 點擊欄位標題排序
   - 升序/降序切換
   - 保留排序狀態

2. **匯出功能**
   - 匯出當前篩選結果為 CSV
   - 匯出所有資料（背景任務）

3. **進階篩選**
   - 日期範圍篩選
   - 數值範圍篩選（qty_per, demand_qty）
   - 多選下拉選單

4. **欄位自訂**
   - 選擇要顯示的欄位
   - 調整欄位順序
   - 儲存使用者偏好

### Phase 3 功能

1. **資料視覺化**
   - 簡單的圖表（Bar/Line Chart）
   - 摘要統計

2. **批量操作**
   - 選擇多筆資料
   - 批量刪除
   - 批量匯出

3. **即時更新**
   - WebSocket 即時同步
   - 自動重新整理

## ✅ 完成檢查清單

- [x] 創建 `BOMDataView.jsx` 元件
- [x] 更新 `App.jsx` 添加路由
- [x] 更新導航配置添加選單項目
- [x] 更新首頁模組卡片
- [x] 雙 Tab 切換功能
- [x] 預設按 created_at DESC 排序
- [x] 動態搜尋條件（BOM Edges / Demand FG）
- [x] Server-side pagination（100 筆/頁）
- [x] 最小可用 UI（無複雜圖表）
- [x] Responsive 設計
- [x] Dark mode 支援
- [x] 創建使用說明文檔

## 🎉 總結

**BOM Data Dashboard** 現已完成，提供：

✅ **簡潔的雙 Tab 介面**  
✅ **靈活的搜尋篩選**  
✅ **高效的分頁查詢**  
✅ **最小可用的 UI 設計**  
✅ **完整的導航整合**  

使用者現在可以輕鬆查看和搜尋 BOM Edges 和 Demand FG 資料，提升資料查詢效率！

---

**實作日期**：2026-01-30  
**版本**：v1.0.0  
**狀態**：✅ 已完成
