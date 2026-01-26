# BOM Explosion 資料模板規格

## 概述

本文件定義了「Component / BOM-Derived Forecast（BOM 展開需求）」MVP 所需的兩種資料模板規格：
1. **bom_edge** - BOM 關係表（父子件用量關係）
2. **demand_fg** - FG 需求表（成品需求時間序列）

---

## Template 1: bom_edge（BOM 關係表）

### (1) 檔案命名建議

- **Excel 格式**：`bom_edge.xlsx`
- **CSV 格式**：`bom_edge.csv`
- **Sheet 名稱**（如使用 Excel 多工作表）：`bom_edge` 或 `BOM`

---

### (2) 欄位清單

| column_name | required | data_type | example | description | validation rules |
|------------|----------|-----------|---------|-------------|------------------|
| parent_material | Y | string | FG-001 | 父件料號 / Parent Material Code | 不可為空，建議使用唯一識別碼 |
| child_material | Y | string | COMP-001 | 子件料號 / Child Material Code | 不可為空 |
| qty_per | Y | float | 2.5 | 單位用量 / Quantity Per Unit | > 0，支援小數（如 0.5, 2.5） |
| uom | N | string | pcs | 單位 / Unit of Measure | 預設值：pcs（如 kg, m, pcs） |
| plant_id | N | string | PLANT-01 | 工廠代碼 / Plant Code | 如有多廠，需指定 |
| bom_version | N | string | V1.0 | BOM 版本 / BOM Version | 用於版本控制 |
| valid_from | N | date | 2026-01-01 | 生效日期 / Valid From Date | 格式：YYYY-MM-DD，需 <= valid_to |
| valid_to | N | date | 2026-12-31 | 失效日期 / Valid To Date | 格式：YYYY-MM-DD，需 >= valid_from |
| scrap_rate | N | float | 0.05 | 損耗率 / Scrap Rate | 0 <= scrap_rate < 1（如 0.05 表示 5%） |
| yield_rate | N | float | 0.95 | 良率 / Yield Rate | 0 < yield_rate <= 1（如 0.95 表示 95%） |
| alt_group | N | string | ALT-GROUP-01 | 替代料組 / Alternative Group | 同一組內為替代料 |
| priority | N | int | 1 | 優先順序 / Priority | 數字越小優先級越高（1=最高） |
| mix_ratio | N | float | 0.6 | 混合比例 / Mix Ratio | 0 < mix_ratio <= 1（用於替代料分配） |
| ecn_number | N | string | ECN-2026-001 | 工程變更單號 / ECN Number | 工程變更追蹤 |
| ecn_effective_date | N | date | 2026-03-01 | ECN 生效日 / ECN Effective Date | 格式：YYYY-MM-DD |
| routing_id | N | string | ROUTE-001 | 製程代碼 / Routing ID | 製程版本識別 |
| notes | N | string | 備註說明 | 備註 / Notes | 自由文字說明 |

---

### (3) 範例資料列（至少 5 筆）

| parent_material | child_material | qty_per | uom | plant_id | bom_version | valid_from | valid_to | scrap_rate | yield_rate | alt_group | priority | mix_ratio | ecn_number | ecn_effective_date | routing_id | notes |
|----------------|----------------|---------|-----|----------|-------------|------------|----------|------------|------------|-----------|----------|-----------|-------------|-------------------|------------|-------|
| FG-001 | COMP-001 | 2.0 | pcs | PLANT-01 | V1.0 | 2026-01-01 | 2026-12-31 | 0.02 | 0.98 | | | | | | | |
| FG-001 | COMP-002 | 1.5 | pcs | PLANT-01 | V1.0 | 2026-01-01 | 2026-12-31 | 0.01 | 0.99 | | | | | | | |
| FG-001 | COMP-003 | 0.5 | kg | PLANT-01 | V1.0 | 2026-01-01 | 2026-12-31 | 0.05 | 0.95 | | | | | | | |
| FG-002 | COMP-001 | 1.0 | pcs | PLANT-01 | V1.0 | 2026-01-01 | 2026-12-31 | 0.03 | 0.97 | | | | | | | |
| FG-002 | COMP-004 | 3.0 | pcs | PLANT-01 | V1.0 | 2026-01-01 | 2026-12-31 | 0.02 | 0.98 | ALT-GROUP-01 | 1 | 0.7 | ECN-2026-001 | 2026-03-01 | ROUTE-001 | 主要替代料 |
| FG-002 | COMP-005 | 3.0 | pcs | PLANT-01 | V1.0 | 2026-01-01 | 2026-12-31 | 0.02 | 0.98 | ALT-GROUP-01 | 2 | 0.3 | ECN-2026-001 | 2026-03-01 | ROUTE-001 | 次要替代料 |

