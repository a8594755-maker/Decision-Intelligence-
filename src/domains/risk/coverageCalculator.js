/**
 * Supply Coverage Risk Calculator (Bucket-Based Version)
 * 
 * 用途：計算基於 time_bucket 的供應覆蓋風險（Week1 Demo）
 * 輸入：Open PO（只有 time_bucket，無 ETA 日期）
 * 輸出：domainResult 數組，每條包含風險評估
 * 
 * 風險規則（Bucket-Based）：
 * - CRITICAL：未來 N 個 bucket 內無入庫（inboundCountHorizon === 0）
 * - WARNING：inboundCountHorizon === 1 或 inboundQtyHorizon < 閾值（如 10）
 * - OK：其他情況
 * 
 * Horizon: 預設 2-3 個 time_bucket（可調整）
 */

import { getCurrentTimeBucket } from '../../utils/timeBucket.js';

const HORIZON_BUCKETS = 3; // 未來 N 個 time_bucket
const MIN_QTY_THRESHOLD = 10; // WARNING 閾值

/**
 * 正規化料號（去空格、轉大寫）
 */
function normalizeItemCode(code) {
  if (!code) return '';
  return String(code).trim().toUpperCase();
}

/**
 * 正規化工廠代碼（去空格、轉大寫）
 */
function normalizeFactory(factory) {
  if (!factory) return '';
  return String(factory).trim().toUpperCase();
}

/**
 * 判斷 bucket 是否在 horizon 內
 * 邏輯：比較 sortKey 字串（如果格式一致，字串比較即可）
 * 
 * @param {string} bucketSortKey - PO 的 timeBucketSortKey
 * @param {string} currentBucket - 當前 bucket
 * @param {number} horizonBuckets - 未來 N 個 bucket
 * @returns {boolean}
 */
function isBucketInHorizon(bucketSortKey, currentBucket, horizonBuckets) {
  if (!bucketSortKey || !currentBucket) return false;
  
  // 簡化邏輯：假設 sortKey 格式一致（YYYY-W##），直接字串比較
  // 若 bucketSortKey >= currentBucket，且在合理範圍內
  if (bucketSortKey < currentBucket) return false;
  
  // 計算 bucket 差距（粗略）
  // 如果是週別格式（YYYY-W##），可以簡單比較
  const currentYear = parseInt(currentBucket.substring(0, 4), 10);
  // Use regex to extract week number robustly (handles W3, W03, W53)
  const cwMatch = currentBucket.match(/W(\d+)/);
  const currentWeek = cwMatch ? parseInt(cwMatch[1], 10) : NaN;

  const bucketYear = parseInt(bucketSortKey.substring(0, 4), 10);
  const bwMatch = bucketSortKey.match(/W(\d+)/);
  const bucketWeek = bwMatch ? parseInt(bwMatch[1], 10) : NaN;
  
  if (isNaN(currentYear) || isNaN(currentWeek) || isNaN(bucketYear) || isNaN(bucketWeek)) {
    // 無法解析，降級：只要 sortKey 不太遠即可
    return bucketSortKey <= currentBucket.replace(/W(\d{2})/, (m, w) => `W${String(parseInt(w) + horizonBuckets).padStart(2, '0')}`);
  }
  
  // 計算週差
  const weekDiff = (bucketYear - currentYear) * 52 + (bucketWeek - currentWeek);
  
  return weekDiff >= 0 && weekDiff <= horizonBuckets;
}

/**
 * 計算單一 Item/Factory 的供應覆蓋風險（Bucket-Based）
 * 
 * @param {Object} params
 * @param {string} params.item - 料號
 * @param {string} params.factory - 工廠代碼
 * @param {Array} params.openPOs - 開放 PO 列表（已正規化，含 timeBucket/timeBucketSortKey）
 * @param {number} [params.currentStock=0] - 當前庫存
 * @param {number} [params.horizonBuckets=3] - 風險評估時間窗（N 個 bucket）
 * @returns {Object} domainResult
 */
