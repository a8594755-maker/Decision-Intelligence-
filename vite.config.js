import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function manualChunks(id) {
  const normalized = id.replace(/\\/g, '/')

  if (normalized.includes('/node_modules/')) {
    if (normalized.includes('/recharts/')) return 'vendor-charts'
    if (normalized.includes('/reactflow/')) return 'vendor-flow'
    if (normalized.includes('/xlsx/')) return 'vendor-xlsx'
    if (normalized.includes('/@supabase/supabase-js/')) return 'vendor-supabase'
    return undefined
  }

  if (
    normalized.includes('/src/views/DecisionSupportView/') ||
    normalized.includes('/src/views/DecisionSupportView/index.jsx') ||
    normalized.includes('/src/components/chat/CanvasPanel.jsx') ||
    normalized.includes('/src/components/chat/AgentExecutionPanel.jsx') ||
    normalized.includes('/src/components/chat/ChatThread.jsx') ||
    normalized.includes('/src/components/chat/ChatComposer.jsx') ||
    normalized.includes('/src/components/chat/ConversationSidebar.jsx') ||
    normalized.includes('/src/components/chat/AIEmployeeConversationSidebar.jsx') ||
    normalized.includes('/src/components/chat/AIEmployeeChatShell.jsx') ||
    normalized.includes('/src/components/chat/SplitShell.jsx')
  ) {
    return 'workspace-chat-ui'
  }

  if (
    normalized.includes('/src/components/chat/')
  ) {
    return 'workspace-chat-cards'
  }

  if (
    normalized.includes('/src/services/chatPlanningService') ||
    normalized.includes('/src/services/chatForecastService') ||
    normalized.includes('/src/services/chatRiskService') ||
    normalized.includes('/src/services/chatCanvasWorkflowService') ||
    normalized.includes('/src/services/chatTaskDecomposer') ||
    normalized.includes('/src/services/chatSessionContextBuilder') ||
    normalized.includes('/src/services/chatRefinementService') ||
    normalized.includes('/src/services/chatActionRegistry') ||
    normalized.includes('/src/services/chatIntentService') ||
    normalized.includes('/src/services/chatScenarioBatchService') ||
    normalized.includes('/src/services/geminiAPI')
  ) {
    return 'workspace-chat-services'
  }

  if (
    normalized.includes('/src/services/chatDatasetProfilingService') ||
    normalized.includes('/src/services/datasetProfilingService') ||
    normalized.includes('/src/services/reuseMemoryService') ||
    normalized.includes('/src/services/topology/') ||
    normalized.includes('/src/services/liveDataQueryService') ||
    normalized.includes('/src/services/emailIntakeService') ||
    normalized.includes('/src/services/transcriptIntakeService') ||
    normalized.includes('/src/services/dynamicTemplateBuilder') ||
    normalized.includes('/src/services/alertMonitorService')
  ) {
    return 'workspace-chat-data'
  }

  if (
    normalized.includes('/src/services/aiEmployee/') ||
    normalized.includes('/src/components/ai-employee/') ||
    normalized.includes('/src/services/aiEmployeeRuntimeService') ||
    normalized.includes('/src/services/agentLoop') ||
    normalized.includes('/src/services/capabilityModelService') ||
    normalized.includes('/src/services/proactiveTaskGenerator') ||
    normalized.includes('/src/services/scheduledTaskService') ||
    normalized.includes('/src/services/modelRoutingService') ||
    normalized.includes('/src/services/workerPerformanceService') ||
    normalized.includes('/src/services/governanceService') ||
    normalized.includes('/src/services/dailySummaryService')
  ) {
    return 'workspace-ai-employee'
  }

  if (
    normalized.includes('/src/services/negotiation/') ||
    normalized.includes('/src/components/chat/Negotiation') ||
    normalized.includes('/src/pages/NegotiationWorkbench')
  ) {
    return 'workspace-negotiation'
  }

  if (
    normalized.includes('/src/components/whatif/') ||
    normalized.includes('/src/services/scenario') ||
    normalized.includes('/src/services/basePlanResolverService') ||
    normalized.includes('/src/services/diScenariosService') ||
    normalized.includes('/src/utils/buildScenarioComparison') ||
    normalized.includes('/src/utils/applyScenarioOverrides')
  ) {
    return 'workspace-scenario'
  }

  return undefined
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0', // 監聽所有 IP 位址 (IPv4 和 IPv6)
    port: 5173,
  },
  build: {
    // Strip console.log and debugger statements in production builds
    esbuild: { drop: ['console', 'debugger'] },
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
})
