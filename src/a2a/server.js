// @product: a2a-server
//
// server.js
// A2A protocol server. Mounts each DI worker template as an A2A agent.
// Provides agent discovery via Agent Cards and task execution via JSON-RPC.

import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { A2AExpressApp } from '@a2a-js/sdk/server/express';
import { buildAgentCard, buildAllAgentCards, getTemplateIds } from './agentCardBuilder.js';
import { DiAgentExecutor } from './diAgentExecutor.js';

/**
 * Mount A2A routes for all worker templates on an Express app.
 *
 * Route structure:
 *   GET  /a2a/agents                              → list all agent cards
 *   GET  /a2a/:templateId/.well-known/agent-card.json → specific agent card
 *   POST /a2a/:templateId                          → JSON-RPC task operations
 *   GET  /.well-known/agent-card.json              → default agent card
 *
 * @param {import('express').Express} app
 * @param {string} baseUrl - Base URL (e.g. 'http://localhost:3100')
 * @param {{ defaultEmployeeId?: string }} [options]
 */
export function mountA2ARoutes(app, baseUrl, options = {}) {
  const templateIds = getTemplateIds();
  const agents = new Map(); // templateId → { handler, a2aApp }

  for (const templateId of templateIds) {
    const agentCard = buildAgentCard(templateId, baseUrl);
    if (!agentCard) continue;

    const executor = new DiAgentExecutor(templateId, {
      employeeId: options.defaultEmployeeId || null,
    });

    const taskStore = new InMemoryTaskStore();
    const handler = new DefaultRequestHandler(agentCard, taskStore, executor);
    const a2aApp = new A2AExpressApp(handler);

    // Mount agent-specific routes
    a2aApp.setupRoutes(app, `/a2a/${templateId}`);
    agents.set(templateId, { handler, a2aApp, agentCard });

    console.error(`[DI-A2A] Registered agent: ${agentCard.name} at /a2a/${templateId}`);
  }

  // Agent directory endpoint — list all agent cards
  app.get('/a2a/agents', (_req, res) => {
    const cards = buildAllAgentCards(baseUrl);
    res.json({
      agents: cards,
      count: cards.length,
      protocol: 'A2A v0.3.0',
    });
  });

  // Default agent card at well-known URL (supply_chain_analyst as default)
  const defaultCard = buildAgentCard('supply_chain_analyst', baseUrl);
  if (defaultCard) {
    app.get('/.well-known/agent-card.json', (_req, res) => {
      res.json(defaultCard);
    });
  }

  console.error(`[DI-A2A] ${agents.size} A2A agents mounted`);
  console.error(`[DI-A2A] Agent directory: GET ${baseUrl}/a2a/agents`);

  return agents;
}
