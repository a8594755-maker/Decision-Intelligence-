# BOM Explosion Payload 範例與錯誤處理

## 📋 資料庫 Schema 對照

### component_demand 表格欄位
```sql
- id (UUID, PK)
- user_id (UUID, NOT NULL)
- batch_id (UUID, nullable)
- material_code (TEXT, NOT NULL)
- plant_id (TEXT, NOT NULL)
- time_bucket (TEXT, NOT NULL)
- demand_qty (DECIMAL, NOT NULL)
- uom (TEXT, default 'pcs')
- source_fg_material (TEXT, nullable)
- source_fg_demand_id (UUID, nullable)
- bom_level (INTEGER, nullable)
- notes (TEXT, nullable)
- created_at, updated_at (TIMESTAMPTZ)
```

### component_demand_trace 表格欄位
```sql
- id (UUID, PK)
- user_id (UUID, NOT NULL)
- batch_id (UUID, nullable)
- component_demand_id (UUID, NOT NULL)
- fg_demand_id (UUID, NOT NULL)
- bom_edge_id (UUID, nullable)
- qty_multiplier (DECIMAL, nullable)
- bom_level (INTEGER, nullable)
- trace_meta (JSONB, default '{}') -- 新增欄位
- created_at (TIMESTAMPTZ)
```

---

## ✅ 正確的 Payload 格式

### 1. component_demand Payload

```javascript
// ✅ 正確格式
const componentDemandRows = [
  {
    user_id: 'uuid-xxx',
    batch_id: 'uuid-yyy',
    material_code: 'COMP-001',
    plant_id: 'P001',
    time_bucket: '2026-W01',
    demand_qty: 2210.5263,
    uom: 'pcs',
    // 以下欄位根據需求設為 null
    source_fg_material: null,
    source_fg_demand_id: null,
    bom_level: null,
    notes: null
  }
];

await componentDemandService.upsertComponentDemand(componentDemandRows);
```

### 2. component_demand_trace Payload

```javascript
// ✅ 正確格式 - trace_meta 是 JSON 物件，path 是 array
const traceRows = [
  {
    user_id: 'uuid-xxx',
    batch_id: 'uuid-yyy',
    component_demand_id: 'uuid-comp-demand',
    fg_demand_id: 'uuid-fg-demand',
    bom_edge_id: 'uuid-bom-edge',
    qty_multiplier: 2.1053,
    bom_level: 1,
    // trace_meta: JSONB 欄位，包含額外追溯信息
    trace_meta: {
      path: ["FG-001", "SA-01", "COMP-001"],  // ✅ JSON array
      fg_material_code: "FG-001",
      component_material_code: "COMP-001",
      plant_id: "P001",
      time_bucket: "2026-W01",
      fg_qty: 1000,
      component_qty: 2210.5263,
      source_type: "SO",
      source_id: "SO-12345"
    }
  }
];

await componentDemandTraceService.insertComponentDemandTrace(traceRows);
```

---

## ❌ 錯誤的 Payload 格式

### 錯誤 1: path_json 是字串而非 JSON

```javascript
// ❌ 錯誤 - path_json 不應該是欄位，且不應該是字串
const wrongPayload = {
  user_id: 'uuid-xxx',
  component_demand_id: 'uuid-comp',
  fg_demand_id: 'uuid-fg',
  path_json: '["FG-001", "SA-01", "COMP-001"]',  // ❌ 字串格式
  fg_material_code: 'FG-001',  // ❌ DB schema 沒有這個欄位
  component_material_code: 'COMP-001'  // ❌ DB schema 沒有這個欄位
};

// 錯誤輸出：
// {
//   "type": "DATABASE_ERROR",
//   "message": "Database insert failed: column \"path_json\" does not exist (code: 42703)",
//   "details": {
//     "code": "42703",
//     "hint": "Perhaps you meant to reference column \"trace_meta\"?"
//   }
// }
```

### 錯誤 2: 缺少必要欄位

```javascript
// ❌ 錯誤 - 缺少 fg_demand_id
const wrongPayload = {
  user_id: 'uuid-xxx',
  component_demand_id: 'uuid-comp'
  // fg_demand_id 遺漏了！
};

// 錯誤輸出：
// {
//   "type": "VALIDATION_ERROR",
//   "message": "Row 0: Missing required fields (user_id, component_demand_id, or fg_demand_id)",
//   "rowIndex": 0
// }
```

---

## 🔍 錯誤輸出格式

### 1. 資料庫錯誤

```javascript
// 輸出格式
{
  "type": "DATABASE_ERROR",
  "message": "寫入 component_demand_trace 失敗",
  "error": {
    "message": "Database insert failed: column \"path_json\" does not exist (code: 42703)",
    "code": "42703",
    "details": "...",
    "hint": "Perhaps you meant to reference column \"trace_meta\"?",
    "sample_payload": [
      {
        "user_id": "uuid-xxx",
        "component_demand_id": "uuid-comp",
        // ... 前 2 筆 payload 範例
      }
    ]
  }
}
```

### 2. 映射錯誤

```javascript
// 輸出格式
{
  "type": "MAPPING_ERROR",
  "message": "找不到 5 筆 component_demand_id 映射",
  "details": {
    "count": 5,
    "sample": [
      {
        "component_material_code": "COMP-X",
        "plant_id": "P001",
        "time_bucket": "2026-W01",
        "aggregation_key": "P001|2026-W01|COMP-X"
      },
      // ... 最多顯示 5 筆範例
    ]
  }
}
```

