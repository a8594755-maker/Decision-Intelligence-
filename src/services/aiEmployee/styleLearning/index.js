/**
 * Style Learning Pipeline — Public API
 *
 * This is the single entry point for the entire Onboarding & Style Learning system.
 * Import from this module to access all style learning capabilities.
 *
 * Architecture:
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │                  Onboarding Service                      │
 *   │  (orchestrates full pipeline: policies → exemplars →     │
 *   │   bulk style → feedback rules → trust metrics)           │
 *   └──────────┬──────────┬──────────┬──────────┬─────────────┘
 *              │          │          │          │
 *   ┌──────────▼──┐ ┌────▼─────┐ ┌──▼─────┐ ┌──▼──────────┐
 *   │  Policy     │ │ Exemplar │ │ Style  │ │ Feedback    │
 *   │  Ingestion  │ │ Service  │ │Profile │ │ Extractor   │
 *   └──────────┬──┘ └────┬─────┘ └──┬─────┘ └──┬──────────┘
 *              │          │          │          │
 *   ┌──────────▼──────────▼──────────▼──────────▼──────────┐
 *   │              Style Extraction Service                  │
 *   │  (Excel/doc → style fingerprints, 90% programmatic)   │
 *   └───────────────────────┬────────────────────────────────┘
 *                           │
 *   ┌───────────────────────▼────────────────────────────────┐
 *   │            Style Retrieval Composer                     │
 *   │  (at generation time: profile + policies + exemplars   │
 *   │   + rules → LLM context block)                         │
 *   └───────────────────────┬────────────────────────────────┘
 *                           │
 *   ┌───────────────────────▼────────────────────────────────┐
 *   │              Trust Metrics Service                      │
 *   │  (first-pass rate, edit distance, autonomy level)       │
 *   └────────────────────────────────────────────────────────┘
 */

// ── Style Extraction (file → fingerprint) ───────────────────
export {
  extractStyleFromExcel,
  enrichTextStyle,
  extractStyleBatch,
} from './styleExtractionService.js';

// ── Style Profile (fingerprints → aggregated profile) ───────
export {
  compileProfile,
  saveProfile,
  getProfile,
  listProfiles,
  deleteProfile,
  updateProfileIncremental,
} from './styleProfileService.js';

// ── Policy Ingestion (handbook/glossary/rules) ──────────────
export {
  POLICY_TYPES,
  createPolicy,
  updatePolicy,
  deactivatePolicy,
  deletePolicy,
  listPolicies,
  getPoliciesForDocType,
  extractPoliciesFromText,
  importPoliciesBatch,
  searchPolicies,
  buildPolicySummary,
} from './policyIngestionService.js';

// ── Exemplar Management (approved output examples) ──────────
export {
  createExemplarFromFile,
  promoteTaskOutput,
  createExemplar,
  getBestExemplars,
  listExemplars,
  recordUsage,
  updateQualityScore,
  approveExemplar,
  deleteExemplar,
  buildExemplarSummary,
} from './exemplarService.js';

// ── Feedback → Style Rules ──────────────────────────────────
export {
  RULE_TYPES,
  extractRulesFromFeedback,
  extractFromSingleRevision,
  listRules,
  verifyRule,
  deactivateRule,
  getRulesReadyForPromotion,
  buildRulesSummary,
} from './feedbackStyleExtractor.js';

// ── Style Retrieval (compose LLM context at generation time) ─
export {
  composeStyleContext,
  composeMinimalStyleContext,
  checkStyleCompliance,
} from './styleRetrievalComposer.js';

// ── Output Profile Bridge (legacy style-learning -> company output profile) ─
export {
  getActiveOutputProfile,
  listOutputProfiles,
  listOutputProfileAssets,
  composeOutputProfileContext,
  resolveOutputProfileScope,
} from './outputProfileService.js';

// ── Company Output Profiles (versioned baseline / proposal lifecycle) ─────
export {
  getActiveCompanyOutputProfile,
  listCompanyOutputProfiles,
  createProfileFromLegacyStyleProfile,
  createOutputProfileProposal,
  approveOutputProfileProposal,
  rejectOutputProfileProposal,
  rollbackOutputProfile,
  mapCompanyProfileRowToOutputProfile,
} from './companyOutputProfileService.js';

// ── Trust & Autonomy Metrics ────────────────────────────────
export {
  computeMetrics as computeTrustMetrics,
  computeAndSave as computeAndSaveTrustMetrics,
  getLatestMetrics,
  getMetricsHistory,
  getAutonomyRecommendation,
} from './trustMetricsService.js';

// ── Onboarding Orchestrator ─────────────────────────────────
export {
  ONBOARDING_STAGES,
  runOnboarding,
  learnFromNewFiles,
  runPeriodicLearning,
  getOnboardingStatus,
} from './onboardingService.js';
