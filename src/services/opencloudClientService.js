// @product: ai-employee
//
// opencloudClientService.js
// ─────────────────────────────────────────────────────────────────────────────
// Thin wrapper around the OpenCloud Libre Graph REST API.
//
// Design decisions:
//   - Custom wrapper instead of the generated SDK to keep bundle small (~250 LOC
//     vs 50+ generated files) and match the codebase's service-module pattern.
//   - Uses fetch (not Axios) since fetch is available everywhere (browser + Node 18+).
//   - All methods return plain objects; errors throw with contextual messages.
//   - Token is supplied via env var; OIDC exchange deferred to Phase 4.
// ─────────────────────────────────────────────────────────────────────────────

import {
  OPENCLOUD_URL,
  OPENCLOUD_TOKEN,
  OPENCLOUD_API_PREFIX,
  isOpenCloudConfigured,
} from '../config/opencloudConfig';

// ── Internal helpers ──────────────────────────────────────────────────────

function baseUrl() {
  return `${OPENCLOUD_URL}${OPENCLOUD_API_PREFIX}`;
}

function headers(contentType) {
  const h = {
    Authorization: `Bearer ${OPENCLOUD_TOKEN}`,
  };
  if (contentType) h['Content-Type'] = contentType;
  return h;
}

async function request(method, path, { body, contentType, raw } = {}) {
  if (!isOpenCloudConfigured()) {
    throw new Error('[OpenCloud] Not configured — set VITE_OPENCLOUD_URL and VITE_OPENCLOUD_TOKEN');
  }

  const url = path.startsWith('http') ? path : `${baseUrl()}${path}`;
  const opts = {
    method,
    headers: headers(contentType || (body && typeof body === 'string' ? 'application/octet-stream' : 'application/json')),
  };

  if (body !== undefined) {
    opts.body = body instanceof Blob || typeof body === 'string' ? body : JSON.stringify(body);
  }

  const res = await fetch(url, opts);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[OpenCloud] ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }

  if (raw) return res;
  if (res.status === 204) return null;

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

// ── Drives (Spaces) ───────────────────────────────────────────────────────

/**
 * List all drives accessible to the current user.
 * @returns {Promise<object[]>} Array of Drive objects
 */
export async function getMyDrives() {
  const data = await request('GET', '/me/drives');
  return data?.value || [];
}

/**
 * Get a specific drive by ID.
 * @param {string} driveId
 * @returns {Promise<object>}
 */
export async function getDrive(driveId) {
  return request('GET', `/drives/${driveId}`);
}

// ── DriveItems (Files & Folders) ──────────────────────────────────────────

/**
 * List children of a folder (or root if folderId is null).
 * @param {string} driveId
 * @param {string|null} folderId - Item ID of the folder, or null for root
 * @returns {Promise<object[]>} Array of DriveItem objects
 */
export async function getDriveItems(driveId, folderId = null) {
  const path = folderId
    ? `/drives/${driveId}/items/${folderId}/children`
    : `/drives/${driveId}/root/children`;
  const data = await request('GET', path);
  return data?.value || [];
}

/**
 * Upload a file to OpenCloud.
 * @param {string} driveId
 * @param {string} parentPath - Folder path from root (e.g. '/Decision-Intelligence/reports')
 * @param {string} filename - File name
 * @param {Blob|string} content - File content
 * @param {string} [contentType] - MIME type
 * @returns {Promise<object>} Created DriveItem
 */
export async function uploadFile(driveId, parentPath, filename, content, contentType) {
  // Libre Graph API uses PUT on the content URL for simple uploads
  const encodedPath = parentPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const encodedName = encodeURIComponent(filename);
  const url = `/drives/${driveId}/root:/${encodedPath}/${encodedName}:/content`;
  return request('PUT', url, { body: content, contentType: contentType || 'application/octet-stream' });
}

/**
 * Download file content.
 * @param {string} driveId
 * @param {string} itemId
 * @returns {Promise<Response>} Raw fetch Response (use .blob(), .text(), .arrayBuffer())
 */
export async function downloadFile(driveId, itemId) {
  return request('GET', `/drives/${driveId}/items/${itemId}/content`, { raw: true });
}

/**
 * Get a DriveItem by ID (metadata only, no content).
 * @param {string} driveId
 * @param {string} itemId
 * @returns {Promise<object>}
 */
export async function getItem(driveId, itemId) {
  return request('GET', `/drives/${driveId}/items/${itemId}`);
}

/**
 * Delete a DriveItem.
 * @param {string} driveId
 * @param {string} itemId
 * @returns {Promise<null>}
 */
export async function deleteItem(driveId, itemId) {
  return request('DELETE', `/drives/${driveId}/items/${itemId}`);
}

