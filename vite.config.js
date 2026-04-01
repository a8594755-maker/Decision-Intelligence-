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
    if (normalized.includes('/@duckdb/duckdb-wasm/')) return 'vendor-duckdb'
    return undefined
  }

  // Chat UI components
  if (
    normalized.includes('/src/views/DecisionSupportView/') ||
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

  if (normalized.includes('/src/components/chat/')) return 'workspace-chat-cards'

  // Service domain chunks — aligned with new directory structure
  if (normalized.includes('/src/services/agent-core/')) return 'chunk-agent'
  if (normalized.includes('/src/services/chat/'))       return 'workspace-chat-services'
  if (normalized.includes('/src/services/forecast/'))   return 'chunk-forecast'
  if (normalized.includes('/src/services/planning/'))   return 'chunk-planning'
  if (normalized.includes('/src/services/risk/'))        return 'chunk-risk'
  if (normalized.includes('/src/services/charts/'))      return 'chunk-charts'
  if (normalized.includes('/src/services/data-prep/'))   return 'workspace-chat-data'
  if (normalized.includes('/src/services/ai-infra/'))    return 'chunk-ai-infra'
  if (normalized.includes('/src/services/memory/'))      return 'chunk-ai-infra'
  if (normalized.includes('/src/services/governance/'))  return 'chunk-governance'
  if (normalized.includes('/src/services/sap-erp/'))     return 'chunk-sap'
  if (normalized.includes('/src/services/canvas/'))      return 'workspace-chat-services'
  if (normalized.includes('/src/services/tasks/'))       return 'workspace-ai-employee'
  if (normalized.includes('/src/services/infra/'))       return 'chunk-ai-infra'

  // Existing subdirectories
  if (normalized.includes('/src/services/aiEmployee/'))  return 'workspace-ai-employee'
  if (normalized.includes('/src/services/negotiation/')) return 'workspace-negotiation'
  if (normalized.includes('/src/services/topology/'))    return 'workspace-chat-data'

  if (normalized.includes('/src/components/ai-employee/')) return 'workspace-ai-employee'
  if (normalized.includes('/src/components/chat/Negotiation')) return 'workspace-negotiation'
  if (normalized.includes('/src/pages/NegotiationWorkbench')) return 'workspace-negotiation'

  if (
    normalized.includes('/src/components/whatif/') ||
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
    host: '0.0.0.0',
    port: 5173,
  },
  optimizeDeps: {
    exclude: ['@anthropic-ai/claude-agent-sdk'],
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
