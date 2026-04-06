/**
 * WorkspacePage — Agent-Driven Workspace
 *
 * Upload data → Agent auto-analyzes → Chat for Q&A
 * No manual tool selection, no conversation history — just results.
 */

import React, { Suspense, lazy } from 'react';

const AgentWorkspaceView = lazy(() => import('../views/AgentWorkspaceView'));

export default function WorkspacePage() {
  return (
    <Suspense
      fallback={
        <div className="h-full flex items-center justify-center">
          <div className="w-8 h-8 rounded-lg bg-[var(--brand-600)] animate-pulse" />
        </div>
      }
    >
      <AgentWorkspaceView />
    </Suspense>
  );
}
