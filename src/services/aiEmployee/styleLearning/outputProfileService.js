/**
 * Output Profile Service
 *
 * First-wave bridge from the older style-learning pipeline to the newer
 * "company output profile" product language.
 *
 * This layer does not introduce new tables yet. Instead it adapts:
 *   - style_profiles      -> active output profiles
 *   - style_exemplars     -> approved company exemplars
 *   - style_policies      -> company handbook / rules
 *
 * It lets runtime code ask for a manager-facing output profile without caring
 * about the underlying legacy table names.
 */

import { getProfile, listProfiles } from './styleProfileService.js';
import { getBestExemplars } from './exemplarService.js';
import { getPoliciesForDocType } from './policyIngestionService.js';
import { composeStyleContext, composeMinimalStyleContext } from './styleRetrievalComposer.js';

const DELIVERABLE_DOC_TYPE_MAP = {
  manager_brief: 'general_report',
  forecast_memo: 'forecast_memo',
  planning_recommendation: 'planning_recommendation',
  risk_memo: 'risk_memo',
  ops_brief: 'ops_brief',
  risk_adjusted_ops_brief: 'risk_adjusted_ops_brief',
  weekly_business_review: 'weekly_business_review',
  published_business_review: 'published_business_review',
  monthly_business_review: 'monthly_business_review',
};

const WORKFLOW_DOC_TYPE_MAP = {
  forecast: 'forecast_memo',
  plan: 'planning_recommendation',
  risk: 'risk_memo',
  forecast_then_plan: 'ops_brief',
  risk_aware_plan: 'risk_adjusted_ops_brief',
  full_report: 'weekly_business_review',
  full_report_with_publish: 'published_business_review',
  mbr_with_excel: 'monthly_business_review',
};

const FORMAT_DOC_TYPE_MAP = {
  spreadsheet: 'spreadsheet_pack',
  doc: 'general_report',
  bi: 'published_dashboard',
};

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') ?? null;
}

function normalizeIdentifier(value) {
  if (!value) return null;
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || null;
}

export function resolveOutputProfileScope({ inputContext = {}, step = {} } = {}) {
  const explicitDocType = firstDefined(
    inputContext.doc_type,
    inputContext.document_type,
    inputContext.output_profile_doc_type
  );
  const deliverableType = normalizeIdentifier(firstDefined(
    inputContext.deliverable_type,
    inputContext.output_profile_type
  ));
  const workflowType = normalizeIdentifier(firstDefined(
    inputContext.workflow_type,
    inputContext.template_id,
    step.workflow_type,
    step.name
  ));
  const format = normalizeIdentifier(firstDefined(
    inputContext.deliverable_format,
    inputContext.output_format
  ));
  const teamId = normalizeIdentifier(firstDefined(
    inputContext.team_id,
    inputContext.department_id,
    inputContext.business_unit,
    inputContext.team,
    inputContext.org_unit
  ));
  const audience = firstDefined(
    inputContext.deliverable_audience,
    inputContext.audience,
    inputContext.manager_audience
  );
  const channel = firstDefined(
    inputContext.deliverable_channel,
    inputContext.output_channel
  );

  const derivedDocType = explicitDocType
    || DELIVERABLE_DOC_TYPE_MAP[deliverableType]
    || WORKFLOW_DOC_TYPE_MAP[workflowType]
    || FORMAT_DOC_TYPE_MAP[format]
    || 'general_report';

  return {
    docType: normalizeIdentifier(derivedDocType) || 'general_report',
    teamId,
    deliverableType,
    workflowType,
    format,
    audience,
    channel,
    profileName: firstDefined(inputContext.output_profile_name, inputContext.deliverable_label, derivedDocType) || 'default_profile',
  };
}

function mapStoredProfileToOutputProfile(profile, scope) {
  const canonical = profile ? {
    structure: profile.canonical_structure || {},
    formatting: profile.canonical_formatting || {},
    charts: profile.canonical_charts || {},
    kpiLayout: profile.canonical_kpi_layout || {},
    textStyle: profile.canonical_text_style || {},
  } : {};

  return {
    id: profile?.id || null,
    employeeId: profile?.employee_id || null,
    teamId: scope.teamId ?? profile?.team_id ?? null,
    docType: scope.docType || profile?.doc_type || 'general_report',
    profileName: profile?.profile_name || scope.profileName || 'default_profile',
    deliverableType: scope.deliverableType || null,
    audience: scope.audience || null,
    format: scope.format || null,
    channel: scope.channel || null,
    status: profile ? 'active' : 'fallback',
    version: 1,
    source: profile ? 'style_profiles' : 'runtime_fallback',
    confidence: Number(profile?.confidence || 0),
    sampleCount: Number(profile?.sample_count || 0),
    highVarianceDims: profile?.high_variance_dims || [],
    canonical,
  };
}

export async function getActiveOutputProfile({ employeeId, inputContext = {}, step = {} }) {
  const scope = resolveOutputProfileScope({ inputContext, step });
  const profile = await getProfile(employeeId, scope.docType, scope.teamId).catch(() => null);
  return mapStoredProfileToOutputProfile(profile, scope);
}

export async function listOutputProfiles(employeeId) {
  const profiles = await listProfiles(employeeId).catch(() => []);
  return profiles.map((profile) => mapStoredProfileToOutputProfile(profile, {
    docType: profile.doc_type,
    teamId: profile.team_id,
    profileName: profile.profile_name,
    deliverableType: null,
    audience: null,
    format: null,
    channel: null,
  }));
}

export async function listOutputProfileAssets({ employeeId, inputContext = {}, step = {}, exemplarLimit = 3 }) {
  const scope = resolveOutputProfileScope({ inputContext, step });

  const [profile, exemplars, policies] = await Promise.all([
    getProfile(employeeId, scope.docType, scope.teamId).catch(() => null),
    getBestExemplars(employeeId, scope.docType, { limit: exemplarLimit, teamId: scope.teamId }).catch(() => []),
    getPoliciesForDocType(employeeId, scope.docType).catch(() => []),
  ]);

  return {
    scope,
    outputProfile: mapStoredProfileToOutputProfile(profile, scope),
    exemplars,
    policies,
  };
}

export async function composeOutputProfileContext({
  employeeId,
  inputContext = {},
  step = {},
  mode = 'minimal',
  overrides = {},
}) {
  const scope = resolveOutputProfileScope({ inputContext, step });
  const outputProfile = await getActiveOutputProfile({ employeeId, inputContext, step });

  const compose = mode === 'full' ? composeStyleContext : composeMinimalStyleContext;
  const params = {
    employeeId,
    docType: scope.docType,
    teamId: scope.teamId,
  };
  if (mode === 'full') {
    params.overrides = overrides;
  }

  const { styleContext, metadata } = await compose(params).catch(() => ({
    styleContext: '',
    metadata: {},
  }));

  return {
    styleContext: styleContext || null,
    outputProfile,
    metadata: {
      ...metadata,
      scope,
      output_profile_status: outputProfile.status,
      output_profile_source: outputProfile.source,
      output_profile_version: outputProfile.version,
      has_output_profile: outputProfile.status === 'active',
    },
  };
}

export const _testExports = {
  resolveOutputProfileScope,
  normalizeIdentifier,
  mapStoredProfileToOutputProfile,
};

export default {
  getActiveOutputProfile,
  listOutputProfiles,
  listOutputProfileAssets,
  composeOutputProfileContext,
  resolveOutputProfileScope,
};
