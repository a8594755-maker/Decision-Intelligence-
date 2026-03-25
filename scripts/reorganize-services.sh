#!/bin/bash
# scripts/reorganize-services.sh
# Moves src/services/ flat files into domain-specific subdirectories
# Uses git mv for tracked files, mv for untracked

set -euo pipefail

BASE="src/services"

# Create all subdirectories
DIRS=(
  "agent-core" "chat" "forecast" "planning" "risk"
  "charts" "data-prep" "ai-infra" "memory" "governance"
  "sap-erp" "canvas" "tasks" "infra"
)

for dir in "${DIRS[@]}"; do
  mkdir -p "$BASE/$dir"
done

move() {
  local src="$1"
  local dst="$2"
  if [ -f "$src" ]; then
    git mv "$src" "$dst" 2>/dev/null || mv "$src" "$dst"
  fi
}

echo "=== Agent Core ==="
for f in \
  chatAgentLoop.js chatAgentLoop.test.js chatAgentLoop.gemini.test.js \
  agentLoopTemplates.js agentLoopTemplates.test.js \
  chatToolAdapter.js chatToolAdapter.test.js \
  dynamicToolExecutor.js dynamicToolExecutor.test.js \
  agentExecutionStrategyService.js agentExecutionStrategyService.test.js \
  agentResponsePresentationService.js agentResponsePresentationService.test.js \
  agentAnswerCoverageService.js \
  agentCandidateJudgeService.js agentCandidateJudgeService.test.js \
  dashboardSummaryAgent.js dashboardSummaryCache.js \
  dynamicTemplateBuilder.js dynamicTemplateBuilder.test.js \
  sandboxRunner.js sandboxRunner.test.js \
  actionTrackingService.js abTestService.js \
; do
  move "$BASE/$f" "$BASE/agent-core/"
done

echo "=== Chat ==="
for f in \
  chatIntentService.js chatIntentService.test.js \
  chatTaskDecomposer.js chatTaskDecomposer.test.js \
  chatSessionContextBuilder.js chatSessionContextBuilder.test.js \
  chatAttachmentService.js chatAttachmentService.test.js \
  chatActionRegistry.js \
  chatRefinementService.js \
  taskIntakeService.js \
  chatThinkingPolicyService.js chatThinkingPolicyService.test.js \
  intakeRoutingService.js \
  chatScenarioBatchService.js \
  emailIntakeEndpoint.js emailIntakeService.js \
  webhookIntakeService.js transcriptIntakeService.js \
  openclawIntakeAdapter.js openclawIntakeAdapter.test.js \
  unifiedIntakePipeline.test.js \
; do
  move "$BASE/$f" "$BASE/chat/"
done

echo "=== Forecast ==="
for f in \
  chatForecastService.js \
  demandForecastEngine.js \
  costForecastService.js \
  revenueForecastService.js \
  supplyForecastService.js \
  inventoryProbForecastService.js \
  dualModelForecastService.js \
  regressionService.js \
  sapForecastBridgeService.js \
  macroSignalService.js \
  autoInsightService.js \
  edaService.js \
  anomalyDetectionService.js \
  baselineCompareService.js baselineCompareService.test.js \
  forecastApiClient.js \
  inventoryProjectionService.js \
  inventoryProjectionForRiskService.js \
  costAnalysisService.js \
  insightsAnalyticsEngine.js insightsAnalyticsEngine.test.js \
; do
  move "$BASE/$f" "$BASE/forecast/"
done

echo "=== Planning ==="
for f in \
  chatPlanningService.js \
  diModelRouterService.js diModelRouterService.test.js \
  bomExplosionService.js \
  scenarioEngine.js \
  scenarioPersistenceService.js \
  scenarioIntentParser.js scenarioIntentParser.test.js \
  scenarioChatBridge.js scenarioChatBridge.test.js \
  approvalWorkflowService.js approvalWorkflowService.test.js \
  approvalGateService.js approvalGate.test.js \
  basePlanResolverService.js \
  diScenariosService.js diRunsService.js sheetRunsService.js \
  planAuditService.js planGovernanceService.js planWritebackService.js \
  multiEchelonBomService.js multiEchelonBomService.test.js \
  optimizationApiClient.js optimizationApiClient.multiEchelon.test.js \
  digitalTwinService.js \
  whatIfService.js \
  negotiationApprovalBridge.js negotiationApprovalBridge.test.js \
  negotiationPersistenceService.js negotiationPersistenceService.test.js \
  negotiationStrategyEngine.js \
  discordApprovalBridge.js \
; do
  move "$BASE/$f" "$BASE/planning/"
done

echo "=== Risk ==="
for f in \
  chatRiskService.js \
  riskAdjustmentsService.js riskAdjustmentsService.test.js \
  riskScoreService.js \
  riskClosedLoopService.js riskClosedLoopService.test.js \
  externalSignalAdapters.js externalSignalAdapters.test.js \
  causalGraphService.js causalGraphService.test.js \
; do
  move "$BASE/$f" "$BASE/risk/"
done

