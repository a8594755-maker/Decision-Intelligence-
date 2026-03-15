import { callLLMJson } from '../../aiEmployeeLLMService.js';
import { buildDeliverablePreview } from '../deliverableProfile.js';
import { getActiveOutputProfile, resolveOutputProfileScope } from './outputProfileService.js';
import { createOutputProfileProposal } from './companyOutputProfileService.js';

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') ?? null;
}

function sanitizeJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function normalizeFeedback(comment) {
  return String(comment || '').trim();
}

function buildReviewProposalPrompt({
  task,
  decision,
  comment,
  review,
  run,
  scope,
  currentProfile,
  deliverable,
}) {
  const preview = {
    headline: deliverable.headline,
    summary: deliverable.summary,
    sections: deliverable.sections,
    preview_kind: deliverable.previewKind,
    profile: deliverable.profile,
    attachment_names: [
      deliverable.primaryAttachmentName,
      ...(deliverable.attachmentNames || []),
    ].filter(Boolean),
  };

  const baseline = currentProfile ? {
    doc_type: currentProfile.docType,
    profile_name: currentProfile.profileName,
    version: currentProfile.version,
    source: currentProfile.source,
    audience: currentProfile.audience,
    format: currentProfile.format,
    channel: currentProfile.channel,
    deliverable_type: currentProfile.deliverableType,
    canonical: currentProfile.canonical,
  } : null;

  return `You are deciding whether a manager's review comment should become a reusable company output-profile proposal for a digital worker.

Create a proposal ONLY if the feedback implies a reusable house-style rule, structure rule, formatting rule, KPI presentation rule, audience/tone rule, or deliverable packaging rule that should apply to future tasks of the same document type.

Do NOT create a proposal for one-off business conclusions, dataset-specific corrections, temporary exceptions, or generic praise.

Task:
${JSON.stringify({
  id: task.id,
  title: task.title,
  description: task.description,
  workflow_type: task.input_context?.workflow_type || null,
  input_context: {
    doc_type: task.input_context?.doc_type || null,
    deliverable_type: task.input_context?.deliverable_type || null,
    deliverable_audience: task.input_context?.deliverable_audience || null,
    deliverable_format: task.input_context?.deliverable_format || null,
    team_id: task.input_context?.team_id || null,
    business_unit: task.input_context?.business_unit || null,
  },
}, null, 2)}

Resolved output profile scope:
${JSON.stringify(scope, null, 2)}

Current baseline profile:
${JSON.stringify(baseline, null, 2)}

Current deliverable preview:
${JSON.stringify(preview, null, 2)}

Review event:
${JSON.stringify({
  review_id: review?.id || null,
  run_id: run?.id || null,
  decision,
  comment,
}, null, 2)}

Return ONLY valid JSON with this shape:
{
  "should_create_proposal": true,
  "proposal_name": "short baseline name",
  "rationale": "why this should become a reusable company rule",
  "proposed_changes": {
    "summary": "human readable diff",
    "rules": ["..."]
  },
  "comparison_summary": {
    "baseline_gap": "what is missing today",
    "expected_benefit": "why this improves future outputs",
    "confidence": 0.0
  },
  "candidate_profile_patch": {
    "audience": "optional",
    "format": "optional",
    "channel": "optional",
    "canonical": {
      "structure": {},
      "formatting": {},
      "charts": {},
      "kpiLayout": {},
      "textStyle": {}
    }
  }
}

If this should NOT become a reusable baseline proposal, return:
{"should_create_proposal": false, "reason": "why not"}`;
}

function likelyStyleFeedback(comment) {
  const text = normalizeFeedback(comment).toLowerCase();
  if (text.length < 12) return false;
  return [
    'always', 'should', 'prefer', 'use', 'format', 'style', 'tone', 'wording',
    'title', 'headline', 'sheet', 'section', 'dashboard', 'kpi', 'metric',
    'summary', 'highlight', 'table', 'layout', 'template', 'naming',
    'manager', 'leadership', '月會', '格式', '語氣', '欄位', '圖表', '摘要', '指標',
  ].some((keyword) => text.includes(keyword));
}

