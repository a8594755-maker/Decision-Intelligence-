/**
 * E2E Integration Test — Full Decision Pipeline + Multi-Worker Collaboration
 *
 * Tests the complete flow:
 *   1. Event → DWO creation
 *   2. Pipeline → Artifacts (brief + writeback + export)
 *   3. Review → Approval
 *   4. Publish with recovery + idempotency
 *   5. ROI value tracking
 *   6. Multi-worker delegation (handoff → fan-out → escalation)
 *   7. Audit trail completeness
 *   8. Replay validation
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Phase 7 — Hardening services
import { buildStableExport, SCHEMA_VERSION } from './exportSchemaStabilizer.js';
import { buildStableErpPayload, validateRoundTrip, generateFixture } from './erpPayloadStabilizer.js';
import { checkIdempotency, acquireLock, markCompleted, _resetForTesting as resetIdempotency } from './idempotencyService.js';
import { executeWithRecovery } from './publishRecoveryService.js';
import { buildFullAuditTrail, AUDIT_EVENTS } from './auditTrailService.js';
import { authorizeAction, PERMISSIONS, generateSignature, verifySignature } from './signatureService.js';
import { captureSnapshot, replayAndValidate } from './replayTestingService.js';
import { runDemoScenario, DEMO_SCENARIOS } from './demoScriptRunner.js';

// Phase 8 — Multi-worker
import {
  createHandoffChain,
  advanceHandoff,
  createFanOut,
  completeFanOutWorker,
  createEscalation,
  resolveEscalation,
  checkAutoEscalation,
  getChainStatus,
  getFanOutStatus,
  _resetForTesting as resetDelegations,
} from './multiWorkerService.js';

beforeEach(() => {
  resetIdempotency();
  resetDelegations();
});

// ═══════════════════════════════════════════════════════════════════════════
// E2E: Full Decision Pipeline
// ═══════════════════════════════════════════════════════════════════════════

describe('E2E: Full Decision Pipeline', () => {
  it('complete flow: event → artifacts → approval → publish → audit → replay', async () => {
    // ── Step 1: Simulate DWO creation from event ──
    const workOrder = {
      task_id: `e2e-${Date.now().toString(36)}`,
      intent_type: 'inventory_replan',
      worker_id: 'e2e-worker',
      business_domain: 'supply_planning',
      source_channel: 'event_queue',
      risk_level: 'medium',
    };

    // ── Step 2: Build artifacts ──
    const decisionBrief = {
      type: 'decision_brief',
      summary: 'E2E test brief',
      recommended_action: 'replenish_now',
      business_impact: { cost_delta: -3500, service_level_impact: '+2%' },
      risk_flags: ['single_source'],
      confidence: 0.82,
    };

    const writebackPayload = {
      target_system: 'sap_mm',
      idempotency_key: `e2e-idem-${Date.now().toString(36)}`,
      intended_mutations: [
        {
          entity: 'purchase_order',
          action: 'create_po',
          field_changes: {
            material_code: 'MAT-E2E',
            plant_id: 'P10',
            quantity: 250,
            order_date: '2026-04-01',
            delivery_date: '2026-04-15',
            supplier_id: 'SUP-001',
            unit_cost: 30,
          },
        },
      ],
    };

    // ── Step 3: Build stable export ──
    const exportResult = buildStableExport({
      rows: writebackPayload.intended_mutations.map(m => ({
        material_code: m.field_changes.material_code,
        plant_id: m.field_changes.plant_id,
        action: m.action,
        quantity: m.field_changes.quantity,
        supplier_id: m.field_changes.supplier_id,
      })),
      taskId: workOrder.task_id,
      format: 'csv',
    });
    expect(exportResult.ok).toBe(true);
    expect(exportResult.artifact.schema_version).toBe(SCHEMA_VERSION);

    // ── Step 4: Build ERP payload ──
    const erpResult = buildStableErpPayload(writebackPayload);
    expect(erpResult.ok).toBe(true);

    const rtCheck = validateRoundTrip(erpResult.payload);
    expect(rtCheck.ok).toBe(true);

    // ── Step 5: Authorization ──
    const auth = authorizeAction({
      userId: 'e2e-manager',
      role: 'manager',
      action: PERMISSIONS.PUBLISH_EXPORT,
      taskId: workOrder.task_id,
      idempotencyKey: writebackPayload.idempotency_key,
    });
    expect(auth.authorized).toBe(true);

    // ── Step 6: Publish with recovery ──
    const publishResult = await executeWithRecovery({
      idempotencyKey: writebackPayload.idempotency_key,
      operation: 'export',
      taskId: workOrder.task_id,
      executeFn: async () => ({ ok: true, path: `/exports/${workOrder.task_id}.csv` }),
    });
    expect(publishResult.ok).toBe(true);
    expect(publishResult.attempts).toBe(1);

    // ── Step 7: Verify idempotency (re-publish should deduplicate) ──
    const dupResult = await executeWithRecovery({
      idempotencyKey: writebackPayload.idempotency_key,
      operation: 'export',
      taskId: workOrder.task_id,
      executeFn: async () => ({ ok: true }),
    });
    expect(dupResult.deduplicated).toBe(true);

    // ── Step 8: Build audit trail ──
    const auditTrail = buildFullAuditTrail({
      worklogs: [
        { event: 'task_received', task_id: workOrder.task_id, created_at: new Date().toISOString() },
      ],
      steps: [
        { status: 'succeeded', step_name: 'build_brief', artifact_refs: [{ type: 'decision_brief' }] },
      ],
      resolution: {
        decision: 'approved',
        reviewer_id: 'e2e-manager',
        task_id: workOrder.task_id,
        publish_permission: { export: true, writeback: false },
      },
      publishAttempts: [
        { task_id: workOrder.task_id, ok: true, operation: 'export', idempotency_key: writebackPayload.idempotency_key },
      ],
      valueEvents: [
        { task_id: workOrder.task_id, worker_id: 'e2e-worker', value_type: 'cost_saved', value_amount: 3500, confidence: 0.82 },
      ],
    });
    expect(auditTrail.completeness.complete).toBe(true);
    expect(auditTrail.completeness.score).toBeGreaterThan(0.8);

    // ── Step 9: Capture snapshot + replay ──
    const snapshot = captureSnapshot({
      workOrder,
      decisionBrief,
      writebackPayload,
      exportArtifact: exportResult.artifact,
      auditEntries: auditTrail.entries,
    });
    const replayResult = replayAndValidate(snapshot);
    expect(replayResult.passed).toBe(true);
    expect(replayResult.summary.failed).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E2E: Multi-Worker Collaboration Pipeline
// ═══════════════════════════════════════════════════════════════════════════

describe('E2E: Multi-Worker Collaboration Pipeline', () => {
  it('sequential handoff → fan-out → escalation lifecycle', () => {
    // ── Phase 1: Sequential handoff chain ──
    const chain = createHandoffChain({
      parentTaskId: 'complex-task',
      parentWorkerId: 'coordinator',
      workerChain: ['planning', 'risk_assessment', 'procurement'],
      context: { priority: 'high', event_type: 'demand_spike' },
    });
    expect(chain.ok).toBe(true);
    expect(chain.delegations).toHaveLength(3);

    // Planning completes
    const advance1 = advanceHandoff(chain.delegations[0].id, {
      artifacts: ['demand_analysis'],
      recommended_action: 'increase_safety_stock',
    });
    expect(advance1.ok).toBe(true);
    expect(advance1.next.child_worker_id).toBe('risk_assessment');

    // Risk assessment completes
    const advance2 = advanceHandoff(chain.delegations[1].id, {
      artifacts: ['risk_report'],
      risk_level: 'medium',
      confidence: 0.45, // Low confidence!
    });
    expect(advance2.ok).toBe(true);

    // Procurement completes chain
    const advance3 = advanceHandoff(chain.delegations[2].id, {
      artifacts: ['po_draft'],
    });
    expect(advance3.chainComplete).toBe(true);

    // Verify chain status
    const chainStatus = getChainStatus(chain.chainId);
    expect(chainStatus.all_complete).toBe(true);
    expect(chainStatus.completed).toBe(3);

    // ── Phase 2: Fan-out for parallel validation ──
    const fanOut = createFanOut({
      parentTaskId: 'complex-task',
      parentWorkerId: 'coordinator',
      workerIds: ['finance_validator', 'compliance_validator', 'capacity_validator'],
      mergeStrategy: 'majority',
      context: { validating: 'po_draft' },
    });
    expect(fanOut.ok).toBe(true);
    expect(fanOut.delegations).toHaveLength(3);

    // All validators run in parallel and vote
    completeFanOutWorker(fanOut.delegations[0].id, { recommended_action: 'approve', issues: [] });
    completeFanOutWorker(fanOut.delegations[1].id, { recommended_action: 'approve', issues: ['minor_flag'] });
    const mergeResult = completeFanOutWorker(fanOut.delegations[2].id, { recommended_action: 'reject', issues: ['capacity_constraint'] });

    expect(mergeResult.allComplete).toBe(true);
    expect(mergeResult.merged.winning_action).toBe('approve'); // 2 vs 1
    expect(mergeResult.merged.vote_count).toBe(2);

    // ── Phase 3: Auto-escalation check ──
    const escalationCheck = checkAutoEscalation({
      confidence: 0.45,
      riskLevel: 'medium',
      retryCount: 0,
      costImpact: 50000,
    });
    expect(escalationCheck.shouldEscalate).toBe(true);
    expect(escalationCheck.reason).toContain('confidence');

    // Create escalation
    const escalation = createEscalation({
      parentTaskId: 'complex-task',
      parentWorkerId: 'risk_assessment',
      coordinatorId: 'senior_coordinator',
      reason: 'Low confidence in risk assessment (0.45)',
      context: { original_confidence: 0.45 },
    });
    expect(escalation.ok).toBe(true);

    // Coordinator resolves
    const resolved = resolveEscalation(escalation.delegation.id, {
      decision: 'override',
      instructions: 'Proceed with additional safety stock buffer',
      override_confidence: 0.75,
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.delegation.status).toBe('completed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E2E: Demo Scenarios
// ═══════════════════════════════════════════════════════════════════════════

describe('E2E: Demo Scenarios', () => {
  it('inventory_replan demo runs end-to-end', async () => {
    const result = await runDemoScenario(DEMO_SCENARIOS.INVENTORY_REPLAN);
    expect(result.success).toBe(true);
    expect(result.artifacts.decision_brief).toBeTruthy();
    expect(result.artifacts.export).toBeTruthy();
    expect(result.audit.completeness.complete).toBe(true);
    expect(result.replay.passed).toBe(true);
  });

  it('supplier_delay demo runs end-to-end', async () => {
    const result = await runDemoScenario(DEMO_SCENARIOS.SUPPLIER_DELAY);
    expect(result.success).toBe(true);
    expect(result.artifacts.decision_brief.recommended_action).toBe('expedite_alternative');
  });

  it('full_cycle demo exercises complete pipeline', async () => {
    const result = await runDemoScenario(DEMO_SCENARIOS.FULL_CYCLE);
    expect(result.success).toBe(true);
    expect(result.log.length).toBeGreaterThan(5);
    expect(result.publish.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E2E: Signature + Auth Pipeline
// ═══════════════════════════════════════════════════════════════════════════

describe('E2E: Signature + Auth Pipeline', () => {
  it('sign → verify → authorize → publish cycle', async () => {
    const payload = { task_id: 'sig-test', action: 'create_po' };
    const secret = 'e2e-webhook-secret';

    // Sign
    const sig = await generateSignature(payload, secret);
    expect(sig).toBeTruthy();

    // Verify
    const valid = await verifySignature(payload, sig, secret);
    expect(valid).toBe(true);

    // Authorize
    const auth = authorizeAction({
      userId: 'u1',
      role: 'admin',
      action: PERMISSIONS.PUBLISH_WRITEBACK,
      taskId: 'sig-test',
      idempotencyKey: 'k1',
    });
    expect(auth.authorized).toBe(true);
    expect(auth.receipt.receipt_id).toBeTruthy();

    // Publish (simulated)
    const pub = await executeWithRecovery({
      idempotencyKey: `sig-${Date.now()}`,
      operation: 'writeback',
      taskId: 'sig-test',
      executeFn: async () => ({ ok: true }),
    });
    expect(pub.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E2E: SAP IDoc Fixture Pipeline
// ═══════════════════════════════════════════════════════════════════════════

describe('E2E: SAP IDoc Fixture Pipeline', () => {
  it('generate fixture → transform → round-trip → validate', () => {
    // Generate
    const fixture = generateFixture('ORDERS05', {
      material: 'MAT-PROD-001',
      plant: 'P-EU-01',
      quantity: 1000,
      supplier: 'SUP-GLOBAL-01',
    });
    expect(fixture.ok).toBe(true);
    expect(fixture.fixture.IDOC_TYPE).toBe('ORDERS05');

    // Build writeback
    const writebackPayload = {
      target_system: 'sap_mm',
      idempotency_key: `sap-${Date.now()}`,
      intended_mutations: [{
        entity: 'purchase_order',
        action: 'create_po',
        field_changes: {
          material_code: 'MAT-PROD-001',
          plant_id: 'P-EU-01',
          quantity: 1000,
          supplier_id: 'SUP-GLOBAL-01',
        },
      }],
    };

    // Transform to ERP
    const erpResult = buildStableErpPayload(writebackPayload);
    expect(erpResult.ok).toBe(true);
    expect(erpResult.payload.schema_version).toBe('1.0.0');

    // Round-trip
    const rtCheck = validateRoundTrip(erpResult.payload);
    expect(rtCheck.ok).toBe(true);
    expect(rtCheck.record_count).toBe(1);
  });
});
