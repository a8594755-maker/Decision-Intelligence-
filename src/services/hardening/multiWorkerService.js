/**
 * multiWorkerService.js — Multi-Worker Collaboration Engine (Phase 8)
 *
 * Implements three collaboration patterns:
 *   1. Sequential Handoff: Worker A finishes → pass context → Worker B starts
 *   2. Parallel Fan-Out:   Same event → spawn N workers in parallel → merge results
 *   3. Escalation:         Worker detects low confidence → escalate to coordinator
 *
 * All patterns produce delegation records for audit trail.
 *
 * @module services/hardening/multiWorkerService
 */

// ── Constants ───────────────────────────────────────────────────────────────

export const DELEGATION_TYPES = Object.freeze({
  HANDOFF:    'handoff',
  FAN_OUT:    'fan_out',
  ESCALATION: 'escalation',
});

export const DELEGATION_STATUS = Object.freeze({
  PENDING:   'pending',
  ACTIVE:    'active',
  COMPLETED: 'completed',
  FAILED:    'failed',
  CANCELLED: 'cancelled',
  SKIPPED:   'skipped',
});

// ── In-Memory Registry (Supabase persistence optional) ──────────────────────

const _delegations = new Map();
const _templates = new Map();
let _delegationCounter = 0;

// ── Sequential Handoff ──────────────────────────────────────────────────────

/**
 * Create a sequential handoff chain: Worker A → Worker B → Worker C.
 * Each worker starts only after the previous one completes.
 *
 * @param {Object} params
 * @param {string} params.parentTaskId - Original task that triggers the chain
 * @param {string} params.parentWorkerId - Worker that initiated the chain
 * @param {string[]} params.workerChain - Ordered list of worker IDs
 * @param {Object} params.context - Shared context passed through the chain
 * @returns {{ ok: boolean, delegations: Object[], chainId: string }}
 */
export function createHandoffChain({ parentTaskId, parentWorkerId, workerChain, context = {} }) {
  if (!workerChain || workerChain.length === 0) {
    return { ok: false, error: 'Worker chain must have at least one worker' };
  }

  const chainId = `chain-${Date.now().toString(36)}-${(++_delegationCounter).toString(36)}`;
  const delegations = [];

  for (let i = 0; i < workerChain.length; i++) {
    const delegation = {
      id: `del-${chainId}-${i}`,
      chain_id: chainId,
      parent_task_id: parentTaskId,
      parent_worker_id: i === 0 ? parentWorkerId : workerChain[i - 1],
      child_worker_id: workerChain[i],
      child_task_id: null, // assigned when worker starts
      delegation_type: DELEGATION_TYPES.HANDOFF,
      sequence_order: i,
      context_json: {
        ...context,
        chain_id: chainId,
        chain_position: i,
        chain_length: workerChain.length,
        previous_worker: i > 0 ? workerChain[i - 1] : null,
      },
      status: i === 0 ? DELEGATION_STATUS.ACTIVE : DELEGATION_STATUS.PENDING,
      result_json: null,
      started_at: i === 0 ? new Date().toISOString() : null,
      completed_at: null,
      created_at: new Date().toISOString(),
    };

    _delegations.set(delegation.id, delegation);
    delegations.push(delegation);
  }

  return { ok: true, delegations, chainId };
}

/**
 * Advance a handoff chain when a worker completes its task.
 *
 * @param {string} delegationId - Current delegation ID
 * @param {Object} result - Task result from the completing worker
 * @returns {{ ok: boolean, next?: Object, chainComplete?: boolean }}
 */
