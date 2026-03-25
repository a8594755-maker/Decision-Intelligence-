/**
 * openclawIntakeAdapter.js — Adapter for OpenClaw/MCP intake into DI task pipeline
 *
 * Translates MCP tool call requests from the MCP server into DI work orders,
 * and formats DI artifacts back into MCP-compatible response content blocks.
 *
 * This follows the same pattern as emailIntakeEndpoint.js:
 *   external channel → normalize → work order → orchestrator
 */

import { INTAKE_SOURCES } from './taskIntakeService.js';
import { getBuiltinTool } from '../ai-infra/builtinToolCatalog.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const OPENCLAW_SOURCE = 'openclaw';

// Channel type mapping
const CHANNEL_TYPES = {
  slack: 'slack',
  discord: 'discord',
  telegram: 'telegram',
  whatsapp: 'whatsapp',
  signal: 'signal',
  web: 'web',
};

// ── Normalize MCP request → Work Order ───────────────────────────────────────

/**
 * Convert an MCP intake request into a DI-native work order.
 *
 * @param {object} mcpRequest - MCP intake request from Python mcp_intake_router
 * @param {string} mcpRequest.tool_id - DI builtin tool ID
 * @param {object} mcpRequest.arguments - Tool arguments
 * @param {string} mcpRequest.source - 'openclaw'
 * @param {string} mcpRequest.agent_role - forecast/procurement/risk
 * @param {object} [mcpRequest.channel_context] - Channel metadata
 * @returns {object} Normalized work order for taskIntakeService
 */
export function normalizeOpenClawMessage(mcpRequest) {
  const {
    tool_id,
    arguments: args = {},
    agent_role = 'general',
    channel_context = {},
  } = mcpRequest;

  const tool = getBuiltinTool(tool_id);
  const toolName = tool?.name || tool_id.replace(/_/g, ' ');

  // Build a human-readable message from the tool call
  const argSummary = Object.entries(args)
    .slice(0, 5)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 50) : v}`)
    .join(', ');

  return {
    source: OPENCLAW_SOURCE,
    message: `[${agent_role}] Run ${toolName}${argSummary ? ` with ${argSummary}` : ''}`,
    priority: _inferPriority(args),
    intent: tool_id,
    metadata: {
      tool_id,
      arguments: args,
      agent_role,
      channel: channel_context,
      builtin_tool_id: tool_id,
    },
  };
}

/**
 * Build a full DecisionWorkOrder from an MCP tool call.
 *
 * @param {string} toolName - MCP tool name (e.g. 'di_run_forecast')
 * @param {object} args - Tool arguments
 * @param {object} channelContext - Channel metadata (type, channel_id, user_id, etc.)
 * @returns {object} DecisionWorkOrder-compatible object
 */
export function buildWorkOrderFromMCPCall(toolName, args, channelContext = {}) {
  // Strip 'di_' prefix to get the DI tool ID
  const toolId = toolName.startsWith('di_') ? toolName.slice(3) : toolName;
  const tool = getBuiltinTool(toolId);

  return {
    source: OPENCLAW_SOURCE,
    title: tool?.name || toolId.replace(/_/g, ' '),
    description: tool?.description || `Execute ${toolId}`,
    priority: _inferPriority(args),
    intent: toolId,
    requested_by: channelContext.user_display_name || channelContext.user_id || 'openclaw-user',
    channel: {
      type: channelContext.type || 'unknown',
      id: channelContext.channel_id,
      user_id: channelContext.user_id,
      agent_role: channelContext.agent_role || 'general',
    },
    parameters: args,
    builtin_tool_id: toolId,
    required_datasets: tool?.required_datasets || [],
    depends_on: tool?.depends_on || [],
  };
}

// ── Format DI artifacts → MCP response ───────────────────────────────────────

/**
 * Convert DI task result artifacts into MCP-compatible content blocks.
 *
 * @param {object} taskResult - DI task result with artifacts
 * @param {object} taskResult.artifacts - Map of artifact_type → artifact data
 * @param {string} taskResult.status - Task status
 * @returns {object} MCP tools/call response format
 */
export function formatMCPResponse(taskResult) {
  const { artifacts = {}, status = 'completed' } = taskResult;
  const content = [];

  // Add status summary
  content.push({
    type: 'text',
    text: `Task ${status}. ${Object.keys(artifacts).length} artifact(s) produced.`,
  });

  // Convert each artifact type to appropriate MCP content
  for (const [type, data] of Object.entries(artifacts)) {
    const formatted = _formatArtifact(type, data);
    if (formatted) {
      content.push(formatted);
    }
  }

  return {
    content,
    isError: status === 'FAILED',
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Format a single DI artifact as MCP content block.
 */
function _formatArtifact(type, data) {
  // Text-based artifacts
  const textTypes = [
    'forecast_series', 'plan_table', 'risk_scores', 'solver_meta',
    'constraint_check', 'replay_metrics', 'inventory_projection',
    'negotiation_report', 'causal_graph', 'scenario_comparison',
    'risk_adjustments', 'risk_plan_table', 'plan_comparison',
    'daily_summary', 'proactive_alerts', 'supplier_kpi_summary',
    'simulation_results', 'analysis_result', 'war_room_session',
  ];

  if (textTypes.includes(type)) {
    return {
      type: 'text',
      text: `## ${_artifactTitle(type)}\n\n${_summarizeArtifact(type, data)}`,
    };
  }

  // Binary/downloadable artifacts → resource reference
  const binaryTypes = ['forecast_csv', 'plan_csv', 'risk_plan_csv', 'excel_workbook', 'report_html'];
  if (binaryTypes.includes(type)) {
    return {
      type: 'resource',
      resource: {
        uri: `di://artifacts/${data?.id || type}`,
        mimeType: type.includes('csv') ? 'text/csv' : 'application/octet-stream',
        text: `📎 ${_artifactTitle(type)} available for download`,
      },
    };
  }

  // Fallback: JSON dump
  return {
    type: 'text',
    text: `## ${_artifactTitle(type)}\n\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 2000)}\n\`\`\``,
  };
}

