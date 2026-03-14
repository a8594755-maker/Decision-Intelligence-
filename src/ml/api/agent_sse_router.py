"""
agent_sse_router.py — Server-Sent Events for agent loop step progress

Inspired by OpenCloud's services/sse/ pattern.
Provides real-time push of step execution events to the frontend,
replacing polling-based progress tracking.

Endpoints:
  GET  /sse/agent/{task_id}/events  — SSE stream of step lifecycle events
  POST /sse/agent/{task_id}/publish — Publish an event (called by JS agent loop)
  GET  /sse/agent/active            — List active SSE channels
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import defaultdict
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logger = logging.getLogger("agent_sse")

agent_sse_router = APIRouter(prefix="/sse", tags=["agent-sse"])

# ---------------------------------------------------------------------------
# In-memory event channels — one asyncio.Queue per task_id
# ---------------------------------------------------------------------------

_channels: Dict[str, asyncio.Queue] = {}
_channel_meta: Dict[str, dict] = {}  # { task_id: { created_at, last_event_at, subscriber_count } }

# Cleanup channels idle for > 10 minutes
CHANNEL_TTL_SECONDS = 600
# Heartbeat interval
HEARTBEAT_INTERVAL = 15


def _get_or_create_channel(task_id: str) -> asyncio.Queue:
    if task_id not in _channels:
        _channels[task_id] = asyncio.Queue(maxsize=500)
        _channel_meta[task_id] = {
            "created_at": time.time(),
            "last_event_at": time.time(),
            "subscriber_count": 0,
        }
    return _channels[task_id]


def _cleanup_stale_channels():
    now = time.time()
    stale = [
        tid for tid, meta in _channel_meta.items()
        if now - meta["last_event_at"] > CHANNEL_TTL_SECONDS and meta["subscriber_count"] <= 0
    ]
    for tid in stale:
        _channels.pop(tid, None)
        _channel_meta.pop(tid, None)
    if stale:
        logger.info(f"[agent_sse] Cleaned up {len(stale)} stale channels")


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class StepEventPayload(BaseModel):
    event_type: str = Field(..., description="step_started | step_completed | step_failed | step_review | step_revision | loop_done | loop_error")
    step_name: Optional[str] = None
    step_index: Optional[int] = None
    status: Optional[str] = None
    summary: Optional[str] = None
    error: Optional[str] = None
    code: Optional[str] = None
    code_language: Optional[str] = None
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    artifacts: Optional[List[Dict[str, Any]]] = None
    api_call: Optional[Dict[str, Any]] = None
    review: Optional[Dict[str, Any]] = None
    healing_strategy: Optional[str] = None
    revision_instructions: Optional[List[str]] = None
    loop_state: Optional[Dict[str, Any]] = None
    timestamp: Optional[float] = None
    extra: Optional[Dict[str, Any]] = None


# ---------------------------------------------------------------------------
# POST /sse/agent/{task_id}/publish — Publish event to channel
# ---------------------------------------------------------------------------

@agent_sse_router.post("/agent/{task_id}/publish")
async def publish_event(task_id: str, payload: StepEventPayload):
    """
    Publish a step event to the SSE channel for this task.
    Called by the JS frontend agent loop (or future Python-side loop).
    """
    channel = _get_or_create_channel(task_id)

    event_data = payload.model_dump(exclude_none=True)
    event_data.setdefault("timestamp", time.time())

    try:
        channel.put_nowait(event_data)
    except asyncio.QueueFull:
        # Drop oldest event to make room
        try:
            channel.get_nowait()
        except asyncio.QueueEmpty:
            pass
        channel.put_nowait(event_data)

    _channel_meta[task_id]["last_event_at"] = time.time()

    # If this is a terminal event, signal stream end
    if payload.event_type in ("loop_done", "loop_error"):
        try:
            channel.put_nowait({"_end": True})
        except asyncio.QueueFull:
            pass

    return {"ok": True, "queued": True, "queue_size": channel.qsize()}


# ---------------------------------------------------------------------------
# GET /sse/agent/{task_id}/events — SSE stream
# ---------------------------------------------------------------------------

@agent_sse_router.get("/agent/{task_id}/events")
async def stream_events(task_id: str, request: Request):
    """
    SSE endpoint streaming step events for a task.
    Sends heartbeat pings every 15s to keep connection alive.
    Automatically closes on terminal events (loop_done, loop_error).
    """
    channel = _get_or_create_channel(task_id)
    _channel_meta[task_id]["subscriber_count"] = _channel_meta[task_id].get("subscriber_count", 0) + 1

    async def event_generator():
        try:
            # Initial connection event
            yield _format_sse("connected", {"task_id": task_id, "timestamp": time.time()})

            while True:
                # Check if client disconnected
                if await request.is_disconnected():
                    break

                try:
                    # Wait for event with timeout (heartbeat interval)
                    event = await asyncio.wait_for(channel.get(), timeout=HEARTBEAT_INTERVAL)

                    # Terminal signal
                    if isinstance(event, dict) and event.get("_end"):
                        yield _format_sse("end", {"done": True, "task_id": task_id})
                        break

                    event_type = event.get("event_type", "step_event")
                    yield _format_sse(event_type, event)

                except asyncio.TimeoutError:
                    # Send heartbeat ping
                    yield _format_sse("ping", {"ts": time.time()})

                    # Periodic cleanup
                    _cleanup_stale_channels()

        finally:
            meta = _channel_meta.get(task_id)
            if meta:
                meta["subscriber_count"] = max(0, meta.get("subscriber_count", 1) - 1)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
        },
    )


# ---------------------------------------------------------------------------
# GET /sse/agent/active — List active channels (debug)
# ---------------------------------------------------------------------------

@agent_sse_router.get("/agent/active")
async def list_active_channels():
    """List active SSE channels with metadata."""
    _cleanup_stale_channels()
    result = []
    for task_id, meta in _channel_meta.items():
        result.append({
            "task_id": task_id,
            "queue_size": _channels[task_id].qsize() if task_id in _channels else 0,
            **meta,
        })
    return {"channels": result, "count": len(result)}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _format_sse(event_type: str, data: dict) -> str:
    """Format a Server-Sent Event message."""
    json_data = json.dumps(data, default=str, ensure_ascii=False)
    return f"event: {event_type}\ndata: {json_data}\n\n"
