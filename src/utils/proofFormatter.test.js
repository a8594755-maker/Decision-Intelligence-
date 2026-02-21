import { describe, it, expect } from 'vitest';
import {
  translateConstraintTag,
  extractBindingConstraints,
  formatObjectiveTermsForDisplay,
  buildProofInlineBlock,
  isBudgetCapBinding,
  isCapacityBinding
} from './proofFormatter';

describe('proofFormatter', () => {
  it('translates known tags into business labels', () => {
    expect(translateConstraintTag('BUDGET_GLOBAL')).toBe('Global budget cap');
    expect(translateConstraintTag('CAP_INV[2026-03-01]')).toBe('Inventory capacity on 2026-03-01');
    expect(translateConstraintTag('MOQ[SKU-A]')).toBe('MOQ for SKU-A');
  });

  it('extracts binding constraints by passed/binding flags', () => {
    const constraints = [
      { name: 'budget_cap', passed: false },
      { name: 'inventory_cap', passed: true, binding: true },
      { name: 'rounding_adjustments', passed: true }
    ];
    const result = extractBindingConstraints(constraints);
    expect(result).toHaveLength(2);
    expect(result.map((item) => item.name)).toEqual(['budget_cap', 'inventory_cap']);
  });

  it('formats objective terms with currency for cost-like fields', () => {
    const text = formatObjectiveTermsForDisplay([
      { name: 'ordered_units', value: 240 },
      { name: 'estimated_total_cost', value: 1850.5 }
    ]);
    expect(text).toContain('- ordered units: 240');
    expect(text).toContain('$1,850');
  });

  it('builds a proof block with cost, constraints, and suggestions', () => {
    const block = buildProofInlineBlock({
      status: 'OPTIMAL',
      solver_meta: { gap: 0 },
      proof: {
        objective_terms: [{ name: 'estimated_total_cost', value: 1850 }],
        constraints_checked: [
          { name: 'budget_cap', tag: 'BUDGET_GLOBAL', passed: false, details: 'budget cap hit' }
        ]
      },
      infeasible_reason_details: [
        { suggested_actions: ['Increase budget cap or reduce service level target.'] }
      ]
    });

    expect(block).toContain('Solver Proof (status: OPTIMAL, optimal (gap=0))');
    expect(block).toContain('Cost Decomposition:');
    expect(block).toContain('Binding Constraints:');
    expect(block).toContain('Solver Suggestions:');
    expect(block).toContain('Increase budget cap or reduce service level target.');
  });

  it('detects budget/capacity binding shortcuts', () => {
    const solverResult = {
      proof: {
        constraints_checked: [
          { name: 'budget_cap', tag: 'BUDGET_GLOBAL', passed: false },
          { name: 'inv', tag: 'CAP_INV[2026-03-01]', passed: true, binding: true }
        ]
      }
    };

    expect(isBudgetCapBinding(solverResult)).toBe(true);
    expect(isCapacityBinding(solverResult)).toBe(true);
  });
});