### 3. 驗證錯誤

```javascript
// 輸出格式
{
  "type": "VALIDATION_ERROR",
  "message": "Row 3: Missing required fields (user_id, material_code, plant_id, or time_bucket)",
  "rowIndex": 3
}
```

---

## 🚀 完整執行範例

### 成功案例

```javascript
import { executeBomExplosion } from './services/bomExplosionService';

const userId = 'uuid-user';
const demandFgRows = [/* FG 需求資料 */];
const bomEdgesRows = [/* BOM 關係資料 */];

const result = await executeBomExplosion(
  userId,
  null, // 自動建立 batch
  demandFgRows,
  bomEdgesRows,
  {
    filename: 'BOM Explosion - Test',
    metadata: {
      plant_id: 'P001',
      source: 'manual_ui'
    }
  }
);

// ✅ 成功輸出
console.log(result);
// {
//   success: true,
//   componentDemandCount: 50,
//   traceCount: 200,
//   errors: [],
//   batchId: 'uuid-batch-xxx'
// }
```

### 失敗案例 - 資料庫錯誤

```javascript
// ❌ 如果沒有執行 trace_meta migration
const result = await executeBomExplosion(...);

console.log(result);
// {
//   success: false,
//   componentDemandCount: 50,
//   traceCount: 0,
//   errors: [
//     {
//       type: 'DATABASE_ERROR',
//       message: '寫入 component_demand_trace 失敗',
//       error: {
//         message: 'Database insert failed: column "trace_meta" does not exist (code: 42703)',
//         code: '42703',
//         hint: 'Execute database/add_trace_meta_column.sql first'
//       }
//     }
//   ],
//   batchId: 'uuid-batch-xxx'
// }
```

### 失敗案例 - 循環引用

```javascript
const result = await executeBomExplosion(...);

console.log(result);
// {
//   success: false,
//   componentDemandCount: 0,
//   traceCount: 0,
//   errors: [
//     {
//       type: 'BOM_CYCLE',
//       message: '檢測到 BOM 循環引用',
//       material: 'COMP-LOOP',
//       path: ['FG-001', 'SA-01', 'COMP-LOOP', 'SA-01']
//     }
//   ],
//   batchId: 'uuid-batch-xxx'
// }
```

---

## 📝 Console 輸出範例

### 正常執行

```
Created batch record: uuid-batch-xxx
Fetched 10 FG demand rows
Fetched 50 BOM edge rows
Updated batch status to completed
BOM Explosion completed: {
  success: true,
  componentDemandCount: 25,
  traceCount: 100,
  batchId: "uuid-batch-xxx"
}
```

### 錯誤執行

```
Created batch record: uuid-batch-xxx
Fetched 10 FG demand rows
Fetched 50 BOM edge rows
寫入 component_demand_trace 失敗: {
  message: "Database insert failed: column \"trace_meta\" does not exist (code: 42703)",
  code: "42703",
  details: "...",
  hint: "Execute migration: database/add_trace_meta_column.sql",
  sample_payload: [
    {
      user_id: "uuid-xxx",
      batch_id: "uuid-batch-xxx",
      component_demand_id: "uuid-comp",
      fg_demand_id: "uuid-fg",
      bom_edge_id: "uuid-bom",
      qty_multiplier: 2.1053,
      bom_level: 1,
      trace_meta: { path: ["FG-001", "SA-01", "COMP-001"], ... }
    },
    // ... 第 2 筆範例
  ]
}
```

---

## 🔧 Troubleshooting

### 問題 1: column "trace_meta" does not exist

**原因**: 尚未執行 migration

**解決方式**:
```sql
-- 在 Supabase SQL Editor 執行
-- database/add_trace_meta_column.sql
ALTER TABLE component_demand_trace 
ADD COLUMN IF NOT EXISTS trace_meta JSONB DEFAULT '{}'::jsonb;
```

### 問題 2: path 應該是 array 但卻是 string

**原因**: path_json 被當作字串處理

**解決方式**:
```javascript
// ❌ 錯誤
trace_meta: {
  path: '["FG-001", "SA-01"]'  // 字串
}

// ✅ 正確
trace_meta: {
  path: ["FG-001", "SA-01"]  // JSON array
}
```

### 問題 3: 找不到 component_demand_id 映射

**原因**: upsert 沒有返回 data，且查詢失敗

**解決方式**: 檢查 Console 輸出，查看詳細的映射錯誤訊息
```javascript
console.error output:
找不到 5 筆 component_demand_id 映射 {
  sample: [
    {
      component_material_code: "COMP-X",
      plant_id: "P001",
      time_bucket: "2026-W01",
      aggregation_key: "P001|2026-W01|COMP-X"
    }
  ],
  total: 5
}
```

---

## 📚 相關文件

- [database/add_trace_meta_column.sql](./database/add_trace_meta_column.sql) - Migration SQL
- [database/bom_forecast_schema.sql](./database/bom_forecast_schema.sql) - 完整 Schema
- [BOM_EXPLOSION_UI_IMPLEMENTATION.md](./BOM_EXPLOSION_UI_IMPLEMENTATION.md) - UI 實施指南

---

**最後更新**: 2026-01-26