echo "=== Charts ==="
for f in \
  chartArtisanService.js chartColorSystem.js chartEnhancementService.js \
  chartRecipeAdapter.js \
  chartRecipeCatalog.js chartRecipeCatalog.test.js \
  chartRecipeExecutor.js chartRecipeExecutor.test.js \
  chartRecipes_advanced.js chartRecipes_composition.js \
  chartRecipes_correlation.js chartRecipes_distribution.js \
  chartRecipes_generic.js chartRecipes_geo.js \
  chartRecipes_timePattern.js chartRecipes_trend.js \
  chartSpecInference.js chartSpecInference.test.js \
  chartTemplateLoader.js chartTemplateSelector.js \
  analysisRecipeCatalog.js analysisRecipeCatalog.test.js \
; do
  move "$BASE/$f" "$BASE/charts/"
done

echo "=== Data Prep ==="
for f in \
  analysisDomainEnrichment.js analysisDomainEnrichment.test.js \
  analysisBlueprintService.js \
  analysisSnapshotService.js \
  analysisToolResultService.js analysisToolResultService.test.js \
  datasetProfilingService.js \
  chatDatasetProfilingService.js \
  datasetProfilesService.js datasetProfilesService.test.js \
  datasetContextSelector.js datasetJoinService.js \
  preAnalysisDataValidator.js preAnalysisDataValidator.test.js \
  dataCleaningService.js dataInsightService.js \
  dataLearningService.js dataEditAuditService.js \
  oneShotImportService.js oneShotAiSuggestService.js \
  chunkIngestService.js ingestRpcService.js \
  importHistoryService.js uploadStrategies.js \
  mappingProfileService.js sampleDataService.js \
  liveDataQueryService.js queryPlannerService.js \
; do
  move "$BASE/$f" "$BASE/data-prep/"
done

echo "=== AI Infra ==="
for f in \
  aiProxyService.js aiProxyService.test.js \
  geminiAPI.js \
  modelConfigService.js modelConfigService.test.js \
  modelRoutingService.js modelRoutingService.test.js \
  modelRegistryService.js \
  builtinToolCatalog.js builtinToolCatalog.test.js \
  toolRegistryService.js toolRegistryService.test.js \
  toolBlueprintGenerator.js \
  toolPermissionGuard.js toolPermissionGuard.test.js \
  aiEmployeeLLMService.js aiEmployeeLLMService.test.js \
  aiEmployeeRuntimeService.js aiEmployeeRuntimeService.test.js \
  capabilityModelService.js gapDetectionService.js \
  externalToolBridgeService.js externalToolBridgeService.test.js \
  directAnalysisService.js directAnalysisService.test.js \
  queryIntentClassifier.js queryIntentClassifier.test.js \
  aiReviewerService.js aiReviewerService.test.js \
; do
  move "$BASE/$f" "$BASE/ai-infra/"
done

echo "=== Memory ==="
for f in \
  aiEmployeeMemoryService.js aiEmployeeMemoryService.test.js \
  sessionContextService.js sessionContextService.test.js \
  reuseMemoryService.js \
; do
  move "$BASE/$f" "$BASE/memory/"
done

echo "=== Governance ==="
for f in \
  governanceService.js policyRuleService.js \
  auditService.js \
  selfHealingService.js selfHealingService.test.js \
  eventBus.js eventBus.test.js \
  notificationService.js notificationService.test.js \
  logicVersionService.js \
  systemHealthService.js systemHealthService.test.js \
  evidenceAssembler.js evidenceAssembler.test.js \
  evidenceRegistry.js evidenceResponseService.js evidenceSynthesisService.js \
  proactiveAlertService.js proactiveAlertService.test.js \
  warRoomOrchestrator.js warRoomOrchestrator.test.js \
  regressionTestService.js \
  alertMonitorService.js alertMonitorService.test.js \
  phase-e-enhancements.test.js \
  platformGapClosure.test.js platformWiring.test.js \
; do
  move "$BASE/$f" "$BASE/governance/"
done

echo "=== SAP/ERP ==="
for f in \
  sapDataQueryService.js sapDataQueryService.test.js \
  sapQueryChatHandler.js sapQueryChatHandler.test.js \
  materialCostService.js \
  supplierKpiService.js \
  supplierCommunicationService.js \
  supplierEventConnectorService.js supplierEventConnectorService.test.js \
; do
  move "$BASE/$f" "$BASE/sap-erp/"
done

echo "=== Canvas ==="
for f in \
  chatCanvasWorkflowService.js \
  canvasAgentService.js canvasLayoutSchema.js \
; do
  move "$BASE/$f" "$BASE/canvas/"
done

echo "=== Tasks ==="
for f in \
  scheduledTaskService.js scheduledTaskService.test.js \
  decisionTaskService.js decisionTaskService.test.js \
  stepStateMachine.js stepStateMachine.test.js \
  taskBudgetService.js taskBudgetService.test.js \
  taskTimelineService.js \
  dailySummaryService.js dailySummaryService.test.js \
  workerPerformanceService.js \
  proactiveTaskGenerator.js proactiveTaskGenerator.test.js \
; do
  move "$BASE/$f" "$BASE/tasks/"
done

echo "=== Infra ==="
for f in \
  supabaseClient.js supabaseClient.facade.test.js \
  asyncRunsApiClient.js \
  publishService.js \
  diResetService.js \
  reportGeneratorService.js reportGeneratorService.test.js \
  excelOpsService.js excelOpsTemplates.js \
; do
  move "$BASE/$f" "$BASE/infra/"
done

echo ""
echo "=== Migration complete ==="
echo "Remaining files in root:"
ls -1 "$BASE"/*.js 2>/dev/null || echo "(none)"
