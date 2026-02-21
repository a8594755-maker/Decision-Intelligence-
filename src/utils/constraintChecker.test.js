import { describe, it, expect } from 'vitest';
import { constraintChecker } from './constraintChecker';

describe('constraintChecker', () => {
  it('flags MOQ and pack size violations deterministically', () => {
    const result = constraintChecker({
      plan: [
        { sku: 'SKU-A', order_qty: 7 },
        { sku: 'SKU-B', order_qty: 11 }
      ],
      constraints: {
        moq: [{ sku: 'SKU-A', min_qty: 10 }],
        pack_size: [{ sku: 'SKU-B', pack_qty: 5 }]
      }
    });

    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.rule)).toEqual(['moq', 'pack_size_multiple']);
  });

  it('passes when rows satisfy hard rules', () => {
    const result = constraintChecker({
      plan: [
        { sku: 'SKU-A', order_qty: 10 },
        { sku: 'SKU-B', order_qty: 15 }
      ],
      constraints: {
        moq: [{ sku: 'SKU-A', min_qty: 10 }],
        pack_size: [{ sku: 'SKU-B', pack_qty: 5 }],
        max_order_qty: [{ sku: 'SKU-A', max_qty: 20 }]
      }
    });

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});
