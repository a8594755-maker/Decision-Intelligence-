import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearBomExplosionCache,
  explodeBomForRun,
  resolveMultiEchelonConfig,
  MULTI_ECHELON_MODES
} from './multiEchelonBomService';

describe('multiEchelonBomService', () => {
  beforeEach(() => {
    clearBomExplosionCache();
  });

  it('resolves BOM mode from explicit config', () => {
    const config = resolveMultiEchelonConfig({
      planSettings: {
        multi_echelon_mode: 'bom_v0',
        max_bom_depth: 7,
        fg_to_components_scope: {
          sku_allowlist: ['fg-1']
        }
      },
      env: {}
    });

    expect(config.mode).toBe(MULTI_ECHELON_MODES.BOM_V0);
    expect(config.max_bom_depth).toBe(7);
    expect(config.fg_to_components_scope.sku_allowlist).toEqual(['FG-1']);
  });

  it('explodes BOM deterministically and reuses cache', () => {
    const demandSeries = [
      { sku: 'FG-1', plant_id: 'P1', date: '2026-01-01', p50: 10 }
    ];

    const bomEdges = [
      { parent_material: 'FG-1', child_material: 'C1', qty_per: 2, plant_id: 'P1' },
      { parent_material: 'FG-1', child_material: 'C2', qty_per: 1, plant_id: 'P1' }
    ];

    const config = {
      mode: 'bom_v0',
      max_bom_depth: 10,
      fg_to_components_scope: { sku_allowlist: [], plant_allowlist: [] },
      lot_sizing_mode: 'moq_pack',
      mapping_rules: { trim: true, case: 'upper' }
    };

    const first = explodeBomForRun({
      datasetFingerprint: 'dsfp_x',
      demandSeries,
      bomEdges,
      config
    });

    const second = explodeBomForRun({
      datasetFingerprint: 'dsfp_x',
      demandSeries,
      bomEdges,
      config
    });

    expect(first.used).toBe(true);
    expect(first.reused).toBe(false);
    expect(second.used).toBe(true);
    expect(second.reused).toBe(true);
    expect(first.requirements).toEqual(second.requirements);
    expect(first.usage_rows.length).toBe(2);
    expect(first.artifact?.totals?.num_rows).toBe(2);
  });
});
