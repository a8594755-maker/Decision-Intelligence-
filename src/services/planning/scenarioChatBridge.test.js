import { describe, it, expect, vi } from 'vitest';

// Mock dependencies before import
vi.mock('./scenarioIntentParser', () => ({
  parseScenarioFromText: vi.fn(),
  validateScenarioOverrides: vi.fn(),
  looksLikeScenario: vi.fn(),
}));

vi.mock('./diScenariosService', () => ({
  createScenario: vi.fn(),
}));

vi.mock('./scenarioEngine', () => ({
  executeScenarioPlan: vi.fn(),
}));

vi.mock('./decisionTaskService', () => ({
  buildScenarioDecisionBundle: vi.fn(),
}));

vi.mock('./evidenceAssembler', () => ({
  assembleScenarioEvidence: vi.fn(),
}));

import { runScenarioFromChat, canRunScenarioFromChat } from './scenarioChatBridge';
import { parseScenarioFromText, validateScenarioOverrides, looksLikeScenario } from './scenarioIntentParser';
import { createScenario } from './diScenariosService';
import { executeScenarioPlan } from './scenarioEngine';
import { buildScenarioDecisionBundle } from '../tasks/decisionTaskService';
import { assembleScenarioEvidence } from '../governance/evidenceAssembler';

describe('runScenarioFromChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns low-confidence message when parse fails', async () => {
    parseScenarioFromText.mockResolvedValue({
      overrides: {},
      confidence: 0.2,
      parse_method: 'local_regex',
    });

    const result = await runScenarioFromChat({
      messageText: 'hello',
      userId: 'u1',
      baseRunId: 100,
    });

    expect(result.scenarioRunId).toBeNull();
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages[0].content).toContain('couldn\'t extract');
  });

  it('runs full pipeline on valid scenario text', async () => {
    parseScenarioFromText.mockResolvedValue({
      overrides: { demand_multiplier: 1.2 },
      confidence: 0.9,
      parse_method: 'local_regex',
    });
    validateScenarioOverrides.mockReturnValue({
      valid: true,
      errors: [],
      sanitized: { demand_multiplier: 1.2 },
    });
    createScenario.mockResolvedValue({
      scenario: { id: 's1', base_run_id: 100, overrides: { demand_multiplier: 1.2 }, engine_flags: {} },
      isNew: true,
      cached: false,
    });
    executeScenarioPlan.mockResolvedValue({
      scenarioRunId: 201,
      comparisonPayload: {
        base_run_id: 100,
        scenario_run_id: 201,
        overrides: { demand_multiplier: 1.2 },
        kpis: { base: {}, scenario: {}, delta: {} },
      },
    });
    assembleScenarioEvidence.mockReturnValue([
      { artifact_type: 'scenario_comparison', run_id: 201, label: 'Compare' },
    ]);
    buildScenarioDecisionBundle.mockReturnValue({
      version: 'v1',
      summary: 'Test bundle',
      recommendation: null,
      drivers: [],
      kpi_impact: {},
      evidence_refs: [],
      blockers: [],
      next_actions: [],
      generated_at: new Date().toISOString(),
    });

    const result = await runScenarioFromChat({
      messageText: 'What if demand increases by 20%?',
      userId: 'u1',
      baseRunId: 100,
    });

    expect(result.scenarioRunId).toBe(201);
    expect(result.overrides).toEqual({ demand_multiplier: 1.2 });
    expect(result.bundle).toBeTruthy();

    // Should have messages: progress, completion, comparison card, decision bundle card
    const bundleMsg = result.messages.find(m => m.type === 'decision_bundle_card');
    expect(bundleMsg).toBeTruthy();
    const compMsg = result.messages.find(m => m.type === 'scenario_comparison_card');
    expect(compMsg).toBeTruthy();
  });

  it('handles validation errors gracefully', async () => {
    parseScenarioFromText.mockResolvedValue({
      overrides: { demand_multiplier: 15 },
      confidence: 0.8,
      parse_method: 'local_regex',
    });
    validateScenarioOverrides.mockReturnValue({
      valid: false,
      errors: ['demand_multiplier clamped to 10'],
      sanitized: { demand_multiplier: 10 },
    });
    createScenario.mockResolvedValue({
      scenario: { id: 's2', base_run_id: 100, overrides: { demand_multiplier: 10 }, engine_flags: {} },
      isNew: true,
    });
    executeScenarioPlan.mockResolvedValue({
      scenarioRunId: 202,
      comparisonPayload: { kpis: { base: {}, scenario: {}, delta: {} } },
    });
    assembleScenarioEvidence.mockReturnValue([]);
    buildScenarioDecisionBundle.mockReturnValue({ version: 'v1', summary: 'Test' });

    const result = await runScenarioFromChat({
      messageText: 'demand 15x',
      userId: 'u1',
      baseRunId: 100,
    });

    const warningMsg = result.messages.find(m => m.content?.includes('adjusted'));
    expect(warningMsg).toBeTruthy();
    expect(result.scenarioRunId).toBe(202);
  });

  it('handles execution failure', async () => {
    parseScenarioFromText.mockResolvedValue({
      overrides: { demand_multiplier: 1.5 },
      confidence: 0.8,
      parse_method: 'local_regex',
    });
    validateScenarioOverrides.mockReturnValue({
      valid: true,
      errors: [],
      sanitized: { demand_multiplier: 1.5 },
    });
    createScenario.mockResolvedValue({
      scenario: { id: 's3', base_run_id: 100, overrides: { demand_multiplier: 1.5 }, engine_flags: {} },
      isNew: true,
    });
    executeScenarioPlan.mockRejectedValue(new Error('Base run not found'));

    const result = await runScenarioFromChat({
      messageText: 'demand +50%',
      userId: 'u1',
      baseRunId: 100,
    });

    expect(result.scenarioRunId).toBeNull();
    const errorMsg = result.messages.find(m => m.content?.includes('failed'));
    expect(errorMsg).toBeTruthy();
    const errorCard = result.messages.find(m => m.type === 'plan_error_card');
    expect(errorCard).toBeTruthy();
  });

  it('returns cached result when scenario already computed', async () => {
    parseScenarioFromText.mockResolvedValue({
      overrides: { demand_multiplier: 1.2 },
      confidence: 0.9,
      parse_method: 'local_regex',
    });
    validateScenarioOverrides.mockReturnValue({
      valid: true,
      errors: [],
      sanitized: { demand_multiplier: 1.2 },
    });
    createScenario.mockResolvedValue({
      scenario: { id: 's4', base_run_id: 100, scenario_run_id: 300, status: 'succeeded' },
      isNew: false,
      cached: true,
    });

    const result = await runScenarioFromChat({
      messageText: 'demand +20%',
      userId: 'u1',
      baseRunId: 100,
    });

    expect(result.scenarioRunId).toBe(300);
    expect(result.cached).toBe(true);
    expect(executeScenarioPlan).not.toHaveBeenCalled();
  });
});

describe('canRunScenarioFromChat', () => {
  it('returns false without baseline', () => {
    expect(canRunScenarioFromChat('What if demand increases?', null)).toBe(false);
  });

  it('returns false without message', () => {
    expect(canRunScenarioFromChat('', 100)).toBe(false);
  });

  it('delegates to looksLikeScenario', () => {
    looksLikeScenario.mockReturnValue(true);
    expect(canRunScenarioFromChat('What if demand increases?', 100)).toBe(true);
    expect(looksLikeScenario).toHaveBeenCalledWith('What if demand increases?');
  });
});
