# BOM Explosion MVP 規格與驗收案例

## 概述

本文件定義 BOM Explosion（物料清單展開）功能的 MVP 規格，包含輸入輸出定義、計算規則、邊界案例處理，以及測試資料與預期結果。

**適用範圍**：SmartOps Step A - Component Demand 計算  
**版本**：v1.0 MVP  
**日期**：2026-01-25

---

## 1. 輸入輸出定義

### 1.1 輸入資料

#### 輸入表 1：`bom_edges`（BOM 關係表）

**核心欄位**（MVP 必要）：

| 欄位名稱 | 資料型別 | 必填 | 說明 | 範例 |
|---------|---------|------|------|------|
| `parent_material` | TEXT | Y | 父件料號 | FG-001 |
| `child_material` | TEXT | Y | 子件料號 | COMP-001 |
| `qty_per` | DECIMAL(10,4) | Y | 單位用量（> 0） | 2.5 |
| `plant_id` | TEXT | N | 工廠代碼（多廠支援） | PLANT-01 |
| `valid_from` | DATE | N | 生效日期 | 2026-01-01 |
| `valid_to` | DATE | N | 失效日期 | 2026-12-31 |
| `scrap_rate` | DECIMAL(5,4) | N | 損耗率（0 <= scrap_rate < 1） | 0.05 |
| `yield_rate` | DECIMAL(5,4) | N | 良率（0 < yield_rate <= 1） | 0.95 |

**進階欄位**（MVP 階段不使用）：
- `alt_group`, `priority`, `mix_ratio`（替代料相關，MVP 不支援）
- `bom_version`, `ecn_number`, `routing_id`（版本控制，MVP 不支援）

---

#### 輸入表 2：`demand_fg`（FG 需求表）

**核心欄位**（MVP 必要）：

| 欄位名稱 | 資料型別 | 必填 | 說明 | 範例 |
|---------|---------|------|------|------|
| `material_code` | TEXT | Y | 成品料號（FG） | FG-001 |
| `plant_id` | TEXT | Y | 工廠代碼 | PLANT-01 |
| `time_bucket` | TEXT | Y | 時間桶（統一時間鍵） | 2026-W02 或 2026-01-08 |
| `demand_qty` | DECIMAL(12,2) | Y | 需求數量（>= 0） | 1000.0 |
| `uom` | TEXT | N | 單位 | pcs |

**時間欄位說明**：
- `time_bucket` 為統一時間識別欄位
- 可從 `week_bucket`（格式：YYYY-W##）或 `date`（格式：YYYY-MM-DD）自動填入
- 如果兩者都有，優先使用 `date`

---

### 1.2 輸出資料

#### 輸出表 1：`component_demand`（Component 需求表）

**輸出欄位**：

| 欄位名稱 | 資料型別 | 說明 | 範例 |
|---------|---------|------|------|
| `id` | UUID | 主鍵（系統自動產生） | uuid |
| `user_id` | UUID | 使用者 ID | uuid |
| `batch_id` | UUID | 計算批次 ID | uuid |
| `material_code` | TEXT | Component 料號 | COMP-001 |
| `plant_id` | TEXT | 工廠代碼 | PLANT-01 |
| `time_bucket` | TEXT | 時間桶 | 2026-W02 |
| `demand_qty` | DECIMAL(12,2) | 需求數量（匯總後） | 2500.0 |
| `uom` | TEXT | 單位 | pcs |
| `source_fg_material` | TEXT | 來源 FG 料號（追溯用） | FG-001 |
| `source_fg_demand_id` | UUID | 來源 FG 需求 ID | uuid |
| `bom_level` | INTEGER | BOM 層級（1=直接子件，2=子件的子件） | 1 |
| `created_at` | TIMESTAMPTZ | 建立時間 | 2026-01-25 10:00:00 |

**輸出粒度**：
- **聚合維度**：`plant_id` + `time_bucket` + `material_code`
- 同一 Component、同一工廠、同一時間桶的需求會自動匯總
- 不同來源 FG 的需求會合併計算

---

#### 輸出表 2：`component_demand_trace`（Component 需求追溯表）

**輸出欄位**：

