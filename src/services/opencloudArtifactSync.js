// @product: ai-employee
//
// opencloudArtifactSync.js
// ─────────────────────────────────────────────────────────────────────────────
// Bridges the DI artifact system to OpenCloud file storage.
//
// Key operations:
//   - syncArtifactToOpenCloud()      — single artifact → file upload
//   - syncTaskOutputsToOpenCloud()   — all artifacts from a completed task
//   - importDatasetFromOpenCloud()   — download file → create dataset profile
//
// Retry strategy: inspired by OpenCloud's postprocessing retry pattern
//   backoff = SYNC_RETRY_BASE_MS × 2^(failures-1), max SYNC_RETRY_MAX retries
//
// Fallback: if OpenCloud is unavailable, artifacts remain in the existing
// Supabase/localStorage store (FallbackFS pattern from OpenCloud).
// ─────────────────────────────────────────────────────────────────────────────

import {
  OPENCLOUD_BASE_FOLDER,
  ARTIFACT_TYPE_TO_EXTENSION,
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_MAX,
  isOpenCloudConfigured,
  getTagsForArtifact,
  AUTO_DISTRIBUTE_ENABLED,
  AUTO_DISTRIBUTE_RECIPIENTS,
} from '../config/opencloudConfig';
import {
  uploadFile,
  ensureFolder,
  createSharingLink,
  sendShareInvitation,
  downloadFile,
  getDriveItems,
  getMyDrives,
  addTags,
  searchByTag,
} from './opencloudClientService';
import { saveJsonArtifact } from '../utils/artifactStore';
import { eventBus, EVENT_NAMES } from './eventBus';

// ── Helpers ───────────────────────────────────────────────────────────────

function artifactToFilename(artifactRef, index = 0) {
  const type = artifactRef.artifact_type || artifactRef.type || 'unknown';
  const label = artifactRef.label || type;
  const ext = ARTIFACT_TYPE_TO_EXTENSION[type] || '.json';
  const safeName = label.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_').slice(0, 60);
  return `${safeName}_${index}${ext}`;
}

function artifactToBlob(artifactRef) {
  const type = artifactRef.artifact_type || artifactRef.type || 'unknown';
  const payload = artifactRef.payload ?? artifactRef.data ?? artifactRef;
  const ext = ARTIFACT_TYPE_TO_EXTENSION[type] || '.json';

  if (ext === '.csv' && typeof payload === 'string') {
    return new Blob([payload], { type: 'text/csv' });
  }
  if (ext === '.html' && typeof payload === 'string') {
    return new Blob([payload], { type: 'text/html' });
  }
  if (ext === '.js' && typeof payload?.code === 'string') {
    return new Blob([payload.code], { type: 'text/javascript' });
  }

  // Default: JSON
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return new Blob([json], { type: 'application/json' });
}

