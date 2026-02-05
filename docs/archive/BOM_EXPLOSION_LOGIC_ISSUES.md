# BOM Explosion 邏輯問題診斷報告

## 🔴 發現的問題

測試執行後發現兩個邏輯問題導致測試失敗：

---

## 問題 1: 只記錄葉節點需求 ❌

### 當前邏輯（錯誤）

```javascript
// 在 explodeBOM() 函數中
if (children.length === 0) {
  // 只有葉節點才記錄需求
  componentDemandMap.set(key, currentQty + parentDemand.demand_qty);
  return;
}

// 有子件的料號不會被記錄
```

### 問題說明

在測試案例 1 中：
```
FG-001 (1000)
  ├─ COMP-001 (2210.53) ← 有子件，不被記錄 ❌
  │   └─ COMP-010 (1127.37) ← 葉節點，被記錄 ✅
  └─ COMP-002 (1500.0) ← 葉節點，被記錄 ✅
```

**結果**：只產生 4 筆記錄（COMP-002 x2 + COMP-010 x2），缺少 COMP-001 x2

### 正確邏輯

**所有非 FG 的料號（包括中間組裝件）都應該被記錄**：

```javascript
// 修正：在遞迴展開之前或之後都要記錄需求
function explodeBOM(...) {
  // ... 循環檢測 ...
  
  // 查找子件
  const children = bomIndex.get(parentDemand.material_code) || [];
  
  // ✅ 不管有沒有子件，都記錄需求（除非是 FG 本身）
  if (path.length > 0) { // path.length > 0 表示不是 FG
    const key = getAggregationKey(...);
    const currentQty = componentDemandMap.get(key) || 0;
    componentDemandMap.set(key, currentQty + parentDemand.demand_qty);
    
    // 記錄 trace
    traceRows.push({ ... });
  }
  
  // 如果有子件，繼續遞迴展開
  if (children.length > 0) {
    for (const childEdge of children) {
      // ... 遞迴邏輯 ...
    }
  }
}
```

---

## 問題 2: 強制單一工廠限制 ❌

### 當前邏輯（錯誤）

```javascript
// 在 calculateBomExplosion() 函數中
const firstFgDemand = demandFgRows[0];
const plantId = firstFgDemand.plant_id;

// 對每個 FG 需求進行展開
for (const fgDemand of demandFgRows) {
  // 檢查 plant_id 是否一致
  if (fgDemand.plant_id !== plantId) {
    errors.push({
      type: 'PLANT_MISMATCH',
      message: `FG 需求的 plant_id 不一致：期望 ${plantId}，實際 ${fgDemand.plant_id}`,
      fgDemand
    });
    continue; // ❌ 跳過此需求
  }
  // ...
}
```

### 問題說明

在測試案例 2 中：
- DF-101, DF-102, DF-103: PLANT-01 ✅
- DF-104: PLANT-02 ← 被跳過 ❌

**結果**：PLANT-02 的需求被完全忽略

### 正確邏輯

**應該支援多工廠場景，每個 FG 需求獨立處理**：

```javascript
// 修正：移除 plant 一致性檢查
// 對每個 FG 需求進行展開（不檢查 plant_id 是否一致）
for (const fgDemand of demandFgRows) {
  // 驗證必要欄位（但不檢查 plant_id 一致性）
  if (!fgDemand.material_code || !fgDemand.plant_id || ...) {
    errors.push({ ... });
    continue;
  }
  
  // 每個 FG 需求使用自己的 plant_id
  const bucketDate = timeBucketToDate(fgDemand.time_bucket);
  const bomIndex = buildBomIndex(bomEdgesRows, fgDemand.plant_id, bucketDate, errors);
  
  // 展開
  explodeBOM(...);
}
```

---

## 🔧 修正方案

### 修正 1: explodeBOM 函數

