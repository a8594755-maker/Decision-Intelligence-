import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockInvokeAiProxy,
  mockInvokeAiProxyStream,
  mockExecuteTool,
} = vi.hoisted(() => ({
  mockInvokeAiProxy: vi.fn(),
  mockInvokeAiProxyStream: vi.fn(),
  mockExecuteTool: vi.fn(),
}));

vi.mock('./aiProxyService.js', () => ({
  invokeAiProxy: (...args) => mockInvokeAiProxy(...args),
  invokeAiProxyStream: (...args) => mockInvokeAiProxyStream(...args),
}));

vi.mock('./chatToolAdapter.js', () => ({
  getToolDefinitions: () => ([
    { type: 'function', function: { name: 'query_sap_data', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'list_sap_tables', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'run_python_analysis', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'generate_chart', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'generate_analysis_workbook', parameters: { type: 'object', properties: {} } } },
  ]),
  getToolSummaryForPrompt: () => 'Available tools: query_sap_data, list_sap_tables, run_python_analysis, generate_chart, generate_analysis_workbook',
  executeTool: (...args) => mockExecuteTool(...args),
}));

async function loadRunAgentLoop() {
  vi.resetModules();
  const mod = await import('./chatAgentLoop.js');
  return mod.runAgentLoop;
}

