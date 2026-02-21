import { describe, it, expect } from 'vitest';
import { replaySimulator } from './replaySimulator';

describe('replaySimulator', () => {
  it('is deterministic and computes service-level proxy', () => {
    const basePayload = {
      forecast_series: [
        { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-01', p50: 6 },
        { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-02', p50: 6 }
      ],
      inventory: [
        { sku: 'SKU-A', plant_id: 'P1', as_of_date: '2025-12-31', on_hand: 5, safety_stock: 0 }
      ],
      open_pos: [],
      plan: [
        { sku: 'SKU-A', plant_id: 'P1', arrival_date: '2026-01-01', order_qty: 10 }
      ]
    };

    const run1 = replaySimulator(basePayload);
    const run2 = replaySimulator(basePayload);

    expect(run1).toEqual(run2);
    expect(run1.metrics.total_demand_units).toBe(12);
    expect(run1.metrics.service_level_proxy).toBeGreaterThan(0.9);
  });

  it('shows lower fill rate without replenishment', () => {
    const withPlan = replaySimulator({
      forecast_series: [
        { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-01', p50: 6 },
        { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-02', p50: 6 }
      ],
      inventory: [
        { sku: 'SKU-A', plant_id: 'P1', as_of_date: '2025-12-31', on_hand: 5, safety_stock: 0 }
      ],
      plan: [
        { sku: 'SKU-A', plant_id: 'P1', arrival_date: '2026-01-01', order_qty: 10 }
      ]
    });

    const withoutPlan = replaySimulator({
      forecast_series: [
        { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-01', p50: 6 },
        { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-02', p50: 6 }
      ],
      inventory: [
        { sku: 'SKU-A', plant_id: 'P1', as_of_date: '2025-12-31', on_hand: 5, safety_stock: 0 }
      ],
      plan: []
    });

    expect(withPlan.metrics.fill_rate).toBeGreaterThan(withoutPlan.metrics.fill_rate);
  });
});