```javascript
function explodeBOM(
  parentDemand,
  bomLevel,
  multiplier,
  path,
  bomIndex,
  componentDemandMap,
  traceRows,
  errors,
  maxDepth = 50,
  fgMaterialCode,
  fgDemandId,
  fgQty,
  sourceType = null,
  sourceId = null,
  bomEdgeId = null
) {
  // 檢查最大深度
  if (bomLevel > maxDepth) {
    errors.push({ ... });
    return;
  }
  
  // 檢查循環引用
  if (path.includes(parentDemand.material_code)) {
    errors.push({ ... });
    return;
  }
  
  // ✅ 修正：不管有沒有子件，只要不是 FG（path.length > 0），就記錄需求
  if (path.length > 0) {
    const key = getAggregationKey(
      parentDemand.plant_id,
      parentDemand.time_bucket,
      parentDemand.material_code
    );
    
    // 累加需求數量
    const currentQty = componentDemandMap.get(key) || 0;
    componentDemandMap.set(key, currentQty + parentDemand.demand_qty);
    
    // 記錄追溯資訊
    const fullPath = [...path, parentDemand.material_code];
    const componentBomLevel = path.length;
    
    traceRows.push({
      fg_material_code: fgMaterialCode,
      component_material_code: parentDemand.material_code,
      plant_id: parentDemand.plant_id,
      time_bucket: parentDemand.time_bucket,
      fg_qty: fgQty,
      component_qty: parentDemand.demand_qty,
      source_type: sourceType,
      source_id: sourceId,
      path_json: JSON.stringify(fullPath),
      fg_demand_id: fgDemandId,
      bom_edge_id: bomEdgeId,
      bom_level: componentBomLevel,
      qty_multiplier: multiplier
    });
  }
  
  // 查找子件
  const children = bomIndex.get(parentDemand.material_code) || [];
  
  // ✅ 如果有子件，繼續遞迴展開
  if (children.length > 0) {
    for (const childEdge of children) {
      // 計算子件數量
      const scrapRate = childEdge.scrap_rate ?? 0;
      const yieldRate = childEdge.yield_rate ?? 1;
      const childQty = roundTo(
        parentDemand.demand_qty * childEdge.qty_per * (1 + scrapRate) / yieldRate,
        4
      );
      const newMultiplier = roundTo(
        multiplier * childEdge.qty_per * (1 + scrapRate) / yieldRate,
        4
      );
      
      // 建立子件需求物件
      const childDemand = {
        material_code: childEdge.child_material,
        plant_id: parentDemand.plant_id,
        time_bucket: parentDemand.time_bucket,
        demand_qty: childQty,
        id: null
      };
      
      // 遞迴展開子件
      explodeBOM(
        childDemand,
        bomLevel + 1,
        newMultiplier,
        [...path, parentDemand.material_code],
        bomIndex,
        componentDemandMap,
        traceRows,
        errors,
        maxDepth,
        fgMaterialCode,
        fgDemandId,
        fgQty,
        sourceType,
        sourceId,
        childEdge.id
      );
    }
  }
}
```

### 修正 2: calculateBomExplosion 函數

```javascript
export function calculateBomExplosion(demandFgRows, bomEdgesRows, options = {}) {
  // ...
  
  // ❌ 移除：不應該假設所有 FG 需求都是同一個 plant
  // const firstFgDemand = demandFgRows[0];
  // const plantId = firstFgDemand.plant_id;
  
  // ✅ 對每個 FG 需求獨立處理（支援多工廠）
  for (const fgDemand of demandFgRows) {
    // 驗證必要欄位
    if (!fgDemand.material_code || !fgDemand.plant_id || ...) {
      errors.push({ ... });
      continue;
    }
    
    // ❌ 移除：不檢查 plant_id 一致性
    // if (fgDemand.plant_id !== plantId) {
    //   errors.push({ type: 'PLANT_MISMATCH', ... });
    //   continue;
    // }
    
    // 每個 FG 使用自己的 plant_id 建立 BOM 索引
    const bucketDate = timeBucketToDate(fgDemand.time_bucket);
    const bomIndex = buildBomIndex(bomEdgesRows, fgDemand.plant_id, bucketDate, errors);
    
    // 展開
    explodeBOM(...);
  }
  
  // ...
}
```

---