function mimeForExt(ext) {
  const map = {
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.pdf': 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

// ── Retry wrapper (OpenCloud postprocessing pattern) ──────────────────────

async function withRetry(fn, label = 'sync') {
  let lastErr;
  for (let attempt = 1; attempt <= SYNC_RETRY_MAX; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < SYNC_RETRY_MAX) {
        const backoff = SYNC_RETRY_BASE_MS * Math.pow(2, attempt - 1);
        console.warn(`[opencloudArtifactSync] ${label} attempt ${attempt} failed, retrying in ${backoff}ms:`, err?.message);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

// ── Single artifact sync ─────────────────────────────────────────────────

/**
 * Upload a single artifact to OpenCloud.
 *
 * @param {object} artifactRef - DI artifact reference object
 * @param {string} driveId - Target OpenCloud drive ID
 * @param {string} folderPath - Target folder path (e.g. 'Decision-Intelligence/tasks/abc123/forecast')
 * @returns {Promise<object>} OpenCloud file reference: { driveId, itemId, filename, webUrl, sharingLink }
 */
export async function syncArtifactToOpenCloud(artifactRef, driveId, folderPath) {
  if (!isOpenCloudConfigured()) {
    console.warn('[opencloudArtifactSync] OpenCloud not configured, skipping sync');
    return null;
  }

  const filename = artifactToFilename(artifactRef);
  const blob = artifactToBlob(artifactRef);
  const type = artifactRef.artifact_type || artifactRef.type || 'unknown';
  const ext = ARTIFACT_TYPE_TO_EXTENSION[type] || '.json';

  const item = await withRetry(async () => {
    await ensureFolder(driveId, folderPath);
    return uploadFile(driveId, folderPath, filename, blob, mimeForExt(ext));
  }, `upload:${filename}`);

  const fileRef = {
    driveId,
    itemId: item?.id || null,
    filename,
    webUrl: item?.webUrl || null,
    sharingLink: null,
    artifact_type: type,
    tags: [],
    synced_at: new Date().toISOString(),
  };

  if (item?.id) {
    // Apply DI tags for classification (best-effort)
    try {
      const tags = getTagsForArtifact(type, artifactRef.taskId);
      await addTags(driveId, item.id, tags);
      fileRef.tags = tags;
    } catch { /* tagging is optional */ }

    // Create sharing link (best-effort)
    try {
      const link = await createSharingLink(driveId, item.id);
      fileRef.sharingLink = link?.link?.webUrl || null;
    } catch { /* sharing is optional */ }

    // Auto-distribute to configured recipients (best-effort)
    if (AUTO_DISTRIBUTE_ENABLED && AUTO_DISTRIBUTE_RECIPIENTS.length > 0) {
      for (const email of AUTO_DISTRIBUTE_RECIPIENTS) {
        try {
          await sendShareInvitation(driveId, item.id, email.trim(), 'viewer');
        } catch { /* distribution is best-effort */ }
      }
    }
  }

  return fileRef;
}

// ── Batch sync (all task outputs) ────────────────────────────────────────

/**
 * Upload all artifacts from a completed AI Employee task to OpenCloud.
 *
 * Folder structure: /{OPENCLOUD_BASE_FOLDER}/{employeeName}/tasks/{taskId}/{stepName}/
 *
 * @param {string} taskId
 * @param {string} driveId
 * @param {object} [opts]
 * @param {string} [opts.employeeName='Data Analyst']
 * @param {object} [opts.loopState] - Task loop_state with step artifacts
 * @param {object[]} [opts.artifactRefs] - Direct artifact refs (if no loop_state)
 * @returns {Promise<{ fileRefs: object[], artifact_ref: object|null }>}
 */
export async function syncTaskOutputsToOpenCloud(taskId, driveId, opts = {}) {
  if (!isOpenCloudConfigured()) {
    console.warn('[opencloudArtifactSync] OpenCloud not configured, skipping task sync');
    return { fileRefs: [], artifact_ref: null };
  }

  const employeeName = opts.employeeName || 'Data Analyst';
  const basePath = `${OPENCLOUD_BASE_FOLDER}/${employeeName}/tasks/${taskId}`;
  const fileRefs = [];

  // Collect artifacts from loop_state steps or from direct refs
  const artifactsToSync = [];

  if (opts.loopState?.steps) {
    for (const step of opts.loopState.steps) {
      if (!step.artifact_refs?.length) continue;
      for (let i = 0; i < step.artifact_refs.length; i++) {
        artifactsToSync.push({
          ref: step.artifact_refs[i],
          folderPath: `${basePath}/${step.name}`,
          index: i,
        });
      }
    }
  } else if (opts.artifactRefs?.length) {
    for (let i = 0; i < opts.artifactRefs.length; i++) {
      artifactsToSync.push({
        ref: opts.artifactRefs[i],
        folderPath: basePath,
        index: i,
      });
    }
  }

  // Upload each artifact (sequential to avoid overwhelming the server)
  for (const { ref, folderPath, index } of artifactsToSync) {
    try {
      const fileRef = await syncArtifactToOpenCloud(ref, driveId, folderPath);
      if (fileRef) fileRefs.push(fileRef);
    } catch (err) {
      console.warn(`[opencloudArtifactSync] Failed to sync artifact ${index}:`, err?.message);
      // Continue with remaining artifacts (best-effort)
    }
  }

  // Save an opencloud_file_ref artifact summarizing all uploads
  let artifact_ref = null;
  if (fileRefs.length > 0) {
    try {
      artifact_ref = saveJsonArtifact?.('opencloud_file_ref', {
        taskId,
        driveId,
        employeeName,
        files: fileRefs,
        synced_at: new Date().toISOString(),
        total_files: fileRefs.length,
      }, { label: `OpenCloud Publish: ${fileRefs.length} files` }) || null;
    } catch { /* best-effort */ }

    eventBus.emit(EVENT_NAMES.OPENCLOUD_SYNC_COMPLETED, { taskId, fileRefs });
  }

  return { fileRefs, artifact_ref };
}

// ── Import dataset from OpenCloud ────────────────────────────────────────

/**
 * Download a file from OpenCloud and create a dataset profile.
 *
 * Supports: .xlsx, .csv, .json
 * Delegates to the existing data import pipeline (createDatasetProfileFromSheets).
 *
 * @param {string} driveId
 * @param {string} itemId - File item ID
 * @param {string} userId
 * @param {object} [itemMeta] - Optional item metadata { name, size, mimeType }
 * @returns {Promise<object>} Result with parsed data and dataset profile info
 */
export async function importDatasetFromOpenCloud(driveId, itemId, userId, itemMeta = {}) {
  if (!isOpenCloudConfigured()) {
    throw new Error('[OpenCloud] Not configured for import');
  }

  const response = await withRetry(
    () => downloadFile(driveId, itemId),
    `download:${itemId}`
  );

  const filename = itemMeta.name || 'opencloud_import';
  const ext = filename.split('.').pop()?.toLowerCase();
  const blob = await response.blob();

  let parsedData;

  if (ext === 'csv') {
    const text = await blob.text();
    const lines = text.split('\n').filter(Boolean);
    const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    const rows = lines.slice(1).map((line) => {
      const values = line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
      const row = {};
      headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
      return row;
    });
    parsedData = { sheets: [{ name: filename.replace(`.${ext}`, ''), headers, rows }] };
  } else if (ext === 'json') {
    const text = await blob.text();
    const json = JSON.parse(text);
    const rows = Array.isArray(json) ? json : json.data || json.rows || [json];
    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    parsedData = { sheets: [{ name: filename.replace(`.${ext}`, ''), headers, rows }] };
  } else {
    // xlsx and other binary formats — return raw blob for DataImportPanel to handle
    parsedData = {
      raw: true,
      blob,
      filename,
      mimeType: itemMeta.mimeType || blob.type,
    };
  }

  eventBus.emit(EVENT_NAMES.OPENCLOUD_IMPORT_COMPLETED, {
    driveId,
    itemId,
    filename,
    sheets: parsedData.sheets?.length || 0,
  });

  return {
    source: 'opencloud',
    driveId,
    itemId,
    filename,
    ...parsedData,
  };
}

// ── Get default drive ────────────────────────────────────────────────────

/**
 * Get the user's personal drive (first drive of type 'personal').
 * Falls back to any available drive.
 * @returns {Promise<string|null>} Drive ID
 */
export async function getDefaultDriveId() {
  if (!isOpenCloudConfigured()) return null;
  try {
    const drives = await getMyDrives();
    const personal = drives.find((d) => d.driveType === 'personal');
    return personal?.id || drives[0]?.id || null;
  } catch {
    return null;
  }
}

// ── List files for file picker ──────────────────────────────────────────

/**
 * Browse files in a drive folder — used by OpenCloudFilePicker UI.
 * @param {string} driveId
 * @param {string|null} folderId
 * @param {{ filter?: string[] }} [opts] - File extension filter, e.g. ['.xlsx', '.csv']
 * @returns {Promise<object[]>} Filtered DriveItems
 */
export async function browseFiles(driveId, folderId = null, opts = {}) {
  const items = await getDriveItems(driveId, folderId);
  if (!opts.filter?.length) return items;

  return items.filter((item) => {
    if (item.folder) return true; // always show folders
    const name = item.name || '';
    return opts.filter.some((ext) => name.toLowerCase().endsWith(ext));
  });
}

// ── Report auto-distribution ──────────────────────────────────────────────

/**
 * Upload a report to OpenCloud and send share invitations to recipients.
 *
 * @param {object} reportResult - From reportGeneratorService.generateReport()
 * @param {string} driveId
 * @param {string} taskId
 * @param {{ recipients?: string[], employeeName?: string }} [opts]
 * @returns {Promise<object>} File reference with sharing info
 */
export async function distributeReport(reportResult, driveId, taskId, opts = {}) {
  if (!isOpenCloudConfigured()) return null;

  const folderPath = `${OPENCLOUD_BASE_FOLDER}/${opts.employeeName || 'Data Analyst'}/reports`;
  const filename = reportResult.filename || `report_${taskId}.${reportResult.format || 'html'}`;
  const blob = typeof reportResult.blob === 'string'
    ? new Blob([reportResult.blob], { type: 'text/html' })
    : reportResult.blob instanceof Blob
      ? reportResult.blob
      : new Blob([JSON.stringify(reportResult.blob, null, 2)], { type: 'application/json' });

  const item = await withRetry(async () => {
    await ensureFolder(driveId, folderPath);
    return uploadFile(driveId, folderPath, filename, blob);
  }, `distribute:${filename}`);

  const fileRef = {
    driveId,
    itemId: item?.id || null,
    filename,
    webUrl: item?.webUrl || null,
    sharingLink: null,
    artifact_type: `report_${reportResult.format || 'html'}`,
    distributed_to: [],
    synced_at: new Date().toISOString(),
  };

  if (item?.id) {
    // Tag as report
    try {
      const tags = getTagsForArtifact(`report_${reportResult.format || 'html'}`, taskId);
      tags.push('di:distributed');
      await addTags(driveId, item.id, tags);
    } catch { /* best-effort */ }

    // Create sharing link
    try {
      const link = await createSharingLink(driveId, item.id);
      fileRef.sharingLink = link?.link?.webUrl || null;
    } catch { /* best-effort */ }

    // Send invitations to all recipients
    const recipients = opts.recipients?.length ? opts.recipients : AUTO_DISTRIBUTE_RECIPIENTS;
    for (const email of recipients) {
      try {
        await sendShareInvitation(driveId, item.id, email.trim(), 'viewer');
        fileRef.distributed_to.push(email.trim());
      } catch (err) {
        console.warn(`[opencloudArtifactSync] Failed to share with ${email}:`, err?.message);
      }
    }
  }

  return fileRef;
}

// ── Tag-based search ─────────────────────────────────────────────────────

/**
 * Search for DI artifacts in OpenCloud by artifact type tag.
 *
 * @param {string} driveId
 * @param {string} artifactType - DI artifact type (e.g. 'forecast_series', 'plan_table')
 * @returns {Promise<object[]>} Matching DriveItems
 */
export async function findArtifactsByType(driveId, artifactType) {
  const tags = getTagsForArtifact(artifactType);
  // Search by the most specific tag
  const searchTag = tags[tags.length - 1] || 'di:artifact';
  return searchByTag(driveId, searchTag);
}

/**
 * Search for all DI artifacts for a specific task.
 *
 * @param {string} driveId
 * @param {string} taskId
 * @returns {Promise<object[]>}
 */
export async function findArtifactsByTask(driveId, taskId) {
  return searchByTag(driveId, `di:task:${taskId}`);
}

export default {
  syncArtifactToOpenCloud,
  syncTaskOutputsToOpenCloud,
  importDatasetFromOpenCloud,
  distributeReport,
  findArtifactsByType,
  findArtifactsByTask,
  getDefaultDriveId,
  browseFiles,
};
