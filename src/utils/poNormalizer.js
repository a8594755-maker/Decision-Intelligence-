/**
 * PO Open Lines Normalizer（Bucket-Based Version）
 * 
 * 用途：將 Supabase po_open_lines 的真實欄位轉換為標準格式
 * 注意：po_open_lines 沒有 ETA/日期欄位，只有 time_bucket
 * 
 * DB 真實欄位：
 * - material_code, plant_id, time_bucket, open_qty
 * - po_number, po_line, supplier_id, status
 */

/**
 * 解析 time_bucket 為可排序的 key
 * 支援格式：
 * - YYYY-W## （週別，如 2026-W05）
 * - W## （週別簡寫，如 W05）
 * - YYYY-MM-DD （日期，雖然罕見）
 * - 其他：原樣返回（fallback）
 * 
 * @param {string} timeBucket
 * @returns {Object} { sortKey: string, year: number|null, week: number|null, display: string }
 */
export const parseTimeBucket = (timeBucket) => {
  if (!timeBucket) {
    return { sortKey: 'Z-UNKNOWN', year: null, week: null, display: '(unknown)' };
  }
  
  const str = String(timeBucket).trim().toUpperCase();
  
  // 格式 1: YYYY-W## （如 2026-W05）
  const fullWeekMatch = str.match(/^(\d{4})-W(\d{2})$/);
  if (fullWeekMatch) {
    const year = parseInt(fullWeekMatch[1], 10);
    const week = parseInt(fullWeekMatch[2], 10);
    return {
      sortKey: `${year}-W${String(week).padStart(2, '0')}`,
      year,
      week,
      display: `${year}-W${String(week).padStart(2, '0')}`
    };
  }
  
  // 格式 2: W## （如 W05，假設當前年份）
  const shortWeekMatch = str.match(/^W(\d{2})$/);
  if (shortWeekMatch) {
    const week = parseInt(shortWeekMatch[1], 10);
    const currentYear = new Date().getFullYear();
    return {
      sortKey: `${currentYear}-W${String(week).padStart(2, '0')}`,
      year: currentYear,
      week,
      display: `${currentYear}-W${String(week).padStart(2, '0')}`
    };
  }
  
  // 格式 3: YYYY-MM-DD （日期格式，罕見）
  const dateMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    return {
      sortKey: str,
      year: parseInt(dateMatch[1], 10),
      week: null,
      display: str
    };
  }
  
  // 格式 4: 無法解析（原樣返回）
  return {
    sortKey: str,
    year: null,
    week: null,
    display: str
  };
};

/**
 * 正規化 PO Open Line 資料
 * 
 * @param {Object} raw - Supabase 原始資料
 * @returns {Object|null} 標準格式
 */
export const normalizeOpenPOLine = (raw) => {
  if (!raw) return null;
  
  // 料號
  const item = (raw.material_code || raw.item || '').trim();
  
  // 工廠
  const factory = (raw.plant_id || raw.factory || '').trim();
  
  // Time Bucket（不轉日期，保留原值 + 解析後的排序 key）
  const timeBucketParsed = parseTimeBucket(raw.time_bucket);
  
  // 數量（容錯 NaN）
  const qtyRaw = raw.open_qty ?? raw.qty ?? 0;
  const qty = parseFloat(qtyRaw);
  const qtySafe = isNaN(qty) ? 0 : qty;
  
  // PO 號碼
  const poNumber = (raw.po_number || '').trim();
  
  // PO 行號
  const poLine = (raw.po_line || '').trim();
  
  // 供應商
  const supplierId = (raw.supplier_id || '').trim();
  
  // 狀態
  const status = (raw.status || 'open').trim();
  
  return {
    item: item || '(unknown)',
    factory: factory || '(unknown)',
    timeBucket: timeBucketParsed.display,      // 顯示用（如 2026-W05）
    timeBucketSortKey: timeBucketParsed.sortKey, // 排序用
    timeBucketYear: timeBucketParsed.year,
    timeBucketWeek: timeBucketParsed.week,
    qty: qtySafe,
    poNumber: poNumber || 'N/A',
    poLine: poLine || '',
    supplierId: supplierId || '',
    status: status,
    _raw: raw // 保留原始資料供 debug
  };
};

/**
 * 批量正規化
 * 
 * @param {Array<Object>} rawPOs
 * @returns {Array<Object>} 正規化後的 PO 列表（過濾掉無效資料）
 */
export const normalizeOpenPOBatch = (rawPOs = []) => {
  if (!Array.isArray(rawPOs)) return [];
  
  return rawPOs
    .map(normalizeOpenPOLine)
    .filter(po => po && po.item && po.factory); // 過濾無效資料
};
