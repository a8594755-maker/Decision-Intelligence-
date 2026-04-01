// @product: a2a-server
//
// agentCardBuilder.js
// Generates A2A Agent Cards from DI worker templates and capability model.

import { WORKER_TEMPLATES, CAPABILITY_POLICIES, CAPABILITY_CLASS } from '../services/ai-infra/capabilityModelService.js';
import { BUILTIN_TOOLS, TOOL_CATEGORY } from '../services/ai-infra/builtinToolCatalog.js';

// Map capability class → tool categories that belong to it
const CLASS_TO_CATEGORIES = {
  [CAPABILITY_CLASS.PLANNING]:         [TOOL_CATEGORY.CORE_PLANNING, TOOL_CATEGORY.RISK, TOOL_CATEGORY.BOM],
  [CAPABILITY_CLASS.ANALYSIS]:         [TOOL_CATEGORY.SCENARIO, TOOL_CATEGORY.COST_REVENUE, TOOL_CATEGORY.UTILITY, TOOL_CATEGORY.ANALYTICS, TOOL_CATEGORY.DATA_ACCESS],
  [CAPABILITY_CLASS.REPORTING]:        [],
  [CAPABILITY_CLASS.SYNTHESIS]:        [],
  [CAPABILITY_CLASS.INTEGRATION]:      [],
  [CAPABILITY_CLASS.CUSTOM_CODE]:      [],
  [CAPABILITY_CLASS.NEGOTIATION]:      [TOOL_CATEGORY.NEGOTIATION],
  [CAPABILITY_CLASS.MONITORING]:       [TOOL_CATEGORY.GOVERNANCE, TOOL_CATEGORY.MONITORING],
  [CAPABILITY_CLASS.DATA_PREPARATION]: [TOOL_CATEGORY.DATA_PREPARATION],
};

/**
 * Get all builtin tools accessible to a worker template.
 *
 * @param {object} template - Worker template
 * @returns {Array<object>} Matching builtin tools
 */
function getToolsForTemplate(template) {
  const allowedCategories = new Set();
  for (const capClass of template.allowed_capabilities) {
    const cats = CLASS_TO_CATEGORIES[capClass] || [];
    for (const cat of cats) allowedCategories.add(cat);
  }
  return BUILTIN_TOOLS.filter(t => allowedCategories.has(t.category));
}

/**
 * Build A2A skills array from tools accessible to a template.
 *
 * @param {object} template - Worker template
 * @returns {Array<object>} A2A skills
 */
function buildSkills(template) {
  const tools = getToolsForTemplate(template);
  return tools.map(tool => ({
    id: tool.id,
    name: tool.name,
    description: tool.description,
    tags: tool.keywords_en,
    inputModes: ['text/plain', 'application/json'],
    outputModes: ['text/plain', 'application/json'],
  }));
}

/**
 * Build an A2A Agent Card for a single worker template.
 *
 * @param {string} templateId - Worker template ID
 * @param {string} baseUrl - Base URL for the A2A server (e.g. 'http://localhost:3100')
 * @returns {object|null} A2A Agent Card or null if template not found
 */
export function buildAgentCard(templateId, baseUrl) {
  const template = WORKER_TEMPLATES[templateId];
  if (!template) return null;

  return {
    name: `DI ${template.name}`,
    description: template.description,
    version: '0.1.0',
    url: `${baseUrl}/a2a/${templateId}`,
    protocolVersion: '0.3.0',
    provider: {
      organization: 'Decision-Intelligence Platform',
    },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    skills: buildSkills(template),
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer' },
      apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
    },
    security: [{ bearer: [] }, { apiKey: [] }],
  };
}

/**
 * Build Agent Cards for all worker templates.
 *
 * @param {string} baseUrl
 * @returns {Array<object>} Array of Agent Cards
 */
export function buildAllAgentCards(baseUrl) {
  return Object.keys(WORKER_TEMPLATES).map(id => buildAgentCard(id, baseUrl));
}

/**
 * Get all worker template IDs.
 * @returns {string[]}
 */
export function getTemplateIds() {
  return Object.keys(WORKER_TEMPLATES);
}