---

### (4) MVP 必要欄位 vs 進階可選欄位

#### ✅ MVP 必要欄位（Minimum Viable Product）

以下欄位為執行基本 BOM explosion 所必需：

| 欄位名稱 | 說明 |
|---------|------|
| `parent_material` | 父件料號（必須） |
| `child_material` | 子件料號（必須） |
| `qty_per` | 單位用量（必須，> 0） |

**最少必要欄位組合**：僅需上述 3 個欄位即可執行基本 BOM 展開。

---

#### 🔧 進階可選欄位（Advanced Optional Fields）

以下欄位用於進階功能，MVP 階段可選：

| 欄位名稱 | 用途 | MVP 階段 |
|---------|------|----------|
| `uom` | 單位識別 | 建議保留 |
| `plant_id` | 多廠支援 | 可選 |
| `bom_version` | 版本控制 | 可選 |
| `valid_from` / `valid_to` | 時效性控制 | 可選 |
| `scrap_rate` | 損耗率計算 | 可選（MVP 可設為 0） |
| `yield_rate` | 良率計算 | 可選（MVP 可設為 1） |
| `alt_group` / `priority` / `mix_ratio` | 替代料分配 | 可選（MVP 不支援替代料分配） |
| `ecn_number` / `ecn_effective_date` | 工程變更追蹤 | 可選 |
| `routing_id` | 製程版本 | 可選 |
| `notes` | 備註 | 可選 |

---

### (5) 常見錯誤清單

| 錯誤類型 | 錯誤範例 | 正確寫法 | 說明 |
|---------|---------|---------|------|
| **BOM Cycle（循環引用）** | FG-001 → COMP-001 → FG-001 | 避免循環 | 父件不能是子件的子件（系統需檢測） |
| **qty_per = 0 或負數** | qty_per: 0, -1 | qty_per: 2.5 | qty_per 必須 > 0 |
| **日期格式錯誤** | 2026/1/1, 01-01-2026 | 2026-01-01 | 必須使用 YYYY-MM-DD |
| **valid_from > valid_to** | valid_from: 2026-12-31<br>valid_to: 2026-01-01 | valid_from <= valid_to | 生效日不能晚於失效日 |
| **scrap_rate 超出範圍** | scrap_rate: 1.5, -0.1 | scrap_rate: 0.05 | 0 <= scrap_rate < 1 |
| **yield_rate 超出範圍** | yield_rate: 1.5, 0 | yield_rate: 0.95 | 0 < yield_rate <= 1 |
| **mix_ratio 總和不等於 1** | 同一 alt_group 的 mix_ratio 總和 = 0.5 | mix_ratio 總和 = 1.0 | 替代料組內比例需加總為 1 |
| **欄位名稱拼寫錯誤** | parent_material_code, Parent_Material | parent_material | 必須使用 snake_case |
| **空值在必填欄位** | parent_material: (空白) | parent_material: FG-001 | 必填欄位不可為空 |
| **特殊字元** | parent_material: FG@001 | parent_material: FG-001 | 避免 @, #, $ 等特殊字元 |

---

## Template 2: demand_fg（FG 需求表）

### (1) 檔案命名建議

- **Excel 格式**：`demand_fg.xlsx`
- **CSV 格式**：`demand_fg.csv`
- **Sheet 名稱**（如使用 Excel 多工作表）：`demand_fg` 或 `Demand`