| 欄位名稱 | 資料型別 | 說明 | 範例 |
|---------|---------|------|------|
| `id` | UUID | 主鍵（系統自動產生） | uuid |
| `user_id` | UUID | 使用者 ID | uuid |
| `batch_id` | UUID | 計算批次 ID | uuid |
| `component_demand_id` | UUID | 關聯到 component_demand.id | uuid |
| `fg_demand_id` | UUID | 關聯到 demand_fg.id | uuid |
| `bom_edge_id` | UUID | 關聯到 bom_edges.id（BOM 路徑） | uuid |
| `qty_multiplier` | DECIMAL(12,4) | 數量乘數（計算過程追溯） | 2.5 |
| `bom_level` | INTEGER | BOM 層級 | 1 |
| `created_at` | TIMESTAMPTZ | 建立時間 | 2026-01-25 10:00:00 |

**追溯用途**：
- 記錄每個 Component 需求的來源路徑
- 支援從 Component 追溯到原始 FG 需求
- 記錄計算過程中的數量乘數（用於除錯）

---

## 2. MVP 計算規則

### 2.1 基本計算邏輯

#### 規則 1：多層 BOM 展開（遞迴）

```
For each FG demand in demand_fg:
  1. 查找該 FG 的所有直接子件（bom_edges where parent_material = FG）
  2. 計算直接子件需求：component_demand = parent_demand × qty_per
  3. 如果子件本身也是父件（存在 bom_edges where parent_material = child）：
     a. 遞迴展開子件的子件（bom_level + 1）
     b. 繼續展開直到沒有更多子件為止
```

**範例**：
```
FG-001 (需求 1000)
  └─ COMP-001 (qty_per=2) → 需求 = 1000 × 2 = 2000
      └─ COMP-010 (qty_per=0.5) → 需求 = 2000 × 0.5 = 1000
  └─ COMP-002 (qty_per=1.5) → 需求 = 1000 × 1.5 = 1500
```

---

#### 規則 2：替代料分配（MVP 階段不支援）

**MVP 階段行為**：
- 如果同一 `parent_material` + `child_material` 組合有多筆記錄（替代料），
- **MVP 階段**：只使用第一筆記錄（按 `priority` 排序，如果沒有 priority 則按 `created_at`）
- **未來版本**：將支援 `alt_group` + `mix_ratio` 進行替代料分配

**範例**（MVP 階段）：
```
FG-001 → COMP-001 (priority=1, qty_per=2.0)  ← 使用此筆
FG-001 → COMP-001 (priority=2, qty_per=1.5)  ← MVP 階段忽略
```

---

#### 規則 3：Scrap/Yield 處理（MVP 階段可選）

**計算公式**（如果提供 scrap_rate 或 yield_rate）：

```
component_demand = parent_demand × qty_per × (1 + scrap_rate) / yield_rate
```

**MVP 階段行為**：
- 如果 `scrap_rate` 為 NULL 或未提供，視為 0
- 如果 `yield_rate` 為 NULL 或未提供，視為 1
- 如果兩者都未提供，公式簡化為：`component_demand = parent_demand × qty_per`

**範例**：
```
情況 A：無 scrap/yield
  parent_demand = 1000, qty_per = 2.0
  → component_demand = 1000 × 2.0 = 2000

情況 B：有 scrap_rate = 0.05, yield_rate = 0.95
  → component_demand = 1000 × 2.0 × (1 + 0.05) / 0.95 = 2210.53

情況 C：只有 scrap_rate = 0.05
  → component_demand = 1000 × 2.0 × (1 + 0.05) / 1 = 2100

情況 D：只有 yield_rate = 0.95
  → component_demand = 1000 × 2.0 × 1 / 0.95 = 2105.26
```

---

#### 規則 4：時效性過濾（valid_from / valid_to）

**過濾邏輯**：
- 如果 `bom_edges.valid_from` 和 `valid_to` 都有值：
  - 使用 `demand_fg.time_bucket` 對應的日期（或週的起始日期）
  - 只選擇 `valid_from <= time_bucket_date <= valid_to` 的 BOM 記錄
- 如果 `valid_from` 或 `valid_to` 為 NULL，視為無時效限制（始終有效）

