# Forecast Domain Layer

## 概述

此目錄包含預測需求（Forecast）相關的 Domain 層實現，提供乾淨、可測試的 Pure Functions。

## 架構設計

```
src/domains/forecast/
├── types.js              # 型別定義（JSDoc）
├── bomCalculator.js      # BOM 計算器（純函數）
├── bomCalculator.test.js # 單元測試
└── README.md            # 本文件
```

### 設計原則

1. **Pure Functions**: 所有函數都是純函數，無副作用
2. **可測試性**: 不依賴外部狀態，易於單元測試
3. **分層架構**: Domain 層只負責業務邏輯，不處理 I/O
4. **型別安全**: 使用 JSDoc 提供完整的型別註解

## 主要功能

### 1. 型別定義 (`types.js`)

定義了以下核心型別：

- `FGDemand` - 成品需求
- `BOMEdge` - BOM 關係（父件-子件）
- `ComponentDemand` - 零件需求（展開結果）
- `ComponentDemandTrace` - 追溯記錄
- `ExplosionOptions` - 展開選項
- `ExplosionError` - 錯誤/警告
- `ExplosionResult` - 展開結果

### 2. BOM 計算器 (`bomCalculator.js`)

#### 核心函數

##### `explodeBOM(fgDemands, bomEdges, options)`

主要的 BOM 展開函數，將成品需求展開為零件需求。

**輸入**：
- `fgDemands`: FG 需求陣列
- `bomEdges`: BOM 關係陣列
- `options`: 展開選項
  - `maxDepth`: 最大展開層級（預設 50）
  - `ignoreScrap`: 是否忽略報廢率（預設 false）
  - `userId`: 使用者 ID（用於輸出）
  - `batchId`: 批次 ID（用於輸出）

**輸出**：
```javascript
{
  componentDemandRows: ComponentDemand[],  // 零件需求（已彙總）
  traceRows: ComponentDemandTrace[],       // 追溯記錄
  errors: ExplosionError[]                 // 錯誤/警告
}
```

**範例**：
```javascript
import { explodeBOM } from './domains/forecast/bomCalculator.js';

const fgDemands = [
  { 
    material_code: 'FG-001', 
    plant_id: 'P001', 
    time_bucket: '2026-W01', 
    demand_qty: 100 
  }
];

const bomEdges = [
  { parent_material: 'FG-001', child_material: 'COMP-A', qty_per: 2, scrap_rate: 0.05 },
  { parent_material: 'FG-001', child_material: 'COMP-B', qty_per: 1 }
];

const result = explodeBOM(fgDemands, bomEdges);
// result.componentDemandRows: [
//   { material_code: 'COMP-A', demand_qty: 210 },  // 100 * 2 * 1.05
//   { material_code: 'COMP-B', demand_qty: 100 }   // 100 * 1
// ]
```

##### `calculateComponentRequirement(parentQty, qtyPer, scrapRate, yieldRate)`

計算零件需求量（考慮報廢率和良率）。

**公式**：
```
component_qty = parent_qty × qty_per × (1 + scrap_rate) / yield_rate
```

**範例**：
```javascript
import { calculateComponentRequirement } from './domains/forecast/bomCalculator.js';

// 100 個父件，每個需要 2 個子件，5% 報廢，95% 良率
const qty = calculateComponentRequirement(100, 2, 0.05, 0.95);
// = 100 × 2 × 1.05 / 0.95 = 221.0526
```

##### `aggregateByComponent(componentList)`

彙總零件需求（按 material_code + plant_id + time_bucket）。

**範例**：
```javascript
import { aggregateByComponent } from './domains/forecast/bomCalculator.js';

const components = [
  { material_code: 'COMP-A', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 100 },
  { material_code: 'COMP-A', plant_id: 'P001', time_bucket: '2026-W01', demand_qty: 50 }
];

const aggregated = aggregateByComponent(components);
// Map { 'P001|2026-W01|COMP-A' => 150 }
```

##### `buildBomIndex(bomEdges, plantId, bucketDate, errors)`

建立 BOM 索引（按 parent_material 分組），並進行過濾：
1. 工廠匹配（plant_id 或通用 BOM）
2. 時效性過濾（valid_from/valid_to）
3. 重疊處理（priority 或 created_at）

#### 工具函數

- `roundTo(value, decimals)` - 四捨五入
- `getAggregationKey(plantId, timeBucket, materialCode)` - 生成聚合 key
- `parseAggregationKey(key)` - 解析聚合 key
- `timeBucketToDate(timeBucket)` - 時間桶轉日期

## 單元測試

### 執行測試

```bash
# 運行所有測試
npm test

# 運行測試並生成覆蓋率報告
npm run test:coverage

# 使用 UI 介面運行測試
npm run test:ui
```

### 測試覆蓋範圍

測試檔案 `bomCalculator.test.js` 包含 30 個測試案例，涵蓋：

1. **工具函數測試** (6 個測試)
   - 四捨五入
   - 聚合 key 生成/解析
   - 時間桶轉換

2. **核心計算函數測試** (24 個測試)
   - 基本需求計算
   - 報廢率/良率計算
   - 彙總功能
   - BOM 索引建立
   - 單層/多層 BOM 展開
   - 循環引用檢測
   - 最大深度檢測
   - 錯誤處理

## 與現有代碼的整合

### Service 層整合

`bomExplosionService.js` 已更新為使用 Domain 層函數：

```javascript
import { explodeBOM } from '../domains/forecast/bomCalculator.js';

export function calculateBomExplosion(demandFgRows, bomEdgesRows, options) {
  return explodeBOM(demandFgRows, bomEdgesRows, options);
}
```

### View 層使用

`ForecastsView.jsx` 通過 `bomExplosionService.js` 間接使用 Domain 層：

```javascript
import { executeBomExplosion } from '../services/bomExplosionService';

// Service 層會調用 Domain 層的 explodeBOM
const result = await executeBomExplosion(userId, batchId, fgDemands, bomEdges);
```

## 重構前後對比

### 重構前（Service 層包含業務邏輯）

```javascript
// bomExplosionService.js
function explodeBOM(...) {
  // 500+ 行業務邏輯
  // 混合了計算邏輯和資料庫操作
  // 難以測試
}
```

### 重構後（清晰的分層）

```
Domain Layer (bomCalculator.js)
  ↓ Pure Functions（純計算邏輯）
Service Layer (bomExplosionService.js)
  ↓ 資料庫操作 + 批次管理
View Layer (ForecastsView.jsx)
  ↓ UI 互動
```

## 優點

1. **可測試性**: Domain 層完全獨立，易於編寫單元測試
2. **可維護性**: 業務邏輯集中在 Domain 層，職責清晰
3. **可重用性**: Pure Functions 可在不同場景重用
4. **型別安全**: JSDoc 提供完整的型別註解
5. **效能**: 減少副作用，更容易優化
6. **可讀性**: 代碼結構清晰，易於理解

## 未來擴展

1. 加入 TypeScript 支援（目前使用 JSDoc）
2. 實現更複雜的 BOM 場景（如替代料、多來源）
3. 加入效能優化（如平行計算）
4. 擴展追溯功能（如成本追溯、鉛時間追溯）

## 參考資源

- [Clean Architecture](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)
- [Domain-Driven Design](https://martinfowler.com/bliki/DomainDrivenDesign.html)
- [Pure Functions](https://en.wikipedia.org/wiki/Pure_function)
- [JSDoc TypeScript](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html)