/**
 * Create a concise summary of an artifact for chat display.
 */
function _summarizeArtifact(type, data) {
  if (!data) return '(no data)';

  if (type === 'forecast_series' && Array.isArray(data)) {
    return `${data.length} forecast rows. First: ${JSON.stringify(data[0]).slice(0, 200)}`;
  }
  if (type === 'plan_table' && Array.isArray(data)) {
    const total = data.reduce((sum, r) => sum + (r.order_qty || 0), 0);
    return `${data.length} order lines, total qty: ${total.toLocaleString()}`;
  }
  if (type === 'risk_scores' && Array.isArray(data)) {
    const high = data.filter(r => (r.risk_score || 0) > 0.7).length;
    return `${data.length} items scored, ${high} high-risk (>0.7)`;
  }
  if (type === 'solver_meta' && typeof data === 'object') {
    return `Status: ${data.status || 'unknown'}, Cost: ${data.total_cost?.toLocaleString() || 'N/A'}`;
  }
  if (type === 'scenario_comparison' && typeof data === 'object') {
    const scenarios = data.scenarios || data.results || [];
    return `${Array.isArray(scenarios) ? scenarios.length : 0} scenarios compared`;
  }

  // Generic: JSON preview
  const json = JSON.stringify(data);
  return json.length > 500 ? json.slice(0, 500) + '...' : json;
}

function _artifactTitle(type) {
  return type
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function _inferPriority(args) {
  const text = JSON.stringify(args).toLowerCase();
  if (/urgent|critical|asap|emergency|緊急/.test(text)) return 'critical';
  if (/important|priority|重要/.test(text)) return 'high';
  return 'medium';
}
