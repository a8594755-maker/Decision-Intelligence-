// @product: ai-employee
//
// reportGeneratorService.js
// ─────────────────────────────────────────────────────────────────────────────
// Generates beautiful reports from task artifacts.
// Supports: HTML (self-contained), XLSX (via exportWorkbook extension),
//           Power BI dataset JSON.
// ─────────────────────────────────────────────────────────────────────────────

import { saveJsonArtifact } from '../utils/artifactStore';
import { toPowerBIDataset } from './externalToolBridgeService';

// ── Constants ────────────────────────────────────────────────────────────────

const SUPABASE_URL = String(import.meta?.env?.VITE_SUPABASE_URL || '').replace(/\/+$/, '');

// ── Helpers ──────────────────────────────────────────────────────────────────

function flattenArtifacts(artifacts) {
  if (!artifacts || typeof artifacts !== 'object') return [];
  return Object.values(artifacts).flat().filter(Boolean);
}

function now() {
  return new Date().toISOString();
}

function _getAccessToken() {
  try {
    if (!SUPABASE_URL || typeof localStorage === 'undefined') return null;
    const match = SUPABASE_URL.match(/\/\/([^.]+)\./);
    if (!match) return null;
    const raw = localStorage.getItem(`sb-${match[1]}-auth-token`);
    if (!raw) return null;
    return JSON.parse(raw)?.access_token || null;
  } catch { return null; }
}

// ── Report-API client ────────────────────────────────────────────────────────

/**
 * Fetch structured report data from the report-api Edge Function.
 * Used by Excel Add-in, Power BI, and the xlsx/powerbi report paths.
 *
 * @param {string} action - API action (list_reports, get_report, get_monthly, get_kpis, etc.)
 * @param {object} [params] - Action-specific parameters
 * @returns {Promise<object|null>} Parsed JSON response, or null if unavailable
 */
export async function fetchReportData(action, params = {}) {
  const token = _getAccessToken();
  if (!token || !SUPABASE_URL) return null;

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/report-api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...params }),
    });

    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn('[reportGeneratorService] fetchReportData failed:', err?.message);
    return null;
  }
}

/**
 * Fetch a full report with all artifacts, steps, and reviews from report-api.
 * @param {string} taskId
 * @returns {Promise<object|null>}
 */
export async function fetchFullReport(taskId) {
  return fetchReportData('get_report', { task_id: taskId });
}

/**
 * Fetch monthly aggregate report from report-api.
 * @param {number} year
 * @param {number} month
 * @returns {Promise<object|null>}
 */
export async function fetchMonthlyReport(year, month) {
  return fetchReportData('get_monthly', { year, month });
}

// ── HTML Report ──────────────────────────────────────────────────────────────

function generateHtmlReport({ artifacts, taskMeta, narrative, revisionLog }) {
  const allRefs = flattenArtifacts(artifacts);
  const title = taskMeta?.title || 'Digital Worker Report';

  const revisionSection = revisionLog
    ? `<section class="revision-log">
        <h2>Revision History</h2>
        <p>Total rounds: ${revisionLog.total_rounds || 0}</p>
        <p>Final score: ${revisionLog.final_score || 'N/A'}</p>
        <ul>${(revisionLog.rounds || []).map((r, i) =>
          `<li>Round ${i + 1}: score ${r.score ?? 'N/A'} — ${r.feedback || 'no feedback'}</li>`
        ).join('')}</ul>
      </section>`
    : '';

  const narrativeSection = narrative
    ? `<section class="narrative"><h2>Summary</h2><p>${String(narrative)}</p></section>`
    : '';

  const artifactSection = allRefs.length > 0
    ? `<section class="artifacts">
        <h2>Artifacts (${allRefs.length})</h2>
        <ul>${allRefs.map(ref => `<li>${ref.artifact_type || ref.type || 'unknown'}: ${ref.id || ref.key || 'N/A'}</li>`).join('')}</ul>
      </section>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #1a1a2e; }
    h1 { color: #16213e; border-bottom: 2px solid #0f3460; padding-bottom: 0.5rem; }
    h2 { color: #0f3460; margin-top: 2rem; }
    .meta { color: #666; font-size: 0.9rem; }
    .revision-log { background: #f8f9fa; border-left: 4px solid #e94560; padding: 1rem; margin: 1rem 0; border-radius: 4px; }
    .narrative { background: #f0f4ff; padding: 1rem; border-radius: 4px; margin: 1rem 0; }
    .artifacts ul { list-style: none; padding: 0; }
    .artifacts li { padding: 0.3rem 0; border-bottom: 1px solid #eee; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p class="meta">Generated: ${now()} | Task ID: ${taskMeta?.id || 'N/A'}</p>
  ${narrativeSection}
  ${artifactSection}
  ${revisionSection}
</body>
</html>`;

  return html;
}

