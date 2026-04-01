/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock supabase
const mockInsert = vi.fn().mockResolvedValue({ data: null, error: null });
const mockSelect = vi.fn().mockReturnValue({
  eq: vi.fn().mockReturnValue({
    order: vi.fn().mockResolvedValue({ data: [] }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
  }),
});
const mockDelete = vi.fn().mockReturnValue({
  in: vi.fn().mockResolvedValue({ data: null }),
});

vi.mock('../infra/supabaseClient', () => ({
  supabase: {
    from: () => ({
      insert: mockInsert,
      select: mockSelect,
      delete: mockDelete,
    }),
  },
  userFilesService: {},
}));

// Mock taskRepo
vi.mock('./persistence/taskRepo.js', () => ({
  getTask: vi.fn().mockResolvedValue({
    id: 'task-1',
    status: 'in_progress',
    version: 3,
    input_context: { workflow_type: 'forecast' },
    plan_snapshot: { steps: [{ step_index: 0 }, { step_index: 1 }] },
    employee_id: 'emp-1',
  }),
  updateTaskStatus: vi.fn().mockResolvedValue({ version: 4 }),
  createTask: vi.fn().mockResolvedValue({ id: 'new-task-1' }),
}));

// Mock stepRepo
vi.mock('./persistence/stepRepo.js', () => ({
  getSteps: vi.fn().mockResolvedValue([
    { id: 'step-0', step_index: 0, step_name: 'forecast', status: 'succeeded', tool_type: 'builtin_tool', retry_count: 0, artifact_refs: ['art-1'], started_at: '2026-01-01', ended_at: '2026-01-01' },
    { id: 'step-1', step_index: 1, step_name: 'plan', status: 'pending', tool_type: 'builtin_tool', retry_count: 0, artifact_refs: [], started_at: null, ended_at: null },
    { id: 'step-2', step_index: 2, step_name: 'risk', status: 'pending', tool_type: 'builtin_tool', retry_count: 0, artifact_refs: [], started_at: null, ended_at: null },
  ]),
  updateStep: vi.fn().mockResolvedValue({}),
}));

describe('checkpointService', () => {
  let service;

  beforeEach(async () => {
    vi.resetModules();
    service = await import('./checkpointService.js');
    service.clearCache('task-1');
  });

  describe('createCheckpoint', () => {
    it('creates a checkpoint with correct structure', async () => {
      const cp = await service.createCheckpoint('task-1', 0);

      expect(cp).toBeDefined();
      expect(cp.task_id).toBe('task-1');
      expect(cp.step_index).toBe(0);
      expect(cp.step_name).toBe('forecast');
      expect(cp.task_status).toBe('in_progress');
      expect(cp.task_version).toBe(3);
      expect(cp.state_snapshot).toBeDefined();
      expect(cp.state_snapshot.step_states).toHaveLength(3);
      expect(cp.state_snapshot.prior_artifacts).toHaveProperty('forecast');
      expect(cp.state_snapshot.prior_artifacts.forecast).toContain('art-1');
      expect(cp.state_snapshot.context.completedStepCount).toBe(1);
      expect(cp.state_snapshot.context.totalStepCount).toBe(3);
    });

    it('persists checkpoint to DB via supabase insert', async () => {
      await service.createCheckpoint('task-1', 0);
      expect(mockInsert).toHaveBeenCalled();
    });

    it('caches the checkpoint in memory', async () => {
      await service.createCheckpoint('task-1', 0);
      const checkpoints = await service.getCheckpoints('task-1');
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].step_index).toBe(0);
    });

    it('handles DB write failure gracefully', async () => {
      mockInsert.mockRejectedValueOnce(new Error('DB down'));
      const cp = await service.createCheckpoint('task-1', 0);
      // Should still succeed (in-memory only)
      expect(cp).toBeDefined();
      expect(cp.task_id).toBe('task-1');
    });
  });

  describe('getCheckpoints', () => {
    it('returns empty array for task with no checkpoints', async () => {
      const checkpoints = await service.getCheckpoints('task-unknown');
      expect(checkpoints).toEqual([]);
    });

    it('returns checkpoints sorted by step_index', async () => {
      await service.createCheckpoint('task-1', 1);
      await service.createCheckpoint('task-1', 0);
      const checkpoints = await service.getCheckpoints('task-1');
      expect(checkpoints[0].step_index).toBeLessThanOrEqual(checkpoints[1].step_index);
    });
  });

  describe('getLatestCheckpoint', () => {
    it('returns null when no checkpoints exist', async () => {
      const latest = await service.getLatestCheckpoint('task-empty');
      expect(latest).toBeNull();
    });

    it('returns the most recent checkpoint', async () => {
      await service.createCheckpoint('task-1', 0);
      await service.createCheckpoint('task-1', 1);
      const latest = await service.getLatestCheckpoint('task-1');
      expect(latest.step_index).toBe(1);
    });
  });

  describe('getCheckpoint', () => {
    it('finds a checkpoint by ID from cache', async () => {
      const cp = await service.createCheckpoint('task-1', 0);
      const found = await service.getCheckpoint(cp.id);
      expect(found).toBeDefined();
      expect(found.id).toBe(cp.id);
    });

    it('returns null for non-existent checkpoint', async () => {
      const found = await service.getCheckpoint('nonexistent');
      expect(found).toBeNull();
    });
  });

  describe('resumeFromCheckpoint', () => {
    it('resets steps after checkpoint back to pending', async () => {
      const cp = await service.createCheckpoint('task-1', 0);
      const { resetSteps, resumeFromIndex } = await service.resumeFromCheckpoint('task-1', cp.id);

      expect(resetSteps).toBe(2); // step 1 and step 2 reset
      expect(resumeFromIndex).toBe(1);
    });

    it('throws for non-existent checkpoint', async () => {
      await expect(service.resumeFromCheckpoint('task-1', 'bad-id')).rejects.toThrow('Checkpoint not found');
    });

    it('throws for mismatched task', async () => {
      const cp = await service.createCheckpoint('task-1', 0);
      await expect(service.resumeFromCheckpoint('task-other', cp.id)).rejects.toThrow('does not belong');
    });
  });

  describe('pruneCheckpoints', () => {
    it('keeps only the specified number of recent checkpoints', async () => {
      await service.createCheckpoint('task-1', 0);
      await service.createCheckpoint('task-1', 1);
      await service.createCheckpoint('task-1', 2);

      const deleted = await service.pruneCheckpoints('task-1', 2);
      expect(deleted).toBe(1);

      const remaining = await service.getCheckpoints('task-1');
      expect(remaining).toHaveLength(2);
    });

    it('does nothing when under the limit', async () => {
      await service.createCheckpoint('task-1', 0);
      const deleted = await service.pruneCheckpoints('task-1', 5);
      expect(deleted).toBe(0);
    });
  });

  describe('clearCache', () => {
    it('clears the in-memory cache for a task', async () => {
      await service.createCheckpoint('task-1', 0);
      service.clearCache('task-1');
      // After clearing cache, getCheckpoints goes to DB (which returns empty in mock)
      const checkpoints = await service.getCheckpoints('task-1');
      expect(checkpoints).toEqual([]);
    });
  });
});
