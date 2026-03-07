"""Tests for observability: logging, request ID middleware, health endpoints."""

import logging
import os
from unittest.mock import MagicMock, patch

import pytest


class TestRequestContextFilter:
    def test_injects_request_id_and_actor_id(self):
        from ml.api.logging_config import (
            RequestContextFilter,
            actor_id_var,
            request_id_var,
        )

        f = RequestContextFilter()
        record = logging.LogRecord(
            name="test", level=logging.INFO, pathname="", lineno=0,
            msg="hello", args=(), exc_info=None,
        )

        request_id_var.set("req-abc")
        actor_id_var.set("user-xyz")

        f.filter(record)
        assert record.request_id == "req-abc"
        assert record.actor_id == "user-xyz"

    def test_defaults_to_empty_strings(self):
        from ml.api.logging_config import (
            RequestContextFilter,
            actor_id_var,
            request_id_var,
        )

        f = RequestContextFilter()
        record = logging.LogRecord(
            name="test", level=logging.INFO, pathname="", lineno=0,
            msg="hello", args=(), exc_info=None,
        )

        # Reset context vars
        request_id_var.set("")
        actor_id_var.set("")

        f.filter(record)
        assert record.request_id == ""
        assert record.actor_id == ""


class TestRequestIdMiddleware:
    @pytest.fixture
    def app(self):
        from fastapi import FastAPI, Request

        from ml.api.observability import request_id_middleware

        test_app = FastAPI()

        @test_app.middleware("http")
        async def _rid(request: Request, call_next):
            return await request_id_middleware(request, call_next)

        @test_app.get("/test")
        async def _test():
            from ml.api.logging_config import request_id_var
            return {"request_id": request_id_var.get("")}

        return test_app

    def test_generates_uuid_request_id(self, app):
        from starlette.testclient import TestClient

        client = TestClient(app)
        resp = client.get("/test")
        assert resp.status_code == 200
        assert "X-Request-ID" in resp.headers
        assert len(resp.headers["X-Request-ID"]) > 0

    def test_uses_provided_request_id(self, app):
        from starlette.testclient import TestClient

        client = TestClient(app)
        resp = client.get("/test", headers={"X-Request-ID": "my-custom-id"})
        assert resp.status_code == 200
        assert resp.headers["X-Request-ID"] == "my-custom-id"


class TestHealthEndpoints:
    @pytest.fixture
    def app(self):
        from fastapi import FastAPI

        from ml.api.observability import health_router

        test_app = FastAPI()
        test_app.include_router(health_router)
        return test_app

    def test_live_always_200(self, app):
        from starlette.testclient import TestClient

        client = TestClient(app)
        resp = client.get("/health/live")
        assert resp.status_code == 200
        assert resp.json()["status"] == "alive"

    def test_ready_without_db(self, app):
        from starlette.testclient import TestClient

        # Without DATABASE_URL, should skip DB check and return ready
        with patch.dict(os.environ, {"DATABASE_URL": ""}, clear=False):
            client = TestClient(app)
            resp = client.get("/health/ready")
            assert resp.status_code == 200
            data = resp.json()
            assert data["status"] == "ready"
            assert data["checks"]["database"] == "skipped"

    def test_ready_with_bad_db(self, app):
        from starlette.testclient import TestClient

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://bad:5432/nope"}, clear=False):
            client = TestClient(app)
            resp = client.get("/health/ready")
            # Should return 503 when DB is unreachable
            assert resp.status_code == 503
            data = resp.json()
            assert data["status"] == "not_ready"
            assert "error" in data["checks"]["database"]
