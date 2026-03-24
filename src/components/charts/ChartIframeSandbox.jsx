/**
 * ChartIframeSandbox.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders LLM-generated HTML in a sandboxed iframe (Layer A).
 *
 * Security: sandbox="allow-scripts" only — no forms, no popups,
 * no same-origin (cannot access parent DOM/cookies/localStorage).
 *
 * Communication: postMessage for height sync and theme changes only.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';

export default function ChartIframeSandbox({
  html,
  minHeight = 300,
  className = '',
  onError,
}) {
  const iframeRef = useRef(null);
  const [loadError, setLoadError] = useState(false);

  // Stable key: only remount iframe when html content actually changes
  const htmlKey = useMemo(() => {
    if (!html) return '';
    let h = 0;
    const sample = html.substring(0, 200) + html.length;
    for (let i = 0; i < sample.length; i++) {
      h = ((h << 5) - h + sample.charCodeAt(i)) | 0;
    }
    return String(h);
  }, [html]);

  // Sync dark mode to iframe
  const syncTheme = useCallback(() => {
    if (iframeRef.current?.contentWindow) {
      const isDark = document.documentElement.classList.contains('dark');
      iframeRef.current.contentWindow.postMessage(
        { type: 'theme-change', dark: isDark },
        '*'
      );
    }
  }, []);

  useEffect(() => {
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, [syncTheme]);

  const handleLoad = useCallback(() => {
    syncTheme();
    setLoadError(false);
  }, [syncTheme]);

  const handleError = useCallback(() => {
    setLoadError(true);
    onError?.('iframe failed to load');
  }, [onError]);

  if (loadError) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-500 text-xs py-8">
        Chart rendering failed. Switch to another view.
      </div>
    );
  }

  // Fixed height — no dynamic height sync. Chart.js responsive:true fills the space.
  const fixedHeight = Math.max(minHeight, 380);

  return (
    <iframe
      key={htmlKey}
      ref={iframeRef}
      srcDoc={html}
      sandbox="allow-scripts"
      className={`w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 ${className}`}
      style={{ height: fixedHeight }}
      title="Artisan Chart"
      onLoad={handleLoad}
      onError={handleError}
    />
  );
}
