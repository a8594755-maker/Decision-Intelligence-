/**
 * HtmlCanvasRenderer.jsx
 *
 * Renders agent-generated HTML in a sandboxed iframe.
 * Auto-resizes to content height.
 */

import { useRef, useEffect } from 'react';

// Safety CSS injected into every dashboard to prevent chart overflow
const SAFETY_CSS = `<style data-safety>
  svg { max-width: 100%; height: auto; }
  body { overflow-x: hidden; max-width: 1400px; margin: 0 auto; padding: 0 16px; box-sizing: border-box; }
  [class*="chart"], .chart-container, .card { overflow: hidden; max-width: 100%; box-sizing: border-box; }
</style>`;

function injectSafetyCSS(rawHtml) {
  if (!rawHtml) return rawHtml;
  // Inject after <head> if present, otherwise prepend
  if (rawHtml.includes('<head>')) return rawHtml.replace('<head>', '<head>' + SAFETY_CSS);
  if (rawHtml.includes('<head ')) return rawHtml.replace(/<head[^>]*>/, '$&' + SAFETY_CSS);
  return SAFETY_CSS + rawHtml;
}

export default function HtmlCanvasRenderer({ html }) {
  const iframeRef = useRef(null);
  const safeHtml = injectSafetyCSS(html);

  // Auto-resize iframe to match content height
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !html) return;

    const resize = () => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc?.body) {
          const h = doc.body.scrollHeight;
          if (h > 100) iframe.style.height = `${h + 40}px`;
        }
      } catch { /* sandbox restriction */ }
    };

    iframe.addEventListener('load', resize);
    // Also resize after a delay (some content renders asynchronously)
    const timer = setTimeout(resize, 500);

    return () => {
      iframe.removeEventListener('load', resize);
      clearTimeout(timer);
    };
  }, [safeHtml]);

  if (!html) return null;

  return (
    <iframe
      ref={iframeRef}
      srcDoc={safeHtml}
      sandbox="allow-scripts"
      className="w-full border-0 rounded-xl overflow-hidden bg-white"
      style={{ minHeight: '600px' }}
      title="Insights Dashboard"
    />
  );
}
