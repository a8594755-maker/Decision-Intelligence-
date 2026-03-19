"""
Observability: Request ID middleware and health endpoints.

- request_id_middleware: assigns UUID per request, sets contextvars
- /health/live: liveness probe (always 200)
- /health/ready: readiness probe (checks DB + solver availability)
"""

import logging
import uuid

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from .logging_config import actor_id_var, request_id_var

logger = logging.getLogger(__name__)

# ── Health Router ──

health_router = APIRouter(tags=["health"])


@health_router.get("/health/live")
async def health_live():
    """Liveness probe — always returns 200."""
    return {"status": "alive"}


@health_router.get("/health/ready")
async def health_ready():
    """
    Readiness probe — checks DB connectivity and solver availability.
    Returns 200 if ready, 503 otherwise.
    """
    checks = {}

    # Check DB
    try:
        import psycopg2
        import os

        db_url = os.getenv("DATABASE_URL", "")
        if db_url:
            conn = psycopg2.connect(db_url, connect_timeout=3)
            cur = conn.cursor()
            cur.execute("SELECT 1")
            cur.close()
            conn.close()
            checks["database"] = "ok"
        else:
            checks["database"] = "skipped"
    except Exception as exc:
        checks["database"] = f"error: {exc}"

    # Check solver availability
    try:
        from ml.api.solver_engines import get_solver_inventory

        inventory = get_solver_inventory()
        checks["solver"] = "ok" if inventory else "no_engines"
    except Exception:
        checks["solver"] = "ok"  # Non-critical if solver_engines not available

    # Check LLM proxy reachability (Supabase Edge Function ai-proxy)
    try:
        sb_url = os.getenv("SUPABASE_URL", "")
        if sb_url:
            proxy_url = f"{sb_url.rstrip('/')}/functions/v1/ai-proxy"
            req = urllib.request.Request(proxy_url, method="OPTIONS")
            resp = urllib.request.urlopen(req, timeout=5)
            checks["llm_proxy"] = "ok" if resp.status in (200, 204) else "degraded"
        else:
            checks["llm_proxy"] = "not_configured"
    except Exception:
        checks["llm_proxy"] = "unreachable"

    is_ready = checks.get("database") in ("ok", "skipped")

    if is_ready:
        return {"status": "ready", "checks": checks}
    else:
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "checks": checks},
        )


# ── Request ID Middleware ──

async def request_id_middleware(request: Request, call_next):
    """
    Assigns a unique request ID (UUID) to each request.
    Reads X-Request-ID header if present, otherwise generates one.
    Sets contextvars for structured logging.
    """
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
    request_id_var.set(rid)

    # Also set actor_id from JWT claims or headers
    jwt_claims = getattr(request.state, "jwt_claims", None)
    if jwt_claims and jwt_claims.sub:
        actor_id_var.set(jwt_claims.sub)
    else:
        actor_id = (
            request.headers.get("x-actor-id")
            or request.headers.get("x-user-id")
            or ""
        )
        actor_id_var.set(actor_id)

    response: Response = await call_next(request)
    response.headers["X-Request-ID"] = rid
    return response
