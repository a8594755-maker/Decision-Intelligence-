// @product: ai-employee
//
// Orchestrator Integration Tests
// ─────────────────────────────────────────────────────────────────────────────
// Tests the full orchestrator flow with realistic in-memory DB mocks.
// Covers the gaps identified in the test pyramid:
//   1. Capability gate blocking at A1 autonomy
//   2. approvePlan propagating _plan_approved_by to bypass capability gate
//   3. tick loop detecting all-steps-review_hold → LLM diagnosis
//   4. _completeTask only fires when ALL steps are terminal
//   5. approveReview unblocking review_hold steps
//   6. Fallback when getNextPendingStep returns null but pending steps exist
//   7. Empty steps guard prevents false completion

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STEP_STATES } from './stepStateMachine.js';
import { TASK_STATES } from './taskStateMachine.js';

// ── In-memory DB ────────────────────────────────────────────────────────────

let _tasks = {};
let _steps = [];
let _employees = {};
let _versionCounter = 0;
let _testSuffix = 0; // Ensures unique task IDs across tests to avoid background tick loop collisions

function resetDb() {
  _tasks = {};
  _steps = [];
  _employees = {};
  _versionCounter = 0;
  _testSuffix++;
}

function makeTask(overrides = {}) {
  const id = overrides.id || `task-${_testSuffix}-${++_versionCounter}`;
  const task = {
    id,
    employee_id: overrides.employee_id || 'emp-1',
    title: overrides.title || 'Test task',
    description: overrides.description || '',
    status: overrides.status || TASK_STATES.DRAFT_PLAN,
    version: overrides.version || 1,
    input_context: overrides.input_context || {},
    plan_snapshot: overrides.plan_snapshot || { steps: [] },
    priority: 'medium',
    source_type: 'manual',
    assigned_by_user_id: 'user-1',
    ...(overrides._extra || {}),
  };
  _tasks[id] = task;
  return task;
}

function makeStep(taskId, index, overrides = {}) {
  const step = {
    id: `step-${taskId}-${index}`,
    task_id: taskId,
    employee_id: overrides.employee_id || 'emp-1',
    step_index: index,
    step_name: overrides.step_name || `step_${index}`,
    status: overrides.status || STEP_STATES.PENDING,
    retry_count: 0,
    max_retries: 3,
    error_message: null,
    artifact_refs: [],
    ...overrides,
  };
  _steps.push(step);
  return step;
}

// ── Supabase mock ───────────────────────────────────────────────────────────

vi.mock('../../services/infra/supabaseClient', () => ({ supabase: null }));

// ── Mock persistence layer (taskRepo, stepRepo, employeeRepo) ──────────────

vi.mock('./persistence/taskRepo.js', () => ({
  createTask: vi.fn(async (params) => {
    const task = makeTask({
      employee_id: params.employeeId,
      title: params.title,
      description: params.description,
      input_context: params.inputContext || {},
      plan_snapshot: params.planSnapshot || {},
      status: TASK_STATES.DRAFT_PLAN,
    });
    return task;
  }),
  getTask: vi.fn(async (taskId) => {
    const t = _tasks[taskId];
    if (!t) throw new Error(`Task not found: ${taskId}`);
    return { ...t };
  }),
  updateTaskStatus: vi.fn(async (taskId, newStatus, expectedVersion) => {
    const t = _tasks[taskId];
    if (!t) throw new Error(`Task not found: ${taskId}`);
    if (t.version !== expectedVersion) {
      throw new Error(`Concurrent modification on task ${taskId}. Expected ${expectedVersion}, got ${t.version}`);
    }
    t.status = newStatus;
    t.version += 1;
    return { ...t };
  }),
  updateTaskInputContext: vi.fn(async (taskId, inputContext, expectedVersion) => {
    const t = _tasks[taskId];
    if (!t) throw new Error(`Task not found: ${taskId}`);
    if (t.version !== expectedVersion) {
      throw new Error(`Concurrent modification on task ${taskId}`);
    }
    t.input_context = inputContext;
    t.version += 1;
    return { ...t };
  }),
}));

