/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the entire dependency chain to avoid ralph-loop-agent and supabase issues
vi.mock('../infra/supabaseClient', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => ({}) }) }) }) },
  userFilesService: {},
}));

vi.mock('./persistence/taskRepo.js', () => ({
  getTask: vi.fn(),
  updateTaskStatus: vi.fn(),
  updateWorkerHeartbeat: vi.fn(),
}));
vi.mock('./persistence/stepRepo.js', () => ({
  getSteps: vi.fn(),
  updateStep: vi.fn(),
}));
vi.mock('./persistence/employeeRepo.js', () => ({
  getEmployee: vi.fn(),
  updateEmployeeStatus: vi.fn(),
  getWorkerTemplateFromDB: vi.fn(),
  listTemplatesFromDB: vi.fn(),
}));
vi.mock('./persistence/worklogRepo.js', () => ({
  appendWorklog: vi.fn(),
}));

// Mock orchestrator to avoid ralph-loop-agent import chain
vi.mock('./orchestrator.js', () => ({
  getTaskStatus: vi.fn().mockResolvedValue({
    task: { status: 'in_progress' },
    steps: [],
    stepsCompleted: 0,
    stepsTotal: 3,
    isComplete: false,
  }),
}));

// Mock gate pipeline
vi.mock('./gates/stepPipeline.js', () => ({
  runGatePipeline: vi.fn().mockResolvedValue({ passed: true, degraded: [] }),
  buildStepContext: vi.fn().mockReturnValue({}),
}));

// Mock executors
vi.mock('./executors/executorRegistry.js', () => ({
  getExecutor: vi.fn().mockReturnValue(async () => ({
    ok: true, artifacts: [{ type: 'test', label: 'Test' }],
  })),
}));

// Mock governance services
vi.mock('../governance/selfHealingService.js', () => ({
  analyzeStepFailure: vi.fn(),
  getAlternativeModel: vi.fn(),
}));

vi.mock('../governance/eventBus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
  EVENT_NAMES: {
    AGENT_STEP_STARTED: 'AGENT_STEP_STARTED',
    AGENT_STEP_COMPLETED: 'AGENT_STEP_COMPLETED',
    AGENT_STEP_FAILED: 'AGENT_STEP_FAILED',
    TASK_COMPLETED: 'TASK_COMPLETED',
    TASK_FAILED: 'TASK_FAILED',
  },
}));

describe('claudeSdkAdapter', () => {
  let adapter;

  beforeEach(async () => {
    vi.resetModules();
    adapter = await import('./claudeSdkAdapter.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isClaudeSdkEnabled', () => {
    it('returns false when env is not set', () => {
      expect(adapter.isClaudeSdkEnabled()).toBe(false);
    });
  });

  describe('abort registry', () => {
    it('registers and aborts a controller', () => {
      const controller = adapter.registerClaudeSdkAbort('test-task-1');
      expect(controller).toBeInstanceOf(AbortController);
      expect(controller.signal.aborted).toBe(false);

      const result = adapter.abortClaudeSdkLoop('test-task-1');
      expect(result).toBe(true);
      expect(controller.signal.aborted).toBe(true);
    });

    it('returns false when aborting non-existent task', () => {
      expect(adapter.abortClaudeSdkLoop('nonexistent')).toBe(false);
    });

    it('cleans up after abort', () => {
      adapter.registerClaudeSdkAbort('test-task-2');
      adapter.abortClaudeSdkLoop('test-task-2');
      expect(adapter.abortClaudeSdkLoop('test-task-2')).toBe(false);
    });
  });

  describe('exports', () => {
    it('exports expected functions', () => {
      expect(typeof adapter.isClaudeSdkEnabled).toBe('function');
      expect(typeof adapter.runClaudeSdkLoop).toBe('function');
      expect(typeof adapter.abortClaudeSdkLoop).toBe('function');
      expect(typeof adapter.registerClaudeSdkAbort).toBe('function');
    });
  });
});

describe('Claude Agent SDK imports', () => {
  it('SDK exports query, tool, createSdkMcpServer', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    expect(typeof sdk.query).toBe('function');
    expect(typeof sdk.tool).toBe('function');
    expect(typeof sdk.createSdkMcpServer).toBe('function');
  });

  it('tool() creates a valid tool definition', async () => {
    const { tool } = await import('@anthropic-ai/claude-agent-sdk');
    const { z } = await import('zod');

    const testTool = tool(
      'test_tool',
      'A test tool',
      z.object({ input: z.string().optional() }),
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );
    expect(testTool).toBeDefined();
  });

  it('createSdkMcpServer creates a server from tools', async () => {
    const { tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
    const { z } = await import('zod');

    const testTool = tool(
      'test_tool',
      'A test tool',
      z.object({}),
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );

    const server = createSdkMcpServer({
      name: 'test-server',
      version: '0.1.0',
      tools: [testTool],
    });
    expect(server).toBeDefined();
  });

  it('SDK EXIT_REASONS and HOOK_EVENTS are available', async () => {
    const { EXIT_REASONS, HOOK_EVENTS } = await import('@anthropic-ai/claude-agent-sdk');
    expect(EXIT_REASONS).toBeDefined();
    expect(HOOK_EVENTS).toBeDefined();
  });
});
