/**
 * Profit at Risk Calculator (Pure Function)
 * 
 * 用途：计算每个风险项的 Profit at Risk（货币化）
 * 输入：风险行 + 财务数据索引
 * 输出：每行加入 profitPerUnit, profitAtRisk, profitAtRiskReason
 * 
 * 计算规则：
 * - exposureQty = max(0, gapQty)
 * - profitAtRisk = exposureQty * profitPerUnit
 * - 若 status === 'OK'，profitAtRisk 可能为 0（取决于 gapQty）
 */

// Fallback 假设值（当没有真实 financials 时）
const DEFAULT_PROFIT_PER_UNIT = 10;
const DEFAULT_CURRENCY = 'USD';

/**
 * 正规化料号（与 coverageCalculator 保持一致）
 */
function normalizeItemCode(code) {
  if (!code) return '';
  return String(code).trim().toUpperCase();
}

/**
 * 建立 Financial Index
 * 
 * @param {Array} financials - FG financials 数据
 * @returns {Object} { itemKey: { profitPerUnit, currency, source: 'REAL' } }
 */
export const buildFinancialIndex = (financials = []) => {
  const index = {};
  
  financials.forEach(fin => {
    const item = normalizeItemCode(
      fin.material_code || fin.item_code || fin.item || fin.product_code || ''
    );
    
    if (!item) return;
    
    // 容错读取 profit_per_unit（多种字段名）
    const profitPerUnit = parseFloat(
      fin.profit_per_unit || 
      fin.margin_per_unit || 
      fin.gross_margin || 
      fin.unit_profit || 
      fin.margin ||
      0
    );
    
    // 容错读取 currency
    const currency = (fin.currency || fin.currency_code || DEFAULT_CURRENCY).trim().toUpperCase();
    
    if (profitPerUnit > 0) {
      index[item] = {
        profitPerUnit,
        currency,
        source: 'REAL',
        _raw: fin
      };
    }
  });
  
  return index;
};

/**
 * 计算单行的 Profit at Risk
 * 
 * @param {Object} riskRow - 风险行（来自 domainResult）
 * @param {Object} financialIndex - 财务索引
 * @param {boolean} useFallback - 是否使用 fallback 假设
 * @returns {Object} 加入 profit 相关字段的 row
 */
