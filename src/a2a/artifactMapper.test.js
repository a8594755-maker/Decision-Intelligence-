import { describe, it, expect } from 'vitest';
import { mapDiArtifactToA2A, buildArtifactEvent } from './artifactMapper.js';

describe('mapDiArtifactToA2A', () => {
  it('converts a JSON artifact to A2A format with data part', () => {
    const diArtifact = {
      id: 'abc-123',
      artifact_type: 'forecast_series',
      artifact_json: { periods: [1, 2, 3], p50: [100, 110, 120] },
      content_type: 'application/json',
    };

    const a2a = mapDiArtifactToA2A(diArtifact, 'run-1');
    expect(a2a.artifactId).toBe('di-abc-123');
    expect(a2a.name).toBe('forecast_series');
    expect(a2a.parts).toHaveLength(1);
    expect(a2a.parts[0].kind).toBe('data');
    expect(a2a.parts[0].data).toEqual(diArtifact.artifact_json);
    expect(a2a.metadata.di_run_id).toBe('run-1');
    expect(a2a.metadata.contract_version).toBe('v1');
  });

  it('converts a CSV artifact to A2A format with text part', () => {
    const diArtifact = {
      id: 'csv-456',
      artifact_type: 'plan_csv',
      artifact_json: 'col1,col2\n1,2\n3,4',
      content_type: 'text/csv;charset=utf-8',
    };

    const a2a = mapDiArtifactToA2A(diArtifact);
    expect(a2a.parts[0].kind).toBe('text');
    expect(a2a.parts[0].text).toBe('col1,col2\n1,2\n3,4');
  });

  it('handles artifact with no content (external storage)', () => {
    const diArtifact = {
      id: 'ext-789',
      artifact_type: 'large_report',
      artifact_json: null,
      content_type: 'application/json',
    };

    const a2a = mapDiArtifactToA2A(diArtifact);
    expect(a2a.parts[0].kind).toBe('text');
    expect(a2a.parts[0].text).toContain('stored externally');
  });

  it('uses artifact_type as fallback ID when id is missing', () => {
    const diArtifact = {
      artifact_type: 'solver_meta',
      artifact_json: { solver: 'heuristic' },
    };

    const a2a = mapDiArtifactToA2A(diArtifact);
    expect(a2a.artifactId).toBe('di-solver_meta');
  });
});

describe('buildArtifactEvent', () => {
  it('builds a valid TaskArtifactUpdateEvent', () => {
    const diArtifact = {
      id: 'art-1',
      artifact_type: 'plan_table',
      artifact_json: { rows: [] },
    };

    const event = buildArtifactEvent('task-1', 'ctx-1', diArtifact, 'run-1');
    expect(event.kind).toBe('artifact-update');
    expect(event.taskId).toBe('task-1');
    expect(event.contextId).toBe('ctx-1');
    expect(event.append).toBe(false);
    expect(event.lastChunk).toBe(true);
    expect(event.artifact.name).toBe('plan_table');
  });

  it('can set lastChunk=false for streaming', () => {
    const event = buildArtifactEvent('task-1', 'ctx-1', { artifact_type: 'x', artifact_json: {} }, 'r', false);
    expect(event.lastChunk).toBe(false);
  });
});
