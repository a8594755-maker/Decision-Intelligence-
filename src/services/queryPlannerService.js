/**
 * queryPlannerService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Multi-Query Strategy: plans 3-6 purposeful queries BEFORE the agent loop,
 * ensuring cross-validation, dimension coverage, and structured evidence collection.
 *
 * This is a deterministic planner — no LLM call needed. It reads the answer
 * contract and builds a query plan based on required dimensions/outputs.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Dimension → query purpose mapping.
 * Each entry describes what kind of query covers that dimension.
 */
const DIMENSION_QUERY_TEMPLATES = {
  revenue:            { purpose: 'total and breakdown by relevant grouping', agg: 'SUM', typical_col: 'payment_value' },
  orders:             { purpose: 'order volume and status distribution', agg: 'COUNT', typical_col: 'order_id' },
  delivery_days:      { purpose: 'delivery time statistics (avg, median, P90)', agg: 'AVG/PERCENTILE', typical_col: 'delivery_days' },
  return_rate:        { purpose: 'cancellation/return rate', agg: 'COUNT ratio', typical_col: 'order_status' },
  rating:             { purpose: 'review score distribution', agg: 'AVG/distribution', typical_col: 'review_score' },
  profit:             { purpose: 'profit/margin analysis', agg: 'SUM/AVG', typical_col: 'profit' },
  customers:          { purpose: 'customer count and segmentation', agg: 'COUNT DISTINCT', typical_col: 'customer_unique_id' },
  products:           { purpose: 'product catalog analysis', agg: 'COUNT', typical_col: 'product_id' },
  sellers:            { purpose: 'seller performance and distribution', agg: 'COUNT/SUM', typical_col: 'seller_id' },
  categories:         { purpose: 'category breakdown', agg: 'GROUP BY', typical_col: 'product_category_name' },
  payments:           { purpose: 'payment method and value analysis', agg: 'SUM/COUNT', typical_col: 'payment_value' },
  retention:          { purpose: 'repeat purchase / retention rate', agg: 'COUNT DISTINCT', typical_col: 'customer_unique_id' },
  conversion:         { purpose: 'conversion funnel analysis', agg: 'COUNT ratio', typical_col: 'order_status' },
  satisfaction:       { purpose: 'customer satisfaction scoring', agg: 'AVG', typical_col: 'review_score' },
  safety_stock:       { purpose: 'safety stock levels', agg: 'calculation', typical_col: 'demand_qty' },
  reorder_point:      { purpose: 'reorder point analysis', agg: 'calculation', typical_col: 'lead_time' },
  service_level:      { purpose: 'service level metrics', agg: 'calculation', typical_col: 'fill_rate' },
  lead_time:          { purpose: 'lead time statistics', agg: 'AVG/PERCENTILE', typical_col: 'lead_time_days' },
  inventory_turns:    { purpose: 'inventory turnover analysis', agg: 'calculation', typical_col: 'stock_qty' },
};

/**
 * Task type → recommended query structure.
 */
const TASK_TYPE_STRATEGIES = {
  comparison:     { extraSteps: ['breakdown_by_group'], crossValidation: true },
  trend:          { extraSteps: ['time_series_breakdown'], crossValidation: true },
  ranking:        { extraSteps: ['ranked_list'], crossValidation: false },
  diagnostic:     { extraSteps: ['anomaly_detection', 'root_cause_breakdown'], crossValidation: true },
  recommendation: { extraSteps: ['scenario_analysis'], crossValidation: true },
  lookup:         { extraSteps: [], crossValidation: false },
  mixed:          { extraSteps: [], crossValidation: true },
};

/**
 * Build a deterministic query plan from the answer contract.
 * Returns a structured plan that gets injected into the agent system prompt.
 *
 * @param {{ userMessage: string, answerContract: object }} params
 * @returns {{ steps: Array<{ step: number, purpose: string, type: string, validates?: string }>, totalSteps: number, crossValidation: boolean }}
 */