describe('chatAgentLoop Gemini recovery', () => {
  beforeEach(() => {
    mockInvokeAiProxy.mockReset();
    mockInvokeAiProxyStream.mockReset();
    mockExecuteTool.mockReset();
  });

  it('uses compat fast path for Gemini analysis mode and falls back to streaming on prose', async () => {
    const runAgentLoop = await loadRunAgentLoop();
    mockExecuteTool.mockResolvedValue({
      success: true,
      result: {
        rowCount: 1,
        rows: [{ revenue: 456 }],
        columns: ['revenue'],
      },
    });
    // Fast path (no-thinking): returns tool call
    mockInvokeAiProxy.mockResolvedValueOnce({
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 'call_query_fallback',
            type: 'function',
            function: {
              name: 'query_sap_data',
              arguments: '{"sql":"SELECT 456 AS revenue"}',
            },
          }],
        },
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 6,
        total_tokens: 18,
      },
      transport: 'compat',
    });
    // Final answer via streaming
    mockInvokeAiProxyStream.mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
      onDelta({
        choices: [{
          delta: {
            content: 'Recovered via Gemini non-streaming tool call.',
          },
        }],
      });
    });

    const result = await runAgentLoop({
      message: '請分析 Olist 補貨策略',
      mode: 'analysis',
      agentProvider: 'gemini',
      agentModel: 'gemini-3.1-pro-preview',
    });

    // Fast path: 1 invokeAiProxy (no-thinking, toolChoice required)
    expect(mockInvokeAiProxy).toHaveBeenCalledTimes(1);
    expect(mockInvokeAiProxy.mock.calls[0][1]).toEqual(expect.objectContaining({
      model: 'gemini-3.1-pro-preview',
      toolChoice: 'required',
    }));
    expect(mockInvokeAiProxy.mock.calls[0][1]).not.toHaveProperty('googleOptions');
    // 1 streaming call for final answer
    expect(mockInvokeAiProxyStream).toHaveBeenCalledTimes(1);
    expect(mockExecuteTool).toHaveBeenCalledWith('query_sap_data', { sql: 'SELECT 456 AS revenue' }, expect.any(Object));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.recoveryAttempts).toEqual(expect.arrayContaining(['compat_first_call_fast_path']));
    expect(result.text).toBe('Recovered via Gemini non-streaming tool call.');
  });

  it('throws a hard failure when Gemini returns empty responses from fast path and streaming', async () => {
    const runAgentLoop = await loadRunAgentLoop();
    // Fast path: empty content, no tool calls
    // Subsequent calls: also empty
    mockInvokeAiProxy.mockResolvedValue({
      choices: [{
        message: {
          role: 'assistant',
          content: '',
        },
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 0,
        total_tokens: 12,
      },
      transport: 'compat',
    });
    mockInvokeAiProxyStream.mockResolvedValue(undefined);

    await expect(runAgentLoop({
      message: '請分析 Olist 補貨策略',
      mode: 'analysis',
      agentProvider: 'gemini',
      agentModel: 'gemini-3.1-pro-preview',
    })).rejects.toMatchObject({
      failureCategory: 'empty_response',
    });
  });

  it('uses compat first-call fast path for Gemini analysis mode and succeeds', async () => {
    const runAgentLoop = await loadRunAgentLoop();
    mockExecuteTool.mockResolvedValue({
      success: true,
      result: {
        rowCount: 1,
        rows: [{ revenue: 123 }],
        columns: ['revenue'],
      },
    });

    // Fast path (invokeAiProxy, no-thinking): returns tool call directly
    mockInvokeAiProxy.mockResolvedValueOnce({
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 'call_fast_1',
            type: 'function',
            function: {
              name: 'query_sap_data',
              arguments: '{"sql":"SELECT 123 AS revenue"}',
            },
          }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    // After fast path tool execution, streaming for final answer
    mockInvokeAiProxyStream.mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
      onDelta({
        choices: [{
          delta: { content: '已根據查詢結果完成分析。' },
        }],
      });
    });

    const result = await runAgentLoop({
      message: '請分析 Olist 補貨策略',
      mode: 'analysis',
      agentProvider: 'gemini',
      agentModel: 'gemini-3.1-pro-preview',
      answerContract: {
        task_type: 'recommendation',
        required_dimensions: ['replenishment_strategy', 'inventory_level'],
        required_outputs: ['recommendation', 'caveat'],
      },
    });

    // Fast path: 1 invokeAiProxy call (no-thinking, toolChoice required)
    expect(mockInvokeAiProxy).toHaveBeenCalledTimes(1);
    expect(mockInvokeAiProxy.mock.calls[0][1]).toEqual(expect.objectContaining({
      toolChoice: 'required',
    }));
    expect(mockInvokeAiProxy.mock.calls[0][1]).not.toHaveProperty('googleOptions');
    // 1 streaming call for final answer
    expect(mockInvokeAiProxyStream).toHaveBeenCalledTimes(1);
    expect(mockExecuteTool).toHaveBeenCalledWith('query_sap_data', { sql: 'SELECT 123 AS revenue' }, expect.any(Object));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.recoveryAttempts).toEqual(expect.arrayContaining(['compat_first_call_fast_path']));
    expect(result.text).toBe('已根據查詢結果完成分析。');
  });

  it('falls through to normal streaming when compat fast path returns prose', async () => {
    const runAgentLoop = await loadRunAgentLoop();
    mockExecuteTool.mockResolvedValue({
      success: true,
      result: {
        rowCount: 1,
        rows: [{ revenue: 123 }],
        columns: ['revenue'],
      },
    });

    // Fast path: returns prose (no tool calls)
    mockInvokeAiProxy.mockResolvedValueOnce({
      choices: [{
        message: {
          role: 'assistant',
          content: '我先給你一些通用建議，再看是否需要查資料。',
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    // Iteration 1: normal streaming — returns tool call
    mockInvokeAiProxyStream
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_query_1',
                function: {
                  name: 'query_sap_data',
                  arguments: '{"sql":"SELECT 123 AS revenue"}',
                },
              }],
            },
          }],
        });
      })
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({
          choices: [{
            delta: { content: '已根據查詢結果完成分析。' },
          }],
        });
      });

    const result = await runAgentLoop({
      message: '請分析 Olist 補貨策略',
      mode: 'analysis',
      agentProvider: 'gemini',
      agentModel: 'gemini-3.1-pro-preview',
      answerContract: {
        task_type: 'recommendation',
        required_dimensions: ['replenishment_strategy', 'inventory_level'],
        required_outputs: ['recommendation', 'caveat'],
      },
    });

    // 1 fast path (prose) + normal streaming takes over
    expect(mockInvokeAiProxy).toHaveBeenCalledTimes(1);
    expect(mockInvokeAiProxyStream).toHaveBeenCalledTimes(2);
    expect(mockExecuteTool).toHaveBeenCalledWith('query_sap_data', { sql: 'SELECT 123 AS revenue' }, expect.any(Object));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.text).toBe('已根據查詢結果完成分析。');
  });

  it('forces evidence tool turn for non-Gemini providers (e.g. OpenAI)', async () => {
    const runAgentLoop = await loadRunAgentLoop();
    mockExecuteTool.mockResolvedValue({
      success: true,
      result: { rowCount: 1, rows: [{ cnt: 42 }], columns: ['cnt'] },
    });

    // OpenAI has streaming support, so uses invokeAiProxyStream
    mockInvokeAiProxyStream
      // Turn 1: prose without tool calls
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({
          choices: [{ delta: { content: 'Here is a general overview of replenishment strategies.' } }],
        });
      })
      // Turn 2 (forced evidence): returns tool call
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_openai_1',
                function: { name: 'query_sap_data', arguments: '{"sql":"SELECT COUNT(*) as cnt FROM orders"}' },
              }],
            },
          }],
        });
      })
      // Turn 3: final answer
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({ choices: [{ delta: { content: 'Analysis complete.' } }] });
      });

    const result = await runAgentLoop({
      message: 'Analyze replenishment strategy',
      mode: 'analysis',
      agentProvider: 'openai',
      agentModel: 'gpt-5.4',
      answerContract: {
        task_type: 'recommendation',
        required_dimensions: ['replenishment'],
        required_outputs: ['recommendation'],
      },
    });

    // Turn 1 was prose → forced evidence turn should have fired
    expect(mockInvokeAiProxyStream).toHaveBeenCalledTimes(3);
    expect(mockInvokeAiProxyStream.mock.calls[1][1]).toEqual(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('Evidence rule'),
        }),
      ]),
    }));
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('Analysis complete.');
  });

  it('fails with missing_evidence after compat fast path and recovery all return prose', async () => {
    const runAgentLoop = await loadRunAgentLoop();

    // Fast path (invokeAiProxy): prose
    // Then no-thinking recovery (invokeAiProxy): also prose
    mockInvokeAiProxy
      .mockResolvedValueOnce({
        choices: [{
          message: { role: 'assistant', content: 'Let me think about this...' },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
      .mockResolvedValueOnce({
        choices: [{
          message: { role: 'assistant', content: 'Cannot produce tool calls even without thinking.' },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

    // After fast path prose, streaming takes over: all prose
    mockInvokeAiProxyStream
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({ choices: [{ delta: { content: 'Here are some general thoughts...' } }] });
      })
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({ choices: [{ delta: { content: 'Still general prose...' } }] });
      });

    await expect(runAgentLoop({
      message: 'Analyze categories',
      mode: 'analysis',
      agentProvider: 'gemini',
      agentModel: 'gemini-3.1-pro-preview',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['product_category'],
        required_outputs: ['recommendation'],
      },
    })).rejects.toMatchObject({
      failureCategory: 'missing_evidence',
      recoveryAttempts: expect.arrayContaining([
        'compat_first_call_fast_path',
        'no_thinking_evidence_recovery',
      ]),
    });
    // Fast path (prose) + no-thinking recovery (prose) = 2 invokeAiProxy calls
    expect(mockInvokeAiProxy).toHaveBeenCalledTimes(2);
    // Both invokeAiProxy calls should NOT include googleOptions
    expect(mockInvokeAiProxy.mock.calls[0][1]).not.toHaveProperty('googleOptions');
    expect(mockInvokeAiProxy.mock.calls[0][1]).toEqual(expect.objectContaining({
      toolChoice: 'required',
    }));
  });

  it('recovers via no-thinking call when compat fast path and streaming all return prose', async () => {
    const runAgentLoop = await loadRunAgentLoop();
    mockExecuteTool.mockResolvedValue({
      success: true,
      result: { rowCount: 1, rows: [{ revenue: 999 }], columns: ['revenue'] },
    });

    // Fast path (invokeAiProxy call 1): prose
    // No-thinking recovery (invokeAiProxy call 2): returns tool call!
    // Any subsequent invokeAiProxy calls (streaming fallback): return empty
    mockInvokeAiProxy
      .mockResolvedValueOnce({
        choices: [{
          message: { role: 'assistant', content: 'Thinking...' },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'call_recovery_1',
              type: 'function',
              function: { name: 'query_sap_data', arguments: '{"sql":"SELECT 999 AS revenue"}' },
            }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
      .mockResolvedValue({
        choices: [{
          message: { role: 'assistant', content: 'Analysis based on recovered evidence.' },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

    // After fast path prose, streaming takes over
    // i=1: prose, i=2: forced evidence prose, i=3+: final answer (empty stream → non-stream fallback)
    mockInvokeAiProxyStream
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({ choices: [{ delta: { content: 'Still thinking...' } }] });
      })
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({ choices: [{ delta: { content: 'More thinking...' } }] });
      })
      .mockResolvedValue(undefined);

    const result = await runAgentLoop({
      message: 'Analyze categories',
      mode: 'analysis',
      agentProvider: 'gemini',
      agentModel: 'gemini-3.1-pro-preview',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['product_category'],
        required_outputs: ['recommendation'],
      },
    });

    expect(mockExecuteTool).toHaveBeenCalledWith('query_sap_data', { sql: 'SELECT 999 AS revenue' }, expect.any(Object));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.recoveryAttempts).toEqual(expect.arrayContaining([
      'compat_first_call_fast_path',
      'no_thinking_evidence_recovery',
    ]));
  });

  it('uses resolveProviderFromModel to correct mismatched provider', async () => {
    const runAgentLoop = await loadRunAgentLoop();
    mockExecuteTool.mockResolvedValue({
      success: true,
      result: { rowCount: 1, rows: [{ val: 1 }], columns: ['val'] },
    });

    // Kimi has no streaming mode, so callLLMWithToolsStream falls back to callLLMWithTools (invokeAiProxy)
    mockInvokeAiProxy
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'call_kimi_1',
              type: 'function',
              function: { name: 'query_sap_data', arguments: '{"sql":"SELECT 1 AS val"}' },
            }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
      .mockResolvedValueOnce({
        choices: [{
          message: { role: 'assistant', content: 'Done with kimi.' },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

    const result = await runAgentLoop({
      message: 'test query',
      mode: 'analysis',
      agentProvider: 'deepseek', // WRONG provider for kimi-k2.5
      agentModel: 'kimi-k2.5',
    });

    // Should have been corrected to kimi_chat_tools, NOT deepseek_chat_tools
    expect(mockInvokeAiProxy.mock.calls[0][0]).toBe('kimi_chat_tools');
    expect(result.text).toBe('Done with kimi.');
  });

  it('downgrades tool choice for Kimi (native transport, no fast path) and injects evidence instruction', async () => {
    // Kimi has transport: 'native' so the compat fast path does NOT apply.
    // Instead, it uses normal path with tool_choice downgraded to 'auto'.
    const runAgentLoop = await loadRunAgentLoop();
    mockExecuteTool.mockResolvedValue({
      success: true,
      result: { rowCount: 1, rows: [{ revenue: 88 }], columns: ['revenue'] },
    });
    mockInvokeAiProxy
      // Kimi has no streaming: callLLMWithToolsStream → stream empty → internal fallback → callLLMWithTools
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'call_kimi_1',
              type: 'function',
              function: {
                name: 'query_sap_data',
                arguments: '{"sql":"SELECT 88 AS revenue"}',
              },
            }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
      .mockResolvedValue({
        choices: [{
          message: { role: 'assistant', content: 'Kimi analysis complete.' },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

    const result = await runAgentLoop({
      message: 'Analyze replenishment strategy',
      mode: 'analysis',
      agentProvider: 'kimi',
      agentModel: 'kimi-k2.5',
      answerContract: {
        task_type: 'recommendation',
        required_dimensions: ['replenishment_strategy', 'inventory_levels'],
        required_outputs: ['recommendation', 'caveat'],
      },
    });

    expect(mockInvokeAiProxy.mock.calls[0][0]).toBe('kimi_chat_tools');
    expect(mockInvokeAiProxy.mock.calls[0][1].model).toBe('kimi-k2.5');
    // Kimi uses native transport → no fast path → toolChoice downgraded to 'auto'
    expect(mockInvokeAiProxy.mock.calls[0][1].toolChoice).toBe('auto');
    expect(mockExecuteTool).toHaveBeenCalledWith('query_sap_data', { sql: 'SELECT 88 AS revenue' }, expect.any(Object));
    expect(result.recoveryAttempts).toEqual(expect.arrayContaining([
      'tool_choice_provider_compat_fallback',
      'provider_tool_choice_compat_nudge',
    ]));
    expect(result.text).toBe('Kimi analysis complete.');
  });

  it('classifies missing models without wrapping them as generic failures', async () => {
    const runAgentLoop = await loadRunAgentLoop();
    mockInvokeAiProxy.mockRejectedValue(new Error('Model Not Exist'));

    await expect(runAgentLoop({
      message: 'Analyze replenishment strategy',
      mode: 'analysis',
      agentProvider: 'kimi',
      agentModel: 'kimi-k2.5',
    })).rejects.toMatchObject({
      failureCategory: 'model_not_found',
    });
  });

  it('propagates overloaded error for Kimi even with fast path', async () => {
    const runAgentLoop = await loadRunAgentLoop();
    const error = new Error('The engine is currently overloaded, please try again later');
    error.failureCategory = 'provider_overloaded';
    error.failureMessage = 'The engine is currently overloaded, please try again later';
    error.provider = 'kimi';
    error.status = 429;
    mockInvokeAiProxy.mockRejectedValue(error);

    await expect(runAgentLoop({
      message: 'Analyze replenishment strategy',
      mode: 'analysis',
      agentProvider: 'kimi',
      agentModel: 'kimi-k2.5',
      answerContract: {
        task_type: 'recommendation',
        required_dimensions: ['replenishment_strategy'],
        required_outputs: ['recommendation'],
      },
    })).rejects.toMatchObject({
      failureCategory: expect.stringMatching(/provider_overloaded|tool_transport_failed/),
    });

    // Fast path catches the error silently; subsequent paths also fail and throw
    expect(mockInvokeAiProxy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    'Run demand forecast and quantify the drivers.',
    'Run a full risk assessment and rank the top risks.',
    'Analyze my uploaded data and summarize the key insights.',
    'Generate a replenishment plan based on forecast results.',
  ])('applies the same missing-evidence guard across analysis prompts: %s', async (prompt) => {
    const runAgentLoop = await loadRunAgentLoop();
    // All invokeAiProxy calls return prose (fast path + recovery + fallbacks)
    mockInvokeAiProxy.mockResolvedValue({
      choices: [{
        message: { role: 'assistant', content: 'No tool calls even without thinking.' },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    // All streaming calls return prose
    mockInvokeAiProxyStream.mockImplementation(async (_mode, _payload, { onDelta }) => {
      onDelta({ choices: [{ delta: { content: 'Still generic prose.' } }] });
    });

    await expect(runAgentLoop({
      message: prompt,
      mode: 'analysis',
      agentProvider: 'gemini',
      agentModel: 'gemini-3.1-pro-preview',
      answerContract: {
        task_type: 'recommendation',
        required_dimensions: ['evidence'],
        required_outputs: ['recommendation'],
      },
    })).rejects.toMatchObject({
      failureCategory: expect.stringMatching(/missing_evidence|tool_transport_failed/),
    });

    mockInvokeAiProxyStream.mockReset();
    mockInvokeAiProxy.mockReset();
  });
});
