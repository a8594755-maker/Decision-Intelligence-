#!/usr/bin/env node
// @product: mcp-server
//
// server.js
// ─────────────────────────────────────────────────────────────────────────────
// Decision-Intelligence MCP Server
//
// Exposes 60+ supply chain AI tools via Model Context Protocol.
// Connects to Claude Desktop, ChatGPT, Cursor, VS Code, and any MCP client.
//
// Usage:
//   node src/mcp/server.js                         # stdio transport (Claude Desktop)
//   DI_MCP_TRANSPORT=http node src/mcp/server.js   # HTTP transport (port 3100)
//   DI_MCP_API_KEY=xxx node src/mcp/server.js      # with auth
// ─────────────────────────────────────────────────────────────────────────────

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { catalogToMcpTools, getToolMeta } from './toolBridge.js';
import { listResources, readResource } from './resourceProvider.js';
import { authenticateRequest, canAccessTool } from './auth.js';
import { BUILTIN_TOOLS, TOOL_CATEGORY } from '../services/ai-infra/builtinToolCatalog.js';
import { getToolAnnotations } from './toolAnnotations.js';
import { buildZodSchema } from './zodSchemaBuilder.js';
import { isArtifactUri, listRecentArtifacts } from './artifactResourceProvider.js';

const SERVER_NAME = 'decision-intelligence';
const SERVER_VERSION = '0.2.0';

// ── Python ML API base URL ─────────────────────────────────────────────────
const ML_API_BASE = process.env.VITE_ML_API_URL || process.env.DI_ML_API_URL || 'http://localhost:8000';

// ── Create MCP Server ──────────────────────────────────────────────────────

