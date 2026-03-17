/**
 * Tests for Phase 8 — Multi-Worker Collaboration
 *
 * Covers:
 *   - Sequential handoff chain lifecycle
 *   - Parallel fan-out with 3 merge strategies
 *   - Escalation + auto-escalation rules
 *   - Template management + execution
 *   - Query APIs
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createHandoffChain,
  advanceHandoff,
  createFanOut,
  completeFanOutWorker,
  createEscalation,
  resolveEscalation,
  checkAutoEscalation,
  getDelegation,
  getDelegationsForTask,
  getDelegationsForWorker,
  getChainStatus,
  getFanOutStatus,
  registerTemplate,
  getTemplate,
  listTemplates,
  executeTemplate,
  DELEGATION_TYPES,
  DELEGATION_STATUS,
  _resetForTesting,
} from './multiWorkerService.js';

beforeEach(() => _resetForTesting());

// ═══════════════════════════════════════════════════════════════════════════
// Sequential Handoff
// ═══════════════════════════════════════════════════════════════════════════

describe('Sequential Handoff', () => {
  it('creates a handoff chain with correct delegation count', () => {
    const result = createHandoffChain({
      parentTaskId: 'task-1',
      parentWorkerId: 'worker-origin',
      workerChain: ['planning', 'risk', 'procurement'],
      context: { priority: 'high' },
    });

    expect(result.ok).toBe(true);
    expect(result.delegations).toHaveLength(3);
    expect(result.chainId).toBeTruthy();
  });

  it('first delegation is active, rest are pending', () => {
    const { delegations } = createHandoffChain({
      parentTaskId: 'task-1',
      parentWorkerId: 'w-origin',
      workerChain: ['A', 'B', 'C'],
    });

    expect(delegations[0].status).toBe(DELEGATION_STATUS.ACTIVE);
    expect(delegations[1].status).toBe(DELEGATION_STATUS.PENDING);
    expect(delegations[2].status).toBe(DELEGATION_STATUS.PENDING);
  });

  it('advanceHandoff completes current and activates next', () => {
    const { delegations } = createHandoffChain({
      parentTaskId: 'task-1',
      parentWorkerId: 'w0',
      workerChain: ['A', 'B', 'C'],
    });

    const advance = advanceHandoff(delegations[0].id, { artifacts: ['brief-1'] });
    expect(advance.ok).toBe(true);
    expect(advance.chainComplete).toBe(false);
    expect(advance.next.child_worker_id).toBe('B');
    expect(advance.next.status).toBe(DELEGATION_STATUS.ACTIVE);
    expect(advance.next.context_json.previous_result).toEqual({ artifacts: ['brief-1'] });
  });

  it('advanceHandoff final step returns chainComplete', () => {
    const { delegations } = createHandoffChain({
      parentTaskId: 'task-1',
      parentWorkerId: 'w0',
      workerChain: ['A', 'B'],
    });

    advanceHandoff(delegations[0].id, {});
    const final = advanceHandoff(delegations[1].id, {});
    expect(final.ok).toBe(true);
    expect(final.chainComplete).toBe(true);
  });

  it('getChainStatus shows progress', () => {
    const { delegations, chainId } = createHandoffChain({
      parentTaskId: 't1',
      parentWorkerId: 'w0',
      workerChain: ['A', 'B', 'C'],
    });

    advanceHandoff(delegations[0].id, {});

    const status = getChainStatus(chainId);
    expect(status.total).toBe(3);
    expect(status.completed).toBe(1);
    expect(status.active_worker).toBe('B');
    expect(status.all_complete).toBe(false);
  });

  it('rejects empty worker chain', () => {
    const result = createHandoffChain({
      parentTaskId: 'task-1',
      parentWorkerId: 'w0',
      workerChain: [],
    });
    expect(result.ok).toBe(false);
  });

  it('accumulates artifacts through chain', () => {
    const { delegations } = createHandoffChain({
      parentTaskId: 't1',
      parentWorkerId: 'w0',
      workerChain: ['A', 'B', 'C'],
    });

    advanceHandoff(delegations[0].id, { artifacts: ['brief-A'] });
    const secondAdvance = advanceHandoff(delegations[1].id, { artifacts: ['brief-B'] });

    // C should have accumulated artifacts from A
    if (!secondAdvance.chainComplete) {
      expect(secondAdvance.next.context_json.accumulated_artifacts).toContain('brief-A');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Parallel Fan-Out
// ═══════════════════════════════════════════════════════════════════════════

describe('Parallel Fan-Out', () => {
  it('creates fan-out with all workers active', () => {
    const result = createFanOut({
      parentTaskId: 'task-fo',
      parentWorkerId: 'origin',
      workerIds: ['planning', 'risk', 'finance'],
      context: { event_type: 'demand_spike' },
    });

    expect(result.ok).toBe(true);
    expect(result.delegations).toHaveLength(3);
    expect(result.delegations.every(d => d.status === DELEGATION_STATUS.ACTIVE)).toBe(true);
    expect(result.fanOutId).toBeTruthy();
  });

  it('completeFanOutWorker tracks partial completion', () => {
    const { delegations } = createFanOut({
      parentTaskId: 'task-fo',
      parentWorkerId: 'origin',
      workerIds: ['A', 'B', 'C'],
    });

    const partial = completeFanOutWorker(delegations[0].id, { recommended_action: 'expedite' });
    expect(partial.ok).toBe(true);
    expect(partial.allComplete).toBe(false);
    expect(partial.progress).toBe('1/3');
  });

  it('completeFanOutWorker merges when all complete (strategy=all)', () => {
    const { delegations } = createFanOut({
      parentTaskId: 'task-fo',
      parentWorkerId: 'origin',
      workerIds: ['A', 'B'],
      mergeStrategy: 'all',
    });

    completeFanOutWorker(delegations[0].id, { recommended_action: 'expedite' });
    const final = completeFanOutWorker(delegations[1].id, { recommended_action: 'defer' });

    expect(final.allComplete).toBe(true);
    expect(final.merged.strategy).toBe('all');
    expect(final.merged.results).toHaveLength(2);
  });

  it('fan-out merge strategy: first', () => {
    const { delegations } = createFanOut({
      parentTaskId: 'task-fo',
      parentWorkerId: 'origin',
      workerIds: ['A', 'B'],
      mergeStrategy: 'first',
    });

    completeFanOutWorker(delegations[0].id, { recommended_action: 'expedite' });
    const final = completeFanOutWorker(delegations[1].id, { recommended_action: 'defer' });

    expect(final.merged.strategy).toBe('first');
    expect(final.merged.selected.result.recommended_action).toBe('expedite');
  });

  it('fan-out merge strategy: majority', () => {
    const { delegations } = createFanOut({
      parentTaskId: 'task-fo',
      parentWorkerId: 'origin',
      workerIds: ['A', 'B', 'C'],
      mergeStrategy: 'majority',
    });

    completeFanOutWorker(delegations[0].id, { recommended_action: 'expedite' });
    completeFanOutWorker(delegations[1].id, { recommended_action: 'expedite' });
    const final = completeFanOutWorker(delegations[2].id, { recommended_action: 'defer' });

    expect(final.merged.strategy).toBe('majority');
    expect(final.merged.winning_action).toBe('expedite');
    expect(final.merged.vote_count).toBe(2);
  });

  it('getFanOutStatus reports progress', () => {
    const { delegations, fanOutId } = createFanOut({
      parentTaskId: 't',
      parentWorkerId: 'w',
      workerIds: ['A', 'B', 'C'],
    });

    completeFanOutWorker(delegations[0].id, {});

    const status = getFanOutStatus(fanOutId);
    expect(status.total).toBe(3);
    expect(status.completed).toBe(1);
    expect(status.in_progress).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Escalation
// ═══════════════════════════════════════════════════════════════════════════

describe('Escalation', () => {
  it('creates escalation delegation', () => {
    const result = createEscalation({
      parentTaskId: 'task-esc',
      parentWorkerId: 'junior-worker',
      coordinatorId: 'senior-coordinator',
      reason: 'Low confidence in supplier selection',
      context: { confidence: 0.3 },
    });

    expect(result.ok).toBe(true);
    expect(result.delegation.delegation_type).toBe(DELEGATION_TYPES.ESCALATION);
    expect(result.delegation.child_worker_id).toBe('senior-coordinator');
    expect(result.delegation.context_json.escalation_reason).toBe('Low confidence in supplier selection');
  });

  it('resolveEscalation completes delegation', () => {
    const { delegation } = createEscalation({
      parentTaskId: 't1',
      parentWorkerId: 'w1',
      coordinatorId: 'coord',
      reason: 'test',
    });

    const resolved = resolveEscalation(delegation.id, {
      decision: 'override',
      instructions: 'Use alternative supplier',
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.delegation.status).toBe(DELEGATION_STATUS.COMPLETED);
    expect(resolved.delegation.result_json.decision).toBe('override');
  });

  it('resolveEscalation rejects non-escalation', () => {
    const { delegations } = createHandoffChain({
      parentTaskId: 't1',
      parentWorkerId: 'w1',
      workerChain: ['A'],
    });

    const result = resolveEscalation(delegations[0].id, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Not an escalation');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Auto-Escalation Rules
// ═══════════════════════════════════════════════════════════════════════════

describe('checkAutoEscalation', () => {
  it('escalates on low confidence', () => {
    const result = checkAutoEscalation({ confidence: 0.3 });
    expect(result.shouldEscalate).toBe(true);
    expect(result.reason).toContain('confidence');
  });

  it('escalates on critical risk', () => {
    const result = checkAutoEscalation({ riskLevel: 'critical' });
    expect(result.shouldEscalate).toBe(true);
  });

  it('escalates on too many retries', () => {
    const result = checkAutoEscalation({ retryCount: 5 });
    expect(result.shouldEscalate).toBe(true);
  });

  it('escalates on high cost impact', () => {
    const result = checkAutoEscalation({ costImpact: 200_000 });
    expect(result.shouldEscalate).toBe(true);
  });

  it('does not escalate normal tasks', () => {
    const result = checkAutoEscalation({
      confidence: 0.85,
      riskLevel: 'medium',
      retryCount: 0,
      costImpact: 5000,
    });
    expect(result.shouldEscalate).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Template Management
// ═══════════════════════════════════════════════════════════════════════════

describe('Template Management', () => {
  it('registerTemplate + getTemplate roundtrip', () => {
    registerTemplate('test-chain', {
      delegation_type: DELEGATION_TYPES.HANDOFF,
      worker_chain: ['A', 'B', 'C'],
    });

    const t = getTemplate('test-chain');
    expect(t).toBeDefined();
    expect(t.worker_chain).toEqual(['A', 'B', 'C']);
  });

  it('listTemplates returns all registered', () => {
    registerTemplate('t1', { delegation_type: 'handoff', worker_chain: ['A'] });
    registerTemplate('t2', { delegation_type: 'fan_out', worker_chain: ['B', 'C'] });

    expect(listTemplates()).toHaveLength(2);
  });

  it('executeTemplate creates handoff from template', () => {
    registerTemplate('supply-chain', {
      delegation_type: DELEGATION_TYPES.HANDOFF,
      worker_chain: ['planning', 'risk', 'procurement'],
    });

    const result = executeTemplate('supply-chain', {
      parentTaskId: 'task-1',
      parentWorkerId: 'origin',
    });

    expect(result.ok).toBe(true);
    expect(result.delegations).toHaveLength(3);
  });

  it('executeTemplate creates fan-out from template', () => {
    registerTemplate('parallel-analysis', {
      delegation_type: DELEGATION_TYPES.FAN_OUT,
      worker_chain: ['A', 'B'],
      merge_strategy: 'majority',
    });

    const result = executeTemplate('parallel-analysis', {
      parentTaskId: 'task-2',
      parentWorkerId: 'origin',
    });

    expect(result.ok).toBe(true);
    expect(result.mergeStrategy).toBe('majority');
  });

  it('executeTemplate creates escalation from template', () => {
    registerTemplate('escalate-high-risk', {
      delegation_type: DELEGATION_TYPES.ESCALATION,
      worker_chain: ['coordinator'],
      escalation_reason: 'Template-triggered escalation',
    });

    const result = executeTemplate('escalate-high-risk', {
      parentTaskId: 'task-3',
      parentWorkerId: 'junior',
    });

    expect(result.ok).toBe(true);
    expect(result.delegation.child_worker_id).toBe('coordinator');
  });

  it('executeTemplate rejects unknown template', () => {
    const result = executeTemplate('nonexistent', {
      parentTaskId: 't', parentWorkerId: 'w',
    });
    expect(result.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Query APIs
// ═══════════════════════════════════════════════════════════════════════════

describe('Query APIs', () => {
  it('getDelegation returns by ID', () => {
    const { delegation } = createEscalation({
      parentTaskId: 't1',
      parentWorkerId: 'w1',
      coordinatorId: 'coord',
      reason: 'test',
    });

    expect(getDelegation(delegation.id)).toBeTruthy();
    expect(getDelegation('nonexistent')).toBeNull();
  });

  it('getDelegationsForTask returns all delegations for a task', () => {
    createHandoffChain({ parentTaskId: 'task-A', parentWorkerId: 'w1', workerChain: ['A', 'B'] });
    createEscalation({ parentTaskId: 'task-A', parentWorkerId: 'w1', coordinatorId: 'C', reason: 'test' });
    createHandoffChain({ parentTaskId: 'task-B', parentWorkerId: 'w2', workerChain: ['D'] });

    const delegations = getDelegationsForTask('task-A');
    expect(delegations.length).toBe(3); // 2 handoff + 1 escalation
  });

  it('getDelegationsForWorker returns both parent and child roles', () => {
    createHandoffChain({ parentTaskId: 't1', parentWorkerId: 'worker-X', workerChain: ['worker-Y', 'worker-Z'] });

    const xDelegations = getDelegationsForWorker('worker-X');
    expect(xDelegations.length).toBeGreaterThan(0);

    const yDelegations = getDelegationsForWorker('worker-Y');
    expect(yDelegations.length).toBeGreaterThan(0);
  });
});
