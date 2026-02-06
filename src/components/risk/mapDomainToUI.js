/**
 * Risk Dashboard - Domain to UI Data Mapper
 * 
 * 統一名詞：
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
  
  // 🔧 容錯取值：料號欄位（按優先順序嘗試）
  // 來源可能是：material_code, materialCode, item, part_no, sku, item_code, product_id 等
  const item = inventoryData.material_code 
    || inventoryData.materialCode 
    || inventoryData.item 
    || inventoryData.part_no 
    || inventoryData.sku 
    || inventoryData.item_code 
    || inventoryData.product_id
    || materialCode  // 從 domainRisk 取得（可能為空）
    || '';
  
  // 如果仍然為空，記錄警告並回填預設值
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

  // TODO: Next inbound ETA 應從 po_open_lines 取得
  const nextInboundEta = options.nextInboundEta || null;

  // TODO: Inbound qty (horizon) 應從 po_open_lines 統計
  const inboundQtyInHorizon = 0;

  return {
    // 識別（統一使用 item 作為料號欄位）
    id: `${item || 'unknown'}-${plantId || 'unknown'}`,
    item: item || '(unknown)',         // 料號（統一欄位名稱）
    materialCode,                       // 保留舊欄位（向後兼容）
    plantId,
    
    // 風險指標
    riskLevel,
    daysToStockout,
    shortageDate,
    probability,
    urgencyScore,
    
    // 庫存狀況（統一名詞）
    onHand: currentStock,              // On hand
    safetyStock: safetyStock,          // Safety stock
    netAvailable: netAvailable,        // Net available
    
    // 供需缺口（統一名詞）
    gapQty: gapQty,                    // Gap qty
    requiredInHorizon: requiredInHorizon, // Required (horizon)
    inboundQtyInHorizon: inboundQtyInHorizon, // Inbound qty (horizon) - TODO
    
    // 補貨資訊（統一名詞）
    nextInboundEta: nextInboundEta,    // Next inbound ETA - TODO
    
    // 其他
    dailyDemand: dailyDemand,
    leadTime: leadTime,
    horizonDays: horizonDays,
    
    // 警告資訊（用於 debug）
    _warnings: warnings.length > 0 ? warnings : undefined,
    
    // 原始資料保留
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
 * 將 Domain 的 Supply Coverage Risk 結果轉換為 UI 格式
 * 
 * 注意：現在使用 time_bucket（而非 ETA 日期）
 * 
 * @param {Object} domainResult - Domain 計算結果
 * @param {Array} warnings - 警告資訊（可選）
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
    // Inventory risk（當有 component_demand 時由 RiskDashboardView 填入）
    daysToStockout: domainDaysToStockout,
    stockoutProbability: domainStockoutProbability,
    // A2: lead time 來源（supplier / fallback）
    leadTimeDaysUsed,
    leadTimeDaysSource,
    // M2: Profit at Risk 相關
    profitPerUnit,
    currency,
    exposureQty,
    profitAtRisk,
    profitAtRiskReason
  } = domainResult;
  
  // 處理缺少 item 的情況
  const displayItem = item || '(unknown)';
  if (!item || item === '(unknown)') {
    warnings.push({
      type: 'MISSING_ITEM',
      message: 'Missing item identifier',
      factory
    });
  }
  
  // 轉換 status 到 riskLevel（與舊版統一）
  const riskLevelMap = {
    'CRITICAL': 'critical',
    'WARNING': 'warning',
    'OK': 'low'
  };
  const riskLevel = riskLevelMap[status] || 'low';
  
  // 計算 urgencyScore（用於排序）
  let urgencyScore = 0;
  if (status === 'CRITICAL') {
    urgencyScore = 100;
  } else if (status === 'WARNING') {
    urgencyScore = 50 + (inboundCountHorizon === 1 ? 10 : 0);
  } else {
    urgencyScore = 10;
  }
  
  // 生成穩定的唯一 ID
  const idBase = `${displayItem}|${factory}|${nextTimeBucket || 'none'}`;
  const idHash = idBase.split('').reduce((hash, char) => {
    return ((hash << 5) - hash) + char.charCodeAt(0);
  }, 0);
  
  return {
    // 識別
    id: `${idBase}|${Math.abs(idHash)}`,
    item: displayItem,
    materialCode: item, // 向後兼容
    plantId: factory,
    
    // 風險指標
    riskLevel,
    status,
    reason,
    urgencyScore,
    
    // Supply Coverage 專屬（Bucket-Based）
    inboundCount: inboundCountHorizon,
    inboundQty: inboundQtyHorizon,
    nextTimeBucket: nextTimeBucket,        // 顯示 time_bucket（如 2026-W05）
    nextInboundEta: nextTimeBucket,        // 向後兼容（Table 用）
    daysUntilNextInbound: null,            // Bucket-based 無此概念
    horizonBuckets: horizonBuckets,
    currentBucket: currentBucket,
    poDetails: domainResult.poDetails || [], // PO 明細（top 5）
    
    // 庫存狀況（從 domainResult 取得）
    onHand: onHand || currentStock || 0,
    currentStock: onHand || currentStock || 0, // 向後兼容
    safetyStock: safetyStock || 0,
    netAvailable: netAvailable !== undefined ? netAvailable : (onHand || currentStock || 0),
    gapQty: gapQty !== undefined ? gapQty : 0,
    
    // 其他（為了兼容舊 Table/Details 組件）
    // 若有 component_demand，由 Inventory domain 計算 daysToStockout / P(stockout)
    daysToStockout: typeof domainDaysToStockout === 'number' ? domainDaysToStockout : Infinity,
    requiredInHorizon: 0,
    inboundQtyInHorizon: inboundQtyHorizon,
    probability: typeof domainStockoutProbability === 'number' ? domainStockoutProbability : (status === 'CRITICAL' ? 1.0 : (status === 'WARNING' ? 0.6 : 0.2)),
    shortageDate: (typeof domainDaysToStockout === 'number' && domainDaysToStockout !== Infinity && domainDaysToStockout >= 0)
      ? (() => { const d = new Date(); d.setDate(d.getDate() + Math.floor(domainDaysToStockout)); return d; })()
      : null,
    horizonDays: horizonBuckets, // 向後兼容（改用 buckets）
    
    // M2: Profit at Risk（貨幣化）
    profitPerUnit: profitPerUnit || 0,
    currency: currency || 'USD',
    exposureQty: exposureQty || 0,
    profitAtRisk: profitAtRisk || 0,
    profitAtRiskReason: profitAtRiskReason || 'MISSING',
    
    // A2: Lead time 來源（Explainability）
    leadTimeDaysUsed: leadTimeDaysUsed,
    leadTimeDaysSource: leadTimeDaysSource || 'fallback',
    
    // 警告資訊
    _warnings: warnings.length > 0 ? warnings : undefined,
    
    // 原始資料
    _raw: domainResult
  };
};
