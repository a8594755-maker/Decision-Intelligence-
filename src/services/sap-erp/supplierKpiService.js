/**
 * Supplier KPI Service
 * Supplier KPI service - query and analyze supplier performance metrics
 */

import { supabase } from '../infra/supabaseClient';

/**
 * Get supplier KPI summary data
 * @param {string} userId - User ID
 * @param {string} supplierId - Supplier ID (optional, returns all suppliers if not provided)
 * @returns {Promise<Array|Object>} KPI summary data
 */
export const getSupplierKpiSummary = async (userId, supplierId = null) => {
  let query = supabase
    .from('supplier_kpi_summary')
    .select('*')
    .eq('user_id', userId);

  if (supplierId) {
    query = query.eq('supplier_id', supplierId);
    const { data, error } = await query.single();
    if (error) {
      if (error.code === 'PGRST116') {
        return null; // No data found
      }
      throw error;
    }
    return data;
  }

  const { data, error } = await query.order('overall_score', { ascending: false });
  if (error) throw error;
  return data || [];
};

/**
 * Get supplier defect rate statistics
 * @param {string} userId - User ID
 * @param {string} supplierId - Supplier ID (optional)
 * @param {number} days - Statistics period in days (default 90)
 * @returns {Promise<Array|Object>} Defect rate statistics data
 */
export const getDefectStats = async (userId, supplierId = null, days = 90) => {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  let query = supabase
    .from('supplier_defect_stats')
    .select('*')
    .eq('user_id', userId);

  if (supplierId) {
    query = query.eq('supplier_id', supplierId);
    const { data, error } = await query.single();
    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw error;
    }
    return data;
  }

  const { data, error } = await query.order('defect_rate_percent', { ascending: false });
  if (error) throw error;
  return data || [];
};

/**
 * Get supplier on-time delivery statistics
 * @param {string} userId - User ID
 * @param {string} supplierId - Supplier ID (optional)
 * @param {number} days - Statistics period in days (default 90)
 * @returns {Promise<Array|Object>} On-time delivery statistics data
 */
export const getDeliveryStats = async (userId, supplierId = null, days = 90) => {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  let query = supabase
    .from('supplier_delivery_stats')
    .select('*')
    .eq('user_id', userId);

  if (supplierId) {
    query = query.eq('supplier_id', supplierId);
    const { data, error } = await query.single();
    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw error;
    }
    return data;
  }

  const { data, error } = await query.order('on_time_rate_percent', { ascending: false });
  if (error) throw error;
  return data || [];
};

/**
 * Get supplier price volatility statistics
 * @param {string} userId - User ID
 * @param {string} supplierId - Supplier ID (optional)
 * @param {string} materialId - Material ID (optional)
 * @returns {Promise<Array|Object>} Price volatility data
 */
export const getPriceVolatility = async (userId, supplierId = null, materialId = null) => {
  let query = supabase
    .from('supplier_price_volatility')
    .select('*')
    .eq('user_id', userId);

  if (supplierId) {
    query = query.eq('supplier_id', supplierId);
  }

  if (materialId) {
    query = query.eq('material_id', materialId);
  }

  // If both supplierId and materialId specified, return single record
  if (supplierId && materialId) {
    const { data, error } = await query.single();
    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw error;
    }
    return data;
  }

  const { data, error } = await query.order('volatility_percent', { ascending: false });
  if (error) throw error;
  return data || [];
};

/**
 * Get supplier detailed goods receipt records
 * @param {string} userId - User ID
 * @param {string} supplierId - Supplier ID
 * @param {object} options - Optional parameters { startDate, endDate, limit, offset }
 * @returns {Promise<Array>} Goods receipt record list
 */
