/**
 * useCanvasEventBridge — Listens to eventBus for artifact events and
 * automatically opens the corresponding widget on the Canvas.
 *
 * Drop this hook into the workspace layout to wire up the
 * Tool-to-Widget Protocol (backend emits artifact → canvas renders widget).
 *
 * Also maintains a recentArtifacts list for the ContextPanel history.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { eventBus, EVENT_NAMES } from '../services/governance/eventBus.js';
import { useCanvas } from '../contexts/CanvasContext.jsx';
import { hasWidget, resolveWidget } from '../components/canvas/WidgetRegistry.js';

// Max recent artifacts to track
const MAX_RECENT = 30;

/**
 * @returns {{ recentArtifacts: Array }}
 */
export default function useCanvasEventBridge() {
  const { openWidget } = useCanvas();
  const [recentArtifacts, setRecentArtifacts] = useState([]);
  const openWidgetRef = useRef(openWidget);

  useEffect(() => {
    openWidgetRef.current = openWidget;
  }, [openWidget]);

  const handleArtifactCreated = useCallback((payload) => {
    if (!payload) return;

    const artifactType = payload.artifact_type || payload.type;
    const data = payload.data || payload.payload || payload;
    const taskId = payload.task_id || payload.sourceTaskId;

    if (!artifactType) return;

    // Add to recent artifacts history
    const entry = resolveWidget(artifactType);
    const recentItem = {
      type: artifactType,
      data,
      title: entry?.title || artifactType.replace(/_/g, ' '),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      timestamp: Date.now(),
    };
    setRecentArtifacts(prev => [recentItem, ...prev].slice(0, MAX_RECENT));

    // Auto-open widget on canvas if registered
    if (hasWidget(artifactType)) {
      openWidgetRef.current(artifactType, data, {
        title: entry?.title,
        size: entry?.defaultSize,
        sourceTaskId: taskId,
      });
    }
  }, []);

  useEffect(() => {
    // Listen for artifact creation events
    const unsub1 = eventBus.on(EVENT_NAMES.ARTIFACT_CREATED, handleArtifactCreated);

    // Also listen for agent step completion (tools produce artifacts)
    const unsub2 = eventBus.on(EVENT_NAMES.AGENT_STEP_COMPLETED, (payload) => {
      if (payload?.artifacts) {
        // Agent step can produce multiple artifacts
        payload.artifacts.forEach(art => handleArtifactCreated({
          artifact_type: art.type || art.artifact_type,
          data: art.data || art,
          task_id: payload.task_id,
        }));
      } else if (payload?.artifact_type) {
        handleArtifactCreated(payload);
      }
    });

    return () => {
      unsub1();
      unsub2();
    };
  }, [handleArtifactCreated]);

  return { recentArtifacts };
}