export function advanceHandoff(delegationId, result = {}) {
  const current = _delegations.get(delegationId);
  if (!current) return { ok: false, error: 'Delegation not found' };
  if (current.delegation_type !== DELEGATION_TYPES.HANDOFF) {
    return { ok: false, error: 'Not a handoff delegation' };
  }

  // Complete current
  current.status = DELEGATION_STATUS.COMPLETED;
  current.result_json = result;
  current.completed_at = new Date().toISOString();

  // Find next in chain
  const chainDelegations = Array.from(_delegations.values())
    .filter(d => d.chain_id === current.chain_id)
    .sort((a, b) => a.sequence_order - b.sequence_order);

  const nextIdx = current.sequence_order + 1;
  const next = chainDelegations[nextIdx];

  if (!next) {
    return { ok: true, chainComplete: true, chainId: current.chain_id };
  }

  // Activate next delegation, passing accumulated context
  next.status = DELEGATION_STATUS.ACTIVE;
  next.started_at = new Date().toISOString();
  next.context_json = {
    ...next.context_json,
    previous_result: result,
    accumulated_artifacts: _gatherChainArtifacts(chainDelegations, nextIdx),
  };

  return { ok: true, next, chainComplete: false };
}

// ── Parallel Fan-Out ────────────────────────────────────────────────────────

/**
 * Fan out a task to multiple workers in parallel.
 * All workers receive the same context and run concurrently.
 *
 * @param {Object} params
 * @param {string} params.parentTaskId
 * @param {string} params.parentWorkerId
 * @param {string[]} params.workerIds - Workers to fan out to
 * @param {Object} params.context - Shared context
 * @param {string} [params.mergeStrategy='all'] - 'all' | 'first' | 'majority'
 * @returns {{ ok: boolean, delegations: Object[], fanOutId: string }}
 */
export function createFanOut({ parentTaskId, parentWorkerId, workerIds, context = {}, mergeStrategy = 'all' }) {
  if (!workerIds || workerIds.length === 0) {
    return { ok: false, error: 'Must specify at least one worker' };
  }

  const fanOutId = `fanout-${Date.now().toString(36)}-${(++_delegationCounter).toString(36)}`;
  const delegations = [];

  for (let i = 0; i < workerIds.length; i++) {
    const delegation = {
      id: `del-${fanOutId}-${i}`,
      fan_out_id: fanOutId,
      parent_task_id: parentTaskId,
      parent_worker_id: parentWorkerId,
      child_worker_id: workerIds[i],
      child_task_id: null,
      delegation_type: DELEGATION_TYPES.FAN_OUT,
      sequence_order: i,
      context_json: {
        ...context,
        fan_out_id: fanOutId,
        fan_out_size: workerIds.length,
        merge_strategy: mergeStrategy,
        worker_index: i,
      },
      status: DELEGATION_STATUS.ACTIVE, // All start immediately
      result_json: null,
      started_at: new Date().toISOString(),
      completed_at: null,
      created_at: new Date().toISOString(),
    };

    _delegations.set(delegation.id, delegation);
    delegations.push(delegation);
  }

  return { ok: true, delegations, fanOutId, mergeStrategy };
}

/**
 * Report completion of a fan-out worker. Checks if all workers are done.
 *
 * @param {string} delegationId
 * @param {Object} result
 * @returns {{ ok: boolean, allComplete: boolean, merged?: Object }}
 */
export function completeFanOutWorker(delegationId, result = {}) {
  const current = _delegations.get(delegationId);
  if (!current) return { ok: false, error: 'Delegation not found' };
  if (current.delegation_type !== DELEGATION_TYPES.FAN_OUT) {
    return { ok: false, error: 'Not a fan-out delegation' };
  }

  current.status = DELEGATION_STATUS.COMPLETED;
  current.result_json = result;
  current.completed_at = new Date().toISOString();

  // Check if all fan-out workers are done
  const fanOutDelegations = Array.from(_delegations.values())
    .filter(d => d.fan_out_id === current.fan_out_id);

  const allComplete = fanOutDelegations.every(
    d => d.status === DELEGATION_STATUS.COMPLETED || d.status === DELEGATION_STATUS.FAILED,
  );

  if (!allComplete) {
    const done = fanOutDelegations.filter(d => d.status === DELEGATION_STATUS.COMPLETED).length;
    return { ok: true, allComplete: false, progress: `${done}/${fanOutDelegations.length}` };
  }

  // Merge results
  const mergeStrategy = current.context_json?.merge_strategy || 'all';
  const merged = _mergeResults(fanOutDelegations, mergeStrategy);

  return { ok: true, allComplete: true, merged };
}

