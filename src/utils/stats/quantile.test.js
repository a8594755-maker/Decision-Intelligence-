import { describe, expect, it } from 'vitest';
import { quantile } from './quantile';

describe('quantile', () => {
  it('returns median for odd-length arrays', () => {
    expect(quantile([1, 5, 3], 0.5)).toBe(3);
  });

  it('returns interpolated median for even-length arrays', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });

  it('returns expected value for q=0.9', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.9)).toBeCloseTo(4.6, 6);
  });

  it('throws for empty arrays', () => {
    expect(() => quantile([], 0.9)).toThrow(/at least one finite number/i);
  });
});
