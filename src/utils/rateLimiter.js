/**
 * Sliding Window Rate Limiter
 *
 * Pure JS, no external dependencies. Stores timestamps in memory.
 * Each limiter instance tracks requests for a named bucket (e.g., 'ai_proxy').
 * Supports multiple windows (e.g., 30/minute AND 500/day simultaneously).
 */

export class RateLimitError extends Error {
  constructor(message, { bucket, windowLabel, limit, remaining, retryAfterMs } = {}) {
    super(message);
    this.name = 'RateLimitError';
    this.bucket = bucket;
    this.windowLabel = windowLabel;
    this.limit = limit;
    this.remaining = remaining;
    this.retryAfterMs = retryAfterMs;
  }
}

export class SlidingWindowLimiter {
  /**
   * @param {object} opts
   * @param {string} opts.bucket - Name of this limiter bucket
   * @param {Array<{label: string, maxRequests: number, windowMs: number}>} opts.windows
   */
  constructor({ bucket, windows }) {
    this.bucket = bucket;
    this.windows = windows;
    this.timestamps = [];
  }

  /** Remove timestamps older than the longest window. */
  _prune(now) {
    const maxWindowMs = Math.max(...this.windows.map((w) => w.windowMs));
    const cutoff = now - maxWindowMs;
    this.timestamps = this.timestamps.filter((ts) => ts > cutoff);
  }

  /**
   * Check if a request is allowed. If allowed, record it.
   * @returns {{ allowed: boolean, windowLabel?: string, limit?: number, remaining?: number, retryAfterMs?: number }}
   */
  tryAcquire() {
    const now = Date.now();
    this._prune(now);

    for (const window of this.windows) {
      const windowStart = now - window.windowMs;
      const countInWindow = this.timestamps.filter((ts) => ts > windowStart).length;
      if (countInWindow >= window.maxRequests) {
        const oldestInWindow = this.timestamps.find((ts) => ts > windowStart);
        const retryAfterMs = oldestInWindow
          ? oldestInWindow + window.windowMs - now
          : window.windowMs;
        return {
          allowed: false,
          windowLabel: window.label,
          limit: window.maxRequests,
          remaining: 0,
          retryAfterMs: Math.max(0, retryAfterMs),
        };
      }
    }

    this.timestamps.push(now);
    return { allowed: true };
  }

  /** Get current status without consuming a slot. */
  getStatus() {
    const now = Date.now();
    this._prune(now);
    return this.windows.map((window) => {
      const windowStart = now - window.windowMs;
      const countInWindow = this.timestamps.filter((ts) => ts > windowStart).length;
      return {
        label: window.label,
        limit: window.maxRequests,
        used: countInWindow,
        remaining: Math.max(0, window.maxRequests - countInWindow),
      };
    });
  }

  reset() {
    this.timestamps = [];
  }
}

/* ------------------------------------------------------------------ */
/*  Default configuration                                             */
/* ------------------------------------------------------------------ */

const RATE_LIMIT_DEFAULTS = Object.freeze({
  ai_proxy: {
    windows: [
      { label: 'per_minute', maxRequests: 30, windowMs: 60_000 },
      { label: 'per_day', maxRequests: 500, windowMs: 86_400_000 },
    ],
  },
  legacy_gemini: {
    windows: [
      { label: 'per_minute', maxRequests: 15, windowMs: 60_000 },
      { label: 'per_day', maxRequests: 300, windowMs: 86_400_000 },
    ],
  },
  legacy_deepseek: {
    windows: [
      { label: 'per_minute', maxRequests: 20, windowMs: 60_000 },
      { label: 'per_day', maxRequests: 400, windowMs: 86_400_000 },
    ],
  },
});

/* ------------------------------------------------------------------ */
/*  Singleton registry                                                */
/* ------------------------------------------------------------------ */

const _limiters = new Map();

/**
 * Get (or create) a rate limiter for the given bucket name.
 * @param {string} bucket - One of 'ai_proxy' | 'legacy_gemini' | 'legacy_deepseek'
 */
export const getRateLimiter = (bucket) => {
  if (_limiters.has(bucket)) return _limiters.get(bucket);
  const config = RATE_LIMIT_DEFAULTS[bucket];
  if (!config) {
    throw new Error(`Unknown rate limiter bucket: "${bucket}"`);
  }
  const limiter = new SlidingWindowLimiter({ bucket, windows: config.windows });
  _limiters.set(bucket, limiter);
  return limiter;
};

/** Reset all limiter instances (useful for testing). */
export const resetAllLimiters = () => {
  _limiters.forEach((limiter) => limiter.reset());
  _limiters.clear();
};

/* ------------------------------------------------------------------ */
/*  Convenience helper                                                */
/* ------------------------------------------------------------------ */

const WINDOW_LABELS = { per_minute: '每分鐘', per_day: '每日' };

/**
 * Acquire a slot or throw a RateLimitError with a user-friendly Traditional Chinese message.
 * @param {string} bucket
 */
export const acquireOrThrow = (bucket) => {
  const limiter = getRateLimiter(bucket);
  const result = limiter.tryAcquire();
  if (!result.allowed) {
    const retrySeconds = Math.ceil(result.retryAfterMs / 1000);
    const windowDesc = WINDOW_LABELS[result.windowLabel] || result.windowLabel;
    const message =
      `⚠️ AI 服務請求過於頻繁\n\n` +
      `已達到${windowDesc}上限（${result.limit} 次）。\n` +
      `請等待約 ${retrySeconds} 秒後再試。`;
    throw new RateLimitError(message, {
      bucket,
      windowLabel: result.windowLabel,
      limit: result.limit,
      remaining: result.remaining,
      retryAfterMs: result.retryAfterMs,
    });
  }
  return result;
};
