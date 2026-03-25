/**
 * Material Cost Service
 * Material cost analysis service - handles material price history and cost analysis
 */

import { supabase } from '../infra/supabaseClient';

/**
 * Get material price data for specified period
 * @param {string} userId - User ID
 * @param {number|null} days - Number of days (30/90/180/365) if provided
 * @param {Object|null} customRange - Custom date range { startDate, endDate }
 * @returns {Promise<Array>} Price history records
 */
export const getMaterialPriceHistory = async (userId, days = null, customRange = null) => {
  let startDate, endDate;

  if (customRange && customRange.startDate && customRange.endDate) {
    // Use custom date range
    startDate = customRange.startDate;
    endDate = customRange.endDate;
  } else {
    // Calculate using days
    const daysToUse = days || 30;
    endDate = new Date();
    startDate = new Date();
    startDate.setDate(startDate.getDate() - daysToUse);
  }

  const startDateStr = typeof startDate === 'string' ? startDate : startDate.toISOString().split('T')[0];
  const endDateStr = typeof endDate === 'string' ? endDate : endDate.toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('price_history')
    .select(`
      *,
      materials (
        material_code,
        material_name,
        category,
        uom
      ),
      suppliers (
        supplier_code,
        supplier_name
      )
    `)
    .eq('user_id', userId)
    .gte('order_date', startDateStr)
    .lte('order_date', endDateStr)
    .order('order_date', { ascending: true });

  if (error) throw error;
  return data || [];
};

/**
 * Get KPI data
 * @param {string} userId - User ID
 * @param {number|null} days - Number of days
 * @param {Object|null} customRange - Custom date range
 * @returns {Promise<Object>} KPI statistics
 */
export const getMaterialCostKPIs = async (userId, days = null, customRange = null) => {
  const priceHistory = await getMaterialPriceHistory(userId, days, customRange);

  if (priceHistory.length === 0) {
    return {
      totalMaterials: 0,
      avgPriceChange: 0,
      topIncreaseMaterial: null,
      highVolatilityCount: 0,
      totalMaterialSpend: null,
      hasQuantityData: false
    };
  }

  // Detect if quantity field exists
  const quantityField = detectQuantityField(priceHistory[0]);
  const hasQuantityData = quantityField !== null;

  // Calculate total spend (if quantity data available)
  let totalMaterialSpend = null;
  if (hasQuantityData) {
    totalMaterialSpend = priceHistory.reduce((sum, record) => {
      const qty = parseFloat(record[quantityField]) || 0;
      const price = parseFloat(record.unit_price) || 0;
      return sum + (qty * price);
    }, 0);
  }

  // Group by material_id
  const materialGroups = {};
  priceHistory.forEach(record => {
    const matId = record.material_id;
    if (!materialGroups[matId]) {
      materialGroups[matId] = {
        material_code: record.materials?.material_code || 'N/A',
        material_name: record.materials?.material_name || 'N/A',
        prices: []
      };
    }
    materialGroups[matId].prices.push({
      date: record.order_date,
      price: parseFloat(record.unit_price)
    });
  });

  // Calculate price change for each material
  const materialStats = [];
  Object.values(materialGroups).forEach(mat => {
    if (mat.prices.length < 2) return;

    mat.prices.sort((a, b) => new Date(a.date) - new Date(b.date));
    const oldestPrice = mat.prices[0].price;
    const latestPrice = mat.prices[mat.prices.length - 1].price;
    const changePercent = ((latestPrice - oldestPrice) / oldestPrice) * 100;

    const prices = mat.prices.map(p => p.price);
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const volatility = avgPrice > 0 ? ((maxPrice - minPrice) / avgPrice) * 100 : 0;

    materialStats.push({
      material_code: mat.material_code,
      material_name: mat.material_name,
      changePercent,
      volatility
    });
  });

  // KPI 1: Total materials with price data
  const totalMaterials = Object.keys(materialGroups).length;

  // KPI 2: Average price change percentage
  const avgPriceChange = materialStats.length > 0
    ? materialStats.reduce((sum, s) => sum + s.changePercent, 0) / materialStats.length
    : 0;

  // KPI 3: Material with largest price increase
  const topIncreaseMaterial = materialStats.length > 0
    ? materialStats.reduce((max, current) =>
        current.changePercent > max.changePercent ? current : max
      )
    : null;

  // KPI 4: High volatility material count (volatility > 15%)
  const highVolatilityCount = materialStats.filter(s => s.volatility > 15).length;

  return {
    totalMaterials,
    avgPriceChange,
    topIncreaseMaterial,
    highVolatilityCount,
    totalMaterialSpend,
    hasQuantityData
  };
};

