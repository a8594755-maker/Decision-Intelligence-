/**
 * AgentLabPage — Test page for General Agent Loop.
 * Upload Excel + type a question → Agent selects tools → executes → synthesizes.
 * Route: /agent-lab
 */
import { lazy, Suspense } from 'react';

const AgentLabView = lazy(() => import('../views/AgentLabView'));

export default function AgentLabPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full text-[var(--text-secondary)]">Loading...</div>}>
      <AgentLabView />
    </Suspense>
  );
}
