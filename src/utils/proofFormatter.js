/**
 * Shared helpers for formatting solver proof payloads.
 * Pure functions so they can be used in browser and tests.
 */

const TAG_TRANSLATIONS = [
  [/^BUDGET_GLOBAL$/, () => 'Global budget cap'],
  [/^CAP_INV\[(.+?)\]$/, (match) => `Inventory capacity on ${match[1]}`],
  [/^CAP_INV$/, () => 'Inventory capacity'],
  [/^CAP_PROD\[(.+?)\]$/, (match) => `Production capacity on ${match[1]}`],
  [/^CAP_PROD$/, () => 'Production capacity'],
  [/^MOQ\[(.+?)\]$/, (match) => `MOQ for ${match[1]}`],
  [/^MOQ$/, () => 'Minimum order quantity'],
  [/^PACK\[(.+?)\]$/, (match) => `Pack size for ${match[1]}`],
  [/^PACK$/, () => 'Pack-size constraint'],
  [/^MAXQ\[(.+?)\]$/, (match) => `Max order qty for ${match[1]}`],
  [/^MAXQ$/, () => 'Max order quantity'],
  [/^SERVICE_LEVEL_GLOBAL$/, () => 'Service level target'],
  [/^BOM_LINK$/, () => 'BOM component link'],
  [/^CP_FEASIBILITY$/, () => 'Overall model feasibility'],
  [/^BALANCE_INV\[(.+?)\]$/, (match) => `Inventory balance on ${match[1]}`]
];

export function translateConstraintTag(tag, sku) {
  if (!tag) return '';
  for (const [pattern, format] of TAG_TRANSLATIONS) {
    const match = tag.match(pattern);
    if (match) {
      const label = format(match);
      return sku ? `${label} (${sku})` : label;
    }
  }
  return tag;
}

export function constraintLabel(constraint) {
  if (!constraint || typeof constraint !== 'object') return 'Unknown constraint';
  return (
    (constraint.tag && translateConstraintTag(constraint.tag, constraint.sku))
    || constraint.description
    || constraint.name
    || 'Unknown constraint'
  );
}

export function extractBindingConstraints(constraintsChecked) {
  if (!Array.isArray(constraintsChecked)) return [];
  return constraintsChecked.filter(
    (constraint) => constraint?.passed === false || constraint?.binding === true
  );
}

export function formatBindingConstraintsForLLM(bindingConstraints) {
  if (!Array.isArray(bindingConstraints) || bindingConstraints.length === 0) {
    return 'No binding constraints detected.';
  }

  return bindingConstraints
    .map((constraint, index) => {
      const label = constraintLabel(constraint);
      const severity = constraint?.severity ? ` [${constraint.severity}]` : '';
      const details = constraint?.details ? ` - ${String(constraint.details)}` : '';
      const scope = constraint?.scope && constraint.scope !== 'global' ? ` (scope: ${constraint.scope})` : '';
      return `${index + 1}. ${label}${severity}${details}${scope}`;
    })
    .join('\n');
}

export function formatObjectiveTermsForDisplay(objectiveTerms) {
  if (!Array.isArray(objectiveTerms) || objectiveTerms.length === 0) {
    return 'No cost decomposition available.';
  }

  return objectiveTerms
    .map((term) => {
      const value = term?.value;
      let formattedValue = 'n/a';
      if (value !== null && value !== undefined) {
        const num = Number(value);
        if (!Number.isFinite(num)) {
          formattedValue = String(value);
        } else if (/cost|penalty|budget/i.test(String(term?.name || ''))) {
          formattedValue = `$${num.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
        } else {
          formattedValue = num.toLocaleString(undefined, { maximumFractionDigits: 2 });
        }
      }

      const note = term?.note ? ` (${term.note})` : '';
      const normalizedName = String(term?.name || 'term').replace(/_/g, ' ');
      return `- ${normalizedName}: ${formattedValue}${note}`;
    })
    .join('\n');
}

export function buildProofInlineBlock(solverResult) {
  if (!solverResult || typeof solverResult !== 'object') return '';

  const proof = solverResult.proof || {};
  const constraintsChecked = Array.isArray(proof.constraints_checked) ? proof.constraints_checked : [];
  const bindingConstraints = extractBindingConstraints(constraintsChecked).slice(0, 20);
  const objectiveTerms = (Array.isArray(proof.objective_terms) ? proof.objective_terms : []).slice(0, 30);
  const detailRows = Array.isArray(solverResult.infeasible_reason_details)
    ? solverResult.infeasible_reason_details
    : (Array.isArray(solverResult.infeasible_reasons_detailed) ? solverResult.infeasible_reasons_detailed : []);
  const suggestedActions = Array.from(new Set(
    detailRows.flatMap((row) => (Array.isArray(row?.suggested_actions) ? row.suggested_actions : []))
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )).slice(0, 4);

  const status = solverResult.status || 'unknown';
  const gap = solverResult?.solver_meta?.gap;
  const gapText = gap === 0
    ? 'optimal (gap=0)'
    : (gap != null ? `gap=${(Number(gap) * 100).toFixed(2)}%` : 'gap=n/a');

  const lines = [`Solver Proof (status: ${status}, ${gapText})`];

  if (objectiveTerms.length > 0) {
    lines.push('');
    lines.push('Cost Decomposition:');
    lines.push(formatObjectiveTermsForDisplay(objectiveTerms));
  }

  if (bindingConstraints.length > 0) {
    lines.push('');
    lines.push('Binding Constraints:');
    lines.push(formatBindingConstraintsForLLM(bindingConstraints));
  }

  if (suggestedActions.length > 0) {
    lines.push('');
    lines.push('Solver Suggestions:');
    suggestedActions.forEach((action, index) => {
      lines.push(`${index + 1}. ${action}`);
    });
  }

  return lines.join('\n');
}

export function isBudgetCapBinding(solverResult) {
  const constraints = Array.isArray(solverResult?.proof?.constraints_checked)
    ? solverResult.proof.constraints_checked
    : [];
  return constraints.some(
    (constraint) => (
      (constraint?.name === 'budget_cap' || String(constraint?.tag || '').startsWith('BUDGET_GLOBAL'))
      && (constraint?.passed === false || constraint?.binding === true)
    )
  );
}

export function isCapacityBinding(solverResult) {
  const constraints = Array.isArray(solverResult?.proof?.constraints_checked)
    ? solverResult.proof.constraints_checked
    : [];
  return constraints.some(
    (constraint) => (
      (String(constraint?.tag || '').startsWith('CAP_INV') || String(constraint?.tag || '').startsWith('CAP_PROD'))
      && (constraint?.passed === false || constraint?.binding === true)
    )
  );
}