// ── Escalation ──────────────────────────────────────────────────────────────

/**
 * Escalate a task from a worker to a coordinator/senior worker.
 *
 * @param {Object} params
 * @param {string} params.parentTaskId
 * @param {string} params.parentWorkerId - Worker requesting escalation
 * @param {string} params.coordinatorId - Target coordinator worker
 * @param {string} params.reason - Why escalation is needed
 * @param {Object} params.context - Task context + artifacts so far
 * @returns {{ ok: boolean, delegation?: Object }}
 */
export function createEscalation({ parentTaskId, parentWorkerId, coordinatorId, reason, context = {} }) {
  const delegation = {
    id: `esc-${Date.now().toString(36)}-${(++_delegationCounter).toString(36)}`,
    parent_task_id: parentTaskId,
    parent_worker_id: parentWorkerId,
    child_worker_id: coordinatorId,
    child_task_id: null,
    delegation_type: DELEGATION_TYPES.ESCALATION,
    sequence_order: 0,
    context_json: {
      ...context,
      escalation_reason: reason,
      escalated_from: parentWorkerId,
      escalated_at: new Date().toISOString(),
    },
    status: DELEGATION_STATUS.ACTIVE,
    result_json: null,
    started_at: new Date().toISOString(),
    completed_at: null,
    created_at: new Date().toISOString(),
  };

  _delegations.set(delegation.id, delegation);
  return { ok: true, delegation };
}

/**
 * Resolve an escalation (coordinator completes review).
 *
 * @param {string} delegationId
 * @param {Object} resolution - { decision, instructions, override_artifacts }
 * @returns {{ ok: boolean }}
 */
export function resolveEscalation(delegationId, resolution = {}) {
  const delegation = _delegations.get(delegationId);
  if (!delegation) return { ok: false, error: 'Delegation not found' };
  if (delegation.delegation_type !== DELEGATION_TYPES.ESCALATION) {
    return { ok: false, error: 'Not an escalation delegation' };
  }

  delegation.status = DELEGATION_STATUS.COMPLETED;
  delegation.result_json = resolution;
  delegation.completed_at = new Date().toISOString();

  return { ok: true, delegation };
}

// ── Auto-Escalation Rules ───────────────────────────────────────────────────

/**
 * Check if a task should be auto-escalated based on rules.
 *
 * @param {Object} taskContext
 * @param {number} taskContext.confidence - Decision confidence (0-1)
 * @param {string} taskContext.riskLevel - 'low' | 'medium' | 'high' | 'critical'
 * @param {number} taskContext.retryCount - Number of retries so far
 * @param {number} taskContext.costImpact - Absolute cost impact
 * @returns {{ shouldEscalate: boolean, reason?: string }}
 */
export function checkAutoEscalation(taskContext) {
  const { confidence = 1, riskLevel = 'low', retryCount = 0, costImpact = 0 } = taskContext;

  if (confidence < 0.5) {
    return { shouldEscalate: true, reason: `Low confidence: ${confidence}` };
  }
  if (riskLevel === 'critical') {
    return { shouldEscalate: true, reason: 'Critical risk level' };
  }
  if (retryCount >= 3) {
    return { shouldEscalate: true, reason: `Too many retries: ${retryCount}` };
  }
  if (Math.abs(costImpact) > 100_000) {
    return { shouldEscalate: true, reason: `High cost impact: $${costImpact}` };
  }

  return { shouldEscalate: false };
}

// ── Query API ───────────────────────────────────────────────────────────────

export function getDelegation(id) {
  return _delegations.get(id) || null;
}

export function getDelegationsForTask(taskId) {
  return Array.from(_delegations.values()).filter(d => d.parent_task_id === taskId);
}

export function getDelegationsForWorker(workerId) {
  return Array.from(_delegations.values()).filter(
    d => d.parent_worker_id === workerId || d.child_worker_id === workerId,
  );
}

