import { describe, it, expect } from 'vitest';
import { buildZodSchema } from './zodSchemaBuilder.js';
import { BUILTIN_TOOLS } from '../services/ai-infra/builtinToolCatalog.js';

describe('buildZodSchema', () => {
  it('returns a Zod object for null/empty input', () => {
    const schema = buildZodSchema(null);
    expect(schema).toBeDefined();
    expect(schema.parse({})).toEqual({});
  });

  it('handles string type', () => {
    const schema = buildZodSchema({ name: 'string' });
    const result = schema.parse({ name: 'test' });
    expect(result.name).toBe('test');
  });

  it('handles number|null type', () => {
    const schema = buildZodSchema({ count: 'number|null (optional)' });
    expect(schema.parse({ count: 42 }).count).toBe(42);
    expect(schema.parse({ count: null }).count).toBeNull();
    expect(schema.parse({}).count).toBeUndefined();
  });

  it('handles object type', () => {
    const schema = buildZodSchema({ settings: 'object (optional overrides)' });
    expect(schema.parse({ settings: { a: 1 } }).settings).toEqual({ a: 1 });
  });

  it('handles boolean type', () => {
    const schema = buildZodSchema({ flag: 'boolean' });
    expect(schema.parse({ flag: true }).flag).toBe(true);
  });

  it('handles enum-like type strings', () => {
    const schema = buildZodSchema({ mode: "'on'|'off' (default 'off')" });
    expect(schema.parse({ mode: 'on' }).mode).toBe('on');
  });

  it('skips function type parameters', () => {
    const schema = buildZodSchema({
      userId: 'string',
      onProgress: 'function (optional callback)',
    });
    const keys = Object.keys(schema.shape);
    expect(keys).toContain('userId');
    expect(keys).not.toContain('onProgress');
  });

  it('builds valid schemas for all catalog tools', () => {
    for (const tool of BUILTIN_TOOLS) {
      const schema = buildZodSchema(tool.input_schema);
      expect(schema).toBeDefined();
      // Should not throw on empty object (all fields optional or with defaults)
      expect(() => schema.parse({})).not.toThrow();
    }
  });
});