// ── Main Export ──────────────────────────────────────────────────────────────

/**
 * Generate a report from task artifacts.
 *
 * @param {object} opts
 * @param {'html'|'xlsx'|'powerbi'} opts.format - Output format
 * @param {object} opts.artifacts - Prior step artifacts { step_name: artifact_refs[] }
 * @param {object} [opts.taskMeta] - { id, title }
 * @param {string} [opts.narrative] - Optional narrative text
 * @param {object} [opts.revisionLog] - Optional revision log
 * @param {string|number} [opts.runId] - Optional run ID for artifact storage
 * @returns {Promise<{ blob: string|object, filename: string, format: string, artifact_ref: object|null }>}
 */
export async function generateReport({ format = 'html', artifacts, taskMeta, narrative, revisionLog, runId }) {
  const fmt = (format || 'html').toLowerCase();
  // Use provided runId, fall back to task id, or generate synthetic one
  const effectiveRunId = runId || taskMeta?.id || `report-${Date.now()}`;

  switch (fmt) {
    case 'html': {
      const html = generateHtmlReport({ artifacts, taskMeta, narrative, revisionLog });
      const filename = `report_${taskMeta?.id || Date.now()}.html`;

      let artifact_ref = null;
      try {
        artifact_ref = await saveJsonArtifact(effectiveRunId, 'report_html', html, 500_000, {
          filename: `report_html_${effectiveRunId}.html`,
        });
      } catch { /* artifact storage is best-effort */ }

      return { blob: html, filename, format: 'html', artifact_ref };
    }

    case 'xlsx': {
      // Try to enrich with report-api data if task ID is available
      let enrichedData = null;
      if (taskMeta?.id) {
        enrichedData = await fetchFullReport(taskMeta.id);
      }

      const allRefs = flattenArtifacts(artifacts);
      const data = {
        format: 'xlsx',
        task: enrichedData?.task || taskMeta,
        artifacts: allRefs,
        steps: enrichedData?.steps || [],
        reviews: enrichedData?.reviews || [],
        categorized_artifacts: enrichedData?.artifacts || {},
        revision_log: revisionLog || null,
        generated_at: now(),
      };

      let artifact_ref = null;
      try {
        artifact_ref = await saveJsonArtifact(effectiveRunId, 'report_json', data, 500_000, {
          filename: `report_json_${effectiveRunId}.json`,
        });
      } catch { /* best-effort */ }

      return { blob: data, filename: `report_${taskMeta?.id || Date.now()}.xlsx`, format: 'xlsx', artifact_ref };
    }

    case 'powerbi': {
      const pbiResult = toPowerBIDataset(artifacts);
      return { blob: pbiResult.dataset, filename: pbiResult.filename, format: 'powerbi', artifact_ref: pbiResult.artifact_ref };
    }

    default:
      throw new Error(`Unsupported report format: ${fmt}`);
  }
}

export default { generateReport, fetchReportData, fetchFullReport, fetchMonthlyReport };