export function getChainStatus(chainId) {
  const delegations = Array.from(_delegations.values())
    .filter(d => d.chain_id === chainId)
    .sort((a, b) => a.sequence_order - b.sequence_order);

  if (delegations.length === 0) return null;

  const active = delegations.find(d => d.status === DELEGATION_STATUS.ACTIVE);
  const completed = delegations.filter(d => d.status === DELEGATION_STATUS.COMPLETED).length;

  return {
    chain_id: chainId,
    total: delegations.length,
    completed,
    active_worker: active?.child_worker_id || null,
    active_step: active?.sequence_order ?? null,
    all_complete: completed === delegations.length,
    delegations,
  };
}

export function getFanOutStatus(fanOutId) {
  const delegations = Array.from(_delegations.values())
    .filter(d => d.fan_out_id === fanOutId);

  if (delegations.length === 0) return null;

  const completed = delegations.filter(d => d.status === DELEGATION_STATUS.COMPLETED).length;
  const failed = delegations.filter(d => d.status === DELEGATION_STATUS.FAILED).length;

  return {
    fan_out_id: fanOutId,
    total: delegations.length,
    completed,
    failed,
    in_progress: delegations.length - completed - failed,
    all_complete: completed + failed === delegations.length,
    delegations,
  };
}

// ── Template Management ─────────────────────────────────────────────────────

export function registerTemplate(name, template) {
  _templates.set(name, { name, ...template, registered_at: new Date().toISOString() });
}

export function getTemplate(name) {
  return _templates.get(name) || null;
}

export function listTemplates() {
  return Array.from(_templates.values());
}

/**
 * Execute a delegation from a named template.
 */
export function executeTemplate(templateName, { parentTaskId, parentWorkerId, context = {} }) {
  const template = _templates.get(templateName);
  if (!template) return { ok: false, error: `Template not found: ${templateName}` };

  switch (template.delegation_type) {
    case DELEGATION_TYPES.HANDOFF:
      return createHandoffChain({
        parentTaskId,
        parentWorkerId,
        workerChain: template.worker_chain,
        context,
      });
    case DELEGATION_TYPES.FAN_OUT:
      return createFanOut({
        parentTaskId,
        parentWorkerId,
        workerIds: template.worker_chain,
        context,
        mergeStrategy: template.merge_strategy || 'all',
      });
    case DELEGATION_TYPES.ESCALATION:
      return createEscalation({
        parentTaskId,
        parentWorkerId,
        coordinatorId: template.worker_chain[0],
        reason: template.escalation_reason || 'Template-triggered escalation',
        context,
      });
    default:
      return { ok: false, error: `Unknown delegation type: ${template.delegation_type}` };
  }
}

// ── Reset (for testing) ─────────────────────────────────────────────────────

export function _resetForTesting() {
  _delegations.clear();
  _templates.clear();
  _delegationCounter = 0;
}

// ── Internal Helpers ────────────────────────────────────────────────────────

function _gatherChainArtifacts(chainDelegations, upToIndex) {
  const artifacts = [];
  for (let i = 0; i < upToIndex; i++) {
    const d = chainDelegations[i];
    if (d.result_json?.artifacts) {
      artifacts.push(...(Array.isArray(d.result_json.artifacts) ? d.result_json.artifacts : [d.result_json.artifacts]));
    }
  }
  return artifacts;
}

function _mergeResults(delegations, strategy) {
  const completed = delegations
    .filter(d => d.status === DELEGATION_STATUS.COMPLETED)
    .map(d => ({
      worker_id: d.child_worker_id,
      result: d.result_json,
      completed_at: d.completed_at,
    }));

  switch (strategy) {
    case 'first':
      // Use first completed result
      return {
        strategy: 'first',
        selected: completed[0] || null,
        all_results: completed,
      };

    case 'majority': {
      // Group by recommended_action, pick majority
      const votes = {};
      for (const c of completed) {
        const action = c.result?.recommended_action || 'unknown';
        votes[action] = (votes[action] || 0) + 1;
      }
      const winner = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
      return {
        strategy: 'majority',
        winning_action: winner?.[0],
        vote_count: winner?.[1],
        all_votes: votes,
        all_results: completed,
      };
    }

    case 'all':
    default:
      // Return all results for manual merge
      return {
        strategy: 'all',
        results: completed,
        result_count: completed.length,
      };
  }
}
