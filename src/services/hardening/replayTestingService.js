/**
 * replayTestingService.js — Decision pipeline replay testing
 *
 * Captures decision pipeline snapshots and replays them for regression testing.
 * Ensures that:
 *   1. Same input → same artifacts (deterministic replay)
 *   2. Export schemas remain stable across versions
 *   3. ERP payloads round-trip correctly
 *   4. Idempotency keys prevent duplicate publishes on replay
 *
 * @module services/hardening/replayTestingService
 */

import { validateExportSchema, normalizeExportRows } from './exportSchemaValidator.js';
import { validateRoundTrip } from './erpPayloadStabilizer.js';
import { checkIdempotency } from './idempotencyService.js';
import { checkAuditCompleteness } from './auditTrailService.js';

// ── Snapshot Format ─────────────────────────────────────────────────────────

/**
 * Capture a decision pipeline snapshot for replay testing.
 *
 * @param {Object} params
 * @param {Object} params.workOrder - Decision Work Order
 * @param {Object[]} params.steps - Executed steps with artifacts
 * @param {Object} params.decisionBrief - decision_brief artifact
 * @param {Object} params.evidencePack - evidence_pack artifact
 * @param {Object} params.writebackPayload - writeback_payload artifact
 * @param {Object} [params.exportArtifact] - spreadsheet_export artifact
 * @param {Object} [params.resolution] - Review resolution
 * @param {Object[]} [params.auditEntries] - Audit trail entries
 * @returns {Object} Replay snapshot
 */
export function captureSnapshot({
  workOrder,
  steps = [],
  decisionBrief = null,
  evidencePack = null,
  writebackPayload = null,
  exportArtifact = null,
  resolution = null,
  auditEntries = [],
}) {
  return {
    snapshot_version: '1.0',
    captured_at: new Date().toISOString(),
    input: {
      work_order: workOrder,
      step_count: steps.length,
    },
    artifacts: {
      decision_brief: decisionBrief,
      evidence_pack: evidencePack,
      writeback_payload: writebackPayload,
      spreadsheet_export: exportArtifact,
    },
    resolution,
    audit_trail: auditEntries,
    checksums: _computeChecksums({
      decisionBrief,
      evidencePack,
      writebackPayload,
      exportArtifact,
    }),
  };
}

/**
 * Replay a snapshot and validate all invariants.
 *
 * @param {Object} snapshot - Previously captured snapshot
 * @param {Object} [currentArtifacts] - Current run artifacts to compare
 * @returns {{ passed: boolean, results: Object[] }}
 */
export function replayAndValidate(snapshot, currentArtifacts = null) {
  const results = [];

  // Test 1: Export schema stability
  if (snapshot.artifacts?.spreadsheet_export) {
    const exportCheck = validateExportSchema({
      data: snapshot.artifacts.spreadsheet_export.data || [],
    });
    results.push({
      test: 'export_schema_stability',
      passed: exportCheck.valid,
      errors: exportCheck.errors,
      warnings: exportCheck.warnings,
    });
  }

  // Test 2: ERP payload round-trip
  if (snapshot.artifacts?.writeback_payload) {
    const rtCheck = validateRoundTrip(snapshot.artifacts.writeback_payload);
    results.push({
      test: 'erp_payload_round_trip',
      passed: rtCheck.ok,
      errors: rtCheck.errors,
    });
  }

  // Test 3: Idempotency key uniqueness
  if (snapshot.artifacts?.writeback_payload?.idempotency_key) {
    const idemCheck = checkIdempotency(
      snapshot.artifacts.writeback_payload.idempotency_key,
      'replay_test',
    );
    results.push({
      test: 'idempotency_key_check',
      passed: !idemCheck.exists,
      info: idemCheck.exists ? 'Key already used — replay would be deduplicated' : 'Key available',
    });
  }

  // Test 4: Audit trail completeness
  if (snapshot.audit_trail?.length > 0) {
    const auditCheck = checkAuditCompleteness(snapshot.audit_trail);
    results.push({
      test: 'audit_trail_completeness',
      passed: auditCheck.complete,
      score: auditCheck.score,
      missing: auditCheck.missing,
    });
  }

  // Test 5: Artifact determinism (compare with current run if provided)
  if (currentArtifacts) {
    const deterministicCheck = _checkDeterminism(snapshot, currentArtifacts);
    results.push({
      test: 'artifact_determinism',
      passed: deterministicCheck.passed,
      diffs: deterministicCheck.diffs,
    });
  }

  // Test 6: Checksum verification
  if (snapshot.checksums) {
    const checksumCheck = _verifyChecksums(snapshot);
    results.push({
      test: 'checksum_integrity',
      passed: checksumCheck.passed,
      details: checksumCheck.details,
    });
  }

  const passed = results.every(r => r.passed);

  return {
    passed,
    results,
    summary: {
      total: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
    },
  };
}

