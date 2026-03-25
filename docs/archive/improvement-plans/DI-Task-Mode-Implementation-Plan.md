# Decision Intelligence — Task Mode 完整實作方案

> 目標：Chat 變成 Command Center，報告在背景產出、獨立 Tab 查看、一鍵匯出 Excel，
> 並銜接排程任務、自動分派、完成通知等工作流。

---

## 一、現有基礎設施盤點（可直接複用）

深入掃描整個 codebase 後，你已經有大量可以複用的基礎設施：

| 能力 | 現有元件 | 位置 | 複用程度 |
|------|---------|------|---------|
| 任務狀態機 | `taskStateMachine.js` | `src/services/aiEmployee/` | ⭐ 直接複用 |
| 步驟執行框架 | `orchestrator.js` + executor registry | `src/services/aiEmployee/` | ⭐ 擴展複用 |
| 非同步 Job 追蹤 | `di_jobs` table + `asyncRunsApiClient.js` | `sql/migrations/` + `src/services/` | ⭐ 直接複用 |
| Artifact 合約 | 120+ validated types | `src/contracts/diArtifactContractV1.js` | ⭐ 擴展新 type |
| Canvas 分頁 | SplitShell + CanvasPanel (7 tabs) | `src/components/chat/` | ⭐ 加新 tab |
| Excel 匯出 | SheetJS `exportWorkbook.js` | `src/utils/` | ⭐ 直接複用 |
| 記憶系統 | `aiEmployeeMemoryService.js` (query/failure patterns) | `src/services/` | ⭐ 直接複用 |
| 通知 | `addNotification()` callback | `useWorkflowExecutor.js` | ⭐ 直接複用 |
| 卡片渲染 | MessageCardRenderer (100+ card types) | `src/views/DecisionSupportView/` | ⭐ 加新 card |
| Conversation 持久化 | Supabase + localStorage fallback | `useConversationManager.js` | ⭐ 直接複用 |
| 審計日誌 | `di_plan_audit_log` | `sql/migrations/` | ⭐ 直接複用 |

**核心發現：AI Employee 的 orchestrator 已經有完整的任務狀態機 + 步驟執行框架，但目前只用於 forecast/plan/risk workflow，完全沒接到 chat analysis flow。**

**這意味著 Task Mode 的核心工作不是「從零建」，而是「把 chat analysis 接入已有的 orchestrator」。**

---

## 二、整體架構設計

### 2.1 三層架構

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: Chat Command Center                            │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  ChatThread (左側)                                    │ │
│  │  • 用戶下指令 → 輕量確認卡片                            │ │
│  │  • 報告完成 → 通知卡片 + 連結到 Report Viewer           │ │
│  │  • 多輪對話不被阻塞                                    │ │
│  └─────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│  Layer 2: Background Task Engine                         │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Task Queue                                          │ │
│  │  • 基於現有 orchestrator + di_jobs                    │ │
│  │  • 最多 2 並行 + FIFO 佇列                            │ │
│  │  • 進度推送到 Chat (SSE / polling)                    │ │
│  └─────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│  Layer 3: Report Viewer & Export                         │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  CanvasPanel 新增 "Reports" Tab (右側)                │ │
│  │  • 報告列表 + 預覽                                     │ │
│  │  • Pin / Archive / Delete                             │ │
│  │  • 一鍵 Export to Excel / PDF                         │ │
│  │  • QA Score 標籤 (Ready / Draft / Failed)             │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 2.2 資料流全景

```
User: "比較 2016 vs 2017 營收，給我最高銷售地區"
    │
    ▼
[Intent Parser] → 判斷這是 analysis task（不是 greeting/meta）
    │
    ▼
[Answer Contract LLM] → { required_dimensions: ["revenue","region"], task_type: "comparison" }
    │
    ▼
[Task Dispatcher] ← 新元件
    │
    ├──→ Chat: 顯示 TaskDispatchCard（"已排入分析任務 #T-0042，預計 20 秒"）
    │
    └──→ Task Queue: 建立 analysis_task record
              │
              ▼
         [Background Worker]
              │
              ├── Step 1: Query Planner (1s)
              ├── Step 2: Evidence Agent — 執行 SQL/Python (8-15s)
              │     │
              │     ├──→ [Progressive Update] → Chat: "已取得營收數據"
              │     └──→ [Progressive Update] → Report Viewer: 即時更新 metric pills
              │
              ├── Step 3: Evidence Registry — 確定性驗證 (0.1s)
              ├── Step 4: Synthesis Agent (3-5s)
              └── Step 5: QA (1s)
              │
              ▼
         [Report Persistence] → analysis_reports table
              │
              ├──→ Chat: TaskCompleteCard（"報告 #T-0042 完成 ✅ QA: 8.7/10"）
              ├──→ Report Viewer: 報告自動出現
              └──→ Notification: toast "分析完成"
```

---

## 三、資料庫設計

### 3.1 新增表：`analysis_reports`

```sql
-- sql/migrations/analysis_reports.sql

CREATE TABLE public.analysis_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 關聯
  user_id UUID NOT NULL REFERENCES auth.users(id),
  conversation_id UUID REFERENCES public.conversations(id),
  task_id UUID,                          -- 關聯到 di_jobs.id (如果由 task queue 執行)

  -- 內容
  title TEXT NOT NULL,                   -- 報告標題（從 headline 生成）
  user_query TEXT NOT NULL,              -- 原始用戶提問
  answer_contract JSONB,                 -- 使用的 answer contract
  brief_json JSONB NOT NULL,             -- 完整的 normalized brief
  tool_calls_json JSONB,                 -- 工具調用記錄（用於 audit 和 re-run）
  evidence_registry_json JSONB,          -- Evidence Registry 快照（方案一實施後）

  -- 品質
  qa_score NUMERIC(4,2),                 -- 最終 QA 分數
  qa_dimension_scores JSONB,             -- 各維度分數
  qa_status TEXT CHECK (qa_status IN ('ready', 'draft', 'failed', 'pending')),
  qa_blockers JSONB DEFAULT '[]',

  -- 狀態
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  execution_time_ms INT,
  error_message TEXT,

  -- 使用者標記
  pinned BOOLEAN DEFAULT FALSE,
  archived BOOLEAN DEFAULT FALSE,
  user_rating SMALLINT CHECK (user_rating BETWEEN 1 AND 5),
  user_feedback TEXT,

  -- Export
  exported_at TIMESTAMPTZ,
  export_format TEXT,                    -- 'xlsx' | 'pdf' | null

  -- 排程
  schedule_id UUID,                      -- 如果由排程觸發
  template_id UUID,                      -- 如果基於報告模板

  -- 時間戳
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 索引
CREATE INDEX idx_reports_user_status ON public.analysis_reports(user_id, status);
CREATE INDEX idx_reports_user_pinned ON public.analysis_reports(user_id, pinned) WHERE pinned = TRUE;
CREATE INDEX idx_reports_conversation ON public.analysis_reports(conversation_id);
CREATE INDEX idx_reports_schedule ON public.analysis_reports(schedule_id);

-- RLS
ALTER TABLE public.analysis_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own reports" ON public.analysis_reports
  FOR ALL USING (auth.uid() = user_id);
```

