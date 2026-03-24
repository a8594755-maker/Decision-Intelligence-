/**
 * gates/index.js — Barrel export for the step execution gate pipeline.
 */

export { runGatePipeline, buildStepContext, DEFAULT_GATE_PIPELINE } from './stepPipeline.js';

// Individual gates (for testing / custom pipelines)
export { datasetGate } from './datasetGate.js';
export { budgetGate } from './budgetGate.js';
export { capabilityPolicyGate } from './capabilityPolicyGate.js';
export { toolPermissionGate } from './toolPermissionGate.js';
export { governanceRulesGate } from './governanceRulesGate.js';
export { publishApprovalGate } from './approvalGate.js';

// Context resolvers
export {
  priorArtifactsResolver,
  styleContextResolver,
  memoryRecallResolver,
  datasetProfileResolver,
  lazyContextResolver,
} from './contextResolvers.js';