---

### (2) 欄位清單

| column_name | required | data_type | example | description | validation rules |
|------------|----------|-----------|---------|-------------|------------------|
| material_code | Y | string | FG-001 | 成品料號 / Finished Goods Material Code | 不可為空 |
| plant_id | Y | string | PLANT-01 | 工廠代碼 / Plant Code | 不可為空（支援多廠） |
| time_bucket | Y | string | 2026-W02 | 時間桶 / Time Bucket | 格式：week_bucket (2026-W02) 或 date (2026-01-08)，擇一即可 |
| date | N | date | 2026-01-08 | 日期 / Date | 格式：YYYY-MM-DD（與 time_bucket 擇一） |
| week_bucket | N | string | 2026-W02 | 週桶 / Week Bucket | 格式：YYYY-W##（與 date 擇一） |
| demand_qty | Y | float | 1000.0 | 需求數量 / Demand Quantity | >= 0，支援小數 |
| uom | N | string | pcs | 單位 / Unit of Measure | 預設值：pcs |
| source_type | N | string | SO | 需求來源類型 / Source Type | 可選值：SO, forecast, manual, other |
| source_id | N | string | SO-2026-001 | 需求來源 ID / Source ID | 如訂單號、預測編號等 |
| customer_id | N | string | CUST-001 | 客戶代碼 / Customer Code | 客戶識別 |
| project_id | N | string | PROJ-001 | 專案代碼 / Project Code | 專案識別 |
| priority | N | int | 1 | 優先順序 / Priority | 數字越小優先級越高 |
| status | N | string | confirmed | 狀態 / Status | 可選值：draft, confirmed, cancelled |
| notes | N | string | 備註說明 | 備註 / Notes | 自由文字說明 |

---

### (3) 範例資料列（至少 5 筆）

#### 範例 A：使用 week_bucket（週桶格式）

| material_code | plant_id | time_bucket | week_bucket | date | demand_qty | uom | source_type | source_id | customer_id | project_id | priority | status | notes |
|--------------|----------|-------------|-------------|------|------------|-----|-------------|-----------|-------------|------------|----------|--------|-------|
| FG-001 | PLANT-01 | 2026-W02 | 2026-W02 | | 1000.0 | pcs | SO | SO-2026-001 | CUST-001 | | 1 | confirmed | |
| FG-001 | PLANT-01 | 2026-W03 | 2026-W03 | | 1500.0 | pcs | forecast | FCST-2026-001 | | | 2 | confirmed | |
| FG-001 | PLANT-01 | 2026-W04 | 2026-W04 | | 1200.0 | pcs | manual | | | PROJ-001 | 1 | confirmed | |
| FG-002 | PLANT-01 | 2026-W02 | 2026-W02 | | 800.0 | pcs | SO | SO-2026-002 | CUST-002 | | 1 | confirmed | |
| FG-002 | PLANT-01 | 2026-W03 | 2026-W03 | | 900.0 | pcs | forecast | FCST-2026-002 | | | 2 | confirmed | |

#### 範例 B：使用 date（日期格式）

| material_code | plant_id | time_bucket | week_bucket | date | demand_qty | uom | source_type | source_id | customer_id | project_id | priority | status | notes |
|--------------|----------|-------------|-------------|------|------------|-----|-------------|-----------|-------------|------------|----------|--------|-------|
| FG-001 | PLANT-01 | 2026-01-08 | | 2026-01-08 | 1000.0 | pcs | SO | SO-2026-001 | CUST-001 | | 1 | confirmed | |
| FG-001 | PLANT-01 | 2026-01-15 | | 2026-01-15 | 1500.0 | pcs | forecast | FCST-2026-001 | | | 2 | confirmed | |
| FG-001 | PLANT-01 | 2026-01-22 | | 2026-01-22 | 1200.0 | pcs | manual | | | PROJ-001 | 1 | confirmed | |
| FG-002 | PLANT-01 | 2026-01-08 | | 2026-01-08 | 800.0 | pcs | SO | SO-2026-002 | CUST-002 | | 1 | confirmed | |
| FG-002 | PLANT-01 | 2026-01-15 | | 2026-01-15 | 900.0 | pcs | forecast | FCST-2026-002 | | | 2 | confirmed | |

