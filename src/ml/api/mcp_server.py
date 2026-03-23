"""
DI MCP Server — Model Context Protocol server for OpenClaw integration.

Exposes Decision-Intelligence supply chain engines as MCP tools.
Supports stdio (OpenClaw native) and HTTP+SSE transports.

Usage:
  # stdio mode (OpenClaw spawns this)
  python -m ml.api.mcp_server --transport stdio

  # HTTP mode (standalone testing)
  python -m ml.api.mcp_server --transport http --port 3100
"""

import asyncio
import json
import logging
import os
import sys
from typing import Any

import httpx

from ml.api.mcp_tool_catalog import get_catalog
from ml.api.mcp_transport import (
    MCPHandler,
    make_response,
    make_error,
    METHOD_NOT_FOUND,
    INVALID_PARAMS,
    INTERNAL_ERROR,
    StdioTransport,
    create_http_router,
)

logger = logging.getLogger(__name__)

# ── Server info ───────────────────────────────────────────────────────────────

SERVER_NAME = "di-supply-chain"
SERVER_VERSION = "1.0.0"
PROTOCOL_VERSION = "2024-11-05"

# ── Configuration ─────────────────────────────────────────────────────────────

DI_API_BASE = os.getenv("DI_API_BASE", "http://localhost:8000")
DI_AGENT_ROLE = os.getenv("DI_AGENT_ROLE", "")  # forecast | procurement | risk | ""
DI_AUTH_HEADER = os.getenv("DI_AUTH_HEADER", "x-di-server")
DI_AUTH_VALUE = os.getenv("DI_AUTH_VALUE", "true")

# ── MCP Server ────────────────────────────────────────────────────────────────


