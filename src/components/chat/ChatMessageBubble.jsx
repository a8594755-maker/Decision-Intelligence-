import React, { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bell, FileText, Table2, Copy, Check } from 'lucide-react';
import { formatAttachmentSize } from '../../services/chat/chatAttachmentService';

const markdownComponents = {
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full text-xs border-collapse border border-slate-300 dark:border-slate-600">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-[var(--surface-subtle)]">{children}</thead>,
  th: ({ children }) => <th className="border border-slate-300 dark:border-slate-600 px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-slate-300 dark:border-slate-600 px-2 py-1">{children}</td>,
  p: ({ children, node }) => {
    const hasBlock = node?.children?.some(c => c.type === 'element' && /^(pre|div|table|ul|ol|blockquote)$/.test(c.tagName));
    return hasBlock ? <div className="mb-3">{children}</div> : <p>{children}</p>;
  },
  pre: ({ children }) => (
    <pre className="bg-slate-900 text-slate-100 p-3 rounded-lg overflow-x-auto my-2 text-xs [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children, className, ...props }) => (
    <code className={`${className || 'bg-slate-200 dark:bg-slate-600 px-1 py-0.5 rounded'} text-xs`} {...props}>{children}</code>
  )
};

function CopyInlineButton({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy message"
      className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:text-slate-300 dark:hover:bg-slate-700"
    >
      {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
    </button>
  );
}

function ChatMessageBubble({ message, renderSpecialMessage, timestampText = '', variant = 'default' }) {
  const isUser = message?.role === 'user';
  const hasSpecial = Boolean(message?.type);
  const isProactive = Boolean(message?.is_proactive);
  const isAIEmployeeVariant = variant === 'ai_employee';
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];

  const renderAttachmentList = () => {
    if (attachments.length === 0) return null;
    return (
      <div className="mb-2 flex flex-wrap gap-2">
        {attachments.map((attachment, index) => {
          const isSpreadsheet = attachment?.kind === 'spreadsheet';
          const Icon = isSpreadsheet ? Table2 : FileText;
          const secondary = attachment?.summary || [
            attachment?.kind,
            formatAttachmentSize(attachment?.size_bytes),
          ].filter(Boolean).join(' • ');

          return (
            <div
              key={attachment.id || `${attachment.file_name || 'attachment'}_${index}`}
              className={`min-w-[12rem] max-w-full rounded-2xl border px-3 py-2 ${
                isUser
                  ? 'border-white/20 bg-white/10 text-white'
                  : 'border-slate-200 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-100'
              }`}
            >
              <div className="flex items-center gap-2">
                <div className={`flex h-8 w-8 items-center justify-center rounded-xl ${isSpreadsheet ? 'bg-emerald-500 text-white' : 'bg-blue-500 text-white'}`}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {attachment.file_name}
                  </p>
                  {secondary ? (
                    <p className={`truncate text-[11px] ${isUser ? 'text-white/75' : 'text-[var(--text-muted)]'}`}>
                      {secondary}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className={`w-full flex ${isUser ? 'justify-end' : 'justify-start'} animate-fade-in group`}>
      <div className={`${isAIEmployeeVariant ? (hasSpecial ? 'w-full' : 'max-w-[min(100%,40rem)]') : `max-w-[88%] ${hasSpecial ? 'w-full' : ''}`}`}>
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
            className={`${
              isAIEmployeeVariant
                ? isUser
                  ? 'rounded-[24px] rounded-br-lg bg-slate-900 px-4 py-2.5 text-white shadow-sm dark:bg-slate-100 dark:text-slate-900'
                  : 'px-1 py-1 text-[var(--text-primary)]'
                : `rounded-2xl px-4 py-2.5 shadow-sm ${
                    isUser
                      ? 'bg-blue-600 text-white rounded-br-md'
                      : 'bg-[var(--surface-card)] text-[var(--text-primary)] border border-[var(--border-default)] rounded-bl-md'
              }`
            }`}
          >
            {renderAttachmentList()}
            {isUser ? (
              message.content ? (
                <p className={`whitespace-pre-wrap leading-relaxed ${isAIEmployeeVariant ? 'text-[14px]' : 'text-sm'}`}>{message.content}</p>
              ) : null
            ) : (
              message.content ? (
                <div className={`leading-relaxed prose prose-sm max-w-none dark:prose-invert ${isAIEmployeeVariant ? 'text-[15px] prose-p:leading-7 prose-headings:mb-3 prose-p:my-2' : 'text-sm'}`}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {message.content || ''}
                  </ReactMarkdown>
                </div>
              ) : null
            )}
            {(timestampText || (!isUser && message?.meta?.model) || (!isUser && message?.content)) ? (
              <div className={`mt-1 flex items-center gap-2 text-[11px] ${isAIEmployeeVariant ? (isUser ? 'text-slate-300 dark:text-slate-500' : 'text-slate-400') : isUser ? 'text-blue-100' : 'text-slate-400'}`}>
                <span>{[timestampText, !isUser && message?.meta?.model ? `· ${message.meta.model}` : null].filter(Boolean).join(' ')}</span>
                {!isUser && message?.content ? <CopyInlineButton text={message.content} /> : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(ChatMessageBubble);
