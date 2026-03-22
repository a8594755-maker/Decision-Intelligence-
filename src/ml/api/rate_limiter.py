"""
Rate Limiting for Decision-Intelligence API.

Supports two backends:
  - InProcessRateLimiter: simple per-worker token bucket (default fallback)
  - RedisRateLimiter: sorted-set sliding window (for multi-worker deployments)

Select via RateLimiter.from_env() — uses Redis if DI_REDIS_URL is set.

Environment variables:
  DI_REDIS_URL            — Redis connection URL (optional)
  DI_RATE_LIMIT_ENABLED   — "true"/"false" (default: "true")
  DI_RATE_LIMIT_PER_MINUTE — requests per minute per key (default: 30)
"""

import logging
import os
import time
from abc import ABC, abstractmethod
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


class BaseRateLimiter(ABC):
    """Abstract rate limiter interface."""

    @abstractmethod
    async def is_allowed(self, key: str) -> bool:
        """Check if request is allowed. Returns True if within limit."""
        ...

    async def close(self):
        """Cleanup resources."""
        pass


class InProcessRateLimiter(BaseRateLimiter):
    """Simple in-process sliding window rate limiter (per-worker)."""

    def __init__(self, max_requests: int = 30, window_seconds: float = 60.0):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._buckets: Dict[str, List[float]] = {}

    async def is_allowed(self, key: str) -> bool:
        now = time.time()
        bucket = self._buckets.setdefault(key, [])
        # Prune old entries
        self._buckets[key] = [ts for ts in bucket if now - ts < self.window_seconds]
        bucket = self._buckets[key]

        if len(bucket) >= self.max_requests:
            return False

        bucket.append(now)
        return True


class RedisRateLimiter(BaseRateLimiter):
    """
    Redis-based sliding window rate limiter using sorted sets.
    Auto-reconnects on failure, falls back to allowing requests.
    """

    def __init__(self, redis_url: str, max_requests: int = 30, window_seconds: float = 60.0):
        self.redis_url = redis_url
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._redis = None
        self._fallback = InProcessRateLimiter(max_requests, window_seconds)
        self._redis_available = True

    async def _get_redis(self):
        if self._redis is None:
            try:
                import redis.asyncio as aioredis
                self._redis = aioredis.from_url(
                    self.redis_url,
                    decode_responses=True,
                    socket_connect_timeout=3,
                    socket_timeout=3,
                )
                await self._redis.ping()
                self._redis_available = True
                logger.info("Redis rate limiter connected")
            except Exception as exc:
                logger.warning("Redis unavailable, falling back to in-process: %s", exc)
                self._redis = None
                self._redis_available = False
        return self._redis

    async def is_allowed(self, key: str) -> bool:
        redis = await self._get_redis()
        if redis is None:
            return await self._fallback.is_allowed(key)

        try:
            redis_key = f"di:rate:{key}"
            now = time.time()
            window_start = now - self.window_seconds

            pipe = redis.pipeline()
            pipe.zremrangebyscore(redis_key, "-inf", window_start)
            pipe.zadd(redis_key, {f"{now}": now})
            pipe.zcard(redis_key)
            pipe.expire(redis_key, int(self.window_seconds) + 10)
            results = await pipe.execute()

            count = results[2]  # ZCARD result
            return count <= self.max_requests
        except Exception as exc:
            logger.warning("Redis rate limit check failed, allowing request: %s", exc)
            self._redis = None
            self._redis_available = False
            return await self._fallback.is_allowed(key)

    async def close(self):
        if self._redis:
            try:
                await self._redis.close()
            except Exception:
                pass
            self._redis = None


class RateLimiter:
    """Factory for rate limiter instances."""

    @staticmethod
    def from_env() -> BaseRateLimiter:
        """
        Create rate limiter based on environment.
        Uses Redis if DI_REDIS_URL is set, otherwise in-process.
        """
        max_requests = int(os.getenv("DI_RATE_LIMIT_PER_MINUTE", "120"))
        redis_url = os.getenv("DI_REDIS_URL", "")

        if redis_url:
            logger.info("Using Redis rate limiter (url=%s...)", redis_url[:20])
            return RedisRateLimiter(redis_url, max_requests)
        else:
            logger.info("Using in-process rate limiter (max=%d/min)", max_requests)
            return InProcessRateLimiter(max_requests)
