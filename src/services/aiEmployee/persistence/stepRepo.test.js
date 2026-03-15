import { describe, expect, it } from 'vitest';

import { normalizeArtifactRefsForStorage } from './stepRepo.js';

describe('normalizeArtifactRefsForStorage', () => {
  it('returns an empty array for non-array artifact payloads from executors', () => {
    expect(normalizeArtifactRefsForStorage({
      forecast_series: {
        artifact_id: 123,
        artifact_type: 'forecast_series',
      },
      metrics: {
        artifact_id: 456,
        artifact_type: 'metrics',
      },
    })).toEqual([]);
  });

  it('keeps valid uuid-shaped artifact refs and drops other payload objects', () => {
    expect(normalizeArtifactRefsForStorage([
      { artifact_id: '123e4567-e89b-12d3-a456-426614174000', artifact_type: 'report_json' },
      { artifact_type: 'inline_preview', payload: { ok: true } },
      'not-a-uuid',
    ])).toEqual(['123e4567-e89b-12d3-a456-426614174000']);
  });
});
