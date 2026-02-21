import { describe, it, expect } from 'vitest';
import { computeRiskScores } from './riskScoring';
import { buildExceptions } from './exceptionBuilder';

describe('riskScoring', () => {
  it('is deterministic for same inputs', () => {
    const payload = {
      po_open_lines: [
        {
          supplier: 'SUP-A',
          material_code: 'MAT-1',
          plant_id: 'P1',
          promised_date: '2026-02-01',
          open_qty: 120
        },
        {
          supplier: 'SUP-A',
          material_code: 'MAT-2',
          plant_id: 'P1',
          promised_date: '2026-02-04',
          open_qty: 80
        }
      ],
      goods_receipt: [
        {
          supplier: 'SUP-A',
          material_code: 'MAT-1',
          plant_id: 'P1',
          promised_date: '2026-01-20',
          actual_delivery_date: '2026-01-25',
          received_qty: 50
        },
        {
          supplier: 'SUP-A',
          material_code: 'MAT-1',
          plant_id: 'P1',
          promised_date: '2026-01-27',
          actual_delivery_date: '2026-01-30',
          received_qty: 60
        }
      ],
      now_date: '2026-02-10'
    };

    const run1 = computeRiskScores(payload);
    const run2 = computeRiskScores(payload);

    expect(run1).toEqual(run2);
    expect(run1.risk_scores.length).toBeGreaterThan(0);
  });

  it('builds actionable exceptions from risk scores', () => {
    const scoring = computeRiskScores({
      po_open_lines: [
        {
          supplier: 'SUP-Z',
          material_code: 'MAT-Z',
          plant_id: 'P1',
          promised_date: '2026-01-01',
          open_qty: 300
        }
      ],
      goods_receipt: [
        {
          supplier: 'SUP-Z',
          material_code: 'MAT-Z',
          plant_id: 'P1',
          promised_date: '2025-12-20',
          actual_delivery_date: '2026-01-05',
          received_qty: 10
        },
        {
          supplier: 'SUP-Z',
          material_code: 'MAT-Z',
          plant_id: 'P1',
          promised_date: '2025-12-24',
          actual_delivery_date: '2026-01-09',
          received_qty: 12
        }
      ],
      now_date: '2026-02-10'
    });

    const exceptions = buildExceptions({
      risk_scores: scoring.risk_scores
    });

    expect(exceptions.exceptions.length).toBeGreaterThan(0);
    expect(exceptions.aggregates.total).toBe(exceptions.exceptions.length);
    expect(exceptions.exceptions[0].recommended_actions.length).toBeGreaterThan(0);
  });
});
