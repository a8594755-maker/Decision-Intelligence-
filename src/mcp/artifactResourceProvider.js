// @product: mcp-server
//
// artifactResourceProvider.js
// Exposes DI artifacts as MCP resources so AI clients can browse and read them.

import { diRunsService } from '../services/planning/diRunsService';
import { loadArtifact } from '../utils/artifactStore';

// ── Resource listing ──────────────────────────────────────────────────────

/**
 * List artifact resources available for a given run ID.
 * Returns MCP resource descriptors for each artifact in the run.
 *
 * @param {string} runId
 * @returns {Promise<Array<{ uri: string, name: string, description: string, mimeType: string }>>}
 */
export async function listArtifactsForRun(runId) {
  const artifacts = await diRunsService.getArtifactsForRun(runId);
  return artifacts.map(a => ({
    uri: `di://artifacts/${runId}/${a.artifact_type}`,
    name: `${a.artifact_type} (run ${String(runId).slice(0, 8)})`,
    description: `Artifact type: ${a.artifact_type}`,
    mimeType: a.content_type || 'application/json',
  }));
}

/**
 * List the most recent artifacts across all runs.
 *
 * @param {number} [limit=20]
 * @returns {Promise<Array<{ uri: string, name: string, description: string, mimeType: string }>>}
 */
export async function listRecentArtifacts(limit = 20) {
  const runs = await diRunsService.listRuns({ limit: 10, order: 'desc' });
  const results = [];

  for (const run of runs) {
    const artifacts = await diRunsService.getArtifactsForRun(run.id);
    for (const a of artifacts) {
      results.push({
        uri: `di://artifacts/${run.id}/${a.artifact_type}`,
        name: `${a.artifact_type} (run ${String(run.id).slice(0, 8)})`,
        description: `Run: ${run.id}, Type: ${a.artifact_type}, Created: ${a.created_at || run.created_at || 'unknown'}`,
        mimeType: a.content_type || 'application/json',
      });
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }

  return results;
}

// ── Resource reading ──────────────────────────────────────────────────────

/**
 * Read an artifact resource by URI.
 * Supports:
 *   di://artifacts/{run_id}/{artifact_type}
 *   di://artifacts/recent
 *
 * @param {string} uri
 * @returns {Promise<Array<{ uri: string, mimeType: string, text: string }>>}
 */
export async function readArtifactResource(uri) {
  // di://artifacts/recent → list recent
  if (uri === 'di://artifacts/recent') {
    const recent = await listRecentArtifacts(20);
    return [{ uri, mimeType: 'application/json', text: JSON.stringify(recent, null, 2) }];
  }

  // di://artifacts/{run_id}/{artifact_type}
  const match = uri.match(/^di:\/\/artifacts\/([^/]+)\/(.+)$/);
  if (match) {
    const [, runId, artifactType] = match;
    const artifacts = await diRunsService.getArtifactsForRun(runId);
    const artifact = artifacts.find(a => a.artifact_type === artifactType);

    if (!artifact) {
      return [{ uri, mimeType: 'text/plain', text: `Artifact not found: type=${artifactType} in run=${runId}` }];
    }

    // Try to load full content
    const content = await loadArtifact(artifact);
    if (content) {
      const mimeType = artifact.content_type || 'application/json';
      const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      return [{ uri, mimeType, text }];
    }

    // Inline artifact_json fallback
    if (artifact.artifact_json) {
      return [{ uri, mimeType: 'application/json', text: JSON.stringify(artifact.artifact_json, null, 2) }];
    }

    return [{ uri, mimeType: 'text/plain', text: `Artifact exists but content could not be loaded: ${artifactType}` }];
  }

  // di://artifacts/{run_id} → list artifacts for run
  const runMatch = uri.match(/^di:\/\/artifacts\/([^/]+)$/);
  if (runMatch) {
    const runId = runMatch[1];
    const list = await listArtifactsForRun(runId);
    return [{ uri, mimeType: 'application/json', text: JSON.stringify(list, null, 2) }];
  }

  throw new Error(`Unknown artifact resource: ${uri}`);
}

/**
 * Check if a URI is an artifact resource URI.
 * @param {string} uri
 * @returns {boolean}
 */
export function isArtifactUri(uri) {
  return uri.startsWith('di://artifacts/');
}
