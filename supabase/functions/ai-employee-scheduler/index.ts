// ============================================
// AI Employee Scheduler Edge Function
// @product: ai-employee
// ============================================
// Purpose: Automated execution of scheduled AI Employee tasks,
//          daily summary generation, and proactive task creation.
//
// Schedules:
//   - Every hour: execute due scheduled tasks
//   - Daily 08:00 UTC: generate daily summaries + proactive tasks
//
// Also exposes HTTP POST for manual trigger.
// ============================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const HOURLY_CRON = Deno.env.get('AI_EMPLOYEE_HOURLY_CRON') || '0 * * * *';
const DAILY_CRON = Deno.env.get('AI_EMPLOYEE_DAILY_CRON') || '0 8 * * *';

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScheduleRow {
  id: string;
  employee_id: string;
  task_template: {
    title?: string;
    template_id?: string;
    workflow_type?: string;
    input_context?: Record<string, unknown>;
    priority?: string;
  };
  schedule_type: string;
  hour: number;
  day_of_week: number | null;
  day_of_month: number | null;
  status: string;
  next_run_at: string;
}

interface RunResult {
  schedule_id: string;
  employee_id: string;
  status: 'success' | 'error';
  task_id?: string;
  detail?: string;
  duration_ms: number;
}

// ── Scheduled task execution ──────────────────────────────────────────────────

async function executeDueSchedules(): Promise<RunResult[]> {
  const supabase = getSupabase();
  const now = new Date().toISOString();

  console.log(`[AI-EMPLOYEE-SCHEDULER] Checking due schedules at ${now}`);

  // 1. Query due schedules
  const { data: dueSchedules, error } = await supabase
    .from('ai_employee_schedules')
    .select('*')
    .eq('status', 'active')
    .lte('next_run_at', now)
    .order('next_run_at');

  if (error) {
    console.error('[AI-EMPLOYEE-SCHEDULER] Failed to query schedules:', error.message);
    return [];
  }

  if (!dueSchedules || dueSchedules.length === 0) {
    console.log('[AI-EMPLOYEE-SCHEDULER] No due schedules.');
    return [];
  }

  console.log(`[AI-EMPLOYEE-SCHEDULER] Found ${dueSchedules.length} due schedule(s).`);
  const results: RunResult[] = [];

  for (const schedule of dueSchedules as ScheduleRow[]) {
    const start = Date.now();
    try {
      // 2. Create task from template
      const template = schedule.task_template;
      const { data: task, error: taskError } = await supabase
        .from('ai_employee_tasks')
        .insert({
          employee_id: schedule.employee_id,
          title: template.title || `Scheduled: ${template.template_id || template.workflow_type}`,
          description: `Auto-generated from schedule ${schedule.id}`,
          priority: template.priority || 'medium',
          status: 'todo',
          source_type: 'scheduled',
          template_id: template.template_id || null,
          input_context: {
            workflow_type: template.workflow_type || undefined,
            schedule_id: schedule.id,
            ...(template.input_context || {}),
          },
        })
        .select()
        .single();

      if (taskError) throw new Error(`createTask: ${taskError.message}`);

      // 3. Advance schedule
      const nextRun = computeNextRun(schedule);
      await supabase
        .from('ai_employee_schedules')
        .update({ last_run_at: now, next_run_at: nextRun })
        .eq('id', schedule.id);

      results.push({
        schedule_id: schedule.id,
        employee_id: schedule.employee_id,
        status: 'success',
        task_id: task.id,
        duration_ms: Date.now() - start,
      });

      console.log(`[AI-EMPLOYEE-SCHEDULER] Schedule ${schedule.id} → task ${task.id}`);
    } catch (err) {
      results.push({
        schedule_id: schedule.id,
        employee_id: schedule.employee_id,
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - start,
      });
      console.error(`[AI-EMPLOYEE-SCHEDULER] Schedule ${schedule.id} failed:`, err);
    }
  }

  return results;
}

// ── Daily summary + proactive tasks ───────────────────────────────────────────

