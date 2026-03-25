// @product: ai-employee
//
// ★ ARCHIVED — This file has ZERO production imports. ★
// All reads are served by queries.js; all mutations by orchestrator.js.
// This stub is kept only for backward-compat re-exports; it may be deleted
// in a future cleanup.
//
// @deprecated — This file is a thin re-export shim.
// Use src/services/aiEmployee/queries.js for reads and
// src/services/aiEmployee/orchestrator.js for mutations.
// ─────────────────────────────────────────────────────────────────────────────

// ── Read functions (from queries) ────────────────────────────────────────────

export {
  getOrCreateWorker as getOrCreateAiden,
  getEmployee,
  getKpis,
  getTask,
  listTasks,
  listTasksByUser,
  listPendingReviews,
  listWorklogs,
  appendWorklog,
  createReview,
  listReviewsForTask,
  enrichRunsWithArtifacts,
} from '../aiEmployee/queries.js';

// ── Mutation functions (from orchestrator / repos) ───────────────────────────
// These are re-exported from the persistence layer to preserve the old API
// surface. New code should use orchestrator.js for task lifecycle instead.

export {
  updateEmployeeStatus,
} from '../aiEmployee/persistence/employeeRepo.js';

export {
  createTask,
  updateTaskStatus,
} from '../aiEmployee/persistence/taskRepo.js';

// Legacy loop_state function — loop_state is no longer used in the new stack.
// Steps are stored as separate rows in ai_employee_runs via stepRepo.
export function updateTaskLoopState() { throw new Error('Deprecated: updateTaskLoopState — loop_state replaced by step rows via orchestrator'); }

// Legacy run functions — no longer available in the new stack.
// Runs have been replaced by step rows in stepRepo.js.
// These stubs exist only for backward compatibility if any code still references them.
export function createRun() { throw new Error('Deprecated: createRun — use stepRepo.createSteps() via orchestrator'); }
export function updateRun() { throw new Error('Deprecated: updateRun — use stepRepo.updateStep() via orchestrator'); }
export function getRun() { throw new Error('Deprecated: getRun — use stepRepo.getSteps() via orchestrator'); }
export function listRunsForTask() { throw new Error('Deprecated: listRunsForTask — use stepRepo.getSteps() via orchestrator'); }

// ── Default export (preserves backward compat for `import svc from ...`) ────

export default {
  getOrCreateAiden: (...args) => import('../aiEmployee/queries.js').then(m => m.getOrCreateWorker(...args)),
  getEmployee: (...args) => import('../aiEmployee/queries.js').then(m => m.getEmployee(...args)),
  getKpis: (...args) => import('../aiEmployee/queries.js').then(m => m.getKpis(...args)),
  getTask: (...args) => import('../aiEmployee/queries.js').then(m => m.getTask(...args)),
  listTasks: (...args) => import('../aiEmployee/queries.js').then(m => m.listTasks(...args)),
  listTasksByUser: (...args) => import('../aiEmployee/queries.js').then(m => m.listTasksByUser(...args)),
  listPendingReviews: (...args) => import('../aiEmployee/queries.js').then(m => m.listPendingReviews(...args)),
  listWorklogs: (...args) => import('../aiEmployee/queries.js').then(m => m.listWorklogs(...args)),
  appendWorklog: (...args) => import('../aiEmployee/queries.js').then(m => m.appendWorklog(...args)),
  createReview: (...args) => import('../aiEmployee/queries.js').then(m => m.createReview(...args)),
  listReviewsForTask: (...args) => import('../aiEmployee/queries.js').then(m => m.listReviewsForTask(...args)),
  updateEmployeeStatus: (...args) => import('../aiEmployee/persistence/employeeRepo.js').then(m => m.updateEmployeeStatus(...args)),
  createTask: (...args) => import('../aiEmployee/persistence/taskRepo.js').then(m => m.createTask(...args)),
  updateTaskStatus: (...args) => import('../aiEmployee/persistence/taskRepo.js').then(m => m.updateTaskStatus(...args)),
  updateTaskLoopState,
  createRun,
  updateRun,
  getRun,
  listRunsForTask,
};
