// @product: mcp-server
//
// resourceProvider.js
// ─────────────────────────────────────────────────────────────────────────────
// MCP Resources: expose datasets, artifacts, and catalog metadata.
// Resources let AI clients browse available data before calling tools.
// ─────────────────────────────────────────────────────────────────────────────

import { BUILTIN_TOOLS, TOOL_CATEGORY } from '../services/ai-infra/builtinToolCatalog.js';

// ── Static resources ───────────────────────────────────────────────────────

export function listResources() {
  return [
    {
      uri: 'di://catalog/tools',
      name: 'Tool Catalog',
      description: 'Complete list of 60+ supply chain AI tools with descriptions, categories, and dependencies.',
      mimeType: 'application/json',
    },
    {
      uri: 'di://catalog/categories',
      name: 'Tool Categories',
      description: 'Available tool categories: core_planning, risk, scenario, negotiation, cost_revenue, bom, analytics, governance, data_access, monitoring.',
      mimeType: 'application/json',
    },
    {
      uri: 'di://catalog/dependency-graph',
      name: 'Tool Dependency Graph',
      description: 'Shows which tools depend on which other tools. Useful for planning multi-step analyses.',
      mimeType: 'application/json',
    },
  ];
}

export function listResourceTemplates() {
  return [
    {
      uriTemplate: 'di://catalog/tools/{category}',
      name: 'Tools by Category',
      description: 'List tools filtered by category (e.g., core_planning, risk, negotiation).',
      mimeType: 'application/json',
    },
  ];
}

export function readResource(uri) {
  if (uri === 'di://catalog/tools') {
    const summary = BUILTIN_TOOLS.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      depends_on: t.depends_on,
      output_artifacts: t.output_artifacts,
    }));
    return [{ uri, mimeType: 'application/json', text: JSON.stringify(summary, null, 2) }];
  }

  if (uri === 'di://catalog/categories') {
    const cats = Object.values(TOOL_CATEGORY).map(cat => ({
      category: cat,
      tools: BUILTIN_TOOLS.filter(t => t.category === cat).map(t => t.id),
    }));
    return [{ uri, mimeType: 'application/json', text: JSON.stringify(cats, null, 2) }];
  }

  if (uri === 'di://catalog/dependency-graph') {
    const graph = {};
    for (const t of BUILTIN_TOOLS) {
      if (t.depends_on.length > 0) {
        graph[t.id] = t.depends_on;
      }
    }
    return [{ uri, mimeType: 'application/json', text: JSON.stringify(graph, null, 2) }];
  }

  // Template: di://catalog/tools/{category}
  const catMatch = uri.match(/^di:\/\/catalog\/tools\/(.+)$/);
  if (catMatch) {
    const category = catMatch[1];
    const tools = BUILTIN_TOOLS.filter(t => t.category === category).map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      depends_on: t.depends_on,
    }));
    return [{ uri, mimeType: 'application/json', text: JSON.stringify(tools, null, 2) }];
  }

  throw new Error(`Unknown resource: ${uri}`);
}

export default { listResources, listResourceTemplates, readResource };