/**
 * Detect quantity field name
 * @param {Object} record - Single record
 * @returns {string|null} Quantity field name or null
 */
const detectQuantityField = (record) => {
  if (!record) return null;
  
  const possibleFields = ['quantity', 'qty', 'order_qty', 'orderQty', 'order_quantity'];
  
  for (const field of possibleFields) {
    if (Object.prototype.hasOwnProperty.call(record, field) && record[field] != null) {
      return field;
    }
  }
  
  return null;
};

/**
 * Get materials list sorted by spend
 * @param {string} userId - User ID
 * @param {number|null} days - Number of days
 * @param {Object|null} customRange - Custom date range
 * @param {number} limit - Return count limit
 * @returns {Promise<Array>} Top materials by spend
 */
export const getTopBySpend = async (userId, days = null, customRange = null, limit = 10) => {
  const priceHistory = await getMaterialPriceHistory(userId, days, customRange);
  
  if (priceHistory.length === 0) {
    return [];
  }

  const quantityField = detectQuantityField(priceHistory[0]);
  
  if (!quantityField) {
    // No quantity data available
    return [];
  }

  // Group by material_id and calculate spend
  const materialSpendMap = {};
  
  priceHistory.forEach(record => {
    const matId = record.material_id;
    const qty = parseFloat(record[quantityField]) || 0;
    const price = parseFloat(record.unit_price) || 0;
    const spend = qty * price;
    
    if (!materialSpendMap[matId]) {
      materialSpendMap[matId] = {
        material_id: matId,
        material_code: record.materials?.material_code || 'N/A',
        material_name: record.materials?.material_name || 'N/A',
        category: record.materials?.category || 'N/A',
        totalQty: 0,
        totalSpend: 0,
        prices: []
      };
    }
    
    materialSpendMap[matId].totalQty += qty;
    materialSpendMap[matId].totalSpend += spend;
    materialSpendMap[matId].prices.push(price);
  });

  // Calculate statistics for each material
  const materialsWithSpend = Object.values(materialSpendMap).map(mat => {
    const avgPrice = mat.prices.reduce((a, b) => a + b, 0) / mat.prices.length;
    mat.prices.sort((a, b) => a - b);
    const oldestPrice = mat.prices[0];
    const latestPrice = mat.prices[mat.prices.length - 1];
    const priceChangePercent = oldestPrice > 0 ? ((latestPrice - oldestPrice) / oldestPrice) * 100 : 0;
    
    return {
      material_id: mat.material_id,
      material_code: mat.material_code,
      material_name: mat.material_name,
      category: mat.category,
      totalQty: mat.totalQty,
      totalSpend: mat.totalSpend,
      avgPrice: avgPrice,
      priceChangePercent: priceChangePercent
    };
  });

  // Sort by total spend descending
  materialsWithSpend.sort((a, b) => b.totalSpend - a.totalSpend);

  return materialsWithSpend.slice(0, limit);
};

