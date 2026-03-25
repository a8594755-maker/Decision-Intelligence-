/**
 * intakeRoutingService.js — Intake Auto-Routing Engine
 *
 * Automatically assigns incoming work orders to the most appropriate
 * digital worker based on content analysis, source type, and worker capabilities.
 *
 * Routing logic:
 *   1. Keyword-based intent detection (EN/ZH)
 *   2. Match intent → capability class
 *   3. Find workers with matching capabilities + available capacity
 *   4. Score candidates by capability autonomy + task history
 *   5. Return best match (or default worker)
 *
 * @module services/intakeRoutingService
 */

import { listEmployeesByManager, listTemplatesFromDB } from '../aiEmployee/persistence/employeeRepo.js';

// ── Intent → Capability Mapping ─────────────────────────────────────────────

const INTENT_CAPABILITY_MAP = [
  {
    intent: 'forecast',
    capabilities: ['forecast', 'analysis', 'planning'],
    keywords: ['forecast', 'predict', 'demand', 'trend', 'projection', '預測', '需求', '趨勢'],
  },
  {
    intent: 'planning',
    capabilities: ['planning', 'forecast'],
    keywords: ['plan', 'replenish', 'inventory', 'reorder', 'supply', 'schedule', '計畫', '補貨', '庫存', '排程'],
  },
  {
    intent: 'risk',
    capabilities: ['risk', 'planning', 'analysis'],
    keywords: ['risk', 'alert', 'warning', 'shortage', 'delay', 'disruption', '風險', '告警', '缺貨', '延遲'],
  },
  {
    intent: 'procurement',
    capabilities: ['negotiation', 'analysis'],
    keywords: ['procure', 'purchase', 'vendor', 'supplier', 'negotiate', 'bid', 'quote', '採購', '供應商', '談判', '報價'],
  },
  {
    intent: 'reporting',
    capabilities: ['reporting', 'synthesis', 'analysis'],
    keywords: ['report', 'summary', 'dashboard', 'mbr', 'kpi', 'analysis', '報告', '摘要', '分析', '儀表板'],
  },
  {
    intent: 'integration',
    capabilities: ['integration', 'monitoring'],
    keywords: ['erp', 'sap', 'oracle', 'sync', 'writeback', 'export', 'publish', '匯出', '同步', '整合'],
  },
  {
    intent: 'data_quality',
    capabilities: ['analysis', 'monitoring', 'reporting'],
    keywords: ['data quality', 'validation', 'clean', 'anomaly', 'missing', '資料品質', '驗證', '異常'],
  },
];

// ── Core Routing ────────────────────────────────────────────────────────────

/**
 * Detect intent from work order content.
 *
 * @param {Object} workOrder - Normalized work order from taskIntakeService
 * @returns {{ intent: string, capabilities: string[], confidence: number }}
 */
export function detectIntent(workOrder) {
  const text = [
    workOrder.title || '',
    workOrder.description || '',
    workOrder.context?.subject || '',
    workOrder.context?.alert_type || '',
  ].join(' ').toLowerCase();

  let bestMatch = null;
  let bestScore = 0;

  for (const entry of INTENT_CAPABILITY_MAP) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (text.includes(kw.toLowerCase())) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
    }
  }

  if (!bestMatch || bestScore === 0) {
    return { intent: 'general', capabilities: ['analysis', 'reporting'], confidence: 0.3 };
  }

  const confidence = Math.min(1, bestScore / 3); // 3+ keyword matches = 100%
  return { intent: bestMatch.intent, capabilities: bestMatch.capabilities, confidence };
}

/**
 * Score a worker candidate against required capabilities.
 *
 * @param {Object} worker - Employee row from ai_employees
 * @param {string[]} requiredCapabilities - Ordered by preference
 * @param {Object[]} templates - Available worker templates
 * @returns {number} Score (higher = better fit)
 */
function scoreWorker(worker, requiredCapabilities, templates) {
  // Find matching template
  const template = templates.find(t => t.id === worker.role || t.role === worker.role);
  const workerCapabilities = template?.capabilities || template?.allowed_capabilities || [];

  let score = 0;

  // Capability match score (first capability = highest weight)
  for (let i = 0; i < requiredCapabilities.length; i++) {
    if (workerCapabilities.includes(requiredCapabilities[i])) {
      score += (requiredCapabilities.length - i) * 10;
    }
  }

  // Availability bonus
  const status = worker._logicalState || worker.status;
  if (status === 'idle') score += 5;
  else if (status === 'busy') score -= 5;

  return score;
}

/**
 * Route a work order to the best available worker.
 *
 * @param {Object} workOrder - Normalized work order
 * @param {string} userId - Manager user ID (to scope worker search)
 * @param {Object} [options]
 * @param {string} [options.preferredEmployeeId] - Override: use this worker if available
 * @returns {Promise<{employeeId: string, workerName: string, intent: string, confidence: number, reason: string}>}
 */
export async function routeWorkOrder(workOrder, userId, options = {}) {
  // If a preferred employee is specified and valid, use it
  if (options.preferredEmployeeId) {
    return {
      employeeId: options.preferredEmployeeId,
      workerName: 'preferred',
      intent: 'manual',
      confidence: 1.0,
      reason: 'Manually assigned',
    };
  }

  // 1. Detect intent
  const { intent, capabilities, confidence } = detectIntent(workOrder);

  // 2. Get all workers for this user
  let workers;
  try {
    workers = await listEmployeesByManager(userId);
  } catch {
    return {
      employeeId: null,
      workerName: null,
      intent,
      confidence,
      reason: 'No workers found — cannot auto-route',
    };
  }

  if (!workers || workers.length === 0) {
    return {
      employeeId: null,
      workerName: null,
      intent,
      confidence,
      reason: 'No workers available for this user',
    };
  }

  // If only one worker, always use it
  if (workers.length === 1) {
    return {
      employeeId: workers[0].id,
      workerName: workers[0].name,
      intent,
      confidence,
      reason: 'Single worker — default assignment',
    };
  }

  // 3. Get templates for scoring
  let templates;
  try {
    templates = await listTemplatesFromDB();
  } catch {
    templates = [];
  }

  // 4. Score and rank workers
  const scored = workers.map(w => ({
    worker: w,
    score: scoreWorker(w, capabilities, templates),
  })).sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (best.score <= 0) {
    // No good match — fall back to first idle worker or first worker
    const idle = workers.find(w => (w._logicalState || w.status) === 'idle');
    const fallback = idle || workers[0];
    return {
      employeeId: fallback.id,
      workerName: fallback.name,
      intent,
      confidence: confidence * 0.5,
      reason: `No capability match — fallback to ${idle ? 'idle' : 'first'} worker`,
    };
  }

  return {
    employeeId: best.worker.id,
    workerName: best.worker.name,
    intent,
    confidence,
    reason: `Best match for "${intent}" intent (score: ${best.score})`,
  };
}

/**
 * Route a work order by source type hint.
 * Some sources have natural affinities to worker types.
 *
 * @param {string} source - INTAKE_SOURCES value
 * @returns {string[]} Preferred capability classes for this source
 */
export function getSourceCapabilityHint(source) {
  const hints = {
    chat:             ['analysis', 'reporting', 'planning'],
    schedule:         ['planning', 'reporting', 'monitoring'],
    proactive_alert:  ['risk', 'planning', 'monitoring'],
    closed_loop:      ['planning', 'analysis'],
    email:            ['analysis', 'reporting', 'planning'],
    meeting_transcript: ['reporting', 'synthesis'],
    api:              ['integration', 'planning', 'risk'],
  };
  return hints[source] || ['analysis', 'reporting'];
}