### 3.2 新增表：`report_templates`

```sql
-- 報告模板 — 可重複使用的分析配置

CREATE TABLE public.report_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),

  name TEXT NOT NULL,                    -- "月會銷售報告"
  description TEXT,                      -- "包含本月營收、YoY成長、前5地區"

  -- 模板配置
  query_template TEXT NOT NULL,          -- 帶佔位符的提問模板
                                         -- "比較 {{current_month}} vs {{previous_month}} 的營收，
                                         --  給我前 {{top_n}} 個銷售地區"
  default_params JSONB DEFAULT '{}',     -- { "top_n": 5 }
  answer_contract_override JSONB,        -- 固定的 answer contract（覆蓋 LLM 推斷）

  -- 排程
  cron_expression TEXT,                  -- '0 9 * * 1' = 每週一早上 9 點
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  schedule_enabled BOOLEAN DEFAULT FALSE,

  -- 通知
  notify_on_complete BOOLEAN DEFAULT TRUE,
  notify_channels JSONB DEFAULT '["in_app"]',  -- ["in_app", "email"]

  -- metadata
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.report_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own templates" ON public.report_templates
  FOR ALL USING (auth.uid() = user_id);
```

### 3.3 新增表：`task_queue`

```sql
-- 分析任務佇列 — 與現有 di_jobs 互補
-- di_jobs 追蹤底層 job execution，task_queue 追蹤用戶層面的任務生命週期

CREATE TABLE public.analysis_task_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),

  -- 任務描述
  user_query TEXT NOT NULL,
  answer_contract JSONB,
  priority SMALLINT DEFAULT 0,           -- 0=normal, 1=high, -1=low

  -- 執行狀態
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  job_id UUID REFERENCES public.di_jobs(id),  -- 關聯到底層 job
  report_id UUID REFERENCES public.analysis_reports(id),  -- 完成後關聯到報告

  -- 來源
  source TEXT DEFAULT 'chat'
    CHECK (source IN ('chat', 'schedule', 'api', 'delegation')),
  conversation_id UUID,
  template_id UUID REFERENCES public.report_templates(id),

  -- 進度
  progress_pct NUMERIC(5,2) DEFAULT 0,
  progress_message TEXT,

  -- 時間
  queued_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  estimated_duration_ms INT,             -- 基於歷史平均預估

  -- 並行控制
  worker_id TEXT                          -- 哪個 worker 在執行
);

CREATE INDEX idx_task_queue_user_status ON public.analysis_task_queue(user_id, status);
CREATE INDEX idx_task_queue_pending ON public.analysis_task_queue(status, priority DESC, queued_at ASC)
  WHERE status = 'queued';
```

---

## 四、後端 Services 設計

### 4.1 `taskDispatcherService.js` — 任務派發核心

