import { describe, expect, it } from 'vitest';
import { parseManualThinkingDirective, resolveChatThinkingPolicy } from './chatThinkingPolicyService.js';

describe('parseManualThinkingDirective', () => {
  it('parses /think as a manual full override', () => {
    const result = parseManualThinkingDirective('/think explain the seller score');

    expect(result.isDirective).toBe(true);
    expect(result.mode).toBe('full');
    expect(result.cleanedMessage).toBe('explain the seller score');
  });

  it('parses /think light as a manual light override', () => {
    const result = parseManualThinkingDirective('/think light what datasets do you have?');

    expect(result.isDirective).toBe(true);
    expect(result.mode).toBe('light');
    expect(result.cleanedMessage).toBe('what datasets do you have?');
  });
});

describe('resolveChatThinkingPolicy', () => {
  it('returns full thinking for manual overrides', () => {
    const result = resolveChatThinkingPolicy('/think what datasets do you have?');

    expect(result.mode).toBe('full');
    expect(result.reason).toBe('manual_override');
  });

  it('returns light thinking for manual light overrides', () => {
    const result = resolveChatThinkingPolicy('/think light can you introduce the datasets?');

    expect(result.mode).toBe('light');
    expect(result.reason).toBe('manual_light_override');
    expect(result.steps).toHaveLength(3);
  });

  it('returns light thinking for dataset orientation questions', () => {
    const result = resolveChatThinkingPolicy('Can you introduce me what kind of datasets you have and how i can make use of it?');

    expect(result.mode).toBe('light');
    expect(result.reason).toBe('dataset_orientation');
    expect(result.steps).toHaveLength(3);
  });

  it('returns light thinking for general capability questions', () => {
    const result = resolveChatThinkingPolicy('What can you do and how should I ask better questions?');

    expect(result.mode).toBe('light');
    expect(result.reason).toBe('capability_orientation');
  });

  it('returns full thinking for direct analysis prompts', () => {
    const result = resolveChatThinkingPolicy('seller performance');

    expect(result.mode).toBe('full');
    expect(result.reason).toBe('direct_analysis');
  });

  it('returns full thinking when recent tool context exists', () => {
    const result = resolveChatThinkingPolicy('What does that mean for the top sellers?', {
      hasRecentToolUse: true,
    });

    expect(result.mode).toBe('full');
    expect(result.reason).toBe('recent_tool_context');
  });

  it('returns none for ordinary chat prompts', () => {
    const result = resolveChatThinkingPolicy('Thanks, that helps.');

    expect(result.mode).toBe('none');
    expect(result.reason).toBe('default');
    expect(result.steps).toEqual([]);
  });
});