async function runDailyJobs(): Promise<{ summaries: number; proactiveTasks: number }> {
  const supabase = getSupabase();
  const now = new Date().toISOString();
  const todayStr = now.slice(0, 10);

  console.log(`[AI-EMPLOYEE-SCHEDULER] Running daily jobs for ${todayStr}`);

  // 1. Get all active employees
  const { data: employees, error } = await supabase
    .from('ai_employees')
    .select('id, manager_user_id')
    .neq('status', 'inactive');

  if (error || !employees?.length) {
    console.log('[AI-EMPLOYEE-SCHEDULER] No active employees found.');
    return { summaries: 0, proactiveTasks: 0 };
  }

  let summaryCount = 0;
  let proactiveCount = 0;

  for (const emp of employees) {
    // ── Daily summary ─────────────────────────────────────────────────────
    try {
      // Gather today's tasks
      const { data: tasks } = await supabase
        .from('ai_employee_tasks')
        .select('*')
        .eq('employee_id', emp.id)
        .gte('updated_at', `${todayStr}T00:00:00Z`);

      const completed = (tasks || []).filter((t: { status: string }) => t.status === 'done').length;
      const failed = (tasks || []).filter((t: { status: string }) => t.status === 'blocked').length;
      const inProgress = (tasks || []).filter((t: { status: string }) => t.status === 'in_progress').length;

      const summary = {
        date: todayStr,
        employee_id: emp.id,
        tasks_completed: completed,
        tasks_failed: failed,
        tasks_in_progress: inProgress,
        total_tasks_today: (tasks || []).length,
        generated_at: now,
      };

      await supabase.from('ai_employee_worklogs').insert({
        employee_id: emp.id,
        log_type: 'daily_summary',
        content: summary,
      });

      // Notify manager
      if (emp.manager_user_id) {
        await supabase.from('ai_employee_notifications').insert({
          user_id: emp.manager_user_id,
          employee_id: emp.id,
          type: 'daily_summary_ready',
          title: `Daily summary: ${completed} completed, ${failed} failed`,
          body: summary,
        });
      }

      summaryCount++;
    } catch (err) {
      console.error(`[AI-EMPLOYEE-SCHEDULER] Summary for ${emp.id} failed:`, err);
    }

    // ── Proactive task check ──────────────────────────────────────────────
    // This is a lightweight version — the full proactiveTaskGenerator runs
    // client-side with risk score data. Here we just check for stale tasks.
    try {
      const { data: staleTasks } = await supabase
        .from('ai_employee_tasks')
        .select('id, title')
        .eq('employee_id', emp.id)
        .eq('status', 'blocked')
        .lt('updated_at', new Date(Date.now() - 24 * 3600000).toISOString())
        .limit(5);

      if (staleTasks?.length && emp.manager_user_id) {
        await supabase.from('ai_employee_notifications').insert({
          user_id: emp.manager_user_id,
          employee_id: emp.id,
          type: 'task_failed',
          title: `${staleTasks.length} task(s) blocked for >24h — needs attention`,
          body: { task_ids: staleTasks.map((t: { id: string }) => t.id) },
        });
        proactiveCount += staleTasks.length;
      }
    } catch (err) {
      console.error(`[AI-EMPLOYEE-SCHEDULER] Proactive check for ${emp.id} failed:`, err);
    }
  }

  console.log(`[AI-EMPLOYEE-SCHEDULER] Daily jobs done: ${summaryCount} summaries, ${proactiveCount} proactive alerts`);
  return { summaries: summaryCount, proactiveTasks: proactiveCount };
}

// ── Next-run computation (mirrors scheduledTaskService.computeNextRun) ────────

function computeNextRun(schedule: ScheduleRow): string {
  const base = new Date();
  const hour = schedule.hour ?? 8;

  switch (schedule.schedule_type) {
    case 'daily': {
      const next = new Date(base);
      next.setUTCHours(hour, 0, 0, 0);
      if (next <= base) next.setUTCDate(next.getUTCDate() + 1);
      return next.toISOString();
    }
    case 'weekly': {
      const dow = schedule.day_of_week ?? 1;
      const next = new Date(base);
      next.setUTCHours(hour, 0, 0, 0);
      const diff = (dow - next.getUTCDay() + 7) % 7 || 7;
      next.setUTCDate(next.getUTCDate() + diff);
      return next.toISOString();
    }
    case 'monthly': {
      const dom = schedule.day_of_month ?? 1;
      const next = new Date(base);
      next.setUTCHours(hour, 0, 0, 0);
      next.setUTCDate(dom);
      if (next <= base) next.setUTCMonth(next.getUTCMonth() + 1);
      return next.toISOString();
    }
    default: {
      const next = new Date(base.getTime() + 86400000);
      next.setUTCHours(hour, 0, 0, 0);
      return next.toISOString();
    }
  }
}

// ── Register cron jobs ────────────────────────────────────────────────────────

Deno.cron('ai-employee-hourly', HOURLY_CRON, async () => {
  await executeDueSchedules();
});

Deno.cron('ai-employee-daily', DAILY_CRON, async () => {
  await executeDueSchedules(); // catch any due schedules too
  await runDailyJobs();
});

// ── HTTP handler for manual trigger ───────────────────────────────────────────

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: { action?: string } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const action = body.action || 'all';

  let scheduleResults: RunResult[] = [];
  let dailyResults = { summaries: 0, proactiveTasks: 0 };

  if (action === 'schedules' || action === 'all') {
    scheduleResults = await executeDueSchedules();
  }
  if (action === 'daily' || action === 'all') {
    dailyResults = await runDailyJobs();
  }

  return new Response(
    JSON.stringify({
      success: true,
      action,
      schedules: {
        executed: scheduleResults.length,
        succeeded: scheduleResults.filter(r => r.status === 'success').length,
        failed: scheduleResults.filter(r => r.status === 'error').length,
        results: scheduleResults,
      },
      daily: dailyResults,
      triggered_at: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    },
  );
});