```javascript
// src/services/taskDispatcherService.js
//
// 職責：接收 chat 的分析請求，建立任務，管理佇列，協調執行

import { supabase } from '../lib/supabaseClient.js';
import { runAgentLoop } from './chatAgentLoop.js';
import { resolveAgentAnswerContract } from './agentResponsePresentationService.js';

// ── 配置 ──
const MAX_CONCURRENT_TASKS = 2;
const POLL_INTERVAL_MS = 2000;

// ── 任務派發（從 chat 觸發）──
export async function dispatchAnalysisTask({
  userId,
  userQuery,
  conversationId,
  answerContract = null,
  priority = 0,
  source = 'chat',
  templateId = null,
  callbacks = {},
}) {
  // 1. 如果沒有 answer contract，先推斷
  if (!answerContract) {
    answerContract = await resolveAgentAnswerContract({
      userMessage: userQuery,
      mode: 'analysis',
    });
  }

  // 2. 預估執行時間（基於歷史）
  const estimatedDuration = await estimateTaskDuration(userId, answerContract);

  // 3. 寫入 task queue
  const { data: task, error } = await supabase
    .from('analysis_task_queue')
    .insert({
      user_id: userId,
      user_query: userQuery,
      answer_contract: answerContract,
      priority,
      source,
      conversation_id: conversationId,
      template_id: templateId,
      estimated_duration_ms: estimatedDuration,
      status: 'queued',
    })
    .select()
    .single();

  if (error) throw new Error(`Task dispatch failed: ${error.message}`);

  // 4. 嘗試立即執行（如果有空位）
  tryExecuteNext(userId, callbacks);

  return {
    taskId: task.id,
    estimatedDuration,
    queuePosition: await getQueuePosition(userId, task.id),
  };
}

// ── 佇列管理 ──
async function tryExecuteNext(userId, callbacks = {}) {
  // 計算目前並行數
  const { count: runningCount } = await supabase
    .from('analysis_task_queue')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'running');

  if (runningCount >= MAX_CONCURRENT_TASKS) return;

  // 取下一個 queued 任務（priority DESC, queued_at ASC）
  const { data: nextTask } = await supabase
    .from('analysis_task_queue')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'queued')
    .order('priority', { ascending: false })
    .order('queued_at', { ascending: true })
    .limit(1)
    .single();

  if (!nextTask) return;

  // 標記為 running
  await supabase
    .from('analysis_task_queue')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', nextTask.id);

  // 背景執行（不 await）
  executeTaskInBackground(nextTask, callbacks).catch(err => {
    console.error(`[TaskDispatcher] Background task failed:`, err);
  });
}

// ── 背景執行 ──
async function executeTaskInBackground(task, callbacks = {}) {
  const startTime = Date.now();

  try {
    // 進度回調
    const updateProgress = async (pct, message) => {
      await supabase
        .from('analysis_task_queue')
        .update({ progress_pct: pct, progress_message: message })
        .eq('id', task.id);
      callbacks.onProgress?.(task.id, pct, message);
    };

    await updateProgress(5, '正在規劃查詢策略...');

    // === 執行 Agent Loop ===
    const agentResult = await runAgentLoop({
      message: task.user_query,
      conversationHistory: [],
      systemPrompt: '',
      toolContext: await buildToolContext(task.user_id),
      answerContract: task.answer_contract,
      mode: 'analysis',
      callbacks: {
        onToolCall: (tc) => {
          updateProgress(
            Math.min(80, 10 + (tc._stepIndex || 0) * 15),
            `執行 ${tc.name}...`
          );
        },
        onToolResult: (tc) => {
          callbacks.onToolResult?.(task.id, tc);
        },
      },
    });

    await updateProgress(85, '正在生成報告...');

    // === 取得 presentation（brief + QA）===
    const { presentAgentResponse } = await import('./agentResponsePresentationService.js');
    const presentation = await presentAgentResponse({
      userMessage: task.user_query,
      answerContract: task.answer_contract,
      toolCalls: agentResult.toolCalls,
      finalAnswerText: agentResult.finalAnswerText,
      mode: 'analysis',
    });

    await updateProgress(95, '品質檢查中...');

    // === 寫入 analysis_reports ===
    const qaScore = presentation.qa?.score || 0;
    const qaStatus = qaScore >= 8.0 && (presentation.qa?.blockers || []).length === 0
      ? 'ready'
      : qaScore >= 5.0 ? 'draft' : 'failed';

    const { data: report } = await supabase
      .from('analysis_reports')
      .insert({
        user_id: task.user_id,
        conversation_id: task.conversation_id,
        task_id: task.id,
        title: presentation.brief?.headline || task.user_query.slice(0, 100),
        user_query: task.user_query,
        answer_contract: task.answer_contract,
        brief_json: presentation.brief,
        tool_calls_json: agentResult.toolCalls,
        qa_score: qaScore,
        qa_dimension_scores: presentation.qa?.dimension_scores,
        qa_status: qaStatus,
        qa_blockers: presentation.qa?.blockers || [],
        status: 'completed',
        execution_time_ms: Date.now() - startTime,
        completed_at: new Date().toISOString(),
      })
      .select()
      .single();

    // === 更新 task queue ===
    await supabase
      .from('analysis_task_queue')
      .update({
        status: 'completed',
        report_id: report.id,
        completed_at: new Date().toISOString(),
        progress_pct: 100,
        progress_message: '完成',
      })
      .eq('id', task.id);

    // === 通知 ===
    callbacks.onTaskComplete?.(task.id, report);

    // === 記錄到 memory ===
    await writeQueryPatternIfSuccessful(task, agentResult, qaScore);

  } catch (err) {
    await supabase
      .from('analysis_task_queue')
      .update({
        status: 'failed',
        progress_message: err.message,
        completed_at: new Date().toISOString(),
      })
      .eq('id', task.id);

    callbacks.onTaskFailed?.(task.id, err);
  }

  // 嘗試執行下一個任務
  tryExecuteNext(task.user_id, callbacks);
}

// ── 預估執行時間 ──
async function estimateTaskDuration(userId, answerContract) {
  const { data: recentTasks } = await supabase
    .from('analysis_reports')
    .select('execution_time_ms')
    .eq('user_id', userId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(10);

  if (!recentTasks?.length) return 20000; // 預設 20 秒

  const avg = recentTasks.reduce((sum, t) => sum + (t.execution_time_ms || 20000), 0) / recentTasks.length;

  // 根據 complexity 調整
  const dimCount = answerContract?.required_dimensions?.length || 0;
  const multiplier = 1 + dimCount * 0.15; // 每多一個 dimension 多 15%

  return Math.round(avg * multiplier);
}

// ── 佇列位置 ──
async function getQueuePosition(userId, taskId) {
  const { data: queued } = await supabase
    .from('analysis_task_queue')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'queued')
    .order('priority', { ascending: false })
    .order('queued_at', { ascending: true });

  const idx = queued?.findIndex(t => t.id === taskId) ?? -1;
  return idx + 1; // 1-based position, 0 = already running
}

// ── 取消任務 ──
export async function cancelTask(taskId) {
  await supabase
    .from('analysis_task_queue')
    .update({ status: 'cancelled', completed_at: new Date().toISOString() })
    .eq('id', taskId)
    .in('status', ['queued', 'running']);
}

// ── 重新執行 ──
export async function retryTask(taskId, callbacks = {}) {
  const { data: task } = await supabase
    .from('analysis_task_queue')
    .select('*')
    .eq('id', taskId)
    .single();

  if (!task) throw new Error('Task not found');

  return dispatchAnalysisTask({
    userId: task.user_id,
    userQuery: task.user_query,
    conversationId: task.conversation_id,
    answerContract: task.answer_contract,
    priority: task.priority,
    source: task.source,
    callbacks,
  });
}
```

### 4.2 `reportService.js` — 報告 CRUD

