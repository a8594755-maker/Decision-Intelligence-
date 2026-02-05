# BOM Explosion Payload 修正摘要

## 🎯 修正目標

1. ✅ 確保 payload 只包含 DB schema 中存在的欄位
2. ✅ `trace_meta.path` 必須是 JSON array（不是字串）
3. ✅ 額外欄位存入 `trace_meta` JSONB 欄位
4. ✅ 提供清楚的錯誤訊息（不只是 console.log Object）

---

## 📂 修改的檔案

### 1. **database/add_trace_meta_column.sql**（新增）

**目的**: 為 `component_demand_trace` 表格添加 `trace_meta` JSONB 欄位

**內容**:
```sql
ALTER TABLE component_demand_trace 
ADD COLUMN IF NOT EXISTS trace_meta JSONB DEFAULT '{}'::jsonb;

CREATE INDEX idx_component_demand_trace_meta 
ON component_demand_trace USING GIN (trace_meta);
```

**執行方式**:
```sql
-- 在 Supabase SQL Editor 中執行
\i database/add_trace_meta_column.sql
```

---

### 2. **src/services/bomExplosionService.js**

#### 修改內容

**Before**:
```javascript
tracePayload.push({
  user_id: userId,
  batch_id: actualBatchId,
  component_demand_id: componentDemandId,
  fg_demand_id: trace.fg_demand_id || null,
  bom_edge_id: trace.bom_edge_id || null,
  qty_multiplier: trace.qty_multiplier,
  bom_level: trace.bom_level
});
```

**After**:
```javascript
// 解析 path_json 為 JSON array
let pathArray = [];
try {
  pathArray = typeof trace.path_json === 'string' 
    ? JSON.parse(trace.path_json) 
    : trace.path_json || [];
} catch (parseError) {
  console.error(`Failed to parse path_json`, {
    component_material_code: trace.component_material_code,
    path_json: trace.path_json,
    error: parseError.message
  });
  pathArray = [];
}

tracePayload.push({
  user_id: userId,
  batch_id: actualBatchId,
  component_demand_id: componentDemandId,
  fg_demand_id: trace.fg_demand_id || null,
  bom_edge_id: trace.bom_edge_id || null,
  qty_multiplier: trace.qty_multiplier,
  bom_level: trace.bom_level,
  // 額外追溯信息存入 trace_meta (JSONB)
  trace_meta: {
    path: pathArray, // ✅ JSON array
    fg_material_code: trace.fg_material_code || null,
    component_material_code: trace.component_material_code || null,
    plant_id: trace.plant_id || null,
    time_bucket: trace.time_bucket || null,
    fg_qty: trace.fg_qty || null,
    component_qty: trace.component_qty || null,
    source_type: trace.source_type || null,
    source_id: trace.source_id || null
  }
});
```

#### 新增錯誤處理

**映射錯誤**:
```javascript
if (missingMappings.length > 0) {
  const errorMsg = `找不到 ${missingMappings.length} 筆 component_demand_id 映射`;
  console.error(errorMsg, {
    sample: missingMappings.slice(0, 5),
    total: missingMappings.length
  });
  result.errors.push({
    type: 'MAPPING_ERROR',
    message: errorMsg,
    details: {
      count: missingMappings.length,
      sample: missingMappings.slice(0, 5)
    }
  });
}
```

**資料庫錯誤**:
```javascript
catch (error) {
  const errorDetails = {
    message: error.message,
    stack: error.stack,
    name: error.name
  };
  console.error('寫入 component_demand_trace 失敗：', errorDetails);
  result.errors.push({
    type: 'DATABASE_ERROR',
    message: '寫入 component_demand_trace 失敗',
    error: errorDetails
  });
}
```

---

### 3. **src/services/supabaseClient.js**

#### 修改 `insertComponentDemandTrace`

**新增驗證**:
```javascript
const payload = rows.map((row, index) => {
  // 驗證必要欄位
  if (!row.user_id || !row.component_demand_id || !row.fg_demand_id) {
    throw new Error(
      `Row ${index}: Missing required fields (user_id, component_demand_id, or fg_demand_id)`
    );
  }

  return {
    user_id: row.user_id,
    batch_id: row.batch_id || null,
    component_demand_id: row.component_demand_id,
    fg_demand_id: row.fg_demand_id,
    bom_edge_id: row.bom_edge_id || null,
    qty_multiplier: row.qty_multiplier || null,
    bom_level: row.bom_level || null,
    trace_meta: row.trace_meta || {}  // ✅ JSONB 欄位
  };
});
```

**改善錯誤訊息**:
```javascript
if (error) {
  const errorDetails = {
    message: error.message,
    code: error.code,
    details: error.details,
    hint: error.hint,
    sample_payload: payload.slice(0, 2) // 顯示前 2 筆
  };
  console.error('insertComponentDemandTrace failed:', errorDetails);
  throw new Error(
    `Database insert failed: ${error.message} (code: ${error.code})`
  );
}
```

#### 修改 `upsertComponentDemand`