**注意**：`time_bucket` 欄位為統一時間識別欄位，系統會自動從 `week_bucket` 或 `date` 欄位填入。使用者只需填寫 `week_bucket` 或 `date` 其中一個即可。

---

### (4) MVP 必要欄位 vs 進階可選欄位

#### ✅ MVP 必要欄位（Minimum Viable Product）

以下欄位為執行基本 BOM explosion 所必需：

| 欄位名稱 | 說明 |
|---------|------|
| `material_code` | 成品料號（必須） |
| `plant_id` | 工廠代碼（必須，支援多廠） |
| `time_bucket` | 時間桶（必須，可從 week_bucket 或 date 自動填入） |
| `demand_qty` | 需求數量（必須，>= 0） |

**時間欄位說明**：
- 使用者可選擇填寫 `week_bucket`（格式：2026-W02）或 `date`（格式：2026-01-08）
- 系統會自動將其中一個值填入 `time_bucket` 欄位
- 如果兩個都填寫，優先使用 `date`

**最少必要欄位組合**：
- `material_code` + `plant_id` + (`week_bucket` 或 `date`) + `demand_qty`

---

#### 🔧 進階可選欄位（Advanced Optional Fields）

以下欄位用於進階功能，MVP 階段可選：

| 欄位名稱 | 用途 | MVP 階段 |
|---------|------|----------|
| `uom` | 單位識別 | 建議保留 |
| `source_type` | 需求來源分類 | 可選（建議保留，用於追溯） |
| `source_id` | 需求來源 ID | 可選（建議保留，用於追溯） |
| `customer_id` | 客戶識別 | 可選 |
| `project_id` | 專案識別 | 可選 |
| `priority` | 優先順序 | 可選 |
| `status` | 狀態管理 | 可選 |
| `notes` | 備註 | 可選 |

---

### (5) 常見錯誤清單

| 錯誤類型 | 錯誤範例 | 正確寫法 | 說明 |
|---------|---------|---------|------|
| **時間欄位格式錯誤** | week_bucket: 2026W2, 2026/02 | week_bucket: 2026-W02 | 必須使用 YYYY-W## 格式 |
| **日期格式錯誤** | date: 2026/1/8, 01-08-2026 | date: 2026-01-08 | 必須使用 YYYY-MM-DD |
| **week_bucket 和 date 都為空** | (兩者皆空白) | 至少填寫一個 | time_bucket 必須有值 |
| **demand_qty 為負數** | demand_qty: -100 | demand_qty: 1000.0 | demand_qty >= 0 |
| **plant_id 為空** | plant_id: (空白) | plant_id: PLANT-01 | 必填欄位（支援多廠） |
| **material_code 為空** | material_code: (空白) | material_code: FG-001 | 必填欄位 |
| **source_type 值不在清單** | source_type: order | source_type: SO | 必須為：SO, forecast, manual, other |
| **欄位名稱拼寫錯誤** | material_id, Material_Code | material_code | 必須使用 snake_case |
| **特殊字元** | material_code: FG@001 | material_code: FG-001 | 避免 @, #, $ 等特殊字元 |
| **week_bucket 週數超出範圍** | 2026-W53 | 2026-W01 ~ 2026-W52/53 | 週數需在有效範圍內 |

---

## SmartOps 上傳注意事項

### 📋 檔案準備要求

1. **第一列必須是 Header（欄位名稱）**
   - 第一列必須包含所有欄位名稱（使用 snake_case）
   - 範例：`parent_material,child_material,qty_per,uom,plant_id`
   - 不可使用合併儲存格作為 header

2. **不可合併儲存格**
   - Excel 檔案中不可使用「合併儲存格」功能
   - 每個資料列必須完整，不可跨列合併