**範例**：
```
BOM 記錄：
  parent_material = FG-001, child_material = COMP-001
  valid_from = 2026-01-01, valid_to = 2026-06-30

FG 需求：
  material_code = FG-001, time_bucket = 2026-W10 (對應 2026-03-07)
  → 符合時效性，使用此 BOM 記錄

FG 需求：
  material_code = FG-001, time_bucket = 2026-W30 (對應 2026-07-20)
  → 不符合時效性，忽略此 BOM 記錄
```

---

#### 規則 5：工廠匹配（plant_id）

**匹配邏輯**：
- 如果 `bom_edges.plant_id` 有值：
  - 必須與 `demand_fg.plant_id` 完全匹配
  - 只選擇 `bom_edges.plant_id = demand_fg.plant_id` 的 BOM 記錄
- 如果 `bom_edges.plant_id` 為 NULL：
  - 視為通用 BOM（適用於所有工廠）
  - 所有工廠的 FG 需求都可以使用此 BOM 記錄

**範例**：
```
BOM 記錄 A：plant_id = PLANT-01, parent = FG-001, child = COMP-001
BOM 記錄 B：plant_id = NULL, parent = FG-001, child = COMP-002

FG 需求：plant_id = PLANT-01, material = FG-001
  → 使用 BOM 記錄 A 和 B（記錄 B 為通用 BOM）

FG 需求：plant_id = PLANT-02, material = FG-001
  → 只使用 BOM 記錄 B（記錄 A 只適用於 PLANT-01）
```

---

#### 規則 6：需求匯總（Aggregation）

**匯總邏輯**：
- 同一 `material_code` + `plant_id` + `time_bucket` 的 Component 需求會自動匯總
- 匯總時累加所有來源的需求數量

**範例**：
```
來源 1：FG-001 → COMP-001，需求 = 2000
來源 2：FG-002 → COMP-001，需求 = 1500

匯總結果：
  material_code = COMP-001
  plant_id = PLANT-01
  time_bucket = 2026-W02
  demand_qty = 2000 + 1500 = 3500
```

---

### 2.2 計算流程（Pseudocode）

```
function bomExplosion(userId, batchId):
  // Step 1: 取得所有 FG 需求
  fgDemands = SELECT * FROM demand_fg WHERE user_id = userId
  
  // Step 2: 初始化結果集合
  componentDemands = {}  // Map<key, demand_qty>
  traces = []  // List of trace records
  
  // Step 3: 對每個 FG 需求進行展開
  for each fgDemand in fgDemands:
    explodeBOM(fgDemand, 1, 1.0, [])  // bom_level=1, multiplier=1.0, path=[]
  
  // Step 4: 寫入 component_demand 表（匯總後）
  for each (key, totalQty) in componentDemands:
    INSERT INTO component_demand (material_code, plant_id, time_bucket, demand_qty, ...)
    VALUES (key.material, key.plant, key.time, totalQty, ...)
  
  // Step 5: 寫入 component_demand_trace 表
  for each trace in traces:
    INSERT INTO component_demand_trace (...)
    VALUES (trace.component_demand_id, trace.fg_demand_id, ...)

function explodeBOM(parentDemand, bomLevel, multiplier, path):
  // 取得當前時間桶對應的日期
  timeDate = getDateFromTimeBucket(parentDemand.time_bucket)
  
  // 查找所有子件（考慮 plant_id 和時效性）
  children = SELECT * FROM bom_edges
    WHERE parent_material = parentDemand.material_code
      AND (plant_id = parentDemand.plant_id OR plant_id IS NULL)
      AND (valid_from IS NULL OR valid_from <= timeDate)
      AND (valid_to IS NULL OR valid_to >= timeDate)
    ORDER BY priority ASC, created_at ASC  // MVP: 只取第一筆替代料
  
  // 對每個子件計算需求
  for each child in children:
    // 計算數量（考慮 scrap/yield）
    scrapRate = child.scrap_rate ?? 0
    yieldRate = child.yield_rate ?? 1
    childQty = parentDemand.demand_qty × child.qty_per × (1 + scrapRate) / yieldRate
    
    // 更新乘數
    newMultiplier = multiplier × child.qty_per × (1 + scrapRate) / yieldRate
    
    // 檢查循環引用
    if child.child_material in path:
      LOG WARNING: "BOM cycle detected: " + path + " -> " + child.child_material
      continue  // 跳過此子件
    
    // 匯總到 componentDemands
    key = (child.child_material, parentDemand.plant_id, parentDemand.time_bucket)
    componentDemands[key] += childQty
    
    // 記錄追溯資訊
    trace = {
      component_material: child.child_material,
      fg_demand_id: parentDemand.id,
      bom_edge_id: child.id,
      qty_multiplier: newMultiplier,
      bom_level: bomLevel
    }
    traces.append(trace)
    
    // 遞迴展開子件的子件
    childDemand = {
      material_code: child.child_material,
      plant_id: parentDemand.plant_id,
      time_bucket: parentDemand.time_bucket,
      demand_qty: childQty,
      id: null  // 虛擬需求，用於遞迴
    }
    explodeBOM(childDemand, bomLevel + 1, newMultiplier, path + [parentDemand.material_code])
```