**新增驗證**:
```javascript
const payload = rows.map((row, index) => {
  // 驗證必要欄位
  if (!row.user_id || !row.material_code || !row.plant_id || !row.time_bucket) {
    throw new Error(
      `Row ${index}: Missing required fields (user_id, material_code, plant_id, or time_bucket)`
    );
  }
  if (row.demand_qty === undefined || row.demand_qty === null) {
    throw new Error(`Row ${index}: Missing demand_qty`);
  }

  return {
    // ... 只包含 DB schema 中的欄位
  };
});
```

**改善錯誤訊息**:
```javascript
// Upsert 失敗時的 fallback 處理
if (error) {
  console.warn('Upsert failed, attempting fallback strategy:', {
    error: error.message,
    code: error.code,
    hint: error.hint
  });
  
  // ... fallback logic
}

// 各種錯誤情況的詳細輸出
if (queryError) {
  const errorDetails = {
    message: queryError.message,
    code: queryError.code,
    details: queryError.details
  };
  console.error('Query existing records failed:', errorDetails);
  throw new Error(`Query failed: ${queryError.message}`);
}
```

---

## 🔄 Migration 步驟

### Step 1: 執行 SQL Migration
```sql
-- 在 Supabase SQL Editor 中執行
ALTER TABLE component_demand_trace 
ADD COLUMN IF NOT EXISTS trace_meta JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_component_demand_trace_meta 
ON component_demand_trace USING GIN (trace_meta);
```

### Step 2: 確認前端代碼已更新
- ✅ `src/services/bomExplosionService.js`
- ✅ `src/services/supabaseClient.js`

### Step 3: 測試
```javascript
// 1. 執行 BOM Explosion
const result = await executeBomExplosion(...);

// 2. 檢查結果
console.log(result);
// {
//   success: true,
//   componentDemandCount: 50,
//   traceCount: 200,
//   errors: [],
//   batchId: 'uuid-xxx'
// }

// 3. 查詢 trace_meta
const traces = await supabase
  .from('component_demand_trace')
  .select('*')
  .eq('batch_id', result.batchId)
  .limit(1);

console.log(traces.data[0].trace_meta);
// {
//   path: ["FG-001", "SA-01", "COMP-001"],
//   fg_material_code: "FG-001",
//   component_material_code: "COMP-001",
//   ...
// }
```

---

## 📊 錯誤輸出對照表

| 錯誤類型 | Console 輸出 | errors Array |
|---------|-------------|--------------|
| **Missing Field** | `Row 3: Missing required fields (user_id, ...)` | `{ type: 'VALIDATION_ERROR', message: '...', rowIndex: 3 }` |
| **DB Column Error** | `Database insert failed: column "path_json" does not exist (code: 42703)` + sample_payload | `{ type: 'DATABASE_ERROR', message: '寫入失敗', error: { code, hint, sample } }` |
| **Mapping Error** | `找不到 5 筆 component_demand_id 映射` + sample mappings | `{ type: 'MAPPING_ERROR', message: '...', details: { count, sample } }` |
| **Parse Error** | `Failed to parse path_json: ...` + trace details | (不中斷，使用空 array) |

---

## ✅ 驗證清單

### 資料庫層面
- [ ] 執行 `add_trace_meta_column.sql` migration
- [ ] 確認 `trace_meta` 欄位存在：
  ```sql
  SELECT column_name, data_type 
  FROM information_schema.columns 
  WHERE table_name = 'component_demand_trace' 
  AND column_name = 'trace_meta';
  ```
- [ ] 確認 GIN 索引存在：
  ```sql
  SELECT indexname 
  FROM pg_indexes 
  WHERE tablename = 'component_demand_trace' 
  AND indexname = 'idx_component_demand_trace_meta';
  ```

### 代碼層面
- [ ] `bomExplosionService.js` 使用 `trace_meta` 欄位
- [ ] `path` 是 JSON array，不是字串
- [ ] `supabaseClient.js` 驗證必要欄位
- [ ] 錯誤訊息包含詳細資訊（code, hint, sample）

### 執行測試
- [ ] 執行 BOM Explosion 成功
- [ ] 查詢 `trace_meta` 欄位，確認 `path` 是 array
- [ ] 觸發錯誤（缺少欄位），確認錯誤訊息清楚
- [ ] 在 Import History 查看批次記錄

---

## 📚 相關文件

1. [database/add_trace_meta_column.sql](./database/add_trace_meta_column.sql) - Migration SQL
2. [BOM_EXPLOSION_PAYLOAD_EXAMPLES.md](./BOM_EXPLOSION_PAYLOAD_EXAMPLES.md) - Payload 範例
3. [database/bom_forecast_schema.sql](./database/bom_forecast_schema.sql) - 完整 Schema
4. [BOM_EXPLOSION_UI_IMPLEMENTATION.md](./BOM_EXPLOSION_UI_IMPLEMENTATION.md) - UI 實施指南

---

**修正完成時間**: 2026-01-26

**重要提醒**: 必須先執行 `add_trace_meta_column.sql` migration，否則會出現 `column "trace_meta" does not exist` 錯誤。
