/**
 * featureGateService.js
 *
 * Central feature flag registry for Decision-Intelligence.
 * All features default to OFF. Enable individually via VITE_FEATURE_* env vars.
 *
 * Usage:
 *   import { isEnabled, FEATURES } from '../config/featureGateService';
 *   if (isEnabled(FEATURES.FORECAST)) { ... }
 *
 * To enable a feature, set in .env.local:
 *   VITE_FEATURE_FORECAST=true
 */

// ── Feature IDs ──────────────────────────────────────────────────────────────

export const FEATURES = {
  // Core planning pipeline
  FORECAST:       'forecast',
  PLAN:           'plan',
  WORKFLOW_A:     'workflow_a',
  WORKFLOW_B:     'workflow_b',
  TOPOLOGY:       'topology',

  // Analysis
  WHAT_IF:        'what_if',
  COMPARE_PLANS:  'compare_plans',
  DIGITAL_TWIN:   'digital_twin',

  // Risk
  RISK_AWARE:     'risk_aware',
  PROACTIVE_ALERTS: 'proactive_alerts',
  MACRO_ORACLE:   'macro_oracle',

  // Governance
  NEGOTIATION:    'negotiation',
  APPROVAL:       'approval',

  // AI Employee
  AI_EMPLOYEE:    'ai_employee',
  RALPH_LOOP:     'ralph_loop',

  // Intake
  EMAIL_INTAKE:   'email_intake',
  TRANSCRIPT_INTAKE: 'transcript_intake',

  // Integrations
  EXCEL_OPS:      'excel_ops',
  OPENCLOUD:      'opencloud',

  // Data management
  DATASET_REUSE:  'dataset_reuse',
  RETRAIN:        'retrain',
};

// ── Feature → Intent mapping ─────────────────────────────────────────────────
// Maps each feature flag to the intents it gates.

const FEATURE_TO_INTENTS = {
  [FEATURES.FORECAST]:     ['RUN_FORECAST'],
  [FEATURES.PLAN]:         ['RUN_PLAN'],
  [FEATURES.WORKFLOW_A]:   ['RUN_WORKFLOW_A'],
  [FEATURES.WORKFLOW_B]:   ['RUN_WORKFLOW_B'],
  [FEATURES.WHAT_IF]:      ['WHAT_IF', 'CHANGE_PARAM'],
  [FEATURES.COMPARE_PLANS]:['COMPARE_PLANS'],
  [FEATURES.DIGITAL_TWIN]: ['RUN_DIGITAL_TWIN'],
  [FEATURES.NEGOTIATION]:  ['ACCEPT_NEGOTIATION_OPTION'],
  [FEATURES.APPROVAL]:     ['APPROVE', 'REJECT'],
  // ASSIGN_TASK removed from intent routing — now triggered via /task slash command only
};

// ── Feature → Action ID mapping ──────────────────────────────────────────────
// Maps each feature flag to the action IDs it gates.

const FEATURE_TO_ACTIONS = {
  [FEATURES.FORECAST]:     ['run_forecast'],
  [FEATURES.PLAN]:         ['run_plan', 'run_risk_plan'],
  [FEATURES.WORKFLOW_A]:   ['run_workflow_a'],
  [FEATURES.WORKFLOW_B]:   ['run_workflow_b'],
  [FEATURES.WHAT_IF]:      ['run_what_if'],
  [FEATURES.COMPARE_PLANS]:['compare_plans', 'compare_scenarios'],
  [FEATURES.DIGITAL_TWIN]: ['run_simulation'],
  [FEATURES.RISK_AWARE]:   ['run_risk_plan'],
  [FEATURES.NEGOTIATION]:  ['start_negotiation', 'review_negotiation'],
  [FEATURES.APPROVAL]:     ['request_approval', 'review_approval', 'build_evidence_pack'],
  // assign_task action button removed — use /task slash command instead
};

// ── Feature → Slash command mapping ──────────────────────────────────────────

const FEATURE_TO_COMMANDS = {
  [FEATURES.FORECAST]:          ['/forecast'],
  [FEATURES.PLAN]:              ['/plan'],
  [FEATURES.WORKFLOW_A]:        ['/workflowa', '/run-workflow-a'],
  [FEATURES.WORKFLOW_B]:        ['/workflowb', '/run-workflow-b', '/risk'],
  [FEATURES.TOPOLOGY]:          ['/topology'],
  [FEATURES.MACRO_ORACLE]:      ['/macro-oracle', '/oracle'],
  [FEATURES.RALPH_LOOP]:        ['/ralph-loop', '/ralph', '/ralph-stop', '/ralph-cancel'],
  [FEATURES.EMAIL_INTAKE]:      ['/email'],
  [FEATURES.TRANSCRIPT_INTAKE]: ['/transcript'],
  [FEATURES.DATASET_REUSE]:     ['/reuse'],
  [FEATURES.RETRAIN]:           ['/retrain'],
  [FEATURES.AI_EMPLOYEE]:       ['/task'],
};