function buildHeuristicProposal({
  scope,
  comment,
  task,
  review,
  run,
  currentProfile,
}) {
  if (!likelyStyleFeedback(comment)) return null;

  return {
    employeeId: task.employee_id,
    teamId: scope.teamId,
    docType: scope.docType,
    profileName: `${scope.docType}_proposal`,
    deliverableType: scope.deliverableType || currentProfile?.deliverableType || null,
    audience: scope.audience || currentProfile?.audience || null,
    format: scope.format || currentProfile?.format || null,
    channel: scope.channel || currentProfile?.channel || null,
    rationale: comment,
    proposedChanges: {
      summary: comment,
      source: 'heuristic_review_feedback',
    },
    comparisonSummary: {
      baseline_gap: 'Manager requested a reusable style/output adjustment.',
      expected_benefit: 'Future outputs should align better with company delivery expectations.',
      confidence: 0.35,
    },
    candidateProfile: {},
    baseProfileId: currentProfile?.source === 'company_output_profiles' ? currentProfile.id : null,
    sourceStyleProfileId: currentProfile?.source === 'style_profiles' ? currentProfile.id : null,
    sourceTaskId: task.id,
    sourceReviewId: review?.id || null,
    sourceRunId: run?.id || null,
  };
}

export async function maybeCreateOutputProfileProposalFromReview({
  task,
  review = null,
  run = null,
  decision,
  comment,
  actorUserId,
  llmJsonFn = callLLMJson,
}) {
  const feedback = normalizeFeedback(comment);
  if (!task?.employee_id || !feedback) return null;

  const scope = resolveOutputProfileScope({
    inputContext: task.input_context || {},
    step: { name: task.input_context?.workflow_type || null },
  });

  const deliverable = buildDeliverablePreview(task);
  const currentProfile = await getActiveOutputProfile({
    employeeId: task.employee_id,
    inputContext: task.input_context || {},
    step: { name: task.input_context?.workflow_type || null },
  }).catch(() => null);

  let draft = null;
  const prompt = buildReviewProposalPrompt({
    task,
    decision,
    comment: feedback,
    review,
    run,
    scope,
    currentProfile,
    deliverable,
  });

  try {
    const result = await llmJsonFn({
      taskType: 'review',
      prompt,
      systemPrompt: 'Decide whether manager feedback should create a reusable output-profile proposal. Return JSON only.',
      maxTokens: 2200,
      routingContext: { highRisk: true },
      trackingMeta: {
        taskId: task.id,
        employeeId: task.employee_id,
        runId: run?.id || null,
        agentRole: 'output_profile_proposal',
        stepName: 'review_learning',
      },
    });

    const data = result?.data || null;
    if (data?.should_create_proposal) {
      draft = {
        employeeId: task.employee_id,
        teamId: scope.teamId,
        docType: scope.docType,
        profileName: firstDefined(data.proposal_name, `${scope.docType}_proposal`),
        deliverableType: scope.deliverableType || currentProfile?.deliverableType || null,
        audience: firstDefined(data?.candidate_profile_patch?.audience, scope.audience, currentProfile?.audience),
        format: firstDefined(data?.candidate_profile_patch?.format, scope.format, currentProfile?.format),
        channel: firstDefined(data?.candidate_profile_patch?.channel, scope.channel, currentProfile?.channel),
        rationale: firstDefined(data.rationale, feedback),
        proposedChanges: sanitizeJson(data.proposed_changes),
        comparisonSummary: sanitizeJson(data.comparison_summary),
        candidateProfile: sanitizeJson(data.candidate_profile_patch),
        baseProfileId: currentProfile?.source === 'company_output_profiles' ? currentProfile.id : null,
        sourceStyleProfileId: currentProfile?.source === 'style_profiles' ? currentProfile.id : null,
        sourceTaskId: task.id,
        sourceReviewId: review?.id || null,
        sourceRunId: run?.id || null,
      };
    }
  } catch (err) {
    console.warn('[reviewProposalService] LLM proposal analysis failed:', err?.message || err);
  }

  if (!draft) {
    draft = buildHeuristicProposal({
      scope,
      comment: feedback,
      task,
      review,
      run,
      currentProfile,
    });
  }

  if (!draft) return null;

  return createOutputProfileProposal({
    ...draft,
    actorUserId,
  });
}

export const _testExports = {
  buildReviewProposalPrompt,
  likelyStyleFeedback,
  buildHeuristicProposal,
};

export default {
  maybeCreateOutputProfileProposalFromReview,
};
