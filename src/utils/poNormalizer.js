/**
 * PO Open Lines Normalizer (Bucket-Based Version)
 * 
 * Purpose: Convert Supabase po_open_lines actual fields to standard format
 * Note: po_open_lines has no ETA/date fields, only time_bucket
 * 
 * DB actual fields:
 * - material_code, plant_id, time_bucket, open_qty
 * - po_number, po_line, supplier_id, status
 */

/**
 * Parse time_bucket into a sortable key
 * Supported formats:
 * - YYYY-W## (week, e.g. 2026-W05)
 * - W## (week shorthand, e.g. W05)
 * - YYYY-MM-DD (date, though rare)
 * - Other: return as-is (fallback)
 * 
 * @param {string} timeBucket
 * @returns {Object} { sortKey: string, year: number|null, week: number|null, display: string }
 */
export const parseTimeBucket = (timeBucket) => {
  if (!timeBucket) {
    return { sortKey: 'Z-UNKNOWN', year: null, week: null, display: '(unknown)' };
  }
  
  const str = String(timeBucket).trim().toUpperCase();
  
  // Format 1: YYYY-W## (e.g. 2026-W05)
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
  
  // Format 2: W## (e.g. W05, assumes current year)
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
  
  // Format 3: YYYY-MM-DD (date format, rare)
  const dateMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    return {
      sortKey: str,
      year: parseInt(dateMatch[1], 10),
      week: null,
      display: str
    };
  }
  
  // Format 4: Cannot parse (return as-is)
  return {
    sortKey: str,
    year: null,
    week: null,
    display: str
  };
};

/**
 * Normalize PO Open Line data
 * 
 * @param {Object} raw - Supabase raw data
 * @returns {Object|null} Standard format
 */
export const normalizeOpenPOLine = (raw) => {
  if (!raw) return null;
  
  // Material code
  const item = (raw.material_code || raw.item || '').trim();
  
  // Plant
  const factory = (raw.plant_id || raw.factory || '').trim();
  
  // Time Bucket (don't convert to date, keep original value + parsed sort key)
  const timeBucketParsed = parseTimeBucket(raw.time_bucket);
  
  // Quantity (NaN-tolerant)
  const qtyRaw = raw.open_qty ?? raw.qty ?? 0;
  const qty = parseFloat(qtyRaw);
  const qtySafe = isNaN(qty) ? 0 : qty;
  
  // PO number
  const poNumber = (raw.po_number || '').trim();
  
  // PO line number
  const poLine = (raw.po_line || '').trim();
  
  // Supplier
  const supplierId = (raw.supplier_id || '').trim();
  
  // Status
  const status = (raw.status || 'open').trim();
  
  return {
    item: item || '(unknown)',
    factory: factory || '(unknown)',
    timeBucket: timeBucketParsed.display,      // For display (e.g. 2026-W05)
    timeBucketSortKey: timeBucketParsed.sortKey, // For sorting
    timeBucketYear: timeBucketParsed.year,
    timeBucketWeek: timeBucketParsed.week,
    qty: qtySafe,
    poNumber: poNumber || 'N/A',
    poLine: poLine || '',
    supplierId: supplierId || '',
    status: status,
    _raw: raw // Keep raw data for debug
  };
};

/**
 * Batch normalize
 * 
 * @param {Array<Object>} rawPOs
 * @returns {Array<Object>} Normalized PO list (invalid data filtered out)
 */
export const normalizeOpenPOBatch = (rawPOs = []) => {
  if (!Array.isArray(rawPOs)) return [];
  
  return rawPOs
    .map(normalizeOpenPOLine)
    .filter(po => po && po.item && po.factory); // Filter invalid data
};