export const getGoodsReceipts = async (userId, supplierId, options = {}) => {
  const { startDate, endDate, limit = 50, offset = 0 } = options;

  let query = supabase
    .from('goods_receipts')
    .select('*, materials(material_code, material_name), suppliers(supplier_name)')
    .eq('user_id', userId)
    .eq('supplier_id', supplierId)
    .order('actual_delivery_date', { ascending: false })
    .range(offset, offset + limit - 1);

  if (startDate) {
    query = query.gte('actual_delivery_date', startDate);
  }

  if (endDate) {
    query = query.lte('actual_delivery_date', endDate);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

/**
 * Get supplier price history
 * @param {string} userId - User ID
 * @param {string} supplierId - Supplier ID
 * @param {string} materialId - Material ID (optional)
 * @param {number} months - Number of recent months to fetch (default 6)
 * @returns {Promise<Array>} Price history records
 */
export const getPriceHistory = async (userId, supplierId, materialId = null, months = 6) => {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);

  let query = supabase
    .from('price_history')
    .select('*, materials(material_code, material_name), suppliers(supplier_name)')
    .eq('user_id', userId)
    .eq('supplier_id', supplierId)
    .gte('order_date', startDate.toISOString().split('T')[0])
    .order('order_date', { ascending: true });

  if (materialId) {
    query = query.eq('material_id', materialId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

/**
 * Get supplier KPI trend data (monthly)
 * @param {string} userId - User ID
 * @param {string} supplierId - Supplier ID
 * @param {number} months - Number of recent months (default 12)
 * @returns {Promise<Object>} Trend data
 */
export const getKpiTrends = async (userId, supplierId, months = 12) => {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);

  // Get goods receipt records
  const { data: receipts, error } = await supabase
    .from('goods_receipts')
    .select('actual_delivery_date, defect_rate, is_on_time, received_qty, rejected_qty')
    .eq('user_id', userId)
    .eq('supplier_id', supplierId)
    .gte('actual_delivery_date', startDate.toISOString().split('T')[0])
    .order('actual_delivery_date', { ascending: true });

  if (error) throw error;

  if (!receipts || receipts.length === 0) {
    return {
      months: [],
      defectRates: [],
      onTimeRates: [],
      receivedQtys: []
    };
  }

  // Group statistics by month
  const monthlyData = {};

  receipts.forEach(r => {
    const monthKey = r.actual_delivery_date.substring(0, 7); // YYYY-MM

    if (!monthlyData[monthKey]) {
      monthlyData[monthKey] = {
        totalReceived: 0,
        totalRejected: 0,
        totalShipments: 0,
        onTimeShipments: 0
      };
    }

    const month = monthlyData[monthKey];
    month.totalReceived += parseFloat(r.received_qty) || 0;
    month.totalRejected += parseFloat(r.rejected_qty) || 0;
    month.totalShipments += 1;
    if (r.is_on_time) {
      month.onTimeShipments += 1;
    }
  });

  // Convert to array format
  const monthKeys = Object.keys(monthlyData).sort();
  const defectRates = monthKeys.map(m => {
    const data = monthlyData[m];
    return data.totalReceived > 0
      ? ((data.totalRejected / data.totalReceived) * 100).toFixed(2)
      : 0;
  });
  const onTimeRates = monthKeys.map(m => {
    const data = monthlyData[m];
    return data.totalShipments > 0
      ? ((data.onTimeShipments / data.totalShipments) * 100).toFixed(2)
      : 0;
  });
  const receivedQtys = monthKeys.map(m => monthlyData[m].totalReceived);

  return {
    months: monthKeys,
    defectRates: defectRates.map(parseFloat),
    onTimeRates: onTimeRates.map(parseFloat),
    receivedQtys
  };
};

/**
 * Filter suppliers by risk level
 * @param {string} userId - User ID
 * @param {string} riskLevel - Risk level (low, medium, high)
 * @returns {Promise<Array>} Supplier list
 */
export const getSuppliersByRisk = async (userId, riskLevel) => {
  const { data, error } = await supabase
    .from('supplier_kpi_summary')
    .select('*')
    .eq('user_id', userId)
    .eq('risk_level', riskLevel)
    .order('overall_score', { ascending: false });

  if (error) throw error;
  return data || [];
};

/**
 * Get worst performing suppliers (for alerts)
 * @param {string} userId - User ID
 * @param {object} thresholds - Threshold settings
 * @returns {Promise<Array>} Suppliers requiring attention
 */
export const getAnomalousSuppliers = async (userId, thresholds = {}) => {
  const {
    maxDefectRate = 5,        // Defect rate > 5%
    minOnTimeRate = 90,       // On-time rate < 90%
    maxPriceVolatility = 15   // Price volatility > 15%
  } = thresholds;

  const { data, error } = await supabase
    .from('supplier_kpi_summary')
    .select('*')
    .eq('user_id', userId)
    .or(`defect_rate.gt.${maxDefectRate},on_time_rate.lt.${minOnTimeRate},max_price_volatility.gt.${maxPriceVolatility}`)
    .order('overall_score', { ascending: true });

  if (error) throw error;

  // Annotate specific issues for each supplier
  const anomalies = (data || []).map(supplier => {
    const issues = [];

    if (supplier.defect_rate > maxDefectRate) {
      issues.push({
        type: 'high_defect_rate',
        severity: 'high',
        message: `Defect rate ${supplier.defect_rate.toFixed(2)}% exceeds threshold ${maxDefectRate}%`,
        value: supplier.defect_rate,
        threshold: maxDefectRate
      });
    }

    if (supplier.on_time_rate < minOnTimeRate) {
      issues.push({
        type: 'low_on_time_rate',
        severity: 'high',
        message: `On-time rate ${supplier.on_time_rate.toFixed(2)}% below threshold ${minOnTimeRate}%`,
        value: supplier.on_time_rate,
        threshold: minOnTimeRate
      });
    }

    if (supplier.max_price_volatility > maxPriceVolatility) {
      issues.push({
        type: 'high_price_volatility',
        severity: 'medium',
        message: `Price volatility ${supplier.max_price_volatility.toFixed(2)}% exceeds threshold ${maxPriceVolatility}%`,
        value: supplier.max_price_volatility,
        threshold: maxPriceVolatility
      });
    }

    return {
      ...supplier,
      issues
    };
  });

  return anomalies;
};

/**
 * Get supplier comprehensive comparison data (for ranking)
 * @param {string} userId - User ID
 * @param {number} limit - Return count (default top 10)
 * @returns {Promise<Array>} Ranking list
 */
export const getSupplierRankings = async (userId, limit = 10) => {
  const { data, error } = await supabase
    .from('supplier_kpi_summary')
    .select('*')
    .eq('user_id', userId)
    .order('overall_score', { ascending: false })
    .limit(limit);

  if (error) throw error;

  // Add ranking information
  return (data || []).map((supplier, index) => ({
    ...supplier,
    rank: index + 1
  }));
};

export default {
  getSupplierKpiSummary,
  getDefectStats,
  getDeliveryStats,
  getPriceVolatility,
  getGoodsReceipts,
  getPriceHistory,
  getKpiTrends,
  getSuppliersByRisk,
  getAnomalousSuppliers,
  getSupplierRankings
};
