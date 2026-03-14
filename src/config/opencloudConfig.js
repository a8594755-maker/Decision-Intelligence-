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

// ── Helpers ────────────────────────────────────────────────────────────────

export function isOpenCloudConfigured() {
  return !!(OPENCLOUD_URL && OPENCLOUD_TOKEN);
}

export default {
  OPENCLOUD_URL,
  OPENCLOUD_TOKEN,
  AUTO_SYNC_ENABLED,
  OPENCLOUD_BASE_FOLDER,
  OPENCLOUD_API_PREFIX,
  ARTIFACT_TYPE_TO_EXTENSION,
  DEFAULT_SHARING_ROLE,
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_MAX,
  isOpenCloudConfigured,
};
