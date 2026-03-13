// @product: ai-employee
//
// reportGeneratorService.js
// ─────────────────────────────────────────────────────────────────────────────
// Generates beautiful reports from task artifacts.
// Supports: HTML (self-contained), XLSX (via exportWorkbook extension),
//           Power BI dataset JSON.
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

// ── HTML Report ──────────────────────────────────────────────────────────────

function generateHtmlReport({ artifacts, taskMeta, narrative, revisionLog }) {
  const allRefs = flattenArtifacts(artifacts);
  const title = taskMeta?.title || 'AI Employee Report';

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
 * @returns {Promise<{ blob: string|object, filename: string, format: string, artifact_ref: object|null }>}
 */
export async function generateReport({ format = 'html', artifacts, taskMeta, narrative, revisionLog }) {
  const fmt = (format || 'html').toLowerCase();

  switch (fmt) {
    case 'html': {
      const html = generateHtmlReport({ artifacts, taskMeta, narrative, revisionLog });
      const filename = `report_${taskMeta?.id || Date.now()}.html`;

      let artifact_ref = null;
      try {
        artifact_ref = saveJsonArtifact?.('report_html', html, {
          label: `Report: ${taskMeta?.title || 'AI Report'}`,
        }) || null;
      } catch { /* artifact storage is best-effort */ }

      return { blob: html, filename, format: 'html', artifact_ref };
    }

    case 'xlsx': {
      // Collect tabular data from artifacts
      const allRefs = flattenArtifacts(artifacts);
      const data = {
        format: 'xlsx',
        task: taskMeta,
        artifacts: allRefs,
        revision_log: revisionLog || null,
        generated_at: now(),
      };

      let artifact_ref = null;
      try {
        artifact_ref = saveJsonArtifact?.('report_json', data, {
          label: `Excel Report Data: ${taskMeta?.title || 'AI Report'}`,
        }) || null;
      } catch { /* best-effort */ }

      return { blob: data, filename: `report_${taskMeta?.id || Date.now()}.xlsx`, format: 'xlsx', artifact_ref };
    }

    case 'powerbi': {
      const { toPowerBIDataset } = await import('./externalToolBridgeService');
      const pbiResult = toPowerBIDataset(artifacts);
      return { blob: pbiResult.dataset, filename: pbiResult.filename, format: 'powerbi', artifact_ref: pbiResult.artifact_ref };
    }

    default:
      throw new Error(`Unsupported report format: ${fmt}`);
  }
}

export default { generateReport };
