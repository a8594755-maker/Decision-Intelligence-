/**
 * Cost Analysis Service
 * 成本分析服务 - 处理营运成本记录、分析和异常检测
 */

import { supabase } from './supabaseClient';

/**
 * 记录每日营运成本
 * @param {string} userId - 用户 ID
 * @param {object} costData - 成本数据
 * @returns {Promise<object>} 保存的成本记录
 */
export const recordDailyCost = async (userId, costData) => {
  const {
    cost_date,
    direct_labor_hours,
    direct_labor_rate,
    indirect_labor_hours,
    indirect_labor_rate,
    production_output,
    production_unit = 'pcs',
    material_cost = 0,
    overhead_cost = 0,
    notes = ''
  } = costData;

  // 计算成本
  const direct_labor_cost = direct_labor_hours * direct_labor_rate;
  const indirect_labor_cost = indirect_labor_hours * indirect_labor_rate;
  const total_labor_cost = direct_labor_cost + indirect_labor_cost;
  const cost_per_unit = production_output > 0
    ? (total_labor_cost + material_cost + overhead_cost) / production_output
    : 0;

  const payload = {
    user_id: userId,
    cost_date,
    direct_labor_hours,
    direct_labor_rate,
    direct_labor_cost,
    indirect_labor_hours,
    indirect_labor_rate,
    indirect_labor_cost,
    total_labor_cost,
    production_output,
    production_unit,
    cost_per_unit,
    material_cost,
    overhead_cost,
    notes
  };

  // 使用 upsert 处理重复日期
  const { data, error } = await supabase
    .from('operational_costs')
    .upsert(payload, {
      onConflict: 'user_id,cost_date',
      returning: 'representation'
    })
    .select()
    .single();

  if (error) throw error;
  return data;
};

/**
 * 获取指定日期范围的成本记录
 * @param {string} userId - 用户 ID
 * @param {string} startDate - 开始日期 (YYYY-MM-DD)
 * @param {string} endDate - 结束日期 (YYYY-MM-DD)
 * @returns {Promise<Array>} 成本记录列表
 */
export const getCostRecords = async (userId, startDate, endDate) => {
  let query = supabase
    .from('operational_costs')
    .select('*')
    .eq('user_id', userId)
    .order('cost_date', { ascending: false });

  if (startDate) {
    query = query.gte('cost_date', startDate);
  }
  if (endDate) {
    query = query.lte('cost_date', endDate);
  }

  const { data, error } = await query;

  if (error) throw error;
  return data || [];
};

/**
 * 获取成本趋势数据
 * @param {string} userId - 用户 ID
 * @param {number} days - 过去多少天（默认 30 天）
 * @returns {Promise<object>} 趋势数据
 */
export const getCostTrends = async (userId, days = 30) => {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const records = await getCostRecords(
    userId,
    startDate.toISOString().split('T')[0],
    endDate.toISOString().split('T')[0]
  );

  if (records.length === 0) {
    return {
      dates: [],
      totalCosts: [],
      directCosts: [],
      indirectCosts: [],
      unitCosts: [],
      averages: {
        avgTotalCost: 0,
        avgDirectCost: 0,
        avgIndirectCost: 0,
        avgUnitCost: 0
      }
    };
  }

  // 按日期排序（升序）
  records.sort((a, b) => new Date(a.cost_date) - new Date(b.cost_date));

  const dates = records.map(r => r.cost_date);
  const totalCosts = records.map(r => parseFloat(r.total_labor_cost) || 0);
  const directCosts = records.map(r => parseFloat(r.direct_labor_cost) || 0);
  const indirectCosts = records.map(r => parseFloat(r.indirect_labor_cost) || 0);
  const unitCosts = records.map(r => parseFloat(r.cost_per_unit) || 0);

  // 计算平均值
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const avg = (arr) => arr.length > 0 ? sum(arr) / arr.length : 0;

  return {
    dates,
    totalCosts,
    directCosts,
    indirectCosts,
    unitCosts,
    averages: {
      avgTotalCost: avg(totalCosts),
      avgDirectCost: avg(directCosts),
      avgIndirectCost: avg(indirectCosts),
      avgUnitCost: avg(unitCosts)
    },
    records
  };
};