---

## 3. Edge Cases（邊界案例）

### Edge Case 1：BOM 循環引用（Cycle）

**情境**：
```
FG-001 → COMP-001
COMP-001 → COMP-002
COMP-002 → COMP-001  ← 循環！
```

**預期行為**：
- 系統應檢測到循環引用
- 記錄警告訊息（LOG WARNING）
- 跳過造成循環的子件，不繼續展開
- 已展開的部分需求仍保留（不回溯）

**驗收標準**：
- [ ] 系統能檢測到循環引用
- [ ] 記錄警告訊息到日誌
- [ ] 不會進入無限迴圈
- [ ] 已計算的需求數量正確（不包含循環部分）

---

### Edge Case 2：缺少 BOM 定義（Missing BOM）

**情境**：
```
FG 需求：FG-001, demand_qty = 1000
BOM 記錄：無 FG-001 的 BOM 定義
```

**預期行為**：
- 系統應記錄警告訊息（LOG WARNING）
- 該 FG 需求無法展開，不產生 Component 需求
- 不影響其他 FG 需求的展開

**驗收標準**：
- [ ] 系統能檢測到缺少 BOM 定義
- [ ] 記錄警告訊息
- [ ] 不產生錯誤，繼續處理其他 FG 需求
- [ ] 其他 FG 的需求展開正常

---

### Edge Case 3：時效性重疊（Overlap Effectivity）

**情境**：
```
BOM 記錄 A：FG-001 → COMP-001, valid_from=2026-01-01, valid_to=2026-06-30, qty_per=2.0
BOM 記錄 B：FG-001 → COMP-001, valid_from=2026-05-01, valid_to=2026-12-31, qty_per=3.0

FG 需求：FG-001, time_bucket=2026-W20 (對應 2026-05-12)
→ 兩個 BOM 記錄都符合時效性（重疊期間：2026-05-01 ~ 2026-06-30）
```

**預期行為**（MVP 階段）：
- 如果兩筆記錄的 `parent_material` + `child_material` 相同：
  - **MVP 階段**：只使用第一筆（按 `created_at` 或 `priority` 排序）
  - **未來版本**：可能需要支援版本控制或 ECN 生效日優先

**驗收標準**：
- [ ] 系統能處理時效性重疊的情況
- [ ] MVP 階段只使用一筆 BOM 記錄
- [ ] 不產生重複的 Component 需求
- [ ] 記錄警告訊息（提醒有時效性重疊）

---

### Edge Case 4：多層 BOM 深度過大（Deep BOM）

**情境**：
```
FG-001 → COMP-001 (level 1)
COMP-001 → COMP-002 (level 2)
COMP-002 → COMP-003 (level 3)
...
COMP-099 → COMP-100 (level 100)  ← 深度過大
```

**預期行為**：
- 系統應設定最大遞迴深度限制（建議：50 層）
- 超過最大深度時，記錄警告並停止展開
- 已展開的部分需求仍保留

**驗收標準**：
- [ ] 系統設定最大遞迴深度（建議 50 層）
- [ ] 超過深度時記錄警告
- [ ] 不會造成堆疊溢出（Stack Overflow）
- [ ] 已計算的需求數量正確

---

### Edge Case 5：同一 Component 多個來源（Multiple Sources）