export const calculateProfitAtRiskForRow = (riskRow, financialIndex = {}, useFallback = true) => {
  const item = normalizeItemCode(riskRow.item);
  
  // 从 financialIndex 查找
  let profitPerUnit = 0;
  let currency = DEFAULT_CURRENCY;
  let profitAtRiskReason = 'MISSING';
  
  if (financialIndex[item]) {
    // 有真实 financials
    profitPerUnit = financialIndex[item].profitPerUnit;
    currency = financialIndex[item].currency;
    profitAtRiskReason = 'REAL';
  } else if (useFallback) {
    // 使用 fallback 假设
    profitPerUnit = DEFAULT_PROFIT_PER_UNIT;
    currency = DEFAULT_CURRENCY;
    profitAtRiskReason = 'ASSUMPTION';
  }
  
  // 计算 exposure（暴露量）
  const gapQty = riskRow.gapQty || 0;
  const exposureQty = Math.max(0, gapQty);
  
  // 计算 Profit at Risk
  const profitAtRisk = exposureQty * profitPerUnit;
  
  // Data quality level based on fallback count
  let fallbackCount = profitAtRiskReason !== 'REAL' ? 1 : 0;
  if (riskRow.leadTimeDaysSource === 'fallback') fallbackCount++;
  if ((riskRow.safetyStock || 0) === 0 && riskRow.safetyStockSource !== 'real') fallbackCount++;

  const dataQualityLevel = profitAtRiskReason === 'MISSING' ? 'missing'
    : fallbackCount === 0 ? 'verified'
    : fallbackCount === 1 ? 'partial'
    : 'estimated';

  // Build assumptions array
  const ssSource = riskRow.safetyStockSource || ((riskRow.safetyStock || 0) > 0 ? 'real' : 'fallback');
  const hasDemand = typeof riskRow.daysToStockout === 'number' && riskRow.daysToStockout !== Infinity;

  const assumptions = [
    {
      field: 'profitPerUnit',
      source: profitAtRiskReason === 'REAL' ? 'fg_financials' : (profitAtRiskReason === 'ASSUMPTION' ? 'fallback' : 'missing'),
      value: profitPerUnit,
      isDefault: profitAtRiskReason !== 'REAL',
      note: profitAtRiskReason === 'REAL'
        ? `Matched ${item} in fg_financials (${currency})`
        : profitAtRiskReason === 'ASSUMPTION'
          ? `No financial data for ${item}; using default $${DEFAULT_PROFIT_PER_UNIT}/unit`
          : `No financial data and fallback disabled`
    },
    {
      field: 'leadTimeDays',
      source: riskRow.leadTimeDaysSource === 'supplier' ? 'suppliers' : 'fallback',
      value: riskRow.leadTimeDaysUsed ?? null,
      isDefault: riskRow.leadTimeDaysSource !== 'supplier',
      note: riskRow.leadTimeDaysSource === 'supplier'
        ? `Lead time from suppliers: ${riskRow.leadTimeDaysUsed} days`
        : 'Using system default lead time (7 days)'
    },
    {
      field: 'safetyStock',
      source: ssSource === 'real' ? 'inventory_snapshots' : 'fallback',
      value: riskRow.safetyStock || 0,
      isDefault: ssSource !== 'real',
      note: ssSource === 'real'
        ? `Safety stock from inventory: ${riskRow.safetyStock}`
        : 'No safety stock data; using 0'
    },
    {
      field: 'demandCoverage',
      source: hasDemand ? 'component_demand' : 'missing',
      value: hasDemand ? riskRow.daysToStockout : null,
      isDefault: !hasDemand,
      note: hasDemand
        ? `Demand data present; daysToStockout = ${riskRow.daysToStockout}`
        : 'No component_demand data for this item/plant'
    }
  ];

  // Compute confidence_score (0-1 weighted average)
  const WEIGHTS = { financial: 0.4, leadTime: 0.25, safetyStock: 0.2, demand: 0.15 };
  const signals = {
    financial: profitAtRiskReason === 'REAL' ? 1.0 : profitAtRiskReason === 'ASSUMPTION' ? 0.3 : 0.0,
    leadTime: riskRow.leadTimeDaysSource === 'supplier' ? 1.0 : 0.3,
    safetyStock: ssSource === 'real' ? 1.0 : 0.3,
    demand: hasDemand ? 1.0 : 0.0
  };
  const confidence_score = Math.round((
    signals.financial * WEIGHTS.financial +
    signals.leadTime * WEIGHTS.leadTime +
    signals.safetyStock * WEIGHTS.safetyStock +
    signals.demand * WEIGHTS.demand
  ) * 100) / 100;

  // Build computation trace
  const computationTrace = {
    steps: [
      {
        label: 'Inventory Lookup',
        inputs: { material: item, plant: riskRow.factory || riskRow.plantId || riskRow.plant_id },
        result: { onHand: riskRow.onHand ?? riskRow.currentStock ?? 0, safetyStock: riskRow.safetyStock || 0, source: ssSource === 'real' ? 'inventory_snapshots' : 'default (0)' },
        formula: null
      },
      {
        label: 'Supply Coverage',
        inputs: { horizonBuckets: riskRow.horizonBuckets, inboundPOs: riskRow.inboundCountHorizon },
        result: { inboundCount: riskRow.inboundCountHorizon ?? 0, inboundQty: riskRow.inboundQtyHorizon ?? 0, status: riskRow.status || 'OK' },
        formula: 'CRITICAL if inboundCount=0, WARNING if inboundCount=1 or qty<10, else OK'
      },
      {
        label: 'Gap Calculation',
        inputs: { safetyStock: riskRow.safetyStock || 0, onHand: riskRow.onHand ?? 0 },
        result: { gapQty, netAvailable: (riskRow.onHand ?? 0) - (riskRow.safetyStock || 0) },
        formula: 'gapQty = max(0, safetyStock - onHand)'
      },
      {
        label: 'Profit at Risk',
        inputs: { exposureQty, profitPerUnit, source: profitAtRiskReason === 'REAL' ? 'fg_financials' : profitAtRiskReason },
        result: { profitAtRisk },
        formula: `profitAtRisk = max(0, ${gapQty}) × ${profitPerUnit} = ${profitAtRisk}`
      }
    ],
    what_if_hints: []
  };

  if (hasDemand) {
    computationTrace.steps.push({
      label: 'Inventory Risk',
      inputs: { dailyDemand: riskRow.dailyDemand || 'from component_demand', leadTimeDays: riskRow.leadTimeDaysUsed, source: riskRow.leadTimeDaysSource },
      result: { daysToStockout: riskRow.daysToStockout, pStockout: riskRow.stockoutProbability ?? riskRow.probability },
      formula: 'daysToStockout = onHand / dailyDemand'
    });
  }

  // Generate what-if hints from default assumptions
  const hintMap = {
    profitPerUnit: { action: `Upload financials for ${item}`, currentState: `Using fallback ($${DEFAULT_PROFIT_PER_UNIT}/unit)`, potentialState: 'Real profit/unit from fg_financials', impactField: 'profitAtRisk' },
    leadTimeDays: { action: `Add lead_time_days to suppliers for ${item}`, currentState: 'Using system default (7 days)', potentialState: 'Supplier-specific lead time', impactField: 'daysToStockout' },
    safetyStock: { action: `Set safety_stock in inventory for ${item}`, currentState: 'Using 0 (no safety stock)', potentialState: 'Real safety stock threshold', impactField: 'gapQty' },
    demandCoverage: { action: `Run BOM explosion forecast including ${item}`, currentState: 'No demand forecast data', potentialState: 'daysToStockout and P(stockout) calculated', impactField: 'daysToStockout' }
  };
  assumptions.filter(a => a.isDefault).forEach(a => {
    if (hintMap[a.field]) computationTrace.what_if_hints.push(hintMap[a.field]);
  });

  return {
    ...riskRow,
    profitPerUnit,
    currency,
    exposureQty,
    profitAtRisk,
    profitAtRiskReason,
    dataQualityLevel,
    assumptions,
    confidence_score,
    computationTrace
  };
};

