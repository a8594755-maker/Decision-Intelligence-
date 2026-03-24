/**
 * mockExecutors.js — Canned executor functions for mock mode.
 * Each returns { ok: true, artifacts: [], logs: [] } after a simulated delay.
 */

const delay = (ms) => new Promise(r => setTimeout(r, ms));

export async function mockExecuteBuiltinTool(stepInput) {
  const name = stepInput?.step?.step_name || stepInput?.step?.name || 'unknown';
  console.info(`[MockExecutor] builtin_tool: ${name}`);
  await delay(300 + Math.random() * 400);
  return {
    ok: true,
    artifacts: [{
      artifact_type: 'analysis_result',
      label: `${name} result`,
      data: {
        summary: `Mock analysis completed for step "${name}".`,
        metrics: { rows_processed: 1024, columns_analyzed: 12, anomalies_found: 3 },
        insights: [
          'Seasonal pattern detected in Q4 data.',
          'Top 3 SKUs account for 45% of total volume.',
          'Lead time variance increased 12% month-over-month.',
        ],
      },
    }],
    logs: [`[Mock] Executed builtin_tool: ${name}`],
  };
}

export async function mockExecutePythonTool(stepInput) {
  const name = stepInput?.step?.step_name || stepInput?.step?.name || 'unknown';
  console.info(`[MockExecutor] python_tool: ${name}`);
  await delay(400 + Math.random() * 500);
  return {
    ok: true,
    artifacts: [{
      artifact_type: 'analysis_result',
      label: `${name} result`,
      data: {
        summary: `Mock Python analysis completed for step "${name}".`,
        dataframe_shape: [500, 8],
        columns: ['date', 'sku', 'qty', 'revenue', 'cost', 'margin', 'region', 'channel'],
        statistics: { mean_qty: 142.5, std_qty: 38.2, median_revenue: 2840 },
      },
    }],
    logs: [`[Mock] Executed python_tool: ${name}`],
  };
}

export async function mockExecuteLlmCall(stepInput) {
  const name = stepInput?.step?.step_name || stepInput?.step?.name || 'unknown';
  console.info(`[MockExecutor] llm_call: ${name}`);
  await delay(200 + Math.random() * 300);
  return {
    ok: true,
    artifacts: [{
      artifact_type: 'report_json',
      label: `${name} LLM output`,
      data: {
        summary: `Mock LLM analysis for "${name}": The data shows a positive trend with seasonal fluctuations. Key recommendations include optimizing inventory levels for peak periods and reviewing supplier lead times.`,
        recommendations: [
          'Increase safety stock by 15% for Q4.',
          'Consolidate shipments to reduce logistics cost.',
          'Review contracts with top 5 suppliers.',
        ],
      },
    }],
    logs: [`[Mock] Executed llm_call: ${name}`],
  };
}

export async function mockExecuteReport(stepInput) {
  const name = stepInput?.step?.step_name || stepInput?.step?.name || 'unknown';
  console.info(`[MockExecutor] report: ${name}`);
  await delay(200 + Math.random() * 300);
  return {
    ok: true,
    artifacts: [{
      artifact_type: 'report_json',
      label: `${name} report`,
      data: {
        title: `Analysis Report — ${name}`,
        generated_at: new Date().toISOString(),
        sections: [
          { heading: 'Executive Summary', body: 'This mock report summarizes the analysis results. All key metrics are within expected ranges.' },
          { heading: 'Key Findings', body: '1. Revenue grew 8% QoQ.\n2. Inventory turnover improved from 4.2x to 4.8x.\n3. Order fulfillment rate remains above 97%.' },
          { heading: 'Recommendations', body: 'Continue current strategy. Monitor supplier performance closely in the next quarter.' },
        ],
      },
    }],
    logs: [`[Mock] Executed report: ${name}`],
  };
}

export async function mockExecuteExcel(stepInput) {
  const name = stepInput?.step?.step_name || stepInput?.step?.name || 'unknown';
  console.info(`[MockExecutor] excel: ${name}`);
  await delay(200);
  return {
    ok: true,
    artifacts: [{
      artifact_type: 'excel_ops',
      label: `${name} excel ops`,
      data: { operations_queued: 5, sheets_created: 2 },
    }],
    logs: [`[Mock] Executed excel: ${name}`],
  };
}
