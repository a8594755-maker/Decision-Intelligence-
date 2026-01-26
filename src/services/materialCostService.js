/**
 * Material Cost Service
 * 材料成本分析服務 - 處理材料價格歷史和成本分析
 */

import { supabase } from './supabaseClient';

/**
 * 獲取指定期間的材料價格數據
 * @param {string} userId - 用戶 ID
 * @param {number|null} days - 天數（30/90/180/365）如果提供
 * @param {Object|null} customRange - 自定義日期範圍 { startDate, endDate }
 * @returns {Promise<Array>} 價格歷史記錄
 */
export const getMaterialPriceHistory = async (userId, days = null, customRange = null) => {
  let startDate, endDate;

  if (customRange && customRange.startDate && customRange.endDate) {
    // 使用自定義日期範圍
    startDate = customRange.startDate;
    endDate = customRange.endDate;
  } else {
    // 使用天數計算
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
 * 獲取 KPI 數據
 * @param {string} userId - 用戶 ID
 * @param {number|null} days - 天數
 * @param {Object|null} customRange - 自定義日期範圍
 * @returns {Promise<Object>} KPI 統計
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

  // 檢測 quantity 欄位是否存在
  const quantityField = detectQuantityField(priceHistory[0]);
  const hasQuantityData = quantityField !== null;

  // 計算總支出（如果有 quantity 數據）
  let totalMaterialSpend = null;
  if (hasQuantityData) {
    totalMaterialSpend = priceHistory.reduce((sum, record) => {
      const qty = parseFloat(record[quantityField]) || 0;
      const price = parseFloat(record.unit_price) || 0;
      return sum + (qty * price);
    }, 0);
  }

  // 按 material_id 分組
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

  // 計算每個材料的價格變化
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

  // KPI 1: 有價格數據的材料總數
  const totalMaterials = Object.keys(materialGroups).length;

  // KPI 2: 平均價格變化百分比
  const avgPriceChange = materialStats.length > 0
    ? materialStats.reduce((sum, s) => sum + s.changePercent, 0) / materialStats.length
    : 0;

  // KPI 3: 漲幅最大的材料
  const topIncreaseMaterial = materialStats.length > 0
    ? materialStats.reduce((max, current) =>
        current.changePercent > max.changePercent ? current : max
      )
    : null;

  // KPI 4: 高波動性材料數量 (volatility > 15%)
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
 * 檢測 quantity 欄位名稱
 * @param {Object} record - 單筆記錄
 * @returns {string|null} quantity 欄位名稱或 null
 */
const detectQuantityField = (record) => {
  if (!record) return null;
  
  const possibleFields = ['quantity', 'qty', 'order_qty', 'orderQty', 'order_quantity'];
  
  for (const field of possibleFields) {
    if (record.hasOwnProperty(field) && record[field] != null) {
      return field;
    }
  }
  
  return null;
};

/**
 * 獲取按支出排序的材料列表
 * @param {string} userId - 用戶 ID
 * @param {number|null} days - 天數
 * @param {Object|null} customRange - 自定義日期範圍
 * @param {number} limit - 返回數量限制
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

  // 按 material_id 分組並計算支出
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

  // 計算每個材料的統計數據
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

  // 按總支出降序排序
  materialsWithSpend.sort((a, b) => b.totalSpend - a.totalSpend);
  
  return materialsWithSpend.slice(0, limit);
};

/**
 * 獲取材料列表（有價格記錄的材料）
 * @param {string} userId - 用戶 ID
 * @param {number|null} days - 天數
 * @param {Object|null} customRange - 自定義日期範圍
 * @returns {Promise<Array>} 材料列表
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
 * 獲取單一材料的價格趨勢
 * @param {string} userId - 用戶 ID
 * @param {string} materialId - 材料 ID
 * @param {number} days - 天數
 * @returns {Promise<Object>} 價格趨勢數據
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
 * 計算動態 Y 軸範圍以使圖表更易讀
 * @param {number} minPrice - 最低價格
 * @param {number} maxPrice - 最高價格
 * @returns {Object} { min, max }
 */
const calculateDynamicYAxis = (minPrice, maxPrice) => {
  if (minPrice === maxPrice) {
    // 價格相同時，創建一個小範圍
    return {
      min: minPrice * 0.98,
      max: maxPrice * 1.02
    };
  }
  
  // 價格有變化時，添加 2% 的緩衝
  return {
    min: minPrice * 0.98,
    max: maxPrice * 1.02
  };
};

/**
 * 獲取 Top Movers（價格變化最大的材料）
 * @param {string} userId - 用戶 ID
 * @param {number} days - 天數
 * @returns {Promise<Array>} Top Movers 列表
 */
export const getTopMovers = async (userId, days = null, customRange = null) => {
  const priceHistory = await getMaterialPriceHistory(userId, days, customRange);

  if (priceHistory.length === 0) {
    return [];
  }

  // 按 material_id 分組
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

  // 計算每個材料的統計數據
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

  // 按絕對變化百分比排序（降序）
  return movers.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
};

/**
 * 獲取單一材料的供應商比較
 * @param {string} userId - 用戶 ID
 * @param {string} materialId - 材料 ID
 * @param {number} days - 天數
 * @returns {Promise<Array>} 供應商比較列表
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

  // 按供應商分組
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

  // 計算每個供應商的統計
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

  // 按最新價格排序（升序，便宜的在前）
  return comparison.sort((a, b) => a.latestPrice - b.latestPrice);
};

/**
 * 檢查數據覆蓋度
 * @param {string} userId - 用戶 ID
 * @param {number} days - 天數
 * @returns {Promise<Object>} 數據覆蓋度報告
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

  // 檢查每個欄位的覆蓋度
  const materialCodeCoverage = (priceHistory.filter(r => r.materials?.material_code).length / totalRecords) * 100;
  const supplierNameCoverage = (priceHistory.filter(r => r.suppliers?.supplier_name).length / totalRecords) * 100;
  const currencyCoverage = (priceHistory.filter(r => r.currency).length / totalRecords) * 100;
  
  // 檢查 quantity 欄位
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
 * 生成 AI 分析的上下文摘要
 * @param {string} userId - 用戶 ID
 * @param {number} days - 天數
 * @returns {Promise<Object>} AI 上下文摘要
 */
export const generateAIContext = async (userId, days = null, customRange = null) => {
  const topMovers = await getTopMovers(userId, days, customRange);
  const kpis = await getMaterialCostKPIs(userId, days, customRange);

  // 取前 10 個 Top Movers
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

export default {
  getMaterialPriceHistory,
  getMaterialCostKPIs,
  getMaterialsWithPrices,
  getMaterialPriceTrend,
  getTopMovers,
  getSupplierComparison,
  getTopBySpend,
  checkDataCoverage,
  generateAIContext
};

