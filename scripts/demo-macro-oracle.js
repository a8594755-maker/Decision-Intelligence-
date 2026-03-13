#!/usr/bin/env node
/**
 * Demo: Macro-Oracle End-to-End Pipeline
 *
 * Simulates: External news → Signal parsing → Risk delta → Closed-loop trigger evaluation
 *            → Negotiation draft generation (with CFR strategy)
 *
 * Usage:
 *   node scripts/demo-macro-oracle.js [scenario]
 *
 * Available scenarios:
 *   semiconductor_fire   — TSMC fab fire, semiconductor price spike
 *   suez_blockage        — Suez Canal blocked, oil price spike
 *   china_rare_earth     — China export controls on rare earth
 *   eu_steel_tariff      — EU anti-dumping tariffs on steel
 *
 * Default: semiconductor_fire
 */

import { fetchAllSignals, DEMO_SCENARIOS } from '../src/services/externalSignalAdapters.js';
import { processExternalSignals } from '../src/services/macroSignalService.js';
import { computePositionBucket } from '../src/services/negotiation/cfr/negotiation-position-buckets.js';
import { computeSupplierTypePriors } from '../src/services/negotiation/cfr/negotiation-types.js';
import { deriveSolverParamsFromStrategy } from '../src/services/negotiation/cfr/cfr-solver-bridge.js';

