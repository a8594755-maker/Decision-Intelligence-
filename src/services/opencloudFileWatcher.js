// @product: ai-employee
//
// opencloudFileWatcher.js
// ─────────────────────────────────────────────────────────────────────────────
// Watches OpenCloud folders for new/modified files and emits events.
//
// Two modes:
//   1. Polling (default) — periodic GET on folder children, compares fingerprints
//   2. SSE (preferred)   — connects to OpenCloud's Server-Sent Events stream
//                          for real-time notifications, falls back to polling
//
// SSE events from OpenCloud:
//   FILE_TOUCHED, FOLDER_CREATED, ITEM_MOVED, ITEM_RENAMED,
//   ITEM_RESTORED, ITEM_TRASHED, SHARE_CREATED, SHARE_REMOVED
// ─────────────────────────────────────────────────────────────────────────────

import { getDriveItems, connectSSE } from './opencloudClientService';
import { isOpenCloudConfigured } from '../config/opencloudConfig';
import { eventBus, EVENT_NAMES } from './eventBus';

// ── Active watchers ───────────────────────────────────────────────────────

const _watchers = new Map(); // watcherId → { intervalId|sseController, driveId, folderId, lastSeen, mode }
let _watcherIdCounter = 0;

// ── SSE event types we care about ─────────────────────────────────────────

const SSE_FILE_EVENTS = new Set([
  'FILE_TOUCHED', 'ITEM_MOVED', 'ITEM_RENAMED', 'ITEM_RESTORED',
]);

const SSE_FOLDER_EVENTS = new Set([
  'FOLDER_CREATED', 'ITEM_TRASHED',
]);

// ── Helpers ───────────────────────────────────────────────────────────────

function itemFingerprint(item) {
  return `${item.id}::${item.lastModifiedDateTime || item.eTag || ''}`;
}

function matchesFilter(name, filter) {
  if (!filter?.length) return true;
  return filter.some((ext) => name.toLowerCase().endsWith(ext));
}

// ── Polling mode ──────────────────────────────────────────────────────────

/**
 * Start watching an OpenCloud folder using polling.
 *
 * @param {string} driveId
 * @param {string|null} folderId - Folder item ID (null = root)
 * @param {number} [intervalMs=60000] - Polling interval in ms
 * @param {{ filter?: string[] }} [opts] - File extension filter
 * @returns {string} Watcher ID (use to stop watching)
 */
export function startWatching(driveId, folderId = null, intervalMs = 60000, opts = {}) {
  if (!isOpenCloudConfigured()) {
    console.warn('[opencloudFileWatcher] OpenCloud not configured');
    return null;
  }

  const watcherId = `watcher_${++_watcherIdCounter}`;
  const state = {
    mode: 'polling',
    driveId,
    folderId,
    lastSeen: new Set(),
    intervalId: null,
    sseController: null,
  };

  const poll = async () => {
    try {
      let items = await getDriveItems(driveId, folderId);

      // Apply extension filter
      if (opts.filter?.length) {
        items = items.filter((item) => {
          if (item.folder) return false;
          return matchesFilter(item.name || '', opts.filter);
        });
      } else {
        items = items.filter((item) => !item.folder);
      }

      const currentFingerprints = new Set(items.map(itemFingerprint));

      for (const item of items) {
        const fp = itemFingerprint(item);
        if (!state.lastSeen.has(fp)) {
          eventBus.emit(EVENT_NAMES.OPENCLOUD_FILE_DETECTED, {
            watcherId,
            driveId,
            item,
            source: 'polling',
            detectedAt: new Date().toISOString(),
          });
        }
      }

      state.lastSeen = currentFingerprints;
    } catch (err) {
      console.warn(`[opencloudFileWatcher] Poll failed for ${watcherId}:`, err?.message);
    }
  };

  // Initial poll (skip detection on first run to avoid flooding)
  getDriveItems(driveId, folderId)
    .then((items) => {
      const files = items.filter((i) => !i.folder);
      state.lastSeen = new Set(files.map(itemFingerprint));
    })
    .catch(() => { /* best-effort initial seed */ });

  state.intervalId = setInterval(poll, intervalMs);
  _watchers.set(watcherId, state);

  console.log(`[opencloudFileWatcher] Started ${watcherId} (polling): drive=${driveId}, folder=${folderId || 'root'}, interval=${intervalMs}ms`);
  return watcherId;
}

// ── SSE mode ──────────────────────────────────────────────────────────────

/**
 * Start watching using SSE (Server-Sent Events) for real-time notifications.
 * Falls back to polling if SSE connection fails.
 *
 * @param {string} driveId - Drive to watch
 * @param {string|null} folderId - Folder item ID (null = all files in drive)
 * @param {{ filter?: string[], fallbackIntervalMs?: number }} [opts]
 * @returns {string} Watcher ID
 */
