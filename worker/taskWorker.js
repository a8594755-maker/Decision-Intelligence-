/**
 * taskWorker.js — Background Node.js worker for server-side task execution.
 *
 * Polls Supabase for unclaimed tasks, claims them, and runs the existing
 * orchestrator tick loop. This allows tasks to continue executing even
 * when the browser tab is closed.
 *
 * Run via: npx vite-node worker/taskWorker.js
 * (vite-node handles import.meta.env from .env files, same as Vitest)
 */

import { randomUUID } from 'node:crypto';
import { __setWorkerProcess, _runTickLoop } from '../src/services/aiEmployee/orchestrator.js';
import * as taskRepo from '../src/services/aiEmployee/persistence/taskRepo.js';
import { startHealthServer, setReady } from './healthCheck.js';

// ── Config ────────────────────────────────────────────────────────────────────

const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = 2_000;   // Poll every 2 seconds
const MAX_CONCURRENT = 3;         // Max tasks executing simultaneously

// ── State ─────────────────────────────────────────────────────────────────────

const activeTasks = new Set();     // taskIds currently being executed
let shuttingDown = false;

// ── Init ──────────────────────────────────────────────────────────────────────

// Tell the orchestrator we're running as a worker (enables heartbeat, etc.)
__setWorkerProcess(true);

console.log(`[Worker] Starting task worker: ${WORKER_ID}`);
console.log(`[Worker] Poll interval: ${POLL_INTERVAL_MS}ms, Max concurrent: ${MAX_CONCURRENT}`);

// ── Poll Loop ─────────────────────────────────────────────────────────────────

async function pollAndClaim() {
  if (shuttingDown) return;
  if (activeTasks.size >= MAX_CONCURRENT) return;

  try {
    const unclaimed = await taskRepo.findUnclaimedTasks({ limit: MAX_CONCURRENT - activeTasks.size });
    if (unclaimed.length === 0) return;

    for (const task of unclaimed) {
      if (activeTasks.size >= MAX_CONCURRENT) break;
      if (activeTasks.has(task.id)) continue;

      // Try to claim the task (CAS — may fail if another worker claims it first)
      const claimed = await taskRepo.claimTask(task.id, WORKER_ID, task.version);
      if (!claimed) {
        console.log(`[Worker] Failed to claim task ${task.id} (another worker got it)`);
        continue;
      }

      console.log(`[Worker] Claimed task ${task.id} (status=${claimed.status}, title="${claimed.title || ''}")`);
      activeTasks.add(task.id);

      // Execute in background (don't await — allows concurrent execution)
      executeTask(task.id).catch((err) => {
        console.error(`[Worker] Unhandled error executing task ${task.id}:`, err);
      });
    }
  } catch (err) {
    console.error('[Worker] Poll error:', err.message);
  }
}

async function executeTask(taskId) {
  try {
    console.log(`[Worker] Executing task ${taskId}...`);
    await _runTickLoop(taskId);
    console.log(`[Worker] Task ${taskId} completed.`);
  } catch (err) {
    console.error(`[Worker] Task ${taskId} failed:`, err.message);
  } finally {
    // Release the claim
    try {
      await taskRepo.releaseTask(taskId);
    } catch (e) {
      console.warn(`[Worker] Failed to release task ${taskId}:`, e.message);
    }
    activeTasks.delete(taskId);
  }
}

// ── Main Loop ─────────────────────────────────────────────────────────────────

async function main() {
  // Start health check server
  startHealthServer(Number(process.env.WORKER_HEALTH_PORT) || 9100);
  setReady(true);

  console.log(`[Worker] Entering poll loop...`);

  while (!shuttingDown) {
    await pollAndClaim();
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.log(`[Worker] Shutting down. Waiting for ${activeTasks.size} active task(s) to finish...`);
  // Wait for active tasks to complete (with a timeout)
  const deadline = Date.now() + 30_000;
  while (activeTasks.size > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1_000));
  }
  if (activeTasks.size > 0) {
    console.warn(`[Worker] Forced shutdown with ${activeTasks.size} task(s) still active.`);
  }
  console.log(`[Worker] Bye.`);
  process.exit(0);
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

function onShutdown(signal) {
  console.log(`[Worker] Received ${signal}, initiating graceful shutdown...`);
  shuttingDown = true;
  setReady(false);
}

process.on('SIGINT', () => onShutdown('SIGINT'));
process.on('SIGTERM', () => onShutdown('SIGTERM'));

// ── Start ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('[Worker] Fatal error:', err);
  process.exit(1);
});