```javascript
// src/services/reportService.js
//
// 職責：報告的查詢、更新、匯出、模板管理

import { supabase } from '../lib/supabaseClient.js';
import { exportWorkbook, appendJsonSheet, appendNarrativeSheet, appendKVSheet } from '../utils/exportWorkbook.js';

// ── 查詢報告 ──
export async function fetchReports(userId, {
  status = null,        // 'ready' | 'draft' | 'failed' | null (all)
  pinned = null,        // true | false | null (all)
  archived = false,     // 預設不顯示 archived
  conversationId = null,
  limit = 20,
  offset = 0,
  orderBy = 'created_at',
  orderDir = 'desc',
} = {}) {
  let query = supabase
    .from('analysis_reports')
    .select('id, title, user_query, qa_score, qa_status, status, pinned, archived, execution_time_ms, created_at, completed_at')
    .eq('user_id', userId)
    .eq('archived', archived)
    .order(orderBy, { ascending: orderDir === 'asc' })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('qa_status', status);
  if (pinned !== null) query = query.eq('pinned', pinned);
  if (conversationId) query = query.eq('conversation_id', conversationId);

  const { data, error, count } = await query;
  if (error) throw error;
  return { reports: data, total: count };
}

// ── 取得完整報告 ──
export async function fetchReportDetail(reportId) {
  const { data, error } = await supabase
    .from('analysis_reports')
    .select('*')
    .eq('id', reportId)
    .single();
  if (error) throw error;
  return data;
}

// ── 更新報告狀態 ──
export async function updateReport(reportId, updates) {
  const allowed = ['pinned', 'archived', 'user_rating', 'user_feedback', 'title'];
  const filtered = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.includes(k))
  );
  filtered.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('analysis_reports')
    .update(filtered)
    .eq('id', reportId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── 匯出報告到 Excel ──
export async function exportReportToExcel(reportId) {
  const report = await fetchReportDetail(reportId);
  if (!report?.brief_json) throw new Error('Report has no brief data');

  const brief = report.brief_json;
  const wb = exportWorkbook();

  // Sheet 1: Executive Summary
  appendKVSheet(wb, 'Summary', [
    ['Report Title', brief.headline || report.title],
    ['Generated', new Date(report.completed_at).toLocaleString()],
    ['User Query', report.user_query],
    ['QA Score', `${report.qa_score}/10 (${report.qa_status})`],
    ['Executive Summary', brief.executive_summary || ''],
  ]);

  // Sheet 2: Key Metrics
  if (brief.metric_pills?.length > 0) {
    appendJsonSheet(wb, 'Key Metrics', brief.metric_pills.map(p => ({
      Metric: p.label,
      Value: p.value,
      Source: p.source || '',
    })));
  }

  // Sheet 3: Full Analysis
  appendNarrativeSheet(wb, 'Analysis', [
    '# Analysis Report',
    '',
    '## Summary',
    brief.summary || '',
    '',
    '## Key Findings',
    ...(brief.key_findings || []).map((f, i) => `${i + 1}. ${f}`),
    '',
    '## Implications',
    ...(brief.implications || []).map((f, i) => `${i + 1}. ${f}`),
    '',
    '## Caveats',
    ...(brief.caveats || []).map((f, i) => `${i + 1}. ${f}`),
    '',
    '## Next Steps',
    ...(brief.next_steps || []).map((f, i) => `${i + 1}. ${f}`),
    '',
    '## Methodology',
    brief.methodology_note || 'N/A',
  ].join('\n'));

  // Sheet 4: Data Tables
  if (brief.tables?.length > 0) {
    for (const table of brief.tables) {
      if (table.columns && table.rows) {
        const rows = table.rows.map(row => {
          const obj = {};
          table.columns.forEach((col, i) => { obj[col] = row[i]; });
          return obj;
        });
        appendJsonSheet(wb, (table.title || 'Data').slice(0, 31), rows);
      }
    }
  }

  // Sheet 5: QA Scorecard
  if (report.qa_dimension_scores) {
    appendJsonSheet(wb, 'QA Scorecard', Object.entries(report.qa_dimension_scores).map(([dim, score]) => ({
      Dimension: dim,
      Score: score,
      Weight: QA_DIMENSION_WEIGHTS[dim] || 0,
      'Weighted Score': ((score || 0) * (QA_DIMENSION_WEIGHTS[dim] || 0)).toFixed(2),
    })));
  }

  // 記錄 export
  await supabase
    .from('analysis_reports')
    .update({ exported_at: new Date().toISOString(), export_format: 'xlsx' })
    .eq('id', reportId);

  return wb;
}

// ── 從報告建立模板 ──
export async function createTemplateFromReport(reportId, { name, cronExpression = null } = {}) {
  const report = await fetchReportDetail(reportId);

  const { data, error } = await supabase
    .from('report_templates')
    .insert({
      user_id: report.user_id,
      name: name || `Template from: ${report.title}`,
      query_template: report.user_query,
      answer_contract_override: report.answer_contract,
      cron_expression: cronExpression,
      schedule_enabled: Boolean(cronExpression),
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}
```

### 4.3 `reportSchedulerService.js` — 排程執行

```javascript
// src/services/reportSchedulerService.js
//
// 職責：定期執行報告模板

import { supabase } from '../lib/supabaseClient.js';
import { dispatchAnalysisTask } from './taskDispatcherService.js';

// ── 檢查並執行到期的排程（由 Supabase cron 或 setInterval 觸發）──
export async function tickScheduler() {
  const now = new Date().toISOString();

  const { data: dueTemplates } = await supabase
    .from('report_templates')
    .select('*')
    .eq('schedule_enabled', true)
    .lte('next_run_at', now);

  for (const template of dueTemplates || []) {
    try {
      // 替換模板佔位符
      const query = resolveTemplateQuery(template.query_template, template.default_params);

      // 派發任務
      await dispatchAnalysisTask({
        userId: template.user_id,
        userQuery: query,
        answerContract: template.answer_contract_override,
        source: 'schedule',
        templateId: template.id,
      });

      // 更新下次執行時間
      const nextRun = getNextCronTime(template.cron_expression);
      await supabase
        .from('report_templates')
        .update({
          last_run_at: now,
          next_run_at: nextRun.toISOString(),
        })
        .eq('id', template.id);

    } catch (err) {
      console.error(`[Scheduler] Template ${template.id} failed:`, err);
    }
  }
}

// ── 模板佔位符解析 ──
function resolveTemplateQuery(template, params = {}) {
  let query = template;

  // 內建時間變數
  const now = new Date();
  const builtins = {
    current_month: now.toISOString().slice(0, 7),
    previous_month: new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 7),
    current_year: String(now.getFullYear()),
    previous_year: String(now.getFullYear() - 1),
    last_week_start: getLastWeekStart().toISOString().slice(0, 10),
    last_week_end: getLastWeekEnd().toISOString().slice(0, 10),
    today: now.toISOString().slice(0, 10),
  };

  const allParams = { ...builtins, ...params };

  for (const [key, value] of Object.entries(allParams)) {
    query = query.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }

  return query;
}

// ── Cron 解析（輕量版，建議用 cron-parser 套件）──
function getNextCronTime(cronExpr) {
  // 簡化版：支援常見模式
  // 實際建議 npm install cron-parser
  // import { parseExpression } from 'cron-parser';
  // return parseExpression(cronExpr).next().toDate();

  // 臨時 fallback：24 小時後
  return new Date(Date.now() + 24 * 60 * 60 * 1000);
}
```

