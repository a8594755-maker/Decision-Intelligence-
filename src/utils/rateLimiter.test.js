import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RateLimitError,
  SlidingWindowLimiter,
  getRateLimiter,
  acquireOrThrow,
  resetAllLimiters,
} from './rateLimiter';

describe('SlidingWindowLimiter', () => {
  let limiter;

  beforeEach(() => {
    limiter = new SlidingWindowLimiter({
      bucket: 'test',
      windows: [
        { label: 'per_minute', maxRequests: 3, windowMs: 60_000 },
        { label: 'per_day', maxRequests: 5, windowMs: 86_400_000 },
      ],
    });
  });

  it('allows requests under the limit', () => {
    expect(limiter.tryAcquire().allowed).toBe(true);
    expect(limiter.tryAcquire().allowed).toBe(true);
    expect(limiter.tryAcquire().allowed).toBe(true);
  });

  it('denies requests at the per-minute limit', () => {
    limiter.tryAcquire();
    limiter.tryAcquire();
    limiter.tryAcquire();
    const result = limiter.tryAcquire();
    expect(result.allowed).toBe(false);
    expect(result.windowLabel).toBe('per_minute');
    expect(result.limit).toBe(3);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('denies requests at the per-day limit', () => {
    vi.useFakeTimers();
    // Make 5 requests across different minutes to avoid per_minute limit
    limiter.tryAcquire();
    limiter.tryAcquire();
    limiter.tryAcquire();
    vi.advanceTimersByTime(61_000); // advance past the minute window
    limiter.tryAcquire();
    limiter.tryAcquire();
    // Now at 5 total (day limit)
    const result = limiter.tryAcquire();
    expect(result.allowed).toBe(false);
    expect(result.windowLabel).toBe('per_day');
    expect(result.limit).toBe(5);
    vi.useRealTimers();
  });

  it('allows requests after the minute window slides', () => {
    vi.useFakeTimers();
    limiter.tryAcquire();
    limiter.tryAcquire();
    limiter.tryAcquire();
    expect(limiter.tryAcquire().allowed).toBe(false);

    vi.advanceTimersByTime(61_000); // slide past the minute window
    expect(limiter.tryAcquire().allowed).toBe(true);
    vi.useRealTimers();
  });

  it('getStatus returns correct remaining counts', () => {
    limiter.tryAcquire();
    limiter.tryAcquire();
    const status = limiter.getStatus();
    expect(status).toHaveLength(2);
    expect(status[0]).toEqual({ label: 'per_minute', limit: 3, used: 2, remaining: 1 });
    expect(status[1]).toEqual({ label: 'per_day', limit: 5, used: 2, remaining: 3 });
  });

  it('reset clears all timestamps', () => {
    limiter.tryAcquire();
    limiter.tryAcquire();
    limiter.tryAcquire();
    expect(limiter.tryAcquire().allowed).toBe(false);
    limiter.reset();
    expect(limiter.tryAcquire().allowed).toBe(true);
  });
});

describe('acquireOrThrow', () => {
  beforeEach(() => resetAllLimiters());

  it('does not throw under the limit', () => {
    expect(() => acquireOrThrow('ai_proxy')).not.toThrow();
  });

  it('throws RateLimitError with Chinese message when per-minute limit exceeded', () => {
    const limiter = getRateLimiter('ai_proxy');
    // Fill up the per-minute limit (30)
    for (let i = 0; i < 30; i++) limiter.tryAcquire();

    expect(() => acquireOrThrow('ai_proxy')).toThrow(RateLimitError);
    try {
      acquireOrThrow('ai_proxy');
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError);
      expect(e.name).toBe('RateLimitError');
      expect(e.message).toContain('AI 服務請求過於頻繁');
      expect(e.message).toContain('每分鐘');
      expect(e.message).toContain('30');
      expect(e.bucket).toBe('ai_proxy');
      expect(e.windowLabel).toBe('per_minute');
      expect(e.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('throws for per-day limit with correct label', () => {
    vi.useFakeTimers();
    const limiter = getRateLimiter('legacy_gemini');
    // Fill day limit (300) across multiple minutes to avoid per-minute (15) limit
    for (let batch = 0; batch < 20; batch++) {
      for (let i = 0; i < 15; i++) limiter.tryAcquire();
      vi.advanceTimersByTime(61_000);
    }
    // Now at 300 total requests
    try {
      acquireOrThrow('legacy_gemini');
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError);
      expect(e.message).toContain('每日');
      expect(e.windowLabel).toBe('per_day');
    }
    vi.useRealTimers();
  });
});

describe('getRateLimiter', () => {
  beforeEach(() => resetAllLimiters());

  it('returns same instance for same bucket', () => {
    const a = getRateLimiter('ai_proxy');
    const b = getRateLimiter('ai_proxy');
    expect(a).toBe(b);
  });

  it('returns different instances for different buckets', () => {
    const a = getRateLimiter('ai_proxy');
    const b = getRateLimiter('legacy_gemini');
    expect(a).not.toBe(b);
  });

  it('throws for unknown bucket', () => {
    expect(() => getRateLimiter('unknown_bucket')).toThrow('Unknown rate limiter bucket');
  });
});

describe('resetAllLimiters', () => {
  it('clears all limiter state', () => {
    const limiter = getRateLimiter('legacy_deepseek');
    for (let i = 0; i < 20; i++) limiter.tryAcquire();
    expect(limiter.tryAcquire().allowed).toBe(false);

    resetAllLimiters();
    // After reset, a new limiter is created with clean state
    const fresh = getRateLimiter('legacy_deepseek');
    expect(fresh.tryAcquire().allowed).toBe(true);
  });
});