/**
 * ABC Spend Concentration Analysis
 * Classifies materials into A/B/C categories by cumulative spend
 * A: top materials accounting for ~80% spend
 * B: next materials accounting for ~15% spend
 * C: remaining materials accounting for ~5% spend
 * @param {string} userId
 * @param {number|null} days
 * @param {Object|null} customRange
 * @returns {Promise<Object>} { materials, summary }
 */
export const getSpendConcentration = async (userId, days = null, customRange = null) => {
  const priceHistory = await getMaterialPriceHistory(userId, days, customRange);

  if (priceHistory.length === 0) {
    return { materials: [], summary: null };
  }

  const quantityField = detectQuantityField(priceHistory[0]);
  if (!quantityField) {
    return { materials: [], summary: null };
  }

  // Group by material_id, accumulate spend
  const materialSpendMap = {};
  priceHistory.forEach(record => {
    const matId = record.material_id;
    const qty = parseFloat(record[quantityField]) || 0;
    const price = parseFloat(record.unit_price) || 0;
    const spend = qty * price;

    if (!materialSpendMap[matId]) {
      materialSpendMap[matId] = {
        material_id: matId,
        material_code: record.materials?.material_code || 'N/A',
        material_name: record.materials?.material_name || 'N/A',
        category: record.materials?.category || 'N/A',
        totalSpend: 0
      };
    }
    materialSpendMap[matId].totalSpend += spend;
  });

  const sorted = Object.values(materialSpendMap)
    .sort((a, b) => b.totalSpend - a.totalSpend);

  const grandTotal = sorted.reduce((sum, m) => sum + m.totalSpend, 0);

  // Compute cumulative shares and assign ABC class
  let cumulative = 0;
  const materials = sorted.map(mat => {
    const spendShare = grandTotal > 0 ? (mat.totalSpend / grandTotal) * 100 : 0;
    cumulative += spendShare;
    const abcClass = cumulative <= 80 ? 'A' : cumulative <= 95 ? 'B' : 'C';
    return { ...mat, spendShare, cumulativeShare: cumulative, abcClass };
  });

  // Build summary
  const groups = { A: { count: 0, totalSpend: 0 }, B: { count: 0, totalSpend: 0 }, C: { count: 0, totalSpend: 0 } };
  materials.forEach(m => {
    groups[m.abcClass].count += 1;
    groups[m.abcClass].totalSpend += m.totalSpend;
  });

  const summary = {
    grandTotal,
    classA: { ...groups.A, pct: grandTotal > 0 ? (groups.A.totalSpend / grandTotal) * 100 : 0 },
    classB: { ...groups.B, pct: grandTotal > 0 ? (groups.B.totalSpend / grandTotal) * 100 : 0 },
    classC: { ...groups.C, pct: grandTotal > 0 ? (groups.C.totalSpend / grandTotal) * 100 : 0 }
  };

  return { materials, summary };
};

/**
 * Get materials list (materials with price records)
 * @param {string} userId - User ID
 * @param {number|null} days - Number of days
 * @param {Object|null} customRange - Custom date range
 * @returns {Promise<Array>} Materials list
 */
export const getMaterialsWithPrices = async (userId, days = null, customRange = null) => {
  const priceHistory = await getMaterialPriceHistory(userId, days, customRange);

  const materialMap = {};
  priceHistory.forEach(record => {
    const matId = record.material_id;
    if (!materialMap[matId] && record.materials) {
      materialMap[matId] = {
        id: matId,
        material_code: record.materials.material_code,
        material_name: record.materials.material_name,
        category: record.materials.category,
        uom: record.materials.uom
      };
    }
  });

  return Object.values(materialMap).sort((a, b) =>
    a.material_code.localeCompare(b.material_code)
  );
};

/**
 * Get price trend for a single material
 * @param {string} userId - User ID
 * @param {string} materialId - Material ID
 * @param {number} days - Number of days
 * @returns {Promise<Object>} Price trend data
 */
