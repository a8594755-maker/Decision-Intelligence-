import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolveModel = vi.fn();
const mockRecordModelRun = vi.fn();
const mockInvokeAiProxy = vi.fn();

vi.mock('./modelRoutingService', () => ({
  resolveModel: (...args) => mockResolveModel(...args),
  recordModelRun: (...args) => mockRecordModelRun(...args),
}));

vi.mock('./aiProxyService', () => ({
  invokeAiProxy: (...args) => mockInvokeAiProxy(...args),
}));

const { callLLM } = await import('./aiEmployeeLLMService.js');

describe('aiEmployeeLLMService Gemini routing', () => {
  beforeEach(() => {
    mockResolveModel.mockReset();
    mockRecordModelRun.mockReset();
    mockInvokeAiProxy.mockReset();
  });

  it('routes Gemini non-JSON calls through gemini_chat compat mode', async () => {
    mockResolveModel.mockResolvedValue({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      tier: 'tier_b',
      escalated: false,
      escalatedFrom: null,
    });
    mockInvokeAiProxy.mockResolvedValue({
      text: 'ok',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      transport: 'compat',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const result = await callLLM({
      taskType: 'report',
      prompt: 'Summarize this dataset.',
      systemPrompt: 'Be concise.',
    });

    expect(mockInvokeAiProxy).toHaveBeenCalledWith(
      'gemini_chat',
      expect.objectContaining({
        message: 'Summarize this dataset.',
        systemPrompt: 'Be concise.',
        model: 'gemini-2.5-flash',
      }),
    );
    expect(result.provider).toBe('gemini');
    expect(result.transport).toBe('compat');
  });

  it('routes Gemini JSON calls through di_prompt native mode', async () => {
    mockResolveModel.mockResolvedValue({
      provider: 'gemini',
      model: 'gemini-3.1-pro-preview',
      tier: 'tier_a',
      escalated: false,
      escalatedFrom: null,
    });
    mockInvokeAiProxy.mockResolvedValue({
      text: '{"ok":true}',
      provider: 'gemini',
      model: 'gemini-3.1-pro-preview',
      transport: 'native',
      usage: { prompt_tokens: 12, completion_tokens: 6 },
    });

    const result = await callLLM({
      taskType: 'task_decomposition',
      prompt: 'Return a JSON plan.',
      jsonMode: true,
    });

    expect(mockInvokeAiProxy).toHaveBeenCalledWith(
      'di_prompt',
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-3.1-pro-preview',
      }),
    );
    expect(result.transport).toBe('native');
  });
});

describe('aiEmployeeLLMService DeepSeek routing', () => {
  beforeEach(() => {
    mockResolveModel.mockReset();
    mockRecordModelRun.mockReset();
    mockInvokeAiProxy.mockReset();
  });

  it('suppresses temperature for deepseek-reasoner model', async () => {
    mockResolveModel.mockResolvedValue({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      tier: 'tier_b',
      escalated: false,
      escalatedFrom: null,
    });
    mockInvokeAiProxy.mockResolvedValue({
      text: 'thinking result',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });

    await callLLM({
      taskType: 'report',
      prompt: 'Analyze this.',
    });

    const payload = mockInvokeAiProxy.mock.calls[0][1];
    expect(payload).not.toHaveProperty('temperature');
    expect(payload.thinking).toBe(true);
  });

  it('includes response_format for deepseek JSON mode via chat', async () => {
    mockResolveModel.mockResolvedValue({
      provider: 'deepseek',
      model: 'deepseek-chat',
      tier: 'tier_c',
      escalated: false,
      escalatedFrom: null,
    });
    mockInvokeAiProxy.mockResolvedValue({
      text: '{"ok":true}',
      provider: 'deepseek',
      model: 'deepseek-chat',
      usage: { prompt_tokens: 15, completion_tokens: 8 },
    });

    await callLLM({
      taskType: 'task_decomposition',
      prompt: 'Return JSON.',
      jsonMode: true,
    });

    const [mode, payload] = mockInvokeAiProxy.mock.calls[0];
    expect(mode).toBe('di_prompt');
    expect(payload.responseMimeType).toBe('application/json');
  });

  it('routes deepseek-chat through deepseek_chat mode with temperature', async () => {
    mockResolveModel.mockResolvedValue({
      provider: 'deepseek',
      model: 'deepseek-chat',
      tier: 'tier_c',
      escalated: false,
      escalatedFrom: null,
    });
    mockInvokeAiProxy.mockResolvedValue({
      text: 'hello',
      provider: 'deepseek',
      model: 'deepseek-chat',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await callLLM({
      taskType: 'report',
      prompt: 'Summarize.',
      systemPrompt: 'Be brief.',
    });

    const [mode, payload] = mockInvokeAiProxy.mock.calls[0];
    expect(mode).toBe('deepseek_chat');
    expect(payload.temperature).toBeDefined();
    expect(payload).not.toHaveProperty('thinking');
  });
});
