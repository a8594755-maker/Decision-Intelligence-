/**
 * Inventory Projection Engine 單元測試（WP2）
 * 至少 5 組：正常、無 inbound、提前 inbound、demand 暴增、safety_stock 生效
 */

import {
  projectInventoryByBuckets,
  projectInventorySummaryByBuckets,
  projectInventorySeriesForKey,
  computeSeriesForKey,
  buildDemandByBucket,
  buildStartingInventory
} from './inventoryProjection.js';

const BUCKETS = ['2026-W06', '2026-W07', '2026-W08'];

describe('projectInventoryByBuckets', () => {
  it('正常：有 inv + inbound + demand，不 stockout', () => {
    const start = new Map([['A|P1', { onHand: 100, safetyStock: 10 }]]);
    const demand = new Map([['A|P1', new Map([['2026-W06', 20], ['2026-W07', 30], ['2026-W08', 25]])]]);
    const inbound = new Map([['A|P1', new Map([['2026-W06', 50], ['2026-W07', 0], ['2026-W08', 0]])]]);
    const results = projectInventoryByBuckets({
      timeBuckets: BUCKETS,
      startingInventory: start,
      demandByBucket: demand,
      inboundByBucket: inbound
    });
    const r = results.get('A|P1');
    expect(r).toBeDefined();
    expect(r.stockoutBucket).toBeNull();
    expect(r.shortageQty).toBe(0);
    expect(r.series[0].end).toBe(100 + 50 - 20); // 130
    expect(r.series[1].begin).toBe(130);
    expect(r.series[1].end).toBe(130 - 30); // 100
    expect(r.minAvailable).toBeGreaterThanOrEqual(0);
  });

  it('無 inbound：會 stockout', () => {
    const start = new Map([['B|P1', { onHand: 50, safetyStock: 0 }]]);
    const demand = new Map([['B|P1', new Map([['2026-W06', 30], ['2026-W07', 30]])]]);
    const inbound = new Map([['B|P1', new Map()]]);
    const results = projectInventoryByBuckets({
      timeBuckets: BUCKETS,
      startingInventory: start,
      demandByBucket: demand,
      inboundByBucket: inbound
    });
    const r = results.get('B|P1');
    expect(r).toBeDefined();
    expect(r.series[0].end).toBe(50 - 30); // 20
    expect(r.series[1].end).toBe(20 - 30); // -10
    expect(r.stockoutBucket).toBe('2026-W07');
    expect(r.shortageQty).toBe(10);
    expect(r.minAvailable).toBe(-10);
  });

  it('提前 inbound：不 stockout', () => {
    const start = new Map([['C|P1', { onHand: 10, safetyStock: 5 }]]);
    const demand = new Map([['C|P1', new Map([['2026-W06', 20], ['2026-W07', 10]])]]);
    const inbound = new Map([['C|P1', new Map([['2026-W06', 25]])]]); // 第一週補 25 → end=15，W07 後 5，不缺口
    const results = projectInventoryByBuckets({
      timeBuckets: BUCKETS,
      startingInventory: start,
      demandByBucket: demand,
      inboundByBucket: inbound
    });
    const r = results.get('C|P1');
    expect(r).toBeDefined();
    expect(r.series[0].end).toBe(10 + 25 - 20); // 15
    expect(r.series[1].end).toBe(15 - 10); // 5
    expect(r.stockoutBucket).toBeNull();
    expect(r.shortageQty).toBe(0);
  });

  it('demand 暴增：stockoutBucket 正確', () => {
    const start = new Map([['D|P1', { onHand: 100, safetyStock: 0 }]]);
    const demand = new Map([['D|P1', new Map([['2026-W06', 200]])]]); // 暴增
    const inbound = new Map([['D|P1', new Map([['2026-W07', 50]])]]);
    const results = projectInventoryByBuckets({
      timeBuckets: BUCKETS,
      startingInventory: start,
      demandByBucket: demand,
      inboundByBucket: inbound
    });
    const r = results.get('D|P1');
    expect(r).toBeDefined();
    expect(r.series[0].end).toBe(100 - 200); // -100
    expect(r.stockoutBucket).toBe('2026-W06');
    expect(r.shortageQty).toBe(100);
  });

  it('safety_stock 生效：available 變負', () => {
    const start = new Map([['E|P1', { onHand: 30, safetyStock: 20 }]]);
    const demand = new Map([['E|P1', new Map([['2026-W06', 15]])]]);
    const inbound = new Map();
    const results = projectInventoryByBuckets({
      timeBuckets: BUCKETS,
      startingInventory: start,
      demandByBucket: demand,
      inboundByBucket: inbound
    });
    const r = results.get('E|P1');
    expect(r).toBeDefined();
    expect(r.series[0].end).toBe(30 - 15); // 15
    expect(r.series[0].available).toBe(15 - 20); // -5
    expect(r.series[0].shortageFlag).toBe(true);
    expect(r.stockoutBucket).toBe('2026-W06');
    expect(r.shortageQty).toBe(5);
  });

  it('空 timeBuckets 回傳空 Map', () => {
    const results = projectInventoryByBuckets({
      timeBuckets: [],
      startingInventory: new Map([['X|P1', { onHand: 1, safetyStock: 0 }]]),
      demandByBucket: new Map(),
      inboundByBucket: new Map()
    });
    expect(results.size).toBe(0);
  });
});

