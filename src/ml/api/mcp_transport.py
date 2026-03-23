"""
MCP Transport Layer — stdio and HTTP+SSE transports for the DI MCP server.

- StdioTransport: reads JSON-RPC 2.0 from stdin, writes to stdout (OpenClaw native)
- HttpSseTransport: FastAPI router for HTTP POST + SSE progress (standalone/testing)
"""

import asyncio
import json
import sys
import logging
from typing import Any, Callable, Awaitable

logger = logging.getLogger(__name__)

# ── JSON-RPC helpers ──────────────────────────────────────────────────────────


def make_response(id: Any, result: Any) -> dict:
    """Build a JSON-RPC 2.0 success response."""
    return {"jsonrpc": "2.0", "id": id, "result": result}


def make_error(id: Any, code: int, message: str, data: Any = None) -> dict:
    """Build a JSON-RPC 2.0 error response."""
    err = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": id, "error": err}


# Standard JSON-RPC error codes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

# ── Type alias for the handler function ───────────────────────────────────────

MCPHandler = Callable[[dict], Awaitable[dict | None]]

# ── Stdio Transport ──────────────────────────────────────────────────────────


class StdioTransport:
    """
    OpenClaw-native transport: JSON-RPC over stdin/stdout.
    Each message is a JSON object on a single line.
    """

    def __init__(self, handler: MCPHandler):
        self.handler = handler
        self._running = False

    async def run(self):
        """Main event loop — read from stdin, process, write to stdout."""
        self._running = True
        logger.info("MCP StdioTransport starting...")

        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await asyncio.get_event_loop().connect_read_pipe(lambda: protocol, sys.stdin)

        while self._running:
            try:
                line = await reader.readline()
                if not line:
                    logger.info("stdin closed, shutting down")
                    break

                line_str = line.decode("utf-8").strip()
                if not line_str:
                    continue

                try:
                    message = json.loads(line_str)
                except json.JSONDecodeError as e:
                    response = make_error(None, PARSE_ERROR, f"Parse error: {e}")
                    self._write(response)
                    continue

                # Validate JSON-RPC 2.0 structure
                if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
                    response = make_error(
                        message.get("id"),
                        INVALID_REQUEST,
                        "Invalid JSON-RPC 2.0 request",
                    )
                    self._write(response)
                    continue

                response = await self.handler(message)
                if response is not None:
                    self._write(response)

            except Exception as e:
                logger.exception("Error processing MCP message")
                self._write(
                    make_error(None, INTERNAL_ERROR, f"Internal error: {str(e)}")
                )

    def _write(self, response: dict):
        """Write JSON-RPC response to stdout."""
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()

    def stop(self):
        self._running = False


# ── HTTP+SSE Transport (FastAPI router) ───────────────────────────────────────


def create_http_router(handler: MCPHandler):
    """
    Create a FastAPI router for HTTP-based MCP transport.
    Useful for testing and web-based MCP clients.
    """
    from fastapi import APIRouter, Request
    from fastapi.responses import JSONResponse

    router = APIRouter(prefix="/mcp", tags=["MCP"])

    @router.post("/jsonrpc")
    async def mcp_jsonrpc(request: Request):
        """Handle MCP JSON-RPC 2.0 requests over HTTP POST."""
        try:
            body = await request.json()
        except Exception:
            return JSONResponse(
                content=make_error(None, PARSE_ERROR, "Invalid JSON body"),
                status_code=400,
            )

        if not isinstance(body, dict) or body.get("jsonrpc") != "2.0":
            return JSONResponse(
                content=make_error(
                    body.get("id") if isinstance(body, dict) else None,
                    INVALID_REQUEST,
                    "Invalid JSON-RPC 2.0 request",
                ),
                status_code=400,
            )

        response = await handler(body)
        if response is None:
            return JSONResponse(content={"status": "notification_received"})
        return JSONResponse(content=response)

    @router.get("/health")
    async def mcp_health():
        """Health check for MCP server."""
        return {"status": "ok", "transport": "http"}

    return router