export const calculateSupplyCoverageRisk = ({
  item,
  factory,
  openPOs = [],
  currentStock = 0,
  horizonBuckets = HORIZON_BUCKETS
}) => {
  const currentBucket = getCurrentTimeBucket();
  
  // 篩選該 item/factory 在未來 N 個 bucket 內的 PO
  const relevantPOs = openPOs.filter(po => {
    const poItem = normalizeItemCode(po.item);
    const poFactory = normalizeFactory(po.factory);
    
    if (poItem !== normalizeItemCode(item) || poFactory !== normalizeFactory(factory)) {
      return false;
    }
    
    return isBucketInHorizon(po.timeBucketSortKey, currentBucket, horizonBuckets);
  });
  
  // 統計未來 N 個 bucket 內的入庫
  const inboundCountHorizon = relevantPOs.length;
  const inboundQtyHorizon = relevantPOs.reduce((sum, po) => sum + po.qty, 0);
  
  // 找到最近的 time_bucket
  let nextTimeBucket = null;
  if (relevantPOs.length > 0) {
    const sortedPOs = relevantPOs
      .slice()
      .sort((a, b) => (a.timeBucketSortKey || '').localeCompare(b.timeBucketSortKey || ''));
    
    nextTimeBucket = sortedPOs[0]?.timeBucket || null;
  }
  
  // 風險規則判定（Bucket-Based）
  let status = 'OK';
  let reason = `有 ${inboundCountHorizon} 次入庫，供應正常`;
  
  if (inboundCountHorizon === 0) {
    status = 'CRITICAL';
    reason = `未來 ${horizonBuckets} 個 bucket 內無入庫`;
  } else if (inboundCountHorizon === 1) {
    status = 'WARNING';
    reason = `未來 ${horizonBuckets} 個 bucket 僅 1 次入庫`;
  } else if (inboundQtyHorizon < MIN_QTY_THRESHOLD) {
    status = 'WARNING';
    reason = `入庫總量僅 ${inboundQtyHorizon}（< ${MIN_QTY_THRESHOLD}）`;
  }
  
  // 準備 PO 明細（按 timeBucket 排序，取前 5 條）
  const poDetails = relevantPOs
    .slice()
    .sort((a, b) => (a.timeBucketSortKey || '').localeCompare(b.timeBucketSortKey || ''))
    .slice(0, 5)
    .map(po => ({
      timeBucket: po.timeBucket,
      qty: po.qty,
      poNumber: po.poNumber,
      poLine: po.poLine
    }));
  
  return {
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
    poDetails, // PO 明細（top 5）
    // 這些會在 batch 函數中補充（如果有 inventory）
    onHand: currentStock,
    safetyStock: 0,
    netAvailable: currentStock,
    gapQty: 0
  };
};

/**
 * 批量計算多個 Item/Factory 組合的風險
 * 
 * @param {Object} params
 * @param {Array} params.openPOs - 開放 PO 列表（已正規化）
 * @param {Array} [params.inventorySnapshots=[]] - 庫存快照（可選）
 * @param {number} [params.horizonBuckets=3] - 風險評估時間窗（N 個 bucket）
 * @returns {Array<Object>} domainResults
 */
export const calculateSupplyCoverageRiskBatch = ({
  openPOs = [],
  inventorySnapshots = [],
  horizonBuckets = HORIZON_BUCKETS
}) => {
  // 建立庫存查詢索引（統一 key 格式）
  const inventoryIndex = {};
  inventorySnapshots.forEach(inv => {
    // 統一正規化（trim + uppercase）
    const item = normalizeItemCode(inv.material_code || inv.item || inv.material);
    const factory = normalizeFactory(inv.plant_id || inv.factory || inv.site);
    
    if (!item || !factory) return; // 跳過無效資料
    
    const key = `${item}|${factory}`;
    
    // 儲存完整庫存資訊（不只是 qty）
    inventoryIndex[key] = {
      onHand: parseFloat(inv.on_hand_qty || inv.on_hand || inv.available_qty || inv.stock || 0),
      safetyStock: parseFloat(inv.safety_stock || inv.min_stock || 0),
      _raw: inv
    };
  });
  
  // 提取所有 unique item/factory 組合（Union: PO + Inventory）
  const itemFactorySet = new Set();
  
  // 從 PO 提取
  openPOs.forEach(po => {
    const item = normalizeItemCode(po.item);
    const factory = normalizeFactory(po.factory);
    if (item && factory) {
      itemFactorySet.add(`${item}|${factory}`);
    }
  });
  
  // 從 Inventory 提取
  inventorySnapshots.forEach(inv => {
    const item = normalizeItemCode(inv.material_code || inv.item || inv.material);
    const factory = normalizeFactory(inv.plant_id || inv.factory || inv.site);
    if (item && factory) {
      itemFactorySet.add(`${item}|${factory}`);
    }
  });
  
  // 對每個組合計算風險
  const results = [];
  
  itemFactorySet.forEach(key => {
    const [item, factory] = key.split('|');
    
    // 從 inventoryIndex 取得庫存資訊
    const invInfo = inventoryIndex[key] || { onHand: 0, safetyStock: 0 };
    
    const riskResult = calculateSupplyCoverageRisk({
      item,
      factory,
      openPOs,
      currentStock: invInfo.onHand,
      horizonBuckets
    });
    
    // 加入庫存詳細資訊到 domainResult
    riskResult.onHand = invInfo.onHand;
    riskResult.safetyStock = invInfo.safetyStock;
    riskResult.netAvailable = invInfo.onHand - invInfo.safetyStock;
    riskResult.gapQty = Math.max(0, invInfo.safetyStock - invInfo.onHand);
    
    results.push(riskResult);
  });
  
  // 排序：CRITICAL -> WARNING -> OK，再按 nextTimeBucket
  results.sort((a, b) => {
    const statusOrder = { 'CRITICAL': 0, 'WARNING': 1, 'OK': 2 };
    const statusDiff = statusOrder[a.status] - statusOrder[b.status];
    
    if (statusDiff !== 0) return statusDiff;
    
    // 同等級時，按 nextTimeBucket 排序（null 排最後）
    if (!a.nextTimeBucket && !b.nextTimeBucket) return 0;
    if (!a.nextTimeBucket) return 1;
    if (!b.nextTimeBucket) return -1;
    
    return (a.nextTimeBucket || '').localeCompare(b.nextTimeBucket || '');
  });
  
  return results;
};

