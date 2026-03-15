import { describe, expect, it } from 'vitest';

import {
  buildDeliverablePreview,
  resolveDeliverableProfile,
} from './deliverableProfile.js';

describe('deliverableProfile', () => {
  it('resolves a manager-facing forecast memo profile from workflow context', () => {
    const profile = resolveDeliverableProfile({
      workflow_type: 'forecast',
    });

    expect(profile).toEqual(expect.objectContaining({
      type: 'forecast_memo',
      format: 'doc',
      audience: 'Planning manager',
      label: 'Forecast Memo',
    }));
  });

  it('builds a document-style deliverable preview from report_json artifacts', () => {
    const preview = buildDeliverablePreview({
      title: 'Weekly Forecast Update',
      description: 'Fallback summary',
      input_context: { workflow_type: 'forecast' },
      ai_employee_runs: [{
        id: 'run-1',
        summary: 'Run completed',
        ended_at: '2026-03-15T00:00:00Z',
        artifact_refs: [{
          artifact_type: 'report_json',
          label: 'Forecast memo',
          data: {
            summary_text: 'Demand remains stable next week.',
            key_results: ['Service level projected above 97%.'],
            recommended_actions: ['Proceed with planned replenishment.'],
          },
        }],
      }],
    });

    expect(preview.previewKind).toBe('document');
    expect(preview.summary).toContain('Demand remains stable');
    expect(preview.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Key Findings' }),
      expect.objectContaining({ label: 'Recommended Actions' }),
    ]));
  });

  it('maps action_items into recommended actions for manager review', () => {
    const preview = buildDeliverablePreview({
      title: 'Weekly Risk Scan',
      input_context: { workflow_type: 'risk' },
      ai_employee_runs: [{
        id: 'run-2',
        summary: 'Risk memo ready',
        ended_at: '2026-03-15T00:00:00Z',
        artifact_refs: [{
          artifact_type: 'report_json',
          label: 'Risk memo',
          data: {
            executive_summary: 'Supplier lead time variance increased this week.',
            action_items: ['Escalate vendor ETA drift.', 'Reduce exposure on the affected SKU.'],
          },
        }],
      }],
    });

    expect(preview.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'Recommended Actions',
        items: expect.arrayContaining(['Escalate vendor ETA drift.', 'Reduce exposure on the affected SKU.']),
      }),
    ]));
  });
});
