import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCallLLMJson = vi.fn();
const mockGetActiveOutputProfile = vi.fn();
const mockCreateOutputProfileProposal = vi.fn();

vi.mock('../../aiEmployeeLLMService.js', () => ({
  callLLMJson: (...args) => mockCallLLMJson(...args),
}));

vi.mock('./outputProfileService.js', () => ({
  getActiveOutputProfile: (...args) => mockGetActiveOutputProfile(...args),
  resolveOutputProfileScope: ({ inputContext = {}, step = {} } = {}) => ({
    docType: inputContext.doc_type
      || inputContext.deliverable_type
      || (step?.name === 'full_report' ? 'weekly_business_review' : step?.name)
      || 'general_report',
    teamId: inputContext.team_id || inputContext.business_unit || null,
    deliverableType: inputContext.deliverable_type || null,
    workflowType: inputContext.workflow_type || step?.name || null,
    format: inputContext.deliverable_format || null,
    audience: inputContext.deliverable_audience || null,
    channel: inputContext.deliverable_channel || null,
    profileName: inputContext.output_profile_name || 'default_profile',
  }),
}));

vi.mock('./companyOutputProfileService.js', () => ({
  createOutputProfileProposal: (...args) => mockCreateOutputProfileProposal(...args),
}));

import {
  maybeCreateOutputProfileProposalFromReview,
  _testExports,
} from './reviewProposalService.js';

const { likelyStyleFeedback } = _testExports;

describe('reviewProposalService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveOutputProfile.mockResolvedValue({
      id: 'profile-1',
      source: 'company_output_profiles',
      docType: 'monthly_business_review',
      profileName: 'apple_mbr_v1',
      audience: 'Leadership review',
      format: 'spreadsheet',
      channel: 'Spreadsheet pack',
      deliverableType: 'monthly_business_review',
      canonical: {
        structure: { sheets: ['Dashboard'] },
      },
    });
    mockCreateOutputProfileProposal.mockImplementation(async (payload) => ({
      id: 'proposal-1',
      status: 'pending_approval',
      ...payload,
    }));
  });

  it('detects likely reusable style feedback heuristically', () => {
    expect(likelyStyleFeedback('Please always keep KPI cards above the issue log.')).toBe(true);
    expect(likelyStyleFeedback('looks good')).toBe(false);
  });

  it('creates a proposal from LLM review analysis', async () => {
    mockCallLLMJson.mockResolvedValue({
      data: {
        should_create_proposal: true,
        proposal_name: 'apple_mbr_v2',
        rationale: 'Leadership wants a stable top-summary section before detail tabs.',
        proposed_changes: {
          rules: ['Always keep KPI cards and three observations on the first sheet.'],
        },
        comparison_summary: {
          baseline_gap: 'The current workbook buries key observations.',
          expected_benefit: 'Faster executive scan.',
          confidence: 0.84,
        },
        candidate_profile_patch: {
          canonical: {
            structure: { first_sheet: 'Dashboard' },
            textStyle: { tone: 'executive_brief' },
          },
        },
      },
    });

    const proposal = await maybeCreateOutputProfileProposalFromReview({
      task: {
        id: 'task-1',
        employee_id: 'emp-1',
        title: 'Apple MBR',
        description: 'Prepare workbook for monthly business review.',
        input_context: {
          workflow_type: 'mbr_with_excel',
          deliverable_type: 'monthly_business_review',
          team_id: 'sales_ops',
          deliverable_audience: 'VP Sales',
        },
        ai_employee_runs: [{
          id: 'run-1',
          summary: 'Workbook ready',
          artifact_refs: [{
            artifact_type: 'excel_workbook',
            label: 'apple_mbr.xlsx',
            data: { filename: 'apple_mbr.xlsx', sheets: ['Dashboard', 'KPI_Summary'] },
          }],
        }],
      },
      review: { id: 'review-1' },
      run: { id: 'run-1' },
      decision: 'approved',
      comment: 'Please always keep KPI cards and top 3 observations on the first sheet.',
      actorUserId: 'user-1',
    });

    expect(mockCallLLMJson).toHaveBeenCalled();
    expect(mockCreateOutputProfileProposal).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: 'emp-1',
      teamId: 'sales_ops',
      docType: 'monthly_business_review',
      baseProfileId: 'profile-1',
      sourceTaskId: 'task-1',
      sourceReviewId: 'review-1',
      sourceRunId: 'run-1',
      actorUserId: 'user-1',
    }));
    expect(proposal.id).toBe('proposal-1');
  });

  it('falls back to a heuristic proposal when LLM does not return one', async () => {
    mockCallLLMJson.mockResolvedValue({
      data: {
        should_create_proposal: false,
        reason: 'Need more evidence.',
      },
    });

    const proposal = await maybeCreateOutputProfileProposalFromReview({
      task: {
        id: 'task-2',
        employee_id: 'emp-2',
        title: 'Weekly Review',
        input_context: {
          workflow_type: 'full_report',
          business_unit: 'North America Sales',
        },
        ai_employee_runs: [],
      },
      decision: 'needs_revision',
      comment: 'Use the same leadership summary wording and section order every week.',
      actorUserId: 'user-2',
    });

    expect(mockCreateOutputProfileProposal).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: 'emp-2',
      docType: 'weekly_business_review',
      actorUserId: 'user-2',
    }));
    expect(proposal.status).toBe('pending_approval');
  });

  it('returns null for non-reusable comments', async () => {
    mockCallLLMJson.mockResolvedValue({
      data: {
        should_create_proposal: false,
        reason: 'One-off comment',
      },
    });

    const proposal = await maybeCreateOutputProfileProposalFromReview({
      task: {
        id: 'task-3',
        employee_id: 'emp-3',
        title: 'Ad hoc brief',
        input_context: {},
        ai_employee_runs: [],
      },
      decision: 'approved',
      comment: 'Looks good',
      actorUserId: 'user-3',
    });

    expect(proposal).toBeNull();
    expect(mockCreateOutputProfileProposal).not.toHaveBeenCalled();
  });
});