vi.mock('./persistence/stepRepo.js', () => ({
  createSteps: vi.fn(async (taskId, employeeId, steps) => {
    return steps.map((s, i) => makeStep(taskId, i, {
      employee_id: employeeId,
      step_name: s.name,
      status: STEP_STATES.PENDING,
    }));
  }),
  getSteps: vi.fn(async (taskId) => {
    return _steps
      .filter(s => s.task_id === taskId)
      .sort((a, b) => a.step_index - b.step_index)
      .map(s => ({ ...s }));
  }),
  getNextPendingStep: vi.fn(async (taskId) => {
    const pending = _steps
      .filter(s => s.task_id === taskId && (s.status === STEP_STATES.PENDING || s.status === STEP_STATES.RETRYING))
      .sort((a, b) => a.step_index - b.step_index);
    return pending.length > 0 ? { ...pending[0] } : null;
  }),
  updateStep: vi.fn(async (stepId, updates) => {
    const s = _steps.find(x => x.id === stepId);
    if (!s) throw new Error(`Step not found: ${stepId}`);
    Object.assign(s, updates);
    return { ...s };
  }),
  markStepSucceeded: vi.fn(async (stepId, { summary, artifactRefs }) => {
    const s = _steps.find(x => x.id === stepId);
    if (!s) throw new Error(`Step not found: ${stepId}`);
    s.status = STEP_STATES.SUCCEEDED;
    s.summary = summary || '';
    s.artifact_refs = artifactRefs || [];
    return { ...s };
  }),
  markStepFailed: vi.fn(async (stepId, error) => {
    const s = _steps.find(x => x.id === stepId);
    if (!s) throw new Error(`Step not found: ${stepId}`);
    s.status = STEP_STATES.FAILED;
    s.error_message = error;
    return { ...s };
  }),
}));

vi.mock('./persistence/employeeRepo.js', () => ({
  getEmployee: vi.fn(async (id) => ({
    id,
    name: 'Test Worker',
    permissions: { can_run_builtin_tool: true },
    _logicalState: 'idle',
    template_id: null,
  })),
  updateEmployeeStatus: vi.fn(async () => {}),
}));

vi.mock('./persistence/worklogRepo.js', () => ({
  appendWorklog: vi.fn(async () => {}),
}));

// ── Mock external services (non-DB) ────────────────────────────────────────

vi.mock('../selfHealingService.js', () => ({
  analyzeStepFailure: vi.fn(() => ({
    healingStrategy: 'block_immediately',
    reasoning: 'test failure',
  })),
  getAlternativeModel: vi.fn(() => null),
  classifyError: vi.fn(() => 'unknown'),
}));

vi.mock('../eventBus.js', () => {
  const emitted = [];
  return {
    eventBus: {
      emit: vi.fn((...args) => emitted.push(args)),
      on: vi.fn(() => () => {}),
    },
    EVENT_NAMES: {
      AGENT_STEP_STARTED: 'agent:step_started',
      AGENT_STEP_COMPLETED: 'agent:step_completed',
      AGENT_STEP_FAILED: 'agent:step_failed',
      AGENT_STEP_BLOCKED: 'agent:step_blocked',
      AGENT_STEP_DIAGNOSED: 'agent:step_diagnosed',
      AGENT_STEP_REVISION: 'agent:step_revision',
      AGENT_LOOP_DONE: 'agent:loop_done',
      AGENT_LOOP_ERROR: 'agent:loop_error',
      TASK_CREATED: 'task:created',
      TASK_STARTED: 'task:started',
      TASK_COMPLETED: 'task:completed',
      TASK_FAILED: 'task:failed',
      REVIEW_REQUESTED: 'review:requested',
    },
    _emitted: emitted,
  };
});

vi.mock('../capabilityModelService.js', () => ({
  resolveCapabilityClass: vi.fn(() => 'planning'),
  getCapabilityPolicyFromDB: vi.fn(async () => ({
    approval_required: true,
    auto_approve_at: 'A3',
    min_autonomy_level: 'A1',
    sensitive_data_allowed: false,
  })),
}));

