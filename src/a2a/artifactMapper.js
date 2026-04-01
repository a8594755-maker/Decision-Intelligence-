// @product: a2a-server
//
// artifactMapper.js
// Converts DI artifacts to A2A artifact format (Parts).

/**
 * Convert a DI artifact (from diRunsService / artifactStore) to A2A artifact format.
 *
 * @param {object} diArtifact - DI artifact object with artifact_type, artifact_json, content_type, etc.
 * @param {string} [runId] - The run ID for metadata
 * @returns {object} A2A artifact
 */
export function mapDiArtifactToA2A(diArtifact, runId) {
  const artifactId = `di-${diArtifact.id || diArtifact.artifact_type}`;
  const isCsv = (diArtifact.content_type || '').includes('csv');

  const parts = [];

  if (isCsv && typeof diArtifact.artifact_json === 'string') {
    parts.push({ kind: 'text', text: diArtifact.artifact_json });
  } else if (diArtifact.artifact_json) {
    parts.push({
      kind: 'data',
      data: diArtifact.artifact_json,
    });
  } else {
    parts.push({
      kind: 'text',
      text: `[Artifact ${diArtifact.artifact_type}: content stored externally]`,
    });
  }

  return {
    artifactId,
    name: diArtifact.artifact_type,
    description: `DI artifact: ${diArtifact.artifact_type}`,
    parts,
    metadata: {
      di_artifact_type: diArtifact.artifact_type,
      di_run_id: runId || diArtifact.run_id,
      di_content_type: diArtifact.content_type || 'application/json',
      contract_version: 'v1',
    },
  };
}

/**
 * Build an A2A TaskArtifactUpdateEvent from a DI artifact.
 *
 * @param {string} taskId - A2A task ID
 * @param {string} contextId - A2A context ID
 * @param {object} diArtifact - DI artifact
 * @param {string} [runId] - DI run ID
 * @param {boolean} [lastChunk=true]
 * @returns {object} TaskArtifactUpdateEvent
 */
export function buildArtifactEvent(taskId, contextId, diArtifact, runId, lastChunk = true) {
  return {
    kind: 'artifact-update',
    taskId,
    contextId,
    artifact: mapDiArtifactToA2A(diArtifact, runId),
    append: false,
    lastChunk,
  };
}
