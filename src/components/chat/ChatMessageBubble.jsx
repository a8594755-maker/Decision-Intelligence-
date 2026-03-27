import React, { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bell, FileText, Table2, Copy, Check, RefreshCw } from 'lucide-react';
import { formatAttachmentSize } from '../../services/chat/chatAttachmentService';

const markdownComponents = {
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full text-xs border-collapse border border-[var(--border-default)]">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-[var(--surface-subtle)]">{children}</thead>,
  th: ({ children }) => <th className="border border-[var(--border-default)] px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-[var(--border-default)] px-2 py-1">{children}</td>,
  p: ({ children, node }) => {
    const hasBlock = node?.children?.some(c => c.type === 'element' && /^(pre|div|table|ul|ol|blockquote)$/.test(c.tagName));
    return hasBlock ? <div className="mb-3">{children}</div> : <p>{children}</p>;
  },
  pre: ({ children }) => (
    <pre className="bg-[var(--surface-subtle)] text-[var(--text-primary)] p-3 rounded-lg overflow-x-auto my-2 text-xs [&>code]:bg-transparent [&>code]:p-0 border border-[var(--border-default)]">
      {children}
    </pre>
  ),
  code: ({ children, className, ...props }) => (
    <code className={`${className || 'bg-[var(--surface-subtle)] px-1 py-0.5 rounded'} text-xs`} {...props}>{children}</code>
  )
};

/* ── Action toolbar for AI messages (always visible, like ChatGPT) ── */
function MessageActions({ text }) {
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
    <div className="flex items-center gap-0.5 mt-2 -ml-1.5">
      <button
        type="button"
        onClick={handleCopy}
        title="Copy"
        aria-label="Copy message"
        className="inline-flex items-center justify-center rounded-lg p-1.5 text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] transition-colors cursor-pointer"
      >
        {copied ? <Check size={15} className="text-[var(--status-success)]" /> : <Copy size={15} />}
      </button>
    </div>
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
              className="min-w-[12rem] max-w-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-base)] text-[var(--text-primary)] px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${isSpreadsheet ? 'bg-[var(--status-success)] text-white' : 'bg-[var(--cat-plan)] text-white'}`}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{attachment.file_name}</p>
                  {secondary ? (
                    <p className="truncate text-[11px] text-[var(--text-muted)]">{secondary}</p>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  /* ── User message bubble (subtle, like ChatGPT) ── */
  const userBubbleClass = isAIEmployeeVariant
    ? 'rounded-2xl rounded-br-sm bg-[var(--surface-subtle)] px-4 py-2.5 text-[var(--text-primary)]'
    : 'rounded-2xl rounded-br-sm bg-[var(--surface-subtle)] px-4 py-2.5 text-[var(--text-primary)]';

  /* ── AI message (clean text, no bubble) ── */
  const aiBubbleClass = isAIEmployeeVariant
    ? 'px-0 py-1 text-[var(--text-primary)]'
    : 'px-0 py-1 text-[var(--text-primary)]';

  return (
    <div className={`w-full flex ${isUser ? 'justify-end' : 'justify-start'} animate-fade-in group`}>
      <div className={`${isAIEmployeeVariant ? (hasSpecial ? 'w-full' : 'max-w-[min(100%,40rem)]') : `max-w-[88%] ${hasSpecial ? 'w-full' : ''}`}`}>
        {/* Proactive alert banner */}
        {isProactive && (
          <div className="flex items-center gap-1.5 mb-1 px-1">
            <Bell className="w-3.5 h-3.5 text-[var(--status-warning)]" />
            <span className="text-[11px] font-medium text-[var(--status-warning)]">Proactive Alert</span>
          </div>
        )}
        {hasSpecial ? (
          <div className={`w-full ${isProactive ? 'border-l-2 border-[var(--status-warning)] pl-2' : ''}`}>{renderSpecialMessage?.(message)}</div>
        ) : (
          <div>
            <div className={isUser ? userBubbleClass : aiBubbleClass}>
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
            </div>

            {/* Timestamp for user messages */}
            {isUser && timestampText ? (
              <div className="mt-1 text-right text-[11px] text-[var(--text-muted)] pr-1">
                {timestampText}
              </div>
            ) : null}

            {/* AI message: timestamp + action toolbar (always visible) */}
            {!isUser && message?.content ? (
              <div className="flex items-center gap-3 mt-0.5">
                {timestampText || message?.meta?.model ? (
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {[timestampText, message?.meta?.model].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
                <MessageActions text={message.content} />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(ChatMessageBubble);
