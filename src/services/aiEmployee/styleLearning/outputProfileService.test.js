import { describe, expect, it, vi } from 'vitest';

vi.mock('../../supabaseClient', () => ({ supabase: null }));

import { _testExports } from './outputProfileService.js';

const {
  resolveOutputProfileScope,
  normalizeIdentifier,
  mapStoredProfileToOutputProfile,
} = _testExports;

describe('outputProfileService', () => {
  it('normalizes identifiers into profile-safe slugs', () => {
    expect(normalizeIdentifier(' Leadership Review ')).toBe('leadership_review');
    expect(normalizeIdentifier('')).toBeNull();
  });

  it('derives doc type from deliverable metadata before workflow fallback', () => {
    const scope = resolveOutputProfileScope({
      inputContext: {
        deliverable_type: 'monthly_business_review',
        deliverable_format: 'spreadsheet',
        business_unit: 'North America Sales',
        deliverable_audience: 'VP Sales',
      },
      step: { name: 'excel_build' },
    });

    expect(scope).toEqual(expect.objectContaining({
      docType: 'monthly_business_review',
      teamId: 'north_america_sales',
      deliverableType: 'monthly_business_review',
      audience: 'VP Sales',
    }));
  });

  it('prefers explicit doc_type when provided', () => {
    const scope = resolveOutputProfileScope({
      inputContext: {
        doc_type: 'apple_mbr_excel',
        workflow_type: 'forecast',
        team_id: 'finance_ops',
      },
    });

    expect(scope.docType).toBe('apple_mbr_excel');
    expect(scope.teamId).toBe('finance_ops');
  });

  it('maps stored style profiles into active output profiles', () => {
    const outputProfile = mapStoredProfileToOutputProfile({
      id: 'profile-1',
      employee_id: 'emp-1',
      team_id: 'ops',
      doc_type: 'weekly_business_review',
      profile_name: 'wbr_v1',
      confidence: 0.87,
      sample_count: 12,
      canonical_structure: { sections: ['summary', 'risks'] },
      canonical_text_style: { tone: 'executive_summary' },
      high_variance_dims: ['chart_type'],
    }, {
      docType: 'weekly_business_review',
      teamId: 'ops',
      profileName: 'wbr_v1',
      deliverableType: 'weekly_business_review',
      audience: 'GM',
      format: 'doc',
      channel: 'Document',
    });

    expect(outputProfile).toEqual(expect.objectContaining({
      status: 'active',
      version: 1,
      source: 'style_profiles',
      docType: 'weekly_business_review',
      audience: 'GM',
      format: 'doc',
      confidence: 0.87,
      sampleCount: 12,
    }));
    expect(outputProfile.canonical.textStyle.tone).toBe('executive_summary');
  });
});