---

## 五、前端元件設計

### 5.1 Chat 層：TaskDispatchCard

```jsx
// src/components/chat/cards/TaskDispatchCard.jsx
//
// 在 chat 中顯示的輕量任務卡片（取代目前的 streaming 等待）

import React, { useState, useEffect } from 'react';

export default function TaskDispatchCard({ taskId, userQuery, estimatedDuration, onCancel, onViewReport }) {
  const [progress, setProgress] = useState({ pct: 0, message: '排入佇列中...' });
  const [status, setStatus] = useState('queued'); // queued | running | completed | failed
  const [reportId, setReportId] = useState(null);

  // 輪詢進度
  useEffect(() => {
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return;

    const interval = setInterval(async () => {
      const task = await fetchTaskStatus(taskId);
      setProgress({ pct: task.progress_pct, message: task.progress_message });
      setStatus(task.status);
      if (task.report_id) setReportId(task.report_id);
      if (task.status === 'completed' || task.status === 'failed') {
        clearInterval(interval);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [taskId, status]);

  return (
    <div className="task-dispatch-card">
      {/* 標題列 */}
      <div className="task-header">
        <span className="task-icon">
          {status === 'queued' && '⏳'}
          {status === 'running' && '🔄'}
          {status === 'completed' && '✅'}
          {status === 'failed' && '❌'}
        </span>
        <span className="task-query">{userQuery}</span>
        <span className="task-id">#{taskId.slice(0, 8)}</span>
      </div>

      {/* 進度條 */}
      {(status === 'queued' || status === 'running') && (
        <div className="task-progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress.pct}%` }} />
          </div>
          <span className="progress-text">{progress.message}</span>
          <span className="progress-eta">
            預計 {Math.ceil((estimatedDuration || 20000) * (1 - progress.pct / 100) / 1000)}s
          </span>
        </div>
      )}

      {/* 完成後的動作 */}
      {status === 'completed' && reportId && (
        <div className="task-actions">
          <button onClick={() => onViewReport(reportId)} className="btn-primary">
            查看報告
          </button>
          <button onClick={() => exportReport(reportId)} className="btn-secondary">
            匯出 Excel
          </button>
        </div>
      )}

      {/* 執行中可取消 */}
      {(status === 'queued' || status === 'running') && (
        <button onClick={() => onCancel(taskId)} className="btn-cancel">取消</button>
      )}

      {/* 失敗可重試 */}
      {status === 'failed' && (
        <div className="task-error">
          <span>{progress.message}</span>
          <button onClick={() => retryTask(taskId)} className="btn-retry">重試</button>
        </div>
      )}
    </div>
  );
}
```

### 5.2 Report Viewer：CanvasPanel 新增 Tab

```jsx
// src/components/chat/ReportViewerTab.jsx
//
// CanvasPanel 的新 tab — 報告列表 + 詳情預覽

import React, { useState, useEffect, useCallback } from 'react';
import { fetchReports, updateReport, exportReportToExcel } from '../../services/reportService.js';

export default function ReportViewerTab({ userId, conversationId }) {
  const [reports, setReports] = useState([]);
  const [selectedReport, setSelectedReport] = useState(null);
  const [filter, setFilter] = useState('all'); // all | ready | draft | failed | pinned
  const [view, setView] = useState('list'); // list | detail

  // 載入報告列表
  const loadReports = useCallback(async () => {
    const params = {};
    if (filter === 'pinned') params.pinned = true;
    else if (filter !== 'all') params.status = filter;
    if (conversationId) params.conversationId = conversationId;

    const { reports: data } = await fetchReports(userId, params);
    setReports(data);
  }, [userId, conversationId, filter]);

  useEffect(() => { loadReports(); }, [loadReports]);

  // 每 5 秒自動刷新（背景任務可能完成）
  useEffect(() => {
    const interval = setInterval(loadReports, 5000);
    return () => clearInterval(interval);
  }, [loadReports]);

  return (
    <div className="report-viewer">
      {view === 'list' ? (
        <ReportListView
          reports={reports}
          filter={filter}
          onFilterChange={setFilter}
          onSelect={(r) => { setSelectedReport(r); setView('detail'); }}
          onPin={(id) => updateReport(id, { pinned: true }).then(loadReports)}
          onArchive={(id) => updateReport(id, { archived: true }).then(loadReports)}
        />
      ) : (
        <ReportDetailView
          report={selectedReport}
          onBack={() => setView('list')}
          onExport={(id) => exportReportToExcel(id)}
          onRate={(id, rating) => updateReport(id, { user_rating: rating })}
          onCreateTemplate={(id) => { /* 開啟模板建立 dialog */ }}
          onDeepDive={(finding) => { /* 把 finding 丟回 chat 做深入分析 */ }}
        />
      )}
    </div>
  );
}

