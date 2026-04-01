import { describe, it, expect } from 'vitest';
import { buildAgentCard, buildAllAgentCards, getTemplateIds } from './agentCardBuilder.js';

const BASE_URL = 'http://localhost:3100';

describe('getTemplateIds', () => {
  it('returns all 4 worker template IDs', () => {
    const ids = getTemplateIds();
    expect(ids).toContain('supply_chain_analyst');
    expect(ids).toContain('procurement_specialist');
    expect(ids).toContain('data_analyst');
    expect(ids).toContain('operations_coordinator');
    expect(ids).toHaveLength(4);
  });
});

describe('buildAgentCard', () => {
  it('builds a valid agent card for supply_chain_analyst', () => {
    const card = buildAgentCard('supply_chain_analyst', BASE_URL);
    expect(card).not.toBeNull();
    expect(card.name).toBe('DI Supply Chain Analyst');
    expect(card.url).toBe(`${BASE_URL}/a2a/supply_chain_analyst`);
    expect(card.protocolVersion).toBe('0.3.0');
    expect(card.capabilities.streaming).toBe(true);
  });

  it('includes skills derived from allowed capabilities', () => {
    const card = buildAgentCard('supply_chain_analyst', BASE_URL);
    expect(card.skills.length).toBeGreaterThan(0);
    // Supply chain analyst should have forecast, plan, risk tools
    const skillIds = card.skills.map(s => s.id);
    expect(skillIds).toContain('run_forecast');
    expect(skillIds).toContain('run_plan');
  });

  it('skills have required A2A fields', () => {
    const card = buildAgentCard('supply_chain_analyst', BASE_URL);
    for (const skill of card.skills) {
      expect(skill).toHaveProperty('id');
      expect(skill).toHaveProperty('name');
      expect(skill).toHaveProperty('description');
      expect(skill.inputModes).toContain('text/plain');
      expect(skill.outputModes).toContain('application/json');
    }
  });

  it('procurement_specialist includes negotiation tools', () => {
    const card = buildAgentCard('procurement_specialist', BASE_URL);
    const skillIds = card.skills.map(s => s.id);
    expect(skillIds).toContain('run_negotiation');
  });

  it('returns null for unknown template', () => {
    expect(buildAgentCard('nonexistent', BASE_URL)).toBeNull();
  });

  it('includes security schemes', () => {
    const card = buildAgentCard('data_analyst', BASE_URL);
    expect(card.securitySchemes).toHaveProperty('bearer');
    expect(card.securitySchemes).toHaveProperty('apiKey');
  });

  it('includes provider information', () => {
    const card = buildAgentCard('data_analyst', BASE_URL);
    expect(card.provider.organization).toBe('Decision-Intelligence Platform');
  });
});

describe('buildAllAgentCards', () => {
  it('builds cards for all templates', () => {
    const cards = buildAllAgentCards(BASE_URL);
    expect(cards).toHaveLength(4);
    const names = cards.map(c => c.name);
    expect(names).toContain('DI Supply Chain Analyst');
    expect(names).toContain('DI Procurement Specialist');
    expect(names).toContain('DI Data Analyst');
    expect(names).toContain('DI Operations Coordinator');
  });

  it('all cards have unique URLs', () => {
    const cards = buildAllAgentCards(BASE_URL);
    const urls = cards.map(c => c.url);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
