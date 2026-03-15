// @product: ai-employee
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('./supabaseClient', () => ({ supabase: null }));

const mockBuildPlan = vi.fn(async ({ title, description, priority, inputContext, executionMode }) => ({
  title,
  description,
  priority,
  taskMeta: { ...inputContext, execution_mode: executionMode || inputContext?.execution_mode || 'manual_approve' },
  steps: [{ name: 'forecast', tool_type: 'builtin_tool', builtin_tool_id: 'run_forecast' }],
}));

const mockSubmitPlan = vi.fn(async (plan, employeeId) => ({
  id: `task-${Math.random().toString(36).slice(2, 6)}`,
  taskId: `task-${Math.random().toString(36).slice(2, 6)}`,
  task: {
    id: `task-${Math.random().toString(36).slice(2, 6)}`,
    employee_id: employeeId,
    status: 'waiting_approval',
    title: plan.title,
    description: plan.description,
    priority: plan.priority,
    input_context: plan.taskMeta,
    plan_snapshot: { steps: plan.steps },
  },
}));
const mockApprovePlan = vi.fn(async () => undefined);

const mockListTasks = vi.fn(async () => []);

vi.mock('./aiEmployeeService', () => ({
  listTasks: (...args) => mockListTasks(...args),
}));

vi.mock('./aiEmployee/index.js', () => ({
  approvePlan: (...args) => mockApprovePlan(...args),
  submitPlan: (...args) => mockSubmitPlan(...args),
}));

vi.mock('./aiEmployee/templatePlanAdapter.js', () => ({
  buildPlanFromTaskTemplate: (...args) => mockBuildPlan(...args),
}));

import { ALERT_TASK_MAP, alertToTask, evaluateAndCreateTasks } from './proactiveTaskGenerator';

// ── Test data ────────────────────────────────────────────────────────────────

