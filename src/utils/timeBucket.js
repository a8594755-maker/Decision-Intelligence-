/**
 * timeBucket.js — Shared ISO 8601 week/bucket utilities.
 *
 * Correct ISO 8601 week: week 1 is the week containing the first Thursday
 * of the year (equivalently, the week containing January 4th).
 * Weeks start on Monday.
 */

/**
 * Returns the ISO 8601 week number and year for a given date.
 * @param {Date} date
 * @returns {{ year: number, week: number }}
 */
export function getIsoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Set to nearest Thursday: current date + 4 - current day number (Mon=1, Sun=7)
  const dayNum = d.getUTCDay() || 7; // Make Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  // Get first day of year
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  // Calculate full weeks between yearStart and Thursday
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNo };
}

/**
 * Format a date as an ISO week bucket string: "YYYY-WNN"
 * @param {Date|string|number} date
 * @returns {string}
 */
export function dateToWeekBucket(date) {
  const d = date instanceof Date ? date : new Date(date);
  const { year, week } = getIsoWeek(d);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Map a date to a time bucket (week or month format).
 * @param {Date|string|number} date
 * @param {'week'|'month'} [bucketFormat='week']
 * @returns {string} "YYYY-WNN" or "YYYY-MM"
 */
export function dateToBucket(date, bucketFormat = 'week') {
  const d = date instanceof Date ? date : new Date(date);
  if (bucketFormat === 'week') {
    return dateToWeekBucket(d);
  }
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${month}`;
}

/**
 * Get the current time bucket.
 * @param {'week'|'month'} [bucketFormat='week']
 * @returns {string}
 */
export function getCurrentTimeBucket(bucketFormat = 'week') {
  return dateToBucket(new Date(), bucketFormat);
}

/**
 * Parse a week bucket string "YYYY-WNN" into { year, week }.
 * Returns null if format is invalid.
 * @param {string} bucket
 * @returns {{ year: number, week: number } | null}
 */
export function parseWeekBucket(bucket) {
  const m = String(bucket).match(/^(\d{4})-W(\d{2})$/);
  if (!m) return null;
  return { year: Number(m[1]), week: Number(m[2]) };
}

/**
 * Calculate the difference in weeks between two week buckets.
 * @param {string} a - "YYYY-WNN"
 * @param {string} b - "YYYY-WNN"
 * @returns {number} b - a in weeks (can be negative)
 */
export function weekDiff(a, b) {
  const pa = parseWeekBucket(a);
  const pb = parseWeekBucket(b);
  if (!pa || !pb) return 0;
  // ISO year has either 52 or 53 weeks; approximate with 52 for cross-year diffs
  // For exact diff, compute via dates
  const weeksA = pa.year * 52 + pa.week;
  const weeksB = pb.year * 52 + pb.week;
  return weeksB - weeksA;
}

/**
 * Shift a week bucket forward or backward by N weeks.
 * @param {string} bucket - "YYYY-WNN"
 * @param {number} offsetWeeks - positive = forward, negative = backward
 * @returns {string} "YYYY-WNN"
 */
export function shiftBucket(bucket, offsetWeeks) {
  const parsed = parseWeekBucket(bucket);
  if (!parsed) return bucket;
  // Convert to a date (Thursday of that ISO week), shift, then back to bucket
  const jan4 = new Date(Date.UTC(parsed.year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  // Monday of week 1
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1);
  // Thursday of target week
  const targetDate = new Date(week1Monday);
  targetDate.setUTCDate(week1Monday.getUTCDate() + (parsed.week - 1) * 7 + 3 + offsetWeeks * 7);
  return dateToWeekBucket(targetDate);
}
