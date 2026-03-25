/**
 * HtmlCanvasRenderer.jsx
 *
 * Renders agent-generated HTML in a sandboxed iframe.
 * Auto-resizes to content height.
 */

import { useRef, useEffect } from 'react';

export default function HtmlCanvasRenderer({ html }) {
  const iframeRef = useRef(null);

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
  }, [html]);

  if (!html) return null;

  return (
    <iframe
      ref={iframeRef}
      srcDoc={html}
      sandbox="allow-scripts"
      className="w-full border-0 rounded-xl overflow-hidden bg-white"
      style={{ minHeight: '600px' }}
      title="Insights Dashboard"
    />
  );
}
