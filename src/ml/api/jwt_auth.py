"""
JWT Authentication Middleware for Decision-Intelligence API.

Validates Supabase JWT tokens (HS256) and extracts claims.
Falls back to header-based auth when DI_JWT_REQUIRED=false (default).

Environment variables:
  SUPABASE_JWT_SECRET  — JWT secret from Supabase project settings
  DI_JWT_REQUIRED      — "true" to enforce JWT on all requests (default: "false")
"""

import logging
import os
from dataclasses import dataclass, field
from typing import Dict, Optional

from fastapi import Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

# Public paths that skip JWT validation
_PUBLIC_PATHS = frozenset({
    "/health",
    "/health/live",
    "/health/ready",
    "/metrics",
    "/docs",
    "/openapi.json",
    "/redoc",
})


@dataclass
class JWTClaims:
    """Decoded JWT claims."""
    sub: str = ""
    role: str = "viewer"
    email: str = ""
    raw_claims: Dict = field(default_factory=dict)


_jwt_secret: Optional[str] = None
_jwt_required: bool = False


def configure_jwt():
    """Read JWT config from environment. Call once at startup."""
    global _jwt_secret, _jwt_required
    _jwt_secret = os.getenv("SUPABASE_JWT_SECRET", "")
    _jwt_required = os.getenv("DI_JWT_REQUIRED", "false").lower() == "true"
    if _jwt_required and not _jwt_secret:
        logger.warning("DI_JWT_REQUIRED=true but SUPABASE_JWT_SECRET is empty")
    elif _jwt_secret:
        logger.info("JWT authentication configured (required=%s)", _jwt_required)
    else:
        logger.info("JWT authentication disabled (no secret configured)")


def _decode_token(token: str) -> Optional[JWTClaims]:
    """Decode and validate a JWT token. Returns None on failure."""
    if not _jwt_secret:
        return None
    try:
        import jwt as pyjwt
    except ImportError:
        logger.warning("PyJWT not installed — JWT validation disabled")
        return None

    try:
        payload = pyjwt.decode(
            token,
            _jwt_secret,
            algorithms=["HS256"],
            options={"require": ["exp", "sub"]},
        )
        sub = payload.get("sub", "")
        # Supabase stores role in app_metadata.role or user_metadata.role
        app_meta = payload.get("app_metadata", {})
        user_meta = payload.get("user_metadata", {})
        role = (
            app_meta.get("role")
            or user_meta.get("role")
            or payload.get("role")
            or "viewer"
        )
        email = payload.get("email", "")
        return JWTClaims(sub=sub, role=role, email=email, raw_claims=payload)
    except Exception as exc:
        logger.debug("JWT decode failed: %s", exc)
        return None


async def jwt_auth_middleware(request: Request, call_next):
    """
    FastAPI middleware for JWT authentication.

    - Skips public paths (health, metrics, docs)
    - When DI_JWT_REQUIRED=true: returns 401 on missing/invalid token
    - When DI_JWT_REQUIRED=false: falls through to header-based auth
    - Sets request.state.jwt_claims on success
    """
    path = request.url.path

    # Skip public paths
    if path in _PUBLIC_PATHS or path.startswith("/health"):
        return await call_next(request)

    # Skip OPTIONS (CORS preflight)
    if request.method == "OPTIONS":
        return await call_next(request)

    # Extract Bearer token
    auth_header = request.headers.get("authorization", "")
    token = None
    if auth_header.lower().startswith("bearer "):
        token = auth_header[7:].strip()

    claims = None
    if token:
        claims = _decode_token(token)

    if claims:
        request.state.jwt_claims = claims
    else:
        request.state.jwt_claims = None
        if _jwt_required and token:
            return JSONResponse(
                status_code=401,
                content={"error": "Invalid or expired JWT token"},
            )
        elif _jwt_required and not token:
            return JSONResponse(
                status_code=401,
                content={"error": "Authorization header with Bearer token required"},
            )

    return await call_next(request)