**情境**：
```
來源 1：FG-001 → COMP-001, demand_qty = 1000, qty_per = 2.0 → COMP-001 需求 = 2000
來源 2：FG-002 → COMP-001, demand_qty = 500, qty_per = 3.0 → COMP-001 需求 = 1500
來源 3：FG-003 → COMP-002 → COMP-001, demand_qty = 800, qty_per = 1.5 → COMP-001 需求 = 1200
```

**預期行為**：
- 所有來源的需求會自動匯總
- 最終 `component_demand` 表中只有一筆記錄：
  - `material_code = COMP-001`
  - `demand_qty = 2000 + 1500 + 1200 = 4700`
- `component_demand_trace` 表中會有多筆追溯記錄（每筆來源一筆）

**驗收標準**：
- [ ] 同一 Component 的需求正確匯總
- [ ] `component_demand` 表中只有一筆匯總記錄
- [ ] `component_demand_trace` 表中有多筆追溯記錄
- [ ] 可以從 Component 追溯到所有來源 FG

---

### Edge Case 6：工廠不匹配（Plant Mismatch）

**情境**：
```
BOM 記錄：parent = FG-001, child = COMP-001, plant_id = PLANT-01
FG 需求：material = FG-001, plant_id = PLANT-02
```

**預期行為**：
- 如果 BOM 記錄的 `plant_id` 有值且與 FG 需求的 `plant_id` 不匹配：
  - 不使用此 BOM 記錄
  - 如果沒有其他匹配的 BOM 記錄，記錄警告（缺少 BOM 定義）

**驗收標準**：
- [ ] 系統正確匹配工廠代碼
- [ ] 不匹配的 BOM 記錄被忽略
- [ ] 記錄警告訊息（如果沒有匹配的 BOM）
- [ ] 通用 BOM（plant_id = NULL）適用於所有工廠

---

### Edge Case 7：時間桶格式不一致（Time Bucket Format）

**情境**：
```
FG 需求 A：time_bucket = 2026-W02 (週桶格式)
FG 需求 B：time_bucket = 2026-01-08 (日期格式)
```

**預期行為**：
- 系統應能處理兩種時間桶格式
- 時效性過濾時，將時間桶轉換為日期進行比較
- 匯總時，相同時間桶（無論格式）的需求會合併

**驗收標準**：
- [ ] 系統能正確解析兩種時間桶格式
- [ ] 時效性過濾正確（時間桶轉換為日期）
- [ ] 不同格式但相同時間的需求能正確匯總
- [ ] 不產生錯誤或資料遺失

---

### Edge Case 8：Scrap/Yield 極端值（Extreme Scrap/Yield）

**情境**：
```
情況 A：scrap_rate = 0.9999 (極高損耗)
情況 B：yield_rate = 0.0001 (極低良率)
情況 C：scrap_rate = 0, yield_rate = 1 (無損耗，100% 良率)
```

**預期行為**：
- 系統應能處理極端值（在有效範圍內）
- 計算結果可能很大（高損耗）或很小（低良率），但應正確計算
- 如果值超出有效範圍（scrap_rate >= 1 或 yield_rate <= 0），應在資料驗證階段拒絕

**驗收標準**：
- [ ] 系統能處理有效範圍內的極端值
- [ ] 計算結果正確（即使數值很大或很小）
- [ ] 超出範圍的值在驗證階段被拒絕
- [ ] 不產生數值溢出錯誤

---

## 4. 測試資料與預期輸出

### 測試案例 1：簡單兩層 BOM

#### 輸入資料

**bom_edges 表**：

| id | parent_material | child_material | qty_per | plant_id | valid_from | valid_to | scrap_rate | yield_rate |
|----|----------------|---------------|---------|----------|-----------|-----------|-----------|------------|
| BE-001 | FG-001 | COMP-001 | 2.0 | PLANT-01 | 2026-01-01 | 2026-12-31 | 0.05 | 0.95 |
| BE-002 | FG-001 | COMP-002 | 1.5 | PLANT-01 | 2026-01-01 | 2026-12-31 | NULL | NULL |
| BE-003 | COMP-001 | COMP-010 | 0.5 | PLANT-01 | 2026-01-01 | 2026-12-31 | 0.02 | 1.0 |

