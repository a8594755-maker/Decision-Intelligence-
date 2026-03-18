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
  const historyRef = useRef([]); // navigation stack

  /**
   * Open a widget on the canvas.
   * @param {string} artifactType - artifact type key (matches WIDGET_REGISTRY)
   * @param {*} data - artifact data payload
   * @param {object} [opts] - { title, size, sourceTaskId, pin }
   */
  const openWidget = useCallback((artifactType, data, opts = {}) => {
    const widget = {
      artifactType,
      data,
      title: opts.title || null,
      size: opts.size || 'full',
      timestamp: Date.now(),
      sourceTaskId: opts.sourceTaskId || null,
    };

    // Push current widget to history before replacing
    setActiveWidget(prev => {
      if (prev) {
        historyRef.current = [prev, ...historyRef.current].slice(0, MAX_HISTORY);
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
  }, [onWidgetChange]);

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
      historyRef.current = historyRef.current.slice(1);
      setActiveWidget(prev);
    }
  }, []);

  /**
   * Close the canvas (no active widget).
   */
  const closeCanvas = useCallback(() => {
    setActiveWidget(prev => {
      if (prev) {
        historyRef.current = [prev, ...historyRef.current].slice(0, MAX_HISTORY);
      }
      return null;
    });
  }, []);

  /**
   * Switch to a pinned tab by id.
   */
  const switchToTab = useCallback((tabId) => {
    setPinnedTabs(prev => {
      const tab = prev.find(t => t.id === tabId);
      if (tab) {
        setActiveWidget({
          artifactType: tab.artifactType,
          data: tab.data,
          title: tab.title,
          size: 'full',
          timestamp: Date.now(),
        });
      }
      return prev;
    });
  }, []);

  /**
   * Remove a pinned tab.
   */
  const unpinTab = useCallback((tabId) => {
    setPinnedTabs(prev => prev.filter(t => t.id !== tabId));
  }, []);

  const canGoBack = historyRef.current.length > 0;

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
