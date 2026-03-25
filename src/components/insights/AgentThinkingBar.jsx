/**
 * AgentThinkingBar.jsx
 *
 * Shows the agent's thinking/reasoning process.
 * During loading: shows real-time iteration progress from the agent.
 * After completion: shows the agent's analytical reasoning (collapsible).
 */

import { useState, useEffect, useRef } from 'react';
import { Brain, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';

export default function AgentThinkingBar({ thinking, loading, progress }) {
  const [expanded, setExpanded] = useState(true);
  const [displayText, setDisplayText] = useState('');
  const intervalRef = useRef(null);

  // Typewriter effect for final thinking
  useEffect(() => {
    if (!thinking) { setDisplayText(''); return; }

    // If loading is done, show full text immediately
    if (!loading) {
      setDisplayText(thinking);
      setExpanded(false); // auto-collapse when done
      return;
    }

    // Typewriter during loading
    let idx = 0;
    setDisplayText('');
    intervalRef.current = setInterval(() => {
      idx++;
      if (idx >= thinking.length) {
        clearInterval(intervalRef.current);
        setDisplayText(thinking);
      } else {
        setDisplayText(thinking.slice(0, idx));
      }
    }, 15);

    return () => clearInterval(intervalRef.current);
  }, [thinking, loading]);

  if (!loading && !thinking) return null;

  return (
    <div className="rounded-xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/20 overflow-hidden transition-all">
      {/* Header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors"
      >
        {loading ? (
          <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" />
        ) : (
          <Brain className="w-4 h-4 text-indigo-500" />
        )}
        <span className="text-sm font-medium text-indigo-700 dark:text-indigo-300">
          {loading
            ? (progress || 'Agent is analyzing your data...')
            : 'Agent reasoning'}
        </span>
        <span className="ml-auto">
          {expanded
            ? <ChevronUp className="w-4 h-4 text-indigo-400" />
            : <ChevronDown className="w-4 h-4 text-indigo-400" />}
        </span>
      </button>

      {/* Body */}
      {expanded && (
        <div className="px-4 pb-3">
          {loading ? (
            <p className="text-sm text-indigo-600/80 dark:text-indigo-400/80 leading-relaxed">
              {progress || 'Gathering insights from your analysis reports...'}
              <span className="inline-block w-1.5 h-4 bg-indigo-500 ml-0.5 animate-pulse" />
            </p>
          ) : displayText ? (
            <p className="text-sm text-indigo-600/80 dark:text-indigo-400/80 leading-relaxed whitespace-pre-wrap">
              {displayText}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
