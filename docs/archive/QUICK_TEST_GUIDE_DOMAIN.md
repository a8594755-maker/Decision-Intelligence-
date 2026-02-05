# Domain 層快速測試指南

## 快速開始

### 1. 運行所有測試

```bash
npm run test:run
```

**預期結果**：
```
✓ src/domains/forecast/bomCalculator.test.js (30 tests) 9ms

Test Files  1 passed (1)
     Tests  30 passed (30)
```

### 2. 互動式測試（監聽模式）

```bash
npm test
```

這會啟動 Vitest 的監聽模式，當你修改代碼時會自動重新運行測試。

### 3. 測試 UI 介面

```bash
npm run test:ui
```

在瀏覽器中打開測試 UI，可視化測試結果。

### 4. 生成覆蓋率報告

```bash
npm run test:coverage
```

會在 `coverage/` 目錄下生成 HTML 格式的覆蓋率報告。

## 測試內容概覽

### 工具函數測試 (6 個)

| 測試項目 | 函數 | 描述 |
|---------|------|------|
| ✅ | `roundTo()` | 四捨五入功能 |
| ✅ | `getAggregationKey()` | 聚合 key 生成 |
| ✅ | `parseAggregationKey()` | 聚合 key 解析 |
| ✅ | `timeBucketToDate()` | YYYY-MM-DD 格式 |
| ✅ | `timeBucketToDate()` | YYYY-W## 格式 |
| ✅ | `timeBucketToDate()` | 錯誤格式處理 |

### 核心計算函數測試 (24 個)

| 測試項目 | 函數 | 描述 |
|---------|------|------|
| ✅ | `calculateComponentRequirement()` | 基本計算 |
| ✅ | `calculateComponentRequirement()` | 報廢率計算 |
| ✅ | `calculateComponentRequirement()` | 良率計算 |
| ✅ | `calculateComponentRequirement()` | 報廢率 + 良率 |
| ✅ | `calculateComponentRequirement()` | 參數驗證 (3 個測試) |
| ✅ | `aggregateByComponent()` | 彙總功能 (3 個測試) |
| ✅ | `buildBomIndex()` | 索引建立 (5 個測試) |
| ✅ | `explodeBOM()` | BOM 展開 (9 個測試) |

## 手動測試範例

### 測試 1：基本 BOM 展開

在 Node.js REPL 中測試：

```bash
node
```

```javascript
// 載入模組
const { explodeBOM } = await import('./src/domains/forecast/bomCalculator.js');

// 準備測試資料
const fgDemands = [
  {
    material_code: 'FG-001',
    plant_id: 'P001',
    time_bucket: '2026-W01',
    demand_qty: 100
  }
];

const bomEdges = [
  { parent_material: 'FG-001', child_material: 'COMP-A', qty_per: 2 },
  { parent_material: 'FG-001', child_material: 'COMP-B', qty_per: 1 }
];

// 執行計算
const result = explodeBOM(fgDemands, bomEdges);

// 檢查結果
console.log('Component Demands:', result.componentDemandRows);
console.log('Trace Records:', result.traceRows.length);
console.log('Errors:', result.errors.length);

// 預期輸出：
// Component Demands: [
//   { material_code: 'COMP-A', demand_qty: 200, ... },
//   { material_code: 'COMP-B', demand_qty: 100, ... }
// ]
// Trace Records: 2
// Errors: 0
```

### 測試 2：報廢率和良率

```javascript
const { calculateComponentRequirement } = await import('./src/domains/forecast/bomCalculator.js');

// 測試：100 個父件，每個需要 2 個子件，5% 報廢，95% 良率
const qty = calculateComponentRequirement(100, 2, 0.05, 0.95);
console.log(qty); // 應該是 221.0526
```

### 測試 3：多層 BOM

```javascript
const { explodeBOM } = await import('./src/domains/forecast/bomCalculator.js');

const fgDemands = [
  {
    material_code: 'FG-001',
    plant_id: 'P001',
    time_bucket: '2026-W01',
    demand_qty: 100
  }
];

const bomEdges = [
  // Level 1
  { parent_material: 'FG-001', child_material: 'SA-01', qty_per: 1 },
  // Level 2
  { parent_material: 'SA-01', child_material: 'COMP-A', qty_per: 2 },
  { parent_material: 'SA-01', child_material: 'COMP-B', qty_per: 3 }
];

const result = explodeBOM(fgDemands, bomEdges);

console.log('Components:', result.componentDemandRows.map(c => ({
  material: c.material_code,
  qty: c.demand_qty
})));

// 預期輸出：
// [
//   { material: 'SA-01', qty: 100 },
//   { material: 'COMP-A', qty: 200 },
//   { material: 'COMP-B', qty: 300 }
// ]
```

