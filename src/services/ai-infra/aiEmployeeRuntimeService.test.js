import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { eventBus, EVENT_NAMES } from '../governance/eventBus.js';

const mockGetOrCreateWorker = vi.fn();
const mockGetDueTasks = vi.fn();
const mockGetSchedule = vi.fn();
const mockGetSchedules = vi.fn();
const mockInstantiateScheduledTask = vi.fn();
const mockActivateEventTrigger = vi.fn();
const mockDeactivateEventTrigger = vi.fn();
const mockListEventTriggers = vi.fn();
const mockApprovePlan = vi.fn();

vi.mock('./aiEmployee/queries.js', () => ({
  getOrCreateWorker: (...args) => mockGetOrCreateWorker(...args),
}));

vi.mock('./scheduledTaskService.js', () => ({
  getDueTasks: (...args) => mockGetDueTasks(...args),
  getSchedule: (...args) => mockGetSchedule(...args),
  getSchedules: (...args) => mockGetSchedules(...args),
  instantiateScheduledTask: (...args) => mockInstantiateScheduledTask(...args),
  activateEventTrigger: (...args) => mockActivateEventTrigger(...args),
  deactivateEventTrigger: (...args) => mockDeactivateEventTrigger(...args),
  listEventTriggers: (...args) => mockListEventTriggers(...args),
}));

vi.mock('./aiEmployee/index.js', () => ({
  approvePlan: (...args) => mockApprovePlan(...args),
}));

import {
  startAiEmployeeRuntime,
  stopAiEmployeeRuntime,
  getAiEmployeeRuntimeState,
} from './aiEmployeeRuntimeService.js';

describe('aiEmployeeRuntimeService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    eventBus.clear();
    mockGetOrCreateWorker.mockResolvedValue({ id: 'emp-1' });
    mockGetSchedules.mockResolvedValue([]);
    mockGetDueTasks.mockResolvedValue([]);
    mockGetSchedule.mockResolvedValue(null);
    mockInstantiateScheduledTask.mockResolvedValue({
      id: 'task-1',
      status: 'waiting_approval',
      input_context: { execution_mode: 'manual_approve' },
    });
    mockListEventTriggers.mockReturnValue([]);
    mockApprovePlan.mockResolvedValue(undefined);
  });

  afterEach(() => {
    stopAiEmployeeRuntime();
    eventBus.clear();
    vi.useRealTimers();
  });

  it('boots the runtime, activates event triggers, and polls due schedules', async () => {
    mockGetSchedules.mockResolvedValue([
      { id: 'sched-event', employee_id: 'emp-1', schedule_type: 'on_file_uploaded', status: 'active' },
      { id: 'sched-daily', employee_id: 'emp-1', schedule_type: 'daily', status: 'active' },
    ]);
    mockGetDueTasks.mockResolvedValue([
      { id: 'sched-daily', employee_id: 'emp-1', schedule_type: 'daily', status: 'active' },
    ]);

    await startAiEmployeeRuntime({ userId: 'user-1', pollIntervalMs: 1000 });

    expect(mockGetOrCreateWorker).toHaveBeenCalledWith('user-1');
    expect(mockActivateEventTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sched-event' })
    );
    expect(mockInstantiateScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sched-daily' }),
      'user-1',
      {}
    );
    expect(mockApprovePlan).not.toHaveBeenCalled();
    expect(getAiEmployeeRuntimeState()).toEqual(expect.objectContaining({
      userId: 'user-1',
      employeeId: 'emp-1',
    }));

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockGetDueTasks).toHaveBeenCalledWith({ employeeId: 'emp-1' });
  });

  it('instantiates a scheduled task when a trigger event fires', async () => {
    mockInstantiateScheduledTask.mockResolvedValueOnce({
      id: 'task-trigger',
      status: 'waiting_approval',
      input_context: { execution_mode: 'auto_run' },
    });
    mockGetSchedule.mockResolvedValue({
      id: 'sched-trigger',
      employee_id: 'emp-1',
      schedule_type: 'on_file_detected',
      status: 'active',
    });

    await startAiEmployeeRuntime({ userId: 'user-1', pollIntervalMs: 1000 });

    eventBus.emit(EVENT_NAMES.TRIGGER_FIRED, {
      scheduleId: 'sched-trigger',
      triggerPayload: { itemId: 'file-1' },
    });

    await vi.runAllTicks();
    await Promise.resolve();

    expect(mockInstantiateScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sched-trigger' }),
      'user-1',
      { triggerPayload: { itemId: 'file-1' } }
    );
    expect(mockApprovePlan).toHaveBeenCalledWith('task-trigger', 'user-1');
  });

  it('auto-approves due schedules marked auto_run', async () => {
    mockGetDueTasks.mockResolvedValue([
      { id: 'sched-auto', employee_id: 'emp-1', schedule_type: 'daily', status: 'active' },
    ]);
    mockInstantiateScheduledTask.mockResolvedValueOnce({
      id: 'task-auto',
      status: 'waiting_approval',
      input_context: { execution_mode: 'auto_run' },
    });

    await startAiEmployeeRuntime({ userId: 'user-1', pollIntervalMs: 1000 });

    expect(mockApprovePlan).toHaveBeenCalledWith('task-auto', 'user-1');
  });

  it('stops the runtime cleanly', async () => {
    await startAiEmployeeRuntime({ userId: 'user-1', pollIntervalMs: 1000 });
    stopAiEmployeeRuntime();
    expect(getAiEmployeeRuntimeState()).toBeNull();
  });
});