3. **空值處理**
   - 可選欄位可留空（不填寫）
   - 必填欄位不可為空
   - 空值請直接留空，不要填寫 "N/A", "NULL", "--" 等文字

4. **日期格式**
   - 統一使用 `YYYY-MM-DD` 格式（例如：2026-01-08）
   - 支援的格式：`2026-01-08`, `2026/01/08`（系統會自動轉換）
   - 不支援：`01-08-2026`, `08/01/2026`（可能造成誤判）

5. **編碼格式**
   - CSV 檔案必須使用 **UTF-8** 編碼
   - Excel 檔案建議使用 `.xlsx` 格式（Excel 2007+）

6. **欄位 Mapping 建議**
   - 系統會自動偵測欄位名稱（snake_case）
   - 如果 Excel 欄位名稱與系統欄位名稱完全一致，系統會自動映射
   - 如果欄位名稱不同，需手動進行欄位映射
   - 範例：Excel 欄位「父件料號」需映射到系統欄位 `parent_material`

7. **資料驗證**
   - 上傳前系統會自動驗證資料格式
   - 驗證失敗的資料列會顯示錯誤訊息
   - 修正錯誤後可重新上傳

8. **批次識別**
   - 系統會自動為每筆上傳產生 `batch_id`（批次 ID）
   - 用於追溯資料來源和上傳時間
   - 使用者無需在模板中填寫 `batch_id`

---

## 最少必要欄位清單（BOM Explosion MVP）

### 執行 BOM 展開所需的最少欄位

要執行基本的 BOM explosion（從 FG 需求展開到 Component 需求），最少需要以下欄位：

#### 1. bom_edge 表（最少 3 個欄位）

| 欄位名稱 | 說明 |
|---------|------|
| `parent_material` | 父件料號 |
| `child_material` | 子件料號 |
| `qty_per` | 單位用量（> 0） |

#### 2. demand_fg 表（最少 4 個欄位）

| 欄位名稱 | 說明 |
|---------|------|
| `material_code` | 成品料號（FG） |
| `plant_id` | 工廠代碼 |
| `time_bucket` | 時間桶（從 `week_bucket` 或 `date` 自動填入） |
| `demand_qty` | 需求數量（>= 0） |

**時間欄位說明**：
- 使用者只需填寫 `week_bucket`（格式：2026-W02）或 `date`（格式：2026-01-08）其中一個
- 系統會自動將值填入 `time_bucket`

---

### BOM Explosion 計算邏輯（參考）

```
For each FG demand in demand_fg:
  For each BOM level (recursive):
    component_demand = parent_demand × qty_per × (1 + scrap_rate) / yield_rate
    If component is also a parent:
      Continue explosion to next level
```

**MVP 簡化版本**（不考慮 scrap/yield）：
```
component_demand = parent_demand × qty_per
```

---

## 總結

### 快速檢查清單

- [ ] bom_edge 表包含：`parent_material`, `child_material`, `qty_per`
- [ ] demand_fg 表包含：`material_code`, `plant_id`, `time_bucket`（或 `week_bucket`/`date`）, `demand_qty`
- [ ] 第一列是 header（欄位名稱）
- [ ] 無合併儲存格
- [ ] 日期格式為 YYYY-MM-DD
- [ ] CSV 檔案使用 UTF-8 編碼
- [ ] 必填欄位無空值
- [ ] qty_per > 0, demand_qty >= 0

---

## 附錄：欄位命名規範

### Snake Case 命名規則

- 使用小寫字母
- 單字之間用底線（`_`）分隔
- 範例：`parent_material`, `demand_qty`, `valid_from`

### 避免的命名方式

- ❌ Camel Case：`parentMaterial`, `demandQty`
- ❌ Pascal Case：`ParentMaterial`, `DemandQty`
- ❌ 空格：`parent material`, `demand qty`
- ❌ 特殊字元：`parent-material`, `demand@qty`

---

**文件版本**：v1.0  
**最後更新**：2026-01-08  
**適用範圍**：BOM Explosion MVP
