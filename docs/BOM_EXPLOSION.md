# BOM Explosion 功能文件

> 🟢 Current | 最後更新: 2026-02-04 | 版本: 1.0  
> **以原始碼為準**: `src/services/bomExplosionService.js`

## 📋 目錄

- [概述](#概述)
- [功能規格](#功能規格)
- [使用指南](#使用指南)
- [資料格式](#資料格式)
- [測試指南](#測試指南)
- [已知限制](#已知限制)

---

## 概述

BOM Explosion (物料清單展開) 是 Decision-Intelligence 的核心功能之一,用於將成品 (FG) 需求展開成零組件 (Component) 需求。

### 核心功能

- **多層 BOM 展開**: 支援最多 50 層的遞迴展開
- **時效性管理**: 根據 valid_from/valid_to 過濾 BOM 記錄
- **工廠匹配**: 支援多工廠場景與通用 BOM (plant_id=NULL)
- **損耗率計算**: 支援 scrap_rate 和 yield_rate 計算
- **需求匯總**: 自動匯總同一料號的多來源需求
- **完整追溯**: 記錄每個 Component 的需求來源路徑

---

## 功能規格

### 輸入資料表

#### 1. bom_edges (BOM 關係表)

**核心欄位** (MVP 必要):

| 欄位名稱 | 資料型別 | 必填 | 說明 | 範例 |
|---------|---------|------|------|------|
| parent_material | TEXT | Y | 父件料號 | FG-001 |
| child_material | TEXT | Y | 子件料號 | COMP-001 |
| qty_per | DECIMAL(10,4) | Y | 單位用量 (> 0) | 2.5 |
| plant_id | TEXT | N | 工廠代碼 | PLANT-01 |
| valid_from | DATE | N | 生效日期 | 2026-01-01 |
| valid_to | DATE | N | 失效日期 | 2026-12-31 |
| scrap_rate | DECIMAL(5,4) | N | 損耗率 (0 ≤ scrap_rate < 1) | 0.05 |
| yield_rate | DECIMAL(5,4) | N | 良率 (0 < yield_rate ≤ 1) | 0.95 |

#### 2. demand_fg (FG 需求表)

**核心欄位** (MVP 必要):

| 欄位名稱 | 資料型別 | 必填 | 說明 | 範例 |
|---------|---------|------|------|------|
| material_code | TEXT | Y | 成品料號 (FG) | FG-001 |
| plant_id | TEXT | Y | 工廠代碼 | PLANT-01 |
| time_bucket | TEXT | Y | 時間桶 | 2026-W02 或 2026-01-08 |
| demand_qty | DECIMAL(12,2) | Y | 需求數量 (≥ 0) | 1000.0 |
| uom | TEXT | N | 單位 | pcs |

### 輸出資料表

#### 1. component_demand (Component 需求表)

| 欄位名稱 | 資料型別 | 說明 | 範例 |
|---------|---------|------|------|
| id | UUID | 主鍵 (系統自動產生) | uuid |
| user_id | UUID | 使用者 ID | uuid |
| batch_id | UUID | 計算批次 ID | uuid |
| material_code | TEXT | Component 料號 | COMP-001 |
| plant_id | TEXT | 工廠代碼 | PLANT-01 |
| time_bucket | TEXT | 時間桶 | 2026-W02 |
| demand_qty | DECIMAL(12,2) | 需求數量 (匯總後) | 2500.0 |
| uom | TEXT | 單位 | pcs |
| bom_level | INTEGER | BOM 層級 | 1 |
| created_at | TIMESTAMPTZ | 建立時間 | 2026-01-25 10:00:00 |

#### 2. component_demand_trace (追溯表)

| 欄位名稱 | 資料型別 | 說明 | 範例 |
|---------|---------|------|------|
| id | UUID | 主鍵 | uuid |
| batch_id | UUID | 計算批次 ID | uuid |
| component_demand_id | UUID | 關聯到 component_demand.id | uuid |
| fg_demand_id | UUID | 關聯到 demand_fg.id | uuid |
| trace_meta | JSONB | 追溯元數據 (path, qty等) | {...} |
| qty_multiplier | DECIMAL(12,4) | 數量乘數 | 2.5 |
| bom_level | INTEGER | BOM 層級 | 1 |
| created_at | TIMESTAMPTZ | 建立時間 | 2026-01-25 10:00:00 |

### 計算規則

#### 1. 基本計算公式

```
component_demand = parent_demand × qty_per × (1 + scrap_rate) / yield_rate
```

**範例**:
- parent_demand = 1000, qty_per = 2.0, scrap_rate = 0.05, yield_rate = 0.95
- → component_demand = 1000 × 2.0 × 1.05 / 0.95 = 2210.53

#### 2. 時效性過濾

- 如果 `valid_from` 和 `valid_to` 都有值:
  - 使用 `demand_fg.time_bucket` 對應的日期
  - 只選擇 `valid_from ≤ time_bucket_date ≤ valid_to` 的 BOM 記錄
- 如果為 NULL,視為無時效限制

#### 3. 工廠匹配

- 如果 `bom_edges.plant_id` 有值:
  - 必須與 `demand_fg.plant_id` 完全匹配
- 如果 `bom_edges.plant_id` 為 NULL:
  - 視為通用 BOM (適用於所有工廠)

#### 4. 需求匯總

- 同一 `material_code` + `plant_id` + `time_bucket` 的需求會自動匯總
- 累加所有來源的需求數量

---

## 使用指南

### Step 1: 上傳 BOM 資料

1. 前往 **Data Upload** 頁面
2. 選擇 **BOM Edge** 類型
3. 上傳 `bom_edge.xlsx` 或 `bom_edge.csv`
4. 完成欄位映射
5. 驗證並儲存

### Step 2: 上傳 FG 需求

1. 在 **Data Upload** 頁面
2. 選擇 **Demand FG** 類型
3. 上傳 `demand_fg.xlsx` 或 `demand_fg.csv`
4. 完成欄位映射
5. 驗證並儲存

### Step 3: 執行 BOM Explosion

1. 前往 **Forecasts** 頁面
2. 選擇篩選條件 (可選):
   - Plant ID
   - Time Buckets
3. 點擊 **Run BOM Explosion**
4. 等待計算完成 (通常 3-10 秒)

### Step 4: 查看結果

1. 在 **Results** 標籤查看 Component 需求
2. 在 **Trace** 標籤查看需求追溯
3. 使用篩選功能縮小範圍
4. 匯出 CSV 進行進一步分析

---

## 資料格式

### 模板檔案

位於 `templates/` 目錄:
- `bom_edge.xlsx` / `bom_edge.csv`
- `demand_fg.xlsx` / `demand_fg.csv`

### BOM Edge 範例

```csv
parent_material,child_material,qty_per,plant_id,valid_from,valid_to,scrap_rate,yield_rate
FG-001,COMP-001,2.0,PLANT-01,2026-01-01,2026-12-31,0.05,0.95
FG-001,COMP-002,1.5,PLANT-01,2026-01-01,2026-12-31,,,
COMP-001,COMP-010,0.5,PLANT-01,2026-01-01,2026-12-31,0.02,1.0
```

### Demand FG 範例

```csv
material_code,plant_id,time_bucket,demand_qty,uom
FG-001,PLANT-01,2026-W02,1000.0,pcs
FG-001,PLANT-01,2026-W03,1500.0,pcs
FG-002,PLANT-01,2026-W02,500.0,pcs
```

### 日期格式說明

- **time_bucket**: 
  - 週桶格式: `YYYY-W##` (例如: 2026-W02)
  - 日期格式: `YYYY-MM-DD` (例如: 2026-01-08)
- **valid_from / valid_to**: `YYYY-MM-DD`

---

## 測試指南

### 執行測試

```bash
npm run test:bom
```

### 測試案例

#### 案例 1: 簡單兩層 BOM

**輸入**:
- FG-001, 2026-W02: 1000
- FG-001, 2026-W03: 1500

**預期輸出**:
- COMP-001, PLANT-01, 2026-W02: 2210.53
- COMP-001, PLANT-01, 2026-W03: 3315.79
- COMP-002, PLANT-01, 2026-W02: 1500.00
- COMP-002, PLANT-01, 2026-W03: 2250.00
- COMP-010, PLANT-01, 2026-W02: 1127.37
- COMP-010, PLANT-01, 2026-W03: 1691.05

#### 案例 2: 多來源匯總

**預期行為**:
- 同一 Component 的多個來源需求會正確匯總
- 時效性過濾正確運作
- 通用 BOM (plant_id=NULL) 適用於所有工廠

---

## 已知限制

### MVP 階段不支援

- ❌ **替代料分配**: `alt_group` + `mix_ratio` 功能 (未來版本)
- ❌ **版本控制**: `bom_version`, `ecn_number` (未來版本)
- ❌ **路由管理**: `routing_id` (未來版本)

### 邊界案例處理

| 案例 | 處理方式 |
|-----|----------|
| **BOM 循環引用** | 檢測並跳過,記錄警告 |
| **缺少 BOM 定義** | 記錄警告,繼續處理其他 FG |
| **時效性重疊** | 只使用第一筆 (按 priority 或 created_at 排序) |
| **深度超過 50 層** | 停止展開,記錄警告 |
| **工廠不匹配** | 忽略該 BOM 記錄 |

### 效能考量

- **最大遞迴深度**: 50 層
- **批次插入**: 使用批次操作提高效能
- **索引優化**: 確保資料表有適當索引

---

## 相關文件

- **Forecasts View**: 查看 [FORECASTS.md](./FORECASTS.md)
- **資料庫結構**: 查看 [DATABASE_SCHEMA_GUIDE.md](../DATABASE_SCHEMA_GUIDE.md)
- **上傳指南**: 查看 [DATA_UPLOAD_COMPLETE_GUIDE.md](../DATA_UPLOAD_COMPLETE_GUIDE.md)

---

## API 參考

### executeBomExplosion()

```javascript
import { executeBomExplosion } from '../services/bomExplosionService';

const result = await executeBomExplosion(userId, options);
```

**參數**:
```javascript
{
  plantId: 'PLANT-01',       // 可選,篩選特定工廠
  timeBuckets: ['2026-W02'], // 可選,篩選特定時間桶
  maxDepth: 50                // 最大遞迴深度
}
```

**返回值**:
```javascript
{
  success: true,
  batchId: 'uuid',
  componentDemandCount: 6,
  traceCount: 10,
  errors: [],
  warnings: []
}
```

---

**維護者**: Decision-Intelligence Team  
**文件版本**: 1.0  
**程式碼版本**: 以 src/services/bomExplosionService.js 為準