export const getMaterialPriceTrend = async (userId, materialId, days = null, customRange = null) => {
  let startDate, endDate;

  if (customRange && customRange.startDate && customRange.endDate) {
    startDate = customRange.startDate;
    endDate = customRange.endDate;
  } else {
    const daysToUse = days || 30;
    endDate = new Date();
    startDate = new Date();
    startDate.setDate(startDate.getDate() - daysToUse);
  }

  const startDateStr = typeof startDate === 'string' ? startDate : startDate.toISOString().split('T')[0];
  const endDateStr = typeof endDate === 'string' ? endDate : endDate.toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('price_history')
    .select(`
      *,
      materials (
        material_code,
        material_name,
        category,
        uom
      ),
      suppliers (
        supplier_code,
        supplier_name
      )
    `)
    .eq('user_id', userId)
    .eq('material_id', materialId)
    .gte('order_date', startDateStr)
    .lte('order_date', endDateStr)
    .order('order_date', { ascending: true });

  if (error) throw error;

  if (!data || data.length === 0) {
    return {
      dates: [],
      prices: [],
      suppliers: [],
      summary: null,
      dynamicYAxis: null
    };
  }

  const dates = data.map(r => r.order_date);
  const prices = data.map(r => parseFloat(r.unit_price));
  const suppliers = data.map(r => r.suppliers?.supplier_name || 'N/A');

  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const volatility = avgPrice > 0 ? ((maxPrice - minPrice) / avgPrice) * 100 : 0;

  const changePercent = prices.length > 1
    ? ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100
    : 0;

  // Calculate dynamic Y-axis range for better visualization
  const dynamicYAxis = calculateDynamicYAxis(minPrice, maxPrice);

  return {
    dates,
    prices,
    suppliers,
    summary: {
      minPrice,
      maxPrice,
      avgPrice,
      volatility,
      changePercent,
      latestPrice: prices[prices.length - 1],
      oldestPrice: prices[0]
    },
    dynamicYAxis
  };
};

/**
 * Calculate dynamic Y-axis range for better chart readability
 * @param {number} minPrice - Minimum price
 * @param {number} maxPrice - Maximum price
 * @returns {Object} { min, max }
 */
const calculateDynamicYAxis = (minPrice, maxPrice) => {
  if (minPrice === maxPrice) {
    // When prices are the same, create a small range
    return {
      min: minPrice * 0.98,
      max: maxPrice * 1.02
    };
  }
  
  // When prices vary, add 2% buffer
  return {
    min: minPrice * 0.98,
    max: maxPrice * 1.02
  };
};

/**
 * Get Top Movers (materials with largest price changes)
 * @param {string} userId - User ID
 * @param {number} days - Number of days
 * @returns {Promise<Array>} Top Movers list
 */
export const getTopMovers = async (userId, days = null, customRange = null) => {
  const priceHistory = await getMaterialPriceHistory(userId, days, customRange);

  if (priceHistory.length === 0) {
    return [];
  }

  // Group by material_id
  const materialGroups = {};
  priceHistory.forEach(record => {
    const matId = record.material_id;
    if (!materialGroups[matId]) {
      materialGroups[matId] = {
        material_id: matId,
        material_code: record.materials?.material_code || 'N/A',
        material_name: record.materials?.material_name || 'N/A',
        category: record.materials?.category || 'N/A',
        uom: record.materials?.uom || 'pcs',
        prices: [],
        suppliers: new Set()
      };
    }
    materialGroups[matId].prices.push({
      date: record.order_date,
      price: parseFloat(record.unit_price),
      currency: record.currency
    });
    if (record.suppliers?.supplier_name) {
      materialGroups[matId].suppliers.add(record.suppliers.supplier_name);
    }
  });

  // Calculate statistics for each material
  const movers = Object.values(materialGroups).map(mat => {
    mat.prices.sort((a, b) => new Date(a.date) - new Date(b.date));

    const prices = mat.prices.map(p => p.price);
    const oldestPrice = prices[0];
    const latestPrice = prices[prices.length - 1];
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

    const changeAbs = latestPrice - oldestPrice;
    const changePercent = (changeAbs / oldestPrice) * 100;
    const volatility = avgPrice > 0 ? ((maxPrice - minPrice) / avgPrice) * 100 : 0;

    return {
      material_id: mat.material_id,
      material_code: mat.material_code,
      material_name: mat.material_name,
      category: mat.category,
      uom: mat.uom,
      oldestPrice,
      latestPrice,
      changeAbs,
      changePercent,
      volatility,
      supplierCount: mat.suppliers.size,
      currency: mat.prices[0].currency
    };
  });

  // Sort by absolute change percentage (descending)
  return movers.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
};

