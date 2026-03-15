import { beforeEach, describe, expect, it, vi } from 'vitest';

const getActiveCompanyOutputProfile = vi.fn();
const listCompanyOutputProfiles = vi.fn();
const mapCompanyProfileRowToOutputProfile = vi.fn((profile, scope) => ({
  id: profile.id,
  docType: scope.docType,
  teamId: scope.teamId,
  profileName: profile.profile_name,
  status: profile.status,
  version: profile.version,
  source: 'company_output_profiles',
  confidence: profile.confidence,
  sampleCount: profile.sample_count,
  highVarianceDims: profile.high_variance_dims || [],
  deliverableType: scope.deliverableType,
  audience: scope.audience,
  format: scope.format,
  channel: scope.channel,
  canonical: {
    structure: profile.canonical_structure || {},
    formatting: profile.canonical_formatting || {},
    charts: profile.canonical_charts || {},
    kpiLayout: profile.canonical_kpi_layout || {},
    textStyle: profile.canonical_text_style || {},
  },
}));

const getProfile = vi.fn();
const listProfiles = vi.fn();

vi.mock('./companyOutputProfileService.js', () => ({
  getActiveCompanyOutputProfile,
  listCompanyOutputProfiles,
  mapCompanyProfileRowToOutputProfile,
}));

vi.mock('./styleProfileService.js', () => ({
  getProfile,
  listProfiles,
}));

vi.mock('./exemplarService.js', () => ({
  getBestExemplars: vi.fn(async () => []),
}));

vi.mock('./policyIngestionService.js', () => ({
  getPoliciesForDocType: vi.fn(async () => []),
}));

vi.mock('./styleRetrievalComposer.js', () => ({
  composeStyleContext: vi.fn(async () => ({ styleContext: '', metadata: {} })),
  composeMinimalStyleContext: vi.fn(async () => ({ styleContext: '', metadata: {} })),
}));

describe('outputProfileService runtime preference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('prefers company_output_profiles over legacy style_profiles when both exist', async () => {
    getActiveCompanyOutputProfile.mockResolvedValue({
      id: 'company-1',
      profile_name: 'apple_mbr_v3',
      status: 'active',
      version: 3,
      confidence: 0.92,
      sample_count: 11,
      canonical_text_style: { tone: 'executive' },
    });
    getProfile.mockResolvedValue({
      id: 'legacy-1',
      profile_name: 'legacy_profile',
      confidence: 0.55,
      sample_count: 4,
    });

    const { getActiveOutputProfile } = await import('./outputProfileService.js');
    const profile = await getActiveOutputProfile({
      employeeId: 'emp-1',
      inputContext: {
        deliverable_type: 'monthly_business_review',
        team_id: 'sales_ops',
      },
      step: { name: 'synthesize' },
    });

    expect(getActiveCompanyOutputProfile).toHaveBeenCalledWith({
      employeeId: 'emp-1',
      docType: 'monthly_business_review',
      teamId: 'sales_ops',
    });
    expect(getProfile).not.toHaveBeenCalled();
    expect(profile.source).toBe('company_output_profiles');
    expect(profile.version).toBe(3);
    expect(profile.canonical.textStyle.tone).toBe('executive');
  });
});
