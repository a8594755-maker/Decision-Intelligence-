/**
 * mcpResponseContract.js — Defines how DI artifacts translate to MCP content blocks.
 *
 * Used by openclawIntakeAdapter.js to format task results for OpenClaw display.
 * Each artifact type has a registered formatter that produces MCP-compatible content.
 */

// ── Artifact → MCP Content Type Mapping ──────────────────────────────────────

export const MCP_CONTENT_TYPES = {
  TEXT: 'text',
  RESOURCE: 'resource',
  IMAGE: 'image',
};

// ── Artifact formatters registry ─────────────────────────────────────────────

/**
 * @typedef {object} MCPContentBlock
 * @property {'text'|'resource'|'image'} type
 * @property {string} [text] - For text content
 * @property {object} [resource] - For resource references
 */

const FORMATTERS = {
  // ── Core Planning ────────────────────────────────────────────────────
  forecast_series: (data) => ({
    type: 'text',
    text: formatForecastSeries(data),
  }),

  plan_table: (data) => ({
    type: 'text',
    text: formatPlanTable(data),
  }),

  solver_meta: (data) => ({
    type: 'text',
    text: formatSolverMeta(data),
  }),

  inventory_projection: (data) => ({
    type: 'text',
    text: formatInventoryProjection(data),
  }),

  // ── Risk ─────────────────────────────────────────────────────────────
  risk_scores: (data) => ({
    type: 'text',
    text: formatRiskScores(data),
  }),

  risk_adjustments: (data) => ({
    type: 'text',
    text: formatAsTable('Risk Adjustments', data, ['material_code', 'adjustment_type', 'factor', 'reason']),
  }),

  // ── Scenario ─────────────────────────────────────────────────────────
  scenario_comparison: (data) => ({
    type: 'text',
    text: formatScenarioComparison(data),
  }),

  // ── Negotiation ──────────────────────────────────────────────────────
  negotiation_report: (data) => ({
    type: 'text',
    text: `## Negotiation Report\n\n${JSON.stringify(data, null, 2).slice(0, 3000)}`,
  }),

  // ── Binary / downloadable ────────────────────────────────────────────
  forecast_csv: (data) => ({
    type: 'resource',
    resource: { uri: `di://artifacts/${data?.id || 'forecast_csv'}`, mimeType: 'text/csv', text: 'Forecast CSV' },
  }),

  plan_csv: (data) => ({
    type: 'resource',
    resource: { uri: `di://artifacts/${data?.id || 'plan_csv'}`, mimeType: 'text/csv', text: 'Plan CSV' },
  }),

  report_html: (data) => ({
    type: 'resource',
    resource: { uri: `di://artifacts/${data?.id || 'report_html'}`, mimeType: 'text/html', text: 'HTML Report' },
  }),

  excel_workbook: (data) => ({
    type: 'resource',
    resource: { uri: `di://artifacts/${data?.id || 'excel'}`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', text: 'Excel Workbook' },
  }),
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Format a DI artifact into an MCP content block.
 *
 * @param {string} artifactType - DI artifact type (e.g. 'forecast_series')
 * @param {any} data - Artifact data
 * @returns {MCPContentBlock}
 */
export function formatArtifactForMCP(artifactType, data) {
  const formatter = FORMATTERS[artifactType];
  if (formatter) {
    return formatter(data);
  }
  // Fallback: JSON text block
  return {
    type: 'text',
    text: `## ${artifactType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}\n\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 2000)}\n\`\`\``,
  };
}

/**
 * Format all task artifacts into MCP content blocks.
 *
 * @param {object} artifacts - Map of artifact_type → data
 * @returns {MCPContentBlock[]}
 */
export function formatAllArtifactsForMCP(artifacts) {
  return Object.entries(artifacts || {}).map(
    ([type, data]) => formatArtifactForMCP(type, data),
  );
}

// ── Formatter implementations ────────────────────────────────────────────────

function formatForecastSeries(data) {
  if (!Array.isArray(data) || data.length === 0) return '## Forecast\n\n(no data)';

  const lines = ['## Demand Forecast Results', ''];
  lines.push(`Total rows: ${data.length}`);

  // Group by material if available
  const materials = [...new Set(data.map(r => r.material_code || r.sku).filter(Boolean))];
  if (materials.length > 0) {
    lines.push(`Materials: ${materials.slice(0, 10).join(', ')}${materials.length > 10 ? ` (+${materials.length - 10} more)` : ''}`);
  }

  // Show first 5 rows as table
  lines.push('', '| Material | Period | P50 | P10 | P90 |');
  lines.push('|----------|--------|-----|-----|-----|');
  for (const row of data.slice(0, 5)) {
    lines.push(`| ${row.material_code || row.sku || '-'} | ${row.time_bucket || row.period || '-'} | ${row.p50 ?? row.forecast ?? '-'} | ${row.p10 ?? '-'} | ${row.p90 ?? '-'} |`);
  }
  if (data.length > 5) lines.push(`| ... | +${data.length - 5} more rows | | | |`);

  return lines.join('\n');
}

function formatPlanTable(data) {
  if (!Array.isArray(data) || data.length === 0) return '## Plan\n\n(no data)';

  const totalQty = data.reduce((s, r) => s + (r.order_qty || 0), 0);
  const lines = ['## Replenishment Plan', ''];
  lines.push(`Total order lines: ${data.length}, Total qty: ${totalQty.toLocaleString()}`);
  lines.push('', '| Material | Supplier | Period | Qty | Cost |');
  lines.push('|----------|----------|--------|-----|------|');
  for (const row of data.slice(0, 8)) {
    lines.push(`| ${row.material_code || '-'} | ${row.supplier_id || '-'} | ${row.time_bucket || '-'} | ${row.order_qty || 0} | ${row.cost ?? '-'} |`);
  }
  if (data.length > 8) lines.push(`| ... | +${data.length - 8} more | | | |`);

  return lines.join('\n');
}

function formatSolverMeta(data) {
  if (!data) return '## Solver Summary\n\n(no data)';
  const lines = ['## Solver Summary', ''];
  lines.push(`- **Status**: ${data.status || 'unknown'}`);
  if (data.total_cost != null) lines.push(`- **Total Cost**: ${data.total_cost.toLocaleString()}`);
  if (data.service_level != null) lines.push(`- **Service Level**: ${(data.service_level * 100).toFixed(1)}%`);
  if (data.solve_time_ms != null) lines.push(`- **Solve Time**: ${data.solve_time_ms}ms`);
  return lines.join('\n');
}

function formatInventoryProjection(data) {
  if (!Array.isArray(data) || data.length === 0) return '## Inventory Projection\n\n(no data)';
  const lines = ['## Inventory Projection', ''];
  const stockouts = data.filter(r => (r.ending_inventory || 0) < 0);
  lines.push(`${data.length} projections, ${stockouts.length} potential stockouts`);
  return lines.join('\n');
}

function formatRiskScores(data) {
  if (!Array.isArray(data) || data.length === 0) return '## Risk Scores\n\n(no data)';

  const high = data.filter(r => (r.risk_score || 0) > 0.7);
  const lines = ['## Supplier Risk Analysis', ''];
  lines.push(`${data.length} items assessed, **${high.length} high-risk** (>0.7)`);

  if (high.length > 0) {
    lines.push('', '### High-Risk Items', '');
    lines.push('| Material | Supplier | Score | On-Time Rate |');
    lines.push('|----------|----------|-------|-------------|');
    for (const r of high.slice(0, 8)) {
      lines.push(`| ${r.material_code || '-'} | ${r.entity_id || r.supplier_id || '-'} | ${(r.risk_score || 0).toFixed(2)} | ${(r.metrics?.on_time_rate ?? '-')} |`);
    }
  }

  return lines.join('\n');
}

function formatScenarioComparison(data) {
  const scenarios = data?.scenarios || data?.results || [];
  if (!Array.isArray(scenarios)) return '## Scenario Comparison\n\n(no data)';
  const lines = ['## Scenario Comparison', ''];
  lines.push(`${scenarios.length} scenario(s) compared`);
  for (const s of scenarios.slice(0, 5)) {
    lines.push(`- **${s.name || s.label || 'Scenario'}**: cost=${s.total_cost?.toLocaleString() || 'N/A'}, SL=${s.service_level ? (s.service_level * 100).toFixed(1) + '%' : 'N/A'}`);
  }
  return lines.join('\n');
}

function formatAsTable(title, data, columns) {
  if (!Array.isArray(data) || data.length === 0) return `## ${title}\n\n(no data)`;
  const lines = [`## ${title}`, ''];
  lines.push('| ' + columns.join(' | ') + ' |');
  lines.push('|' + columns.map(() => '---').join('|') + '|');
  for (const row of data.slice(0, 10)) {
    lines.push('| ' + columns.map(c => row[c] ?? '-').join(' | ') + ' |');
  }
  return lines.join('\n');
}