/**
 * Get supplier comparison for a single material
 * @param {string} userId - User ID
 * @param {string} materialId - Material ID
 * @param {number} days - Number of days
 * @returns {Promise<Array>} Supplier comparison list
 */
export const getSupplierComparison = async (userId, materialId, days = null, customRange = null) => {
  let startDate, endDate;

  if (customRange && customRange.startDate && customRange.endDate) {
    startDate = customRange.startDate;
    endDate = customRange.endDate;
  } else {
    const daysToUse = days || 30;
    endDate = new Date();
    startDate = new Date();
    startDate.setDate(startDate.getDate() - daysToUse);
  }

  const startDateStr = typeof startDate === 'string' ? startDate : startDate.toISOString().split('T')[0];
  const endDateStr = typeof endDate === 'string' ? endDate : endDate.toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('price_history')
    .select(`
      *,
      suppliers (
        supplier_code,
        supplier_name
      )
    `)
    .eq('user_id', userId)
    .eq('material_id', materialId)
    .gte('order_date', startDateStr)
    .lte('order_date', endDateStr)
    .order('order_date', { ascending: true });

  if (error) throw error;

  if (!data || data.length === 0) {
    return [];
  }

  // Group by supplier
  const supplierGroups = {};
  data.forEach(record => {
    const suppId = record.supplier_id;
    const suppName = record.suppliers?.supplier_name || 'Unknown';
    
    if (!supplierGroups[suppId]) {
      supplierGroups[suppId] = {
        supplier_id: suppId,
        supplier_name: suppName,
        supplier_code: record.suppliers?.supplier_code || 'N/A',
        prices: []
      };
    }
    
    supplierGroups[suppId].prices.push({
      date: record.order_date,
      price: parseFloat(record.unit_price),
      currency: record.currency
    });
  });

  // Calculate statistics for each supplier
  const comparison = Object.values(supplierGroups).map(supp => {
    supp.prices.sort((a, b) => new Date(a.date) - new Date(b.date));

    const prices = supp.prices.map(p => p.price);
    const latestPrice = prices[prices.length - 1];
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const changePercent = prices.length > 1
      ? ((latestPrice - prices[0]) / prices[0]) * 100
      : 0;

    return {
      supplier_id: supp.supplier_id,
      supplier_name: supp.supplier_name,
      supplier_code: supp.supplier_code,
      latestPrice,
      avgPrice,
      changePercent,
      lastDate: supp.prices[supp.prices.length - 1].date,
      currency: supp.prices[0].currency
    };
  });

  // Sort by latest price ascending (cheapest first)
  return comparison.sort((a, b) => a.latestPrice - b.latestPrice);
};

/**
 * Check data coverage
 * @param {string} userId - User ID
 * @param {number} days - Number of days
 * @returns {Promise<Object>} Data coverage report
 */
