import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockApprovePlan = vi.fn();
const mockApproveReview = vi.fn();
const mockRetryTask = vi.fn();
const mockMaybeCreateOutputProfileProposalFromReview = vi.fn();

vi.mock('./orchestrator.js', () => ({
  approvePlan: (...args) => mockApprovePlan(...args),
  approveReview: (...args) => mockApproveReview(...args),
  retryTask: (...args) => mockRetryTask(...args),
}));

vi.mock('../aiEmployeeLLMService.js', () => ({
  callLLM: vi.fn(async () => ({ text: '[]' })),
}));

vi.mock('./deliverableProfile.js', () => ({
  buildDeliverablePreview: vi.fn(() => ({
    headline: 'Manager Brief',
    summary: 'Deliverable summary',
    sections: [{ label: 'Key Findings', items: ['A'] }],
    previewKind: 'document',
  })),
}));

vi.mock('./styleLearning/reviewProposalService.js', () => ({
  maybeCreateOutputProfileProposalFromReview: (...args) => mockMaybeCreateOutputProfileProposalFromReview(...args),
}));

import { resolveReviewDecision, runTask } from './taskActionService.js';
import { TASK_STATES } from './taskStateMachine.js';

describe('taskActionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeCreateOutputProfileProposalFromReview.mockResolvedValue(null);
  });

  describe('runTask', () => {
    it('approves orchestrator tasks that are waiting_approval', async () => {
      const result = await runTask({
        id: 'task-1',
        status: 'waiting_approval',
        plan_snapshot: { steps: [{ name: 'forecast' }] },
      }, 'user-1');

      expect(mockApprovePlan).toHaveBeenCalledWith('task-1', 'user-1');
      expect(result).toEqual({ nextStatus: 'queued' });
    });

    it('retries failed orchestrator tasks', async () => {
      const result = await runTask({
        id: 'task-2',
        status: TASK_STATES.FAILED,
        plan_snapshot: { steps: [{ name: 'plan' }] },
      }, 'user-1');

      expect(mockRetryTask).toHaveBeenCalledWith('task-2', 'user-1');
      expect(result).toEqual({ nextStatus: 'queued' });
    });

    it('rejects tasks with unsupported status', async () => {
      await expect(runTask({
        id: 'task-x',
        status: 'done',
      }, 'user-1')).rejects.toThrow('cannot be run from the task board');
    });
  });

  describe('resolveReviewDecision', () => {
    it('resumes orchestrator review_hold tasks on approval', async () => {
      const result = await resolveReviewDecision({
        id: 'task-3',
        status: 'review_hold',
        employee_id: 'emp-3',
      }, {
        userId: 'user-1',
        decision: 'approved',
        comment: 'Looks good.',
      });

      expect(mockApproveReview).toHaveBeenCalledWith('task-3', 'user-1', expect.objectContaining({
        feedback: 'Looks good.',
        llmFn: expect.any(Function),
        revision: expect.objectContaining({
          original: expect.objectContaining({
            summary: 'Deliverable summary',
          }),
        }),
      }));
      expect(mockMaybeCreateOutputProfileProposalFromReview).toHaveBeenCalledWith(expect.objectContaining({
        task: expect.objectContaining({ id: 'task-3' }),
        decision: 'approved',
        comment: 'Looks good.',
        actorUserId: 'user-1',
      }));
      expect(result.nextStatus).toBe('in_progress');
    });

    it('returns proposal metadata when review feedback creates one', async () => {
      mockMaybeCreateOutputProfileProposalFromReview.mockResolvedValue({
        id: 'proposal-1',
        status: 'pending_approval',
      });

      const result = await resolveReviewDecision({
        id: 'task-33',
        status: 'review_hold',
        employee_id: 'emp-33',
      }, {
        userId: 'user-1',
        decision: 'approved',
        comment: 'Use the same leadership summary structure every month.',
      });

      expect(result.outputProfileProposal).toEqual({
        id: 'proposal-1',
        status: 'pending_approval',
      });
      expect(result.message).toContain('House-style proposal queued for approval');
    });

    it('marks orchestrator review_hold tasks failed on revision request', async () => {
      const result = await resolveReviewDecision({
        id: 'task-4',
        status: 'review_hold',
        employee_id: 'emp-1',
      }, {
        userId: 'user-1',
        decision: 'needs_revision',
      });

      expect(mockApproveReview).toHaveBeenCalledWith('task-4', 'user-1', expect.objectContaining({
        decision: 'needs_revision',
      }));
      expect(result).toEqual(expect.objectContaining({
        previousStatus: 'review_hold',
        nextStatus: 'failed',
      }));
    });

    it('rejects tasks that are not in review_hold status', async () => {
      await expect(resolveReviewDecision({
        id: 'task-x',
        status: 'in_progress',
      }, {
        userId: 'user-1',
        decision: 'approved',
      })).rejects.toThrow('not reviewable');
    });
  });
});
