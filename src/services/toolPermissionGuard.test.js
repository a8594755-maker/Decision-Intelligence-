// @product: ai-employee
import { describe, it, expect } from 'vitest';
import {
  PERMISSION_REGISTRY,
  PermissionDeniedError,
  checkPermission,
  canExecute,
} from './toolPermissionGuard';

const AIDEN_FULL = {
  name: 'Aiden',
  permissions: { can_run_forecast: true, can_run_plan: true, can_run_risk: true },
};

const AIDEN_LIMITED = {
  name: 'Aiden',
  permissions: { can_run_forecast: true, can_run_plan: false, can_run_risk: false },
};

const AIDEN_EMPTY = {
  name: 'Aiden',
  permissions: {},
};

describe('PERMISSION_REGISTRY', () => {
  it('maps forecast, plan, risk to required permissions', () => {
    expect(PERMISSION_REGISTRY.forecast).toEqual(['can_run_forecast']);
    expect(PERMISSION_REGISTRY.plan).toEqual(['can_run_plan']);
    expect(PERMISSION_REGISTRY.risk).toEqual(['can_run_risk']);
  });

  it('synthesize requires no permissions', () => {
    expect(PERMISSION_REGISTRY.synthesize).toEqual([]);
  });
});

describe('checkPermission', () => {
  it('allows when employee has all required permissions', () => {
    expect(checkPermission(AIDEN_FULL, 'forecast')).toBe(true);
    expect(checkPermission(AIDEN_FULL, 'plan')).toBe(true);
    expect(checkPermission(AIDEN_FULL, 'risk')).toBe(true);
  });

  it('allows synthesize with no permissions', () => {
    expect(checkPermission(AIDEN_EMPTY, 'synthesize')).toBe(true);
  });

  it('allows unknown workflow types (fail at executor dispatch instead)', () => {
    expect(checkPermission(AIDEN_EMPTY, 'unknown_type')).toBe(true);
  });

  it('throws PermissionDeniedError when permission is missing', () => {
    expect(() => checkPermission(AIDEN_LIMITED, 'plan')).toThrow(PermissionDeniedError);
    expect(() => checkPermission(AIDEN_LIMITED, 'risk')).toThrow(PermissionDeniedError);
  });

  it('throws PermissionDeniedError when permission is false', () => {
    const emp = { name: 'Bot', permissions: { can_run_forecast: false } };
    expect(() => checkPermission(emp, 'forecast')).toThrow(PermissionDeniedError);
  });

  it('throws with correct metadata', () => {
    try {
      checkPermission(AIDEN_LIMITED, 'plan');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PermissionDeniedError);
      expect(err.employeeName).toBe('Aiden');
      expect(err.workflowType).toBe('plan');
      expect(err.missingPermissions).toEqual(['can_run_plan']);
    }
  });

  it('handles null employee gracefully', () => {
    expect(() => checkPermission(null, 'forecast')).toThrow(PermissionDeniedError);
  });

  it('handles employee with no permissions field', () => {
    expect(() => checkPermission({ name: 'Bot' }, 'forecast')).toThrow(PermissionDeniedError);
  });
});

describe('canExecute', () => {
  it('returns allowed=true when permissions are present', () => {
    const result = canExecute(AIDEN_FULL, 'forecast');
    expect(result.allowed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('returns allowed=false with missing permissions listed', () => {
    const result = canExecute(AIDEN_LIMITED, 'risk');
    expect(result.allowed).toBe(false);
    expect(result.missing).toEqual(['can_run_risk']);
  });

  it('returns allowed=true for synthesize regardless of permissions', () => {
    const result = canExecute(AIDEN_EMPTY, 'synthesize');
    expect(result.allowed).toBe(true);
  });

  it('returns allowed=true for unknown workflow types', () => {
    const result = canExecute(AIDEN_EMPTY, 'future_workflow');
    expect(result.allowed).toBe(true);
  });
});