class DIMCPServer:
    """
    Decision-Intelligence MCP Server.
    Translates MCP protocol calls into DI API requests.
    """

    def __init__(self):
        self.catalog = get_catalog()
        self._client = httpx.AsyncClient(
            base_url=DI_API_BASE,
            timeout=180.0,
            headers={DI_AUTH_HEADER: DI_AUTH_VALUE},
        )
        self._initialized = False

    async def handle(self, message: dict) -> dict | None:
        """Route a JSON-RPC 2.0 message to the appropriate handler."""
        method = message.get("method", "")
        msg_id = message.get("id")
        params = message.get("params", {})

        # Notifications (no id) → no response
        if msg_id is None and method.startswith("notifications/"):
            self._handle_notification(method, params)
            return None

        handler_map = {
            "initialize": self._handle_initialize,
            "initialized": self._handle_initialized,
            "ping": self._handle_ping,
            "tools/list": self._handle_tools_list,
            "tools/call": self._handle_tools_call,
            "resources/list": self._handle_resources_list,
            "resources/read": self._handle_resources_read,
        }

        handler = handler_map.get(method)
        if handler is None:
            return make_error(msg_id, METHOD_NOT_FOUND, f"Unknown method: {method}")

        try:
            result = await handler(params)
            return make_response(msg_id, result)
        except ValueError as e:
            return make_error(msg_id, INVALID_PARAMS, str(e))
        except Exception as e:
            logger.exception("Error handling %s", method)
            return make_error(msg_id, INTERNAL_ERROR, str(e))

    # ── Protocol handlers ─────────────────────────────────────────────────

    async def _handle_initialize(self, params: dict) -> dict:
        """Respond to MCP initialize with server capabilities."""
        self._initialized = True
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {
                "tools": {"listChanged": False},
                "resources": {"subscribe": False, "listChanged": False},
            },
            "serverInfo": {
                "name": SERVER_NAME,
                "version": SERVER_VERSION,
            },
        }

    async def _handle_initialized(self, params: dict) -> dict:
        """Client acknowledged initialization."""
        return {}

    async def _handle_ping(self, params: dict) -> dict:
        return {}

    async def _handle_tools_list(self, params: dict) -> dict:
        """Return available DI tools, optionally filtered by agent role."""
        role = DI_AGENT_ROLE or None
        tools = self.catalog.list_tools(role=role)
        return {"tools": tools}

    async def _handle_tools_call(self, params: dict) -> dict:
        """Execute a DI tool via the appropriate API endpoint."""
        tool_name = params.get("name")
        arguments = params.get("arguments", {})

        if not tool_name:
            raise ValueError("Missing 'name' in tools/call params")

        routing = self.catalog.get_routing_info(tool_name)
        if not routing:
            raise ValueError(f"Unknown tool: {tool_name}")

        routing_target = routing.get("routing_target", "")
        tool_id = routing.get("tool_id", "")

        # Route to appropriate handler
        if routing_target.startswith("POST "):
            # Direct Python API call
            result = await self._call_python_api(routing_target, arguments)
        else:
            # Route through MCP intake → orchestrator
            result = await self._call_mcp_intake(tool_id, arguments)

        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(result, default=str, ensure_ascii=False),
                }
            ],
            "isError": result.get("_error", False),
        }

    async def _handle_resources_list(self, params: dict) -> dict:
        """List available MCP resources (datasets, tasks)."""
        return {
            "resources": [
                {
                    "uri": "di://datasets",
                    "name": "Available Datasets",
                    "description": "List of dataset profiles available for analysis",
                    "mimeType": "application/json",
                },
                {
                    "uri": "di://workers",
                    "name": "Digital Workers",
                    "description": "Active AI digital workers and their status",
                    "mimeType": "application/json",
                },
            ]
        }

    async def _handle_resources_read(self, params: dict) -> dict:
        """Read a specific resource by URI."""
        uri = params.get("uri", "")

        if uri == "di://datasets":
            data = await self._fetch_resource("/api/datasets")
        elif uri.startswith("di://tasks/"):
            task_id = uri.replace("di://tasks/", "")
            data = await self._fetch_resource(f"/api/tasks/{task_id}")
        elif uri.startswith("di://artifacts/"):
            artifact_id = uri.replace("di://artifacts/", "")
            data = await self._fetch_resource(f"/api/artifacts/{artifact_id}")
        elif uri == "di://workers":
            data = await self._fetch_resource("/api/workers")
        else:
            raise ValueError(f"Unknown resource URI: {uri}")

        return {
            "contents": [
                {
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": json.dumps(data, default=str, ensure_ascii=False),
                }
            ]
        }

    # ── Notification handlers ─────────────────────────────────────────────

    def _handle_notification(self, method: str, params: dict):
        """Handle MCP notifications (no response expected)."""
        if method == "notifications/cancelled":
            logger.info("Tool call cancelled: %s", params.get("requestId"))
        elif method == "notifications/progress":
            logger.debug("Progress: %s", params)
        else:
            logger.debug("Unhandled notification: %s", method)

    # ── Internal routing ──────────────────────────────────────────────────

    async def _call_python_api(self, routing_target: str, arguments: dict) -> dict:
        """
        Call a Python FastAPI endpoint directly.
        routing_target format: 'POST /demand-forecast'
        """
        parts = routing_target.split(" ", 1)
        method = parts[0].upper()
        path = parts[1] if len(parts) > 1 else parts[0]

        try:
            if method == "POST":
                response = await self._client.post(path, json=arguments)
            elif method == "GET":
                response = await self._client.get(path, params=arguments)
            else:
                return {"_error": True, "message": f"Unsupported method: {method}"}

            response.raise_for_status()
            return response.json()

        except httpx.HTTPStatusError as e:
            logger.error("API error %s %s: %s", method, path, e.response.status_code)
            return {
                "_error": True,
                "message": f"API returned {e.response.status_code}",
                "detail": e.response.text[:500],
            }
        except httpx.RequestError as e:
            logger.error("Request error %s %s: %s", method, path, e)
            return {
                "_error": True,
                "message": f"Connection error: {str(e)}",
            }

    async def _call_mcp_intake(self, tool_id: str, arguments: dict) -> dict:
        """
        Route a tool call through the MCP intake endpoint → DI orchestrator.
        For multi-step tools that need the full task pipeline.
        """
        payload = {
            "tool_id": tool_id,
            "arguments": arguments,
            "source": "openclaw",
            "agent_role": DI_AGENT_ROLE or "general",
        }

        try:
            response = await self._client.post("/api/mcp-intake", json=payload)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            return {
                "_error": True,
                "message": f"Intake error: {e.response.status_code}",
                "detail": e.response.text[:500],
            }
        except httpx.RequestError as e:
            return {
                "_error": True,
                "message": f"Connection error: {str(e)}",
            }

    async def _fetch_resource(self, path: str) -> dict:
        """Fetch a resource from the DI API."""
        try:
            response = await self._client.get(path)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            return {"_error": True, "message": str(e)}

    async def close(self):
        """Cleanup resources."""
        await self._client.aclose()


# ── CLI Entry Point ───────────────────────────────────────────────────────────


async def main():
    import argparse

    parser = argparse.ArgumentParser(description="DI MCP Server for OpenClaw")
    parser.add_argument(
        "--transport",
        choices=["stdio", "http"],
        default="stdio",
        help="Transport mode (default: stdio)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=3100,
        help="HTTP port (only for http transport, default: 3100)",
    )
    args = parser.parse_args()

    # Configure logging
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        stream=sys.stderr,  # Log to stderr so stdout is clean for JSON-RPC
    )

    server = DIMCPServer()

    if args.transport == "stdio":
        transport = StdioTransport(server.handle)
        try:
            await transport.run()
        finally:
            await server.close()

    elif args.transport == "http":
        import uvicorn
        from fastapi import FastAPI

        app = FastAPI(title="DI MCP Server", version=SERVER_VERSION)
        router = create_http_router(server.handle)
        app.include_router(router)

        config = uvicorn.Config(app, host="0.0.0.0", port=args.port)
        http_server = uvicorn.Server(config)
        try:
            await http_server.serve()
        finally:
            await server.close()


if __name__ == "__main__":
    asyncio.run(main())
