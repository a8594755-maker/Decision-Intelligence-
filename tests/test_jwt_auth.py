"""Tests for JWT authentication middleware."""

import os
import time
from unittest.mock import MagicMock, patch

import pytest


# ── Helpers ──


def _make_jwt_token(payload: dict, secret: str = "test-secret") -> str:
    """Create a valid JWT token for testing."""
    import jwt as pyjwt

    defaults = {
        "sub": "user-123",
        "exp": int(time.time()) + 3600,
        "iat": int(time.time()),
        "email": "test@example.com",
        "app_metadata": {"role": "planner"},
    }
    defaults.update(payload)
    return pyjwt.encode(defaults, secret, algorithm="HS256")


def _make_expired_token(secret: str = "test-secret") -> str:
    import jwt as pyjwt

    payload = {
        "sub": "user-123",
        "exp": int(time.time()) - 100,
        "iat": int(time.time()) - 200,
    }
    return pyjwt.encode(payload, secret, algorithm="HS256")


# ── Tests ──


class TestDecodeToken:
    def test_valid_token(self):
        from ml.api.jwt_auth import JWTClaims, _decode_token, configure_jwt

        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": "test-secret"}):
            configure_jwt()
            token = _make_jwt_token({"sub": "user-abc", "email": "a@b.com"})
            claims = _decode_token(token)
            assert claims is not None
            assert claims.sub == "user-abc"
            assert claims.email == "a@b.com"
            assert claims.role == "planner"

    def test_expired_token(self):
        from ml.api.jwt_auth import _decode_token, configure_jwt

        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": "test-secret"}):
            configure_jwt()
            token = _make_expired_token()
            claims = _decode_token(token)
            assert claims is None

    def test_invalid_token(self):
        from ml.api.jwt_auth import _decode_token, configure_jwt

        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": "test-secret"}):
            configure_jwt()
            claims = _decode_token("not.a.valid.token")
            assert claims is None

    def test_wrong_secret(self):
        from ml.api.jwt_auth import _decode_token, configure_jwt

        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": "correct-secret"}):
            configure_jwt()
            token = _make_jwt_token({}, secret="wrong-secret")
            claims = _decode_token(token)
            assert claims is None

    def test_no_secret_configured(self):
        from ml.api.jwt_auth import _decode_token, configure_jwt

        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": ""}, clear=False):
            configure_jwt()
            token = _make_jwt_token({})
            claims = _decode_token(token)
            assert claims is None

    def test_role_from_app_metadata(self):
        from ml.api.jwt_auth import _decode_token, configure_jwt

        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": "test-secret"}):
            configure_jwt()
            token = _make_jwt_token(
                {"app_metadata": {"role": "admin"}, "user_metadata": {}}
            )
            claims = _decode_token(token)
            assert claims.role == "admin"

    def test_role_fallback_to_user_metadata(self):
        from ml.api.jwt_auth import _decode_token, configure_jwt

        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": "test-secret"}):
            configure_jwt()
            token = _make_jwt_token(
                {"app_metadata": {}, "user_metadata": {"role": "analyst"}}
            )
            claims = _decode_token(token)
            assert claims.role == "analyst"

    def test_role_default_viewer(self):
        from ml.api.jwt_auth import _decode_token, configure_jwt

        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": "test-secret"}):
            configure_jwt()
            token = _make_jwt_token({"app_metadata": {}, "user_metadata": {}})
            claims = _decode_token(token)
            assert claims.role == "viewer"


class TestMiddleware:
    """Test JWT middleware behavior using FastAPI TestClient."""

    @pytest.fixture
    def app(self):
        from fastapi import FastAPI, Request

        from ml.api.jwt_auth import configure_jwt, jwt_auth_middleware

        test_app = FastAPI()

        @test_app.middleware("http")
        async def _jwt(request: Request, call_next):
            return await jwt_auth_middleware(request, call_next)

        @test_app.get("/health")
        async def _health():
            return {"ok": True}

        @test_app.get("/health/live")
        async def _live():
            return {"alive": True}

        @test_app.get("/api/data")
        async def _data(request: Request):
            claims = getattr(request.state, "jwt_claims", None)
            return {
                "authenticated": claims is not None,
                "sub": claims.sub if claims else None,
            }

        return test_app

    def test_public_path_bypasses_auth(self, app):
        from starlette.testclient import TestClient

        from ml.api.jwt_auth import configure_jwt

        with patch.dict(
            os.environ,
            {"SUPABASE_JWT_SECRET": "test-secret", "DI_JWT_REQUIRED": "true"},
        ):
            configure_jwt()
            client = TestClient(app)
            resp = client.get("/health")
            assert resp.status_code == 200

            resp = client.get("/health/live")
            assert resp.status_code == 200

    def test_401_when_required_and_missing(self, app):
        from starlette.testclient import TestClient

        from ml.api.jwt_auth import configure_jwt

        with patch.dict(
            os.environ,
            {"SUPABASE_JWT_SECRET": "test-secret", "DI_JWT_REQUIRED": "true"},
        ):
            configure_jwt()
            client = TestClient(app)
            resp = client.get("/api/data")
            assert resp.status_code == 401

    def test_401_when_required_and_invalid(self, app):
        from starlette.testclient import TestClient

        from ml.api.jwt_auth import configure_jwt

        with patch.dict(
            os.environ,
            {"SUPABASE_JWT_SECRET": "test-secret", "DI_JWT_REQUIRED": "true"},
        ):
            configure_jwt()
            client = TestClient(app)
            resp = client.get(
                "/api/data", headers={"Authorization": "Bearer invalid.token.here"}
            )
            assert resp.status_code == 401

    def test_passthrough_when_not_required(self, app):
        from starlette.testclient import TestClient

        from ml.api.jwt_auth import configure_jwt

        with patch.dict(
            os.environ,
            {"SUPABASE_JWT_SECRET": "test-secret", "DI_JWT_REQUIRED": "false"},
        ):
            configure_jwt()
            client = TestClient(app)
            resp = client.get("/api/data")
            assert resp.status_code == 200
            data = resp.json()
            assert data["authenticated"] is False

    def test_valid_token_sets_claims(self, app):
        from starlette.testclient import TestClient

        from ml.api.jwt_auth import configure_jwt

        with patch.dict(
            os.environ,
            {"SUPABASE_JWT_SECRET": "test-secret", "DI_JWT_REQUIRED": "true"},
        ):
            configure_jwt()
            token = _make_jwt_token({"sub": "user-xyz"})
            client = TestClient(app)
            resp = client.get(
                "/api/data", headers={"Authorization": f"Bearer {token}"}
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["authenticated"] is True
            assert data["sub"] == "user-xyz"
