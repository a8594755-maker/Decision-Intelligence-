"""
MCP Intake Router — FastAPI endpoint that bridges MCP tool calls into the
DI orchestrator pipeline via task creation.

This endpoint receives work orders from the MCP server (for tools that need
multi-step orchestration) and returns task_id for progress tracking.
"""

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["MCP Intake"])

# ── Request / Response models ─────────────────────────────────────────────────


class MCPIntakeRequest(BaseModel):
    """Work order from MCP server → DI orchestrator."""
    tool_id: str = Field(..., description="DI builtin tool ID (e.g. 'run_forecast')")
    arguments: dict[str, Any] = Field(default_factory=dict, description="Tool arguments from MCP call")
    source: str = Field(default="openclaw", description="Intake source identifier")
    agent_role: str = Field(default="general", description="OpenClaw agent role (forecast/procurement/risk)")

    # Optional context from OpenClaw channel
    channel_type: Optional[str] = Field(None, description="slack/discord/telegram/whatsapp")
    channel_id: Optional[str] = Field(None, description="Channel or conversation ID")
    user_id: Optional[str] = Field(None, description="External user ID from channel")
    user_display_name: Optional[str] = Field(None, description="User display name")
    correlation_id: Optional[str] = Field(None, description="For request tracing")


class MCPIntakeResponse(BaseModel):
    """Response after work order acceptance."""
    status: str  # 'accepted' | 'queued' | 'error'
    task_id: Optional[str] = None
    message: str = ""
    tool_id: str = ""
    estimated_steps: int = 0


# ── Endpoint ──────────────────────────────────────────────────────────────────


@router.post("/mcp-intake", response_model=MCPIntakeResponse)
async def mcp_intake(request: Request, body: MCPIntakeRequest):
    """
    Accept a work order from the MCP server and queue it for orchestration.

    This is the bridge between OpenClaw MCP tool calls and the DI task pipeline.
    For simple tools (direct API calls), the MCP server calls endpoints directly.
    For complex multi-step tools, it routes here.
    """
    correlation_id = body.correlation_id or str(uuid.uuid4())
    logger.info(
        "MCP intake: tool=%s role=%s channel=%s corr=%s",
        body.tool_id,
        body.agent_role,
        body.channel_type,
        correlation_id,
    )

    try:
        # Build a work order in the DI-native format
        work_order = {
            "id": correlation_id,
            "source": "openclaw",
            "tool_id": body.tool_id,
            "arguments": body.arguments,
            "priority": "medium",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "channel_context": {
                "type": body.channel_type,
                "channel_id": body.channel_id,
                "user_id": body.user_id,
                "user_display_name": body.user_display_name,
                "agent_role": body.agent_role,
            },
        }

        # Derive a human-readable title from the tool_id
        title = _tool_id_to_title(body.tool_id)
        work_order["title"] = title

        # Derive message for the intake service
        work_order["message"] = (
            f"[OpenClaw/{body.agent_role}] {title}: "
            + ", ".join(f"{k}={v}" for k, v in list(body.arguments.items())[:5])
        )

        # Store the work order for the JS-side to pick up via polling
        # In production, this would go to Supabase or Redis.
        # For now, store in-memory and expose via /api/mcp-intake/pending
        _pending_orders[correlation_id] = work_order

        return MCPIntakeResponse(
            status="accepted",
            task_id=correlation_id,
            message=f"Work order accepted: {title}",
            tool_id=body.tool_id,
            estimated_steps=_estimate_steps(body.tool_id),
        )

    except Exception as e:
        logger.exception("MCP intake error for tool=%s", body.tool_id)
        return MCPIntakeResponse(
            status="error",
            message=f"Intake error: {str(e)}",
            tool_id=body.tool_id,
        )


# ── Pending orders store (in-memory; production → Supabase) ──────────────────

_pending_orders: dict[str, dict] = {}


@router.get("/mcp-intake/pending")
async def list_pending_orders():
    """List pending MCP intake orders (for JS-side orchestrator to poll)."""
    orders = list(_pending_orders.values())
    return {"count": len(orders), "orders": orders}


@router.post("/mcp-intake/{order_id}/complete")
async def complete_order(order_id: str, request: Request):
    """Mark an MCP intake order as completed (called by JS orchestrator)."""
    body = await request.json()
    if order_id in _pending_orders:
        del _pending_orders[order_id]
    return {"status": "completed", "order_id": order_id, "result": body}


@router.get("/mcp-intake/{order_id}/status")
async def order_status(order_id: str):
    """Check status of an MCP intake order."""
    if order_id in _pending_orders:
        return {"status": "pending", "order": _pending_orders[order_id]}
    return {"status": "completed_or_unknown", "order_id": order_id}


# ── Helpers ───────────────────────────────────────────────────────────────────

_TOOL_TITLES = {
    "run_forecast": "Demand Forecast",
    "run_plan": "Replenishment Plan",
    "run_risk_analysis": "Supplier Risk Analysis",
    "run_risk_aware_plan": "Risk-Aware Plan",
    "run_scenario": "What-If Scenario",
    "run_batch_scenarios": "Batch Scenario Comparison",
    "run_negotiation": "Agentic Negotiation",
    "run_bom_explosion": "BOM Explosion",
    "run_cost_forecast": "Cost Forecast",
    "run_closed_loop": "Closed-Loop Re-Plan",
    "run_war_room": "War Room Analysis",
    "fetch_external_signals": "Macro-Oracle Signals",
    "run_digital_twin_simulation": "Digital Twin Simulation",
}

_STEP_ESTIMATES = {
    "run_forecast": 2,
    "run_plan": 3,
    "run_risk_analysis": 2,
    "run_risk_aware_plan": 4,
    "run_scenario": 2,
    "run_negotiation": 4,
    "run_bom_explosion": 3,
    "run_war_room": 5,
}


def _tool_id_to_title(tool_id: str) -> str:
    return _TOOL_TITLES.get(tool_id, tool_id.replace("_", " ").title())


def _estimate_steps(tool_id: str) -> int:
    return _STEP_ESTIMATES.get(tool_id, 2)
