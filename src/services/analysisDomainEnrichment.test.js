import { describe, it, expect } from 'vitest';
import {
  detectDomain,
  buildDomainEnrichmentPrompt,
  buildParameterSweepInstruction,
  buildChallengerInstruction,
  buildJudgeDomainCriteria,
  extractSupplyChainParams,
  extractBriefSafetyStockValues,
  verifyFormulaConsistency,
  isParameterOptimizationQuestion,
} from './analysisDomainEnrichment.js';

// ── detectDomain ─────────────────────────────────────────────────────────────

describe('detectDomain', () => {
  it('detects supply chain from English safety stock question', () => {
    const result = detectDomain('What should I set for safety stock levels?');
    expect(result.domainKey).toBe('supply_chain');
    expect(result.matchedConcepts).toContain('safety_stock');
  });

  it('detects supply chain from Chinese safety stock question', () => {
    const result = detectDomain('Olist 各品類的安全庫存應該設多少？');
    expect(result.domainKey).toBe('supply_chain');
    expect(result.matchedConcepts).toContain('safety_stock');
  });

  it('detects supply chain from reorder point question', () => {
    const result = detectDomain('Calculate reorder point and EOQ for each category');
    expect(result.domainKey).toBe('supply_chain');
    expect(result.matchedConcepts).toContain('reorder_point');
    expect(result.matchedConcepts).toContain('eoq');
  });

  it('detects supply chain from Chinese replenishment question', () => {
    const result = detectDomain('補貨參數建議和服務水準分析');
    expect(result.domainKey).toBe('supply_chain');
    expect(result.matchedConcepts).toContain('replenishment');
    expect(result.matchedConcepts).toContain('service_level');
  });

  it('returns null domain for non-supply-chain questions', () => {
    const result = detectDomain('Show me revenue trends by category');
    expect(result.domainKey).toBeNull();
    expect(result.matchedConcepts).toHaveLength(0);
  });

  it('handles empty/null input', () => {
    expect(detectDomain('').domainKey).toBeNull();
    expect(detectDomain(null).domainKey).toBeNull();
    expect(detectDomain(undefined).domainKey).toBeNull();
  });
});

// ── buildDomainEnrichmentPrompt ──────────────────────────────────────────────

describe('buildDomainEnrichmentPrompt', () => {
  it('returns recipe-driven prompt when concepts match a recipe', () => {
    const prompt = buildDomainEnrichmentPrompt('supply_chain', ['safety_stock'], 'recommendation');
    // Should get recipe prompt (from analysisRecipeCatalog)
    expect(prompt).toContain('Prescribed Analysis Methodology');
    expect(prompt).toContain('Safety Stock');
    expect(prompt).toContain('run_python_analysis');
    expect(prompt).toContain('1.645');
  });

  it('returns fallback enrichment when no recipe matches', () => {
    // 'lead_time' alone does not trigger any recipe
    const prompt = buildDomainEnrichmentPrompt('supply_chain', ['lead_time']);
    expect(prompt).toContain('SS = Z × √(LT × σ²_d_daily + d̄_daily² × σ²_LT)');
    expect(prompt).toContain('EOQ = √(2DS/H)');
    expect(prompt).toContain('1.645');
  });

  it('returns empty string for unknown domain', () => {
    expect(buildDomainEnrichmentPrompt('unknown', [])).toBe('');
    expect(buildDomainEnrichmentPrompt(null, [])).toBe('');
  });
});

// ── buildParameterSweepInstruction ───────────────────────────────────────────

describe('buildParameterSweepInstruction', () => {
  it('returns sweep instruction for supply_chain', () => {
    const instruction = buildParameterSweepInstruction('supply_chain');
    expect(instruction).toContain('MANDATORY');
    expect(instruction).toContain('90%');
    expect(instruction).toContain('95%');
    expect(instruction).toContain('99%');
    expect(instruction).toContain('Sensitivity Analysis');
  });

  it('returns empty for unknown domain', () => {
    expect(buildParameterSweepInstruction(null)).toBe('');
  });
});

// ── buildChallengerInstruction ───────────────────────────────────────────────

