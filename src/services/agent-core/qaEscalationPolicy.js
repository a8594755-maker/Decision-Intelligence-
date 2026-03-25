const SOFT_BLOCKER_PATTERNS = [
  /duplicate|dedup|restatement|pseudo-table|formatting|raw json|leaked debug|verbosity|information density/i,
];

const DIMENSION_COVERAGE_PATTERNS = [
  /missing required dimensions/i,
];

function hasSuccessfulToolEvidence(toolCalls = []) {
  return (toolCalls || []).some((toolCall) => {
    const result = toolCall?.result || {};
    if (!result?.success) return false;
    if (Array.isArray(result.rows) && result.rows.length > 0) return true;
    if (result.data) return true;
    if (Number.isFinite(result.rowCount) && result.rowCount > 0) return true;
    if (Number.isFinite(result?.result?.rowCount) && result.result.rowCount > 0) return true;
    return false;
  });
}

function inferSoftBlockers(blockers = []) {
  return blockers.filter((blocker) => SOFT_BLOCKER_PATTERNS.some((pattern) => pattern.test(String(blocker || ''))));
}

export function resolveQaEscalationMode({
  qa = null,
  toolCalls = [],
  forceOptimizer = false,
  lowScoreThreshold = null,
  lowScoreAction = 'none',
  softBlockerAction = 'none',
} = {}) {
  if (forceOptimizer) {
    return { mode: 'full_optimizer', reasons: ['forced_full_thinking'] };
  }

  const blockers = Array.isArray(qa?.blockers) ? qa.blockers : [];
  const explicitSoftBlockers = Array.isArray(qa?.soft_blockers) ? qa.soft_blockers : [];
  const explicitHardBlockers = Array.isArray(qa?.hard_blockers) ? qa.hard_blockers : [];
  const softBlockers = explicitSoftBlockers.length > 0 ? explicitSoftBlockers : inferSoftBlockers(blockers);
  const hardBlockers = explicitHardBlockers.length > 0
    ? explicitHardBlockers
    : blockers.filter((blocker) => !softBlockers.includes(blocker));

  if (hardBlockers.length > 0) {
    const onlyDimensionCoverageBlockers = hardBlockers.every((blocker) => (
      DIMENSION_COVERAGE_PATTERNS.some((pattern) => pattern.test(String(blocker || '')))
    ));

    if (onlyDimensionCoverageBlockers && hasSuccessfulToolEvidence(toolCalls)) {
      return {
        mode: softBlockerAction,
        reasons: ['dimension_coverage_with_evidence'],
      };
    }

    return {
      mode: 'full_optimizer',
      reasons: ['hard_blockers'],
    };
  }

  if (softBlockers.length > 0 && softBlockerAction !== 'none') {
    return {
      mode: softBlockerAction,
      reasons: ['soft_blockers'],
    };
  }

  const score = Number(qa?.score || 0);
  if (Number.isFinite(lowScoreThreshold) && score < lowScoreThreshold && lowScoreAction !== 'none') {
    return {
      mode: lowScoreAction,
      reasons: ['low_score'],
    };
  }

  return { mode: 'none', reasons: [] };
}

export default {
  resolveQaEscalationMode,
};
