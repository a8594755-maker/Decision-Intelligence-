/**
 * Analysis Recipe Catalog
 *
 * Structured, multi-step methodology prescriptions injected into the agent prompt
 * when a domain + question type matches. Each recipe tells the agent EXACTLY what
 * steps to follow and which tool to use for each step.
 *
 * Architecture:
 *   detectDomain() → selectRecipe() → buildRecipePrompt() → agent system prompt
 *
 * Extensibility: Add recipe objects to RECIPE_CATALOG for new domains/question types.
 * The selector and formatter are generic — no code changes needed.
 */

// ── Recipe Definitions ──────────────────────────────────────────────────────

export const RECIPE_CATALOG = [
  {
    id: 'safety_stock_optimization',
    domain: 'supply_chain',
    triggerConcepts: ['safety_stock', 'reorder_point', 'replenishment'],
    triggerTaskTypes: ['recommendation', 'diagnostic', 'mixed'],
    label: 'Safety Stock & Replenishment Parameter Optimization',
    steps: [
      {
        id: 'data_assessment',
        tool: 'query_sap_data',
        title: 'Data Assessment',
        instructions: [
          'Query the dataset to determine:',
          '1. Full time range (MIN/MAX dates)',
          '2. Number of distinct product categories/items',
          '3. Whether lead time columns exist (search for columns containing "lead", "delivery", "shipping", "transit")',
          '4. Whether cost/price columns exist (for EOQ calculation)',
          '5. Dataset business context: what does each row represent? (transactions, shipments, inventory snapshots, etc.)',
          'Use this step ONLY for data discovery. Do NOT compute statistics yet.',
        ].join('\n'),
      },
      {
        id: 'stationarity_and_window',
        tool: 'run_python_analysis',
        title: 'Stationarity Check & Window Selection',
        instructions: [
          'Use Python (pandas) to:',
          '1. Compute monthly demand (order count or quantity) per category/item',
          '2. For each category, split the time series into first half and second half',
          '3. Compare means: if |mean_second - mean_first| / |mean_first| > 15%, the data has a TREND',
          '4. If trend detected: select only the RECENT STABLE window (e.g., last 8-12 months or the longest stationary segment)',
          '5. Report a comparison table: category, full_period_CV, stable_period_CV, CV_inflation_%',
          '',
          'WHY THIS MATTERS: Growth or decline trends inflate standard deviation, making CV look 2-5x higher',
          'than true demand volatility. Using the full period will OVERSTATE safety stock.',
          '',
          'Output: The selected stable window dates, and the CV comparison table.',
        ].join('\n'),
      },
      {
        id: 'abc_xyz_classification',
        tool: 'run_python_analysis',
        title: 'ABC-XYZ Classification',
        instructions: [
          'Using the STABLE period data from the previous step:',
          '',
          'ABC Classification (by revenue or demand volume):',
          '- Sort categories by total revenue descending',
          '- Cumulative revenue %: A = top 80%, B = next 15%, C = bottom 5%',
          '',
          'XYZ Classification (by demand CV from stable period):',
          '- X: CV < 0.25 (stable demand)',
          '- Y: 0.25 ≤ CV < 0.50 (moderate variability)',
          '- Z: CV ≥ 0.50 (high variability)',
          '',
          'Service Level Assignment by ABC:',
          '- A items: 95% (z = 1.645)',
          '- B items: 90% (z = 1.282)',
          '- C items: 85% (z = 1.036)',
          '',
          'Output: per-category table with columns:',
          '  category, ABC, XYZ, group, total_revenue, avg_demand, std_demand, CV, service_level, z_score',
        ].join('\n'),
      },
      {
        id: 'ss_computation',
        tool: 'run_python_analysis',
        title: 'Safety Stock Computation (Full Formula)',
        instructions: [
          'FORMULA (with lead time variability):',
          '  SS = Z × √(LT × σ²_d_daily + d̄_daily² × σ²_LT)',
          '',
          'Where:',
          '  d̄_daily = avg_monthly_demand / 30',
          '  σ_d_daily = std_monthly_demand / √30',
          '  LT = mean lead time in days',
          '  σ_LT = std dev of lead time in days',
          '  Z = z-score from ABC service level assignment',
          '',
          'SIMPLIFIED (when σ_LT = 0 or unknown):',
          '  SS = Z × σ_d_daily × √(LT)',
          '',
          'IMPORTANT: Compute BOTH SS_full and SS_simple, show the % difference.',
          'If the lead time data is not directly measuring supplier replenishment lead time',
          '(e.g., it measures customer delivery time, internal processing time, etc.),',
          'FLAG IT as a proxy and explain the discrepancy.',
          '',
          'Also compute:',
          '  ROP = d̄_daily × LT + SS',
          '',
          'Output: per-category table with ALL intermediate values visible.',
        ].join('\n'),
      },
      {
        id: 'sensitivity_analysis',
        tool: 'run_python_analysis',
        title: 'Sensitivity Analysis',
        instructions: [
          'Identify which input parameters have the most uncertainty in this dataset, then generate sensitivity tables:',
          '',
          '1. Lead time sensitivity (especially important if LT is estimated or proxied):',
          '   Pick 3 plausible lead time scenarios (e.g., short/medium/long) based on the data range.',
          '   Show SS and ROP for each, per category.',
          '',
          '2. Service level sensitivity:',
          '   Show SS at 85% (z=1.036), 90% (z=1.282), 95% (z=1.645), 99% (z=2.326)',
          '',
          '3. Seasonality check:',
          '   Examine whether any months show demand spikes significantly above average.',
          '   If found, report peak-to-average ratio and flag categories most affected.',
          '',
          'Label clearly: these are SCENARIOS for decision-makers, not point estimates.',
        ].join('\n'),
      },
      {
        id: 'strategy_matrix',
        tool: 'run_python_analysis',
        title: 'ABC-XYZ Strategy Matrix',
        instructions: [
          'Create a strategy recommendation table for each ABC-XYZ group:',
          '',
          'AX: Stable high-value → fixed-interval replenishment, low SS, monthly review',
          'AY: Variable high-value → ROP-triggered, moderate SS, bi-weekly review',
          'AZ: Volatile high-value → frequent monitoring, high SS, weekly review, consider VMI',
          'BX: Stable medium-value → standard ROP, low SS, monthly review',
          'BY: Variable medium-value → standard ROP, moderate SS, monthly review',
          'BZ: Volatile medium-value → shorter replenishment cycles, consider SKU rationalization',
          'CX: Stable low-value → minimum inventory policy',
          'CY: Variable low-value → MTO preferred, minimal stock',
          'CZ: Volatile low-value → consider discontinuation or pure MTO',
          '',
          'Output: group, strategy_name, description, service_level, review_frequency, category_count, example_categories',
        ].join('\n'),
      },
      {
        id: 'visualization',
        tool: 'run_python_analysis',
        title: 'Key Visualizations',
        instructions: [
          'Based on ALL analysis results computed so far, decide which visualizations would best support your findings.',
          'Output 1-3 charts as structured JSON in the analysis_result artifact `charts` array.',
          'Available chart types: bar, horizontal_bar, grouped_bar, stacked_bar, line, area, scatter, pie, donut, histogram, lorenz.',
          '',
          'Think about what the reader needs to SEE to understand the key insights:',
          '- Are there before/after comparisons that a chart would make dramatically clearer?',
          '- Are there distributions or groupings that are hard to grasp from raw numbers?',
          '- Are there sensitivity relationships that are non-linear or surprising?',
          '',
          'Skip charts that merely restate table data. Each chart should reveal something a table cannot.',
          'Include clear titles in the user\'s language.',
        ].join('\n'),
      },
      {
        id: 'excel_report',
        tool: 'generate_analysis_workbook',
        title: 'Excel Report Generation',
        instructions: [
          'Produce a professional multi-sheet Excel workbook summarizing ALL analysis steps completed above.',
          '',
          'Required sheets:',
          '- Methodology sheet: data window selection rationale, formulas used, proxy disclosures, all limitations and assumptions',
          '- Main parameter table: one row per category with ALL computed fields (group, demand stats, CV, LT, SS, ROP, etc.)',
          '- Sensitivity analysis: the scenarios computed in the sensitivity step',
          '- Strategy matrix: the ABC-XYZ group strategies with category counts',
          '',
          'Additional sheets if the analysis produced notable findings:',
          '- CV trend analysis (if stationarity step found significant trend inflation)',
          '- Seasonal analysis (if seasonality check found notable spikes)',
          '',
          'Use the same language the user used for sheet names and content.',
          'Include ALL categories, not just a top-N subset.',
        ].join('\n'),
      },
    ],
    formulas: {
      ss_full: 'SS = Z × √(LT × σ²_d + d̄² × σ²_LT)',
      ss_simple: 'SS = Z × σ_d × √(LT)  [when σ_LT = 0]',
      rop: 'ROP = d̄ × LT + SS',
      eoq: 'EOQ = √(2DS/H)',
    },
    proxyDisclosures: [
      'If lead time data does not directly measure supplier replenishment lead time, always disclose what it actually measures, explain the gap, and provide sensitivity analysis across plausible real lead times.',
      'If the dataset represents a marketplace, aggregator, or multi-seller platform, note that category-level parameters are strategic benchmarks, not direct purchasing instructions for individual sellers.',
    ],
  },

  {
    id: 'demand_classification',
    domain: 'supply_chain',
    triggerConcepts: ['eoq'],
    triggerTaskTypes: ['recommendation', 'diagnostic', 'mixed'],
    label: 'Demand Classification & Inventory Strategy',
    steps: [
      {
        id: 'data_assessment',
        tool: 'query_sap_data',
        title: 'Data Assessment',
        instructions: 'Query time range, distinct items/categories, revenue and demand columns. Identify what each row represents.',
      },
      {
        id: 'stationarity_and_window',
        tool: 'run_python_analysis',
        title: 'Stationarity Check & Window Selection',
        instructions: [
          'Compute monthly demand per category. Split time series into first-half and second-half.',
          'If |mean_second - mean_first| / |mean_first| > 15%, a trend exists — select only the recent stable window.',
          'Report: category, full_period_CV, stable_period_CV, CV_inflation_%.',
        ].join('\n'),
      },
      {
        id: 'abc_xyz_classification',
        tool: 'run_python_analysis',
        title: 'ABC-XYZ Classification',
        instructions: [
          'Using STABLE period data:',
          'ABC by cumulative revenue: A = top 80%, B = next 15%, C = bottom 5%.',
          'XYZ by demand CV: X < 0.25, Y = 0.25-0.50, Z ≥ 0.50.',
          'Assign service levels: A=95%, B=90%, C=85%.',
        ].join('\n'),
      },
      {
        id: 'strategy_matrix',
        tool: 'run_python_analysis',
        title: 'Strategy Recommendations',
        instructions: 'Generate per-group strategy recommendations with review frequency and inventory policy.',
      },
    ],
    formulas: {},
    proxyDisclosures: [],
  },

  // ── General Domain Recipes ─────────────────────────────────────────────

  {
    id: 'cohort_retention_analysis',
    domain: 'ecommerce',
    triggerConcepts: ['retention', 'churn', 'ltv'],
    triggerTaskTypes: ['trend', 'diagnostic', 'mixed', 'comparison'],
    label: 'Cohort Retention Analysis',
    steps: [
      {
        id: 'data_assessment',
        tool: 'query_sap_data',
        title: 'Data Assessment',
        instructions: [
          'Identify the key columns:',
          '1. Customer/user identifier column',
          '2. Transaction/event date column',
          '3. Revenue/amount column (if exists)',
          '4. Full date range and total unique customers',
        ].join('\n'),
      },
      {
        id: 'cohort_definition',
        tool: 'run_python_analysis',
        title: 'Cohort Definition & Retention Matrix',
        instructions: [
          'Use Python to:',
          '1. Assign each customer to a cohort based on their first purchase/event month',
          '2. For each cohort, calculate how many customers were active in month 0, 1, 2, ... N',
          '3. Build a retention matrix: rows = cohort month, columns = month offset, values = % retained',
          '4. Calculate average retention curve across all cohorts',
          '5. Identify best and worst retaining cohorts',
        ].join('\n'),
      },
      {
        id: 'visualization',
        tool: 'generate_chart',
        title: 'Retention Heatmap',
        instructions: 'Generate a heatmap showing the retention matrix. X-axis: months since first purchase, Y-axis: cohort month.',
      },
      {
        id: 'synthesis',
        tool: 'run_python_analysis',
        title: 'LTV Estimation & Recommendations',
        instructions: [
          'Calculate:',
          '1. Average customer lifespan (months until churn, defined as 2+ months inactive)',
          '2. Average revenue per customer per active month',
          '3. Estimated LTV = avg_monthly_revenue × avg_lifespan',
          '4. Churn rate by cohort age',
          '5. Recommendations for improving retention at the highest churn points',
        ].join('\n'),
      },
    ],
    formulas: {
      retention_rate: 'Customers active in month N / Customers in cohort × 100%',
      ltv: 'Avg Revenue Per Active Month × Avg Customer Lifespan',
      churn_rate: '1 - Retention Rate',
    },
    proxyDisclosures: [],
  },

  {
    id: 'funnel_conversion_analysis',
    domain: 'ecommerce',
    triggerConcepts: ['conversion_rate', 'basket_analysis'],
    triggerTaskTypes: ['diagnostic', 'recommendation', 'mixed'],
    label: 'Funnel & Conversion Analysis',
    steps: [
      {
        id: 'funnel_definition',
        tool: 'query_sap_data',
        title: 'Funnel Stage Definition',
        instructions: [
          'Identify funnel stages from the data:',
          '1. What event/status columns define stages? (e.g., order_status, event_type)',
          '2. What is the natural sequence of stages?',
          '3. How many records at each stage?',
        ].join('\n'),
      },
      {
        id: 'conversion_calculation',
        tool: 'run_python_analysis',
        title: 'Stage-by-Stage Conversion',
        instructions: [
          'Use Python to:',
          '1. Count unique users/sessions at each funnel stage',
          '2. Calculate conversion rate between consecutive stages',
          '3. Calculate overall funnel conversion (top to bottom)',
          '4. Segment by key dimensions (channel, device, customer type) if available',
          '5. Find the biggest drop-off point',
        ].join('\n'),
      },
      {
        id: 'visualization',
        tool: 'generate_chart',
        title: 'Funnel Visualization',
        instructions: 'Generate a bar chart showing the funnel stages with count and conversion rate labels.',
      },
      {
        id: 'recommendations',
        tool: 'run_python_analysis',
        title: 'Drop-off Analysis & Recommendations',
        instructions: 'Analyze the biggest drop-off point. What segments have the worst conversion? What actions could improve it?',
      },
    ],
    formulas: {
      stage_conversion: 'Users at Stage N / Users at Stage N-1 × 100%',
      overall_conversion: 'Users at Final Stage / Users at First Stage × 100%',
    },
    proxyDisclosures: [],
  },

  {
    id: 'revenue_driver_analysis',
    domain: 'finance',
    triggerConcepts: ['revenue_growth', 'gross_margin', 'cost_structure'],
    triggerTaskTypes: ['diagnostic', 'trend', 'comparison', 'mixed'],
    label: 'Revenue Driver Analysis',
    steps: [
      {
        id: 'data_scan',
        tool: 'query_sap_data',
        title: 'Revenue Data Scan',
        instructions: [
          'Query for:',
          '1. Revenue, cost, and quantity columns',
          '2. Time period range',
          '3. Dimension columns (product, region, channel, customer segment)',
          '4. Total records and time granularity',
        ].join('\n'),
      },
      {
        id: 'decomposition',
        tool: 'run_python_analysis',
        title: 'Revenue Decomposition',
        instructions: [
          'Use Python to decompose revenue changes:',
          '1. Price effect: (Actual Price - Prior Price) × Actual Quantity',
          '2. Volume effect: (Actual Quantity - Prior Quantity) × Prior Price',
          '3. Mix effect: change in product/segment mix contribution',
          '4. Show decomposition by time period (MoM or QoQ)',
          '5. Identify top growth drivers and biggest decliners',
        ].join('\n'),
      },
      {
        id: 'margin_analysis',
        tool: 'run_python_analysis',
        title: 'Margin Analysis',
        instructions: [
          'Calculate:',
          '1. Gross margin % by product/segment/channel',
          '2. Margin trend over time',
          '3. Cost structure breakdown (if COGS detail available)',
          '4. Flag any margin compression (declining margin with growing revenue)',
        ].join('\n'),
      },
      {
        id: 'sensitivity',
        tool: 'run_python_analysis',
        title: 'Sensitivity & Recommendations',
        instructions: 'Show impact on total revenue if: (a) price +/- 5%, (b) volume +/- 10%, (c) mix shifts toward highest-margin product. Provide 3 actionable recommendations.',
      },
    ],
    formulas: {
      gross_margin: '(Revenue - COGS) / Revenue × 100%',
      price_effect: '(P_actual - P_prior) × Q_actual',
      volume_effect: '(Q_actual - Q_prior) × P_prior',
    },
    proxyDisclosures: [],
  },

  {
    id: 'time_series_decomposition',
    domain: 'general',
    triggerConcepts: ['trend', 'distribution'],
    triggerTaskTypes: ['trend', 'diagnostic', 'mixed'],
    label: 'Time Series Decomposition',
    steps: [
      {
        id: 'data_assessment',
        tool: 'query_sap_data',
        title: 'Time Series Data Assessment',
        instructions: [
          'Identify:',
          '1. Date/time column and its granularity (daily, weekly, monthly)',
          '2. Numeric metric columns suitable for time series analysis',
          '3. Full date range and data density (any gaps?)',
        ].join('\n'),
      },
      {
        id: 'decomposition',
        tool: 'run_python_analysis',
        title: 'Trend-Seasonality-Residual Decomposition',
        instructions: [
          'Use Python to:',
          '1. Resample to regular intervals if needed',
          '2. Apply additive decomposition: Y = Trend + Seasonal + Residual',
          '3. Extract trend component (rolling mean or linear fit)',
          '4. Extract seasonal component (subtract trend, average by period)',
          '5. Residual = Original - Trend - Seasonal',
          '6. Report: trend direction, seasonal period, residual volatility',
        ].join('\n'),
      },
      {
        id: 'visualization',
        tool: 'generate_chart',
        title: 'Decomposition Visualization',
        instructions: 'Generate a multi-panel chart showing: original series, trend component, seasonal component, and residuals.',
      },
      {
        id: 'forecast_and_anomaly',
        tool: 'run_python_analysis',
        title: 'Short-Term Forecast & Anomaly Detection',
        instructions: [
          'Based on the decomposition:',
          '1. Project trend forward 3-6 periods',
          '2. Add seasonal pattern for forecast',
          '3. Flag any residuals > 2 std as anomalies',
          '4. Report confidence interval for forecast',
        ].join('\n'),
      },
    ],
    formulas: {
      additive: 'Y(t) = Trend(t) + Seasonal(t) + Residual(t)',
      trend: 'Moving average or linear regression over full period',
      seasonal: 'Average of (Y - Trend) grouped by period position',
    },
    proxyDisclosures: [],
  },
];