**demand_fg 表**：

| id | material_code | plant_id | time_bucket | demand_qty | uom |
|----|--------------|----------|-------------|------------|-----|
| DF-001 | FG-001 | PLANT-01 | 2026-W02 | 1000.0 | pcs |
| DF-002 | FG-001 | PLANT-01 | 2026-W03 | 1500.0 | pcs |

---

#### 手算預期輸出

**計算過程**：

**FG-001, time_bucket=2026-W02, demand_qty=1000**：

1. **Level 1：直接子件**
   - COMP-001：`1000 × 2.0 × (1 + 0.05) / 0.95 = 2210.53`
   - COMP-002：`1000 × 1.5 × (1 + 0) / 1 = 1500.0`

2. **Level 2：COMP-001 的子件**
   - COMP-010：`2210.53 × 0.5 × (1 + 0.02) / 1.0 = 1127.37`

**FG-001, time_bucket=2026-W03, demand_qty=1500**：

1. **Level 1：直接子件**
   - COMP-001：`1500 × 2.0 × (1 + 0.05) / 0.95 = 3315.79`
   - COMP-002：`1500 × 1.5 × (1 + 0) / 1 = 2250.0`

2. **Level 2：COMP-001 的子件**
   - COMP-010：`3315.79 × 0.5 × (1 + 0.02) / 1.0 = 1691.05`

**匯總結果**（按 plant_id + time_bucket + material_code）：

| material_code | plant_id | time_bucket | demand_qty | bom_level | source_fg_material |
|--------------|----------|-------------|------------|-----------|-------------------|
| COMP-001 | PLANT-01 | 2026-W02 | 2210.53 | 1 | FG-001 |
| COMP-001 | PLANT-01 | 2026-W03 | 3315.79 | 1 | FG-001 |
| COMP-002 | PLANT-01 | 2026-W02 | 1500.0 | 1 | FG-001 |
| COMP-002 | PLANT-01 | 2026-W03 | 2250.0 | 1 | FG-001 |
| COMP-010 | PLANT-01 | 2026-W02 | 1127.37 | 2 | FG-001 |
| COMP-010 | PLANT-01 | 2026-W03 | 1691.05 | 2 | FG-001 |

---

#### 預期輸出（component_demand 表）

| material_code | plant_id | time_bucket | demand_qty | uom | source_fg_material | bom_level |
|--------------|----------|-------------|------------|-----|-------------------|-----------|
| COMP-001 | PLANT-01 | 2026-W02 | 2210.53 | pcs | FG-001 | 1 |
| COMP-001 | PLANT-01 | 2026-W03 | 3315.79 | pcs | FG-001 | 1 |
| COMP-002 | PLANT-01 | 2026-W02 | 1500.0 | pcs | FG-001 | 1 |
| COMP-002 | PLANT-01 | 2026-W03 | 2250.0 | pcs | FG-001 | 1 |
| COMP-010 | PLANT-01 | 2026-W02 | 1127.37 | pcs | FG-001 | 2 |
| COMP-010 | PLANT-01 | 2026-W03 | 1691.05 | pcs | FG-001 | 2 |

**注意**：實際輸出中，`source_fg_material` 可能只保留一個值（如果有多個來源會匯總），但 `component_demand_trace` 表會記錄所有來源。

---

### 測試案例 2：多來源匯總 + 時效性過濾

#### 輸入資料

**bom_edges 表**：

| id | parent_material | child_material | qty_per | plant_id | valid_from | valid_to | scrap_rate | yield_rate |
|----|----------------|---------------|---------|----------|-----------|-----------|-----------|------------|
| BE-101 | FG-001 | COMP-001 | 2.0 | PLANT-01 | 2026-01-01 | 2026-06-30 | NULL | NULL |
| BE-102 | FG-001 | COMP-001 | 3.0 | PLANT-01 | 2026-07-01 | 2026-12-31 | NULL | NULL |
| BE-103 | FG-002 | COMP-001 | 1.5 | NULL | 2026-01-01 | 2026-12-31 | 0.1 | NULL |
| BE-104 | FG-002 | COMP-002 | 2.5 | PLANT-01 | 2026-01-01 | 2026-12-31 | NULL | NULL |
| BE-105 | COMP-002 | COMP-001 | 0.8 | PLANT-01 | 2026-01-01 | 2026-12-31 | NULL | NULL |