function makeAlert(type, overrides = {}) {
  return {
    alert_id: `alert-${type}-${Date.now()}`,
    alert_type: type,
    severity: 'high',
    material_code: 'MAT-001',
    plant_id: 'PLT-01',
    supplier: 'SUP-A',
    title: `Test alert: ${type}`,
    message: `Alert message for ${type}`,
    impact_score: 5000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── ALERT_TASK_MAP ───────────────────────────────────────────────────────────

describe('ALERT_TASK_MAP', () => {
  it('maps all 4 alert types', () => {
    expect(ALERT_TASK_MAP.stockout_risk).toBeTruthy();
    expect(ALERT_TASK_MAP.supplier_delay).toBeTruthy();
    expect(ALERT_TASK_MAP.dual_source_rec).toBeTruthy();
    expect(ALERT_TASK_MAP.expedite_rec).toBeTruthy();
  });

  it('stockout_risk uses risk_aware_plan template', () => {
    expect(ALERT_TASK_MAP.stockout_risk.template_id).toBe('risk_aware_plan');
    expect(ALERT_TASK_MAP.stockout_risk.priority).toBe('urgent');
    expect(ALERT_TASK_MAP.stockout_risk.execution_mode).toBe('auto_run');
  });

  it('expedite_rec uses forecast_then_plan template', () => {
    expect(ALERT_TASK_MAP.expedite_rec.template_id).toBe('forecast_then_plan');
  });

  it('supplier_delay uses risk workflow', () => {
    expect(ALERT_TASK_MAP.supplier_delay.workflow_type).toBe('risk');
    expect(ALERT_TASK_MAP.supplier_delay.template_id).toBeNull();
  });
});

// ── alertToTask ──────────────────────────────────────────────────────────────

describe('alertToTask', () => {
  it('converts stockout_risk alert to task params', () => {
    const alert = makeAlert('stockout_risk');
    const result = alertToTask(alert, 'emp-1');
    expect(result).toBeTruthy();
    expect(result.title).toContain('Stockout mitigation');
    expect(result.title).toContain('MAT-001');
    expect(result.priority).toBe('urgent');
    expect(result.execution_mode).toBe('auto_run');
    expect(result.template_id).toBe('risk_aware_plan');
    expect(result.input_context.alert_id).toBe(alert.alert_id);
    expect(result.source_type).toBe('scheduled');
  });

  it('converts supplier_delay alert', () => {
    const result = alertToTask(makeAlert('supplier_delay'), 'emp-1');
    expect(result.priority).toBe('high');
    expect(result.input_context.workflow_type).toBe('risk');
  });

  it('converts dual_source_rec alert', () => {
    const result = alertToTask(makeAlert('dual_source_rec'), 'emp-1');
    expect(result.priority).toBe('medium');
    expect(result.input_context.workflow_type).toBe('plan');
  });

  it('converts expedite_rec alert', () => {
    const result = alertToTask(makeAlert('expedite_rec'), 'emp-1');
    expect(result.title).toContain('Expedite planning');
    expect(result.template_id).toBe('forecast_then_plan');
  });

  it('returns null for unknown alert type', () => {
    const result = alertToTask(makeAlert('unknown_type'), 'emp-1');
    expect(result).toBeNull();
  });

  it('preserves alert metadata in input_context', () => {
    const alert = makeAlert('stockout_risk', {
      severity: 'critical',
      impact_score: 12000,
    });
    const result = alertToTask(alert, 'emp-1');
    expect(result.input_context.severity).toBe('critical');
    expect(result.input_context.impact_score).toBe(12000);
    expect(result.input_context.material_code).toBe('MAT-001');
    expect(result.input_context.plant_id).toBe('PLT-01');
  });
});

// ── evaluateAndCreateTasks ───────────────────────────────────────────────────

describe('evaluateAndCreateTasks', () => {
  it('returns empty result for no alerts', async () => {
    const result = await evaluateAndCreateTasks('emp-1', 'user-1', []);
    expect(result.created).toEqual([]);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('creates tasks for valid alerts', async () => {
    const alerts = [makeAlert('stockout_risk'), makeAlert('supplier_delay')];
    const result = await evaluateAndCreateTasks('emp-1', 'user-1', alerts);
    expect(result.created.length).toBe(2);
    expect(result.skipped).toBe(0);
    expect(mockBuildPlan).toHaveBeenCalledTimes(2);
    expect(mockSubmitPlan).toHaveBeenCalledTimes(2);
    expect(mockApprovePlan).toHaveBeenCalledTimes(2);
  });

  it('skips unknown alert types', async () => {
    const alerts = [makeAlert('unknown_type')];
    const result = await evaluateAndCreateTasks('emp-1', 'user-1', alerts);
    expect(result.created.length).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockSubmitPlan).not.toHaveBeenCalled();
  });

  it('deduplicates: skips alerts with existing pending tasks', async () => {
    const alert = makeAlert('stockout_risk', { alert_id: 'existing-alert-1' });

    mockListTasks.mockResolvedValueOnce([
      {
        id: 'task-existing',
        employee_id: 'emp-1',
        status: 'in_progress',
        input_context: { alert_id: 'existing-alert-1' },
      },
    ]);

    const result = await evaluateAndCreateTasks('emp-1', 'user-1', [alert]);
    expect(result.created.length).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('does not skip alerts whose tasks are done', async () => {
    const alert = makeAlert('stockout_risk', { alert_id: 'done-alert-1' });

    mockListTasks.mockResolvedValueOnce([
      {
        id: 'task-done',
        employee_id: 'emp-1',
        status: 'done',
        input_context: { alert_id: 'done-alert-1' },
      },
    ]);

    const result = await evaluateAndCreateTasks('emp-1', 'user-1', [alert]);
    expect(result.created.length).toBe(1);
  });

  it('counts errors when submitPlan fails', async () => {
    mockSubmitPlan.mockRejectedValueOnce(new Error('DB error'));

    const result = await evaluateAndCreateTasks('emp-1', 'user-1', [makeAlert('stockout_risk')]);
    expect(result.created.length).toBe(0);
    expect(result.errors).toBe(1);
  });

  it('passes correct params to buildPlan and submitPlan', async () => {
    const alert = makeAlert('supplier_delay');
    await evaluateAndCreateTasks('emp-1', 'user-1', [alert]);

    expect(mockBuildPlan).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('Supplier delay'),
      priority: 'high',
      executionMode: 'auto_run',
      sourceType: 'scheduled',
      userId: 'user-1',
      inputContext: expect.objectContaining({
        alert_id: alert.alert_id,
        alert_type: 'supplier_delay',
        workflow_type: 'risk',
      }),
    }));

    expect(mockSubmitPlan).toHaveBeenCalledWith(expect.any(Object), 'emp-1', 'user-1');
    expect(mockApprovePlan).toHaveBeenCalledWith(expect.any(String), 'user-1');
  });
});