## 📊 修正前後對比

### 測試案例 1

| 項目 | 修正前 | 修正後 |
|------|--------|--------|
| Component 記錄數 | 4 | 6 |
| COMP-001 記錄 | ❌ 0 筆 | ✅ 2 筆 |
| COMP-002 記錄 | ✅ 2 筆 | ✅ 2 筆 |
| COMP-010 記錄 | ✅ 2 筆 | ✅ 2 筆 |

### 測試案例 2

| 項目 | 修正前 | 修正後 |
|------|--------|--------|
| Component 記錄數 | 2 | 4 |
| PLANT-01 記錄 | ✅ 2 筆 | ✅ 2 筆 |
| PLANT-02 記錄 | ❌ 0 筆 | ✅ 2 筆 |
| PLANT_MISMATCH 錯誤 | ❌ 1 個 | ✅ 0 個 |

---

## 🚀 修正步驟

### Step 1: 備份當前代碼
```bash
cp src/services/bomExplosionService.js src/services/bomExplosionService.js.backup
```

### Step 2: 應用修正
修改 `src/services/bomExplosionService.js`：
1. 修正 `explodeBOM` 函數：在遞迴前記錄所有 Component 需求
2. 修正 `calculateBomExplosion` 函數：移除 plant_id 一致性檢查

### Step 3: 重新執行測試
```bash
npm run test:bom
```

### Step 4: 驗證結果
- ✅ 測試案例 1：應產生 6 筆記錄
- ✅ 測試案例 2：應產生 4 筆記錄（包含 PLANT-02）
- ✅ 無 PLANT_MISMATCH 錯誤

---

## 📝 設計決策

### Q: 為什麼中間組裝件也要記錄？

**A**: 在實際生產場景中，中間組裝件（如 Sub-Assembly）也是需要採購或生產的物料。例如：
```
FG-001 (成品)
  └─ SA-01 (子組裝) ← 需要記錄！可能需要外購或內部生產
      └─ COMP-10 (零件) ← 也需要記錄
```

兩者都需要被計劃和採購。

### Q: 為什麼要支援多工廠？

**A**: 實際應用中，不同工廠可能有不同的 FG 需求：
```
PLANT-01: FG-001 需求 1000
PLANT-02: FG-002 需求 500
PLANT-03: FG-001 需求 800
```

應該能同時計算所有工廠的 Component 需求。

---

## 🎯 預期行為（修正後）

### 測試案例 1

**輸入**:
- FG-001, 2026-W02: 1000
- FG-001, 2026-W03: 1500

**輸出（6 筆）**:
1. COMP-001, PLANT-01, 2026-W02: 2210.53
2. COMP-001, PLANT-01, 2026-W03: 3315.79
3. COMP-002, PLANT-01, 2026-W02: 1500.00
4. COMP-002, PLANT-01, 2026-W03: 2250.00
5. COMP-010, PLANT-01, 2026-W02: 1127.37
6. COMP-010, PLANT-01, 2026-W03: 1691.05

### 測試案例 2

**輸入**:
- FG-001, PLANT-01, 2026-W10: 1000
- FG-001, PLANT-01, 2026-W30: 800
- FG-002, PLANT-01, 2026-W10: 500
- FG-002, PLANT-02, 2026-W10: 600

**輸出（4 筆）**:
1. COMP-001, PLANT-01, 2026-W10: 3825.00 (聚合)
2. COMP-001, PLANT-01, 2026-W30: 2400.00
3. COMP-001, PLANT-02, 2026-W10: 990.00
4. COMP-002, PLANT-01, 2026-W10: 1250.00

---

## 📚 參考文件

- [BOM_EXPLOSION_SPEC.md](./BOM_EXPLOSION_SPEC.md) - 規格定義
- [test-bom-explosion.js](./test-bom-explosion.js) - 測試腳本
- [src/services/bomExplosionService.js](./src/services/bomExplosionService.js) - 實作代碼

---

**診斷日期**: 2026-01-26  
**修正日期**: 2026-01-26  
**狀態**: ✅ 已修正並驗證通過