**demand_fg 表**：

| id | material_code | plant_id | time_bucket | demand_qty | uom |
|----|--------------|----------|-------------|------------|-----|
| DF-101 | FG-001 | PLANT-01 | 2026-W10 | 1000.0 | pcs |
| DF-102 | FG-001 | PLANT-01 | 2026-W30 | 800.0 | pcs |
| DF-103 | FG-002 | PLANT-01 | 2026-W10 | 500.0 | pcs |
| DF-104 | FG-002 | PLANT-02 | 2026-W10 | 600.0 | pcs |

**時間桶對應日期**：
- 2026-W10 → 2026-03-07（3 月第 2 週）
- 2026-W30 → 2026-07-20（7 月第 3 週）

---

#### 手算預期輸出

**計算過程**：

**FG-001, time_bucket=2026-W10 (2026-03-07), demand_qty=1000**：
- 時效性檢查：BE-101 (valid_from=2026-01-01, valid_to=2026-06-30) ✓ 符合
- COMP-001：`1000 × 2.0 = 2000.0`

**FG-001, time_bucket=2026-W30 (2026-07-20), demand_qty=800**：
- 時效性檢查：BE-102 (valid_from=2026-07-01, valid_to=2026-12-31) ✓ 符合
- COMP-001：`800 × 3.0 = 2400.0`

**FG-002, time_bucket=2026-W10, plant_id=PLANT-01, demand_qty=500**：
- COMP-001：`500 × 1.5 × (1 + 0.1) = 825.0`（通用 BOM，plant_id=NULL）
- COMP-002：`500 × 2.5 = 1250.0`
  - COMP-002 的子件 COMP-001：`1250 × 0.8 = 1000.0`

**FG-002, time_bucket=2026-W10, plant_id=PLANT-02, demand_qty=600**：
- COMP-001：`600 × 1.5 × (1 + 0.1) = 990.0`（通用 BOM）
- COMP-002：無匹配 BOM（BE-104 的 plant_id=PLANT-01，不匹配 PLANT-02）
  - 警告：缺少 COMP-002 的 BOM 定義（PLANT-02）

**匯總 COMP-001, PLANT-01, 2026-W10**：
- 來源 1：FG-001 → COMP-001 = 2000.0
- 來源 2：FG-002 → COMP-001 = 825.0
- 來源 3：FG-002 → COMP-002 → COMP-001 = 1000.0
- **總計**：2000 + 825 + 1000 = **3825.0**

**匯總 COMP-001, PLANT-02, 2026-W10**：
- 來源 1：FG-002 → COMP-001 = 990.0
- **總計**：**990.0**

---

#### 預期輸出（component_demand 表）

| material_code | plant_id | time_bucket | demand_qty | uom | source_fg_material | bom_level |
|--------------|----------|-------------|------------|-----|-------------------|-----------|
| COMP-001 | PLANT-01 | 2026-W10 | 3825.0 | pcs | FG-001, FG-002 | 1, 2 |
| COMP-001 | PLANT-01 | 2026-W30 | 2400.0 | pcs | FG-001 | 1 |
| COMP-001 | PLANT-02 | 2026-W10 | 990.0 | pcs | FG-002 | 1 |
| COMP-002 | PLANT-01 | 2026-W10 | 1250.0 | pcs | FG-002 | 1 |

**注意**：
- `source_fg_material` 欄位可能只顯示一個值（系統實作決定），但 `component_demand_trace` 表會記錄所有來源
- COMP-002 在 PLANT-02 沒有 BOM 定義，因此不產生需求（記錄警告）

---

## 5. 驗收標準總結

### 功能驗收

- [ ] **多層 BOM 展開**：能正確展開多層 BOM（至少支援 50 層）
- [ ] **時效性過濾**：能根據 `valid_from` / `valid_to` 過濾 BOM 記錄
- [ ] **工廠匹配**：能正確匹配 `plant_id`（支援通用 BOM，plant_id=NULL）
- [ ] **Scrap/Yield 計算**：能正確計算損耗率和良率（可選）
- [ ] **需求匯總**：能正確匯總同一 Component 的多個來源需求
- [ ] **追溯功能**：`component_demand_trace` 表能正確記錄需求來源

