/**
 * Demand Forecast Engine v1
 * 
 * Implements Moving Average (MA) baseline algorithm with P10/P50/P90 confidence intervals
 * 
 * Algorithm: Moving Average v1 (ma_v1)
 * - p50 = mean of last N historical buckets
 * - p10 = p50 - z * std (z = 1.28 for 80% confidence)
 * - p90 = p50 + z * std
 * - Fallback: last bucket value (naive) if insufficient history
 * 
 * @version MVP v1
 */

/**
 * Calculate statistics (mean, std) from historical demand data
 * @param {Array} history - Array of { time_bucket, demand_qty } objects
 * @returns {Object} { mean, std, n, hasSufficientData }
 */
function calculateStatistics(history) {
  if (!history || history.length === 0) {
    return { mean: 0, std: 0, n: 0, hasSufficientData: false };
  }

  const values = history.map(h => Number(h.demand_qty) || 0);
  const n = values.length;
  
  if (n === 0) {
    return { mean: 0, std: 0, n: 0, hasSufficientData: false };
  }

  // Calculate mean
  const sum = values.reduce((acc, val) => acc + val, 0);
  const mean = sum / n;

  // Calculate standard deviation (sample std with Bessel's correction)
  let std = 0;
  if (n > 1) {
    const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
    const variance = squaredDiffs.reduce((acc, val) => acc + val, 0) / (n - 1);
    std = Math.sqrt(variance);
  }

  // We need at least 2 data points for meaningful std calculation
  const hasSufficientData = n >= 2;

  return { mean, std, n, hasSufficientData };
}

/**
 * Calculate P10/P50/P90 forecast values
 * @param {number} mean - Mean of historical data
 * @param {number} std - Standard deviation of historical data
 * @param {number} zScore - Z-score for confidence intervals (default 1.28 for 80%)
 * @returns {Object} { p10, p50, p90 }
 */
function calculateForecastValues(mean, std, zScore = 1.28) {
  const p50 = mean;
  const p10 = Math.max(0, p50 - zScore * std);  // Ensure non-negative
  const p90 = p50 + zScore * std;

  return { p10, p50, p90 };
}

/**
 * Calculate WAPE (Weighted Absolute Percentage Error)
 * Simple metric for forecast accuracy on historical data
 * @param {Array} actual - Actual values
 * @param {number} forecast - Forecast value
 * @returns {number|null} WAPE percentage or null if cannot calculate
 */
function calculateWAPE(actual, forecast) {
  if (!actual || actual.length === 0 || forecast === 0) {
    return null;
  }

  const sumActual = actual.reduce((acc, val) => acc + Math.abs(Number(val) || 0), 0);
  if (sumActual === 0) {
    return null;
  }

  const sumAbsError = actual.reduce((acc, val) => acc + Math.abs((Number(val) || 0) - forecast), 0);
  return (sumAbsError / sumActual) * 100;
}

/**
 * Generate forecast for a single FG/material + plant combination
 * @param {string} userId - User ID
 * @param {string} materialCode - FG material code
 * @param {string} plantId - Plant ID
 * @param {Array} targetTimeBuckets - Array of time buckets to forecast
 * @param {Array} historicalData - Array of { time_bucket, demand_qty } from demand_fg
 * @param {Object} options - Forecast options
 * @returns {Array} Array of forecast objects for each time bucket
 */