describe('buildChallengerInstruction', () => {
  it('returns domain-specific instruction for supply chain', () => {
    const instruction = buildChallengerInstruction({
      answerContract: { task_type: 'recommendation' },
      domainKey: 'supply_chain',
    });
    expect(instruction).toContain('CHALLENGER analyst for a supply chain');
    expect(instruction).toContain('METHODOLOGY DIVERGENCE');
    expect(instruction).toContain('COVERAGE MANDATE');
    expect(instruction).toContain('STRESS TEST');
    expect(instruction).toContain('periodic-review');
  });

  it('returns generic instruction for non-supply-chain', () => {
    const instruction = buildChallengerInstruction({
      answerContract: { task_type: 'comparison' },
      domainKey: null,
    });
    expect(instruction).toContain('CHALLENGER analyst');
    expect(instruction).toContain('DIFFERENT METHODOLOGY');
    expect(instruction).not.toContain('periodic-review');
  });

  it('injects primary brief summary when available', () => {
    const instruction = buildChallengerInstruction({
      answerContract: {},
      domainKey: 'supply_chain',
      primaryBrief: {
        headline: 'Safety stock ranges from 67 to 258 units',
        key_findings: ['bed_bath_table has highest demand', 'electronics is most volatile'],
        caveats: ['Based on order line count, not actual inventory'],
      },
    });
    expect(instruction).toContain('PRIMARY AGENT SUMMARY');
    expect(instruction).toContain('Safety stock ranges from 67 to 258 units');
    expect(instruction).toContain('bed_bath_table');
    expect(instruction).toContain('verify these numbers');
  });

  it('does not inject primary summary when null', () => {
    const instruction = buildChallengerInstruction({
      answerContract: {},
      domainKey: 'supply_chain',
      primaryBrief: null,
    });
    expect(instruction).not.toContain('PRIMARY AGENT SUMMARY');
  });
});

// ── buildJudgeDomainCriteria ─────────────────────────────────────────────────

describe('buildJudgeDomainCriteria', () => {
  it('returns supply chain criteria', () => {
    const criteria = buildJudgeDomainCriteria('supply_chain');
    expect(criteria).toContain('FORMULA CORRECTNESS');
    expect(criteria).toContain('COVERAGE COMPLETENESS');
    expect(criteria).toContain('SENSITIVITY ANALYSIS');
    expect(criteria).toContain('METHODOLOGY TRANSPARENCY');
    expect(criteria).toContain('PARAMETER REASONABLENESS');
  });

  it('returns empty for unknown domain', () => {
    expect(buildJudgeDomainCriteria(null)).toBe('');
    expect(buildJudgeDomainCriteria('finance')).toBe('');
  });
});

// ── extractSupplyChainParams ─────────────────────────────────────────────────

describe('extractSupplyChainParams', () => {
  it('extracts params from successful query_sap_data results', () => {
    const toolCalls = [{
      name: 'query_sap_data',
      result: {
        success: true,
        result: {
          rows: [
            { category: 'electronics', avg_monthly_demand: 136.4, sd_monthly_demand: 103.1, avg_lead_time_days: 12.7 },
            { category: 'bed_bath_table', avg_monthly_demand: 547.3, sd_monthly_demand: 238.8, avg_lead_time_days: 12.8 },
          ],
        },
      },
    }];
    const params = extractSupplyChainParams(toolCalls);
    expect(params).toHaveLength(2);
    expect(params[0].category).toBe('electronics');
    expect(params[0].demand_mean).toBe(136.4);
    expect(params[0].demand_std).toBe(103.1);
    expect(params[0].lead_time_days).toBe(12.7);
  });

  it('skips failed tool calls', () => {
    const toolCalls = [{
      name: 'query_sap_data',
      result: { success: false, error: 'SQL error' },
    }];
    expect(extractSupplyChainParams(toolCalls)).toHaveLength(0);
  });

  it('extracts lead_time_std when available', () => {
    const toolCalls = [{
      name: 'query_sap_data',
      result: {
        success: true,
        result: {
          rows: [
            { category: 'electronics', avg_monthly_demand: 136.4, sd_monthly_demand: 103.1, avg_lead_time_days: 12.7, sd_lead_time_days: 3.5 },
          ],
        },
      },
    }];
    const params = extractSupplyChainParams(toolCalls);
    expect(params).toHaveLength(1);
    expect(params[0].lead_time_std).toBe(3.5);
  });

  it('sets lead_time_std to null when not available', () => {
    const toolCalls = [{
      name: 'query_sap_data',
      result: {
        success: true,
        result: {
          rows: [
            { category: 'electronics', avg_monthly_demand: 136.4, sd_monthly_demand: 103.1, avg_lead_time_days: 12.7 },
          ],
        },
      },
    }];
    const params = extractSupplyChainParams(toolCalls);
    expect(params).toHaveLength(1);
    expect(params[0].lead_time_std).toBeNull();
  });

  it('skips rows with missing fields', () => {
    const toolCalls = [{
      name: 'query_sap_data',
      result: {
        success: true,
        result: {
          rows: [
            { category: 'electronics', avg_monthly_demand: 136.4 }, // missing std and lead time
          ],
        },
      },
    }];
    expect(extractSupplyChainParams(toolCalls)).toHaveLength(0);
  });
});

