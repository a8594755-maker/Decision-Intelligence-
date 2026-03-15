import * as aiEmployeeService from './aiEmployeeService.js';
import { approvePlan } from './aiEmployee/index.js';
import { eventBus, EVENT_NAMES } from './eventBus.js';
import { shouldAutoRun } from './aiEmployee/executionPolicy.js';
import {
  getDueTasks,
  getSchedule,
  getSchedules,
  instantiateScheduledTask,
  activateEventTrigger,
  deactivateEventTrigger,
  listEventTriggers,
} from './scheduledTaskService.js';

const DEFAULT_POLL_INTERVAL_MS = 30000;
const GLOBAL_INFLIGHT_SCHEDULE_IDS = new Set();

let activeRuntime = null;

function isEventTriggerSchedule(schedule) {
  return Boolean(schedule?.schedule_type?.startsWith('on_file_'));
}

async function syncEventTriggers(employeeId) {
  const schedules = await getSchedules(employeeId);
  const activeEventSchedules = schedules.filter((schedule) => (
    schedule.status === 'active' && isEventTriggerSchedule(schedule)
  ));
  const activeIds = new Set(activeEventSchedules.map((schedule) => schedule.id));

  for (const { scheduleId } of listEventTriggers()) {
    if (!activeIds.has(scheduleId)) {
      deactivateEventTrigger(scheduleId);
    }
  }

  for (const schedule of activeEventSchedules) {
    activateEventTrigger(schedule);
  }

  return activeEventSchedules;
}

async function instantiateIfNeeded(schedule, userId, options = {}) {
  if (!schedule?.id || GLOBAL_INFLIGHT_SCHEDULE_IDS.has(schedule.id)) {
    return null;
  }

  GLOBAL_INFLIGHT_SCHEDULE_IDS.add(schedule.id);
  try {
    const task = await instantiateScheduledTask(schedule, userId, options);
    if (task?.id && task.status === 'waiting_approval' && shouldAutoRun(task.input_context?.execution_mode)) {
      await approvePlan(task.id, userId);
      return { ...task, status: 'queued' };
    }
    return task;
  } finally {
    GLOBAL_INFLIGHT_SCHEDULE_IDS.delete(schedule.id);
  }
}

export async function startAiEmployeeRuntime({
  userId,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  if (!userId) return null;

  if (activeRuntime?.userId === userId) {
    return activeRuntime;
  }

  stopAiEmployeeRuntime();

  const runtime = {
    userId,
    employeeId: null,
    pollIntervalMs,
    intervalId: null,
    triggerUnsubscribe: null,
    stopped: false,
  };
  activeRuntime = runtime;

  const employee = await aiEmployeeService.getOrCreateAiden(userId);
  if (runtime.stopped) return null;
  runtime.employeeId = employee.id;

  const processDueSchedules = async () => {
    if (runtime.stopped || !runtime.employeeId) return;

    try {
      await syncEventTriggers(runtime.employeeId);

      const dueSchedules = await getDueTasks({ employeeId: runtime.employeeId });
      for (const schedule of dueSchedules) {
        try {
          await instantiateIfNeeded(schedule, userId);
        } catch (err) {
          console.warn('[aiEmployeeRuntimeService] Failed to instantiate due schedule:', schedule.id, err?.message);
        }
      }
    } catch (err) {
      console.warn('[aiEmployeeRuntimeService] Due schedule poll failed:', err?.message);
    }
  };

  runtime.triggerUnsubscribe = eventBus.on(EVENT_NAMES.TRIGGER_FIRED, async (payload) => {
    if (runtime.stopped || !payload?.scheduleId) return;

    try {
      const schedule = await getSchedule(payload.scheduleId);
      if (!schedule || schedule.employee_id !== runtime.employeeId || schedule.status !== 'active') {
        return;
      }
      await instantiateIfNeeded(schedule, userId, { triggerPayload: payload.triggerPayload || null });
    } catch (err) {
      console.warn('[aiEmployeeRuntimeService] Trigger execution failed:', payload.scheduleId, err?.message);
    }
  });

  await processDueSchedules();

  runtime.intervalId = setInterval(() => {
    void processDueSchedules();
  }, pollIntervalMs);

  return runtime;
}

export function stopAiEmployeeRuntime() {
  if (!activeRuntime) return;

  activeRuntime.stopped = true;
  if (activeRuntime.intervalId) {
    clearInterval(activeRuntime.intervalId);
  }
  if (activeRuntime.triggerUnsubscribe) {
    activeRuntime.triggerUnsubscribe();
  }

  activeRuntime = null;
}

export function getAiEmployeeRuntimeState() {
  if (!activeRuntime) return null;

  return {
    userId: activeRuntime.userId,
    employeeId: activeRuntime.employeeId,
    pollIntervalMs: activeRuntime.pollIntervalMs,
    activeEventTriggers: listEventTriggers(),
    inflightSchedules: Array.from(GLOBAL_INFLIGHT_SCHEDULE_IDS),
  };
}

export default {
  startAiEmployeeRuntime,
  stopAiEmployeeRuntime,
  getAiEmployeeRuntimeState,
};
