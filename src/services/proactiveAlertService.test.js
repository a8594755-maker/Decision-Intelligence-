/**
 * Unit tests for proactiveAlertService — pure function tests, no external deps.
 */

import { describe, it, expect } from 'vitest';
import { generateAlerts, ALERT_CONFIG } from './proactiveAlertService.js';

const RISK_SCORES_WITH_STOCKOUT = [
  {
    entity_type: 'supplier_material',
    material_code: 'SKU-A',
    plant_id: 'P1',
    supplier: 'SUP-1',
    risk_score: 75,
    metrics: { on_time_rate: 0.62, p90_delay_days: 8.5, avg_delay_days: 4.2 },
  },
  {
    entity_type: 'supplier_material',
    material_code: 'SKU-B',
    plant_id: 'P2',
    supplier: 'SUP-2',
    risk_score: 130,
    metrics: { on_time_rate: 0.45, p90_delay_days: 14.0, avg_delay_days: 7.1 },
  },
  {
    entity_type: 'supplier',
    material_code: '',
    plant_id: '',
    supplier: 'SUP-3',
    risk_score: 50,
    metrics: { on_time_rate: 0.80 },
  },
];

const STOCKOUT_DATA = [
  { material_code: 'SKU-A', plant_id: 'P1', p_stockout: 0.75, impact_usd: 42000, days_to_stockout: 5 },
  { material_code: 'SKU-B', plant_id: 'P2', p_stockout: 0.30, impact_usd: 8000, days_to_stockout: 20 },
];

describe('generateAlerts', () => {
  it('should generate expedite alert for high P(stockout)', () => {
    const result = generateAlerts({ riskScores: RISK_SCORES_WITH_STOCKOUT, stockoutData: STOCKOUT_DATA });
    const expediteAlerts = result.alerts.filter((a) => a.alert_type === 'expedite_rec');
    expect(expediteAlerts.length).toBeGreaterThanOrEqual(1);
    expect(expediteAlerts[0].material_code).toBe('SKU-A');
    expect(expediteAlerts[0].severity).toBe('critical');
  });

  it('should generate dual_source_rec for critical risk scores', () => {
    const result = generateAlerts({ riskScores: RISK_SCORES_WITH_STOCKOUT, stockoutData: STOCKOUT_DATA });
    const dualSource = result.alerts.filter((a) => a.alert_type === 'dual_source_rec');
    expect(dualSource.length).toBeGreaterThanOrEqual(1);
    expect(dualSource[0].material_code).toBe('SKU-B');
  });

  it('should generate supplier_delay for high risk scores below critical', () => {
    const result = generateAlerts({ riskScores: RISK_SCORES_WITH_STOCKOUT, stockoutData: STOCKOUT_DATA });
    const supplierDelay = result.alerts.filter((a) => a.alert_type === 'supplier_delay');
    expect(supplierDelay.length).toBeGreaterThanOrEqual(1);
    expect(supplierDelay[0].material_code).toBe('SKU-A');
  });

  it('should NOT include non-supplier_material entity types', () => {
    const result = generateAlerts({ riskScores: RISK_SCORES_WITH_STOCKOUT, stockoutData: STOCKOUT_DATA });
    const sup3Alerts = result.alerts.filter((a) => a.supplier === 'SUP-3');
    expect(sup3Alerts).toHaveLength(0);
  });

  it('should sort by impact_score descending', () => {
    const result = generateAlerts({ riskScores: RISK_SCORES_WITH_STOCKOUT, stockoutData: STOCKOUT_DATA });
    for (let i = 1; i < result.alerts.length; i++) {
      expect(result.alerts[i - 1].impact_score).toBeGreaterThanOrEqual(result.alerts[i].impact_score);
    }
  });

  it('should respect max_alerts_per_run', () => {
    const result = generateAlerts({
      riskScores: RISK_SCORES_WITH_STOCKOUT,
      stockoutData: STOCKOUT_DATA,
      configOverrides: { max_alerts_per_run: 2 },
    });
    expect(result.alerts.length).toBeLessThanOrEqual(2);
  });

  it('should return summary with counts', () => {
    const result = generateAlerts({ riskScores: RISK_SCORES_WITH_STOCKOUT, stockoutData: STOCKOUT_DATA });
    expect(result.summary.total_alerts).toBeGreaterThan(0);
    expect(typeof result.summary.critical_count).toBe('number');
    expect(typeof result.summary.high_count).toBe('number');
  });

  it('should return empty alerts for empty input', () => {
    const result = generateAlerts({ riskScores: [], stockoutData: [] });
    expect(result.alerts).toHaveLength(0);
    expect(result.summary.total_alerts).toBe(0);
  });

  it('should return empty alerts for undefined input', () => {
    const result = generateAlerts();
    expect(result.alerts).toHaveLength(0);
  });

  it('should include evidence_refs on each alert', () => {
    const result = generateAlerts({ riskScores: RISK_SCORES_WITH_STOCKOUT, stockoutData: STOCKOUT_DATA });
    result.alerts.forEach((alert) => {
      expect(Array.isArray(alert.evidence_refs)).toBe(true);
      expect(alert.evidence_refs.length).toBeGreaterThan(0);
    });
  });

  it('should include recommended_actions on each alert', () => {
    const result = generateAlerts({ riskScores: RISK_SCORES_WITH_STOCKOUT, stockoutData: STOCKOUT_DATA });
    result.alerts.forEach((alert) => {
      expect(Array.isArray(alert.recommended_actions)).toBe(true);
      expect(alert.recommended_actions.length).toBeGreaterThan(0);
    });
  });

  it('should skip stockout alerts below min_impact_usd', () => {
    const lowImpactStockout = [
      { material_code: 'SKU-A', plant_id: 'P1', p_stockout: 0.80, impact_usd: 500, days_to_stockout: 3 },
    ];
    const result = generateAlerts({ riskScores: RISK_SCORES_WITH_STOCKOUT, stockoutData: lowImpactStockout });
    const stockoutAlerts = result.alerts.filter((a) => a.alert_type === 'stockout_risk' || a.alert_type === 'expedite_rec');
    expect(stockoutAlerts).toHaveLength(0);
  });
});
