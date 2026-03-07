import { describe, it, expect } from 'vitest';
import { createStructuredLogger } from './structuredLogger';

describe('StructuredLogger', () => {
  it('logs entries with correct schema', () => {
    const log = createStructuredLogger({ minLevel: 'debug' });
    log.info('test-source', 'Something happened', { key: 'value' });
    const entries = log.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'info',
      source: 'test-source',
      message: 'Something happened',
      data: { key: 'value' },
    });
    expect(entries[0].ts).toBeTruthy();
    expect(entries[0].id).toBe(1);
  });

  it('respects minLevel filter', () => {
    const log = createStructuredLogger({ minLevel: 'warn' });
    log.debug('src', 'debug msg');
    log.info('src', 'info msg');
    log.warn('src', 'warn msg');
    log.error('src', 'error msg');
    expect(log.getEntries()).toHaveLength(2);
  });

  it('enforces ring buffer size limit', () => {
    const log = createStructuredLogger({ bufferSize: 3, minLevel: 'debug' });
    log.info('a', '1');
    log.info('a', '2');
    log.info('a', '3');
    log.info('a', '4');
    expect(log.getEntries()).toHaveLength(3);
    expect(log.getEntries()[0].message).toBe('2');
  });

  it('filters by source and level', () => {
    const log = createStructuredLogger({ minLevel: 'debug' });
    log.info('import', 'importing');
    log.warn('planning', 'fallback used');
    log.error('import', 'failed');
    expect(log.getEntries({ source: 'import' })).toHaveLength(2);
    expect(log.getEntries({ level: 'warn' })).toHaveLength(1);
  });

  it('getStats returns accurate counts', () => {
    const log = createStructuredLogger({ minLevel: 'debug' });
    log.info('a', 'x');
    log.warn('a', 'y');
    log.error('a', 'z');
    const stats = log.getStats();
    expect(stats.total).toBe(3);
    expect(stats.byLevel).toEqual({ debug: 0, info: 1, warn: 1, error: 1 });
  });

  it('tracks traceId from data._traceId', () => {
    const log = createStructuredLogger({ minLevel: 'debug' });
    log.info('src', 'msg1', { _traceId: 'trace-abc' });
    log.info('src', 'msg2', { _traceId: 'trace-abc' });
    log.info('src', 'msg3', { _traceId: 'trace-xyz' });
    expect(log.getEntries({ traceId: 'trace-abc' })).toHaveLength(2);
  });

  it('clear removes all entries', () => {
    const log = createStructuredLogger({ minLevel: 'debug' });
    log.info('a', 'x');
    log.info('a', 'y');
    log.clear();
    expect(log.getEntries()).toHaveLength(0);
    expect(log.getStats().total).toBe(0);
  });
});
