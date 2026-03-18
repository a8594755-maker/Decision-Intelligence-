/**
 * DynamicCanvas — The right pane of the Trinity Layout.
 *
 * Reads `activeWidget` from CanvasContext and resolves the component
 * through WidgetRegistry. Renders a chrome shell (title bar, tabs, back)
 * around the resolved widget.
 */

import React, { Suspense } from 'react';
import {
  X, ChevronLeft, Pin, PinOff, Maximize2, Minimize2,
} from 'lucide-react';
import { useCanvas } from '../../contexts/CanvasContext';
import { resolveWidget } from './WidgetRegistry';
import { useAuth } from '../../contexts/AuthContext';
import { useApp } from '../../contexts/AppContext';

function CanvasEmpty() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3" style={{ color: 'var(--text-muted)' }}>
      <div className="w-12 h-12 rounded-xl bg-indigo-100 flex items-center justify-center">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
        </svg>
      </div>
      <p className="text-sm font-medium">Canvas</p>
      <p className="text-xs max-w-48 text-center">
        Run a tool or ask the AI to generate artifacts — they'll appear here automatically.
      </p>
    </div>
  );
}

function WidgetLoadingFallback() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="w-6 h-6 rounded-md bg-indigo-600 animate-pulse" />
    </div>
  );
}

export default function DynamicCanvas() {
  const { activeWidget, pinnedTabs, canGoBack, goBack, closeCanvas, switchToTab, unpinTab } = useCanvas();
  const { user } = useAuth();
  const { globalDataSource } = useApp();

  const entry = activeWidget ? resolveWidget(activeWidget.artifactType) : null;
  const WidgetComponent = entry?.component;
  const title = activeWidget?.title || entry?.title || 'Canvas';
  // Determine widget mode: 'live' if explicitly set in data, otherwise 'artifact'
  const widgetMode = activeWidget?.data?.mode || 'artifact';

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--surface-base)' }}>
      {/* Pinned Tabs Bar */}
      {pinnedTabs.length > 0 && (
        <div className="flex items-center gap-1 px-2 py-1 border-b overflow-x-auto" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-raised)' }}>
          {pinnedTabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => switchToTab(tab.id)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs whitespace-nowrap transition-colors ${
                activeWidget?.artifactType === tab.artifactType ? 'bg-indigo-100 text-indigo-700' : 'hover:bg-gray-100'
              }`}
            >
              <span>{tab.title}</span>
              <X
                size={10}
                className="opacity-50 hover:opacity-100"
                onClick={e => { e.stopPropagation(); unpinTab(tab.id); }}
              />
            </button>
          ))}
        </div>
      )}

      {/* Title Bar */}
      {activeWidget && (
        <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'var(--border-default)' }}>
          <div className="flex items-center gap-2">
            {canGoBack && (
              <button onClick={goBack} className="p-1 rounded hover:bg-gray-100" title="Go back">
                <ChevronLeft size={16} style={{ color: 'var(--text-muted)' }} />
              </button>
            )}
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
            {activeWidget.sourceTaskId && (
              <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ backgroundColor: 'var(--surface-raised)', color: 'var(--text-muted)' }}>
                Task #{activeWidget.sourceTaskId}
              </span>
            )}
          </div>
          <button onClick={closeCanvas} className="p-1 rounded hover:bg-gray-100" title="Close canvas">
            <X size={16} style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>
      )}

      {/* Widget Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {WidgetComponent ? (
          <Suspense fallback={<WidgetLoadingFallback />}>
            <WidgetComponent
              data={activeWidget.data}
              mode={widgetMode}
              user={user}
              globalDataSource={globalDataSource}
              initialTab={activeWidget.data?.initialTab}
            />
          </Suspense>
        ) : (
          <CanvasEmpty />
        )}
      </div>
    </div>
  );
}