// Inline minimal risk delta (avoids Vite-only imports in supplierEventConnectorService)
function computeRiskDelta(event) {
  const baseDeltas = { delivery_delay: 15, quality_alert: 20, capacity_change: 10, force_majeure: 40, shipment_status: 8, price_change: 5 };
  const sevMult = { low: 0.5, medium: 1.0, high: 1.5, critical: 2.0 };
  const base = baseDeltas[event.event_type] || 10;
  const delta = Math.round(base * (sevMult[event.severity] || 1.0) * 10) / 10;
  return { risk_score_delta: delta, evidence_refs: [`event_type=${event.event_type}`, `severity=${event.severity}`] };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function section(title) {
  console.log(`\n${BOLD}${CYAN}━━━ ${title} ━━━${RESET}`);
}

function kv(key, value, color = '') {
  console.log(`  ${DIM}${key}:${RESET} ${color}${value}${RESET}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const scenarioKey = process.argv[2] || 'semiconductor_fire';

  if (!DEMO_SCENARIOS[scenarioKey]) {
    console.error(`${RED}Unknown scenario: ${scenarioKey}${RESET}`);
    console.log(`Available: ${Object.keys(DEMO_SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  console.log(`${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  Macro-Oracle Demo: ${DEMO_SCENARIOS[scenarioKey].label.padEnd(38)}║${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}`);

  // ── Step 1: Fetch external signals ────────────────────────────────────────
  section('Step 1: Fetch External Signals');

  const externalData = await fetchAllSignals({ demoScenario: scenarioKey });
  kv('Source', externalData.source, CYAN);
  kv('Commodity prices', externalData.commodityPrices.length);
  kv('Geopolitical events', externalData.geopoliticalEvents.length);

  for (const cp of externalData.commodityPrices) {
    const changePct = ((cp.current_price - cp.previous_price) / cp.previous_price * 100).toFixed(1);
    kv(`  ${cp.commodity}`, `${cp.previous_price} → ${cp.current_price} ${cp.currency} (${changePct > 0 ? '+' : ''}${changePct}%)`, changePct > 0 ? RED : GREEN);
  }

  for (const ge of externalData.geopoliticalEvents) {
    const sevColor = ge.severity === 'critical' ? RED : ge.severity === 'high' ? YELLOW : '';
    kv(`  [${ge.severity.toUpperCase()}]`, ge.description, sevColor);
  }

  // ── Step 2: Parse into macro signals ──────────────────────────────────────
  section('Step 2: Parse into Macro Signals');

  const { signals, supplierEvents, skipped } = processExternalSignals({
    commodityPrices: externalData.commodityPrices,
    geopoliticalEvents: externalData.geopoliticalEvents,
    currencyMoves: externalData.currencyMoves,
  });

  kv('Signals generated', signals.length, GREEN);
  kv('Supplier events', supplierEvents.length);
  kv('Skipped (below threshold)', skipped);

  for (const sig of signals) {
    const sevColor = sig.severity === 'critical' ? RED : sig.severity === 'high' ? YELLOW : '';
    kv(`  ${sig.signal_type}`, `magnitude=${sig.magnitude} severity=${sig.severity}`, sevColor);
  }

  // ── Step 3: Compute risk deltas ───────────────────────────────────────────
  section('Step 3: Compute Risk Deltas');

  for (const event of supplierEvents) {
    const delta = computeRiskDelta(event);
    const deltaColor = delta.risk_score_delta > 20 ? RED : delta.risk_score_delta > 10 ? YELLOW : '';
    kv(`  ${event.event_type}`, `risk_delta=+${delta.risk_score_delta.toFixed(1)}`, deltaColor);
    kv(`    evidence`, delta.evidence_refs.join(', '), DIM);
  }

  // ── Step 4: Evaluate closed-loop trigger ──────────────────────────────────
  section('Step 4: Closed-Loop Trigger Evaluation');

  // Simulate current risk state (pre-event baseline: risk_score=45)
  const baseRiskScore = 45;
  const totalDelta = supplierEvents.reduce((sum, e) => {
    const d = computeRiskDelta(e);
    return sum + d.risk_score_delta;
  }, 0);
  const newRiskScore = Math.min(200, baseRiskScore + totalDelta);

  kv('Base risk score', baseRiskScore);
  kv('Total risk delta', `+${totalDelta.toFixed(1)}`, RED);
  kv('New risk score', newRiskScore.toFixed(1), newRiskScore > 60 ? RED : YELLOW);

  const shouldTrigger = newRiskScore > 60;
  kv('Trigger condition (risk > 60)', shouldTrigger ? 'YES — REPLAN RECOMMENDED' : 'No', shouldTrigger ? RED : GREEN);

  // ── Step 5: CFR strategy assessment ───────────────────────────────────────
  section('Step 5: CFR Game-Theory Assessment');

  const { bucket, name: bucketName } = computePositionBucket({ risk_score: newRiskScore });
  kv('Buyer position', `${bucketName} (bucket=${bucket})`, bucket >= 3 ? GREEN : bucket <= 1 ? RED : YELLOW);

  // Simulate supplier KPIs for a supplier affected by this event
  const supplierKpis = { on_time_rate: 0.72, defect_rate: 0.03 };
  const priors = computeSupplierTypePriors(supplierKpis);
  kv('Supplier type priors', '');
  kv('  P(AGGRESSIVE)', priors.AGGRESSIVE.toFixed(2), priors.AGGRESSIVE > 0.4 ? RED : '');
  kv('  P(COOPERATIVE)', priors.COOPERATIVE.toFixed(2));
  kv('  P(DESPERATE)', priors.DESPERATE.toFixed(2), priors.DESPERATE > 0.4 ? GREEN : '');

  // Derive solver adjustments
  const adjustment = deriveSolverParamsFromStrategy({
    cfrActionProbs: { accept: 0.3, reject: 0.4, counter: 0.3 },
    supplierTypePriors: priors,
    positionBucket: bucket,
  });

  kv('Supplier assessment', adjustment.supplier_assessment, adjustment.supplier_assessment === 'aggressive' ? RED : GREEN);
  kv('Safety stock alpha ×', adjustment.safety_stock_alpha_multiplier, adjustment.safety_stock_alpha_multiplier > 1 ? RED : GREEN);
  kv('Stockout penalty ×', adjustment.stockout_penalty_multiplier);
  kv('Dual-source flag', adjustment.dual_source_flag ? 'YES' : 'no', adjustment.dual_source_flag ? YELLOW : '');
  kv('Reason', adjustment.adjustment_reason);

  // ── Step 6: Draft recommendation ──────────────────────────────────────────
  section('Step 6: Recommendation');

  if (shouldTrigger) {
    console.log(`
  ${BOLD}${RED}⚠  ALERT: Supply chain disruption detected${RESET}
  ${DIM}Source:${RESET} ${externalData.geopoliticalEvents[0]?.description || 'Unknown'}

  ${BOLD}Recommended Actions:${RESET}
  1. ${adjustment.dual_source_flag ? `${RED}Activate dual-source procurement${RESET} for affected materials` : 'Monitor situation — single source adequate'}
  2. Adjust safety stock alpha: 0.50 → ${(0.50 * adjustment.safety_stock_alpha_multiplier).toFixed(2)}
  3. Re-run planning solver with updated parameters
  4. ${adjustment.supplier_assessment === 'aggressive'
    ? `${YELLOW}Prepare hardball negotiation strategy${RESET} (CFR recommends assertive opening)`
    : `${GREEN}Cooperative negotiation tone${RESET} (CFR recommends collaborative approach)`}
`);
  } else {
    console.log(`\n  ${GREEN}✓ No immediate action required. Risk levels within tolerance.${RESET}\n`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  section('Pipeline Summary');
  console.log(`
  ${DIM}External News${RESET} → ${signals.length} signals → ${supplierEvents.length} events → risk Δ+${totalDelta.toFixed(1)}
  → ${shouldTrigger ? `${RED}TRIGGER${RESET}` : `${GREEN}OK${RESET}`} → CFR: ${adjustment.supplier_assessment} → alpha ×${adjustment.safety_stock_alpha_multiplier}
  `);
}

main().catch((err) => {
  console.error(`${RED}Demo failed:${RESET}`, err.message);
  process.exit(1);
});