/**
 * 分析成本结构
 * @param {string} userId - 用户 ID
 * @param {string} date - 日期 (可选，默认今天)
 * @returns {Promise<object>} 成本结构分析
 */
export const analyzeCostStructure = async (userId, date = null) => {
  const targetDate = date || new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('operational_costs')
    .select('*')
    .eq('user_id', userId)
    .eq('cost_date', targetDate)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      // No data found
      return null;
    }
    throw error;
  }

  const totalCost = parseFloat(data.total_labor_cost) +
                   parseFloat(data.material_cost || 0) +
                   parseFloat(data.overhead_cost || 0);

  return {
    date: data.cost_date,
    breakdown: {
      directLabor: parseFloat(data.direct_labor_cost),
      indirectLabor: parseFloat(data.indirect_labor_cost),
      material: parseFloat(data.material_cost || 0),
      overhead: parseFloat(data.overhead_cost || 0)
    },
    percentages: {
      directLabor: totalCost > 0 ? (parseFloat(data.direct_labor_cost) / totalCost * 100) : 0,
      indirectLabor: totalCost > 0 ? (parseFloat(data.indirect_labor_cost) / totalCost * 100) : 0,
      material: totalCost > 0 ? (parseFloat(data.material_cost || 0) / totalCost * 100) : 0,
      overhead: totalCost > 0 ? (parseFloat(data.overhead_cost || 0) / totalCost * 100) : 0
    },
    totalCost,
    output: parseFloat(data.production_output),
    costPerUnit: parseFloat(data.cost_per_unit)
  };
};

/**
 * 检测成本异常
 * @param {string} userId - 用户 ID
 * @param {number} days - 检测过去多少天（默认 7 天）
 * @returns {Promise<Array>} 检测到的异常列表
 */
export const detectCostAnomalies = async (userId, days = 7) => {
  // 获取历史数据
  const trends = await getCostTrends(userId, 30); // 取30天用于计算基准

  if (trends.records.length < 7) {
    // 数据不足，无法检测异常
    return [];
  }

  const { averages, records } = trends;
  const recentRecords = records.slice(-days); // 最近 N 天的记录

  const anomalies = [];

  for (const record of recentRecords) {
    const totalCost = parseFloat(record.total_labor_cost);
    const unitCost = parseFloat(record.cost_per_unit);
    const output = parseFloat(record.production_output);

    // 检测1: 总成本异常高
    if (totalCost > averages.avgTotalCost * 1.2) {
      const deviation = ((totalCost - averages.avgTotalCost) / averages.avgTotalCost * 100).toFixed(2);
      anomalies.push({
        user_id: userId,
        cost_id: record.id,
        anomaly_type: 'high_cost',
        severity: totalCost > averages.avgTotalCost * 1.5 ? 'high' : 'medium',
        anomaly_date: record.cost_date,
        detected_value: totalCost,
        expected_value: averages.avgTotalCost,
        deviation_percent: parseFloat(deviation),
        description: `总成本 ${totalCost.toFixed(2)} 元，超出平均值 ${deviation}%`
      });
    }

    // 检测2: 单位成本异常高
    if (unitCost > averages.avgUnitCost * 1.3 && averages.avgUnitCost > 0) {
      const deviation = ((unitCost - averages.avgUnitCost) / averages.avgUnitCost * 100).toFixed(2);
      anomalies.push({
        user_id: userId,
        cost_id: record.id,
        anomaly_type: 'unit_cost_spike',
        severity: unitCost > averages.avgUnitCost * 1.5 ? 'high' : 'medium',
        anomaly_date: record.cost_date,
        detected_value: unitCost,
        expected_value: averages.avgUnitCost,
        deviation_percent: parseFloat(deviation),
        description: `单位成本 ${unitCost.toFixed(2)} 元，超出平均值 ${deviation}%`
      });
    }

    // 检测3: 产出过低
    const avgOutput = records.reduce((sum, r) => sum + parseFloat(r.production_output), 0) / records.length;
    if (output < avgOutput * 0.7 && avgOutput > 0) {
      const deviation = ((avgOutput - output) / avgOutput * 100).toFixed(2);
      anomalies.push({
        user_id: userId,
        cost_id: record.id,
        anomaly_type: 'low_output',
        severity: output < avgOutput * 0.5 ? 'high' : 'medium',
        anomaly_date: record.cost_date,
        detected_value: output,
        expected_value: avgOutput,
        deviation_percent: parseFloat(deviation),
        description: `产出 ${output} 件，低于平均值 ${deviation}%`
      });
    }
  }

  // 保存异常到数据库
  if (anomalies.length > 0) {
    const { error } = await supabase
      .from('cost_anomalies')
      .upsert(anomalies, {
        onConflict: 'user_id,cost_id,anomaly_type'
      });

    if (error) console.error('Error saving anomalies:', error);
  }

  return anomalies;
};