export function generateSingleForecast(
  userId,
  materialCode,
  plantId,
  targetTimeBuckets,
  historicalData,
  options = {}
) {
  const {
    trainWindowBuckets = 8,
    modelVersion = 'ma_v1',
    zScore = 1.28
  } = options;

  // Calculate statistics from historical data
  const stats = calculateStatistics(historicalData);
  
  // Calculate forecast values
  let forecastValues;
  let fallbackUsed = false;
  
  if (stats.hasSufficientData) {
    // Normal case: use moving average with confidence intervals
    forecastValues = calculateForecastValues(stats.mean, stats.std, zScore);
  } else if (historicalData.length > 0) {
    // Fallback: use last bucket value (naive forecast) with synthetic confidence intervals
    const lastValue = Number(historicalData[historicalData.length - 1].demand_qty) || 0;
    if (lastValue > 0) {
      // Build a reasonable confidence band: ±20% of last value
      forecastValues = {
        p10: Math.max(0, Math.round(lastValue * 0.8)),
        p50: lastValue,
        p90: Math.round(lastValue * 1.2)
      };
    } else {
      // Last value was zero — use mean of all available points if any are non-zero
      const nonZeroValues = historicalData.map(h => Number(h.demand_qty) || 0).filter(v => v > 0);
      if (nonZeroValues.length > 0) {
        const avgNonZero = nonZeroValues.reduce((s, v) => s + v, 0) / nonZeroValues.length;
        forecastValues = {
          p10: Math.max(0, Math.round(avgNonZero * 0.8)),
          p50: Math.round(avgNonZero),
          p90: Math.round(avgNonZero * 1.2)
        };
      } else {
        forecastValues = { p10: 0, p50: 0, p90: 0 };
      }
    }
    fallbackUsed = true;
    console.warn(
      `[demandForecastEngine] Insufficient data (n=${historicalData.length}) for ${materialCode}@${plantId}, using naive fallback: p50=${forecastValues.p50}`
    );
  } else {
    // No historical data at all — this is a data pipeline problem
    forecastValues = { p10: 0, p50: 0, p90: 0 };
    fallbackUsed = true;
    console.error(
      `[demandForecastEngine] NO historical data for ${materialCode}@${plantId}. ` +
      'Check that demand_fg.csv rows are correctly parsed and stored in the database.'
    );
  }

  // Calculate WAPE for metrics
  const wape = stats.hasSufficientData 
    ? calculateWAPE(historicalData.map(h => h.demand_qty), forecastValues.p50)
    : null;

  // Generate forecast for each target time bucket
  return targetTimeBuckets.map(timeBucket => ({
    user_id: userId,
    material_code: materialCode,
    plant_id: plantId,
    time_bucket: timeBucket,
    p10: forecastValues.p10,
    p50: forecastValues.p50,
    p90: forecastValues.p90,
    model_version: modelVersion,
    train_window_buckets: trainWindowBuckets,
    metrics: {
      wape: wape,
      std: stats.std,
      n: stats.n,
      mean: stats.mean,
      fallback_used: fallbackUsed,
      historical_buckets_used: historicalData.length
    }
  }));
}

/**
 * Execute demand forecast for multiple materials
 * This is the main entry point for the forecast engine
 * 
 * @param {Object} params - Forecast parameters
 * @param {string} params.userId - User ID
 * @param {string} params.plantId - Plant ID (optional, null for all plants)
 * @param {Array} params.targetTimeBuckets - Array of time buckets to forecast
 * @param {number} params.trainWindowBuckets - Number of historical buckets to use (default: 8)
 * @param {string} params.modelVersion - Model version (default: 'ma_v1')
 * @param {Function} params.getHistoricalDataFn - Async function to fetch historical data
 * @returns {Promise<Object>} Forecast results and metadata
 */
export async function executeDemandForecast(params) {
  const {
    userId,
    plantId = null,
    targetTimeBuckets,
    trainWindowBuckets = 8,
    modelVersion = 'ma_v1',
    getHistoricalDataFn
  } = params;

  if (!userId) {
    throw new Error('userId is required');
  }

  if (!Array.isArray(targetTimeBuckets) || targetTimeBuckets.length === 0) {
    throw new Error('targetTimeBuckets must be a non-empty array');
  }

  if (!getHistoricalDataFn || typeof getHistoricalDataFn !== 'function') {
    throw new Error('getHistoricalDataFn is required');
  }

  const startTime = Date.now();
  const allForecasts = [];
  const materialStats = {
    processed: 0,
    skipped: 0,
    errors: []
  };

  try {
    // Get the latest time bucket from targets to use as cutoff for historical data
    const sortedTargets = [...targetTimeBuckets].sort();
    const lastTargetBucket = sortedTargets[sortedTargets.length - 1];

    // Fetch all historical demand_fg data for this user/plant
    const historicalData = await getHistoricalDataFn(userId, plantId, lastTargetBucket, trainWindowBuckets);
    
    if (!historicalData || historicalData.length === 0) {
      return {
        success: true,
        forecasts: [],
        metadata: {
          totalMaterials: 0,
          totalForecasts: 0,
          trainWindowBuckets,
          modelVersion,
          executionTimeMs: Date.now() - startTime,
          warning: 'No historical demand data found'
        }
      };
    }

    // Group historical data by material_code and plant_id
    const groupedData = historicalData.reduce((acc, row) => {
      const key = `${row.material_code}__${row.plant_id}`;
      if (!acc[key]) {
        acc[key] = {
          material_code: row.material_code,
          plant_id: row.plant_id,
          history: []
        };
      }
      acc[key].history.push(row);
      return acc;
    }, {});

    // Generate forecasts for each material/plant combination
    for (const key of Object.keys(groupedData)) {
      const { material_code, plant_id, history } = groupedData[key];
      
      try {
        const forecasts = generateSingleForecast(
          userId,
          material_code,
          plant_id,
          targetTimeBuckets,
          history,
          { trainWindowBuckets, modelVersion }
        );

        allForecasts.push(...forecasts);
        materialStats.processed++;
      } catch (error) {
        materialStats.errors.push({
          material_code,
          plant_id,
          error: error.message
        });
        materialStats.skipped++;
      }
    }

    return {
      success: true,
      forecasts: allForecasts,
      metadata: {
        totalMaterials: materialStats.processed,
        totalForecasts: allForecasts.length,
        trainWindowBuckets,
        modelVersion,
        targetTimeBuckets,
        executionTimeMs: Date.now() - startTime,
        errors: materialStats.errors.length > 0 ? materialStats.errors : undefined
      }
    };

  } catch (error) {
    return {
      success: false,
      forecasts: [],
      metadata: {
        trainWindowBuckets,
        modelVersion,
        targetTimeBuckets,
        executionTimeMs: Date.now() - startTime,
        error: error.message
      }
    };
  }
}

