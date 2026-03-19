// @product: ai-employee
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('./supabaseClient', () => ({ supabase: null }));

vi.mock('./aiEmployee/queries.js', () => ({
  listTasks: vi.fn(async () => []),
  getKpis: vi.fn(async () => ({
    employee_id: 'emp-1',
    tasks_completed: 10,
    tasks_open: 3,
    tasks_overdue: 1,
    on_time_rate_pct: 85,
    reviews_approved: 8,
    reviews_revised: 2,
    review_pass_rate_pct: 80,
  })),
  appendWorklog: vi.fn(async () => ({})),
  listWorklogs: vi.fn(async () => []),
}));

vi.mock('./modelRoutingService', () => ({
  getEmployeeCostSummary: vi.fn(async () => ({
    total_cost: 0.12,
    total_calls: 5,
    by_tier: { tier_c: { cost: 0.08, calls: 4 }, tier_a: { cost: 0.04, calls: 1 } },
  })),
}));

import { generateDailySummary, getLatestSummary } from './dailySummaryService';
import * as queries from './aiEmployee/queries.js';
import { getEmployeeCostSummary } from './modelRoutingService';

const TODAY = new Date();
const TODAY_STR = TODAY.toISOString().slice(0, 10);

function makeTask(overrides = {}) {
  return {
    id: `task-${Math.random().toString(36).slice(2, 6)}`,
    employee_id: 'emp-1',
    status: 'done',
    created_at: TODAY.toISOString(),
    updated_at: TODAY.toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── generateDailySummary ─────────────────────────────────────────────────────

describe('generateDailySummary', () => {
  it('returns empty summary when no tasks exist', async () => {
    const summary = await generateDailySummary('emp-1');
    expect(summary.date).toBe(TODAY_STR);
    expect(summary.employee_id).toBe('emp-1');
    expect(summary.tasks_completed).toBe(0);
    expect(summary.tasks_failed).toBe(0);
    expect(summary.total_tasks_today).toBe(0);
    expect(summary.generated_at).toBeTruthy();
  });

  it('counts tasks by status', async () => {
    queries.listTasks.mockResolvedValueOnce([
      makeTask({ status: 'done' }),
      makeTask({ status: 'done' }),
      makeTask({ status: 'blocked' }),
      makeTask({ status: 'in_progress' }),
      makeTask({ status: 'review_hold' }),
    ]);

    const summary = await generateDailySummary('emp-1');
    expect(summary.tasks_completed).toBe(2);
    expect(summary.tasks_failed).toBe(1);
    expect(summary.tasks_in_progress).toBe(1);
    expect(summary.tasks_waiting_review).toBe(1);
    expect(summary.total_tasks_today).toBe(5);
  });

  it('includes cost data', async () => {
    const summary = await generateDailySummary('emp-1');
    expect(summary.total_cost).toBe(0.12);
    expect(summary.total_calls).toBe(5);
    expect(summary.cost_by_tier).toEqual({
      tier_c: { cost: 0.08, calls: 4 },
      tier_a: { cost: 0.04, calls: 1 },
    });
  });

  it('includes KPI snapshot', async () => {
    const summary = await generateDailySummary('emp-1');
    expect(summary.kpi_snapshot).toBeTruthy();
    expect(summary.kpi_snapshot.on_time_rate).toBe(85);
    expect(summary.kpi_snapshot.review_pass_rate).toBe(80);
    expect(summary.kpi_snapshot.tasks_completed_all_time).toBe(10);
  });

  it('generates highlights for completed tasks', async () => {
    queries.listTasks.mockResolvedValueOnce([
      makeTask({ status: 'done' }),
      makeTask({ status: 'done' }),
    ]);

    const summary = await generateDailySummary('emp-1');
    expect(summary.highlights.some((h) => h.includes('2 task(s) completed'))).toBe(true);
  });

  it('generates issues for failed tasks', async () => {
    queries.listTasks.mockResolvedValueOnce([
      makeTask({ status: 'blocked' }),
      makeTask({ status: 'blocked' }),
    ]);

    const summary = await generateDailySummary('emp-1');
    expect(summary.issues.some((i) => i.includes('2 task(s) blocked'))).toBe(true);
  });

  it('flags high cost', async () => {
    getEmployeeCostSummary.mockResolvedValueOnce({
      total_cost: 0.75,
      total_calls: 20,
      by_tier: {},
    });

    const summary = await generateDailySummary('emp-1');
    expect(summary.issues.some((i) => i.includes('Daily cost'))).toBe(true);
  });

  it('flags low review pass rate', async () => {
    queries.getKpis.mockResolvedValueOnce({
      employee_id: 'emp-1',
      tasks_completed: 5,
      tasks_open: 2,
      on_time_rate_pct: 90,
      review_pass_rate_pct: 50,
      reviews_approved: 2,
      reviews_revised: 2,
    });

    const summary = await generateDailySummary('emp-1');
    expect(summary.issues.some((i) => i.includes('Review pass rate is 50%'))).toBe(true);
  });

  it('writes worklog entry', async () => {
    await generateDailySummary('emp-1');
    expect(queries.appendWorklog).toHaveBeenCalledWith(
      'emp-1',
      null,
      null,
      'daily_summary',
      expect.objectContaining({ date: TODAY_STR })
    );
  });

  it('survives cost service failure', async () => {
    getEmployeeCostSummary.mockRejectedValueOnce(new Error('fail'));
    const summary = await generateDailySummary('emp-1');
    expect(summary.total_cost).toBe(0);
  });

  it('survives KPI service failure', async () => {
    queries.getKpis.mockRejectedValueOnce(new Error('fail'));
    const summary = await generateDailySummary('emp-1');
    expect(summary.kpi_snapshot).toBeNull();
  });

  it('filters tasks by reference date', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    queries.listTasks.mockResolvedValueOnce([
      makeTask({ status: 'done', updated_at: yesterday.toISOString(), created_at: yesterday.toISOString() }),
      makeTask({ status: 'done' }), // today
    ]);

    const summary = await generateDailySummary('emp-1');
    // Only today's task should be counted
    expect(summary.tasks_completed).toBe(1);
  });
});

// ── getLatestSummary ─────────────────────────────────────────────────────────

describe('getLatestSummary', () => {
  it('returns null when no summaries exist', async () => {
    const result = await getLatestSummary('emp-1');
    expect(result).toBeNull();
  });

  it('returns the latest daily_summary worklog content', async () => {
    queries.listWorklogs.mockResolvedValueOnce([
      { log_type: 'task_update', content: { note: 'task done' } },
      { log_type: 'daily_summary', content: { date: '2026-03-13', tasks_completed: 5 } },
    ]);

    const result = await getLatestSummary('emp-1');
    expect(result.date).toBe('2026-03-13');
    expect(result.tasks_completed).toBe(5);
  });
});