### Edge Cases 驗收

- [ ] **循環引用檢測**：能檢測並處理 BOM 循環引用
- [ ] **缺少 BOM 定義**：能處理缺少 BOM 定義的情況（記錄警告）
- [ ] **時效性重疊**：能處理時效性重疊的情況（MVP 階段只使用一筆）
- [ ] **深度限制**：能處理過深的 BOM（設定最大深度限制）
- [ ] **多來源匯總**：能正確匯總多個來源的需求
- [ ] **工廠不匹配**：能正確處理工廠不匹配的情況
- [ ] **時間桶格式**：能處理不同時間桶格式（週桶/日期）
- [ ] **極端值處理**：能處理 Scrap/Yield 的極端值（在有效範圍內）

### 資料驗收

- [ ] **測試案例 1**：簡單兩層 BOM 的計算結果正確
- [ ] **測試案例 2**：多來源匯總 + 時效性過濾的計算結果正確
- [ ] **資料完整性**：所有必要的欄位都有值
- [ ] **資料一致性**：`component_demand` 和 `component_demand_trace` 的資料一致

---

## 6. 實作注意事項

### 6.1 效能考量

- **批次處理**：建議使用批次插入（batch insert）寫入 `component_demand` 和 `component_demand_trace` 表
- **索引優化**：確保 `bom_edges` 表有適當的索引（`parent_material`, `plant_id`, `valid_from`, `valid_to`）
- **遞迴深度限制**：設定最大遞迴深度（建議 50 層），避免無限遞迴

### 6.2 錯誤處理

- **警告訊息**：所有警告應記錄到日誌（LOG），不中斷計算流程
- **錯誤訊息**：嚴重錯誤（如資料庫連接失敗）應拋出異常並中斷計算
- **部分失敗**：如果某個 FG 需求無法展開，不影響其他 FG 需求的處理

### 6.3 資料驗證

- **輸入驗證**：在計算前驗證 `bom_edges` 和 `demand_fg` 的資料完整性
- **計算驗證**：計算結果應符合預期範圍（如需求數量 >= 0）
- **追溯驗證**：確保 `component_demand_trace` 的記錄能正確追溯到原始 FG 需求

---

## 附錄：資料庫 Schema 參考

### bom_edges 表（關鍵欄位）

```sql
CREATE TABLE bom_edges (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  parent_material TEXT NOT NULL,
  child_material TEXT NOT NULL,
  qty_per DECIMAL(10, 4) NOT NULL CHECK (qty_per > 0),
  plant_id TEXT,
  valid_from DATE,
  valid_to DATE,
  scrap_rate DECIMAL(5, 4) CHECK (0 <= scrap_rate < 1),
  yield_rate DECIMAL(5, 4) CHECK (0 < yield_rate <= 1),
  ...
);
```

### demand_fg 表（關鍵欄位）

```sql
CREATE TABLE demand_fg (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  material_code TEXT NOT NULL,
  plant_id TEXT NOT NULL,
  time_bucket TEXT NOT NULL,
  demand_qty DECIMAL(12, 2) NOT NULL CHECK (demand_qty >= 0),
  ...
);
```

### component_demand 表（關鍵欄位）

```sql
CREATE TABLE component_demand (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  batch_id UUID,
  material_code TEXT NOT NULL,
  plant_id TEXT NOT NULL,
  time_bucket TEXT NOT NULL,
  demand_qty DECIMAL(12, 2) NOT NULL CHECK (demand_qty >= 0),
  source_fg_material TEXT,
  source_fg_demand_id UUID,
  bom_level INTEGER,
  ...
);
```

### component_demand_trace 表（關鍵欄位）

```sql
CREATE TABLE component_demand_trace (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  batch_id UUID,
  component_demand_id UUID NOT NULL,
  fg_demand_id UUID NOT NULL,
  bom_edge_id UUID,
  qty_multiplier DECIMAL(12, 4),
  bom_level INTEGER,
  ...
);
```

---

**文件版本**：v1.0 MVP  
**建立日期**：2026-01-25  
**適用範圍**：SmartOps BOM Explosion MVP 功能
