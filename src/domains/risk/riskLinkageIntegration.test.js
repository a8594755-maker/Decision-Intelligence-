/**
 * Risk–Forecast Linkage 整合測試（B3）
 * 驗證：有 component_demand 時 Risk row 產出 daysToStockout、P(stockout)、leadTimeDaysUsed；
 * 無 demand 時不產出 daysToStockout（或為 Infinity）。
 * 不依賴 Supabase，純 in-memory mock。
 */

import { calculateSupplyCoverageRiskBatch } from './coverageCalculator.js';
import { calculateInventoryRisk } from '../inventory/calculator.js';
import { calculateProfitAtRiskBatch } from './profitAtRiskCalculator.js';
import { aggregateComponentDemandToDaily, normalizeKey } from '../../utils/componentDemandAggregator.js';
import { mapSupplyCoverageToUI } from '../../components/risk/mapDomainToUI.js';

const HORIZON_BUCKETS = 3;
const DEFAULT_LEAD_TIME_DAYS = 7;

function applyInventoryRiskToDomainResults(domainResults, componentDemandAggregated, keyToLeadTime) {
  domainResults.forEach(row => {
    const key = normalizeKey(row.item, row.factory);
    const demandInfo = componentDemandAggregated[key];
    const dailyDemand = demandInfo?.dailyDemand;
    const onHand = row.onHand != null ? row.onHand : 0;
    const safetyStock = row.safetyStock != null ? row.safetyStock : 0;
    const ltInfo = keyToLeadTime[key] || { leadTimeDays: DEFAULT_LEAD_TIME_DAYS, source: 'fallback' };
    row.leadTimeDaysUsed = ltInfo.leadTimeDays;
    row.leadTimeDaysSource = ltInfo.source;

    if (typeof dailyDemand === 'number' && dailyDemand > 0) {
      try {
        const invRisk = calculateInventoryRisk({
          currentStock: onHand,
          safetyStock,
          dailyDemand,
          leadTimeDays: ltInfo.leadTimeDays,
          demandVolatility: 0.1
        });
        row.daysToStockout = invRisk.daysToStockout;
        row.stockoutProbability = invRisk.probability;
      } catch (_) {}
    }
  });
}

describe('Risk linkage integration', () => {
  const mockOpenPOs = [
    { item: 'PART-A', factory: 'P1', timeBucket: '2026-W10', timeBucketSortKey: '2026-W10', qty: 100, poNumber: 'PO-1', poLine: '001', supplierId: '' }
  ];
  const mockInventory = [
    { material_code: 'PART-A', plant_id: 'P1', on_hand_qty: 50, safety_stock: 10 }
  ];

  it('有 demand 時產出 daysToStockout、P(stockout)、leadTimeDaysUsed', () => {
    const domainResults = calculateSupplyCoverageRiskBatch({
      openPOs: mockOpenPOs,
      inventorySnapshots: mockInventory,
      horizonBuckets: HORIZON_BUCKETS
    });
    expect(domainResults.length).toBeGreaterThan(0);

    const demandRows = [
      { material_code: 'PART-A', plant_id: 'P1', time_bucket: '2026-W08', demand_qty: 70 },
      { material_code: 'PART-A', plant_id: 'P1', time_bucket: '2026-W09', demand_qty: 70 }
    ];
    const componentDemandAggregated = aggregateComponentDemandToDaily(demandRows, HORIZON_BUCKETS);
    const keyToLeadTime = { [normalizeKey('PART-A', 'P1')]: { leadTimeDays: 7, source: 'fallback' } };

    applyInventoryRiskToDomainResults(domainResults, componentDemandAggregated, keyToLeadTime);

    const rowA = domainResults.find(r => normalizeKey(r.item, r.factory) === 'PART-A|P1');
    expect(rowA).toBeDefined();
    expect(typeof rowA.daysToStockout).toBe('number');
    expect(rowA.daysToStockout).not.toBe(Infinity);
    expect(typeof rowA.stockoutProbability).toBe('number');
    expect(rowA.leadTimeDaysUsed).toBe(7);
    expect(rowA.leadTimeDaysSource).toBe('fallback');

    const warnings = [];
    const uiRow = mapSupplyCoverageToUI(rowA, warnings);
    expect(uiRow.daysToStockout).toBe(rowA.daysToStockout);
    expect(uiRow.probability).toBe(rowA.stockoutProbability);
    expect(uiRow.leadTimeDaysUsed).toBe(7);
  });

  it('無 demand 時不產出 daysToStockout（mapper 為 Infinity）', () => {
    const domainResults = calculateSupplyCoverageRiskBatch({
      openPOs: mockOpenPOs,
      inventorySnapshots: mockInventory,
      horizonBuckets: HORIZON_BUCKETS
    });
    const componentDemandAggregated = {};
    const keyToLeadTime = { [normalizeKey('PART-A', 'P1')]: { leadTimeDays: 7, source: 'fallback' } };

    applyInventoryRiskToDomainResults(domainResults, componentDemandAggregated, keyToLeadTime);

    const rowA = domainResults.find(r => normalizeKey(r.item, r.factory) === 'PART-A|P1');
    expect(rowA).toBeDefined();
    expect(rowA.daysToStockout).toBeUndefined();
    expect(rowA.leadTimeDaysUsed).toBe(7);

    const warnings = [];
    const uiRow = mapSupplyCoverageToUI(rowA, warnings);
    expect(uiRow.daysToStockout).toBe(Infinity);
  });

  it('有 financials 時產出 profitAtRisk', () => {
    const domainResults = calculateSupplyCoverageRiskBatch({
      openPOs: mockOpenPOs,
      inventorySnapshots: mockInventory,
      horizonBuckets: HORIZON_BUCKETS
    });
    const financials = [{ material_code: 'PART-A', profit_per_unit: 10, unit_margin: 5 }];
    const { rows } = calculateProfitAtRiskBatch({
      riskRows: domainResults,
      financials,
      useFallback: false
    });
    const rowA = rows.find(r => (r.item || '').toUpperCase() === 'PART-A' && (r.factory || '').toUpperCase() === 'P1');
    expect(rowA).toBeDefined();
    expect(typeof rowA.profitAtRisk).toBe('number');
  });
});
