/**
 * hardening/index.js — Integration Hardening Module (Phase 7 + 8)
 *
 * Central export for all hardening services.
 */

// Phase 7.1 — Export Schema Stabilization
export {
  buildStableExport,
  validateSchemaCompatibility,
  getSchemaFingerprint,
  SCHEMA_VERSION,
} from './exportSchemaStabilizer.js';

// Phase 7.2 — ERP Payload Schema
export {
  buildStableErpPayload,
  validateRoundTrip,
  generateFixture,
  ERP_SCHEMA_VERSION,
  SAP_IDOC_FULL_FIXTURES,
} from './erpPayloadStabilizer.js';

// Phase 7.3 — Idempotency
export {
  checkIdempotency,
  acquireLock,
  markCompleted,
  markFailed,
  getStats as getIdempotencyStats,
} from './idempotencyService.js';

// Phase 7.4 — Retry / Recovery
export {
  executeWithRecovery,
  calculateRetryDelay,
  buildPublishAuditEntry,
} from './publishRecoveryService.js';

// Phase 7.5 — Audit Trail
export {
  buildAuditEntry,
  buildFullAuditTrail,
  checkAuditCompleteness,
  formatAuditTrail,
  AUDIT_EVENTS,
} from './auditTrailService.js';

// Phase 7.6 — Signature / Auth / Permission
export {
  generateSignature,
  verifySignature,
  checkPermission,
  authorizeAction,
  validateWebhookSignature,
  PERMISSIONS,
} from './signatureService.js';

// Phase 7.7 — Replay Testing
export {
  captureSnapshot,
  replayAndValidate,
  runReplayTestSuite,
} from './replayTestingService.js';

// Phase 7.8 — Demo Scripts
export {
  runDemoScenario,
  runAllDemos,
  DEMO_SCENARIOS,
} from './demoScriptRunner.js';

// Phase 8 — Multi-Worker Collaboration
export {
  createHandoffChain,
  advanceHandoff,
  createFanOut,
  completeFanOutWorker,
  createEscalation,
  resolveEscalation,
  checkAutoEscalation,
  getDelegation,
  getDelegationsForTask,
  getDelegationsForWorker,
  getChainStatus,
  getFanOutStatus,
  registerTemplate,
  executeTemplate,
  DELEGATION_TYPES,
  DELEGATION_STATUS,
} from './multiWorkerService.js';