// ── 報告列表 ──
function ReportListView({ reports, filter, onFilterChange, onSelect, onPin, onArchive }) {
  return (
    <div className="report-list">
      {/* 篩選器 */}
      <div className="report-filters">
        {['all', 'ready', 'draft', 'failed', 'pinned'].map(f => (
          <button
            key={f}
            className={`filter-btn ${filter === f ? 'active' : ''}`}
            onClick={() => onFilterChange(f)}
          >
            {f === 'all' && '全部'}
            {f === 'ready' && '✅ 可匯出'}
            {f === 'draft' && '📝 草稿'}
            {f === 'failed' && '❌ 失敗'}
            {f === 'pinned' && '📌 收藏'}
          </button>
        ))}
      </div>

      {/* 報告卡片 */}
      {reports.map(report => (
        <div key={report.id} className="report-card" onClick={() => onSelect(report)}>
          <div className="report-card-header">
            <QaStatusBadge status={report.qa_status} score={report.qa_score} />
            <span className="report-title">{report.title}</span>
            {report.pinned && <span className="pin-icon">📌</span>}
          </div>
          <div className="report-card-meta">
            <span className="report-query">{report.user_query}</span>
            <span className="report-time">{formatRelativeTime(report.completed_at)}</span>
            <span className="report-duration">{formatDuration(report.execution_time_ms)}</span>
          </div>
          <div className="report-card-actions">
            <button onClick={(e) => { e.stopPropagation(); onPin(report.id); }}>📌</button>
            <button onClick={(e) => { e.stopPropagation(); onArchive(report.id); }}>📦</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 報告詳情 ──
function ReportDetailView({ report, onBack, onExport, onRate, onCreateTemplate, onDeepDive }) {
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    fetchReportDetail(report.id).then(setDetail);
  }, [report.id]);

  if (!detail) return <div className="loading">載入中...</div>;

  const brief = detail.brief_json;

  return (
    <div className="report-detail">
      {/* 頂部工具列 */}
      <div className="report-toolbar">
        <button onClick={onBack}>← 返回列表</button>
        <div className="toolbar-actions">
          <button onClick={() => onExport(report.id)} className="btn-export">
            📊 匯出 Excel
          </button>
          <button onClick={() => onCreateTemplate(report.id)} className="btn-template">
            📋 存為模板
          </button>
          <StarRating value={detail.user_rating} onChange={(v) => onRate(report.id, v)} />
        </div>
      </div>

      {/* QA Score Bar */}
      <QaScoreBar score={detail.qa_score} dimensions={detail.qa_dimension_scores} />

      {/* Headline */}
      <h2 className="report-headline">{brief.headline}</h2>

      {/* Metric Pills */}
      {brief.metric_pills?.length > 0 && (
        <div className="metric-pills-row">
          {brief.metric_pills.map((pill, i) => (
            <MetricPill key={i} label={pill.label} value={pill.value} source={pill.source} />
          ))}
        </div>
      )}

      {/* Summary */}
      <div className="report-summary markdown-body">
        <ReactMarkdown>{brief.summary}</ReactMarkdown>
      </div>

      {/* Charts */}
      {brief.charts?.map((chart, i) => (
        <ChartRenderer key={i} chart={chart} />
      ))}

      {/* Tables */}
      {brief.tables?.map((table, i) => (
        <DataTable key={i} title={table.title} columns={table.columns} rows={table.rows} />
      ))}

      {/* Key Findings — 可點擊深入分析 */}
      <div className="report-findings">
        <h3>Key Findings</h3>
        {brief.key_findings?.map((finding, i) => (
          <div key={i} className="finding-item">
            <span>{finding}</span>
            <button
              className="btn-deep-dive"
              onClick={() => onDeepDive(finding)}
              title="針對這個發現深入分析"
            >
              🔍 深入
            </button>
          </div>
        ))}
      </div>

      {/* Implications + Next Steps */}
      <div className="report-implications">
        <h3>Implications</h3>
        <ul>{brief.implications?.map((imp, i) => <li key={i}>{imp}</li>)}</ul>
      </div>
      <div className="report-next-steps">
        <h3>Next Steps</h3>
        <ul>{brief.next_steps?.map((ns, i) => <li key={i}>{ns}</li>)}</ul>
      </div>

      {/* Caveats + Methodology */}
      <details className="report-caveats">
        <summary>Caveats & Methodology</summary>
        <ul>{brief.caveats?.map((c, i) => <li key={i}>{c}</li>)}</ul>
        <p>{brief.methodology_note}</p>
      </details>
    </div>
  );
}

// ── QA Score Badge ──
function QaStatusBadge({ status, score }) {
  const colors = {
    ready: '#22c55e',   // green
    draft: '#f59e0b',   // amber
    failed: '#ef4444',  // red
    pending: '#6b7280', // gray
  };
  return (
    <span className="qa-badge" style={{ backgroundColor: colors[status] }}>
      {score?.toFixed(1)} {status === 'ready' ? '✓' : status === 'draft' ? '△' : '✗'}
    </span>
  );
}
```

### 5.3 整合到 CanvasPanel

```jsx
// src/components/chat/CanvasPanel.jsx
// 在現有的 tab 列表中加入 "reports" tab

// 現有 tabs（約 line 23-31）：
// const TABS = ['logs', 'code', 'charts', 'data', 'topology', 'downloads', 'whatif'];

// 改為：
const TABS = ['reports', 'logs', 'code', 'charts', 'data', 'topology', 'downloads', 'whatif'];
//             ^^^^^^^^ 新增，放第一位

// 在 tab content render 區域加入：
{activeTab === 'reports' && (
  <ReportViewerTab
    userId={user.id}
    conversationId={currentConversationId}
  />
)}
```

### 5.4 Chat 層：修改 submit flow

```javascript
// src/views/DecisionSupportView/index.jsx
// 修改 handleSubmit / handleAnalysisQuery 流程

// === 現狀（約 line 2440-2580）===
// handleAnalysisQuery = async () => {
//   setIsStreaming(true);
//   const result = await runAgentLoop({...});  // ← 同步等待
//   // ... QA, repair, optimize
//   setIsStreaming(false);
// }

// === 改為 ===
// handleAnalysisQuery 變成 Task Dispatch

async function handleAnalysisQuery(query, answerContract) {
  // 1. 派發任務（不阻塞）
  const { taskId, estimatedDuration, queuePosition } = await dispatchAnalysisTask({
    userId: user.id,
    userQuery: query,
    conversationId: currentConversationId,
    answerContract,
    callbacks: {
      onProgress: (id, pct, msg) => {
        // 更新 TaskDispatchCard 的進度（透過 state 或 event bus）
        updateTaskProgress(id, pct, msg);
      },
      onToolResult: (id, toolCall) => {
        // Progressive rendering — 即時更新右側 Report Viewer
        handleProgressiveUpdate(id, toolCall);
      },
      onTaskComplete: (id, report) => {
        // 在 chat 中追加完成通知
        appendMessagesToCurrentConversation([{
          role: 'assistant',
          content: '',
          card_type: 'task_complete',
          card_data: { taskId: id, reportId: report.id, title: report.title, qaScore: report.qa_score },
          timestamp: new Date().toISOString(),
        }]);
        // 彈出 toast
        addNotification(`報告「${report.title}」已完成 (QA: ${report.qa_score}/10)`, 'success');
        // 自動切到 Report Viewer tab
        setCanvasActiveTab('reports');
      },
      onTaskFailed: (id, error) => {
        appendMessagesToCurrentConversation([{
          role: 'assistant',
          content: '',
          card_type: 'task_failed',
          card_data: { taskId: id, error: error.message },
          timestamp: new Date().toISOString(),
        }]);
        addNotification(`分析任務失敗: ${error.message}`, 'error');
      },
    },
  });

  // 2. 在 chat 中立即顯示 TaskDispatchCard（不等待結果）
  appendMessagesToCurrentConversation([{
    role: 'assistant',
    content: '',
    card_type: 'task_dispatch',
    card_data: { taskId, estimatedDuration, queuePosition, userQuery: query },
    timestamp: new Date().toISOString(),
  }]);

  // 3. chat 立即可以接受下一個輸入（不 block）
  // setIsStreaming(false) 不需要了，因為沒有 streaming
}
```

### 5.5 MessageCardRenderer 新增卡片類型

```jsx
// src/views/DecisionSupportView/MessageCardRenderer.jsx
// 在卡片 dispatch 邏輯中加入新類型

// 現有 dispatch（約 line 50-100）：
// switch (message.card_type) {
//   case 'forecast': return <ForecastCard .../>;
//   case 'plan_approval': return <PlanApprovalCard .../>;
//   ...
// }

// 新增：
case 'task_dispatch':
  return <TaskDispatchCard {...message.card_data} onViewReport={handleViewReport} onCancel={handleCancelTask} />;

case 'task_complete':
  return <TaskCompleteCard {...message.card_data} onViewReport={handleViewReport} onExport={handleExportReport} />;

case 'task_failed':
  return <TaskFailedCard {...message.card_data} onRetry={handleRetryTask} />;
```

---

## 六、Chat ↔ Report 雙向連結

### 6.1 從 Chat 引用報告

```
用戶：「那份 2016 vs 2017 的報告裡，第三個發現，幫我深入分析」

系統需要：
1. 辨識用戶在引用哪份報告 → 用 conversationId + 最近的 report
2. 取得第三個 key_finding → brief_json.key_findings[2]
3. 以此為新問題，派發新任務
```

```javascript
// src/services/chatContextService.js（新增）

export async function resolveReportReference(userId, conversationId, userMessage) {
  // 嘗試從訊息中辨識報告引用
  const reportRef = parseReportReference(userMessage);
  // "那份報告" / "上一份分析" / "#T-xxxx" / "2016 vs 2017 的報告"

  if (!reportRef) return null;

  let report;
  if (reportRef.taskId) {
    // 直接引用 task ID
    report = await fetchReportByTaskId(reportRef.taskId);
  } else {
    // 模糊匹配：最近的、或關鍵字匹配
    const { reports } = await fetchReports(userId, {
      conversationId,
      limit: 5,
    });
    report = findBestMatch(reports, reportRef.keywords);
  }

  if (!report) return null;

  // 如果引用了特定 finding
  if (reportRef.findingIndex != null) {
    const finding = report.brief_json?.key_findings?.[reportRef.findingIndex];
    return {
      report,
      referencedContent: finding,
      contextForAgent: `User is referring to a previous analysis: "${report.title}". ` +
        `Specifically, finding #${reportRef.findingIndex + 1}: "${finding}". ` +
        `The user wants to dive deeper into this finding.`,
    };
  }

  return {
    report,
    referencedContent: report.brief_json?.summary,
    contextForAgent: `User is referring to a previous analysis: "${report.title}". ` +
      `Key metrics: ${JSON.stringify(report.brief_json?.metric_pills)}. ` +
      `Summary: ${report.brief_json?.executive_summary}`,
  };
}
```

### 6.2 從 Report 發起 Chat

Report Viewer 中的「深入分析」按鈕：

```javascript
// ReportDetailView 中的 onDeepDive handler

function handleDeepDive(finding, report) {
  // 1. 建構新的 chat 訊息
  const deepDiveQuery = `針對以下發現做深入分析：「${finding}」\n` +
    `（來源報告：${report.title}）`;

  // 2. 注入報告 context 到 conversation history
  const reportContext = {
    role: 'system',
    content: `Reference report "${report.title}" (id: ${report.id}). ` +
      `Original query: "${report.user_query}". ` +
      `Key metrics: ${JSON.stringify(report.brief_json?.metric_pills)}. ` +
      `The user wants deeper analysis on: "${finding}"`,
  };

  // 3. 透過 event bus 或 callback 發送到 ChatComposer
  eventBus.emit('chat:inject', {
    query: deepDiveQuery,
    additionalContext: reportContext,
  });

  // 4. 自動切到 chat tab
  setActivePanel('chat');
}
```

---

## 七、排程任務 UI

### 7.1 Template Manager（在 Report Viewer 內）

```jsx
// src/components/chat/TemplateManagerPanel.jsx

function TemplateManagerPanel({ userId }) {
  const [templates, setTemplates] = useState([]);

  return (
    <div className="template-manager">
      <h3>報告模板 & 排程</h3>

      {templates.map(template => (
        <div key={template.id} className="template-card">
          <div className="template-header">
            <span className="template-name">{template.name}</span>
            <span className={`schedule-badge ${template.schedule_enabled ? 'active' : 'inactive'}`}>
              {template.schedule_enabled
                ? `🔄 ${describeCron(template.cron_expression)}`
                : '手動執行'
              }
            </span>
          </div>

          <div className="template-query">
            <code>{template.query_template}</code>
          </div>

          {template.default_params && Object.keys(template.default_params).length > 0 && (
            <div className="template-params">
              參數：{JSON.stringify(template.default_params)}
            </div>
          )}

          <div className="template-meta">
            {template.last_run_at && <span>上次執行：{formatRelativeTime(template.last_run_at)}</span>}
            {template.next_run_at && template.schedule_enabled && (
              <span>下次執行：{formatRelativeTime(template.next_run_at)}</span>
            )}
          </div>

          <div className="template-actions">
            <button onClick={() => runTemplateNow(template)}>▶️ 立即執行</button>
            <button onClick={() => toggleSchedule(template)}>
              {template.schedule_enabled ? '⏸ 暫停排程' : '▶ 啟用排程'}
            </button>
            <button onClick={() => editTemplate(template)}>✏️ 編輯</button>
            <button onClick={() => deleteTemplate(template)}>🗑️ 刪除</button>
          </div>
        </div>
      ))}

      <button className="btn-create-template" onClick={showCreateDialog}>
        + 建立新模板
      </button>
    </div>
  );
}
```

### 7.2 用自然語言建立排程

```
用戶（在 chat 中）：「每週一早上九點幫我跑上週的銷售彙總報告」

系統解析：
- query_template: "上週 ({{last_week_start}} ~ {{last_week_end}}) 的銷售彙總，
    包含總營收、訂單數、前 5 地區、前 5 類別"
- cron_expression: "0 9 * * 1"  (每週一 09:00)
- name: "週報 — 銷售彙總"
```

```javascript
// 在 intent parser 中加入排程偵測

const SCHEDULE_PATTERNS = [
  /每(天|日|週[一二三四五六日]?|月|季)/,
  /定期|排程|自動|schedule|recurring/i,
  /每(個)?(?:禮拜|星期)[一二三四五六日]/,
  /早上|下午|晚上|(\d{1,2})[點:：](\d{0,2})/,
];

function detectScheduleIntent(message) {
  const hasSchedule = SCHEDULE_PATTERNS.some(p => p.test(message));
  if (!hasSchedule) return null;

  // 用 LLM 解析自然語言排程
  return {
    isScheduleRequest: true,
    // LLM 會把 "每週一早上九點" 轉成 cron + query template
  };
}
```

---

## 八、實施階段規劃

### Phase 0：基礎準備（0.5 天）
```
□ 執行 SQL migration（analysis_reports + report_templates + analysis_task_queue）
□ npm install cron-parser（排程解析）
□ 確認 Supabase RLS policy 正確
```

### Phase 1：Report 持久化 + Viewer（3 天）
```
□ 建立 reportService.js（CRUD + export）
□ 建立 ReportViewerTab.jsx（列表 + 詳情）
□ 將 ReportViewerTab 加入 CanvasPanel 作為新 tab
□ 修改現有 analysis flow：完成後自動寫入 analysis_reports
□ 測試：手動分析完成 → 報告自動出現在 Report Viewer
```

### Phase 2：Task Queue + Background Execution（3 天）
```
□ 建立 taskDispatcherService.js（派發 + 佇列 + 背景執行）
□ 建立 TaskDispatchCard.jsx + TaskCompleteCard.jsx
□ 修改 handleAnalysisQuery → 改為 task dispatch 模式
□ 加入進度推送（polling 或 Supabase realtime subscription）
□ 加入 MessageCardRenderer 新卡片類型
□ 測試：用戶下指令 → 不阻塞 → 背景完成 → chat 通知 + report viewer 顯示
```

### Phase 3：Excel Export + 報告品質標籤（2 天）
```
□ 實作 exportReportToExcel（多 sheet 格式）
□ Report Viewer 加入 QA status badge（Ready/Draft/Failed）
□ Report Viewer 加入 Pin / Archive / Rate 功能
□ 一鍵 export 按鈕（Report Viewer + TaskCompleteCard）
□ 測試：好報告一鍵匯出 → 多 sheet Excel
```

### Phase 4：Chat ↔ Report 雙向連結（2 天）
```
□ 實作 resolveReportReference（chat 引用報告）
□ Report Viewer "深入分析" 按鈕 → 發回 chat
□ TaskCompleteCard "查看報告" → 自動切到 Report Viewer tab
□ 測試：chat 說 "那份報告的第二個發現" → 正確解析並深入分析
```

### Phase 5：排程 + 模板（2 天）
```
□ 建立 reportSchedulerService.js
□ 建立 TemplateManagerPanel.jsx
□ "存為模板" 功能（從報告 → 模板）
□ 自然語言排程偵測 + 建立
□ Supabase cron 或 setInterval 驅動 tickScheduler
□ 測試：建立模板 + 排程 → 自動執行 → 報告出現 + 通知
```

### Phase 6：Progressive Rendering（1.5 天）
```
□ onToolResult callback 中提取 quick metrics
□ Report Viewer 支援 skeleton → real 的過渡
□ 背景任務每個 SQL 完成時即時更新 metric pills
□ 測試：任務執行中 → Report Viewer 即時顯示進度數據
```

---

## 九、與其他方案的整合關係

```
DI-Pipeline-Round5-Fix-Guide.md     ← 止血（先做）
DI-Next-Level-Architecture-Guide.md ← 品質躍升（Evidence-First 等）
DI-Task-Mode-Implementation-Plan.md ← 工作流躍升（本文件）

依賴關係：
Round 5 止血 ──→ 品質穩定
                    │
                    ▼
              Evidence-First 架構 ──→ 報告品質可信賴
                                        │
                                        ▼
                                   Task Mode ──→ 背景執行有意義
                                                （因為用戶信任不需要盯著看）

可並行的部分：
- Task Mode Phase 1-2（Report Viewer + Task Queue）
  跟 Round 5 止血可以並行，因為只是加新元件，不改現有邏輯
- Evidence-First 架構跟 Task Mode Phase 3-6 串行
  （export 和排程需要報告品質穩定後才有意義）
```

---

## 十、最終願景：完整工作流

```
週一早上 9:00
  │
  ▼ [排程觸發]
  「週報模板」自動執行
  │
  ├── 背景：Evidence Agent 查詢上週數據
  ├── 背景：Evidence Registry 驗證 + 預計算
  ├── 背景：Synthesis Agent 生成報告
  └── 背景：QA → ready ✅
  │
  ▼ [9:00:22]
  用戶打開 app → toast "週報已生成" → 點擊查看
  │
  ▼ [Report Viewer]
  看到完整報告 + QA 8.7/10 ✅ Ready
  │
  ├── 點「匯出 Excel」→ 下載多 sheet workbook
  ├── 點「第 3 個發現：東南地區營收下降 15%」的「深入分析」按鈕
  │     │
  │     ▼ [自動發回 chat]
  │     新任務：「深入分析東南地區營收下降 15% 的原因」
  │     → 背景執行 → 新報告出現在 Report Viewer
  │
  └── 在 chat 中說：「把這份週報和東南地區分析一起寄給 team」
        → 未來功能：email integration
```