/**
 * 获取成本异常记录
 * @param {string} userId - 用户 ID
 * @param {string} status - 状态过滤 (可选: pending, investigating, resolved, ignored)
 * @returns {Promise<Array>} 异常记录列表
 */
export const getCostAnomalies = async (userId, status = null) => {
  let query = supabase
    .from('cost_anomalies')
    .select('*, operational_costs(*)')
    .eq('user_id', userId)
    .order('anomaly_date', { ascending: false });

  if (status) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;

  if (error) throw error;
  return data || [];
};

/**
 * 更新异常状态
 * @param {string} anomalyId - 异常 ID
 * @param {string} status - 新状态
 * @param {string} resolutionNotes - 解决说明 (可选)
 * @returns {Promise<object>} 更新后的记录
 */
export const updateAnomalyStatus = async (anomalyId, status, resolutionNotes = '') => {
  const updates = {
    status,
    resolution_notes: resolutionNotes
  };

  if (status === 'resolved') {
    updates.resolved_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('cost_anomalies')
    .update(updates)
    .eq('id', anomalyId)
    .select()
    .single();

  if (error) throw error;
  return data;
};

/**
 * 获取成本比较数据（本月 vs 上月）
 * @param {string} userId - 用户 ID
 * @returns {Promise<object>} 对比数据
 */
export const getCostComparison = async (userId) => {
  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

  // 本月数据
  const thisMonthRecords = await getCostRecords(
    userId,
    thisMonthStart.toISOString().split('T')[0],
    now.toISOString().split('T')[0]
  );

  // 上月数据
  const lastMonthRecords = await getCostRecords(
    userId,
    lastMonthStart.toISOString().split('T')[0],
    lastMonthEnd.toISOString().split('T')[0]
  );

  const calcTotal = (records) => {
    return records.reduce((sum, r) => sum + parseFloat(r.total_labor_cost), 0);
  };

  const calcAvg = (records) => {
    if (records.length === 0) return 0;
    return calcTotal(records) / records.length;
  };

  const thisMonthTotal = calcTotal(thisMonthRecords);
  const lastMonthTotal = calcTotal(lastMonthRecords);
  const thisMonthAvg = calcAvg(thisMonthRecords);
  const lastMonthAvg = calcAvg(lastMonthRecords);

  const changePercent = lastMonthTotal > 0
    ? ((thisMonthTotal - lastMonthTotal) / lastMonthTotal * 100).toFixed(2)
    : 0;

  return {
    thisMonth: {
      total: thisMonthTotal,
      average: thisMonthAvg,
      days: thisMonthRecords.length
    },
    lastMonth: {
      total: lastMonthTotal,
      average: lastMonthAvg,
      days: lastMonthRecords.length
    },
    comparison: {
      changeAmount: thisMonthTotal - lastMonthTotal,
      changePercent: parseFloat(changePercent),
      trend: changePercent > 0 ? 'up' : changePercent < 0 ? 'down' : 'stable'
    }
  };
};

/**
 * 删除成本记录
 * @param {string} costId - 成本记录 ID
 * @returns {Promise<void>}
 */
export const deleteCostRecord = async (costId) => {
  const { error } = await supabase
    .from('operational_costs')
    .delete()
    .eq('id', costId);

  if (error) throw error;
};

export default {
  recordDailyCost,
  getCostRecords,
  getCostTrends,
  analyzeCostStructure,
  detectCostAnomalies,
  getCostAnomalies,
  updateAnomalyStatus,
  getCostComparison,
  deleteCostRecord
};
