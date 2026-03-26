/**
 * indexedDbCache.js — IndexedDB-backed cache for large data (Insights dashboards, etc.)
 * Replaces localStorage for data that exceeds 5MB limit.
 * Simple key-value store with optional fingerprint matching.
 */

const DB_NAME = 'di_cache';
const DB_VERSION = 1;
const STORE_NAME = 'cache';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

/**
 * Get cached data by key. Optionally checks fingerprint.
 * @param {string} key
 * @param {string} [fingerprint] — if provided, only returns data if fingerprint matches
 * @returns {Promise<object|null>}
 */
export async function getCached(key, fingerprint) {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => {
        const entry = req.result;
        if (!entry) { console.info(`[idb] Miss: ${key} — not found`); return resolve(null); }
        if (fingerprint && entry.fingerprint !== fingerprint) {
          console.info(`[idb] Miss: ${key} — fingerprint mismatch`);
          return resolve(null);
        }
        const age = Math.round((Date.now() - (entry.timestamp || 0)) / 1000);
        console.info(`[idb] Hit: ${key}, age=${age}s`);
        resolve(entry.data);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/**
 * Save data to cache.
 * @param {string} key
 * @param {object} data
 * @param {string} [fingerprint]
 */
export async function setCached(key, data, fingerprint) {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({
        key,
        data,
        fingerprint: fingerprint || null,
        timestamp: Date.now(),
      });
      tx.oncomplete = () => { console.info(`[idb] Saved: ${key}`); resolve(); };
      tx.onerror = () => resolve();
    });
  } catch (e) {
    console.warn(`[idb] Save failed: ${key} — ${e.message}`);
  }
}

/**
 * Delete cached data.
 * @param {string} key
 */
export async function clearCached(key) {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* */ }
}

/**
 * Get all entries (for history/listing).
 * @param {string} [prefix] — optional key prefix filter
 * @returns {Promise<object[]>}
 */
export async function getAllCached(prefix) {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        let results = req.result || [];
        if (prefix) results = results.filter(e => e.key.startsWith(prefix));
        resolve(results.map(e => e.data));
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}
