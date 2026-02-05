/**
 * What-if Simulator: Expedite Inbound（提前到貨模擬）
 * 
 * 用途：模擬「將最早一筆 PO 提前 N buckets」後的風險變化
 * 限制：
 * - 只處理 expedite（提前到貨），不處理取消/減量/新增
 * - 只處理最早一筆 inbound
 * - 不引入複雜演算法
 * 
 * Pure Functions（無副作用）
 */

/**
 * Bucket 操作工具：前移/後移 N 個週別
 * 
 * @param {string} bucket - 週別字串，如 "2026-W07"
 * @param {number} offset - 偏移量（負數=前移，正數=後移）
 * @returns {string} - 新的週別字串
 */
export const shiftBucket = (bucket, offset) => {
  if (!bucket || typeof bucket !== 'string') {
    return bucket;
  }
  
  // 解析格式：YYYY-W##
  const match = bucket.match(/^(\d{4})-W(\d{2})$/);
  if (!match) {
    // 無法解析，回傳原值
    return bucket;
  }
  
  let year = parseInt(match[1], 10);
  let week = parseInt(match[2], 10);
  
  // 應用偏移
  week += offset;
  
  // 處理跨年（簡化版：假設每年 52 週）
  while (week < 1) {
    week += 52;
    year -= 1;
  }
  
  while (week > 52) {
    week -= 52;
    year += 1;
  }
  
  return `${year}-W${String(week).padStart(2, '0')}`;
};

/**
 * 從 PO 列表建立 Inbound Schedule
 * 
 * @param {Array} poLines - PO 明細列表（含 timeBucket, qty）
 * @returns {Object} { schedule: Map<bucket, totalQty>, sortedBuckets: Array<bucket>, totalQty: number }
 */
export const buildInboundScheduleFromPOLines = (poLines = []) => {
  const schedule = new Map();
  let totalQty = 0;
  
  poLines.forEach(po => {
    const bucket = po.timeBucket;
    const qty = parseFloat(po.qty || 0);
    
    if (bucket && qty > 0) {
      const current = schedule.get(bucket) || 0;
      schedule.set(bucket, current + qty);
      totalQty += qty;
    }
  });
  
  // 排序 buckets（按字串順序，因為 YYYY-W## 格式可排序）
  const sortedBuckets = Array.from(schedule.keys()).sort();
  
  return {
    schedule,
    sortedBuckets,
    totalQty
  };
};

/**
 * 模擬提前到貨（Expedite）
 * 
 * 規則：
 * - 找到最早的 inbound bucket
 * - 將該 bucket 的所有 qty 移到「提前 N buckets」的新 bucket
 * - 若無 inbound，回傳原 schedule + reason
 * 
 * @param {Map} schedule - 原始 inbound schedule
 * @param {Array} sortedBuckets - 排序後的 buckets
 * @param {number} expediteBuckets - 提前的 bucket 數量（如 1, 2, 3）
 * @returns {Object} { schedule: Map, sortedBuckets: Array, success: boolean, reason: string, changes: Object }
 */
export const simulateExpediteInbound = (schedule, sortedBuckets, expediteBuckets) => {
  // 檢查是否有 inbound
  if (!sortedBuckets || sortedBuckets.length === 0) {
    return {
      schedule: new Map(schedule),
      sortedBuckets: [],
      success: false,
      reason: 'NO_INBOUND',
      changes: {
        fromBucket: null,
        toBucket: null,
        qty: 0
      }
    };
  }
  
  // 找到最早的 bucket
  const earliestBucket = sortedBuckets[0];
  const qty = schedule.get(earliestBucket);
  
  // 計算新 bucket（提前 N buckets）
  const newBucket = shiftBucket(earliestBucket, -expediteBuckets);
  
  // 建立新 schedule
  const newSchedule = new Map(schedule);
  
  // 移除原 bucket
  newSchedule.delete(earliestBucket);
  
  // 加入新 bucket
  const existingQty = newSchedule.get(newBucket) || 0;
  newSchedule.set(newBucket, existingQty + qty);
  
  // 重新排序
  const newSortedBuckets = Array.from(newSchedule.keys()).sort();
  
  return {
    schedule: newSchedule,
    sortedBuckets: newSortedBuckets,
    success: true,
    reason: 'EXPEDITED',
    changes: {
      fromBucket: earliestBucket,
      toBucket: newBucket,
      qty
    }
  };
};

/**
 * 將 Schedule 轉回 PO Lines 格式（供重算 coverage risk 用）
 * 
 * @param {Map} schedule - Inbound schedule
 * @returns {Array} PO lines（模擬格式）
 */
export const scheduleToPOLines = (schedule) => {
  const poLines = [];
  
  schedule.forEach((qty, bucket) => {
    poLines.push({
      timeBucket: bucket,
      timeBucketSortKey: bucket,
      qty,
      poNumber: 'SIMULATED',
      poLine: '001'
    });
  });
  
  return poLines;
};

/**
 * 計算 Horizon 內的總 Inbound 量
 * 
 * @param {Map} schedule - Inbound schedule
 * @param {Array} sortedBuckets - 排序後的 buckets
 * @param {number} horizonBuckets - Horizon（如 3 buckets）
 * @returns {number} - Horizon 內總 inbound qty
 */
export const sumInboundWithinHorizon = (schedule, sortedBuckets, horizonBuckets) => {
  if (!schedule || !sortedBuckets || sortedBuckets.length === 0) {
    return 0;
  }
  
  let totalQty = 0;
  const bucketsInHorizon = sortedBuckets.slice(0, horizonBuckets);
  
  bucketsInHorizon.forEach(bucket => {
    totalQty += schedule.get(bucket) || 0;
  });
  
  return totalQty;
};

