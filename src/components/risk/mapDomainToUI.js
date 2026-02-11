/**
 * Risk Dashboard - Domain to UI Data Mapper
 * 
 * Unified terminology:
 * - Days to stockout
 * - Shortage date
 * - Gap qty
 * - Next inbound ETA
 * - On hand
 * - Net available
 */

export const mapDomainRiskToTableRow = (domainRisk, inventoryData = {}, options = {}) => {
  const warnings = options.warnings || [];
  
  const {
    materialCode,
    plantId,
    currentStock,
    safetyStock,
    dailyDemand,
    leadTime,
    daysToStockout,
    probability,
    urgencyScore,
    riskLevel
  } = domainRisk;

  const horizonDays = options.horizonDays || 30;
  
  // 🔧 Fault-tolerant value extraction: item field (try in priority order)
  // Source may be: material_code, materialCode, item, part_no, sku, item_code, product_id, etc.
  const item = inventoryData.material_code 
    || inventoryData.materialCode 
    || inventoryData.item 
    || inventoryData.part_no 
    || inventoryData.sku 
    || inventoryData.item_code 
    || inventoryData.product_id
    || materialCode  // From domainRisk (may be empty)
    || '';
  
  // If still empty, log warning and use default value
  if (!item) {
    warnings.push({
      type: 'MISSING_ITEM',
      message: 'Missing item identifier in inventory data',
      rawKeys: Object.keys(inventoryData),
      domainKeys: Object.keys(domainRisk)
    });
  }

  // Net available = On hand - Safety stock
  const netAvailable = currentStock - safetyStock;

  // Gap qty = Required (horizon) - On hand
  const requiredInHorizon = dailyDemand * horizonDays;
  const gapQty = Math.max(0, requiredInHorizon - currentStock);

  // Shortage date
  let shortageDate = null;
  if (daysToStockout !== Infinity && daysToStockout >= 0) {
    shortageDate = new Date();
    shortageDate.setDate(shortageDate.getDate() + Math.floor(daysToStockout));
  }

  // TODO: Next inbound ETA should be fetched from po_open_lines
  const nextInboundEta = options.nextInboundEta || null;

  // TODO: Inbound qty (horizon) should be aggregated from po_open_lines
  const inboundQtyInHorizon = 0;

  return {
    // Identification (unified using item as material code field)
    id: `${item || 'unknown'}-${plantId || 'unknown'}`,
    item: item || '(unknown)',         // Material code (unified field name)
    materialCode,                       // Keep old field (backward compatible)
    plantId,
    
    // Risk indicators
    riskLevel,
    daysToStockout,
    shortageDate,
    probability,
    urgencyScore,
    
    // Inventory status (unified terminology)
    onHand: currentStock,              // On hand
    safetyStock: safetyStock,          // Safety stock
    netAvailable: netAvailable,        // Net available
    
    // Supply-demand gap (unified terminology)
    gapQty: gapQty,                    // Gap qty
    requiredInHorizon: requiredInHorizon, // Required (horizon)
    inboundQtyInHorizon: inboundQtyInHorizon, // Inbound qty (horizon) - TODO
    
    // Replenishment info (unified terminology)
    nextInboundEta: nextInboundEta,    // Next inbound ETA - TODO
    
    // Other
    dailyDemand: dailyDemand,
    leadTime: leadTime,
    horizonDays: horizonDays,
    
    // Warning info (for debug)
    _warnings: warnings.length > 0 ? warnings : undefined,
    
    // Raw data preserved
    _raw: {
      ...domainRisk,
      ...inventoryData
    }
  };
};

export const getRiskLevelConfig = (riskLevel) => {
  const configs = {
    critical: {
      label: 'Critical',
      icon: '🔴',
      bgColor: 'bg-red-600',
      textColor: 'text-white',
      lightBg: 'bg-red-50',
      darkLightBg: 'dark:bg-red-900/10',
      borderColor: 'border-red-600'
    },
    warning: {
      label: 'Warning',
      icon: '🟡',
      bgColor: 'bg-yellow-500',
      textColor: 'text-black',
      lightBg: 'bg-yellow-50',
      darkLightBg: 'dark:bg-yellow-900/10',
      borderColor: 'border-yellow-500'
    },
    low: {
      label: 'OK',
      icon: '🟢',
      bgColor: 'bg-green-500',
      textColor: 'text-white',
      lightBg: 'bg-green-50',
      darkLightBg: 'dark:bg-green-900/10',
      borderColor: 'border-green-500'
    }
  };
  
  return configs[riskLevel] || configs.low;
};

export const formatDate = (date) => {
  if (!date) return 'N/A';
  const d = new Date(date);
  if (isNaN(d.getTime())) return 'Invalid Date';
  
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
};

export const formatNumber = (num) => {
  if (num === null || num === undefined || isNaN(num)) return '0';
  return Math.round(num).toLocaleString();
};