/**
 * Create a folder.
 * @param {string} driveId
 * @param {string} parentItemId - Parent folder item ID (use 'root' for root)
 * @param {string} folderName
 * @returns {Promise<object>} Created folder DriveItem
 */
export async function createFolder(driveId, parentItemId, folderName) {
  const parentPart = parentItemId === 'root' ? 'root' : `items/${parentItemId}`;
  return request('POST', `/drives/${driveId}/${parentPart}/children`, {
    body: {
      name: folderName,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    },
  });
}

/**
 * Ensure a folder path exists, creating intermediate folders as needed.
 * Like `mkdir -p` for OpenCloud drives.
 *
 * @param {string} driveId
 * @param {string} folderPath - e.g. 'Decision-Intelligence/tasks/abc123'
 * @returns {Promise<string>} The item ID of the final (deepest) folder
 */
export async function ensureFolder(driveId, folderPath) {
  const segments = folderPath.split('/').filter(Boolean);
  let currentParentId = 'root';

  for (const segment of segments) {
    // List children and check if folder already exists
    const children = await getDriveItems(driveId, currentParentId === 'root' ? null : currentParentId);
    const existing = children.find(
      (c) => c.folder && c.name.toLowerCase() === segment.toLowerCase()
    );

    if (existing) {
      currentParentId = existing.id;
    } else {
      try {
        const created = await createFolder(driveId, currentParentId, segment);
        currentParentId = created.id;
      } catch (err) {
        // Race condition: folder may have been created between list and create
        if (err.message?.includes('409') || err.message?.includes('ALREADY_EXISTS')) {
          const retry = await getDriveItems(driveId, currentParentId === 'root' ? null : currentParentId);
          const found = retry.find((c) => c.folder && c.name.toLowerCase() === segment.toLowerCase());
          if (found) {
            currentParentId = found.id;
            continue;
          }
        }
        throw err;
      }
    }
  }

  return currentParentId;
}

// ── Sharing ───────────────────────────────────────────────────────────────

/**
 * Create a public sharing link for a DriveItem.
 * @param {string} driveId
 * @param {string} itemId
 * @param {{ type?: string, password?: string }} [opts]
 * @returns {Promise<object>} Sharing link object
 */
export async function createSharingLink(driveId, itemId, opts = {}) {
  return request('POST', `/drives/${driveId}/items/${itemId}/createLink`, {
    body: {
      type: opts.type || 'view',
      ...(opts.password ? { password: opts.password } : {}),
    },
  });
}

/**
 * Send a share invitation to a user by email.
 * @param {string} driveId
 * @param {string} itemId
 * @param {string} recipientEmail
 * @param {string} [role='viewer'] - 'viewer' | 'editor'
 * @returns {Promise<object>}
 */
export async function sendShareInvitation(driveId, itemId, recipientEmail, role = 'viewer') {
  return request('POST', `/drives/${driveId}/items/${itemId}/invite`, {
    body: {
      recipients: [{ objectId: recipientEmail }],
      roles: [role],
    },
  });
}

/**
 * List permissions/shares on a DriveItem.
 * @param {string} driveId
 * @param {string} itemId
 * @returns {Promise<object[]>}
 */
export async function listPermissions(driveId, itemId) {
  const data = await request('GET', `/drives/${driveId}/items/${itemId}/permissions`);
  return data?.value || [];
}

// ── Search ────────────────────────────────────────────────────────────────

/**
 * Search for files in a drive.
 * @param {string} driveId
 * @param {string} query - Search term
 * @returns {Promise<object[]>} Matching DriveItems
 */
export async function searchFiles(driveId, query) {
  const data = await request('GET', `/drives/${driveId}/root/search(q='${encodeURIComponent(query)}')`);
  return data?.value || [];
}

// ── Tags ──────────────────────────────────────────────────────────────────

/**
 * Add tags to a DriveItem.
 * @param {string} driveId
 * @param {string} itemId
 * @param {string[]} tags
 * @returns {Promise<object>}
 */
export async function addTags(driveId, itemId, tags) {
  return request('PATCH', `/drives/${driveId}/items/${itemId}`, {
    body: { tags },
  });
}

// ── Activities ────────────────────────────────────────────────────────────

/**
 * Get recent activities for a drive.
 * @param {string} driveId
 * @returns {Promise<object[]>}
 */
export async function getActivities(driveId) {
  const data = await request('GET', `/drives/${driveId}/activities`);
  return data?.value || [];
}

// ── Health Check ──────────────────────────────────────────────────────────

/**
 * Check if the OpenCloud server is healthy.
 * @returns {Promise<boolean>}
 */