export const checkDataCoverage = async (userId, days = null, customRange = null) => {
  const priceHistory = await getMaterialPriceHistory(userId, days, customRange);

  if (priceHistory.length === 0) {
    return {
      hasPriceData: false,
      totalRecords: 0,
      missingFields: [],
      coverage: {
        material_code: 0,
        supplier_name: 0,
        order_date: 100,
        unit_price: 100,
        currency: 0
      },
      recommendations: [
        'No material price data found for the selected period.',
        'Go to Data Upload page (External Systems) to upload price history data.',
        'Required columns: MaterialCode, SupplierName, OrderDate, UnitPrice, Currency'
      ]
    };
  }

  const totalRecords = priceHistory.length;
  const missingFields = [];

  // Check coverage for each field
  const materialCodeCoverage = (priceHistory.filter(r => r.materials?.material_code).length / totalRecords) * 100;
  const supplierNameCoverage = (priceHistory.filter(r => r.suppliers?.supplier_name).length / totalRecords) * 100;
  const currencyCoverage = (priceHistory.filter(r => r.currency).length / totalRecords) * 100;
  
  // Check quantity field
  const quantityField = detectQuantityField(priceHistory[0]);
  const hasQuantityData = quantityField !== null;
  let quantityCoverage = 0;
  if (hasQuantityData) {
    quantityCoverage = (priceHistory.filter(r => r[quantityField] != null && r[quantityField] > 0).length / totalRecords) * 100;
  }

  if (materialCodeCoverage < 90) {
    missingFields.push('material_code');
  }
  if (supplierNameCoverage < 90) {
    missingFields.push('supplier_name');
  }
  if (currencyCoverage < 90) {
    missingFields.push('currency');
  }
  if (!hasQuantityData) {
    missingFields.push('quantity');
  }

  const recommendations = [];
  if (missingFields.length > 0) {
    recommendations.push(`Some fields have low coverage: ${missingFields.join(', ')}`);
    recommendations.push('Go to Data Upload page to re-upload data with complete information.');
    if (!hasQuantityData) {
      recommendations.push('⚠️ Quantity data is missing. Upload data with Quantity/Qty/OrderQty column to enable spend analysis.');
    }
  } else {
    recommendations.push('✓ Your data looks good for Material Cost analysis.');
  }

  return {
    hasPriceData: true,
    totalRecords,
    missingFields,
    coverage: {
      material_code: materialCodeCoverage,
      supplier_name: supplierNameCoverage,
      order_date: 100,
      unit_price: 100,
      currency: currencyCoverage,
      quantity: quantityCoverage
    },
    hasQuantityData,
    recommendations
  };
};

/**
 * Generate context summary for AI analysis
 * @param {string} userId - User ID
 * @param {number} days - Number of days
 * @returns {Promise<Object>} AI context summary
 */
export const generateAIContext = async (userId, days = null, customRange = null) => {
  const topMovers = await getTopMovers(userId, days, customRange);
  const kpis = await getMaterialCostKPIs(userId, days, customRange);

  // Take top 10 movers
  const topIncreasers = topMovers.filter(m => m.changePercent > 0).slice(0, 5);
  const topDecreasers = topMovers.filter(m => m.changePercent < 0).slice(0, 5);
  const highVolatility = topMovers.filter(m => m.volatility > 15).slice(0, 5);

  return {
    period: `${days} days`,
    kpis,
    topIncreasers: topIncreasers.map(m => ({
      material: `${m.material_code} - ${m.material_name}`,
      changePercent: m.changePercent.toFixed(2),
      oldPrice: m.oldestPrice.toFixed(2),
      newPrice: m.latestPrice.toFixed(2)
    })),
    topDecreasers: topDecreasers.map(m => ({
      material: `${m.material_code} - ${m.material_name}`,
      changePercent: m.changePercent.toFixed(2),
      oldPrice: m.oldestPrice.toFixed(2),
      newPrice: m.latestPrice.toFixed(2)
    })),
    highVolatility: highVolatility.map(m => ({
      material: `${m.material_code} - ${m.material_name}`,
      volatility: m.volatility.toFixed(2),
      avgPrice: ((m.oldestPrice + m.latestPrice) / 2).toFixed(2)
    }))
  };
};

