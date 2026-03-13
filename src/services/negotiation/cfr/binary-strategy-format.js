/**
 * Binary Strategy Format — Ported from CardPilot's binary-format.ts
 *
 * Compact binary format for CFR strategy storage with O(log n) lookup.
 *
 * Format:
 *   Header (32 bytes):
 *     [4B] magic "CFR1"/"CFR2"  [2B] version  [2B] bucketCount
 *     [4B] numFlops/scenarios   [4B] iterations  [4B] indexOffset
 *     [4B] entryCount           [8B] reserved
 *
 *   Index (entryCount * 8 bytes, sorted by hash for binary search):
 *     [4B] fnv1a hash of key   [4B] body offset
 *
 *   Body (variable):
 *     [1B] numActions  [numActions bytes] uint8 quantized probs (0-255)
 *
 * Typical compression: 513MB JSONL → ~30MB .cfr2.gz
 */

// gunzipSync is lazy-loaded to avoid crashing in browser environments
// where node:zlib is externalized by Vite.
let _gunzipSync = null;
function getGunzipSync() {
  if (!_gunzipSync) {
    try {
      // Dynamic require — only works in Node.js (tests, SSR, build scripts)
      // eslint-disable-next-line no-eval
      _gunzipSync = eval('require')('zlib').gunzipSync;
    } catch {
      // Browser fallback: use DecompressionStream API
      _gunzipSync = null;
    }
  }
  return _gunzipSync;
}

// ── Constants ───────────────────────────────────────────────────────────────

const HEADER_SIZE = 32;

// ── Hash & Quantization ─────────────────────────────────────────────────────

/**
 * FNV-1a hash (32-bit, unsigned).
 */
export function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Quantize probability [0, 1] to uint8 [0, 255].
 */
export function quantizeProb(p) {
  return Math.max(0, Math.min(255, Math.round(p * 255)));
}

/**
 * Dequantize uint8 [0, 255] back to probability [0, 1].
 */
export function dequantizeProb(b) {
  return b / 255;
}

// ── Writer (create binary format from strategy entries) ─────────────────────

/**
 * Build a binary strategy buffer from an array of { key, probs } entries.
 *
 * @param {Array<{key: string, probs: number[]}>} entries
 * @param {Object} [meta] - { iterations, bucketCount, numScenarios }
 * @returns {Buffer} Raw (uncompressed) binary buffer
 */
export function buildBinaryBuffer(entries, meta = {}) {
  const { iterations = 50000, bucketCount = 5, numScenarios = 1 } = meta;
  const totalEntries = entries.length;

  // Compute body size
  let totalBodySize = 0;
  for (const entry of entries) {
    totalBodySize += 1 + entry.probs.length;
  }

  // Build index + body
  const indexBuf = Buffer.alloc(totalEntries * 12); // hash + offset + numActions (for sorting)
  const bodyBuf = Buffer.alloc(totalBodySize);
  let bodyOffset = 0;

  for (let i = 0; i < totalEntries; i++) {
    const { key, probs } = entries[i];
    const hash = fnv1a(key);
    const numActions = probs.length;

    // Index entry: hash, bodyOffset, numActions
    const iOff = i * 12;
    indexBuf.writeUInt32LE(hash, iOff);
    indexBuf.writeUInt32LE(bodyOffset, iOff + 4);
    indexBuf.writeUInt32LE(numActions, iOff + 8);

    // Body: [numActions] [quantized probs...]
    bodyBuf[bodyOffset] = numActions;
    for (let j = 0; j < numActions; j++) {
      bodyBuf[bodyOffset + 1 + j] = quantizeProb(probs[j]);
    }
    bodyOffset += 1 + numActions;
  }

  // Sort index by hash (simple sort for small negotiation strategy sets)
  const sortedEntries = [];
  for (let i = 0; i < totalEntries; i++) {
    sortedEntries.push({
      hash: indexBuf.readUInt32LE(i * 12),
      bodyOffset: indexBuf.readUInt32LE(i * 12 + 4),
    });
  }
  sortedEntries.sort((a, b) => a.hash - b.hash);

  // Assemble final binary
  const indexSize = totalEntries * 8;
  const buffer = Buffer.alloc(HEADER_SIZE + indexSize + totalBodySize);

  // Header
  buffer.write('CFR2', 0);
  buffer.writeUInt16LE(1, 4);                    // version
  buffer.writeUInt16LE(bucketCount, 6);
  buffer.writeUInt32LE(numScenarios, 8);
  buffer.writeUInt32LE(iterations, 12);
  buffer.writeUInt32LE(HEADER_SIZE, 16);          // indexOffset
  buffer.writeUInt32LE(totalEntries, 20);         // entryCount

  // Sorted index (hash + bodyOffset, 8 bytes each)
  let off = HEADER_SIZE;
  for (const entry of sortedEntries) {
    buffer.writeUInt32LE(entry.hash, off);
    buffer.writeUInt32LE(entry.bodyOffset, off + 4);
    off += 8;
  }

  // Copy body
  bodyBuf.copy(buffer, HEADER_SIZE + indexSize);

  return buffer;
}

// ── Reader (O(log n) lookup) ────────────────────────────────────────────────

/**
 * BinaryStrategyReader — O(log n) lookup for pre-computed CFR strategies.
 *
 * Ported from CardPilot/packages/cfr-solver/src/storage/binary-format.ts
 */
export class BinaryStrategyReader {
  /**
   * @param {Buffer} input - Raw or gzip-compressed binary buffer
   */
  constructor(input) {
    // Decompress if gzipped (magic bytes 0x1f 0x8b)
    if (input[0] === 0x1f && input[1] === 0x8b) {
      const gunzip = getGunzipSync();
      if (!gunzip) {
        throw new Error('gzip decompression not available in this environment. Provide an uncompressed buffer.');
      }
      this._buffer = gunzip(input);
    } else {
      this._buffer = input;
    }

    // Validate magic
    const magic = this._buffer.subarray(0, 4).toString();
    if (magic !== 'CFR1' && magic !== 'CFR2') {
      throw new Error(`Invalid binary format: expected CFR1 or CFR2, got ${magic}`);
    }

    this._indexStart = this._buffer.readUInt32LE(16);
    this._indexCount = this._buffer.readUInt32LE(20);
    this._bodyStart = this._indexStart + this._indexCount * 8;
  }

  /**
   * O(log n) lookup by info-set key string.
   *
   * @param {string} key - Info-set key (e.g., 'B|2|OPENING|')
   * @returns {number[]|null} Dequantized action probabilities, or null if not found
   */
  lookup(key) {
    if (this._indexCount === 0) return null;
    const hash = fnv1a(key);

    let lo = 0;
    let hi = this._indexCount - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const entryHash = this._buffer.readUInt32LE(this._indexStart + mid * 8);

      if (entryHash === hash) {
        const bodyOff = this._buffer.readUInt32LE(this._indexStart + mid * 8 + 4);
        const abs = this._bodyStart + bodyOff;
        const n = this._buffer[abs];
        const probs = [];
        for (let i = 0; i < n; i++) {
          probs.push(dequantizeProb(this._buffer[abs + 1 + i]));
        }
        return probs;
      }

      if (entryHash < hash) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return null;
  }

  get entryCount() { return this._indexCount; }
  get version() { return this._buffer.readUInt16LE(4); }
  get numScenarios() { return this._buffer.readUInt32LE(8); }
  get iterations() { return this._buffer.readUInt32LE(12); }
  get bucketCount() { return this._buffer.readUInt16LE(6); }
}
