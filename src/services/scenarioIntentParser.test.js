import { describe, it, expect } from 'vitest';
import {
  parseScenarioFromText,
  looksLikeScenario,
  validateScenarioOverrides,
} from './scenarioIntentParser';

// ── looksLikeScenario ────────────────────────────────────────────────────────

describe('looksLikeScenario', () => {
  it('detects English scenario markers', () => {
    expect(looksLikeScenario('What if demand increases by 20%?')).toBe(true);
    expect(looksLikeScenario('Suppose lead time delays by 2 weeks')).toBe(true);
    expect(looksLikeScenario('Simulate a disruption scenario')).toBe(true);
    expect(looksLikeScenario('What happens if we increase safety stock?')).toBe(true);
  });

  it('detects Chinese scenario markers', () => {
    expect(looksLikeScenario('如果需求增加 20% 會怎樣？')).toBe(true);
    expect(looksLikeScenario('假設供應商延遲三週')).toBe(true);
    expect(looksLikeScenario('模擬中斷情境')).toBe(true);
  });

  it('rejects non-scenario text', () => {
    expect(looksLikeScenario('hello')).toBe(false);
    expect(looksLikeScenario('show me the plan')).toBe(false);
    expect(looksLikeScenario('run forecast')).toBe(false);
    expect(looksLikeScenario(null)).toBe(false);
    expect(looksLikeScenario('')).toBe(false);
  });
});

// ── parseScenarioFromText ────────────────────────────────────────────────────

describe('parseScenarioFromText', () => {
  it('parses demand increase', async () => {
    const result = await parseScenarioFromText('What if demand increases by 20%?');
    expect(result.overrides.demand_multiplier).toBeCloseTo(1.2);
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.parse_method).toBe('local_regex');
  });

  it('parses demand decrease', async () => {
    const result = await parseScenarioFromText('Demand decreases by 15%');
    expect(result.overrides.demand_multiplier).toBeCloseTo(0.85);
  });

  it('parses lead time delay in days', async () => {
    const result = await parseScenarioFromText('Supplier delays lead time by 14 days');
    expect(result.overrides.lead_time_delta_days).toBe(14);
  });

  it('parses lead time delay in weeks', async () => {
    const result = await parseScenarioFromText('What if there is a delay of 3 weeks?');
    expect(result.overrides.lead_time_delta_days).toBe(21);
  });

  it('parses Chinese week delay', async () => {
    const result = await parseScenarioFromText('假設延遲三週');
    expect(result.overrides.lead_time_delta_days).toBe(21);
  });

  it('parses service level target', async () => {
    const result = await parseScenarioFromText('Set service level to 98%');
    expect(result.overrides.service_target).toBeCloseTo(0.98);
  });

  it('parses budget cap with dollar sign', async () => {
    const result = await parseScenarioFromText('Budget cap $100,000');
    expect(result.overrides.budget_cap).toBe(100000);
  });

  it('parses budget in Chinese 萬', async () => {
    const result = await parseScenarioFromText('預算 10萬');
    expect(result.overrides.budget_cap).toBe(100000);
  });

  it('parses risk mode', async () => {
    const result = await parseScenarioFromText('Run with risk-aware mode');
    expect(result.overrides.risk_mode).toBe('on');
  });

  it('parses expedite mode', async () => {
    const result = await parseScenarioFromText('Enable expedite shipping');
    expect(result.overrides.expedite_mode).toBe('on');
  });

  it('parses stockout penalty multiplier', async () => {
    const result = await parseScenarioFromText('Stockout penalty 2x');
    expect(result.overrides.stockout_penalty_multiplier).toBe(2);
  });

  it('parses chaos intensity', async () => {
    const result = await parseScenarioFromText('Simulate with high chaos disruption');
    expect(result.overrides.chaos_intensity).toBe('high');
  });

  it('parses simulation scenario type', async () => {
    const result = await parseScenarioFromText('Use volatile scenario mode');
    expect(result.overrides.simulation_scenario).toBe('volatile');
  });

  it('parses compound scenarios', async () => {
    const result = await parseScenarioFromText(
      'What if demand increases by 30% and lead time delays by 2 weeks with risk-aware mode?'
    );
    expect(result.overrides.demand_multiplier).toBeCloseTo(1.3);
    expect(result.overrides.lead_time_delta_days).toBe(14);
    expect(result.overrides.risk_mode).toBe('on');
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it('extracts affected entities', async () => {
    const result = await parseScenarioFromText(
      'What if supplier ABC delays by 3 weeks for material MAT-001 at plant P1?'
    );
    expect(result.affected_entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'supplier', value: 'ABC' }),
        expect.objectContaining({ type: 'material', value: 'MAT-001' }),
        expect.objectContaining({ type: 'plant', value: 'P1' }),
      ])
    );
  });

  it('returns low confidence for unparseable text', async () => {
    const result = await parseScenarioFromText('Hello there');
    expect(result.confidence).toBeLessThan(0.5);
    expect(Object.keys(result.overrides)).toHaveLength(0);
  });

  it('parses lead time reduction with expedite', async () => {
    const result = await parseScenarioFromText('Reduce lead time by 5 days');
    expect(result.overrides.lead_time_buffer_days).toBe(5);
    expect(result.overrides.expedite_mode).toBe('on');
  });
});

// ── validateScenarioOverrides ────────────────────────────────────────────────

describe('validateScenarioOverrides', () => {
  it('passes valid overrides', () => {
    const { valid, errors, sanitized } = validateScenarioOverrides({
      demand_multiplier: 1.2,
      service_target: 0.95,
      budget_cap: 50000,
    });
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
    expect(sanitized.demand_multiplier).toBe(1.2);
  });

  it('clamps out-of-range demand multiplier', () => {
    const { valid, errors, sanitized } = validateScenarioOverrides({
      demand_multiplier: 15,
    });
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    expect(sanitized.demand_multiplier).toBe(10);
  });

  it('clamps out-of-range service target', () => {
    const { sanitized } = validateScenarioOverrides({ service_target: 1.5 });
    expect(sanitized.service_target).toBe(1);
  });

  it('removes non-positive budget cap', () => {
    const { sanitized } = validateScenarioOverrides({ budget_cap: -100 });
    expect(sanitized.budget_cap).toBeUndefined();
  });

  it('clamps lead time delta', () => {
    const { sanitized } = validateScenarioOverrides({ lead_time_delta_days: 365 });
    expect(sanitized.lead_time_delta_days).toBe(180);
  });
});
