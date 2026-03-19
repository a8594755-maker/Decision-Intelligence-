/**
 * CanvasContext — manages the Dynamic Canvas (right pane) state.
 *
 * Any component can call `openWidget(artifactType, data, opts)` to push a new
 * widget onto the canvas.  The DynamicCanvas renderer reads `activeWidget` and
 * resolves it through the WidgetRegistry.
 *
 * Supports:
 *  - Single active widget (replaces current)
 *  - Widget history stack (back navigation)
 *  - Pinned tabs (persist across widget switches)
 */

import { createContext, useContext, useState, useCallback, useRef } from 'react';

const CanvasContext = createContext(null);

// Max history depth to prevent unbounded memory growth
const MAX_HISTORY = 50;

/**
 * @typedef {object} CanvasWidget
 * @property {string}  artifactType  - key into WIDGET_REGISTRY
 * @property {*}       data          - artifact payload passed as props
 * @property {string}  [title]       - optional override for widget title
 * @property {string}  [size]        - 'full' | 'half' | 'popup'
 * @property {number}  timestamp     - Date.now() when opened
 * @property {string}  [sourceTaskId] - originating task id (for traceability)
 */

/**
 * @param {object} props
 * @param {React.ReactNode} props.children
 * @param {function} [props.onWidgetChange] - Optional callback when active widget changes (for URL sync)
 */
export function CanvasProvider({ children, onWidgetChange }) {
  const [activeWidget, setActiveWidget] = useState(null);
  const [pinnedTabs, setPinnedTabs] = useState([]); // { id, artifactType, data, title }
  const [historyDepth, setHistoryDepth] = useState(0);
  const historyRef = useRef([]); // navigation stack
  const widgetSequenceRef = useRef(0);

  const buildWidget = useCallback((artifactType, data, opts = {}) => ({
    artifactType,
    data,
    title: opts.title || null,
    size: opts.size || 'full',
    timestamp: Date.now(),
    instanceId: `widget_${++widgetSequenceRef.current}`,
    sourceTaskId: opts.sourceTaskId || null,
  }), []);

  const syncHistory = useCallback((nextHistory) => {
    historyRef.current = nextHistory;
    setHistoryDepth(nextHistory.length);
  }, []);

  /**
   * Open a widget on the canvas.
   * @param {string} artifactType - artifact type key (matches WIDGET_REGISTRY)
   * @param {*} data - artifact data payload
   * @param {object} [opts] - { title, size, sourceTaskId, pin }
   */
  const openWidget = useCallback((artifactType, data, opts = {}) => {
    const widget = buildWidget(artifactType, data, opts);

    // Push current widget to history before replacing
    setActiveWidget(prev => {
      if (prev) {
        syncHistory([prev, ...historyRef.current].slice(0, MAX_HISTORY));
      }
      return widget;
    });

    // Notify external listener (e.g., URL sync)
    if (onWidgetChange) onWidgetChange(widget);

    // Optionally pin as a tab
    if (opts.pin) {
      setPinnedTabs(prev => {
        const id = `${artifactType}_${Date.now()}`;
        if (prev.length >= 8) return prev; // cap tabs
        return [...prev, { id, artifactType, data, title: opts.title || artifactType }];
      });
    }
  }, [buildWidget, onWidgetChange, syncHistory]);

  /**
   * Update the data of the currently active widget in-place (e.g. live edits).
   */
  const updateWidgetData = useCallback((patchFn) => {
    setActiveWidget(prev => {
      if (!prev) return prev;
      return { ...prev, data: patchFn(prev.data), timestamp: Date.now() };
    });
  }, []);

  /**
   * Navigate back to previous widget (if any).
   */
  const goBack = useCallback(() => {
    const prev = historyRef.current[0];
    if (prev) {
      syncHistory(historyRef.current.slice(1));
      setActiveWidget(prev);
    }
  }, [syncHistory]);

  /**
   * Close the canvas (no active widget).
   */
  const closeCanvas = useCallback(() => {
    setActiveWidget(prev => {
      if (prev) {
        syncHistory([prev, ...historyRef.current].slice(0, MAX_HISTORY));
      }
      return null;
    });
  }, [syncHistory]);

  /**
   * Switch to a pinned tab by id.
   */
  const switchToTab = useCallback((tabId) => {
    const tab = pinnedTabs.find(t => t.id === tabId);
    if (!tab) return;
    setActiveWidget(buildWidget(tab.artifactType, tab.data, { title: tab.title, size: 'full' }));
  }, [buildWidget, pinnedTabs]);

  /**
   * Remove a pinned tab.
   */
  const unpinTab = useCallback((tabId) => {
    setPinnedTabs(prev => prev.filter(t => t.id !== tabId));
  }, []);

  const canGoBack = historyDepth > 0;

  const value = {
    activeWidget,
    pinnedTabs,
    canGoBack,
    openWidget,
    updateWidgetData,
    goBack,
    closeCanvas,
    switchToTab,
    unpinTab,
  };

  return (
    <CanvasContext.Provider value={value}>
      {children}
    </CanvasContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const useCanvas = () => {
  const ctx = useContext(CanvasContext);
  if (!ctx) throw new Error('useCanvas must be used inside <CanvasProvider>');
  return ctx;
};

export default CanvasContext;