describe('buildDemandByBucket / buildInboundByBucket / buildStartingInventory', () => {
  it('buildDemandByBucket 彙總多筆同 key 同 bucket', () => {
    const rows = [
      { material_code: 'M', plant_id: 'P', time_bucket: 'W06', demand_qty: 10 },
      { material_code: 'M', plant_id: 'P', time_bucket: 'W06', demand_qty: 5 }
    ];
    const map = buildDemandByBucket(rows);
    expect(map.get('M|P').get('W06')).toBe(15);
  });

  it('buildStartingInventory 處理 null safety_stock', () => {
    const rows = [{ material_code: 'X', plant_id: 'Y', on_hand_qty: 50 }];
    const map = buildStartingInventory(rows);
    expect(map.get('X|Y')).toEqual({ onHand: 50, safetyStock: 0 });
  });
});

describe('projectInventorySummaryByBuckets (M2.3)', () => {
  it('只產出 summary，數值與 full 推演一致', () => {
    const start = new Map([['A|P1', { onHand: 100, safetyStock: 10 }]]);
    const demand = new Map([['A|P1', new Map([['2026-W06', 20], ['2026-W07', 30]])]]);
    const inbound = new Map([['A|P1', new Map([['2026-W06', 50]])]]);
    const summary = projectInventorySummaryByBuckets({
      timeBuckets: BUCKETS,
      startingInventory: start,
      demandByBucket: demand,
      inboundByBucket: inbound
    });
    const s = summary.get('A|P1');
    expect(s).toBeDefined();
    expect(s.stockoutBucket).toBeNull();
    expect(s.shortageQty).toBe(0);
    expect(s.minAvailable).toBe(100 - 10); // 90 或更高（第一 bucket 後 130-10=120）
    expect(s.startOnHand).toBe(100);
    expect(s.safetyStock).toBe(10);
    expect(s.totals.demand).toBe(20 + 30 + 0);
    expect(s.totals.inbound).toBe(50);
  });

  it('有缺口時 summary 含 stockoutBucket 與 shortageQty', () => {
    const start = new Map([['B|P1', { onHand: 50, safetyStock: 0 }]]);
    const demand = new Map([['B|P1', new Map([['2026-W06', 30], ['2026-W07', 30]])]]);
    const inbound = new Map([['B|P1', new Map()]]);
    const summary = projectInventorySummaryByBuckets({
      timeBuckets: BUCKETS,
      startingInventory: start,
      demandByBucket: demand,
      inboundByBucket: inbound
    });
    const s = summary.get('B|P1');
    expect(s).toBeDefined();
    expect(s.stockoutBucket).toBe('2026-W07');
    expect(s.shortageQty).toBe(10);
    expect(s.minAvailable).toBe(-10);
  });

  it('空 timeBuckets 回傳空 Map', () => {
    const summary = projectInventorySummaryByBuckets({
      timeBuckets: [],
      startingInventory: new Map([['X|P1', { onHand: 1, safetyStock: 0 }]]),
      demandByBucket: new Map(),
      inboundByBucket: new Map()
    });
    expect(summary.size).toBe(0);
  });
});

describe('projectInventorySeriesForKey / computeSeriesForKey (M2.3)', () => {
  it('單 key series 推演公式 end = begin + inbound - demand', () => {
    const start = new Map([['K|P', { onHand: 40, safetyStock: 5 }]]);
    const demand = new Map([['K|P', new Map([['2026-W06', 10], ['2026-W07', 15]])]]);
    const inbound = new Map([['K|P', new Map([['2026-W06', 20]])]]);
    const series = projectInventorySeriesForKey({
      timeBuckets: BUCKETS,
      startingInventory: start,
      demandByBucket: demand,
      inboundByBucket: inbound,
      key: 'K|P'
    });
    expect(series.length).toBe(3);
    expect(series[0].bucket).toBe('2026-W06');
    expect(series[0].begin).toBe(40);
    expect(series[0].inbound).toBe(20);
    expect(series[0].demand).toBe(10);
    expect(series[0].end).toBe(40 + 20 - 10); // 50
    expect(series[0].available).toBe(50 - 5); // 45
    expect(series[0].shortageFlag).toBe(false);
    expect(series[1].begin).toBe(50);
    expect(series[1].end).toBe(50 - 15); // 35
  });

  it('computeSeriesForKey(cache, key) 與 projectInventorySeriesForKey 一致', () => {
    const cache = {
      timeBuckets: BUCKETS,
      startingInventory: new Map([['Q|R', { onHand: 10, safetyStock: 0 }]]),
      demandByBucket: new Map([['Q|R', new Map([['2026-W06', 3]])]]),
      inboundByBucket: new Map([['Q|R', new Map([['2026-W06', 5]])]])
    };
    const fromHelper = computeSeriesForKey(cache, 'Q|R');
    const fromDirect = projectInventorySeriesForKey({ ...cache, key: 'Q|R' });
    expect(fromHelper).toEqual(fromDirect);
    expect(fromHelper[0].end).toBe(10 + 5 - 3); // 12
  });
});