/**
 * Detect price anomalies across material price history
 * Uses statistical deviation (sigma) and period-over-period change detection
 * @param {string} userId
 * @param {number|null} days
 * @param {Object|null} customRange
 * @returns {Promise<Array>} Anomaly records sorted by severity
 */
export const detectPriceAnomalies = async (userId, days = null, customRange = null) => {
  const priceHistory = await getMaterialPriceHistory(userId, days, customRange);

  if (priceHistory.length === 0) {
    return [];
  }

  // Group by material_id
  const materialGroups = {};
  priceHistory.forEach(record => {
    const matId = record.material_id;
    if (!materialGroups[matId]) {
      materialGroups[matId] = {
        material_code: record.materials?.material_code || 'N/A',
        material_name: record.materials?.material_name || 'N/A',
        records: []
      };
    }
    materialGroups[matId].records.push({
      supplier_name: record.suppliers?.supplier_name || 'Unknown',
      order_date: record.order_date,
      unit_price: parseFloat(record.unit_price)
    });
  });

  const anomalies = [];

  Object.entries(materialGroups).forEach(([matId, group]) => {
    const records = group.records.sort((a, b) => new Date(a.order_date) - new Date(b.order_date));

    if (records.length < 3) return; // Need minimum data points

    const prices = records.map(r => r.unit_price);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
    const stddev = Math.sqrt(variance);

    if (stddev === 0) return; // All prices identical

    let consecutiveIncreases = 0;
    let cumulativeIncreasePct = 0;

    records.forEach((record, i) => {
      const deviationFromMean = Math.abs(record.unit_price - mean);
      const sigmaCount = deviationFromMean / stddev;
      const deviationPct = mean > 0 ? ((record.unit_price - mean) / mean) * 100 : 0;

      let pctChange = 0;
      if (i > 0) {
        const prevPrice = records[i - 1].unit_price;
        pctChange = prevPrice > 0 ? ((record.unit_price - prevPrice) / prevPrice) * 100 : 0;
      }

      // Track consecutive increases
      if (pctChange > 0) {
        consecutiveIncreases++;
        cumulativeIncreasePct += pctChange;
      } else {
        consecutiveIncreases = 0;
        cumulativeIncreasePct = 0;
      }

      const isStatOutlier = sigmaCount > 1.5;
      const isSuddenJump = Math.abs(pctChange) > 15;
      const isPersistentIncrease = consecutiveIncreases >= 3 && cumulativeIncreasePct > 20;

      if (!isStatOutlier && !isSuddenJump && !isPersistentIncrease) return;

      // Determine anomaly_type
      let anomaly_type = 'outlier';
      if (isPersistentIncrease) {
        anomaly_type = 'persistent_increase';
      } else if (record.unit_price > mean && pctChange > 15) {
        anomaly_type = 'spike';
      } else if (record.unit_price < mean && pctChange < -15) {
        anomaly_type = 'drop';
      }

      // Determine severity
      let severity = 'low';
      if (sigmaCount > 3 || Math.abs(pctChange) > 30) {
        severity = 'high';
      } else if (sigmaCount > 2 || Math.abs(pctChange) > 20) {
        severity = 'medium';
      }

      anomalies.push({
        material_code: group.material_code,
        material_name: group.material_name,
        material_id: matId,
        supplier_name: record.supplier_name,
        order_date: record.order_date,
        unit_price: record.unit_price,
        expected_price: parseFloat(mean.toFixed(4)),
        deviation_pct: parseFloat(deviationPct.toFixed(2)),
        anomaly_type,
        severity
      });
    });
  });

  // Sort: high first, then medium, then low; within same severity, by date desc
  const severityOrder = { high: 0, medium: 1, low: 2 };
  anomalies.sort((a, b) => {
    if (severityOrder[a.severity] !== severityOrder[b.severity]) {
      return severityOrder[a.severity] - severityOrder[b.severity];
    }
    return new Date(b.order_date) - new Date(a.order_date);
  });

  return anomalies;
};