/**
 * Supply Coverage Risk Adapter (Bucket-Based Version)
 * Converts Domain Supply Coverage Risk results to UI format
 * 
 * Note: Now uses time_bucket (instead of ETA dates)
 * 
 * @param {Object} domainResult - Domain calculation result
 * @param {Array} warnings - Warning info (optional)
 * @returns {Object} uiRow
 */
export const mapSupplyCoverageToUI = (domainResult, warnings = []) => {
  const {
    item,
    factory,
    horizonBuckets,
    currentBucket,
    inboundCountHorizon,
    inboundQtyHorizon,
    nextTimeBucket,
    currentStock,
    status,
    reason,
    onHand,
    safetyStock,
    netAvailable,
    gapQty,
    // Inventory risk (filled by RiskDashboardView when component_demand is available)
    daysToStockout: domainDaysToStockout,
    stockoutProbability: domainStockoutProbability,
    // A2: lead time source (supplier / fallback)
    leadTimeDaysUsed,
    leadTimeDaysSource,
    // M2: Profit at Risk related
    profitPerUnit,
    currency,
    exposureQty,
    profitAtRisk,
    profitAtRiskReason
  } = domainResult;
  
  // Handle missing item case
  const displayItem = item || '(unknown)';
  if (!item || item === '(unknown)') {
    warnings.push({
      type: 'MISSING_ITEM',
      message: 'Missing item identifier',
      factory
    });
  }
  
  // Convert status to riskLevel (unified with old version)
  const riskLevelMap = {
    'CRITICAL': 'critical',
    'WARNING': 'warning',
    'OK': 'low'
  };
  const riskLevel = riskLevelMap[status] || 'low';
  
  // Calculate urgencyScore (for sorting)
  let urgencyScore = 0;
  if (status === 'CRITICAL') {
    urgencyScore = 100;
  } else if (status === 'WARNING') {
    urgencyScore = 50 + (inboundCountHorizon === 1 ? 10 : 0);
  } else {
    urgencyScore = 10;
  }
  
  // Generate stable unique ID
  const idBase = `${displayItem}|${factory}|${nextTimeBucket || 'none'}`;
  const idHash = idBase.split('').reduce((hash, char) => {
    return ((hash << 5) - hash) + char.charCodeAt(0);
  }, 0);
  
  return {
    // Identification
    id: `${idBase}|${Math.abs(idHash)}`,
    item: displayItem,
    materialCode: item, // Backward compatible
    plantId: factory,
    
    // Risk indicators
    riskLevel,
    status,
    reason,
    urgencyScore,
    
    // Supply Coverage specific (Bucket-Based)
    inboundCount: inboundCountHorizon,
    inboundQty: inboundQtyHorizon,
    nextTimeBucket: nextTimeBucket,        // Display time_bucket (e.g. 2026-W05)
    nextInboundEta: nextTimeBucket,        // Backward compatible (for Table)
    daysUntilNextInbound: null,            // Not applicable in Bucket-based
    horizonBuckets: horizonBuckets,
    currentBucket: currentBucket,
    poDetails: domainResult.poDetails || [], // PO details (top 5)
    
    // Inventory status (from domainResult)
    onHand: onHand || currentStock || 0,
    currentStock: onHand || currentStock || 0, // Backward compatible
    safetyStock: safetyStock || 0,
    netAvailable: netAvailable !== undefined ? netAvailable : (onHand || currentStock || 0),
    gapQty: gapQty !== undefined ? gapQty : 0,
    
    // Other (for backward compatibility with old Table/Details components)
    // If component_demand exists, daysToStockout / P(stockout) calculated by Inventory domain
    daysToStockout: typeof domainDaysToStockout === 'number' ? domainDaysToStockout : Infinity,
    requiredInHorizon: 0,
    inboundQtyInHorizon: inboundQtyHorizon,
    probability: typeof domainStockoutProbability === 'number' ? domainStockoutProbability : (status === 'CRITICAL' ? 1.0 : (status === 'WARNING' ? 0.6 : 0.2)),
    shortageDate: (typeof domainDaysToStockout === 'number' && domainDaysToStockout !== Infinity && domainDaysToStockout >= 0)
      ? (() => { const d = new Date(); d.setDate(d.getDate() + Math.floor(domainDaysToStockout)); return d; })()
      : null,
    horizonDays: horizonBuckets, // Backward compatible (now uses buckets)
    
    // M2: Profit at Risk (Monetization)
    profitPerUnit: profitPerUnit || 0,
    currency: currency || 'USD',
    exposureQty: exposureQty || 0,
    profitAtRisk: profitAtRisk || 0,
    profitAtRiskReason: profitAtRiskReason || 'MISSING',
    
    // A2: Lead time source (Explainability)
    leadTimeDaysUsed: leadTimeDaysUsed,
    leadTimeDaysSource: leadTimeDaysSource || 'fallback',
    
    // Warning info
    _warnings: warnings.length > 0 ? warnings : undefined,
    
    // Raw data
    _raw: domainResult
  };
};
