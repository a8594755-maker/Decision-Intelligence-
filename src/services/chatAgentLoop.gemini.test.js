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

  it('falls back to non-streaming Gemini tools when the stream returns no content or tool calls', async () => {
    const runAgentLoop = await loadRunAgentLoop();
    mockExecuteTool.mockResolvedValue({
      success: true,
      result: {
        rowCount: 1,
        rows: [{ revenue: 456 }],
        columns: ['revenue'],
      },
    });
    mockInvokeAiProxyStream
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({
          choices: [{
            delta: {
              content: 'Recovered via Gemini non-streaming tool call.',
            },
          }],
        });
      });
    mockInvokeAiProxy.mockResolvedValue({
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

    const result = await runAgentLoop({
      message: '請分析 Olist 補貨策略',
      mode: 'analysis',
      agentProvider: 'gemini',
      agentModel: 'gemini-3.1-pro-preview',
    });

    expect(mockInvokeAiProxyStream).toHaveBeenCalledTimes(2);
    // Gemini thinking config causes tool_choice downgrade to 'auto'
    expect(mockInvokeAiProxyStream.mock.calls[0][1]).toEqual(expect.objectContaining({
      model: 'gemini-3.1-pro-preview',
      toolChoice: 'auto',
      googleOptions: {
        thinkingConfig: {
          include_thoughts: true,
        },
      },
    }));
    expect(mockInvokeAiProxyStream.mock.calls[1][1]).toEqual(expect.objectContaining({
      toolChoice: 'auto',
    }));
    expect(mockInvokeAiProxy).toHaveBeenCalledWith(
      'gemini_chat_tools',
      expect.objectContaining({
        model: 'gemini-3.1-pro-preview',
        toolChoice: 'auto',
        googleOptions: {
          thinkingConfig: {
            include_thoughts: true,
          },
        },
      }),
      expect.any(Object),
    );
    expect(mockExecuteTool).toHaveBeenCalledWith('query_sap_data', { sql: 'SELECT 456 AS revenue' }, expect.any(Object));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.text).toBe('Recovered via Gemini non-streaming tool call.');
  });

  it('throws a hard failure when Gemini returns empty streaming and non-streaming responses', async () => {
    const runAgentLoop = await loadRunAgentLoop();
    mockInvokeAiProxyStream.mockResolvedValue(undefined);
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

    await expect(runAgentLoop({
      message: '請分析 Olist 補貨策略',
      mode: 'analysis',
      agentProvider: 'gemini',
      agentModel: 'gemini-3.1-pro-preview',
    })).rejects.toMatchObject({
      failureCategory: 'empty_response',
      recoveryAttempts: expect.arrayContaining(['stream_empty_to_non_stream_fallback']),
    });
  });

  it('forces an evidence tool turn for any provider when prose is returned without tool calls', async () => {
    const runAgentLoop = await loadRunAgentLoop();
    mockExecuteTool.mockResolvedValue({
      success: true,
      result: {
        rowCount: 1,
        rows: [{ revenue: 123 }],
        columns: ['revenue'],
      },
    });

    mockInvokeAiProxyStream
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({
          choices: [{
            delta: {
              content: '我先給你一些通用建議，再看是否需要查資料。',
            },
          }],
        });
      })
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
            delta: {
              content: '已根據查詢結果完成分析。',
            },
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

    expect(mockInvokeAiProxyStream).toHaveBeenCalledTimes(3);
    // Gemini's thinking config conflicts with tool_choice:"required", so it gets
    // downgraded to "auto" with prompt-based evidence enforcement (same as Kimi).
    expect(mockInvokeAiProxyStream.mock.calls[0][1]).toEqual(expect.objectContaining({
      toolChoice: 'auto',
    }));
    expect(mockInvokeAiProxyStream.mock.calls[1][1]).toEqual(expect.objectContaining({
      toolChoice: 'auto',
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('Evidence rule: your previous reply contained prose but no tool call.'),
        }),
      ]),
    }));
    expect(mockInvokeAiProxyStream.mock.calls[2][1]).toEqual(expect.objectContaining({
      toolChoice: 'auto',
    }));
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

  it('fails with missing_evidence after two forced evidence turns and no-thinking recovery still returns prose', async () => {
    const runAgentLoop = await loadRunAgentLoop();

    mockInvokeAiProxyStream
      // Turn 1: prose
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({ choices: [{ delta: { content: 'Let me think about this...' } }] });
      })
      // Turn 2 (forced evidence attempt 0): still prose
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({ choices: [{ delta: { content: 'Here are some general thoughts...' } }] });
      })
      // Turn 3 (forced evidence attempt 1): still prose
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({ choices: [{ delta: { content: 'Still just thinking out loud...' } }] });
      });

    // No-thinking recovery (non-streaming) also returns prose
    mockInvokeAiProxy.mockResolvedValueOnce({
      choices: [{
        message: { role: 'assistant', content: 'Cannot produce tool calls even without thinking.' },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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
        'forced_evidence_turn_0',
        'forced_evidence_turn_1',
        'no_thinking_evidence_recovery',
      ]),
    });
    // 3 streaming turns + 1 non-streaming recovery
    expect(mockInvokeAiProxyStream).toHaveBeenCalledTimes(3);
    expect(mockInvokeAiProxy).toHaveBeenCalledTimes(1);
    // The no-thinking call should NOT include googleOptions
    expect(mockInvokeAiProxy.mock.calls[0][1]).not.toHaveProperty('googleOptions');
    expect(mockInvokeAiProxy.mock.calls[0][1]).toEqual(expect.objectContaining({
      toolChoice: 'required',
    }));
  });

  it('recovers via no-thinking non-streaming call when Gemini fails all forced evidence turns', async () => {
    const runAgentLoop = await loadRunAgentLoop();
    mockExecuteTool.mockResolvedValue({
      success: true,
      result: { rowCount: 1, rows: [{ revenue: 999 }], columns: ['revenue'] },
    });

    // 3 streaming turns: all prose
    mockInvokeAiProxyStream
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({ choices: [{ delta: { content: 'Thinking...' } }] });
      })
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({ choices: [{ delta: { content: 'Still thinking...' } }] });
      })
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({ choices: [{ delta: { content: 'More thoughts...' } }] });
      })
      // Turn 4: final answer after recovery succeeds
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({ choices: [{ delta: { content: 'Analysis based on recovered evidence.' } }] });
      });

    // No-thinking recovery: returns tool call!
    mockInvokeAiProxy.mockResolvedValueOnce({
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
    });

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

    // 3 prose turns + 1 final answer turn after recovery
    expect(mockInvokeAiProxyStream).toHaveBeenCalledTimes(4);
    // 1 no-thinking recovery call
    expect(mockInvokeAiProxy).toHaveBeenCalledTimes(1);
    expect(mockInvokeAiProxy.mock.calls[0][1]).not.toHaveProperty('googleOptions');
    expect(mockInvokeAiProxy.mock.calls[0][1]).toEqual(expect.objectContaining({
      toolChoice: 'required',
    }));
    expect(mockExecuteTool).toHaveBeenCalledWith('query_sap_data', { sql: 'SELECT 999 AS revenue' }, expect.any(Object));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.recoveryAttempts).toEqual(expect.arrayContaining(['no_thinking_evidence_recovery']));
    expect(result.text).toBe('Analysis based on recovered evidence.');
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

  it('downgrades required tool choice for Kimi and injects an explicit evidence-first instruction', async () => {
    const runAgentLoop = await loadRunAgentLoop();
    mockExecuteTool.mockResolvedValue({
      success: true,
      result: { rowCount: 1, rows: [{ revenue: 88 }], columns: ['revenue'] },
    });
    mockInvokeAiProxy
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'call_kimi_required_1',
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
      .mockResolvedValueOnce({
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

    expect(mockInvokeAiProxy).toHaveBeenCalledTimes(2);
    expect(mockInvokeAiProxy.mock.calls[0][0]).toBe('kimi_chat_tools');
    expect(mockInvokeAiProxy.mock.calls[0][1]).toEqual(expect.objectContaining({
      model: 'kimi-k2.5',
      toolChoice: 'auto',
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('Evidence-first rule: this task requires tool-backed evidence'),
        }),
      ]),
    }));
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

  it('does not double-send non-stream Kimi requests when the provider is overloaded', async () => {
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
      failureCategory: 'provider_overloaded',
      provider: 'kimi',
    });

    expect(mockInvokeAiProxy).toHaveBeenCalledTimes(1);
  });

  it.each([
    'Run demand forecast and quantify the drivers.',
    'Run a full risk assessment and rank the top risks.',
    'Analyze my uploaded data and summarize the key insights.',
    'Generate a replenishment plan based on forecast results.',
  ])('applies the same missing-evidence guard across analysis prompts: %s', async (prompt) => {
    const runAgentLoop = await loadRunAgentLoop();
    // 3 streaming turns (1 initial + 2 forced evidence): all prose
    mockInvokeAiProxyStream
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({ choices: [{ delta: { content: 'Here is a generic answer without evidence.' } }] });
      })
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({ choices: [{ delta: { content: 'Still generic prose.' } }] });
      })
      .mockImplementationOnce(async (_mode, _payload, { onDelta }) => {
        onDelta({ choices: [{ delta: { content: 'Third attempt, still prose.' } }] });
      });
    // No-thinking recovery: also prose
    mockInvokeAiProxy.mockResolvedValueOnce({
      choices: [{
        message: { role: 'assistant', content: 'No tool calls even without thinking.' },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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
      failureCategory: 'missing_evidence',
    });

    mockInvokeAiProxyStream.mockReset();
    mockInvokeAiProxy.mockReset();
  });
});