export function startWatchingSSE(driveId, folderId = null, opts = {}) {
  if (!isOpenCloudConfigured()) {
    console.warn('[opencloudFileWatcher] OpenCloud not configured');
    return null;
  }

  const watcherId = `watcher_sse_${++_watcherIdCounter}`;
  const state = {
    mode: 'sse',
    driveId,
    folderId,
    lastSeen: new Set(),
    intervalId: null,
    sseController: null,
  };

  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 10;
  const RECONNECT_BASE_MS = 2000;

  const handleSSEEvent = (eventType, data) => {
    // Filter to relevant events
    if (!SSE_FILE_EVENTS.has(eventType) && !SSE_FOLDER_EVENTS.has(eventType)) return;

    // If watching a specific folder, check if event is in that folder
    if (folderId && data?.parentReference?.id && data.parentReference.id !== folderId) return;

    // If watching a specific drive, check drive ID
    if (data?.parentReference?.driveId && data.parentReference.driveId !== driveId) return;

    // Apply file extension filter
    if (SSE_FILE_EVENTS.has(eventType) && data?.name) {
      if (!matchesFilter(data.name, opts.filter)) return;
    }

    eventBus.emit(EVENT_NAMES.OPENCLOUD_FILE_DETECTED, {
      watcherId,
      driveId,
      item: data,
      sseEventType: eventType,
      source: 'sse',
      detectedAt: new Date().toISOString(),
    });

    // Also emit specific SSE events for subscribers who need them
    eventBus.emit(`opencloud:sse:${eventType.toLowerCase()}`, {
      watcherId,
      driveId,
      data,
    });
  };

  const connectWithReconnect = () => {
    try {
      state.sseController = connectSSE(
        handleSSEEvent,
        (err) => {
          console.warn(`[opencloudFileWatcher] SSE error for ${watcherId}:`, err?.message);

          if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            const backoff = RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts);
            reconnectAttempts++;
            console.log(`[opencloudFileWatcher] SSE reconnecting in ${backoff}ms (attempt ${reconnectAttempts})`);
            reconnectTimer = setTimeout(connectWithReconnect, backoff);
          } else {
            // Max reconnect attempts exceeded — fall back to polling
            console.warn(`[opencloudFileWatcher] SSE max reconnects reached for ${watcherId}, falling back to polling`);
            state.mode = 'polling_fallback';
            state.intervalId = setInterval(async () => {
              try {
                let items = await getDriveItems(driveId, folderId);
                if (opts.filter?.length) {
                  items = items.filter((item) => !item.folder && matchesFilter(item.name || '', opts.filter));
                } else {
                  items = items.filter((item) => !item.folder);
                }
                for (const item of items) {
                  const fp = itemFingerprint(item);
                  if (!state.lastSeen.has(fp)) {
                    eventBus.emit(EVENT_NAMES.OPENCLOUD_FILE_DETECTED, {
                      watcherId, driveId, item, source: 'polling_fallback',
                      detectedAt: new Date().toISOString(),
                    });
                  }
                }
                state.lastSeen = new Set(items.map(itemFingerprint));
              } catch { /* best-effort fallback */ }
            }, opts.fallbackIntervalMs || 60000);
          }
        }
      );

      reconnectAttempts = 0;
      console.log(`[opencloudFileWatcher] SSE connected for ${watcherId}`);
    } catch (err) {
      console.warn(`[opencloudFileWatcher] SSE connect failed for ${watcherId}:`, err?.message);
      // Immediate fallback to polling
      return startWatching(driveId, folderId, opts.fallbackIntervalMs || 60000, opts);
    }
  };

  connectWithReconnect();
  _watchers.set(watcherId, state);

  return watcherId;
}

/**
 * Start watching using the best available method.
 * Tries SSE first, falls back to polling.
 *
 * @param {string} driveId
 * @param {string|null} folderId
 * @param {{ filter?: string[], intervalMs?: number, preferSSE?: boolean }} [opts]
 * @returns {string} Watcher ID
 */
export function startWatchingAuto(driveId, folderId = null, opts = {}) {
  if (opts.preferSSE !== false) {
    try {
      return startWatchingSSE(driveId, folderId, opts);
    } catch {
      // SSE unavailable, fall through to polling
    }
  }
  return startWatching(driveId, folderId, opts.intervalMs || 60000, opts);
}

// ── Stop / List ───────────────────────────────────────────────────────────

/**
 * Stop watching a folder.
 * @param {string} watcherId
 * @returns {boolean} true if watcher was found and stopped
 */
export function stopWatching(watcherId) {
  const state = _watchers.get(watcherId);
  if (!state) return false;

  if (state.intervalId) clearInterval(state.intervalId);
  if (state.sseController) state.sseController.close();
  _watchers.delete(watcherId);
  console.log(`[opencloudFileWatcher] Stopped ${watcherId} (${state.mode})`);
  return true;
}

/**
 * Stop all active watchers.
 */
export function stopAll() {
  for (const [id] of _watchers) {
    stopWatching(id);
  }
}

/**
 * List active watchers.
 * @returns {{ watcherId: string, driveId: string, folderId: string|null, mode: string }[]}
 */
export function listWatchers() {
  return Array.from(_watchers.entries()).map(([id, state]) => ({
    watcherId: id,
    driveId: state.driveId,
    folderId: state.folderId,
    mode: state.mode,
    trackedFiles: state.lastSeen.size,
  }));
}

export default { startWatching, startWatchingSSE, startWatchingAuto, stopWatching, stopAll, listWatchers };