// ── Internal state ───────────────────────────────────────────────────────────

const _flags = {};

// Build reverse lookup maps
const _intentToFeature = {};
for (const [feature, intents] of Object.entries(FEATURE_TO_INTENTS)) {
  for (const intent of intents) {
    _intentToFeature[intent] = feature;
  }
}

const _actionToFeature = {};
for (const [feature, actions] of Object.entries(FEATURE_TO_ACTIONS)) {
  for (const action of actions) {
    _actionToFeature[action] = feature;
  }
}

const _commandToFeature = {};
for (const [feature, commands] of Object.entries(FEATURE_TO_COMMANDS)) {
  for (const cmd of commands) {
    _commandToFeature[cmd] = feature;
  }
}

// ── Initialize from env ──────────────────────────────────────────────────────

function _initFromEnv() {
  const allFeatures = Object.values(FEATURES);
  for (const feature of allFeatures) {
    const envKey = `VITE_FEATURE_${feature.toUpperCase()}`;
    const envVal = import.meta.env?.[envKey];
    _flags[feature] = envVal === 'true' || envVal === '1' || envVal === true;
  }
}

_initFromEnv();

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if a feature is enabled.
 * @param {string} featureId - One of FEATURES.*
 * @returns {boolean}
 */
export function isEnabled(featureId) {
  return _flags[featureId] === true;
}

/**
 * Check if an intent is allowed by feature flags.
 * GENERAL_CHAT and QUERY_DATA are always allowed.
 * @param {string} intentName - e.g. 'RUN_PLAN'
 * @returns {boolean}
 */
export function isIntentEnabled(intentName) {
  if (intentName === 'GENERAL_CHAT' || intentName === 'QUERY_DATA') return true;
  const feature = _intentToFeature[intentName];
  if (!feature) return true; // Unknown intents pass through
  return isEnabled(feature);
}

/**
 * Check if an action button is allowed by feature flags.
 * upload_dataset and confirm_contract are always allowed.
 * @param {string} actionId - e.g. 'run_forecast'
 * @returns {boolean}
 */
export function isActionEnabled(actionId) {
  if (actionId === 'upload_dataset' || actionId === 'confirm_contract') return true;
  const feature = _actionToFeature[actionId];
  if (!feature) return true; // Unknown actions pass through
  return isEnabled(feature);
}

/**
 * Check if a slash command is allowed by feature flags.
 * /reset_data and /workflow are always allowed.
 * @param {string} command - e.g. '/forecast' (lowercase, first word only)
 * @returns {boolean}
 */
export function isCommandEnabled(command) {
  if (command === '/reset_data' || command === '/workflow') return true;
  const feature = _commandToFeature[command];
  if (!feature) return true; // Unknown commands pass through
  return isEnabled(feature);
}

/**
 * Enable a feature at runtime (for testing / dev tools).
 * @param {string} featureId
 * @param {boolean} enabled
 */
export function setFeature(featureId, enabled) {
  _flags[featureId] = Boolean(enabled);
}

/**
 * Enable all features at once.
 */
export function enableAll() {
  for (const feature of Object.values(FEATURES)) {
    _flags[feature] = true;
  }
}

/**
 * Disable all features at once.
 */
export function disableAll() {
  for (const feature of Object.values(FEATURES)) {
    _flags[feature] = false;
  }
}

/**
 * Get current state of all flags (for debugging / admin UI).
 * @returns {Object} { [featureId]: boolean }
 */
export function getAllFlags() {
  return { ..._flags };
}

/**
 * Get list of enabled features.
 * @returns {string[]}
 */
export function getEnabledFeatures() {
  return Object.entries(_flags)
    .filter(([, v]) => v)
    .map(([k]) => k);
}

/**
 * Get disabled-feature message for chat.
 * @param {string} featureName
 * @returns {string}
 */
export function getDisabledMessage(featureName) {
  return `This feature (**${featureName}**) is not enabled. To enable it, set \`VITE_FEATURE_${featureName.toUpperCase()}=true\` in \`.env.local\` and restart the app.`;
}

// Expose on window for dev console access
if (typeof window !== 'undefined') {
  window.__DI_FEATURES = {
    isEnabled,
    setFeature,
    enableAll,
    disableAll,
    getAllFlags,
    getEnabledFeatures,
    FEATURES,
  };
}

export default {
  FEATURES,
  isEnabled,
  isIntentEnabled,
  isActionEnabled,
  isCommandEnabled,
  setFeature,
  enableAll,
  disableAll,
  getAllFlags,
  getEnabledFeatures,
  getDisabledMessage,
};
