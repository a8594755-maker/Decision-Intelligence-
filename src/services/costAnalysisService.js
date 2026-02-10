/**
 * Cost Analysis Service
 * Cost analysis service - handles operational cost records, analysis, and anomaly detection
 */

import { supabase } from './supabaseClient';

/**
 * Record daily operational cost
 * @param {string} userId - User ID
 * @param {object} costData - Cost data
 * @returns {Promise<object>} Saved cost record
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

  // Calculate costs
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

  // Use upsert to handle duplicate dates
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
 * Safely convert to number (handles null, commas, strings)
 */
function toNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Calculate operational cost derived fields
 */
function computeDerived(row) {
  const directHours = toNumber(row.direct_labor_hours);
  const directRate = toNumber(row.direct_labor_rate);
  const indirectHours = toNumber(row.indirect_labor_hours);
  const indirectRate = toNumber(row.indirect_labor_rate);
  const output = toNumber(row.production_output);
  const matCost = toNumber(row.material_cost);
  const ohCost = toNumber(row.overhead_cost);

  const directCost = directHours * directRate;
  const indirectCost = indirectHours * indirectRate;
  const totalLabor = directCost + indirectCost;
  const costPerUnit = output > 0
    ? (totalLabor + matCost + ohCost) / output
    : 0;

  return {
    ...row,
    direct_labor_hours: directHours,
    direct_labor_rate: directRate,
    direct_labor_cost: directCost,
    indirect_labor_hours: indirectHours,
    indirect_labor_rate: indirectRate,
    indirect_labor_cost: indirectCost,
    total_labor_cost: totalLabor,
    production_output: output,
    material_cost: matCost,
    overhead_cost: ohCost,
    cost_per_unit: costPerUnit
  };
}

/**
 * Batch upsert operational costs (used by Upload Pipeline)
 * @param {string} userId - User ID
 * @param {Array<object>} rows - Normalized data rows (canonical keys)
 * @param {string|null} batchId - Batch ID (UUID)
 * @param {string|null} uploadFileId - Upload file ID (UUID)
 * @returns {Promise<object>} { success, rows }
 */
export const batchUpsertOperationalCosts = async (userId, rows, batchId = null, uploadFileId = null) => {
  const chunkSize = 500;

  const payload = rows.map(r => computeDerived({
    user_id: userId,
    cost_date: r.cost_date,
    direct_labor_hours: r.direct_labor_hours,
    direct_labor_rate: r.direct_labor_rate,
    indirect_labor_hours: r.indirect_labor_hours,
    indirect_labor_rate: r.indirect_labor_rate,
    production_output: r.production_output,
    production_unit: r.production_unit || 'pcs',
    material_cost: r.material_cost,
    overhead_cost: r.overhead_cost,
    notes: r.notes ?? null,
    batch_id: batchId ?? null,
    upload_file_id: uploadFileId ?? null
  }));

  let totalUpserted = 0;
  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize);

    const { error } = await supabase
      .from('operational_costs')
      .upsert(chunk, { onConflict: 'user_id,cost_date' });

    if (error) throw error;
    totalUpserted += chunk.length;
  }

  return { success: true, count: totalUpserted };
};

/**
 * Get cost records for specified date range
 * @param {string} userId - User ID
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {Promise<Array>} Cost record list
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
 * Get cost trend data
 * @param {string} userId - User ID
 * @param {number} days - Number of past days (default 30)
 * @returns {Promise<object>} Trend data
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

  // Sort by date (ascending)
  records.sort((a, b) => new Date(a.cost_date) - new Date(b.cost_date));

  const dates = records.map(r => r.cost_date);
  const totalCosts = records.map(r => parseFloat(r.total_labor_cost) || 0);
  const directCosts = records.map(r => parseFloat(r.direct_labor_cost) || 0);
  const indirectCosts = records.map(r => parseFloat(r.indirect_labor_cost) || 0);
  const unitCosts = records.map(r => parseFloat(r.cost_per_unit) || 0);

  // Calculate averages
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
 * Analyze cost structure
 * @param {string} userId - User ID
 * @param {string} date - Date (optional, defaults to today)
 * @returns {Promise<object>} Cost structure analysis
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
 * Detect cost anomalies
 * @param {string} userId - User ID
 * @param {number} days - Number of past days to detect (default 7)
 * @returns {Promise<Array>} Detected anomaly list
 */
export const detectCostAnomalies = async (userId, days = 7) => {
  // Get historical data
  const trends = await getCostTrends(userId, 30); // Use 30 days to calculate baseline

  if (trends.records.length < 7) {
    // Insufficient data, cannot detect anomalies
    return [];
  }

  const { averages, records } = trends;
  const recentRecords = records.slice(-days); // Records from last N days

  const anomalies = [];

  for (const record of recentRecords) {
    const totalCost = parseFloat(record.total_labor_cost);
    const unitCost = parseFloat(record.cost_per_unit);
    const output = parseFloat(record.production_output);

    // Detection 1: Abnormally high total cost
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
        description: `Total cost ${totalCost.toFixed(2)}, exceeds average by ${deviation}%`
      });
    }

    // Detection 2: Abnormally high unit cost
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
        description: `Unit cost ${unitCost.toFixed(2)}, exceeds average by ${deviation}%`
      });
    }

    // Detection 3: Output too low
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
        description: `Output ${output} units, below average by ${deviation}%`
      });
    }
  }

  // Save anomalies to database
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
 * Get cost anomaly records
 * @param {string} userId - User ID
 * @param {string} status - Status filter (optional: pending, investigating, resolved, ignored)
 * @returns {Promise<Array>} Anomaly record list
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
 * Update anomaly status
 * @param {string} anomalyId - Anomaly ID
 * @param {string} status - New status
 * @param {string} resolutionNotes - Resolution notes (optional)
 * @returns {Promise<object>} Updated record
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
 * Get cost comparison data (this month vs last month)
 * @param {string} userId - User ID
 * @returns {Promise<object>} Comparison data
 */
export const getCostComparison = async (userId) => {
  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

  // This month's data
  const thisMonthRecords = await getCostRecords(
    userId,
    thisMonthStart.toISOString().split('T')[0],
    now.toISOString().split('T')[0]
  );

  // Last month's data
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
 * Delete cost record
 * @param {string} costId - Cost record ID
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
  batchUpsertOperationalCosts,
  getCostRecords,
  getCostTrends,
  analyzeCostStructure,
  detectCostAnomalies,
  getCostAnomalies,
  updateAnomalyStatus,
  getCostComparison,
  deleteCostRecord
};
