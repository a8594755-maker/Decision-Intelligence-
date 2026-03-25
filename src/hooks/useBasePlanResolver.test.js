// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../services/planning/basePlanResolverService', () => ({
  resolveBasePlan: vi.fn(),
  validateBasePlan: vi.fn(() => ({ valid: true, reason: null })),
  persistBasePlan: vi.fn(),
  fetchRecentPlans: vi.fn().mockResolvedValue([]),
  runAutoBaseline: vi.fn(),
}));

import { useBasePlanResolver } from './useBasePlanResolver.js';
import { resolveBasePlan } from '../services/planning/basePlanResolverService';

describe('useBasePlanResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-resolves when dataset profile inputs change', async () => {
    resolveBasePlan
      .mockResolvedValueOnce({ mode: 'plan', basePlan: { id: 101 } })
      .mockResolvedValueOnce({ mode: 'plan', basePlan: { id: 202 } });

    const { result, rerender } = renderHook((props) => useBasePlanResolver(props), {
      initialProps: {
        userId: 'user-1',
        datasetProfileId: 1,
        routeRunId: null,
        latestDataTs: null,
        latestContractTs: null,
      },
    });

    await waitFor(() => {
      expect(resolveBasePlan).toHaveBeenCalledTimes(1);
      expect(result.current.resolvedRunId).toBe(101);
    });

    rerender({
      userId: 'user-1',
      datasetProfileId: 2,
      routeRunId: null,
      latestDataTs: null,
      latestContractTs: null,
    });

    await waitFor(() => {
      expect(resolveBasePlan).toHaveBeenCalledTimes(2);
      expect(result.current.resolvedRunId).toBe(202);
    });
  });
});