// ── Recipe Selection ────────────────────────────────────────────────────────

/**
 * Select the best matching recipe for a given domain, concepts, and task type.
 * Returns null if no recipe matches.
 */
export function selectRecipe(domainKey, matchedConcepts = [], taskType = null) {
  if (!domainKey) return null;

  let bestRecipe = null;
  let bestScore = 0;

  for (const recipe of RECIPE_CATALOG) {
    if (recipe.domain !== domainKey) continue;

    // Task type must match
    if (taskType && !recipe.triggerTaskTypes.includes(taskType)) continue;

    // Score by concept overlap
    const conceptOverlap = (matchedConcepts || []).filter((c) =>
      recipe.triggerConcepts.includes(c)
    ).length;

    if (conceptOverlap > bestScore) {
      bestScore = conceptOverlap;
      bestRecipe = recipe;
    }
  }

  return bestScore > 0 ? bestRecipe : null;
}

// ── Recipe Prompt Builder ───────────────────────────────────────────────────

/**
 * Convert a recipe into a structured prompt block for the agent system prompt.
 */
export function buildRecipePrompt(recipe) {
  if (!recipe) return '';

  const lines = [];
  lines.push(`## Prescribed Analysis Methodology: ${recipe.label}`);
  lines.push('');
  lines.push('You MUST follow these steps in order. Each step specifies which tool to use.');
  lines.push('Do NOT skip steps. Do NOT substitute SQL where Python is specified.');
  lines.push('');

  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i];
    lines.push(`### Step ${i + 1}: ${step.title} (tool: ${step.tool})`);
    lines.push(step.instructions);
    lines.push('');
  }

  // Tool selection guidance
  const pythonSteps = recipe.steps.filter((s) => s.tool === 'run_python_analysis');
  if (pythonSteps.length > 0) {
    const pythonStepNums = pythonSteps.map((s) => recipe.steps.indexOf(s) + 1).join(', ');
    lines.push(`TOOL SELECTION: Steps ${pythonStepNums} MUST use run_python_analysis (Python/pandas/numpy).`);
    lines.push('SQL (query_sap_data) is for data retrieval only. Python is for computation, classification, and sensitivity analysis.');
    lines.push('You may combine multiple Python steps into a single run_python_analysis call if it makes the analysis more coherent.');
    lines.push('');
  }

  // Formulas
  if (recipe.formulas && Object.keys(recipe.formulas).length > 0) {
    lines.push('CANONICAL FORMULAS:');
    for (const [key, formula] of Object.entries(recipe.formulas)) {
      lines.push(`- ${key}: ${formula}`);
    }
    lines.push('');
  }

  // Proxy disclosures
  if (recipe.proxyDisclosures && recipe.proxyDisclosures.length > 0) {
    lines.push('MANDATORY PROXY DISCLOSURES:');
    for (const disclosure of recipe.proxyDisclosures) {
      lines.push(`- ⚠️ ${disclosure}`);
    }
    lines.push('');
  }

  // Iteration budget guidance
  lines.push('ITERATION BUDGET: You have up to 8 tool calls total. Combine consecutive Python steps into a single call where it makes the analysis more coherent.');

  return lines.join('\n');
}

export default {
  RECIPE_CATALOG,
  selectRecipe,
  buildRecipePrompt,
};