/**
 * Execute a complete demand forecast run
 * This orchestrates the full process: create run → generate forecasts → save to DB
 * 
 * @param {Object} params - Run parameters
 * @param {string} params.userId - User ID
 * @param {string} params.plantId - Plant ID (optional)
 * @param {Array} params.targetTimeBuckets - Time buckets to forecast
 * @param {number} params.trainWindowBuckets - Training window size (default: 8)
 * @param {string} params.scenarioName - Scenario name (default: 'demand_forecast')
 * @param {Object} services - Service objects { forecastRunsService, demandForecastService }
 * @returns {Promise<Object>} Run result with forecastRunId and statistics
 */
export async function runDemandForecast(params, services) {
  const {
    userId,
    plantId = null,
    targetTimeBuckets,
    trainWindowBuckets = 8,
    scenarioName = 'demand_forecast'
  } = params;

  const { forecastRunsService, demandForecastService } = services;

  const modelVersion = 'ma_v1';
  const startTime = Date.now();

  try {
    // Step 1: Create forecast run record
    const runRecord = await forecastRunsService.createRun(userId, {
      scenarioName,
      parameters: {
        kind: 'demand_forecast',
        model_version: modelVersion,
        train_window_buckets: trainWindowBuckets,
        time_buckets: targetTimeBuckets,
        plant_id: plantId
      },
      kind: 'demand_forecast'
    });

    const forecastRunId = runRecord.id;

    // Step 2: Execute forecast engine
    const forecastResult = await executeDemandForecast({
      userId,
      plantId,
      targetTimeBuckets,
      trainWindowBuckets,
      modelVersion,
      getHistoricalDataFn: (uid, pid, endBucket, window) => 
        demandForecastService.getHistoricalDemandFg(uid, pid, null, endBucket, window * targetTimeBuckets.length)
    });

    console.log('DEBUG - forecastResult:', JSON.stringify(forecastResult, null, 2));

    if (!forecastResult.success) {
      throw new Error(forecastResult.metadata.error || 'Forecast engine failed');
    }

    // Step 3: Add forecast_run_id to each forecast
    const forecastsWithRunId = forecastResult.forecasts.map(f => ({
      ...f,
      forecast_run_id: forecastRunId
    }));

    console.log('DEBUG - forecastsWithRunId count:', forecastsWithRunId.length);
    console.log('DEBUG - first forecast:', forecastsWithRunId[0]);

    // Step 4: Save forecasts to database
    let savedCount = 0;
    if (forecastsWithRunId.length > 0) {
      console.log('DEBUG - calling batchInsert with', forecastsWithRunId.length, 'forecasts');
      const insertResult = await demandForecastService.batchInsert(userId, forecastsWithRunId);
      console.log('DEBUG - insertResult:', insertResult);
      savedCount = insertResult.count;
    } else {
      console.log('DEBUG - no forecasts to insert');
    }

    const executionTimeMs = Date.now() - startTime;

    return {
      success: true,
      forecastRunId,
      statistics: {
        totalMaterials: forecastResult.metadata.totalMaterials,
        totalForecasts: savedCount,
        trainWindowBuckets,
        modelVersion,
        executionTimeMs
      },
      runRecord: {
        ...runRecord,
        parameters: {
          kind: 'demand_forecast',
          model_version: modelVersion,
          train_window_buckets: trainWindowBuckets,
          time_buckets: targetTimeBuckets,
          plant_id: plantId
        }
      }
    };

  } catch (error) {
    return {
      success: false,
      forecastRunId: null,
      error: error.message,
      statistics: {
        trainWindowBuckets,
        modelVersion,
        executionTimeMs: Date.now() - startTime
      }
    };
  }
}

// Export individual functions for testing
export const forecastEngine = {
  calculateStatistics,
  calculateForecastValues,
  calculateWAPE,
  generateSingleForecast,
  executeDemandForecast,
  runDemandForecast
};

export default forecastEngine;
