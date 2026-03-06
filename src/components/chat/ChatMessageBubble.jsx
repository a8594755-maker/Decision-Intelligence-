import React, { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bell } from 'lucide-react';

const markdownComponents = {
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full text-xs border-collapse border border-slate-300 dark:border-slate-600">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-slate-100 dark:bg-slate-700">{children}</thead>,
  th: ({ children }) => <th className="border border-slate-300 dark:border-slate-600 px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-slate-300 dark:border-slate-600 px-2 py-1">{children}</td>,
  code: ({ inline, children, ...props }) => {
    if (inline) {
      return <code className="bg-slate-200 dark:bg-slate-600 px-1 py-0.5 rounded text-xs" {...props}>{children}</code>;
    }
    return (
      <pre className="bg-slate-900 text-slate-100 p-3 rounded-lg overflow-x-auto my-2 text-xs">
        <code {...props}>{children}</code>
      </pre>
    );
  }
};

function ChatMessageBubble({ message, renderSpecialMessage, timestampText = '' }) {
  const isUser = message?.role === 'user';
  const hasSpecial = Boolean(message?.type);
  const isProactive = Boolean(message?.is_proactive);

  return (
    <div className={`w-full flex ${isUser ? 'justify-end' : 'justify-start'} animate-fade-in`}>
      <div className={`max-w-[88%] ${hasSpecial ? 'w-full' : ''}`}>
        {/* Proactive alert banner */}
        {isProactive && (
          <div className="flex items-center gap-1.5 mb-1 px-1">
            <Bell className="w-3.5 h-3.5 text-amber-500" />
            <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">Proactive Alert</span>
          </div>
        )}
        {hasSpecial ? (
          <div className={`w-full ${isProactive ? 'border-l-2 border-amber-400 pl-2' : ''}`}>{renderSpecialMessage?.(message)}</div>
        ) : (
          <div
            className={`rounded-2xl px-4 py-2.5 shadow-sm ${
              isUser
                ? 'bg-blue-600 text-white rounded-br-md'
                : 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-200/70 dark:border-slate-700/70 rounded-bl-md'
            }`}
          >
            {isUser ? (
              <p className="text-sm whitespace-pre-wrap leading-relaxed">{message.content}</p>
            ) : (
              <div className="text-sm leading-relaxed prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {message.content || ''}
                </ReactMarkdown>
              </div>
            )}
            {timestampText ? (
              <p className={`mt-1 text-[11px] ${isUser ? 'text-blue-100' : 'text-slate-400'}`}>
                {timestampText}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(ChatMessageBubble);