// ── extractBriefSafetyStockValues ────────────────────────────────────────────

describe('extractBriefSafetyStockValues', () => {
  it('extracts SS values from brief tables', () => {
    const brief = {
      tables: [{
        title: 'Replenishment Parameters',
        columns: ['Category', 'Monthly Demand', 'Safety Stock', 'Reorder Point'],
        rows: [
          ['electronics', 136.4, 111, 168],
          ['bed_bath_table', 547.3, 258, 492],
        ],
      }],
    };
    const values = extractBriefSafetyStockValues(brief);
    expect(values).toHaveLength(2);
    expect(values[0]).toEqual({ category: 'electronics', safety_stock: 111 });
    expect(values[1]).toEqual({ category: 'bed_bath_table', safety_stock: 258 });
  });

  it('handles Chinese column names', () => {
    const brief = {
      tables: [{
        columns: ['品類', '安全庫存'],
        rows: [['electronics', 111]],
      }],
    };
    const values = extractBriefSafetyStockValues(brief);
    expect(values).toHaveLength(1);
    expect(values[0].safety_stock).toBe(111);
  });

  it('returns empty for tables without SS column', () => {
    const brief = {
      tables: [{
        columns: ['Category', 'Revenue'],
        rows: [['electronics', 50000]],
      }],
    };
    expect(extractBriefSafetyStockValues(brief)).toHaveLength(0);
  });
});

// ── verifyFormulaConsistency ─────────────────────────────────────────────────

describe('verifyFormulaConsistency', () => {
  const toolCalls = [{
    name: 'query_sap_data',
    result: {
      success: true,
      result: {
        rows: [
          { category: 'electronics', avg_monthly_demand: 136.4, sd_monthly_demand: 103.1, avg_lead_time_days: 12.7 },
          { category: 'bed_bath_table', avg_monthly_demand: 547.3, sd_monthly_demand: 238.8, avg_lead_time_days: 12.8 },
        ],
      },
    },
  }];

  it('returns empty when values match formula (within tolerance)', () => {
    // electronics: SS = 1.645 * 103.1 * sqrt(12.7/30) ≈ 110.3
    const brief = {
      tables: [{
        columns: ['Category', 'Safety Stock'],
        rows: [['electronics', 111]],
      }],
    };
    const findings = verifyFormulaConsistency(brief, toolCalls, 'supply_chain');
    expect(findings).toHaveLength(0);
  });

  it('flags significant discrepancies', () => {
    // electronics expected ~110, but brief says 200 (82% off)
    const brief = {
      tables: [{
        columns: ['Category', 'Safety Stock'],
        rows: [['electronics', 200]],
      }],
    };
    const findings = verifyFormulaConsistency(brief, toolCalls, 'supply_chain');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('electronics');
    expect(findings[0]).toContain('difference');
  });

  it('returns empty for non-supply-chain domain', () => {
    const brief = {
      tables: [{ columns: ['Category', 'Safety Stock'], rows: [['electronics', 999]] }],
    };
    expect(verifyFormulaConsistency(brief, toolCalls, 'finance')).toHaveLength(0);
    expect(verifyFormulaConsistency(brief, toolCalls, null)).toHaveLength(0);
  });

  it('handles missing SQL evidence gracefully', () => {
    const brief = {
      tables: [{ columns: ['Category', 'Safety Stock'], rows: [['electronics', 111]] }],
    };
    expect(verifyFormulaConsistency(brief, [], 'supply_chain')).toHaveLength(0);
  });
});

// ── isParameterOptimizationQuestion ──────────────────────────────────────────

describe('isParameterOptimizationQuestion', () => {
  it('detects "how much" questions', () => {
    expect(isParameterOptimizationQuestion('How much safety stock should I set?', 'recommendation')).toBe(true);
  });

  it('detects Chinese parameter questions', () => {
    expect(isParameterOptimizationQuestion('安全庫存應該設多少？', 'recommendation')).toBe(true);
  });

  it('rejects non-recommendation task types', () => {
    expect(isParameterOptimizationQuestion('How much safety stock?', 'lookup')).toBe(false);
  });

  it('rejects questions without parameter optimization intent', () => {
    expect(isParameterOptimizationQuestion('Show me the data', 'recommendation')).toBe(false);
  });
});
