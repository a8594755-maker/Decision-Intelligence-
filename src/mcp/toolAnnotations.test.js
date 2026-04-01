import { describe, it, expect } from 'vitest';
import { getToolAnnotations } from './toolAnnotations.js';
import { TOOL_CATEGORY } from '../services/ai-infra/builtinToolCatalog.js';

describe('getToolAnnotations', () => {
  it('marks data_access tools as read-only', () => {
    const ann = getToolAnnotations({ category: TOOL_CATEGORY.DATA_ACCESS });
    expect(ann.readOnlyHint).toBe(true);
    expect(ann.destructiveHint).toBe(false);
  });

  it('marks analytics tools as read-only', () => {
    const ann = getToolAnnotations({ category: TOOL_CATEGORY.ANALYTICS });
    expect(ann.readOnlyHint).toBe(true);
  });

  it('marks monitoring tools as read-only', () => {
    const ann = getToolAnnotations({ category: TOOL_CATEGORY.MONITORING });
    expect(ann.readOnlyHint).toBe(true);
  });

  it('marks utility tools as read-only', () => {
    const ann = getToolAnnotations({ category: TOOL_CATEGORY.UTILITY });
    expect(ann.readOnlyHint).toBe(true);
  });

  it('marks core_planning tools as NOT read-only', () => {
    const ann = getToolAnnotations({ category: TOOL_CATEGORY.CORE_PLANNING });
    expect(ann.readOnlyHint).toBe(false);
  });

  it('marks governance tools as destructive', () => {
    const ann = getToolAnnotations({ category: TOOL_CATEGORY.GOVERNANCE });
    expect(ann.destructiveHint).toBe(true);
    expect(ann.idempotentHint).toBe(false);
  });

  it('marks non-governance tools as idempotent', () => {
    const ann = getToolAnnotations({ category: TOOL_CATEGORY.CORE_PLANNING });
    expect(ann.idempotentHint).toBe(true);
  });

  it('marks Python tools as openWorld', () => {
    const ann = getToolAnnotations({ category: TOOL_CATEGORY.CORE_PLANNING, isPython: true });
    expect(ann.openWorldHint).toBe(true);
  });

  it('marks JS tools as NOT openWorld', () => {
    const ann = getToolAnnotations({ category: TOOL_CATEGORY.CORE_PLANNING, isPython: false });
    expect(ann.openWorldHint).toBe(false);
  });

  it('returns all four annotation fields', () => {
    const ann = getToolAnnotations({ category: TOOL_CATEGORY.RISK });
    expect(ann).toHaveProperty('readOnlyHint');
    expect(ann).toHaveProperty('destructiveHint');
    expect(ann).toHaveProperty('idempotentHint');
    expect(ann).toHaveProperty('openWorldHint');
  });
});
