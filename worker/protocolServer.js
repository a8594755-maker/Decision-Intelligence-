#!/usr/bin/env node
// @product: protocol-server
//
// protocolServer.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared HTTP server exposing both MCP and A2A protocols.
//
// MCP: POST/GET/DELETE /mcp        (Streamable HTTP transport)
// A2A: GET /a2a/agents             (Agent directory)
//      GET /a2a/:id/.well-known/agent-card.json
//      POST /a2a/:id               (JSON-RPC task operations)
//
// Usage:
//   npx vite-node worker/protocolServer.js
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../src/mcp/server.js';
import { mountA2ARoutes } from '../src/a2a/server.js';

const PORT = parseInt(process.env.DI_PROTOCOL_PORT || '3100', 10);
const BASE_URL = process.env.DI_PROTOCOL_BASE_URL || `http://localhost:${PORT}`;

const app = express();
app.use(express.json());

// ── MCP over Streamable HTTP ────────────────────────────────────────────────

const { server: mcpServer, toolCount } = createMcpServer();
const mcpSessions = new Map();

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  let transport;

  if (sessionId && mcpSessions.has(sessionId)) {
    transport = mcpSessions.get(sessionId);
  } else {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
    await mcpServer.connect(transport);
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) mcpSessions.delete(sid);
    };
    if (transport.sessionId) {
      mcpSessions.set(transport.sessionId, transport);
    }
  }

  await transport.handleRequest(req, res);
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = sessionId ? mcpSessions.get(sessionId) : null;
  if (!transport) {
    res.status(400).json({ error: 'No active session. Send a POST first.' });
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = sessionId ? mcpSessions.get(sessionId) : null;
  if (transport) {
    await transport.handleRequest(req, res);
    mcpSessions.delete(sessionId);
  } else {
    res.status(200).end();
  }
});

// ── A2A Agents ──────────────────────────────────────────────────────────────

const a2aAgents = mountA2ARoutes(app, BASE_URL);

// ── Health ──────────────────────────────────────────────────────────────────

app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    protocols: {
      mcp: { tools: toolCount, endpoint: '/mcp' },
      a2a: { agents: a2aAgents.size, endpoint: '/a2a/agents' },
    },
    uptime: process.uptime(),
  });
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.error(`[ProtocolServer] Listening on port ${PORT}`);
  console.error(`[ProtocolServer] MCP: POST ${BASE_URL}/mcp (${toolCount} tools)`);
  console.error(`[ProtocolServer] A2A: GET ${BASE_URL}/a2a/agents (${a2aAgents.size} agents)`);
  console.error(`[ProtocolServer] Health: GET ${BASE_URL}/healthz`);
});
