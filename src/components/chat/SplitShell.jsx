import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, PanelRightOpen } from 'lucide-react';
import ResizableDivider from './ResizableDivider';

const clampRatio = (ratio) => Math.max(0.25, Math.min(0.75, ratio));

export default function SplitShell({
  sidebar,
  chat,
  canvas,
  sidebarCollapsed,
  onSidebarToggle,
  canvasOpen,
  onCanvasToggle,
  initialSplitRatio = 0.5,
  onSplitRatioCommit
}) {
  const workRef = useRef(null);
  const frameRef = useRef(null);
  const pendingXRef = useRef(null);
  const splitRatioRef = useRef(clampRatio(initialSplitRatio));
  const endDragRef = useRef(null);
  const [splitRatio, setSplitRatio] = useState(clampRatio(initialSplitRatio));

  const sidebarWidth = sidebarCollapsed ? 56 : 300;

  const commitRatio = useCallback((nextRatio) => {
    const clamped = clampRatio(nextRatio);
    splitRatioRef.current = clamped;
    setSplitRatio(clamped);
    onSplitRatioCommit?.(clamped);
  }, [onSplitRatioCommit]);

  const applyDrag = useCallback(() => {
    frameRef.current = null;
    const x = pendingXRef.current;
    const el = workRef.current;
    if (x == null || !el) return;

    const rect = el.getBoundingClientRect();
    if (!rect.width) return;

    const next = clampRatio((x - rect.left) / rect.width);
    splitRatioRef.current = next;
    setSplitRatio(next);
  }, []);

  const onPointerMove = useCallback((event) => {
    pendingXRef.current = event.clientX;
    if (!frameRef.current) {
      frameRef.current = window.requestAnimationFrame(applyDrag);
    }
  }, [applyDrag]);

  const endDrag = useCallback(() => {
    if (frameRef.current) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const endListener = endDragRef.current;
    window.removeEventListener('pointermove', onPointerMove);
    if (endListener) {
      window.removeEventListener('pointerup', endListener);
      window.removeEventListener('pointercancel', endListener);
    }
    onSplitRatioCommit?.(splitRatioRef.current);
  }, [onPointerMove, onSplitRatioCommit]);

  useEffect(() => {
    endDragRef.current = endDrag;
  }, [endDrag]);

  const onDividerPointerDown = useCallback((event) => {
    event.preventDefault();
    const endListener = endDragRef.current;
    window.addEventListener('pointermove', onPointerMove);
    if (endListener) {
      window.addEventListener('pointerup', endListener);
      window.addEventListener('pointercancel', endListener);
    }
  }, [onPointerMove]);

  // Keyboard shortcut for sidebar toggle (⌘+B / Ctrl+B)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        onSidebarToggle?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSidebarToggle]);

  useEffect(() => {
    return () => {
      if (frameRef.current) {
        window.cancelAnimationFrame(frameRef.current);
      }
      const endListener = endDragRef.current;
      window.removeEventListener('pointermove', onPointerMove);
      if (endListener) {
        window.removeEventListener('pointerup', endListener);
        window.removeEventListener('pointercancel', endListener);
      }
    };
  }, [onPointerMove]);

  const chatWidth = useMemo(() => {
    if (!canvasOpen) return '100%';
    return `${splitRatio * 100}%`;
  }, [canvasOpen, splitRatio]);

  const canvasWidth = useMemo(() => {
    if (!canvasOpen) return '0%';
    return `${(1 - splitRatio) * 100}%`;
  }, [canvasOpen, splitRatio]);

  return (
    <div className="h-full w-full flex gap-2 md:gap-3 overflow-hidden">
      {/* Sidebar - Collapsible */}
      <aside
        style={{ width: `${sidebarWidth}px` }}
        className="h-full flex-shrink-0 transition-[width] motion-safe:duration-200 ease-out motion-reduce:transition-none"
      >
        <div className="h-full relative">
          {sidebar}
          {/* Toggle button positioned at the edge of sidebar */}
          <button
            type="button"
            onClick={onSidebarToggle}
            className="absolute -right-3 top-4 z-10 h-6 w-6 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title={sidebarCollapsed ? 'Expand history (⌘+B)' : 'Collapse history (⌘+B)'}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="w-3.5 h-3.5 text-slate-600 dark:text-slate-400" />
            ) : (
              <PanelLeftClose className="w-3.5 h-3.5 text-slate-600 dark:text-slate-400" />
            )}
          </button>
        </div>
      </aside>

      {/* Main work area - Chat + Canvas */}
      <section ref={workRef} className="flex-1 min-w-0 h-full flex items-stretch relative overflow-hidden">
        {/* Chat area */}
        <div
          style={{ width: chatWidth }}
          className="h-full min-w-0 transition-[width] motion-safe:duration-200 ease-out motion-reduce:transition-none"
        >
          {chat}
        </div>

        {/* Resizable divider - only visible when canvas is open */}
        {canvasOpen ? (
          <ResizableDivider
            onPointerDown={onDividerPointerDown}
            onDoubleClick={() => commitRatio(0.5)}
          />
        ) : null}

        {/* Canvas panel - slides in/out with transform */}
        <div
          style={{ width: canvasWidth }}
          className={`h-full min-w-0 overflow-hidden motion-safe:transition-all motion-safe:duration-200 ease-out motion-reduce:transition-none ${
            canvasOpen
              ? 'opacity-100 translate-x-0'
              : 'opacity-0 translate-x-4 pointer-events-none'
          }`}
        >
          {canvas}
        </div>

        {/* Open Canvas button - shown when canvas is closed */}
        {!canvasOpen ? (
          <button
            type="button"
            onClick={onCanvasToggle}
            className="absolute right-3 top-3 z-20 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/90 px-2.5 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shadow-sm"
            title="Open Canvas"
          >
            <PanelRightOpen className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Canvas</span>
          </button>
        ) : null}
      </section>
    </div>
  );
}