## 整合測試（與 UI 互動）

### 1. 啟動開發伺服器

```bash
npm run dev
```

### 2. 測試流程

1. 開啟瀏覽器訪問應用
2. 前往 **Forecasts** 頁面
3. 確認已上傳以下資料：
   - `demand_fg` (成品需求)
   - `bom_edge` (BOM 關係)
4. 點擊 **Run BOM Explosion**
5. 檢查結果：
   - ✅ Component Demand 數量正確
   - ✅ Trace Records 數量正確
   - ✅ 無錯誤或警告

### 3. 驗證計算正確性

在 **Forecast Results** 標籤中：
- 檢查 `demand_qty` 是否符合預期
- 驗證報廢率和良率的計算
- 確認多層 BOM 的彙總正確

在 **Trace** 標籤中：
- 檢查 `bom_level` 是否正確
- 驗證 `path` 追溯路徑
- 確認 `qty_multiplier` 數值

## 效能測試

### 基準測試

```javascript
const { explodeBOM } = await import('./src/domains/forecast/bomCalculator.js');

// 建立大量測試資料
const fgDemands = Array.from({ length: 1000 }, (_, i) => ({
  material_code: `FG-${String(i).padStart(3, '0')}`,
  plant_id: 'P001',
  time_bucket: '2026-W01',
  demand_qty: 100
}));

const bomEdges = [];
for (let i = 0; i < 1000; i++) {
  bomEdges.push({
    parent_material: `FG-${String(i).padStart(3, '0')}`,
    child_material: `COMP-A-${String(i).padStart(3, '0')}`,
    qty_per: 2
  });
  bomEdges.push({
    parent_material: `FG-${String(i).padStart(3, '0')}`,
    child_material: `COMP-B-${String(i).padStart(3, '0')}`,
    qty_per: 1
  });
}

// 效能測試
console.time('BOM Explosion');
const result = explodeBOM(fgDemands, bomEdges);
console.timeEnd('BOM Explosion');

console.log('Component Demands:', result.componentDemandRows.length);
console.log('Trace Records:', result.traceRows.length);

// 預期：
// BOM Explosion: < 100ms
// Component Demands: 2000
// Trace Records: 2000
```

## 常見問題

### Q: 測試失敗怎麼辦？

**A**: 檢查以下項目：
1. Node.js 版本（建議 v18+）
2. 依賴套件是否正確安裝（`npm install`）
3. 查看錯誤訊息和堆疊追蹤
4. 確認測試資料格式正確

### Q: 如何只運行特定測試？

**A**: 使用 Vitest 的過濾功能：

```bash
# 只運行包含 "explodeBOM" 的測試
npm test -- explodeBOM

# 只運行特定檔案
npm test -- bomCalculator.test.js
```

### Q: 如何調試測試？

**A**: 在測試中加入 `console.log` 或使用 Vitest UI：

```javascript
test('我的測試', () => {
  const result = explodeBOM(...);
  console.log('Result:', JSON.stringify(result, null, 2));
  expect(result.errors.length).toBe(0);
});
```

或使用：
```bash
npm run test:ui
```

### Q: 測試覆蓋率不完整？

**A**: 檢查 `coverage/` 目錄下的 HTML 報告：

```bash
npm run test:coverage
# 然後開啟 coverage/index.html
```

## 下一步

1. ✅ 確認所有測試通過
2. ✅ 檢查 linter 無錯誤
3. ⏳ 閱讀 `DOMAIN_LAYER_REFACTORING.md` 了解完整架構
4. ⏳ 閱讀 `src/domains/forecast/README.md` 學習 API 使用
5. ⏳ 嘗試整合測試（UI + Domain）

## 參考資源

- [Vitest 官方文檔](https://vitest.dev/)
- [完整重構總結](./DOMAIN_LAYER_REFACTORING.md)
- [Domain 層 README](./src/domains/forecast/README.md)

---

**測試狀態**: ✅ 30/30 通過  
**最後更新**: 2026-02-04
