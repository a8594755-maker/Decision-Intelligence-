import { describe, it, expect } from 'vitest';
import { createSpan } from './pipelineSpan';

describe('PipelineSpan', () => {
  it('tracks timing correctly', () => {
    const span = createSpan('import', 'validate');
    span.addMetric('rows', 100);
    span.end();
    const json = span.toJSON();
    expect(json.pipeline).toBe('import');
    expect(json.stage).toBe('validate');
    expect(json.durationMs).toBeGreaterThanOrEqual(0);
    expect(json.metrics.rows).toBe(100);
    expect(json.endedAt).toBeTruthy();
  });

  it('increments metrics correctly', () => {
    const span = createSpan('import', 'ingest');
    span.incrementMetric('chunks_done');
    span.incrementMetric('chunks_done');
    span.incrementMetric('chunks_done');
    expect(span.toJSON().metrics.chunks_done).toBe(3);
  });

  it('generates consistent traceId', () => {
    const span = createSpan('import', 'classify');
    expect(span.traceId).toMatch(/^import-/);
  });

  it('uses parent traceId when provided', () => {
    const span = createSpan('planning', 'optimize', 'parent-123');
    expect(span.traceId).toBe('parent-123');
  });

  it('durationMs updates before end()', () => {
    const span = createSpan('test', 'stage');
    const d1 = span.durationMs;
    expect(d1).toBeGreaterThanOrEqual(0);
    span.end();
    expect(span.durationMs).toBeGreaterThanOrEqual(d1);
  });
});
