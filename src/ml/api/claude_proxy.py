"""
claude_proxy.py
FastAPI router: POST /claude

Thin backend proxy for Excel Add-in custom functions.
Excel → POST /claude → Anthropic Messages API (claude-opus-4-6) → text response.

Security: API key stays server-side; Excel never touches it.
Caching: In-memory TTL cache (configurable, default 5 min) to avoid
         duplicate calls from Excel recalculation.
Rate limiting: Max requests per minute (default 30).
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger("claude_proxy")

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------
claude_proxy_router = APIRouter()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = os.getenv("DI_CLAUDE_MODEL", "claude-opus-4-6")
CLAUDE_MAX_TOKENS = int(os.getenv("DI_CLAUDE_MAX_TOKENS", "2048"))
CACHE_TTL_SECONDS = int(os.getenv("DI_CLAUDE_CACHE_TTL", "300"))  # 5 min
CACHE_MAX_SIZE = int(os.getenv("DI_CLAUDE_CACHE_MAX", "200"))
MAX_INPUT_CHARS = int(os.getenv("DI_CLAUDE_MAX_INPUT", "8000"))
RATE_LIMIT_PER_MIN = int(os.getenv("DI_CLAUDE_RATE_LIMIT", "30"))

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ClaudeRequest(BaseModel):
    prompt: str = Field(..., description="The prompt to send to Claude")
    system: Optional[str] = Field(None, description="Optional system prompt")
    max_tokens: Optional[int] = Field(None, description="Override max tokens")
    context: Optional[str] = Field(None, description="Optional cell range context to prepend")


class ClaudeResponse(BaseModel):
    text: str
    model: str
    cached: bool = False
    input_tokens: int = 0
    output_tokens: int = 0


class ClaudeBatchItem(BaseModel):
    id: str = Field(..., description="Cell reference or identifier")
    prompt: str


class ClaudeBatchRequest(BaseModel):
    items: List[ClaudeBatchItem] = Field(..., max_length=20)
    system: Optional[str] = None


class ClaudeBatchResponse(BaseModel):
    results: List[Dict[str, Any]]


# ---------------------------------------------------------------------------
# In-memory cache (LRU with TTL)
# ---------------------------------------------------------------------------

class _TTLCache:
    """Simple LRU cache with TTL expiry."""

    def __init__(self, max_size: int = 200, ttl: int = 300):
        self._store: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._max_size = max_size
        self._ttl = ttl

    def _key(self, prompt: str, system: str | None) -> str:
        raw = f"{prompt}||{system or ''}"
        return hashlib.sha256(raw.encode()).hexdigest()[:32]

    def get(self, prompt: str, system: str | None = None) -> Any | None:
        k = self._key(prompt, system)
        if k not in self._store:
            return None
        ts, val = self._store[k]
        if time.time() - ts > self._ttl:
            del self._store[k]
            return None
        self._store.move_to_end(k)
        return val

    def put(self, prompt: str, system: str | None, value: Any):
        k = self._key(prompt, system)
        self._store[k] = (time.time(), value)
        self._store.move_to_end(k)
        if len(self._store) > self._max_size:
            self._store.popitem(last=False)


_cache = _TTLCache(max_size=CACHE_MAX_SIZE, ttl=CACHE_TTL_SECONDS)

# ---------------------------------------------------------------------------
# Simple rate limiter
# ---------------------------------------------------------------------------

_rate_window: list[float] = []


def _check_rate_limit():
    now = time.time()
    cutoff = now - 60
    while _rate_window and _rate_window[0] < cutoff:
        _rate_window.pop(0)
    if len(_rate_window) >= RATE_LIMIT_PER_MIN:
        raise HTTPException(429, detail="Rate limit exceeded. Try again in a minute.")
    _rate_window.append(now)


# ---------------------------------------------------------------------------
# Anthropic API call
# ---------------------------------------------------------------------------

async def _call_claude(prompt: str, system: str | None, max_tokens: int) -> dict:
    """Call Anthropic Messages API. Returns {text, model, input_tokens, output_tokens}."""
    if not ANTHROPIC_API_KEY:
        raise HTTPException(503, detail="ANTHROPIC_API_KEY not configured on server")

    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    payload: dict[str, Any] = {
        "model": CLAUDE_MODEL,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    if system:
        payload["system"] = system

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code != 200:
            detail = resp.text[:500]
            logger.error(f"[claude_proxy] Anthropic API error {resp.status_code}: {detail}")
            raise HTTPException(502, detail=f"Anthropic API error: {detail}")
        data = resp.json()

    text_parts = []
    for block in data.get("content", []):
        if block.get("type") == "text":
            text_parts.append(block["text"])

    usage = data.get("usage", {})
    return {
        "text": "\n".join(text_parts),
        "model": data.get("model", CLAUDE_MODEL),
        "input_tokens": usage.get("input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0),
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@claude_proxy_router.post("/claude", response_model=ClaudeResponse)
async def ask_claude(req: ClaudeRequest):
    """Single prompt → Claude response. Used by =CLAUDE() custom function."""
    # Input guard
    full_prompt = req.prompt
    if req.context:
        full_prompt = f"Context data:\n{req.context}\n\nUser request:\n{req.prompt}"

    if len(full_prompt) > MAX_INPUT_CHARS:
        raise HTTPException(
            400,
            detail=f"Input too long ({len(full_prompt)} chars). Max: {MAX_INPUT_CHARS}",
        )

    # Cache check
    cached = _cache.get(full_prompt, req.system)
    if cached:
        return ClaudeResponse(**cached, cached=True)

    # Rate limit
    _check_rate_limit()

    # Call Claude
    max_tok = req.max_tokens or CLAUDE_MAX_TOKENS
    result = await _call_claude(full_prompt, req.system, max_tok)

    # Cache result
    _cache.put(full_prompt, req.system, result)

    return ClaudeResponse(**result, cached=False)


@claude_proxy_router.post("/claude/batch", response_model=ClaudeBatchResponse)
async def ask_claude_batch(req: ClaudeBatchRequest):
    """Batch multiple prompts. Used when Excel needs multiple cells analyzed at once."""
    if len(req.items) > 20:
        raise HTTPException(400, detail="Max 20 items per batch")

    _check_rate_limit()

    results = []
    for item in req.items:
        prompt = item.prompt
        if len(prompt) > MAX_INPUT_CHARS:
            results.append({"id": item.id, "text": f"ERROR: Input too long ({len(prompt)} chars)", "error": True})
            continue

        # Check cache
        cached = _cache.get(prompt, req.system)
        if cached:
            results.append({"id": item.id, **cached, "cached": True})
            continue

        try:
            result = await _call_claude(prompt, req.system, CLAUDE_MAX_TOKENS)
            _cache.put(prompt, req.system, result)
            results.append({"id": item.id, **result, "cached": False})
        except Exception as e:
            results.append({"id": item.id, "text": f"ERROR: {str(e)}", "error": True})

    return ClaudeBatchResponse(results=results)


@claude_proxy_router.get("/claude/health")
async def claude_health():
    """Check if Claude proxy is configured and ready."""
    return {
        "ok": bool(ANTHROPIC_API_KEY),
        "model": CLAUDE_MODEL,
        "max_tokens": CLAUDE_MAX_TOKENS,
        "cache_ttl": CACHE_TTL_SECONDS,
        "rate_limit": RATE_LIMIT_PER_MIN,
    }
