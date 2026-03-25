// insightsHubExecutor.js
// ─────────────────────────────────────────────────────────────────────────────
// Executes analysis queries from the Insights Hub using the chat agent loop.
// When the user approves a suggestion, this runs the same agent loop as chat
// and saves the result as a snapshot for the dashboard.
// ─────────────────────────────────────────────────────────────────────────────

import { runAgentLoop } from '../agent-core/chatAgentLoop.js';
import { saveSnapshot } from '../data-prep/analysisSnapshotService.js';

/**
 * Execute an analysis query from Insights Hub.
 * Uses the same agent loop as the chat — queries data, generates charts, etc.
 *
 * @param {string} query - The analysis query to run
 * @param {string} userId - User ID
 * @param {{ onProgress?: (msg: string) => void, signal?: AbortSignal }} options
 * @returns {Promise<{ success: boolean, snapshotId?: string, error?: string }>}
 */
export async function executeInsightQuery(query, userId, { onProgress, signal } = {}) {
  if (!query || !userId) {
    return { success: false, error: 'Missing query or userId' };
  }

  try {
    onProgress?.('Running analysis...');

    const result = await runAgentLoop({
      message: query,
      toolContext: { userId },
      mode: 'analysis',
      callbacks: {
        onToolCall: ({ name }) => onProgress?.(`Using ${name}...`),
      },
      signal,
    });

    onProgress?.('Saving results...');

    // Extract brief from the agent result
    const brief = result?.presentation?.brief;
    if (!brief?.headline) {
      // Try to construct a minimal brief from the result
      const text = result?.presentation?.text || result?.text || '';
      if (!text) {
        return { success: false, error: 'Agent produced no output' };
      }
      // Save with a constructed brief
      const snapshotId = await saveSnapshot({
        userId,
        conversationId: `insights-${Date.now()}`,
        messageIndex: 0,
        brief: {
          headline: query.slice(0, 100),
          summary: text.slice(0, 500),
          metric_pills: result?.presentation?.brief?.metric_pills || [],
          charts: result?.presentation?.brief?.charts || [],
          tables: result?.presentation?.brief?.tables || [],
          key_findings: result?.presentation?.brief?.key_findings || [],
        },
        query,
      });
      return { success: true, snapshotId };
    }

    // Save the full brief as a snapshot
    const snapshotId = await saveSnapshot({
      userId,
      conversationId: `insights-${Date.now()}`,
      messageIndex: 0,
      brief,
      query,
    });

    return { success: true, snapshotId };
  } catch (err) {
    console.error('[insightsExecutor] Query failed:', err);
    return { success: false, error: err.message || 'Analysis failed' };
  }
}
