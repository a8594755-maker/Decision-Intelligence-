"""Tests for rate limiter."""

import os
from unittest.mock import patch

import pytest


class TestInProcessRateLimiter:
    @pytest.mark.asyncio
    async def test_permits_up_to_limit(self):
        from ml.api.rate_limiter import InProcessRateLimiter

        limiter = InProcessRateLimiter(max_requests=3, window_seconds=60.0)

        assert await limiter.is_allowed("user-1") is True
        assert await limiter.is_allowed("user-1") is True
        assert await limiter.is_allowed("user-1") is True

    @pytest.mark.asyncio
    async def test_rejects_beyond_limit(self):
        from ml.api.rate_limiter import InProcessRateLimiter

        limiter = InProcessRateLimiter(max_requests=2, window_seconds=60.0)

        assert await limiter.is_allowed("user-1") is True
        assert await limiter.is_allowed("user-1") is True
        assert await limiter.is_allowed("user-1") is False

    @pytest.mark.asyncio
    async def test_separate_keys(self):
        from ml.api.rate_limiter import InProcessRateLimiter

        limiter = InProcessRateLimiter(max_requests=1, window_seconds=60.0)

        assert await limiter.is_allowed("user-a") is True
        assert await limiter.is_allowed("user-b") is True
        assert await limiter.is_allowed("user-a") is False

    @pytest.mark.asyncio
    async def test_window_expiry(self):
        import time
        from ml.api.rate_limiter import InProcessRateLimiter

        limiter = InProcessRateLimiter(max_requests=1, window_seconds=0.1)

        assert await limiter.is_allowed("user-1") is True
        assert await limiter.is_allowed("user-1") is False

        # Wait for window to expire
        time.sleep(0.15)
        assert await limiter.is_allowed("user-1") is True


class TestRedisRateLimiter:
    @pytest.mark.asyncio
    async def test_falls_back_when_redis_unavailable(self):
        from ml.api.rate_limiter import RedisRateLimiter

        # Use a bogus URL that will fail to connect
        limiter = RedisRateLimiter(
            redis_url="redis://localhost:59999",
            max_requests=5,
            window_seconds=60.0,
        )

        # Should fall back to in-process and allow requests
        assert await limiter.is_allowed("user-1") is True
        assert await limiter.is_allowed("user-1") is True

        await limiter.close()


class TestFactory:
    def test_from_env_no_redis(self):
        from ml.api.rate_limiter import InProcessRateLimiter, RateLimiter

        with patch.dict(os.environ, {"DI_REDIS_URL": ""}, clear=False):
            limiter = RateLimiter.from_env()
            assert isinstance(limiter, InProcessRateLimiter)

    def test_from_env_with_redis(self):
        from ml.api.rate_limiter import RedisRateLimiter, RateLimiter

        with patch.dict(
            os.environ, {"DI_REDIS_URL": "redis://localhost:6379"}, clear=False
        ):
            limiter = RateLimiter.from_env()
            assert isinstance(limiter, RedisRateLimiter)
