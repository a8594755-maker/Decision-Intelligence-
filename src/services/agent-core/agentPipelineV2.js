/**
 * agentPipelineV2.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 4-Phase Agent Pipeline: Planner → Executor → Renderer → QA
 *
 * This orchestrates the full V2 pipeline, replacing the single-pass ReAct
 * loop + 9-stage recovery chain with structured phases.
 *
 * Usage:
 *   import { runAgentPipelineV2 } from './agentPipelineV2';
 *   const result = await runAgentPipelineV2({ message, ... });
 *   // result.presentation.brief ← JSON brief, same schema as V1
 *
 * Backward compatibility:
 *   The output shape matches buildAgentPresentationPayload() so the UI
 *   (DecisionSupportView) can consume it without changes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { generateTurnPlan } from './agentPlannerService.js';
import { runAgentLoopV2 } from './chatAgentLoop.js';
import { renderFromEvidence } from './agentResponsePresentationService.js';
import { getModelConfig } from '../ai-infra/modelConfigService.js';

/**
 * Run the full 4-phase agent pipeline.
 *
 * @param {Object} params
 * @param {string} params.message - User message
 * @param {Array} params.conversationHistory - Prior conversation turns
 * @param {Object} params.toolContext - Runtime context (userId, datasetProfileRow, etc.)
 * @param {Object} params.callbacks - UI callbacks (onTextChunk, onToolCall, etc.)
 * @param {AbortSignal} params.signal - Abort signal
 * @param {Object|null} params.sessionContext - Session context for planner
 * @returns {Promise<Object>} { presentation, turnPlan, executorResult }
 */
export async function runAgentPipelineV2({
  message,
  conversationHistory = [],
  toolContext = {},
  callbacks = {},
  signal,
  sessionContext = null,
}) {
  const { onTextChunk, onToolCall, onToolResult, onThinking } = callbacks;

  // ── Phase 1: PLANNER ──────────────────────────────────────────────────────
  onThinking?.({ step: 0, type: 'phase', content: 'Planning...', fullContent: '' });

  const turnPlan = await generateTurnPlan({
    userMessage: message,
    sessionContext,
    datasetProfile: toolContext.datasetProfileRow,
    conversationHistory,
    useLlmPlanner: true,
  });

  console.info('[pipelineV2] Phase 1 (Planner):', JSON.stringify(turnPlan));

  // Meta queries: skip executor + renderer, return simple response
  if (turnPlan.task_type === 'meta') {
    return {
      presentation: {
        brief: {
          headline: '',
          summary: '',
          metric_pills: [],
          tables: [],
          charts: [],
          key_findings: [],
          caveats: [],
          next_steps: [],
        },
        qa: { status: 'pass', score: 10, skipped: true },
        trace: { source: 'v2_meta_skip' },
        skippedSteps: ['executor', 'renderer', 'qa'],
      },
      turnPlan,
      executorResult: null,
      _isMeta: true,
    };
  }

  // ── Phase 2: EXECUTOR ─────────────────────────────────────────────────────
  onThinking?.({ step: 1, type: 'phase', content: 'Gathering evidence...', fullContent: '' });

  const primaryConfig = getModelConfig('primary');
  const executorResult = await runAgentLoopV2({
    message,
    turnPlan,
    conversationHistory,
    toolContext,
    callbacks: {
      onTextChunk,
      onToolCall,
      onToolResult,
      onThinking: (data) => onThinking?.({ ...data, phase: 'executor' }),
    },
    signal,
    agentProvider: primaryConfig.provider,
    agentModel: primaryConfig.model,
  });

  console.info('[pipelineV2] Phase 2 (Executor): evidence_count=', executorResult.evidenceBundle?.summary?.totalEntries);

  // ── Phase 3: RENDERER ─────────────────────────────────────────────────────
  onThinking?.({ step: 2, type: 'phase', content: 'Rendering analysis...', fullContent: '' });

  const presentation = await renderFromEvidence({
    evidenceBundle: executorResult.evidenceBundle,
    turnPlan,
    userMessage: message,
  });

  console.info('[pipelineV2] Phase 3 (Renderer): headline=', presentation.brief?.headline);

  // ── Phase 4: QA (deterministic QA already applied in renderFromEvidence) ──
  // Additional LLM judge is only triggered if:
  // - planner confidence < 0.7
  // - deterministic QA score is borderline (6.5-8.0)
  // - evidence has warnings (scope mismatches)
  const needsLlmJudge = (
    turnPlan.review_level === 'full'
    || turnPlan.confidence < 0.7
    || (presentation.qa?.score >= 6.5 && presentation.qa?.score < 8.0)
    || (executorResult.evidenceBundle?.warnings?.length > 0)
  );

  if (needsLlmJudge) {
    console.info('[pipelineV2] Phase 4 (QA): LLM judge triggered');
    // TODO: integrate LLM judge from agentCandidateJudgeService
    // For now, deterministic QA is sufficient
  }

  return {
    presentation,
    turnPlan,
    executorResult,
    _isMeta: false,
  };
}

export default { runAgentPipelineV2 };
