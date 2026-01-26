/**
 * Supplier KPI Service
 * 供应商 KPI 服务 - 查询和分析供应商绩效指标
 */

import { supabase } from './supabaseClient';

/**
 * 获取供应商 KPI 汇总数据
 * @param {string} userId - 用户 ID
 * @param {string} supplierId - 供应商 ID (可选，不传则返回所有供应商)
 * @returns {Promise<Array|Object>} KPI 汇总数据
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
 * 获取供应商不良率统计
 * @param {string} userId - 用户 ID
 * @param {string} supplierId - 供应商 ID (可选)
 * @param {number} days - 统计天数 (默认 90 天)
 * @returns {Promise<Array|Object>} 不良率统计数据
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
 * 获取供应商准时交货统计
 * @param {string} userId - 用户 ID
 * @param {string} supplierId - 供应商 ID (可选)
 * @param {number} days - 统计天数 (默认 90 天)
 * @returns {Promise<Array|Object>} 准时交货统计数据
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
 * 获取供应商价格波动统计
 * @param {string} userId - 用户 ID
 * @param {string} supplierId - 供应商 ID (可选)
 * @param {string} materialId - 物料 ID (可选)
 * @returns {Promise<Array|Object>} 价格波动数据
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
 * 获取供应商详细收货记录
 * @param {string} userId - 用户 ID
 * @param {string} supplierId - 供应商 ID
 * @param {object} options - 可选参数 { startDate, endDate, limit, offset }
 * @returns {Promise<Array>} 收货记录列表
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
 * 获取供应商价格历史
 * @param {string} userId - 用户 ID
 * @param {string} supplierId - 供应商 ID
 * @param {string} materialId - 物料 ID (可选)
 * @param {number} months - 获取最近几个月的数据 (默认 6 个月)
 * @returns {Promise<Array>} 价格历史记录
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
 * 获取供应商 KPI 趋势数据（按月）
 * @param {string} userId - 用户 ID
 * @param {string} supplierId - 供应商 ID
 * @param {number} months - 最近几个月 (默认 12 个月)
 * @returns {Promise<Object>} 趋势数据
 */
export const getKpiTrends = async (userId, supplierId, months = 12) => {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);

  // 获取收货记录
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

  // 按月分组统计
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

  // 转换为数组格式
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
 * 根据风险等级筛选供应商
 * @param {string} userId - 用户 ID
 * @param {string} riskLevel - 风险等级 (low, medium, high)
 * @returns {Promise<Array>} 供应商列表
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
 * 获取最差表现的供应商（用于告警）
 * @param {string} userId - 用户 ID
 * @param {object} thresholds - 阈值设置
 * @returns {Promise<Array>} 需要关注的供应商列表
 */
export const getAnomalousSuppliers = async (userId, thresholds = {}) => {
  const {
    maxDefectRate = 5,        // 不良率 > 5%
    minOnTimeRate = 90,       // 准时率 < 90%
    maxPriceVolatility = 15   // 价格波动 > 15%
  } = thresholds;

  const { data, error } = await supabase
    .from('supplier_kpi_summary')
    .select('*')
    .eq('user_id', userId)
    .or(`defect_rate.gt.${maxDefectRate},on_time_rate.lt.${minOnTimeRate},max_price_volatility.gt.${maxPriceVolatility}`)
    .order('overall_score', { ascending: true });

  if (error) throw error;

  // 为每个供应商标注具体的问题
  const anomalies = (data || []).map(supplier => {
    const issues = [];

    if (supplier.defect_rate > maxDefectRate) {
      issues.push({
        type: 'high_defect_rate',
        severity: 'high',
        message: `不良率 ${supplier.defect_rate.toFixed(2)}% 超出阈值 ${maxDefectRate}%`,
        value: supplier.defect_rate,
        threshold: maxDefectRate
      });
    }

    if (supplier.on_time_rate < minOnTimeRate) {
      issues.push({
        type: 'low_on_time_rate',
        severity: 'high',
        message: `准时率 ${supplier.on_time_rate.toFixed(2)}% 低于阈值 ${minOnTimeRate}%`,
        value: supplier.on_time_rate,
        threshold: minOnTimeRate
      });
    }

    if (supplier.max_price_volatility > maxPriceVolatility) {
      issues.push({
        type: 'high_price_volatility',
        severity: 'medium',
        message: `价格波动 ${supplier.max_price_volatility.toFixed(2)}% 超出阈值 ${maxPriceVolatility}%`,
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
 * 获取供应商综合对比数据（用于排名）
 * @param {string} userId - 用户 ID
 * @param {number} limit - 返回数量 (默认前 10 名)
 * @returns {Promise<Array>} 排名列表
 */
export const getSupplierRankings = async (userId, limit = 10) => {
  const { data, error } = await supabase
    .from('supplier_kpi_summary')
    .select('*')
    .eq('user_id', userId)
    .order('overall_score', { ascending: false })
    .limit(limit);

  if (error) throw error;

  // 添加排名信息
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
