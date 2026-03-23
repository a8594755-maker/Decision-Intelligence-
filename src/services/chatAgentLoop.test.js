import { describe, expect, it } from 'vitest';

import { getToolDefinitions } from './chatToolAdapter.js';
import { ANALYSIS_AGENT_TOOL_IDS, getAgentToolConfig, getAgentToolStreamingMode } from './chatAgentLoop.js';

function getToolNames(opts) {
  return getToolDefinitions({ ...opts, includeRegistered: false }).map((tool) => tool.function.name);
}

describe('chatAgentLoop tool exposure', () => {
  it('includes run_python_analysis in analysis mode and keeps the tool set narrow', () => {
    const names = getToolNames(getAgentToolConfig('analysis'));

    expect(names).toContain('run_python_analysis');
    expect(names).toContain('query_sap_data');
    expect(names).not.toContain('run_forecast');
    expect(ANALYSIS_AGENT_TOOL_IDS).toContain('run_python_analysis');
  });

  it('keeps Python analysis tools out of the default agent tool set', () => {
    const names = getToolNames({ ...getAgentToolConfig('default') });

    expect(names).not.toContain('run_python_analysis');
    expect(names).toContain('query_sap_data');
  });
});

describe('chatAgentLoop streaming mode routing', () => {
  it('routes Anthropic and OpenAI providers to streaming tool modes', () => {
    expect(getAgentToolStreamingMode('openai')).toBe('openai_chat_tools_stream');
    expect(getAgentToolStreamingMode('anthropic')).toBe('anthropic_chat_tools_stream');
    expect(getAgentToolStreamingMode('deepseek')).toBeNull();
  });
});