/**
 * 批量计算 Profit at Risk
 * 
 * @param {Object} params
 * @param {Array} params.riskRows - 风险行列表
 * @param {Array} [params.financials=[]] - FG financials 数据
 * @param {boolean} [params.useFallback=true] - 是否使用 fallback 假设
 * @returns {Object} { rows, summary }
 */
export const calculateProfitAtRiskBatch = ({
  riskRows = [],
  financials = [],
  useFallback = true
}) => {
  // 建立 financial index
  const financialIndex = buildFinancialIndex(financials);
  
  // 计算每行
  const rowsWithProfit = riskRows.map(row => 
    calculateProfitAtRiskForRow(row, financialIndex, useFallback)
  );
  
  // 计算汇总
  const summary = {
    totalProfitAtRisk: 0,
    criticalProfitAtRisk: 0,
    warningProfitAtRisk: 0,
    lowProfitAtRisk: 0,
    itemsWithRealFinancials: Object.keys(financialIndex).length,
    itemsWithAssumption: 0,
    itemsWithMissing: 0
  };
  
  rowsWithProfit.forEach(row => {
    summary.totalProfitAtRisk += row.profitAtRisk;
    
    // 按风险等级汇总
    if (row.status === 'CRITICAL' || row.riskLevel === 'critical') {
      summary.criticalProfitAtRisk += row.profitAtRisk;
    } else if (row.status === 'WARNING' || row.riskLevel === 'warning') {
      summary.warningProfitAtRisk += row.profitAtRisk;
    } else {
      summary.lowProfitAtRisk += row.profitAtRisk;
    }
    
    // 统计来源
    if (row.profitAtRiskReason === 'ASSUMPTION') {
      summary.itemsWithAssumption++;
    } else if (row.profitAtRiskReason === 'MISSING') {
      summary.itemsWithMissing++;
    }
  });
  
  return {
    rows: rowsWithProfit,
    summary
  };
};

/**
 * 格式化货币显示
 * 
 * @param {number} amount - 金额
 * @param {string} currency - 货币代码
 * @returns {string}
 */
export const formatCurrency = (amount, currency = DEFAULT_CURRENCY) => {
  if (!amount || isNaN(amount)) return '$0';
  
  const symbol = currency === 'USD' ? '$' : 
                 currency === 'EUR' ? '€' : 
                 currency === 'CNY' ? '¥' : 
                 currency;
  
  return `${symbol}${Math.round(amount).toLocaleString()}`;
};

/**
 * 获取 Fallback 假设值（用于 UI 显示）
 */
export const getFallbackAssumption = () => ({
  profitPerUnit: DEFAULT_PROFIT_PER_UNIT,
  currency: DEFAULT_CURRENCY,
  displayText: `Assumption: $${DEFAULT_PROFIT_PER_UNIT}/unit`
});
