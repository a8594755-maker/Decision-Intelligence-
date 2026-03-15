/**
 * Style Retrieval Composer
 *
 * At generation time, composes the complete style context for the LLM.
 * Pulls from all knowledge sources:
 *   1. Style Profile (canonical style for this doc type)
 *   2. Policies (company rules, glossary, KPI definitions)
 *   3. Exemplars (approved output skeletons)
 *   4. Feedback Rules (learned from manager revisions)
 *
 * Returns a structured context block that gets injected into the LLM system prompt.
 */
import { getProfile } from './styleProfileService.js';
import { getPoliciesForDocType, buildPolicySummary } from './policyIngestionService.js';
import { getBestExemplars, buildExemplarSummary } from './exemplarService.js';
import { listRules, buildRulesSummary } from './feedbackStyleExtractor.js';

// ─── Max sizes for context budget ────────────────────────────
const MAX_STYLE_CONTEXT_CHARS = 6000;  // total budget for style context in prompt
const SECTION_BUDGETS = {
  profile: 1500,
  policies: 2000,
  exemplars: 1500,
  rules: 1000,
};

// ─── Main Composer ───────────────────────────────────────────

/**
 * Compose the full style context for a generation task.
 *
 * @param {object} params
 * @param {string} params.employeeId
 * @param {string} params.docType - the type of document being generated
 * @param {string} [params.teamId]
 * @param {object} [params.overrides] - manual overrides (e.g. specific tone request)
 * @returns {{ styleContext: string, metadata: object }}
 */
export async function composeStyleContext({ employeeId, docType, teamId, overrides = {} }) {
  // Fetch all sources in parallel
  const [profile, policies, exemplars, rules] = await Promise.all([
    getProfile(employeeId, docType, teamId).catch(() => null),
    getPoliciesForDocType(employeeId, docType).catch(() => []),
    getBestExemplars(employeeId, docType, { limit: 2, teamId }).catch(() => []),
    listRules(employeeId, { activeOnly: true }).catch(() => []),
  ]);

  // Build each section
  const profileBlock = profile ? buildProfileBlock(profile) : '';
  const policyBlock = buildPolicySummary(policies);
  const exemplarBlock = buildExemplarSummary(exemplars);
  const rulesBlock = buildRulesSummary(rules);

  // Apply overrides
  const overrideBlock = Object.keys(overrides).length
    ? buildOverrideBlock(overrides)
    : '';

  // Assemble with budget limits
  const sections = [
    truncate(profileBlock, SECTION_BUDGETS.profile),
    truncate(policyBlock, SECTION_BUDGETS.policies),
    truncate(exemplarBlock, SECTION_BUDGETS.exemplars),
    truncate(rulesBlock, SECTION_BUDGETS.rules),
    overrideBlock,
  ].filter(Boolean);

  const styleContext = sections.join('\n\n');
  const finalContext = styleContext.length > MAX_STYLE_CONTEXT_CHARS
    ? styleContext.slice(0, MAX_STYLE_CONTEXT_CHARS) + '\n[...truncated for context budget]'
    : styleContext;

  return {
    styleContext: finalContext,
    metadata: {
      has_profile: !!profile,
      profile_confidence: profile?.confidence || 0,
      policy_count: policies.length,
      exemplar_count: exemplars.length,
      rule_count: rules.length,
      has_overrides: Object.keys(overrides).length > 0,
      total_chars: finalContext.length,
    },
  };
}

/**
 * Compose a minimal style context (for low-budget / fast tasks).
 * Only includes profile and highest-priority policies.
 */
export async function composeMinimalStyleContext({ employeeId, docType, teamId }) {
  const [profile, policies] = await Promise.all([
    getProfile(employeeId, docType, teamId).catch(() => null),
    getPoliciesForDocType(employeeId, docType).catch(() => []),
  ]);

  const profileBlock = profile ? buildProfileBlock(profile) : '';
  const topPolicies = policies.slice(0, 5);
  const policyBlock = buildPolicySummary(topPolicies);

  const styleContext = [profileBlock, policyBlock].filter(Boolean).join('\n\n');

  return {
    styleContext: truncate(styleContext, 2000),
    metadata: { has_profile: !!profile, policy_count: topPolicies.length, minimal: true },
  };
}

// ─── Section Builders ────────────────────────────────────────

