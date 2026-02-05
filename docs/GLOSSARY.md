# SmartOps 術語表

> 統一專案中使用的術語、縮寫和概念定義

## 📋 目錄

- [核心概念](#核心概念)
- [資料術語](#資料術語)
- [功能模組](#功能模組)
- [技術縮寫](#技術縮寫)

---

## 核心概念

### BOM (Bill of Materials) 
**物料清單**

描述產品結構的資料,定義一個成品 (FG) 由哪些零組件 (Component) 組成,以及各自的用量。

**相關術語**:
- **BOM Explosion** / **BOM Expansion**: BOM 展開,將成品需求展開成零組件需求
- **BOM Level**: BOM 層級,0=FG, 1=直接子件, 2=子件的子件...
- **Parent Material**: 父件 (例如: 成品、子組裝件)
- **Child Material**: 子件 (例如: 零件、原料)

### FG (Finished Good)
**成品**

最終交付給客戶的產品。在 BOM 結構中位於最頂層 (Level 0)。

**範例**: `FG-001`, `PRODUCT-A`

### Component
**零組件** / **物料**

組成成品的零件、原料、子組裝件。在 BOM 結構中位於 Level 1 或更深層。

**範例**: `COMP-001`, `MAT-Steel-304`

### Sub-Assembly (SA)
**子組裝件** / **中間件**

既是某個成品的子件,同時本身也有子件的物料。在 BOM 結構中位於中間層。

**範例**: 
```
FG-001 (Level 0)
  └─ SA-Motor-01 (Level 1) ← Sub-Assembly
      └─ COMP-Wire (Level 2)
```

---

## 資料術語

### Time Bucket
**時間桶** / **時間區間**

需求資料的時間維度識別碼,可以是週桶或日期。

**格式**:
- 週桶: `YYYY-W##` (例如: `2026-W02` = 2026年第2週)
- 日期: `YYYY-MM-DD` (例如: `2026-01-08`)

**使用場景**: 
- FG 需求按時間桶聚合
- BOM 展開結果按時間桶分組

### Plant ID
**工廠代碼**

識別生產或需求所屬的工廠/廠區。

**範例**: `PLANT-01`, `PLANT-TW`, `FACTORY-SZ`

**特殊值**:
- `NULL` = 通用 BOM,適用於所有工廠

### Batch ID
**批次 ID**

每次資料上傳或計算會產生一個唯一的批次 ID,用於追溯和 Undo。

**用途**:
- 追溯資料來源
- 撤銷 (Undo) 特定批次
- 查看批次歷史

### User ID
**使用者 ID**

識別資料所屬的使用者,確保多租戶資料隔離。

**實作**: Supabase `auth.uid()`

---

## 功能模組

### BOM Explosion
**BOM 展開**

根據 BOM 關係表和 FG 需求,計算出所有 Component 的需求數量。

**輸入**:
- `bom_edges` (BOM 關係)
- `demand_fg` (FG 需求)

**輸出**:
- `component_demand` (Component 需求)
- `component_demand_trace` (需求追溯)

### Data Upload
**資料上傳**

從 Excel/CSV 匯入資料到系統的功能。

**支援類型**:
- Goods Receipt (收貨記錄)
- Price History (價格歷史)
- Supplier Master (供應商主檔)
- BOM Edge (BOM 關係)
- Demand FG (FG 需求)

### Import History
**匯入歷史**

記錄所有資料上傳操作,提供查詢和 Undo 功能。

**關鍵概念**:
- **Batch Record**: 批次記錄
- **Undo**: 撤銷,刪除特定批次的資料
- **Status**: pending (處理中), completed (已完成), undone (已撤銷)

### Cost Analysis
**成本分析**

記錄和分析營運成本,檢測異常,提供 AI 優化建議。

**關鍵指標**:
- Direct Labor Cost (直接人工成本)
- Indirect Labor Cost (間接人工成本)
- Unit Cost (單位成本)
- Cost Anomaly (成本異常)

### Forecasts
**需求預測** / **計畫管理**

執行 BOM Explosion,查看 Component 需求結果,進行需求規劃。

**主要功能**:
- Run BOM Explosion
- View Results (查看需求)
- View Trace (追溯來源)
- Export CSV

---

## 技術縮寫

### RLS (Row Level Security)
**行級安全策略**

Supabase/PostgreSQL 的資料隔離機制,確保使用者只能存取自己的資料。

**實作**:
```sql
CREATE POLICY "Users can manage their own data"
  ON table_name
  FOR ALL
  USING (auth.uid() = user_id);
```

### CRUD
**增刪改查**

- **C**reate: 新增
- **R**ead: 讀取
- **U**pdate: 更新
- **D**elete: 刪除

### UUID
**通用唯一識別碼**

系統中所有主鍵 (Primary Key) 使用的資料型別。

**範例**: `550e8400-e29b-41d4-a716-446655440000`

### UOM (Unit of Measure)
**計量單位**

**常見值**: `pcs` (個), `kg` (公斤), `m` (公尺), `L` (公升)

### KPI (Key Performance Indicator)
**關鍵績效指標**

**供應商 KPI**:
- Receiving Quality Rate (收貨合格率)
- On-Time Delivery Rate (準時交貨率)
- Defect Rate (不良率)
- Price Volatility (價格波動度)

### AI
**人工智慧**

SmartOps 使用 Google Gemini AI 提供:
- 自動欄位映射 (Auto Field Mapping)
- 成本異常分析 (Cost Anomaly Analysis)
- 優化建議 (Optimization Suggestions)

---

## BOM 相關術語

### Qty Per
**單位用量**

製造一個父件需要多少子件。

**範例**: 
- `qty_per = 2.0` → 製造 1 個 FG 需要 2 個 Component

### Scrap Rate
**損耗率**

生產過程中的材料損耗比例。

**範圍**: `0 ≤ scrap_rate < 1`

**範例**:
- `scrap_rate = 0.05` → 5% 損耗
- 計算: `實際用量 = 標準用量 × (1 + scrap_rate)`

### Yield Rate
**良率**

生產過程中的良品比例。

**範圍**: `0 < yield_rate ≤ 1`

**範例**:
- `yield_rate = 0.95` → 95% 良率
- 計算: `實際用量 = 標準用量 / yield_rate`

### Valid From / Valid To
**生效日期** / **失效日期**

BOM 記錄的有效時間範圍。

**用途**: 支援 BOM 版本管理,不同時間使用不同的 BOM 結構。

### Priority
**優先級**

當同一 Parent-Child 組合有多筆 BOM 記錄時,決定使用順序。

**範例** (替代料):
- Priority 1: 主要材料
- Priority 2: 替代材料 (主要材料缺貨時使用)

### ECN (Engineering Change Notice)
**工程變更通知**

記錄 BOM 變更的工程文件編號。

---

## 資料驗證術語

### Valid Rows
**有效資料**

通過所有驗證規則的資料,會被寫入資料庫。

### Error Rows
**錯誤資料**

未通過驗證的資料,不會被寫入,會顯示錯誤訊息。

### Column Mapping
**欄位映射**

將 Excel 欄位對應到系統欄位的過程。

**範例**:
```
Excel 欄位      →    系統欄位
"供應商"        →    supplier_name
"料號"          →    material_code
```

### Upload Schema
**上傳結構定義**

定義每種上傳類型的欄位結構、驗證規則、資料型別。

---

## 資料庫術語

### Supabase
SmartOps 使用的雲端資料庫平台,基於 PostgreSQL。

### PostgreSQL (Postgres)
開源關係型資料庫管理系統,Supabase 的底層引擎。

### JSONB
PostgreSQL 的二進位 JSON 資料型別,用於儲存靈活的結構化資料。

**使用場景**:
- `trace_meta` 欄位 (追溯元數據)
- `metadata` 欄位 (批次元數據)

### Index
**索引**

提高資料庫查詢效能的資料結構。

**範例**:
- `idx_suppliers_user_id`: 對 `user_id` 建立索引
- `idx_component_demand_batch`: 對 `batch_id` 建立索引

---

## 統一用語

為了避免混淆,統一使用以下術語:

| ✅ 推薦使用 | ❌ 避免使用 | 說明 |
|-----------|-----------|------|
| BOM Explosion | BOM Expansion | BOM 展開 |
| Component | Part, Material | 零組件 |
| FG (Finished Good) | Product, Final Product | 成品 |
| Time Bucket | Time Period, Date Range | 時間桶 |
| Plant ID | Factory, Site | 工廠代碼 |
| Batch ID | Import ID, Upload ID | 批次 ID |
| Valid Rows | Success Rows, Good Data | 有效資料 |
| Error Rows | Failed Rows, Bad Data | 錯誤資料 |
| Column Mapping | Field Mapping | 欄位映射 |

---

## 常見縮寫對照表

| 縮寫 | 全名 | 中文 |
|-----|------|------|
| BOM | Bill of Materials | 物料清單 |
| FG | Finished Good | 成品 |
| SA | Sub-Assembly | 子組裝件 |
| PaR | Purchase Request | 採購請求 |
| CTE | Common Table Expression | 公用表表達式 (SQL) |
| RLS | Row Level Security | 行級安全策略 |
| UUID | Universally Unique Identifier | 通用唯一識別碼 |
| UOM | Unit of Measure | 計量單位 |
| KPI | Key Performance Indicator | 關鍵績效指標 |
| ECN | Engineering Change Notice | 工程變更通知 |
| AI | Artificial Intelligence | 人工智慧 |
| CSV | Comma-Separated Values | 逗號分隔值檔案 |
| CRUD | Create, Read, Update, Delete | 增刪改查 |
| UI | User Interface | 使用者介面 |
| API | Application Programming Interface | 應用程式介面 |

---

## 資料型別說明

| 型別 | PostgreSQL 型別 | 說明 | 範例 |
|-----|----------------|------|------|
| 文字 | TEXT | 不限長度文字 | "供應商A" |
| 整數 | INTEGER | 整數 | 100 |
| 小數 | DECIMAL(10,4) | 固定精度小數 | 2.5000 |
| 日期 | DATE | 日期 (無時間) | 2026-01-15 |
| 時間戳 | TIMESTAMPTZ | 日期時間 (含時區) | 2026-01-15 10:30:00+00 |
| 布林 | BOOLEAN | 真/假 | true, false |
| UUID | UUID | 唯一識別碼 | 550e8400-e29b-41d4-a716... |
| JSONB | JSONB | 二進位 JSON | {"key": "value"} |

---

## 狀態值說明

### Import Batch Status

| 狀態 | 英文 | 說明 |
|-----|------|------|
| 處理中 | pending | 正在匯入資料 |
| 已完成 | completed | 匯入成功 |
| 已撤銷 | undone | 批次已撤銷,資料已刪除 |

### Supplier Status

| 狀態 | 英文 | 說明 |
|-----|------|------|
| 啟用 | active | 正常合作中 |
| 停用 | inactive | 暫時停止合作 |
| 暫停 | suspended | 因品質問題暫停 |

---

**維護者**: SmartOps Team  
**最後更新**: 2026-02-04  
**版本**: 1.0