/**
 * 評估模擬結果（Before vs After）- 使用 Effective Gap 模型
 * 
 * Effective Gap 模型：
 * - Base Gap = max(0, Safety Stock - On Hand)
 * - Inbound in Horizon = sum(schedule 內 horizon 的 qty)
 * - Effective Gap = max(0, Base Gap - Inbound in Horizon)
 * - Profit at Risk = Effective Gap * Profit per Unit
 * 
 * Status 規則：
 * - Effective Gap = 0 → OK
 * - Effective Gap > 0 且有 inbound → WARNING
 * - Effective Gap > 0 且無 inbound → CRITICAL
 * 
 * @param {Object} params
 * @param {Object} params.rowContext - 當前列的上下文（含 item, factory, onHand, safetyStock, profitPerUnit, gapQty, etc.）
 * @param {Map} params.beforeSchedule - 原始 schedule
 * @param {Array} params.beforeSortedBuckets - 原始 sorted buckets
 * @param {Map} params.afterSchedule - 模擬後 schedule
 * @param {Array} params.afterSortedBuckets - 模擬後 sorted buckets
 * @param {number} params.horizonBuckets - Horizon（如 3 buckets）
 * @returns {Object} { before, after, delta }
 */
export const evaluateSimulation = ({
  rowContext,
  beforeSchedule,
  beforeSortedBuckets,
  afterSchedule,
  afterSortedBuckets,
  horizonBuckets = 3
}) => {
  // 輔助函數：評估單一 schedule（使用 Effective Gap 模型）
  const evaluateSchedule = (schedule, sortedBuckets) => {
    // 計算 horizon 內的 inbound count 和 qty
    const inboundCount = Math.min(sortedBuckets.length, horizonBuckets);
    const inboundQtyWithinHorizon = sumInboundWithinHorizon(schedule, sortedBuckets, horizonBuckets);
    
    const nextBucket = sortedBuckets.length > 0 ? sortedBuckets[0] : null;
    
    // Base Gap（原始缺口）
    const onHand = rowContext.onHand || 0;
    const safetyStock = rowContext.safetyStock || 0;
    const baseGapQty = rowContext.gapQty !== undefined ? rowContext.gapQty : Math.max(0, safetyStock - onHand);
    
    // Effective Gap（考慮 horizon 內 inbound 後的實際缺口）
    const effectiveGap = Math.max(0, baseGapQty - inboundQtyWithinHorizon);
    
    // Profit at Risk（基於 Effective Gap）
    const profitPerUnit = rowContext.profitPerUnit || 10; // Fallback
    const profitAtRisk = effectiveGap * profitPerUnit;
    
    // Status 規則（基於 Effective Gap）
    let status = 'OK';
    if (effectiveGap === 0) {
      status = 'OK';
    } else if (inboundQtyWithinHorizon > 0) {
      status = 'WARNING';  // 有 inbound 但仍有缺口
    } else {
      status = 'CRITICAL'; // 無 inbound 且有缺口
    }
    
    return {
      status,
      nextBucket,
      inboundCount,
      inboundQtyWithinHorizon,
      baseGapQty,
      effectiveGap,
      profitAtRisk
    };
  };
  
  // 評估 Before
  const before = evaluateSchedule(beforeSchedule, beforeSortedBuckets);
  
  // 評估 After
  const after = evaluateSchedule(afterSchedule, afterSortedBuckets);
  
  // 計算 Delta
  const delta = {
    statusChanged: before.status !== after.status,
    statusImproved: (
      (before.status === 'CRITICAL' && after.status === 'WARNING') ||
      (before.status === 'CRITICAL' && after.status === 'OK') ||
      (before.status === 'WARNING' && after.status === 'OK')
    ),
    nextBucketChanged: before.nextBucket !== after.nextBucket,
    profitAtRiskDelta: after.profitAtRisk - before.profitAtRisk,
    effectiveGapDelta: after.effectiveGap - before.effectiveGap,
    inboundQtyWithinHorizonDelta: after.inboundQtyWithinHorizon - before.inboundQtyWithinHorizon,
    inboundCountDelta: after.inboundCount - before.inboundCount
  };
  
  return {
    before,
    after,
    delta
  };
};

/**
 * 完整 What-if Expedite 流程（All-in-one）
 * 
 * @param {Object} params
 * @param {Array} params.poLines - PO 明細列表
 * @param {Object} params.rowContext - 當前列上下文
 * @param {number} params.expediteBuckets - 提前 N buckets
 * @param {number} params.horizonBuckets - Horizon
 * @returns {Object} { success, reason, before, after, delta, changes }
 */
export const simulateWhatIfExpedite = ({
  poLines = [],
  rowContext = {},
  expediteBuckets = 1,
  horizonBuckets = 3
}) => {
  // Step 1: 建立原始 schedule
  const { schedule: beforeSchedule, sortedBuckets: beforeSortedBuckets } = 
    buildInboundScheduleFromPOLines(poLines);
  
  // Step 2: 模擬 expedite
  const {
    schedule: afterSchedule,
    sortedBuckets: afterSortedBuckets,
    success,
    reason,
    changes
  } = simulateExpediteInbound(beforeSchedule, beforeSortedBuckets, expediteBuckets);
  
  // 若失敗，直接回傳
  if (!success) {
    return {
      success: false,
      reason,
      before: null,
      after: null,
      delta: null,
      changes: null
    };
  }
  
  // Step 3: 評估結果
  const { before, after, delta } = evaluateSimulation({
    rowContext,
    beforeSchedule,
    beforeSortedBuckets,
    afterSchedule,
    afterSortedBuckets,
    horizonBuckets
  });
  
  return {
    success: true,
    reason,
    before,
    after,
    delta,
    changes
  };
};