/**
 * Supplier Spend Concentration Analysis
 * Groups spend by supplier with HHI concentration index
 * @param {string} userId
 * @param {number|null} days
 * @param {Object|null} customRange
 * @returns {Promise<Object>} { suppliers, concentration }
 */
export const getSupplierSpendConcentration = async (userId, days = null, customRange = null) => {
  const priceHistory = await getMaterialPriceHistory(userId, days, customRange);

  if (priceHistory.length === 0) {
    return { suppliers: [], concentration: null };
  }

  const quantityField = detectQuantityField(priceHistory[0]);
  if (!quantityField) {
    return { suppliers: [], concentration: null };
  }

  // Group by supplier_id
  const supplierMap = {};
  priceHistory.forEach(record => {
    const suppId = record.supplier_id;
    const qty = parseFloat(record[quantityField]) || 0;
    const price = parseFloat(record.unit_price) || 0;
    const spend = qty * price;

    if (!supplierMap[suppId]) {
      supplierMap[suppId] = {
        supplier_id: suppId,
        supplier_name: record.suppliers?.supplier_name || 'Unknown',
        supplier_code: record.suppliers?.supplier_code || 'N/A',
        totalSpend: 0,
        materialIds: new Set(),
        prices: []
      };
    }
    supplierMap[suppId].totalSpend += spend;
    supplierMap[suppId].materialIds.add(record.material_id);
    supplierMap[suppId].prices.push(price);
  });

  const sorted = Object.values(supplierMap)
    .sort((a, b) => b.totalSpend - a.totalSpend);

  const grandTotal = sorted.reduce((sum, s) => sum + s.totalSpend, 0);

  const suppliers = sorted.map(s => {
    const spendShare = grandTotal > 0 ? (s.totalSpend / grandTotal) * 100 : 0;
    // Avg price change: compare first half avg to second half avg
    const mid = Math.floor(s.prices.length / 2);
    const firstHalfAvg = mid > 0 ? s.prices.slice(0, mid).reduce((a, b) => a + b, 0) / mid : 0;
    const secondHalfAvg = (s.prices.length - mid) > 0
      ? s.prices.slice(mid).reduce((a, b) => a + b, 0) / (s.prices.length - mid)
      : 0;
    const avgPriceChange = firstHalfAvg > 0 ? ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100 : 0;

    return {
      supplier_id: s.supplier_id,
      supplier_name: s.supplier_name,
      supplier_code: s.supplier_code,
      totalSpend: s.totalSpend,
      spendShare,
      materialCount: s.materialIds.size,
      avgPriceChange
    };
  });

  // Concentration metrics
  const shares = suppliers.map(s => s.spendShare);
  const top1_pct = shares[0] || 0;
  const top3_pct = shares.slice(0, 3).reduce((a, b) => a + b, 0);
  const top5_pct = shares.slice(0, 5).reduce((a, b) => a + b, 0);
  const hhi = shares.reduce((sum, s) => sum + Math.pow(s, 2), 0);
  const riskLevel = hhi > 2500 ? 'high' : hhi > 1500 ? 'medium' : 'low';

  return {
    suppliers,
    concentration: {
      top1_pct,
      top3_pct,
      top5_pct,
      hhi: parseFloat(hhi.toFixed(0)),
      riskLevel
    }
  };
};

export default {
  getMaterialPriceHistory,
  getMaterialCostKPIs,
  getMaterialsWithPrices,
  getMaterialPriceTrend,
  getTopMovers,
  getSupplierComparison,
  getTopBySpend,
  checkDataCoverage,
  generateAIContext,
  getSpendConcentration,
  detectPriceAnomalies,
  getSupplierSpendConcentration
};

