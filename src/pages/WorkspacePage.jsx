/**
 * WorkspacePage — Unified Digital Worker Workspace (Canvas Architecture)
 *
 * Layout: AppShell sidebar (nav) | DSV with conversation sidebar (chat) | DynamicCanvas (widgets)
 *
 * Wraps DecisionSupportView in CanvasProvider + UnifiedWorkspaceLayout so that
 * artifact events from the agent loop automatically open widgets on the right pane.
 *
 * Deep linking: /workspace?widget=risk&context=plant_001&tab=demand
 */

import React, { Suspense, lazy, useEffect, useRef } from 'react';
import { envConfig } from '../config/environments';
import FeatureGatePanel from '../components/dev/FeatureGatePanel';
import { useSearchParams } from 'react-router-dom';
import { CanvasProvider, useCanvas } from '../contexts/CanvasContext';
import UnifiedWorkspaceLayout from '../components/canvas/UnifiedWorkspaceLayout';
import useCanvasEventBridge from '../hooks/useCanvasEventBridge';
import { useAuth } from '../contexts/AuthContext';
import { resolveDeepLink, resolveWidget } from '../components/canvas/WidgetRegistry';

const DecisionSupportView = lazy(() => import('../views/DecisionSupportView/index.jsx'));

function WorkspaceInner() {
  const { user, addNotification } = useAuth();
  const { openWidget, activeWidget } = useCanvas();
  const [searchParams, setSearchParams] = useSearchParams();
  const initializedRef = useRef(false);

  // Wire eventBus → canvas (artifact:created → auto-open widget)
  useCanvasEventBridge();

  // URL → Canvas: parse deep link on mount
  useEffect(() => {
    if (initializedRef.current) return;
    const widgetParam = searchParams.get('widget');
    if (!widgetParam) return;

    const artifactType = resolveDeepLink(widgetParam);
    if (!artifactType) return;

    const entry = resolveWidget(artifactType);
    if (!entry) return;

    initializedRef.current = true;
    const context = searchParams.get('context');
    const tab = searchParams.get('tab');
    openWidget(artifactType, { contextId: context, initialTab: tab, mode: 'live' }, {
      title: entry.title,
      size: entry.defaultSize,
    });
  }, [searchParams, openWidget]);

  // Canvas → URL: sync active widget back to URL params
  useEffect(() => {
    if (!activeWidget) return;
    const { artifactType } = activeWidget;
    // Only update URL if it differs from current param
    const currentParam = searchParams.get('widget');
    const resolved = resolveDeepLink(currentParam);
    if (resolved !== artifactType) {
      const params = { widget: artifactType };
      if (activeWidget.data?.contextId) params.context = activeWidget.data.contextId;
      if (activeWidget.data?.initialTab) params.tab = activeWidget.data.initialTab;
      setSearchParams(params, { replace: true });
    }
  }, [activeWidget, searchParams, setSearchParams]);

  return (
    <UnifiedWorkspaceLayout>
      <Suspense
        fallback={
          <div className="h-full flex items-center justify-center">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 animate-pulse" />
          </div>
        }
      >
        <DecisionSupportView
          user={user}
          addNotification={addNotification}
          mode="ai_employee"
        />
      </Suspense>
    </UnifiedWorkspaceLayout>
  );
}

export default function WorkspacePage() {
  return (
    <CanvasProvider>
      <WorkspaceInner />
      {envConfig.enableDevTools && <FeatureGatePanel />}
    </CanvasProvider>
  );
}