export function createMcpServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        resources: {},
        tools: {},
        prompts: {},
      },
      instructions: `Decision-Intelligence: Supply Chain AI Engine.

This MCP server provides 60+ deterministic supply chain tools:
- Demand forecasting (Prophet, LightGBM, Chronos, XGBoost, ETS)
- Replenishment planning (MIP solver, heuristic)
- Supplier risk analysis and risk-aware planning
- CFR game-theory negotiation engine
- What-if scenario simulation and Monte Carlo digital twins
- BOM explosion and multi-echelon planning
- Cost/revenue forecasting and P&L impact
- 5-Whys causal root cause analysis
- Supplier KPI scoring and ranking
- Governance workflows (approval, audit, commit)
- Live ERP data queries (SAP, Oracle compatible)
- External signal monitoring (GDELT geopolitical events)

All tools produce deterministic, auditable results.
Start with 'run_forecast' for demand prediction, then 'run_plan' for optimization.
Use 'run_risk_analysis' to assess supply risk before planning.

Browse available tools: read the 'di://catalog/tools' resource.
Browse recent artifacts: read the 'di://artifacts/recent' resource.`,
    },
  );

  // ── Register Resources ─────────────────────────────────────────────────

  server.resource(
    'Tool Catalog',
    'di://catalog/tools',
    { description: 'Complete list of 60+ supply chain AI tools', mimeType: 'application/json' },
    async () => readResource('di://catalog/tools'),
  );

  server.resource(
    'Tool Categories',
    'di://catalog/categories',
    { description: 'Tool categories and their tools', mimeType: 'application/json' },
    async () => readResource('di://catalog/categories'),
  );

  server.resource(
    'Dependency Graph',
    'di://catalog/dependency-graph',
    { description: 'Tool dependency graph for multi-step analysis', mimeType: 'application/json' },
    async () => readResource('di://catalog/dependency-graph'),
  );

  server.resource(
    'Tools by Category',
    new ResourceTemplate('di://catalog/tools/{category}', { list: undefined }),
    { description: 'Filter tools by category', mimeType: 'application/json' },
    async (uri, { category }) => readResource(`di://catalog/tools/${category}`),
  );

  server.resource(
    'Recent Artifacts',
    'di://artifacts/recent',
    { description: 'Browse the 20 most recent analysis artifacts', mimeType: 'application/json' },
    async () => readResource('di://artifacts/recent'),
  );

  server.resource(
    'Run Artifacts',
    new ResourceTemplate('di://artifacts/{run_id}', { list: undefined }),
    { description: 'List all artifacts for a specific run', mimeType: 'application/json' },
    async (uri, { run_id }) => readResource(`di://artifacts/${run_id}`),
  );

  server.resource(
    'Artifact Detail',
    new ResourceTemplate('di://artifacts/{run_id}/{artifact_type}', { list: undefined }),
    { description: 'Read a specific artifact by run ID and type', mimeType: 'application/json' },
    async (uri, { run_id, artifact_type }) => readResource(`di://artifacts/${run_id}/${artifact_type}`),
  );

  // ── Register Prompts ───────────────────────────────────────────────────

  server.prompt(
    'analyze-supply-risk',
    'Analyze supply chain risks for a material or supplier. Runs risk analysis, identifies high-risk items, and suggests mitigation.',
    async () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `You are a supply chain risk analyst using the Decision-Intelligence engine.

Steps:
1. First, use 'run_risk_analysis' to compute supplier risk scores
2. Review the risk scores — focus on items with risk_score > 70
3. For high-risk items, use 'run_risk_adjustments' to get solver parameter adjustments
4. Use 'run_stockout_causal_graph' if any items have stockout risk
5. Summarize findings: which suppliers/materials are at risk, why, and recommended actions

Present results as a structured risk report with severity levels.`,
        },
      }],
    }),
  );

  server.prompt(
    'generate-replenishment-plan',
    'Generate an optimized replenishment plan. Runs forecast, optimization, and verification.',
    async () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `You are a supply planning worker using the Decision-Intelligence engine.

Steps:
1. Use 'run_forecast' to generate demand predictions with P10/P50/P90 quantiles
2. Use 'run_plan' to generate an optimized replenishment plan
3. Review the plan_table and solver_meta artifacts
4. Use 'run_plan_comparison' if there's a previous baseline to compare against
5. Summarize the plan: total order quantity, estimated cost, fill rate, key SKUs

Present results with KPIs and highlight any items needing attention.`,
        },
      }],
    }),
  );

  server.prompt(
    'negotiate-supplier-terms',
    'Run a supplier negotiation using CFR game theory. Generates options, evaluates strategies, and recommends best terms.',
    async () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `You are a procurement negotiation specialist using the Decision-Intelligence CFR engine.

Steps:
1. Ensure a plan exists (run 'run_plan' if needed)
2. Use 'run_negotiation' to run the full CFR negotiation loop
3. Review negotiation_options and negotiation_evaluation artifacts
4. Analyze the CFR strategy: which position (DESPERATE/AGGRESSIVE/DEFENSIVE)?
5. Review cfr_param_adjustment for solver parameter recommendations
6. Summarize: recommended terms, trade-offs, confidence level, and next steps

Present as a negotiation brief with recommended opening position and fallback.`,
        },
      }],
    }),
  );

  server.prompt(
    'full-planning-cycle',
    'Run a complete planning cycle: forecast → plan → risk → verify → compare. End-to-end supply chain analysis.',
    async () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `You are a senior supply chain planner using the Decision-Intelligence engine.
Run a complete planning cycle:

1. 'run_forecast' — demand prediction
2. 'run_risk_analysis' — supplier risk assessment
3. 'run_risk_aware_plan' — risk-adjusted replenishment plan
4. Review solver_meta for constraint binding and feasibility
5. 'run_plan_comparison' — compare vs baseline if available
6. 'run_cost_forecast' — project procurement costs
7. Summarize everything as an executive brief:
   - Demand outlook (trend, seasonality, uncertainty)
   - Risk posture (high-risk suppliers, materials)
   - Plan KPIs (fill rate, total cost, safety stock levels)
   - Cost projection (vs budget)
   - Recommended actions and escalations`,
        },
      }],
    }),
  );

  server.prompt(
    'query-supply-chain-data',
    'Query and explore supply chain data — suppliers, materials, inventory, POs.',
    async () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `You are a data analyst exploring supply chain data using the Decision-Intelligence engine.

Available tools for data access:
- 'query_sap_data' — SQL queries on master data tables
- 'list_sap_tables' — discover available tables and schemas
- 'query_live_data' — browse ERP tables with filters and pagination
- 'get_supplier_kpi_summary' — supplier performance metrics
- 'get_supplier_rankings' — rank suppliers by composite score

Start by using 'list_sap_tables' to see what data is available, then query as needed.`,
        },
      }],
    }),
  );

  // ── Register Tools ─────────────────────────────────────────────────────
  // Dynamically register all 60+ catalog tools as MCP tools with Zod schemas and annotations.

  const mcpToolDefs = catalogToMcpTools();

  for (const toolDef of mcpToolDefs) {
    const meta = getToolMeta(toolDef.name);
    if (!meta) continue;

    const zodSchema = buildZodSchema(meta.input_schema);
    const annotations = getToolAnnotations(meta);

    server.registerTool(
      toolDef.name,
      {
        title: meta.name,
        description: toolDef.description,
        inputSchema: zodSchema,
        annotations,
      },
      async (args) => {
        try {
          return await executeTool(meta, args);
        } catch (err) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: err.message || String(err),
                tool: toolDef.name,
                hint: 'Check input parameters and ensure required dependencies have been run first.',
              }, null, 2),
            }],
            isError: true,
          };
        }
      },
    );
  }

  return { server, toolCount: mcpToolDefs.length };
}

// ── Tool Execution Engine ──────────────────────────────────────────────────

async function executeTool(meta, args) {
  if (meta.isPython) {
    return await executePythonTool(meta, args);
  }
  return await executeJsTool(meta, args);
}