function buildProfileBlock(profile) {
  const lines = ['=== Document Style Profile ==='];
  lines.push(`Type: ${profile.doc_type} | Confidence: ${profile.confidence} | Based on ${profile.sample_count} samples`);

  const cs = profile.canonical_structure || {};
  if (cs.typical_sheet_count) lines.push(`Typical sheets: ${cs.typical_sheet_count}`);
  if (cs.common_sheet_names?.length) lines.push(`Sheet names: ${cs.common_sheet_names.join(', ')}`);
  if (cs.has_cover_sheet) lines.push('Include a cover sheet');
  if (cs.has_dashboard_sheet) lines.push('Include a dashboard/summary sheet');

  const cf = profile.canonical_formatting || {};
  if (cf.header_bg_color) lines.push(`Header background: ${cf.header_bg_color}`);
  if (cf.header_font) lines.push(`Header font: ${cf.header_font}`);
  if (cf.common_number_formats?.length) lines.push(`Number formats: ${cf.common_number_formats.join(', ')}`);
  if (cf.has_alternating_rows) lines.push('Use alternating row colors');
  if (cf.has_freeze_panes) lines.push('Freeze header panes');

  const ck = profile.canonical_kpi_layout || {};
  if (ck.position) lines.push(`KPI position: ${ck.position}`);
  if (ck.style) lines.push(`KPI style: ${ck.style}`);
  if (ck.common_kpi_keywords?.length) lines.push(`Key KPIs: ${ck.common_kpi_keywords.join(', ')}`);

  const ct = profile.canonical_text_style || {};
  if (ct.language) lines.push(`Language: ${ct.language}`);
  if (ct.tone) lines.push(`Tone: ${ct.tone}`);
  if (ct.bullet_style && ct.bullet_style !== 'none') lines.push(`Bullet style: ${ct.bullet_style}`);
  if (ct.kpi_naming) lines.push(`KPI naming: ${ct.kpi_naming}`);
  if (ct.sample_phrases?.length) lines.push(`Characteristic phrases: "${ct.sample_phrases.slice(0, 3).join('", "')}"`);

  if (profile.high_variance_dims?.length) {
    lines.push(`Note: These dimensions vary across samples and may need clarification: ${profile.high_variance_dims.join(', ')}`);
  }

  return lines.join('\n');
}

function buildOverrideBlock(overrides) {
  const lines = ['=== Style Overrides (for this task only) ==='];
  for (const [key, value] of Object.entries(overrides)) {
    lines.push(`- ${key}: ${value}`);
  }
  return lines.join('\n');
}

// ─── Post-Generation Style Check ─────────────────────────────

/**
 * Check generated output against style profile and policies.
 * Returns a list of style violations/warnings.
 *
 * @param {object} output - the generated output (artifacts, text, etc.)
 * @param {object} profile - the style profile
 * @param {Array} policies - applicable policies
 * @returns {Array<{ severity: string, dimension: string, message: string }>}
 */
export function checkStyleCompliance(output, profile, policies) {
  const violations = [];

  // Check prohibited terms
  const prohibited = policies.filter(p => p.policy_type === 'prohibited_terms');
  for (const p of prohibited) {
    const terms = p.structured?.terms || [p.content];
    const outputText = JSON.stringify(output).toLowerCase();
    for (const term of terms) {
      if (outputText.includes(term.toLowerCase())) {
        violations.push({
          severity: 'error',
          dimension: 'prohibited_terms',
          message: `Output contains prohibited term: "${term}" (policy: ${p.title})`,
        });
      }
    }
  }

  // Check KPI naming conventions
  if (profile?.canonical_text_style?.kpi_naming) {
    // Basic check — could be extended with specific regex patterns
    violations.push({
      severity: 'info',
      dimension: 'kpi_naming',
      message: `Verify KPI naming follows convention: ${profile.canonical_text_style.kpi_naming}`,
    });
  }

  // Check language consistency
  if (profile?.canonical_text_style?.language) {
    const expected = profile.canonical_text_style.language;
    // Simple heuristic — check if output text matches expected language
    const outputText = typeof output === 'string' ? output : JSON.stringify(output);
    const hasChinese = /[\u4e00-\u9fff]/.test(outputText);
    const hasEnglish = /[a-zA-Z]{5,}/.test(outputText);

    if (expected === 'zh-TW' && !hasChinese && hasEnglish) {
      violations.push({
        severity: 'warning',
        dimension: 'language',
        message: 'Output appears to be in English but style profile expects zh-TW',
      });
    }
  }

  return violations;
}

// ─── Helpers ─────────────────────────────────────────────────

function truncate(text, maxLen) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n[...truncated]';
}

export const _testExports = { buildProfileBlock, buildOverrideBlock, checkStyleCompliance, truncate };
