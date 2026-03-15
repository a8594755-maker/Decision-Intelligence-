// @product: ai-employee
//
// opencloudConfig.js
// ─────────────────────────────────────────────────────────────────────────────
// Configuration constants for OpenCloud EU integration.
// OpenCloud is a self-hosted file management platform (Libre Graph API).
// ─────────────────────────────────────────────────────────────────────────────

// ── Environment variables ──────────────────────────────────────────────────

export const OPENCLOUD_URL = String(import.meta.env.VITE_OPENCLOUD_URL || '').replace(/\/+$/, '');
export const OPENCLOUD_TOKEN = String(import.meta.env.VITE_OPENCLOUD_TOKEN || '');
export const AUTO_SYNC_ENABLED = import.meta.env.VITE_OPENCLOUD_AUTO_SYNC === 'true';

// ── Defaults ───────────────────────────────────────────────────────────────

export const OPENCLOUD_BASE_FOLDER = 'Decision-Intelligence';

export const OPENCLOUD_API_PREFIX = '/graph/v1.0';

// ── Artifact → file extension mapping ──────────────────────────────────────

export const ARTIFACT_TYPE_TO_EXTENSION = {
  report_html: '.html',
  report_json: '.json',
  plan_csv: '.csv',
  forecast_csv: '.csv',
  plan_table: '.json',
  forecast_series: '.json',
  powerbi_dataset: '.json',
  solver_meta: '.json',
  constraint_check: '.json',
  replay_metrics: '.json',
  inventory_projection: '.json',
  risk_adjustments: '.json',
  risk_plan_table: '.json',
  risk_replay_metrics: '.json',
  risk_inventory_projection: '.json',
  plan_comparison: '.json',
  risk_plan_csv: '.csv',
  data_quality_report: '.json',
  decision_bundle: '.json',
  ai_employee_run_summary: '.json',
  ai_review_result: '.json',
  revision_log: '.json',
  dynamic_tool_code: '.js',
  cfr_negotiation_strategy: '.json',
  cfr_negotiation_recommendation: '.json',
  cfr_param_adjustment: '.json',
  negotiation_report: '.json',
  scenario_comparison: '.json',
  evidence_pack: '.json',
  metrics: '.json',
};

// ── Sharing defaults ───────────────────────────────────────────────────────

export const DEFAULT_SHARING_ROLE = 'viewer'; // viewer | editor

// ── Sync retry ─────────────────────────────────────────────────────────────
// Inspired by OpenCloud's postprocessing retry: backoff = BASE × 2^(failures-1)

export const SYNC_RETRY_BASE_MS = 2000;
export const SYNC_RETRY_MAX = 5;

// ── DI Tag Taxonomy ──────────────────────────────────────────────────────
// Tags applied to files uploaded to OpenCloud for classification & search.
// Uses `di:` namespace to avoid conflicts with user tags.

export const DI_TAG_PREFIX = 'di';

export const ARTIFACT_TYPE_TO_TAGS = {
  forecast_series:      [`${DI_TAG_PREFIX}:forecast`],
  forecast_csv:         [`${DI_TAG_PREFIX}:forecast`, `${DI_TAG_PREFIX}:csv`],
  plan_table:           [`${DI_TAG_PREFIX}:plan`],
  plan_csv:             [`${DI_TAG_PREFIX}:plan`, `${DI_TAG_PREFIX}:csv`],
  risk_adjustments:     [`${DI_TAG_PREFIX}:risk`],
  risk_plan_table:      [`${DI_TAG_PREFIX}:plan`, `${DI_TAG_PREFIX}:risk`],
  risk_plan_csv:        [`${DI_TAG_PREFIX}:plan`, `${DI_TAG_PREFIX}:risk`, `${DI_TAG_PREFIX}:csv`],
  report_html:          [`${DI_TAG_PREFIX}:report`],
  report_json:          [`${DI_TAG_PREFIX}:report`],
  decision_bundle:      [`${DI_TAG_PREFIX}:decision`],
  solver_meta:          [`${DI_TAG_PREFIX}:solver`],
  constraint_check:     [`${DI_TAG_PREFIX}:constraint`],
  replay_metrics:       [`${DI_TAG_PREFIX}:replay`],
  inventory_projection: [`${DI_TAG_PREFIX}:inventory`],
  data_quality_report:  [`${DI_TAG_PREFIX}:quality`],
  evidence_pack:        [`${DI_TAG_PREFIX}:evidence`],
  scenario_comparison:  [`${DI_TAG_PREFIX}:scenario`],
  plan_comparison:      [`${DI_TAG_PREFIX}:comparison`],
  cfr_negotiation_strategy: [`${DI_TAG_PREFIX}:negotiation`, `${DI_TAG_PREFIX}:cfr`],
  powerbi_dataset:      [`${DI_TAG_PREFIX}:powerbi`],
};

// ── Auto-distribution defaults ──────────────────────────────────────────

export const AUTO_DISTRIBUTE_ENABLED = import.meta.env.VITE_OPENCLOUD_AUTO_DISTRIBUTE === 'true';
export const AUTO_DISTRIBUTE_RECIPIENTS = (import.meta.env.VITE_OPENCLOUD_DISTRIBUTE_TO || '').split(',').filter(Boolean);

// ── Desktop sync ─────────────────────────────────────────────────────────

export const DESKTOP_SYNC_FOLDER = import.meta.env.VITE_OPENCLOUD_DESKTOP_SYNC_FOLDER || '';

// ── Helpers ────────────────────────────────────────────────────────────────

export function isOpenCloudConfigured() {
  return !!(OPENCLOUD_URL && OPENCLOUD_TOKEN);
}

/**
 * Get DI tags for an artifact type.
 * Always includes the `di:artifact` base tag.
 * @param {string} artifactType
 * @param {string} [taskId]
 * @returns {string[]}
 */
export function getTagsForArtifact(artifactType, taskId) {
  const tags = [`${DI_TAG_PREFIX}:artifact`, ...(ARTIFACT_TYPE_TO_TAGS[artifactType] || [])];
  if (taskId) tags.push(`${DI_TAG_PREFIX}:task:${taskId}`);
  return [...new Set(tags)];
}

export default {
  OPENCLOUD_URL,
  OPENCLOUD_TOKEN,
  AUTO_SYNC_ENABLED,
  AUTO_DISTRIBUTE_ENABLED,
  AUTO_DISTRIBUTE_RECIPIENTS,
  DESKTOP_SYNC_FOLDER,
  OPENCLOUD_BASE_FOLDER,
  OPENCLOUD_API_PREFIX,
  ARTIFACT_TYPE_TO_EXTENSION,
  ARTIFACT_TYPE_TO_TAGS,
  DI_TAG_PREFIX,
  DEFAULT_SHARING_ROLE,
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_MAX,
  isOpenCloudConfigured,
  getTagsForArtifact,
};