async function executePythonTool(meta, args) {
  const methodParts = (meta.method || '').match(/^(POST|GET|PUT|DELETE)\s+(.+)$/i);
  if (!methodParts) {
    throw new Error(`Invalid Python API method format: '${meta.method}'`);
  }
  const [, httpMethod, apiPath] = methodParts;
  const url = `${ML_API_BASE}${apiPath}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 180_000);

  try {
    const resp = await fetch(url, {
      method: httpMethod,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => 'Unknown error');
      throw new Error(`Python API ${resp.status}: ${errText.slice(0, 500)}`);
    }

    const result = await resp.json();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          tool: meta.id,
          status: 'success',
          artifacts: result.artifacts || result.artifact_refs || [],
          data: result.data || result,
          metadata: {
            output_artifacts: meta.output_artifacts,
            depends_on: meta.depends_on,
          },
        }, null, 2),
      }],
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error(`Python API call timed out after 180s: ${url}`);
    }
    throw err;
  }
}

async function executeJsTool(meta, args) {
  const modulePath = meta.module.replace(/^\.\//, '');
  let mod;
  try {
    mod = await import(`../services/${modulePath}.js`);
  } catch (importErr) {
    try {
      mod = await import(`../services/${modulePath}`);
    } catch {
      throw new Error(`Cannot import module '${meta.module}': ${importErr.message}`);
    }
  }

  const fn = mod[meta.method] || mod.default?.[meta.method];
  if (typeof fn !== 'function') {
    throw new Error(`Method '${meta.method}' not found in module '${meta.module}'. Available: ${Object.keys(mod).filter(k => typeof mod[k] === 'function').join(', ')}`);
  }

  const result = await fn(args);

  const artifacts = result?.artifacts || result?.artifact_refs || [];
  const data = result?.data || result?.result || result;

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        tool: meta.id,
        status: result?.ok === false ? 'error' : 'success',
        ...(result?.error ? { error: result.error } : {}),
        artifacts: Array.isArray(artifacts) ? artifacts.map(a => ({
          type: a.type || a.artifact_type,
          label: a.label || a.name,
          ...(a.data ? { data: a.data } : {}),
          ...(a.summary ? { summary: a.summary } : {}),
        })) : [],
        data: typeof data === 'object' && !Array.isArray(data)
          ? sanitizeForJson(data)
          : data,
        metadata: {
          output_artifacts: meta.output_artifacts,
          depends_on: meta.depends_on,
          category: meta.category,
        },
      }, null, 2),
    }],
  };
}

function sanitizeForJson(obj, depth = 0) {
  if (depth > 5 || obj === null || obj === undefined) return obj;
  if (typeof obj === 'function') return undefined;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.slice(0, 100).map(item => sanitizeForJson(item, depth + 1));

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'function') continue;
    result[key] = sanitizeForJson(value, depth + 1);
  }
  return result;
}

// ── Start Server (stdio or HTTP) ──────────────────────────────────────────

async function main() {
  const transportMode = process.env.DI_MCP_TRANSPORT || 'stdio';
  const { server, toolCount } = createMcpServer();

  if (transportMode === 'http') {
    const port = parseInt(process.env.DI_MCP_PORT || '3100', 10);
    const { default: express } = await import('express');

    const app = express();
    // Session management for Streamable HTTP
    const sessions = new Map();

    app.post('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'];
      let transport;

      if (sessionId && sessions.has(sessionId)) {
        transport = sessions.get(sessionId);
      } else {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
        await server.connect(transport);
        // Store session after connection
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) sessions.delete(sid);
        };
        if (transport.sessionId) {
          sessions.set(transport.sessionId, transport);
        }
      }

      await transport.handleRequest(req, res);
    });

    app.get('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'];
      const transport = sessionId ? sessions.get(sessionId) : null;
      if (!transport) {
        res.status(400).json({ error: 'No active session. Send a POST first.' });
        return;
      }
      await transport.handleRequest(req, res);
    });

    app.delete('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'];
      const transport = sessionId ? sessions.get(sessionId) : null;
      if (transport) {
        await transport.handleRequest(req, res);
        sessions.delete(sessionId);
      } else {
        res.status(200).end();
      }
    });

    app.get('/healthz', (req, res) => res.json({ status: 'ok', tools: toolCount }));

    app.listen(port, () => {
      console.error(`[DI-MCP] HTTP transport on port ${port}`);
      console.error(`[DI-MCP] ${toolCount} supply chain tools registered`);
      console.error(`[DI-MCP] POST/GET/DELETE http://localhost:${port}/mcp`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[DI-MCP] Decision-Intelligence MCP Server v${SERVER_VERSION} started (stdio)`);
    console.error(`[DI-MCP] ${toolCount} supply chain tools registered`);
    console.error(`[DI-MCP] Python ML API: ${ML_API_BASE}`);
  }
}

main().catch(err => {
  console.error('[DI-MCP] Fatal error:', err);
  process.exit(1);
});