/**
 * 生成測試用 Sample Data（開發用）
 * 
 * @param {number} count - 生成筆數
 * @returns {Object} { openPOs, inventorySnapshots }
 */
export const generateSampleData = (count = 20) => {
  const items = ['PART-A101', 'PART-B202', 'PART-C303', 'PART-D404', 'PART-E505', 
                 'PART-F606', 'PART-G707', 'PART-H808', 'PART-I909', 'PART-J1010'];
  const factories = ['FAC-TW01', 'FAC-CN01', 'FAC-US01', 'FAC-JP01'];
  
  const openPOs = [];
  const inventorySnapshots = [];
  
  const currentYear = new Date().getFullYear();
  // Use correct ISO 8601 week calculation (Thursday-based)
  const _now = new Date();
  const _d = new Date(Date.UTC(_now.getFullYear(), _now.getMonth(), _now.getDate()));
  _d.setUTCDate(_d.getUTCDate() + 4 - (_d.getUTCDay() || 7));
  const _yearStart = new Date(Date.UTC(_d.getUTCFullYear(), 0, 1));
  const currentWeek = Math.ceil((((_d - _yearStart) / 86400000) + 1) / 7);
  
  // 生成庫存快照
  for (let i = 0; i < count; i++) {
    const item = items[i % items.length] + (i >= items.length ? `-${Math.floor(i / items.length)}` : '');
    const factory = factories[i % factories.length];
    
    inventorySnapshots.push({
      material_code: item,
      plant_id: factory,
      on_hand_qty: Math.floor(Math.random() * 500) + 100,
      safety_stock: Math.floor(Math.random() * 100) + 50,
      created_at: new Date().toISOString()
    });
  }
  
  // 生成 Open PO（確保至少 3 條 CRITICAL、5 條 WARNING）
  inventorySnapshots.forEach((inv, idx) => {
    const item = inv.material_code;
    const factory = inv.plant_id;
    
    // 前 3 條：無 PO（CRITICAL）
    if (idx < 3) {
      // 不生成 PO
      return;
    }
    
    // 接下來 5 條：WARNING（僅 1 次 或 qty 很小）
    if (idx < 8) {
      const weekOffset = Math.floor(Math.random() * 3) + 1; // 1-3 週後
      const timeBucket = `${currentYear}-W${String(currentWeek + weekOffset).padStart(2, '0')}`;
      
      openPOs.push({
        item,
        factory,
        timeBucket,
        timeBucketSortKey: timeBucket,
        qty: idx < 6 ? Math.floor(Math.random() * 5) + 3 : 50, // 前幾條 qty 很小
        poNumber: `PO-${10000 + idx}`,
        poLine: '001'
      });
      return;
    }
    
    // 其餘：OK（多次入庫且 qty 充足）
    const poCount = Math.floor(Math.random() * 3) + 2; // 2-4 次
    for (let j = 0; j < poCount; j++) {
      const weekOffset = Math.floor(Math.random() * 3) + 1;
      const timeBucket = `${currentYear}-W${String(currentWeek + weekOffset).padStart(2, '0')}`;
      
      openPOs.push({
        item,
        factory,
        timeBucket,
        timeBucketSortKey: timeBucket,
        qty: Math.floor(Math.random() * 150) + 50,
        poNumber: `PO-${10000 + idx}-${j}`,
        poLine: String(j + 1).padStart(3, '0')
      });
    }
  });
  
  return {
    openPOs,
    inventorySnapshots
  };
};
