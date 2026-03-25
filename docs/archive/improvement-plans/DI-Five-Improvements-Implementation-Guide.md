# Decision Intelligence — 五項改善實作指南

> **版本:** v1.0 | **日期:** 2026-03-24
> **適用對象:** DI 開發團隊
> **預估總工期:** 6–8 週（可並行推進）

---

## 目錄

1. [改善一：Services 目錄重組](#改善一services-目錄重組)
2. [改善二：啟用 TypeScript Strict Mode](#改善二啟用-typescript-strict-mode)
3. [改善三：文件大掃除](#改善三文件大掃除)
4. [改善四：測試覆蓋率提升](#改善四測試覆蓋率提升)
5. [改善五：替換手動 Async 控制工具](#改善五替換手動-async-控制工具)
6. [執行時程總覽](#執行時程總覽)
7. [風險與回退策略](#風險與回退策略)

---

## 改善一：Services 目錄重組

### 現況問題

`src/services/` 目前有 **414 個檔案**平鋪在同一層目錄下，總計約 3.7MB。最大的檔案 `agentResponsePresentationService.js` 有 132KB（約 3,028 行），`chatPlanningService.js` 有 116KB。開發者在找檔案時需要在數百個檔案中搜尋，新人 onboarding 極為困難。

雖然已有少量子目錄（`forecasting/`、`closed_loop/`、`negotiation/` 等），但絕大多數檔案仍在根層。

### 目標架構

按照業務領域將 414 個檔案歸入 14 個子目錄：

```
src/services/
├── agent-core/              # Agent 迴圈與執行引擎（~45 檔案）
│   ├── chatAgentLoop.js
│   ├── agentLoopTemplates.js
│   ├── chatToolAdapter.js
│   ├── dynamicToolExecutor.js
│   ├── agentExecutionStrategyService.js
│   ├── agentResponsePresentationService.js
│   ├── agentAnswerCoverageService.js
│   ├── agentCandidateJudgeService.js
│   └── ...
│
├── chat/                    # Chat 介面整合（~12 檔案）
│   ├── chatIntentService.js
│   ├── chatTaskDecomposer.js
│   ├── chatSessionContextBuilder.js
│   ├── chatAttachmentService.js
│   ├── chatActionRegistry.js
│   ├── chatRefinementService.js
│   ├── taskIntakeService.js
│   └── ...
│
├── forecast/                # 預測領域（~32 檔案）
│   ├── chatForecastService.js
│   ├── demandForecastEngine.js
│   ├── revenueForecastService.js
│   ├── costForecastService.js
│   ├── supplyForecastService.js
│   ├── dualModelForecastService.js
│   ├── sapForecastBridgeService.js
│   └── ...
│
├── planning/                # 規劃與場景（~35 檔案）
│   ├── chatPlanningService.js
│   ├── diModelRouterService.js
│   ├── bomExplosionService.js
│   ├── scenarioEngine.js
│   ├── scenarioPersistenceService.js
│   ├── approvalWorkflowService.js
│   └── ...
│
├── risk/                    # 風險與優化（~28 檔案）
│   ├── chatRiskService.js
│   ├── riskAdjustmentsService.js
│   ├── riskScoreService.js
│   ├── optimizationApiClient.js
│   ├── whatIfService.js
│   ├── externalSignalAdapters.js
│   └── ...
│
├── charts/                  # 圖表與視覺化（~42 檔案）
│   ├── chartRecipeCatalog.js
│   ├── chartRecipes_trend.js
│   ├── chartRecipes_advanced.js
│   ├── chartSpecInference.js
│   ├── chartArtisanService.js
│   ├── analysisRecipeCatalog.js
│   └── ...
│
├── data-prep/               # 資料準備與分析（~38 檔案）
│   ├── analysisDomainEnrichment.js
│   ├── datasetProfilingService.js
│   ├── preAnalysisDataValidator.js
│   ├── dataCleaningService.js
│   ├── oneShotImportService.js
│   └── ...
│
├── ai-infra/                # AI 基礎設施（~26 檔案）
│   ├── aiProxyService.js
│   ├── geminiAPI.js
│   ├── modelConfigService.js
│   ├── modelRoutingService.js
│   ├── builtinToolCatalog.js
│   ├── toolRegistryService.js
│   └── ...
│
├── memory/                  # 記憶與上下文（~7 檔案）
│   ├── aiEmployeeMemoryService.js
│   ├── sessionContextService.js
│   ├── reuseMemoryService.js
│   └── ...
│
├── governance/              # 治理與審計（~22 檔案）
│   ├── governanceService.js
│   ├── policyRuleService.js
│   ├── auditService.js
│   ├── selfHealingService.js
│   ├── eventBus.js
│   └── ...
│
├── sap-erp/                 # SAP/ERP 整合（~15 檔案）
│   ├── sapDataQueryService.js
│   ├── sapQueryChatHandler.js
│   ├── materialCostService.js
│   ├── supplierKpiService.js
│   └── ...
│
├── canvas/                  # Canvas 與工作流（~5 檔案）
│   ├── chatCanvasWorkflowService.js
│   ├── canvasAgentService.js
│   └── ...
│
├── tasks/                   # 排程與任務管理（~6 檔案）
│   ├── scheduledTaskService.js
│   ├── decisionTaskService.js
│   ├── stepStateMachine.js
│   └── ...
│
└── infra/                   # 基礎工具（~5 檔案）
    ├── supabaseClient.js
    ├── asyncRunsApiClient.js
    └── ...
```

### 實作步驟

#### 步驟 1：建立遷移腳本（第 1 天）

建立一個 `scripts/reorganize-services.sh` 腳本，自動化整個搬遷：

```bash
#!/bin/bash
# scripts/reorganize-services.sh
# 用途：將 src/services/ 平鋪檔案搬入對應子目錄
# 安全措施：只做 git mv，不刪除任何檔案

set -euo pipefail

BASE="src/services"

# 建立子目錄
DIRS=(
  "agent-core" "chat" "forecast" "planning" "risk"
  "charts" "data-prep" "ai-infra" "memory" "governance"
  "sap-erp" "canvas" "tasks" "infra"
)

for dir in "${DIRS[@]}"; do
  mkdir -p "$BASE/$dir"
done

# Agent Core
git mv "$BASE/chatAgentLoop.js" "$BASE/agent-core/" 2>/dev/null || true
git mv "$BASE/chatAgentLoop.test.js" "$BASE/agent-core/" 2>/dev/null || true
git mv "$BASE/chatAgentLoop.gemini.test.js" "$BASE/agent-core/" 2>/dev/null || true
git mv "$BASE/agentLoopTemplates.js" "$BASE/agent-core/" 2>/dev/null || true
git mv "$BASE/agentLoopTemplates.test.js" "$BASE/agent-core/" 2>/dev/null || true
git mv "$BASE/chatToolAdapter.js" "$BASE/agent-core/" 2>/dev/null || true
git mv "$BASE/chatToolAdapter.test.js" "$BASE/agent-core/" 2>/dev/null || true
git mv "$BASE/dynamicToolExecutor.js" "$BASE/agent-core/" 2>/dev/null || true
git mv "$BASE/dynamicToolExecutor.test.js" "$BASE/agent-core/" 2>/dev/null || true
git mv "$BASE/agentExecutionStrategyService.js" "$BASE/agent-core/" 2>/dev/null || true
git mv "$BASE/agentExecutionStrategyService.test.js" "$BASE/agent-core/" 2>/dev/null || true
git mv "$BASE/agentResponsePresentationService.js" "$BASE/agent-core/" 2>/dev/null || true
git mv "$BASE/agentResponsePresentationService.test.js" "$BASE/agent-core/" 2>/dev/null || true
git mv "$BASE/agentAnswerCoverageService.js" "$BASE/agent-core/" 2>/dev/null || true
git mv "$BASE/agentCandidateJudgeService.js" "$BASE/agent-core/" 2>/dev/null || true
git mv "$BASE/agentCandidateJudgeService.test.js" "$BASE/agent-core/" 2>/dev/null || true
git mv "$BASE/dashboardSummaryAgent.js" "$BASE/agent-core/" 2>/dev/null || true

# Chat
git mv "$BASE/chatIntentService.js" "$BASE/chat/" 2>/dev/null || true
git mv "$BASE/chatIntentService.test.js" "$BASE/chat/" 2>/dev/null || true
git mv "$BASE/chatTaskDecomposer.js" "$BASE/chat/" 2>/dev/null || true
git mv "$BASE/chatTaskDecomposer.test.js" "$BASE/chat/" 2>/dev/null || true
git mv "$BASE/chatSessionContextBuilder.js" "$BASE/chat/" 2>/dev/null || true
git mv "$BASE/chatSessionContextBuilder.test.js" "$BASE/chat/" 2>/dev/null || true
git mv "$BASE/chatAttachmentService.js" "$BASE/chat/" 2>/dev/null || true
git mv "$BASE/chatAttachmentService.test.js" "$BASE/chat/" 2>/dev/null || true
git mv "$BASE/chatActionRegistry.js" "$BASE/chat/" 2>/dev/null || true
git mv "$BASE/chatRefinementService.js" "$BASE/chat/" 2>/dev/null || true
git mv "$BASE/taskIntakeService.js" "$BASE/chat/" 2>/dev/null || true
git mv "$BASE/chatThinkingPolicyService.js" "$BASE/chat/" 2>/dev/null || true

# Forecast
git mv "$BASE/chatForecastService.js" "$BASE/forecast/" 2>/dev/null || true
git mv "$BASE/demandForecastEngine.js" "$BASE/forecast/" 2>/dev/null || true
git mv "$BASE/costForecastService.js" "$BASE/forecast/" 2>/dev/null || true
git mv "$BASE/revenueForecastService.js" "$BASE/forecast/" 2>/dev/null || true
git mv "$BASE/supplyForecastService.js" "$BASE/forecast/" 2>/dev/null || true
git mv "$BASE/inventoryProbForecastService.js" "$BASE/forecast/" 2>/dev/null || true
git mv "$BASE/dualModelForecastService.js" "$BASE/forecast/" 2>/dev/null || true
git mv "$BASE/regressionService.js" "$BASE/forecast/" 2>/dev/null || true
git mv "$BASE/sapForecastBridgeService.js" "$BASE/forecast/" 2>/dev/null || true
git mv "$BASE/macroSignalService.js" "$BASE/forecast/" 2>/dev/null || true
git mv "$BASE/autoInsightService.js" "$BASE/forecast/" 2>/dev/null || true
git mv "$BASE/edaService.js" "$BASE/forecast/" 2>/dev/null || true
git mv "$BASE/anomalyDetectionService.js" "$BASE/forecast/" 2>/dev/null || true
git mv "$BASE/baselineCompareService.js" "$BASE/forecast/" 2>/dev/null || true
git mv "$BASE/baselineCompareService.test.js" "$BASE/forecast/" 2>/dev/null || true
git mv "$BASE/forecastApiClient.js" "$BASE/forecast/" 2>/dev/null || true

# AI Infrastructure
git mv "$BASE/aiProxyService.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/aiProxyService.test.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/geminiAPI.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/modelConfigService.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/modelConfigService.test.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/modelRoutingService.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/modelRoutingService.test.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/modelRegistryService.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/builtinToolCatalog.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/builtinToolCatalog.test.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/toolRegistryService.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/toolRegistryService.test.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/toolBlueprintGenerator.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/toolPermissionGuard.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/aiEmployeeLLMService.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/aiEmployeeLLMService.test.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/aiEmployeeRuntimeService.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/aiEmployeeRuntimeService.test.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/capabilityModelService.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/gapDetectionService.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/externalToolBridgeService.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/externalToolBridgeService.test.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/directAnalysisService.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/directAnalysisService.test.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/queryIntentClassifier.js" "$BASE/ai-infra/" 2>/dev/null || true
git mv "$BASE/queryIntentClassifier.test.js" "$BASE/ai-infra/" 2>/dev/null || true

# 其餘領域請按同樣模式補完...

echo "✅ 搬遷完成，請執行 npm run build 驗證"
```

#### 步驟 2：建立 Barrel Exports（第 1–2 天）

在每個子目錄建立 `index.js`，保持原有的 import 路徑向後相容：

```javascript
// src/services/agent-core/index.js
export { default as chatAgentLoop } from './chatAgentLoop.js';
export { default as agentResponsePresentationService } from './agentResponsePresentationService.js';
// ... 其他 exports
```

同時在 `src/services/index.js` 建立統一的 re-export：

```javascript
// src/services/index.js
// 保持向後相容 — 舊的 import 路徑仍然可用
export * from './agent-core/index.js';
export * from './chat/index.js';
export * from './forecast/index.js';
// ... 其他子目錄
```

#### 步驟 3：更新 Import 路徑（第 2–3 天）

使用自動化工具批次更新 import：

```bash
# 安裝 jscodeshift
npx jscodeshift -t scripts/codemods/update-service-imports.js src/ --dry --print

# 確認無誤後正式執行
npx jscodeshift -t scripts/codemods/update-service-imports.js src/
```

或者使用更簡單的 sed 方式：

```bash
# 範例：更新 chatAgentLoop 的 import 路徑
find src -name "*.js" -o -name "*.jsx" | xargs sed -i '' \
  "s|from ['\"].*services/chatAgentLoop|from '@/services/agent-core/chatAgentLoop|g"
```

#### 步驟 4：更新 Vite Code Splitting 設定（第 3 天）

修改 `vite.config.js` 的 manualChunks，對齊新的目錄結構：

```javascript
manualChunks(id) {
  // 按新的子目錄結構分 chunk
  if (id.includes('services/agent-core'))  return 'chunk-agent';
  if (id.includes('services/chat'))        return 'chunk-chat';
  if (id.includes('services/forecast'))    return 'chunk-forecast';
  if (id.includes('services/planning'))    return 'chunk-planning';
  if (id.includes('services/charts'))      return 'chunk-charts';
  if (id.includes('services/ai-infra'))    return 'chunk-ai-infra';
  // ... 其餘領域
}
```

#### 步驟 5：拆分大檔案（第 4–5 天）

對超過 500 行的檔案進行拆分。以最大的 `agentResponsePresentationService.js`（3,028 行）為例：

```
agent-core/
├── agentResponsePresentationService.js    # 主入口，只保留 orchestration（~200 行）
├── responseFormatter.js                   # 回應格式化邏輯（~500 行）
├── chartSelectionEngine.js                # 圖表選擇邏輯（~400 行）
├── answerCoverageValidator.js             # 回答覆蓋率驗證（~300 行）
├── responseTemplateResolver.js            # 模板解析（~300 行）
└── presentationUtils.js                   # 共用工具函式（~200 行）
```

拆分原則：
- 主檔案只保留 orchestration 邏輯（import + 呼叫子模組）
- 每個子模組不超過 500 行
- 保持 public API 不變，只重構內部結構
- 同步更新對應的 `.test.js` 檔案

#### 步驟 6：驗證（第 5 天）

```bash
# 完整驗證流程
npm run lint          # ESLint 通過
npm run test:run      # 全部 unit test 通過
npm run build         # Vite build 成功
npm run test:dw-gate  # Digital Worker gate 通過
npm run test:v1-gate  # V1 gate 通過
```

### 驗收標準

- `src/services/` 根層不超過 20 個檔案（barrel exports + 遷移中的遺留）
- 每個子目錄有 `index.js` barrel export
- 沒有超過 500 行的檔案
- 所有現有測試通過
- build 產出的 chunk 大小無異常增長

---

## 改善二：啟用 TypeScript Strict Mode

### 現況問題

目前的 `tsconfig.json` 設定了 `strict: false`，且 `checkJs: false`。整個 codebase 是 **100% JavaScript**（846 個 .js/.jsx 檔案，0 個 .ts/.tsx 檔案）。類型安全完全依賴 JSDoc 註解，但覆蓋率不均勻。

### 遷移策略：漸進式 TypeScript 導入

不建議一次性全部轉換，而是分四個階段逐步推進。

#### 階段 1：啟用 checkJs 和基礎檢查（第 1 週）

```jsonc
// tsconfig.json — 階段 1
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "allowJs": true,
    "checkJs": true,           // ← 開啟 JS 型別檢查
    "strict": false,           // 先不開 strict
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": [
    "src/domains/**/*.js",     // ← 先只檢查 domains 層
    "src/utils/**/*.js",
    "src/contracts/**/*.js"
  ]
}
```

這個階段只針對純函式層（domains、utils、contracts），因為這些檔案已有較好的 JSDoc 覆蓋。

修復方法：對於 checkJs 報出的錯誤，用 JSDoc 補上型別：

```javascript
// src/domains/inventory/calculator.js

/**
 * @param {number} currentStock
 * @param {number} dailyDemand
 * @param {number} [safetyStock=0]
 * @returns {number}
 */
export function calculateDaysToStockout(currentStock, dailyDemand, safetyStock = 0) {
  // ...
}
```

#### 階段 2：轉換 Contracts 和 Domains 為 TypeScript（第 2–3 週）

從最純淨的層開始轉換為 `.ts`：

```typescript
// src/contracts/planningApiContract.ts（原 .js → .ts）

export interface PlanningRequest {
  dataset_id: string;
  plan_type: 'demand' | 'supply' | 'capacity';
  horizon_days: number;
  constraints?: PlanConstraint[];
}

export interface PlanConstraint {
  type: 'budget' | 'capacity' | 'timeline';
  value: number;
  unit: string;
}

export interface PlanningResponse {
  plan_id: string;
  status: 'draft' | 'pending_approval' | 'approved';
  artifacts: PlanArtifact[];
  risk_score: number;
}
```

```typescript
// src/domains/inventory/calculator.ts（原 .js → .ts）

export function calculateDaysToStockout(
  currentStock: number,
  dailyDemand: number,
  safetyStock: number = 0
): number {
  if (typeof currentStock !== 'number' || isNaN(currentStock)) {
    throw new Error(`Invalid number for currentStock: ${currentStock}`);
  }
  // ...
}
```

轉換腳本：

```bash
# 批次重命名 .js → .ts（只在 domains/ 和 contracts/）
find src/domains src/contracts -name "*.js" -not -name "*.test.js" | while read f; do
  git mv "$f" "${f%.js}.ts"
done

# 對應的測試檔也一起改
find src/domains src/contracts -name "*.test.js" | while read f; do
  git mv "$f" "${f%.test.js}.test.ts"
done
```

#### 階段 3：啟用 Strict Mode 子集（第 3–4 週）

```jsonc
// tsconfig.json — 階段 3
{
  "compilerOptions": {
    "strict": false,
    "noImplicitAny": true,           // ← 禁止隱式 any
    "strictNullChecks": true,         // ← null/undefined 檢查
    "noImplicitReturns": true,        // ← 禁止隱式 return
    "noFallthroughCasesInSwitch": true
  },
  "include": [
    "src/domains/**/*.ts",
    "src/contracts/**/*.ts",
    "src/utils/**/*.js"
  ]
}
```

#### 階段 4：全面 Strict Mode（第 5–8 週）

逐步擴展 include 範圍至 services 和 components，最終目標：

```jsonc
// tsconfig.json — 最終狀態
{
  "compilerOptions": {
    "strict": true,
    "allowJs": true,
    "checkJs": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.js", "src/**/*.jsx"]
}
```

### ESLint 同步收緊

配合 TypeScript 遷移，逐步收緊 ESLint 規則：

```javascript
// eslint.config.js — 收緊版

// 階段 1：把 warn 升級為 error（針對已轉換的 .ts 檔案）
{
  files: ['src/domains/**/*.ts', 'src/contracts/**/*.ts'],
  rules: {
    'no-unused-vars': 'error',       // warn → error
    'no-empty': 'error',             // warn → error
    'no-prototype-builtins': 'error', // warn → error
  }
},

// 階段 2：全域收緊（當大部分檔案已轉換後）
{
  rules: {
    'no-unused-vars': ['error', {
      argsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_'
      // 移除 varsIgnorePattern: '^[A-Z_]' — 不再允許
    }],
  }
}
```

### 驗收標準

- 階段 1 完成：`npx tsc --noEmit` 對 domains/utils/contracts 零錯誤
- 階段 2 完成：所有 contract 和 domain 檔案為 .ts，有明確的 interface/type 定義
- 階段 3 完成：`noImplicitAny` 和 `strictNullChecks` 開啟且零錯誤
- 最終目標：全專案 `strict: true`，ESLint 無 warning

---

## 改善三：文件大掃除

### 現況問題

`docs/` 目錄有 **210 個 Markdown 檔案**，`docs/guides/` 裡有 14 個檔案（超過 `.cursorrules` 規定的 12 個上限），`docs/archive/` 有 74 個子目錄。專案根目錄有至少 15 個 `DI-*.md` 改善計畫文件互相重疊。

### 執行計畫

#### 步驟 1：清理根目錄的 DI-*.md 檔案（第 1 天）

```bash
# 將根目錄的改善計畫文件歸檔
mkdir -p docs/archive/improvement-plans

# 搬移所有 DI-*.md 到歸檔目錄
for f in DI-*.md; do
  git mv "$f" "docs/archive/improvement-plans/$f"
done

# 根目錄只保留 README.md 和 CHANGELOG.md、CONTRIBUTING.md
```

移動清單（根目錄現有的 DI-*.md）：
- `DI-AI-Employee-Improvement-Assessment.md` → archive
- `DI-Agent-Optimization-Plan.md` → archive
- `DI-Agent-Output-Quality-Improvement-Plan-v3.md` → archive
- `DI-Agent-Output-Quality-Improvement-Plan.md` → archive
- `DI-Architecture-Quality-Upgrade-Guide.md` → archive
- `DI-Chart-AC-Hybrid-Architecture.md` → archive
- `DI-Complete-Improvement-Plan-v2.md` → archive
- `DI-Complete-Modification-Plan.md` → archive
- `DI-Dashboard-Insights-Hub-Architecture.md` → archive
- `DI-Data-Understanding-Refactor-Plan.md` → archive
- `DI-Next-Level-Architecture-Guide.md` → archive
- `DI-Pipeline-Quality-Fix-Guide.md` → archive
- `DI-Pipeline-Round4-Fix-Guide.md` → archive
- `DI-Pipeline-Round5-Fix-Guide.md` → archive

#### 步驟 2：精簡 docs/guides/ 至 12 個以內（第 1 天）

目前 14 個檔案，需要合併或歸檔 2 個：

**保留的 12 個：**
1. `ARCHITECTURE_DESIGN.md` — 架構總覽
2. `DATABASE_SCHEMA_GUIDE.md` — 資料庫 schema
3. `DATA_VALIDATION_GUIDE.md` — 資料驗證規則
4. `DOMAIN_ARCHITECTURE_COMPLETE.md` — 領域架構
5. `INGEST_RPC_QUICKSTART.md` — 資料匯入快速上手
6. `ONE_SHOT_FRAMEWORK_GUIDE.md` — One-shot 框架
7. `UPLOAD_WORKFLOW_GUIDE.md` — 上傳流程
8. `UPLOAD_TYPES_REQUIRED_FIELDS.md` — 上傳欄位規格
9. `SUPABASE_SERVICES_API_REFERENCE.md` — Supabase API
10. `STEP1_SCHEMA_DEPLOYMENT_GUIDE.md` — Schema 部署
11. `NEW_TEMPLATES_GUIDE.md` — 模板指南
12. `README.md` — 目錄索引

**歸檔的 2 個：**
- `OPERATIONAL_COSTS_UPLOAD_GUIDE.md` → 合併到 `UPLOAD_WORKFLOW_GUIDE.md`
- `VALIDATION_RULES_QUICK_REFERENCE.md` → 合併到 `DATA_VALIDATION_GUIDE.md`

#### 步驟 3：為所有保留文件加上 metadata header（第 2 天）

根據 `.cursorrules` 的要求：

```yaml
---
owner: di-core-team
status: active
last_reviewed: 2026-03-24
---
```

自動化腳本：

```bash
#!/bin/bash
# scripts/add-doc-metadata.sh
TODAY=$(date +%Y-%m-%d)
HEADER="---\nowner: di-core-team\nstatus: active\nlast_reviewed: $TODAY\n---\n"

for f in docs/guides/*.md; do
  if ! head -1 "$f" | grep -q "^---$"; then
    echo -e "$HEADER\n$(cat "$f")" > "$f"
    echo "✅ Added metadata to $f"
  fi
done
```

#### 步驟 4：清理 docs/archive/ 重複內容（第 2–3 天）

```bash
# 列出 archive 裡所有檔案，按修改時間排序
find docs/archive -name "*.md" -printf "%T@ %p\n" | sort -n | tail -20

# 找出內容高度相似的檔案（使用 diff）
# 手動審核後刪除重複版本，只保留最新且最完整的
```

#### 步驟 5：建立文件索引（第 3 天）

在 `docs/README.md` 建立清晰的索引：

```markdown
# DI 文件索引

## 核心指南（docs/guides/ — 上限 12 份）
| 文件 | 用途 | 最後審核 |
|------|------|---------|
| ARCHITECTURE_DESIGN.md | 系統架構總覽 | 2026-03-24 |
| DATABASE_SCHEMA_GUIDE.md | 資料庫表結構 | 2026-03-24 |
| ... | ... | ... |

## 運維文件（docs/ 根層）
| 文件 | 用途 |
|------|------|
| SETUP.md | 本地開發環境設定 |
| DEPLOYMENT.md | 部署指南 |
| RUNBOOK.md | 運維手冊 |

## 歸檔（docs/archive/）
歷史文件，僅供參考。不主動維護。
```

### 驗收標準

- 根目錄只有 README.md、CHANGELOG.md、CONTRIBUTING.md 三個 .md 檔
- `docs/guides/` 不超過 12 個檔案
- 所有保留文件都有 metadata header
- `docs/README.md` 有完整索引

---

## 改善四：測試覆蓋率提升

### 現況問題

目前有 190 個 JavaScript 測試檔案和 53 個 Python 測試檔案。但相對於 199 個 component 和 269 個 service，覆蓋率不足。Service 層是測試最薄弱的環節——76 個測試檔案對應 269 個 service 檔案（覆蓋率約 28%）。

### 覆蓋率目標

| 層級 | 現況估計 | 目標 | 優先級 |
|------|---------|------|--------|
| `src/domains/` | ~80% | 95% | P1 |
| `src/services/` agent-core | ~40% | 80% | P1 |
| `src/services/` 其他 | ~25% | 60% | P2 |
| `src/components/` | ~30% | 50% | P3 |
| `src/hooks/` | ~40% | 80% | P2 |

### 實作步驟

#### 步驟 1：啟用覆蓋率報告（第 1 天）

```javascript
// vitest.config.js — 新增覆蓋率門檻
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './reports/coverage',
      // 全域門檻（逐步提高）
      thresholds: {
        lines: 40,        // 起始門檻，每週提高 5%
        functions: 40,
        branches: 30,
        statements: 40,
      },
      // 針對 domains 層設更高門檻
      'src/domains/**': {
        lines: 90,
        functions: 90,
        branches: 80,
      },
      include: ['src/**/*.{js,jsx,ts,tsx}'],
      exclude: [
        'src/**/*.test.{js,jsx,ts,tsx}',
        'src/test/**',
        'src/**/*.stories.{js,jsx}',
      ],
    },
  },
});
```

#### 步驟 2：補齊 Agent Core 測試（P1，第 1–2 週）

Agent core 是平台的核心，但幾個關鍵模組缺乏測試。

優先補齊清單：

```
需要新增測試的檔案（agent-core）：
□ dashboardSummaryAgent.js      — 目前無測試
□ canvasAgentService.js          — 目前無測試
□ agentAnswerCoverageService.js  — 目前無測試

需要擴充測試的檔案：
□ chatAgentLoop.js               — 有測試但缺少 error path 和 timeout 場景
□ agentResponsePresentationService.js — 測試存在但需要補齊 edge case
```

測試範本（以 dashboardSummaryAgent 為例）：

```javascript
// src/services/agent-core/dashboardSummaryAgent.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateDashboardSummary } from './dashboardSummaryAgent.js';

describe('dashboardSummaryAgent', () => {
  // Happy path
  it('should generate summary from valid dashboard data', async () => {
    const mockData = {
      kpis: [{ name: 'revenue', value: 1000000 }],
      alerts: [{ severity: 'high', message: 'Stock low' }],
    };
    const result = await generateDashboardSummary(mockData);
    expect(result).toHaveProperty('summary');
    expect(result.summary).toBeTruthy();
  });

  // Edge case: empty data
  it('should handle empty dashboard gracefully', async () => {
    const result = await generateDashboardSummary({ kpis: [], alerts: [] });
    expect(result.summary).toContain('No data');
  });

  // Error path: null input
  it('should throw on null input', async () => {
    await expect(generateDashboardSummary(null)).rejects.toThrow();
  });

  // LLM failure fallback
  it('should return fallback summary when LLM is unavailable', async () => {
    vi.mock('./aiProxyService', () => ({
      callAI: vi.fn().mockRejectedValue(new Error('LLM timeout')),
    }));
    const result = await generateDashboardSummary({ kpis: [{ name: 'x', value: 1 }] });
    expect(result.fallback).toBe(true);
  });
});
```

#### 步驟 3：補齊 Service 層關鍵路徑測試（P2，第 2–4 週）

按照業務重要性排序：

```
第一批（Week 2）：
□ chatPlanningService.js           — 規劃引擎核心（目前無獨立測試）
□ chatForecastService.js           — 預測引擎核心
□ chatRiskService.js               — 風險引擎核心

第二批（Week 3）：
□ oneShotImportService.js          — 資料匯入（用戶首要接觸點）
□ analysisDomainEnrichment.js      — 分析前處理
□ datasetProfilingService.js       — Dataset 分析

第三批（Week 4）：
□ approvalWorkflowService.js       — 審批流程
□ scenarioEngine.js                — 場景引擎
□ scheduledTaskService.js          — 排程任務
```

#### 步驟 4：加入 CI 覆蓋率檢查（第 2 週）

在 `package.json` 中加入覆蓋率 CI 指令：

```json
{
  "scripts": {
    "test:coverage:ci": "vitest run --coverage --reporter=json --outputFile=reports/coverage.json",
    "test:coverage:check": "vitest run --coverage --coverage.thresholdAutoUpdate"
  }
}
```

在 CI pipeline（GitHub Actions）中加入：

```yaml
# .github/workflows/ci.yml
- name: Run tests with coverage
  run: npm run test:coverage:ci

- name: Check coverage thresholds
  run: |
    LINES=$(jq '.total.lines.pct' reports/coverage.json)
    if (( $(echo "$LINES < 40" | bc -l) )); then
      echo "❌ Line coverage $LINES% is below 40% threshold"
      exit 1
    fi
```

#### 步驟 5：Python 測試補強（第 3–4 週）

```bash
# 確認現有覆蓋率
cd /path/to/project
./venv312/bin/python -m pytest tests/ --cov=src/ml --cov-report=term-missing

# 重點補齊：
# □ src/ml/api/main.py — API 端點整合測試
# □ src/ml/demand_forecasting/ — 預測模型測試
# □ src/ml/governance/ — 權限控制測試
```

### 驗收標準

- `npm run test:coverage` 全域覆蓋率 ≥ 40%（每週提高 5%）
- `src/domains/` 覆蓋率 ≥ 90%
- Agent core 關鍵路徑都有 happy path + error path 測試
- CI pipeline 包含覆蓋率門檻檢查

---

## 改善五：替換手動 Async 控制工具

### 現況問題

`src/services/aiProxyService.js` 中自行實作了 `AsyncSemaphore` 和 `CircuitBreaker` 兩個類別。雖然功能正確，但存在以下風險：

1. **AsyncSemaphore** 手動管理 FIFO queue 和 AbortSignal，容易有 race condition
2. **CircuitBreaker** 的狀態機（CLOSED → OPEN → HALF_OPEN）缺乏完整的單元測試覆蓋
3. **Backpressure** 邏輯散落在多處，動態調整 `maxConcurrent` 容易產生非預期行為
4. **除錯困難** — 沒有可觀測性，出問題時難以追蹤狀態轉換

### 替換方案

用成熟的開源 library 替換：

| 功能 | 現有實作 | 替換方案 | npm 週下載量 |
|------|---------|---------|-------------|
| 並發控制 | AsyncSemaphore | `p-queue` | 15M+ |
| 斷路器 | CircuitBreaker | `cockatiel` | 1M+ |
| 重試 | 手動 delay loop | `cockatiel` (RetryPolicy) | 同上 |

### 實作步驟

#### 步驟 1：安裝依賴（第 1 天）

```bash
npm install p-queue cockatiel
```

#### 步驟 2：建立新的 resilience layer（第 1–2 天）

建立一個新的 `src/services/ai-infra/resilience.js` 模組：

```javascript
// src/services/ai-infra/resilience.js
import PQueue from 'p-queue';
import {
  CircuitBreakerPolicy,
  ConsecutiveBreaker,
  ExponentialBackoff,
  handleAll,
  retry,
  wrap,
  SamplingBreaker,
} from 'cockatiel';

// ============================================================
// Provider 配置
// ============================================================

const PROVIDER_CONFIGS = {
  kimi: { concurrency: 4, breaker: { threshold: 3, window: 30_000, cooldown: 60_000 } },
  gemini: { concurrency: 4, breaker: { threshold: 3, window: 30_000, cooldown: 60_000 } },
  default: { concurrency: 1, breaker: { threshold: 3, window: 30_000, cooldown: 60_000 } },
};

// ============================================================
// 每個 Provider 一組 Queue + CircuitBreaker
// ============================================================

const providerInstances = new Map();

function getProviderInstance(provider) {
  if (providerInstances.has(provider)) {
    return providerInstances.get(provider);
  }

  const config = PROVIDER_CONFIGS[provider] || PROVIDER_CONFIGS.default;

  // 並發佇列（取代 AsyncSemaphore）
  const queue = new PQueue({
    concurrency: config.concurrency,
    timeout: 180_000,        // 180s timeout
    throwOnTimeout: true,
  });

  // 斷路器（取代 CircuitBreaker class）
  const circuitBreaker = new CircuitBreakerPolicy(
    handleAll,
    {
      breaker: new SamplingBreaker({
        threshold: 0.5,           // 50% 失敗率觸發
        duration: config.breaker.window,
        minimumRps: 1,
      }),
      halfOpenAfter: config.breaker.cooldown,
    }
  );

  // 重試策略（取代手動 delay loop）
  const retryPolicy = retry(handleAll, {
    maxAttempts: 4,
    backoff: new ExponentialBackoff({
      initialDelay: 2_000,
      maxDelay: 25_000,
      exponent: 2.5,
    }),
  });

  // 組合策略：retry → circuitBreaker
  const policy = wrap(retryPolicy, circuitBreaker);

  // 可觀測性
  circuitBreaker.onStateChange((state) => {
    console.warn(`[Resilience] ${provider} circuit breaker → ${state}`);
  });

  circuitBreaker.onBreak(() => {
    // Backpressure: 斷路器打開時降低並發
    queue.concurrency = 1;
    console.warn(`[Resilience] ${provider} backpressure: concurrency → 1`);
  });

  circuitBreaker.onReset(() => {
    // 恢復正常並發
    queue.concurrency = config.concurrency;
    console.info(`[Resilience] ${provider} recovered: concurrency → ${config.concurrency}`);
  });

  const instance = { queue, circuitBreaker, retryPolicy, policy, config };
  providerInstances.set(provider, instance);
  return instance;
}

// ============================================================
// Public API（保持與現有 aiProxyService 相容）
// ============================================================

/**
 * 執行受保護的 AI 請求
 * @param {string} provider - 'kimi' | 'gemini' | 'default'
 * @param {() => Promise<any>} fn - 實際的 API 呼叫
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<any>}
 */
export async function executeWithResilience(provider, fn, options = {}) {
  const { queue, policy } = getProviderInstance(provider);

  return queue.add(
    () => policy.execute(async ({ signal }) => {
      // 支援外部 AbortSignal
      if (options.signal?.aborted) {
        throw new Error('Request aborted');
      }
      return fn({ signal: options.signal });
    }),
    { signal: options.signal }
  );
}

/**
 * 取得 Provider 狀態（用於 health check）
 */
export function getProviderStatus(provider) {
  if (!providerInstances.has(provider)) {
    return { state: 'UNINITIALIZED', pending: 0 };
  }
  const { queue, circuitBreaker } = providerInstances.get(provider);
  return {
    state: circuitBreaker.state,
    pending: queue.pending,
    size: queue.size,
  };
}

/**
 * 重置指定 Provider（用於測試）
 */
export function resetProvider(provider) {
  providerInstances.delete(provider);
}
```

#### 步驟 3：重構 aiProxyService.js（第 2–3 天）

```javascript
// src/services/ai-infra/aiProxyService.js — 重構後

import { executeWithResilience, getProviderStatus } from './resilience.js';

// 移除整個 AsyncSemaphore class（~80 行）
// 移除整個 CircuitBreaker class（~60 行）
// 移除手動重試邏輯（~40 行）

/**
 * 呼叫 AI Proxy（核心函式）
 */
export async function callAIProxy(payload, options = {}) {
  const provider = inferProxyProvider(payload);

  return executeWithResilience(
    provider,
    async ({ signal }) => {
      const response = await fetch(getProxyUrl(), {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(payload),
        signal,
      });

      if (!response.ok) {
        const error = new Error(`AI Proxy error: ${response.status}`);
        error.status = response.status;
        throw error;
      }

      return response.json();
    },
    { signal: options.signal }
  );
}

// 保留 warmupEdgeFunction、inferProxyProvider 等輔助函式不變
```

#### 步驟 4：為新的 resilience layer 寫測試（第 3 天）

```javascript
// src/services/ai-infra/resilience.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeWithResilience, getProviderStatus, resetProvider } from './resilience.js';

describe('resilience layer', () => {
  beforeEach(() => {
    resetProvider('test');
  });

  it('should limit concurrency', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = () => executeWithResilience('default', async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 50));
      concurrent--;
      return 'ok';
    });

    // 發射 5 個並行請求，default provider 限制為 1
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(maxConcurrent).toBe(1);
  });

  it('should open circuit after consecutive failures', async () => {
    const failingFn = async () => { throw new Error('fail'); };

    // 連續失敗直到斷路器打開
    for (let i = 0; i < 5; i++) {
      try { await executeWithResilience('test', failingFn); } catch {}
    }

    const status = getProviderStatus('test');
    // Circuit should be open or half-open after failures
    expect(['open', 'halfOpen']).toContain(status.state);
  });

  it('should respect AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeWithResilience('default', async () => 'ok', { signal: controller.signal })
    ).rejects.toThrow();
  });
});
```

#### 步驟 5：移除舊程式碼並驗證（第 4 天）

```bash
# 確認沒有其他地方直接引用 AsyncSemaphore 或 CircuitBreaker
grep -r "AsyncSemaphore\|new CircuitBreaker" src/ --include="*.js" --include="*.jsx"

# 如果有其他檔案引用，更新它們指向新的 resilience module
# 然後跑完整測試
npm run test:run
npm run test:dw-gate
npm run build
```

### 驗收標準

- `AsyncSemaphore` 和 `CircuitBreaker` 兩個 class 完全移除
- 用 `p-queue` + `cockatiel` 取代
- 新的 resilience layer 有獨立的單元測試
- 所有現有的 AI proxy 相關測試通過
- 斷路器狀態可在 health check 端點查看

---

## 執行時程總覽

```
Week 1:  [改善一] Services 重組 ─────────────────
         [改善三] 文件大掃除 ──────

Week 2:  [改善一] Import 更新 + 驗證 ───────────
         [改善二] 階段 1 — checkJs ────
         [改善四] 覆蓋率報告 + Agent Core 測試 ──

Week 3:  [改善二] 階段 2 — Contracts/Domains → TS ─
         [改善四] Service 層測試 ─────────
         [改善五] Resilience Layer ─────────

Week 4:  [改善一] 大檔案拆分 ────────
         [改善二] 階段 3 — noImplicitAny ────
         [改善四] Service 層測試（續）───────
         [改善五] 替換完成 + 驗證 ───────

Week 5-6: [改善二] 階段 4 — strict: true 擴展 ────
           [改善四] Component 測試補強 ─────────

Week 7-8: [改善二] 全專案 strict mode ─────────
           全面驗證 + 文件更新 ─────────
```

**可並行的項目：**
- 改善一（Services 重組）和 改善三（文件整理）完全獨立，可同時進行
- 改善四（測試）可以在改善一完成後立即開始
- 改善五（Async 工具）可以獨立於其他改善進行

**有依賴的項目：**
- 改善二（TypeScript）的 include 路徑需要在改善一（目錄重組）之後調整
- 改善四（測試路徑）需要配合改善一的目錄結構

---

## 風險與回退策略

### 風險 1：Services 重組導致大量 import 斷裂

**緩解措施：**
- 使用 barrel exports（`index.js`）保持向後相容
- 分批提交，每移動一個 domain 就跑一次 `npm run build`
- 保留舊路徑的 re-export 至少兩週，確認無殘留引用後再移除

**回退方案：** 每個 domain 搬遷為獨立的 git commit，可逐個 revert。

### 風險 2：TypeScript 遷移引入大量型別錯誤

**緩解措施：**
- 漸進式遷移，先從最乾淨的 domains 層開始
- 使用 `// @ts-ignore` 或 `// @ts-expect-error` 暫時壓制無法立即修復的錯誤
- `tsconfig` 的 include 範圍逐步擴大

**回退方案：** 每個階段的 `tsconfig.json` 變更為獨立 commit，可隨時回退到上一階段。

### 風險 3：Async 工具替換影響生產穩定性

**緩解措施：**
- 先在 staging 環境驗證 `cockatiel` + `p-queue` 的行為與舊實作一致
- 寫對照測試：同樣的場景分別用新舊實作跑，結果必須一致
- Feature flag 控制切換：`VITE_USE_NEW_RESILIENCE=true`

**回退方案：** 保留舊的 `AsyncSemaphore` 和 `CircuitBreaker` 在 `_legacy/` 目錄，透過 feature flag 切換。

### 風險 4：測試覆蓋率門檻阻擋 CI

**緩解措施：**
- 初始門檻設為 40%（低於現況，確保不會立即失敗）
- 每週提高 5%，給團隊時間補齊測試
- 允許個別 module 申請豁免（在 vitest.config 中 exclude）

**回退方案：** 降低門檻或暫時關閉 CI 覆蓋率檢查。

---

> **附註：** 本指南中的所有程式碼範例都基於專案現有的技術棧（React 19 + Vite + Vitest + Supabase + FastAPI）。執行前請確認 Node.js ≥ 18 和 Python ≥ 3.12 環境已就緒。