export async function checkHealth() {
  if (!isOpenCloudConfigured()) return false;
  try {
    const res = await fetch(`${OPENCLOUD_URL}/healthz`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

// ── User Info ─────────────────────────────────────────────────────────────

/**
 * Get the current authenticated user's profile.
 * @returns {Promise<object>}
 */
export async function getMe() {
  return request('GET', '/me');
}

// ── SSE (Server-Sent Events) ────────────────────────────────────────────

/**
 * Connect to OpenCloud's Server-Sent Events stream for real-time file notifications.
 * Returns an EventSource-like controller.
 *
 * Event types emitted: FILE_TOUCHED, FOLDER_CREATED, ITEM_MOVED, ITEM_RENAMED,
 *                      ITEM_RESTORED, ITEM_TRASHED, SHARE_CREATED, SHARE_REMOVED
 *
 * @param {function} onEvent - Callback: (eventType, data) => void
 * @param {function} [onError] - Error callback
 * @returns {{ close: function }} Controller with close() method
 */
export function connectSSE(onEvent, onError) {
  if (!isOpenCloudConfigured()) {
    throw new Error('[OpenCloud] Not configured for SSE');
  }

  const url = `${OPENCLOUD_URL}/ocs/v2.php/apps/notifications/api/v1/notifications/sse`;
  const es = new EventSource(url, {
    // EventSource doesn't natively support headers, so we append token as query param
    // In production, use a proxy or polyfill that supports headers
  });

  // Fallback: if EventSource doesn't support auth headers, use fetch-based SSE
  let controller = null;
  let aborted = false;

  const startFetchSSE = async () => {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${OPENCLOUD_TOKEN}`, Accept: 'text/event-stream' },
        signal: (controller = new AbortController()).signal,
      });

      if (!res.ok) {
        onError?.(new Error(`SSE connection failed: ${res.status}`));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = 'message';
        let currentData = '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            currentData += line.slice(5).trim();
          } else if (line === '') {
            if (currentData) {
              try {
                const parsed = JSON.parse(currentData);
                onEvent(currentEvent, parsed);
              } catch {
                onEvent(currentEvent, currentData);
              }
            }
            currentEvent = 'message';
            currentData = '';
          }
        }
      }
    } catch (err) {
      if (!aborted) onError?.(err);
    }
  };

  // Close the native EventSource (unused path) and use fetch-based instead
  es.close();
  startFetchSSE();

  return {
    close() {
      aborted = true;
      controller?.abort();
    },
  };
}

// ── Full-Text Search (Bleve + Tika) ─────────────────────────────────────

/**
 * Full-text search across all drives using OpenCloud's search API.
 * Leverages Bleve indexing + Apache Tika content extraction.
 *
 * @param {string} query - Search query (supports KQL: `Tags:di_forecast`, `name:report`)
 * @param {{ driveId?: string, limit?: number }} [opts]
 * @returns {Promise<object[]>} Matching DriveItems with highlights
 */
export async function searchAllDrives(query, opts = {}) {
  if (opts.driveId) {
    return searchFiles(opts.driveId, query);
  }

  // Search across all accessible drives
  const drives = await getMyDrives();
  const results = [];

  for (const drive of drives) {
    try {
      const items = await searchFiles(drive.id, query);
      results.push(...items.map((item) => ({ ...item, _driveId: drive.id, _driveName: drive.name })));
    } catch { /* skip inaccessible drives */ }
  }

  return opts.limit ? results.slice(0, opts.limit) : results;
}

// ── Tag Helpers ──────────────────────────────────────────────────────────

/**
 * Remove tags from a DriveItem.
 * @param {string} driveId
 * @param {string} itemId
 * @param {string[]} tagsToRemove
 * @returns {Promise<object>}
 */
export async function removeTags(driveId, itemId, tagsToRemove) {
  const item = await getItem(driveId, itemId);
  const currentTags = item?.tags || [];
  const newTags = currentTags.filter((t) => !tagsToRemove.includes(t));
  return addTags(driveId, itemId, newTags);
}

/**
 * Search for files by tag across a drive.
 * Uses KQL tag query syntax.
 * @param {string} driveId
 * @param {string} tag
 * @returns {Promise<object[]>}
 */
export async function searchByTag(driveId, tag) {
  return searchFiles(driveId, `Tags:${tag}`);
}

export default {
  getMyDrives,
  getDrive,
  getDriveItems,
  uploadFile,
  downloadFile,
  getItem,
  deleteItem,
  createFolder,
  ensureFolder,
  createSharingLink,
  sendShareInvitation,
  listPermissions,
  searchFiles,
  searchAllDrives,
  addTags,
  removeTags,
  searchByTag,
  getActivities,
  checkHealth,
  getMe,
  connectSSE,
};