/**
 * Run a full replay test suite against multiple snapshots.
 *
 * @param {Object[]} snapshots - Array of captured snapshots
 * @returns {{ passed: boolean, total: number, results: Object[] }}
 */
export function runReplayTestSuite(snapshots) {
  const suiteResults = snapshots.map((snapshot, i) => {
    const result = replayAndValidate(snapshot);
    return {
      snapshot_index: i,
      captured_at: snapshot.captured_at,
      ...result,
    };
  });

  return {
    passed: suiteResults.every(r => r.passed),
    total: suiteResults.length,
    results: suiteResults,
  };
}

// ── Internal Helpers ────────────────────────────────────────────────────────

function _computeChecksums({ decisionBrief, evidencePack, writebackPayload, exportArtifact }) {
  const checksums = {};

  if (decisionBrief) {
    checksums.decision_brief = _hashObject({
      recommended_action: decisionBrief.recommended_action,
      confidence: decisionBrief.confidence,
      risk_count: decisionBrief.risk_flags?.length || 0,
    });
  }

  if (writebackPayload) {
    checksums.writeback_payload = _hashObject({
      mutation_count: writebackPayload.intended_mutations?.length || 0,
      target_system: writebackPayload.target_system,
      idempotency_key: writebackPayload.idempotency_key,
    });
  }

  if (exportArtifact) {
    checksums.export = _hashObject({
      row_count: exportArtifact.row_count || exportArtifact.data?.length || 0,
      format: exportArtifact.format,
    });
  }

  return checksums;
}

function _hashObject(obj) {
  const str = JSON.stringify(obj);
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

function _checkDeterminism(snapshot, currentArtifacts) {
  const diffs = [];

  if (snapshot.artifacts?.writeback_payload && currentArtifacts?.writeback_payload) {
    const orig = snapshot.artifacts.writeback_payload;
    const curr = currentArtifacts.writeback_payload;

    if (orig.intended_mutations?.length !== curr.intended_mutations?.length) {
      diffs.push(`Mutation count: ${orig.intended_mutations?.length} → ${curr.intended_mutations?.length}`);
    }
    if (orig.target_system !== curr.target_system) {
      diffs.push(`Target system: ${orig.target_system} → ${curr.target_system}`);
    }
  }

  if (snapshot.artifacts?.spreadsheet_export && currentArtifacts?.spreadsheet_export) {
    const origRows = snapshot.artifacts.spreadsheet_export.data?.length || 0;
    const currRows = currentArtifacts.spreadsheet_export.data?.length || 0;
    if (origRows !== currRows) {
      diffs.push(`Export row count: ${origRows} → ${currRows}`);
    }
  }

  return { passed: diffs.length === 0, diffs };
}

function _verifyChecksums(snapshot) {
  const current = _computeChecksums({
    decisionBrief: snapshot.artifacts?.decision_brief,
    evidencePack: snapshot.artifacts?.evidence_pack,
    writebackPayload: snapshot.artifacts?.writeback_payload,
    exportArtifact: snapshot.artifacts?.spreadsheet_export,
  });

  const details = {};
  let allMatch = true;

  for (const [key, expected] of Object.entries(snapshot.checksums || {})) {
    const actual = current[key];
    const match = actual === expected;
    details[key] = { expected, actual, match };
    if (!match) allMatch = false;
  }

  return { passed: allMatch, details };
}