export function buildQueryPlan({ userMessage, answerContract }) {
  const dims = Array.isArray(answerContract?.required_dimensions)
    ? answerContract.required_dimensions : [];
  const outputs = Array.isArray(answerContract?.required_outputs)
    ? answerContract.required_outputs : [];
  const taskType = answerContract?.task_type || 'mixed';
  const strategy = TASK_TYPE_STRATEGIES[taskType] || TASK_TYPE_STRATEGIES.mixed;

  const steps = [];
  let stepNum = 1;

  // Step 1: Main aggregation query — always present for analysis
  if (dims.length > 0 || outputs.length > 0) {
    const primaryDims = dims.slice(0, 3);
    const dimPurposes = primaryDims
      .map(d => DIMENSION_QUERY_TEMPLATES[d]?.purpose || d)
      .join('; ');
    steps.push({
      step: stepNum++,
      purpose: `Main aggregation: ${dimPurposes || 'primary metrics for the question'}`,
      type: 'primary',
      covers: primaryDims,
    });
  }

  // Step 2: Cross-validation query (different approach to verify totals)
  if (strategy.crossValidation && dims.length > 0) {
    steps.push({
      step: stepNum++,
      purpose: 'Cross-validation: verify main totals via alternative aggregation path (e.g. SUM from payments table vs orders table)',
      type: 'validation',
      validates: 'step_1',
    });
  }

  // Step 3: Time breakdown for trend context
  const needsTimeSeries = taskType === 'trend'
    || dims.some(d => /time|date|month|quarter|year|trend/i.test(d))
    || /trend|over time|月|趨勢|走勢/i.test(userMessage);
  if (needsTimeSeries || (dims.length >= 2 && taskType !== 'lookup')) {
    steps.push({
      step: stepNum++,
      purpose: 'Time breakdown: monthly or quarterly trend to provide temporal context',
      type: 'trend',
      validates: 'step_1',
    });
  }

  // Step 4: Remaining uncovered dimensions
  const coveredDims = new Set(steps.flatMap(s => s.covers || []));
  const uncoveredDims = dims.filter(d => !coveredDims.has(d));
  if (uncoveredDims.length > 0) {
    const uncoveredPurposes = uncoveredDims
      .map(d => DIMENSION_QUERY_TEMPLATES[d]?.purpose || d)
      .join('; ');
    steps.push({
      step: stepNum++,
      purpose: `Dimension coverage: ${uncoveredPurposes}`,
      type: 'coverage',
      covers: uncoveredDims,
    });
  }

  // Step 5: Task-type specific queries
  for (const extra of strategy.extraSteps) {
    if (extra === 'breakdown_by_group') {
      steps.push({
        step: stepNum++,
        purpose: 'Group comparison: breakdown by the comparison groups mentioned in the question',
        type: 'breakdown',
      });
    } else if (extra === 'time_series_breakdown') {
      if (!steps.some(s => s.type === 'trend')) {
        steps.push({
          step: stepNum++,
          purpose: 'Time series: monthly/periodic breakdown for trend analysis',
          type: 'trend',
        });
      }
    } else if (extra === 'ranked_list') {
      steps.push({
        step: stepNum++,
        purpose: 'Ranked list: top/bottom entities ordered by the primary metric',
        type: 'ranking',
      });
    } else if (extra === 'anomaly_detection') {
      steps.push({
        step: stepNum++,
        purpose: 'Anomaly detection: identify outliers or unusual patterns in the data',
        type: 'diagnostic',
      });
    } else if (extra === 'root_cause_breakdown') {
      steps.push({
        step: stepNum++,
        purpose: 'Root cause: break down the anomaly by relevant dimensions to identify drivers',
        type: 'diagnostic',
      });
    }
  }

  // Cap at 6 steps to prevent over-querying
  const cappedSteps = steps.slice(0, 6);

  return {
    steps: cappedSteps,
    totalSteps: cappedSteps.length,
    crossValidation: strategy.crossValidation,
    taskType,
  };
}

/**
 * Format the query plan as a prompt block for injection into the agent system prompt.
 *
 * @param {{ steps: Array, totalSteps: number, crossValidation: boolean }} plan
 * @returns {string} Formatted prompt text, or empty string if no plan
 */
export function formatQueryPlanForPrompt(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return '';

  const lines = [
    '',
    '── Query Plan (execute in order, adapt as needed) ──',
  ];

  for (const step of plan.steps) {
    const validatesNote = step.validates
      ? ` [validates ${step.validates}]`
      : '';
    const typeTag = step.type ? ` [${step.type}]` : '';
    lines.push(`${step.step}. ${step.purpose}${typeTag}${validatesNote}`);
  }

  if (plan.crossValidation) {
    lines.push('');
    lines.push('After executing all queries, verify:');
    lines.push('- Validation query totals ≈ main query totals (tolerance: 1%)');
    lines.push('- Time breakdown sum ≈ main query total');
    lines.push('If mismatches > tolerance, note the discrepancy in your evidence summary.');
  }

  lines.push('');
  return lines.join('\n');
}

export default { buildQueryPlan, formatQueryPlanForPrompt };
