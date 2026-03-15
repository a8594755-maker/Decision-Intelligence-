import { resolveTemplate } from '../agentLoopTemplates.js';
import { datasetProfilesService } from '../datasetProfilesService.js';
import { EXECUTION_MODES, resolveExecutionMode } from './executionPolicy.js';
import { getDefaultDeliverableProfile } from './deliverableProfile.js';

const DEFAULT_LLM_CONFIG = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  temperature: 0.15,
  max_tokens: 4096,
};

const DATASET_REQUIRED_STEP_TYPES = new Set(['forecast', 'plan', 'risk']);

function mapTemplateStep(templateId, step) {
  const review_checkpoint = Boolean(step.requires_review);

  switch (step.workflow_type) {
    case 'forecast':
      return {
        name: step.name,
        tool_hint: 'Run demand forecast from the selected dataset profile.',
        tool_type: 'builtin_tool',
        builtin_tool_id: 'run_forecast',
        review_checkpoint,
      };

    case 'plan':
      return {
        name: step.name,
        tool_hint: templateId === 'risk_aware_plan'
          ? 'Generate a risk-aware replenishment plan from prior forecast and risk outputs.'
          : 'Generate a replenishment plan from the selected dataset profile.',
        tool_type: 'builtin_tool',
        builtin_tool_id: templateId === 'risk_aware_plan' ? 'run_risk_aware_plan' : 'run_plan',
        input_args: templateId === 'risk_aware_plan' ? { riskMode: 'on' } : {},
        review_checkpoint,
      };

    case 'risk':
      return {
        name: step.name,
        tool_hint: 'Run supplier risk analysis from the selected dataset profile.',
        tool_type: 'builtin_tool',
        builtin_tool_id: 'run_risk_analysis',
        review_checkpoint,
      };

    case 'synthesize':
      return {
        name: step.name,
        tool_hint: 'Generate an executive-ready report from prior step artifacts.',
        tool_type: 'report',
        report_format: 'html',
        review_checkpoint,
      };

    case 'builtin_tool':
      return {
        name: step.name,
        tool_hint: step.name,
        tool_type: 'builtin_tool',
        builtin_tool_id: step.builtin_tool_id || null,
        review_checkpoint,
      };

    case 'excel_ops':
      return {
        name: step.name,
        tool_hint: 'Generate an Excel workbook from the accumulated step artifacts.',
        tool_type: 'excel',
        review_checkpoint,
      };

    default:
      throw new Error(`Unsupported template workflow_type: ${step.workflow_type}`);
  }
}

function templateRequiresDataset(template) {
  return (template?.steps || []).some((step) => DATASET_REQUIRED_STEP_TYPES.has(step.workflow_type));
}

async function resolveDatasetProfileContext({
  userId,
  datasetProfileId,
  datasetProfileRow = null,
  template = null,
}) {
  if (!templateRequiresDataset(template)) {
    return {
      datasetProfileId: datasetProfileId || datasetProfileRow?.id || null,
      datasetProfileRow: datasetProfileRow || null,
    };
  }

  let resolvedRow = datasetProfileRow || null;

  if (!resolvedRow && datasetProfileId) {
    resolvedRow = await datasetProfilesService.getDatasetProfileById(userId, datasetProfileId);
  }

  if (!resolvedRow) {
    resolvedRow = await datasetProfilesService.getLatestDatasetProfile(userId);
  }

  if (!resolvedRow) {
    throw new Error('A dataset profile is required for this task source, but none was provided or found.');
  }

  return {
    datasetProfileId: resolvedRow.id,
    datasetProfileRow: resolvedRow,
  };
}

export async function buildPlanFromTemplateTask({
  templateId,
  title,
  description = '',
  priority = 'medium',
  dueAt = null,
  executionMode = null,
  datasetProfileId,
  datasetProfileRow,
  userId,
}) {
  const template = resolveTemplate(templateId);
  if (!template) {
    throw new Error(`Unknown template: ${templateId}`);
  }

  const resolvedDataset = await resolveDatasetProfileContext({
    userId,
    datasetProfileId,
    datasetProfileRow,
    template,
  });

  const steps = template.steps.map((step) => mapTemplateStep(templateId, step));
  const deliverable = getDefaultDeliverableProfile(template.id);

  return {
    title,
    description,
    steps,
    inputData: {
      userId,
      title,
      datasetProfileId: resolvedDataset.datasetProfileId,
      datasetProfileRow: resolvedDataset.datasetProfileRow,
    },
    llmConfig: DEFAULT_LLM_CONFIG,
    priority,
    taskMeta: {
      due_at: dueAt,
      source_type: 'manual',
      execution_mode: resolveExecutionMode(executionMode, EXECUTION_MODES.MANUAL_APPROVE),
      template_id: templateId,
      dataset_profile_id: resolvedDataset.datasetProfileId,
      workflow_type: templateId,
      deliverable_type: deliverable.type,
      doc_type: deliverable.docType,
      deliverable_format: deliverable.format,
      deliverable_channel: deliverable.channel,
      deliverable_audience: deliverable.audience,
      deliverable_label: deliverable.label,
    },
  };
}

export async function buildPlanFromTaskTemplate({
  title,
  description = '',
  priority = 'medium',
  dueAt = null,
  sourceType = 'manual',
  executionMode = null,
  templateId = null,
  workflowType = null,
  datasetProfileId = null,
  datasetProfileRow = null,
  userId,
  inputContext = {},
}) {
  const resolvedTemplateId = templateId || workflowType;
  if (!resolvedTemplateId) {
    throw new Error('Task source must provide either templateId or workflowType.');
  }

  const template = resolveTemplate(resolvedTemplateId);
  if (!template) {
    throw new Error(`Unknown template or workflow type: ${resolvedTemplateId}`);
  }

  const resolvedDataset = await resolveDatasetProfileContext({
    userId,
    datasetProfileId: datasetProfileId || inputContext.dataset_profile_id || null,
    datasetProfileRow,
    template,
  });

  const steps = template.steps.map((step) => mapTemplateStep(template.id, step));
  const resolvedExecutionMode = resolveExecutionMode(
    executionMode,
    inputContext.execution_mode,
    template.execution_mode
  );
  const deliverable = getDefaultDeliverableProfile(template.id);
  const mergedContext = {
    ...inputContext,
    execution_mode: resolvedExecutionMode,
    template_id: template.id,
    workflow_type: template.id,
    dataset_profile_id: resolvedDataset.datasetProfileId,
    deliverable_type: inputContext.deliverable_type || deliverable.type,
    doc_type: inputContext.doc_type || inputContext.document_type || deliverable.docType,
    deliverable_format: inputContext.deliverable_format || deliverable.format,
    deliverable_channel: inputContext.deliverable_channel || deliverable.channel,
    deliverable_audience: inputContext.deliverable_audience || deliverable.audience,
    deliverable_label: inputContext.deliverable_label || deliverable.label,
  };

  return {
    title,
    description,
    steps,
    inputData: {
      userId,
      title,
      datasetProfileId: resolvedDataset.datasetProfileId,
      datasetProfileRow: resolvedDataset.datasetProfileRow,
    },
    llmConfig: DEFAULT_LLM_CONFIG,
    priority,
    taskMeta: {
      due_at: dueAt,
      source_type: sourceType,
      ...mergedContext,
    },
  };
}

export default {
  buildPlanFromTemplateTask,
  buildPlanFromTaskTemplate,
};