vi.mock('./styleLearning/trustMetricsService.js', () => ({
  getLatestMetrics: vi.fn(async () => null), // No metrics → A1 default
  recordReviewOutcome: vi.fn(async () => {}),
}));

vi.mock('./styleLearning/outputProfileService.js', () => ({
  composeOutputProfileContext: vi.fn(async () => ({ styleContext: null, outputProfile: null })),
}));

vi.mock('./styleLearning/feedbackStyleExtractor.js', () => ({
  extractFromSingleRevision: vi.fn(async () => {}),
}));

vi.mock('../taskBudgetService.js', () => ({
  checkBudget: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('../aiEmployeeMemoryService.js', () => ({
  recall: vi.fn(async () => []),
  summarizeMemories: vi.fn(() => ''),
}));

vi.mock('../aiReviewerService.js', () => ({
  reviewStepOutput: vi.fn(async () => ({ passed: true, score: 1.0 })),
  shouldReview: vi.fn(() => false),
}));

vi.mock('./decisionPipelineService.js', () => ({
  annotateStepsWithPhases: vi.fn((steps) => steps.map(s => ({ ...s, _pipeline_phase: 'analyze' }))),
  getPipelineProgress: vi.fn(),
  classifyStepPhase: vi.fn(() => 'analyze'),
  PIPELINE_PHASES: { INGEST: 'ingest', ANALYZE: 'analyze', DRAFT_PLAN: 'draft_plan', REVIEW: 'review', PUBLISH: 'publish' },
}));

vi.mock('./worklogTaxonomy.js', () => ({
  WORKLOG_EVENTS: {},
  buildWorklogEntry: vi.fn(),
}));

vi.mock('../artifacts/decisionArtifactBuilder.js', () => ({
  buildDecisionBrief: vi.fn(() => ({})),
}));
vi.mock('../artifacts/evidencePackBuilder.js', () => ({
  buildEvidencePack: vi.fn(() => ({})),
}));
vi.mock('../artifacts/writebackPayloadBuilder.js', () => ({
  buildWritebackPayload: vi.fn(() => ({})),
}));
vi.mock('../approvalGateService.js', () => ({
  enforceApprovalGate: vi.fn(() => ({ allowed: true })),
}));
vi.mock('../roi/valueTrackingService.js', () => ({
  recordTaskValue: vi.fn(async () => {}),
}));
vi.mock('../hardening/auditTrailService.js', () => ({
  buildFullAuditTrail: vi.fn(() => ({})),
}));
vi.mock('./ralphLoopAdapter.js', () => ({
  isRalphLoopEnabled: vi.fn(() => false),
  runRalphLoop: vi.fn(async () => ({ completionReason: 'done', iterations: 1 })),
}));
vi.mock('../datasetProfilesService.js', () => ({
  datasetProfilesService: { getDatasetProfileById: vi.fn(async () => null) },
}));
vi.mock('../policyRuleService.js', () => ({
  evaluateRules: vi.fn(async () => ({ allowed: true, require_approval: false, reasons: [], triggered_rules: [] })),
}));
vi.mock('../toolPermissionGuard.js', () => ({
  canExecuteTool: vi.fn(() => true),
  checkCapabilityPolicy: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('./lazyContextService.js', () => ({
  resolveContext: vi.fn(async () => ({ ok: false })),
  detectMissingContext: vi.fn(() => []),
}));
vi.mock('./errorDiagnosticService.js', () => ({
  diagnoseStepFailure: vi.fn(async ({ errorMessage }) => ({
    root_cause: `Diagnosed: ${errorMessage?.slice(0, 100)}`,
    category: 'permission_denied',
    severity: 'needs_user_action',
    suggestions: [{ action: 'fix', detail: 'Fix it' }],
    confidence: 0.8,
    source: 'template',
    diagnosis_ms: 5,
    step_name: 'test',
    retry_count: 0,
    error_snippet: errorMessage?.slice(0, 100),
  })),
}));

// Mock executor registry — return a simple success executor
vi.mock('./executors/executorRegistry.js', () => ({
  getExecutor: vi.fn(() => async () => ({
    ok: true,
    artifacts: ['artifact-001'],
    logs: ['executed successfully'],
  })),
}));

// ── Import orchestrator (after mocks) ──────────────────────────────────────

const orchestrator = await import('./orchestrator.js');
const { tick, approvePlan, approveReview, submitPlan, getTaskStatus } = orchestrator;
const stepRepo = await import('./persistence/stepRepo.js');
const taskRepo = await import('./persistence/taskRepo.js');
const { eventBus } = await import('../governance/eventBus.js');
const { getLatestMetrics } = await import('./styleLearning/trustMetricsService.js');
const { getCapabilityPolicyFromDB } = await import('../ai-infra/capabilityModelService.js');
const { diagnoseStepFailure } = await import('./errorDiagnosticService.js');
const { getExecutor } = await import('./executors/executorRegistry.js');

// ── Helpers ────────────────────────────────────────────────────────────────

function setupTaskWithSteps(numSteps, taskOverrides = {}, stepOverrides = {}) {
  const task = makeTask({
    status: TASK_STATES.IN_PROGRESS,
    plan_snapshot: {
      steps: Array.from({ length: numSteps }, (_, i) => ({
        name: stepOverrides.step_name || `step_${i}`,
        tool_type: stepOverrides.tool_type || 'builtin_tool',
        builtin_tool_id: stepOverrides.builtin_tool_id || `tool_${i}`,
      })),
    },
    ...taskOverrides,
  });
  const steps = [];
  for (let i = 0; i < numSteps; i++) {
    steps.push(makeStep(task.id, i, {
      employee_id: task.employee_id,
      step_name: `step_${i}`,
      ...stepOverrides,
    }));
  }
  return { task, steps };
}

// ── Tests ──────────────────────────────────────────────────────────────────

afterEach(async () => {
  // Let any background tick loops from approvePlan/approveReview settle
  await new Promise(r => setTimeout(r, 50));
});

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  // Reset default mock return values
  getLatestMetrics.mockResolvedValue(null); // A1 by default
  getCapabilityPolicyFromDB.mockResolvedValue({
    approval_required: true,
    auto_approve_at: 'A3',
    min_autonomy_level: 'A1',
    sensitive_data_allowed: false,
  });
  getExecutor.mockReturnValue(async () => ({
    ok: true, artifacts: ['artifact-001'], logs: ['ok'],
  }));
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Capability gate blocks steps at A1 autonomy
// ═══════════════════════════════════════════════════════════════════════════

describe('Capability gate', () => {
  it('blocks step when worker autonomy A1 < policy threshold A3', async () => {
    const { task } = setupTaskWithSteps(3);

    const result = await tick(task.id);

    // Step should be transitioned to review_hold
    const step0 = _steps.find(s => s.task_id === task.id && s.step_index === 0);
    expect(step0.status).toBe(STEP_STATES.REVIEW_HOLD);
    expect(step0.error_message).toContain('Capability "planning" requires approval');
    expect(step0.error_message).toContain('A1');
    expect(step0.error_message).toContain('A3');
  });

  it('blocks all steps sequentially when tick loop runs through them', async () => {
    const { task } = setupTaskWithSteps(3);

    // Run tick repeatedly until done
    let done = false;
    let iterations = 0;
    while (!done && iterations < 10) {
      const result = await tick(task.id);
      done = result.done;
      iterations++;
    }

    // All 3 steps should be in review_hold
    const taskSteps = _steps.filter(s => s.task_id === task.id);
    expect(taskSteps.every(s => s.status === STEP_STATES.REVIEW_HOLD)).toBe(true);

    // Task should be in review_hold state
    expect(_tasks[task.id].status).toBe(TASK_STATES.REVIEW_HOLD);
  });

  it('skips capability gate when autonomy >= A3', async () => {
    getLatestMetrics.mockResolvedValue({ autonomy_level: 'A3' });

    const { task } = setupTaskWithSteps(1);

    const result = await tick(task.id);

    // Step should have been executed (running → succeeded)
    const step0 = _steps.find(s => s.task_id === task.id && s.step_index === 0);
    expect(step0.status).toBe(STEP_STATES.SUCCEEDED);
  });

  it('skips capability gate when _plan_approved_by is set', async () => {
    const { task } = setupTaskWithSteps(1, {
      input_context: { _plan_approved_by: 'user-1', _plan_approved_at: '2026-01-01' },
    });

    const result = await tick(task.id);

    // Step should execute despite A1 autonomy, because plan was approved
    const step0 = _steps.find(s => s.task_id === task.id && s.step_index === 0);
    expect(step0.status).toBe(STEP_STATES.SUCCEEDED);
  });

  it('does not block when capability policy has approval_required=false', async () => {
    getCapabilityPolicyFromDB.mockResolvedValue({
      approval_required: false,
      auto_approve_at: 'A3',
      min_autonomy_level: 'A1',
      sensitive_data_allowed: false,
    });

    const { task } = setupTaskWithSteps(1);

    await tick(task.id);

    const step0 = _steps.find(s => s.task_id === task.id && s.step_index === 0);
    expect(step0.status).toBe(STEP_STATES.SUCCEEDED);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. approvePlan propagates plan-level approval
// ═══════════════════════════════════════════════════════════════════════════

describe('approvePlan propagation', () => {
  it('sets _plan_approved_by in input_context on approval', async () => {
    const task = makeTask({
      status: TASK_STATES.WAITING_APPROVAL,
      input_context: { workflow_type: 'forecast' },
      plan_snapshot: { steps: [{ name: 'step_0', tool_type: 'builtin_tool' }] },
    });
    makeStep(task.id, 0, { employee_id: task.employee_id });

    // approvePlan transitions task and sets _plan_approved_by
    await approvePlan(task.id, 'user-1');

    // Verify updateTaskInputContext was called with _plan_approved_by
    expect(taskRepo.updateTaskInputContext).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        _plan_approved_by: 'user-1',
        _plan_approved_at: expect.any(String),
      }),
      expect.any(Number),
    );
  });

  it('steps bypass capability gate after plan approval', async () => {
    // Ensure executor returns success
    getExecutor.mockReturnValue(async () => ({
      ok: true, artifacts: ['art-1'], logs: ['ok'],
    }));

    // Set up a task that was approved (input_context has _plan_approved_by)
    const { task } = setupTaskWithSteps(2, {
      input_context: { _plan_approved_by: 'user-1' },
    });

    // Run tick for step 0
    let result = await tick(task.id);
    expect(result.done).toBe(false);

    // Step 0 should have been executed (not blocked)
    const step0 = _steps.find(s => s.task_id === task.id && s.step_index === 0);
    expect(step0.status).toBe(STEP_STATES.SUCCEEDED);

    // Run tick for step 1
    result = await tick(task.id);
    const step1 = _steps.find(s => s.task_id === task.id && s.step_index === 1);
    expect(step1.status).toBe(STEP_STATES.SUCCEEDED);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. tick loop detects all-steps-review_hold → diagnosis
// ═══════════════════════════════════════════════════════════════════════════

describe('All-steps-held diagnosis', () => {
  it('calls _diagnoseAllHeld when all steps are in review_hold', async () => {
    const { task } = setupTaskWithSteps(2);

    // Manually set all steps to review_hold (simulating capability gate blocked them)
    _steps.filter(s => s.task_id === task.id).forEach(s => {
      s.status = STEP_STATES.REVIEW_HOLD;
      s.error_message = 'Capability "planning" requires approval (A1 < A3)';
    });

    const result = await tick(task.id);

    // Should detect all held and return done with all_held flag
    expect(result.done).toBe(true);
    expect(result.all_held).toBe(true);

    // Should have called diagnoseStepFailure for the summary
    expect(diagnoseStepFailure).toHaveBeenCalled();

    // Should have emitted AGENT_STEP_BLOCKED with all_steps_held event
    const blockedCalls = eventBus.emit.mock.calls.filter(
      c => c[0] === 'agent:step_blocked'
    );
    const allHeldEvent = blockedCalls.find(
      c => c[1]?.event_type === 'all_steps_held'
    );
    expect(allHeldEvent).toBeTruthy();
    expect(allHeldEvent[1].held_count).toBe(2);
    expect(allHeldEvent[1].diagnosis).toBeTruthy();
  });

  it('does NOT call _completeTask when steps are in review_hold', async () => {
    const { task } = setupTaskWithSteps(2);

    // Set all to review_hold
    _steps.filter(s => s.task_id === task.id).forEach(s => {
      s.status = STEP_STATES.REVIEW_HOLD;
    });

    await tick(task.id);

    // Task should NOT be transitioned to 'done'
    expect(_tasks[task.id].status).not.toBe(TASK_STATES.DONE);

    // TASK_COMPLETED should NOT have been emitted
    const completedCalls = eventBus.emit.mock.calls.filter(
      c => c[0] === 'task:completed'
    );
    expect(completedCalls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. _completeTask safety: only when all steps are terminal
// ═══════════════════════════════════════════════════════════════════════════

describe('completeTask safety guards', () => {
  it('completes task when all steps are succeeded', async () => {
    const { task } = setupTaskWithSteps(2, {
      input_context: { _plan_approved_by: 'user-1' },
    });

    // Run ticks until done
    let done = false;
    let iterations = 0;
    while (!done && iterations < 10) {
      const result = await tick(task.id);
      done = result.done;
      iterations++;
    }

    // All steps succeeded
    const taskSteps = _steps.filter(s => s.task_id === task.id);
    expect(taskSteps.every(s => s.status === STEP_STATES.SUCCEEDED)).toBe(true);

    // Task should be done
    expect(_tasks[task.id].status).toBe(TASK_STATES.DONE);

    // TASK_COMPLETED should have been emitted
    const completedCalls = eventBus.emit.mock.calls.filter(
      c => c[0] === 'task:completed'
    );
    expect(completedCalls.length).toBeGreaterThan(0);
  });

  it('does NOT complete task when steps are still pending (DB query mismatch)', async () => {
    const { task } = setupTaskWithSteps(2);

    // Simulate getNextPendingStep returning null even though steps are pending
    stepRepo.getNextPendingStep.mockResolvedValueOnce(null);

    const result = await tick(task.id);

    // Should detect pending steps via fallback and execute them
    // OR return done with error — but NOT call _completeTask
    expect(_tasks[task.id].status).not.toBe(TASK_STATES.DONE);
  });

  it('does NOT complete task when no step rows exist in DB', async () => {
    const task = makeTask({
      status: TASK_STATES.IN_PROGRESS,
      plan_snapshot: { steps: [{ name: 's1', tool_type: 'builtin_tool' }] },
    });
    // Do NOT create any step rows

    const result = await tick(task.id);

    expect(result.done).toBe(true);
    expect(result.error).toContain('No step rows found');
    expect(_tasks[task.id].status).not.toBe(TASK_STATES.DONE);
  });

  it('does NOT complete task when steps are in non-terminal states (e.g. failed)', async () => {
    const { task } = setupTaskWithSteps(2);

    // Set one step to succeeded, one to failed (non-terminal for our purposes, but
    // getNextPendingStep won't return failed steps)
    _steps.filter(s => s.task_id === task.id)[0].status = STEP_STATES.SUCCEEDED;
    _steps.filter(s => s.task_id === task.id)[1].status = STEP_STATES.FAILED;

    const result = await tick(task.id);

    // failed is not terminal (only succeeded/skipped are), so should NOT complete
    expect(_tasks[task.id].status).not.toBe(TASK_STATES.DONE);
    expect(result.error).toBeTruthy();
  });

  it('completes task when steps are mix of succeeded and skipped', async () => {
    const { task } = setupTaskWithSteps(2);

    _steps.filter(s => s.task_id === task.id)[0].status = STEP_STATES.SUCCEEDED;
    _steps.filter(s => s.task_id === task.id)[1].status = STEP_STATES.SKIPPED;

    const result = await tick(task.id);

    expect(result.done).toBe(true);
    expect(_tasks[task.id].status).toBe(TASK_STATES.DONE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. approveReview unblocks review_hold steps
// ═══════════════════════════════════════════════════════════════════════════

describe('approveReview unblocks steps', () => {
  it('transitions all review_hold steps back to pending on approve', async () => {
    const { task } = setupTaskWithSteps(3);

    // Set task to review_hold and all steps to review_hold
    _tasks[task.id].status = TASK_STATES.REVIEW_HOLD;
    _steps.filter(s => s.task_id === task.id).forEach(s => {
      s.status = STEP_STATES.REVIEW_HOLD;
      s.error_message = 'Capability blocked';
    });

    await approveReview(task.id, 'user-1', { decision: 'approve' });

    // All steps should be back to pending
    const taskSteps = _steps.filter(s => s.task_id === task.id);
    expect(taskSteps.every(s => s.status === STEP_STATES.PENDING)).toBe(true);

    // Error messages should be cleared
    expect(taskSteps.every(s => s.error_message === null)).toBe(true);

    // _plan_approved_by should be set
    expect(taskRepo.updateTaskInputContext).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ _plan_approved_by: 'user-1' }),
      expect.any(Number),
    );
  });

  it('does NOT unblock steps on rejection — task transitions to failed', async () => {
    const { task } = setupTaskWithSteps(2);

    _tasks[task.id].status = TASK_STATES.REVIEW_HOLD;
    _steps.filter(s => s.task_id === task.id).forEach(s => {
      s.status = STEP_STATES.REVIEW_HOLD;
    });

    await approveReview(task.id, 'user-1', { decision: 'rejected' });

    // Task should be failed (rejection → REVIEW_REJECTED → FAILED)
    expect(_tasks[task.id].status).toBe(TASK_STATES.FAILED);

    // TASK_FAILED event should have been emitted
    const failedCalls = eventBus.emit.mock.calls.filter(c => c[0] === 'task:failed');
    expect(failedCalls.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Full flow: submit → approve → tick → complete
// ═══════════════════════════════════════════════════════════════════════════

describe('Full orchestrator flow', () => {
  it('submit → approve → tick → all steps succeed → task done', async () => {
    // Submit a plan
    const plan = {
      title: 'Forecast + Plan',
      description: 'Run forecast and plan',
      steps: [
        { name: 'run_forecast', tool_type: 'builtin_tool', builtin_tool_id: 'run_forecast' },
        { name: 'run_plan', tool_type: 'builtin_tool', builtin_tool_id: 'run_plan' },
      ],
      inputData: { userId: 'user-1' },
      llmConfig: {},
    };

    const { taskId } = await submitPlan(plan, 'emp-1', 'user-1');
    expect(_tasks[taskId]).toBeTruthy();
    expect(_tasks[taskId].status).toBe(TASK_STATES.WAITING_APPROVAL);

    // Approve — this starts the tick loop
    // We need to prevent the tick loop from actually running to control manually
    const { isRalphLoopEnabled } = await import('./ralphLoopAdapter.js');
    isRalphLoopEnabled.mockReturnValue(false);

    // Instead of calling approvePlan (which runs the full tick loop),
    // manually transition and test tick() individually
    _tasks[taskId].status = TASK_STATES.IN_PROGRESS;
    _tasks[taskId].input_context._plan_approved_by = 'user-1';

    // Tick step 0
    let result = await tick(taskId);
    expect(result.done).toBe(false);
    const step0 = _steps.find(s => s.task_id === taskId && s.step_index === 0);
    expect(step0.status).toBe(STEP_STATES.SUCCEEDED);

    // Tick step 1
    result = await tick(taskId);
    expect(result.done).toBe(false);
    const step1 = _steps.find(s => s.task_id === taskId && s.step_index === 1);
    expect(step1.status).toBe(STEP_STATES.SUCCEEDED);

    // Tick again → should complete
    result = await tick(taskId);
    expect(result.done).toBe(true);
    expect(_tasks[taskId].status).toBe(TASK_STATES.DONE);
  });

  it('submit → approve → capability gate blocks → approveReview → steps execute', async () => {
    // Submit a plan
    const plan = {
      title: 'Blocked then unblocked',
      description: 'Test review flow',
      steps: [
        { name: 'step_0', tool_type: 'builtin_tool', builtin_tool_id: 'run_forecast' },
      ],
      inputData: {},
      llmConfig: {},
    };

    const { taskId } = await submitPlan(plan, 'emp-1', 'user-1');

    // Manually transition to in_progress (without _plan_approved_by)
    _tasks[taskId].status = TASK_STATES.IN_PROGRESS;

    // Tick → should be blocked by capability gate
    let result = await tick(taskId);
    const step0 = _steps.find(s => s.task_id === taskId && s.step_index === 0);
    expect(step0.status).toBe(STEP_STATES.REVIEW_HOLD);

    // Manager approves the review → should unblock
    _tasks[taskId].status = TASK_STATES.REVIEW_HOLD;
    await approveReview(taskId, 'user-1', { decision: 'approve' });

    // Step should be back to pending
    expect(step0.status).toBe(STEP_STATES.PENDING);

    // Task should be back to in_progress
    expect(_tasks[taskId].status).toBe(TASK_STATES.IN_PROGRESS);

    // _plan_approved_by should be set now
    const latestTask = _tasks[taskId];
    expect(latestTask.input_context._plan_approved_by).toBe('user-1');

    // Tick again — should succeed this time (plan approved bypasses gate)
    result = await tick(taskId);
    expect(step0.status).toBe(STEP_STATES.SUCCEEDED);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Step execution with failed executor
// ═══════════════════════════════════════════════════════════════════════════

describe('Step execution error handling', () => {
  it('fails step and task when executor throws and healing strategy is block_immediately', async () => {
    getExecutor.mockReturnValue(async () => {
      throw new Error('Module not found: forecast engine');
    });

    const { task } = setupTaskWithSteps(1, {
      input_context: { _plan_approved_by: 'user-1' },
    });

    const result = await tick(task.id);

    // tick returns { done: false, stepResult: { ok: false, ... } }
    expect(result.stepResult?.ok).toBe(false);
    const step0 = _steps.find(s => s.task_id === task.id && s.step_index === 0);
    expect(step0.status).toBe(STEP_STATES.FAILED);
    expect(_tasks[task.id].status).toBe(TASK_STATES.FAILED);
  });

  it('handles executor returning ok=false', async () => {
    getExecutor.mockReturnValue(async () => ({
      ok: false,
      artifacts: [],
      logs: [],
      error: 'Missing dataset',
    }));

    const { task } = setupTaskWithSteps(1, {
      input_context: { _plan_approved_by: 'user-1' },
    });

    const result = await tick(task.id);

    expect(result.stepResult?.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. getTaskStatus correctness
// ═══════════════════════════════════════════════════════════════════════════

describe('getTaskStatus', () => {
  it('returns correct step counts and completion state', async () => {
    const { task } = setupTaskWithSteps(3);
    _steps.filter(s => s.task_id === task.id)[0].status = STEP_STATES.SUCCEEDED;
    _steps.filter(s => s.task_id === task.id)[1].status = STEP_STATES.RUNNING;
    _steps.filter(s => s.task_id === task.id)[2].status = STEP_STATES.PENDING;

    const status = await getTaskStatus(task.id);

    expect(status.stepsTotal).toBe(3);
    expect(status.stepsCompleted).toBe(1); // only succeeded counts as terminal
    expect(status.isComplete).toBe(false); // task is in_progress, not terminal
    expect(status.steps).toHaveLength(3);
  });

  it('isComplete is true when task is in done state', async () => {
    const { task } = setupTaskWithSteps(1);
    _tasks[task.id].status = TASK_STATES.DONE;
    _steps.filter(s => s.task_id === task.id)[0].status = STEP_STATES.SUCCEEDED;

    const status = await getTaskStatus(task.id);

    expect(status.isComplete).toBe(true);
  });
});
