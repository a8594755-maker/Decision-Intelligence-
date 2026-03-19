import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./planGovernanceService', () => ({
  requestPlanApproval: vi.fn(),
  approvePlanApproval: vi.fn(),
  rejectPlanApproval: vi.fn(),
}));

import {
  batchApprove,
  batchReject,
  requestApprovalWithDeadline,
} from './approvalWorkflowService.js';
import {
  approvePlanApproval,
  rejectPlanApproval,
  requestPlanApproval,
} from './planGovernanceService';

describe('approvalWorkflowService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requestApprovalWithDeadline passes camelCase params to governance service and reads nested approval record', async () => {
    requestPlanApproval.mockResolvedValue({
      approval: {
        approval_id: 'ap-123',
        status: 'PENDING',
      },
    });

    const result = await requestApprovalWithDeadline({
      runId: 42,
      userId: 'user-1',
      conversationId: 'conv-1',
      narrative: 'Need approval',
    });

    expect(requestPlanApproval).toHaveBeenCalledWith({
      runId: 42,
      userId: 'user-1',
    });
    expect(result.approval_id).toBe('ap-123');
    expect(result.status).toBe('PENDING');
  });

  it('batchApprove passes camelCase params to governance service', async () => {
    approvePlanApproval.mockResolvedValue({ approval: { approval_id: 'ap-1', status: 'APPROVED' } });

    const results = await batchApprove({
      approvalIds: ['ap-1'],
      userId: 'user-1',
      note: 'looks good',
    });

    expect(approvePlanApproval).toHaveBeenCalledWith({
      approvalId: 'ap-1',
      userId: 'user-1',
      note: 'looks good',
    });
    expect(results).toEqual([
      expect.objectContaining({ approval_id: 'ap-1', status: 'APPROVED' }),
    ]);
  });

  it('batchReject passes camelCase params to governance service', async () => {
    rejectPlanApproval.mockResolvedValue({ approval: { approval_id: 'ap-2', status: 'REJECTED' } });

    const results = await batchReject({
      approvalIds: ['ap-2'],
      userId: 'user-1',
      note: 'rejecting',
    });

    expect(rejectPlanApproval).toHaveBeenCalledWith({
      approvalId: 'ap-2',
      userId: 'user-1',
      note: 'rejecting',
    });
    expect(results).toEqual([
      expect.objectContaining({ approval_id: 'ap-2', status: 'REJECTED' }),
    ]);
  });
});
