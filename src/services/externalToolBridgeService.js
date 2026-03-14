// @product: ai-employee
//
// externalToolBridgeService.js
// ─────────────────────────────────────────────────────────────────────────────
// Bridges DI artifacts to external tool formats:
//   - Power BI: DAX-friendly JSON dataset
//   - Excel: XLSX with refresh metadata (delegates to exportWorkbook)
// ─────────────────────────────────────────────────────────────────────────────

import { saveJsonArtifact } from '../utils/artifactStore';

// ── Helpers ──────────────────────────────────────────────────────────────────

function flattenArtifacts(artifacts) {
  if (!artifacts || typeof artifacts !== 'object') return [];
  return Object.values(artifacts).flat().filter(Boolean);
}

function now() {
  return new Date().toISOString();
}

// ── Power BI Dataset ────────────────────────────────────────────────────────

/**
 * Convert DI artifacts into a Power BI-importable JSON dataset.
 * Structure follows the tabular model pattern:
 *   { tables: [{ name, columns: [{name, dataType}], rows: [...] }] }
 *
 * @param {object} artifacts - Prior step artifacts { step_name: artifact_refs[] }
 * @returns {{ dataset: object, filename: string, artifact_ref: object|null }}
 */
export function toPowerBIDataset(artifacts) {
  const allRefs = flattenArtifacts(artifacts);
  const tables = [];

  // Group artifacts by type into tables
  const byType = {};
  for (const ref of allRefs) {
    const type = ref.artifact_type || ref.type || 'unknown';
    if (!byType[type]) byType[type] = [];
    byType[type].push(ref);
  }

  for (const [typeName, refs] of Object.entries(byType)) {
    // Extract rows from payload if available
    const rows = [];
    const columnSet = new Set();

    for (const ref of refs) {
      const payload = ref.payload || ref;
      if (payload.rows && Array.isArray(payload.rows)) {
        for (const row of payload.rows) {
          if (row && typeof row === 'object') {
            Object.keys(row).forEach(k => columnSet.add(k));
            rows.push(row);
          }
        }
      } else if (typeof payload === 'object' && !Array.isArray(payload)) {
        Object.keys(payload).forEach(k => columnSet.add(k));
        rows.push(payload);
      }
    }

    if (rows.length === 0) continue;

    const columns = Array.from(columnSet).map(name => ({
      name,
      dataType: inferDataType(rows[0]?.[name]),
    }));

    tables.push({
      name: typeName,
      columns,
      rows: rows.slice(0, 10000), // Cap for Power BI import
    });
  }

  const dataset = {
    version: '1.0',
    generated_at: now(),
    model: 'di_export',
    tables,
  };

  const filename = `powerbi_dataset_${Date.now()}.json`;

  let artifact_ref = null;
  try {
    artifact_ref = saveJsonArtifact?.('powerbi_dataset', dataset, {
      label: 'Power BI Dataset Export',
    }) || null;
  } catch { /* best-effort */ }

  return { dataset, filename, artifact_ref };
}

// ── Excel with refresh metadata ─────────────────────────────────────────────

/**
 * Convert artifacts to XLSX-ready structure with refresh metadata.
 * Actual .xlsx generation is deferred to exportWorkbook.js on the UI side.
 *
 * @param {object} artifacts - Prior step artifacts
 * @param {object} [cfg] - Configuration { includeRevisionLog: boolean }
 * @returns {{ sheets: object[], metadata: object, artifact_ref: object|null }}
 */
export function toExcelWithRefresh(artifacts, cfg = {}) {
  const allRefs = flattenArtifacts(artifacts);
  const sheets = [];

  // Main data sheets — one per artifact type
  const byType = {};
  for (const ref of allRefs) {
    const type = ref.artifact_type || ref.type || 'unknown';
    if (!byType[type]) byType[type] = [];
    byType[type].push(ref);
  }

  for (const [typeName, refs] of Object.entries(byType)) {
    const rows = [];
    for (const ref of refs) {
      const payload = ref.payload || ref;
      if (payload.rows && Array.isArray(payload.rows)) {
        rows.push(...payload.rows);
      } else if (typeof payload === 'object' && !Array.isArray(payload)) {
        rows.push(payload);
      }
    }
    if (rows.length > 0) {
      sheets.push({ name: typeName.slice(0, 31), rows }); // Excel sheet name max 31 chars
    }
  }

  const metadata = {
    generated_at: now(),
    source: 'di_ai_employee',
    refresh_hint: 'Re-run the task to refresh data',
    total_sheets: sheets.length,
    total_rows: sheets.reduce((sum, s) => sum + s.rows.length, 0),
  };

  let artifact_ref = null;
  try {
    artifact_ref = saveJsonArtifact?.('report_json', { sheets, metadata }, {
      label: 'Excel Export Data',
    }) || null;
  } catch { /* best-effort */ }

  return { sheets, metadata, artifact_ref };
}

// ── Utilities ────────────────────────────────────────────────────────────────

function inferDataType(value) {
  if (value === null || value === undefined) return 'string';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int64' : 'double';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'dateTime';
    return 'string';
  }
  return 'string';
}

// ── OpenCloud Upload ──────────────────────────────────────────────────────

/**
 * Upload DI artifacts to an OpenCloud drive.
 * Delegates to opencloudArtifactSync for the actual upload.
 *
 * @param {object} artifacts - Prior step artifacts { step_name: artifact_refs[] }
 * @param {string} driveId - OpenCloud drive ID
 * @param {string} [folderPath] - Target folder path
 * @returns {Promise<{ fileRefs: object[], artifact_ref: object|null }>}
 */
export async function toOpenCloudUpload(artifacts, driveId, folderPath) {
  const { syncTaskOutputsToOpenCloud } = await import('./opencloudArtifactSync');
  const allRefs = flattenArtifacts(artifacts);
  return syncTaskOutputsToOpenCloud(
    `export_${Date.now()}`,
    driveId,
    { artifactRefs: allRefs, employeeName: folderPath || 'exports' }
  );
}

export default { toPowerBIDataset, toExcelWithRefresh, toOpenCloudUpload };
