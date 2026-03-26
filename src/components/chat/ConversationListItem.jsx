import React, { memo } from 'react';
import { Trash2 } from 'lucide-react';

function ConversationListItem({
  conversation,
  isActive,
  onSelect,
  onDelete,
  formatTime,
  variant = 'default',
}) {
  const lastMessage = conversation?.messages?.[conversation.messages.length - 1];
  const isAiError = lastMessage?.type === 'ai_error_card';
  const snippet = isAiError ? 'AI error' : String(lastMessage?.content || '[Card]');
  const compact = variant === 'compact';

  return (
    <div
      role="button"
      tabIndex={0}
      className={`w-full text-left group relative transition-colors duration-150 ${
        compact
          ? `px-3 py-2 rounded-2xl ${
              isActive
                ? 'bg-slate-100/95 dark:bg-slate-800/85'
                : 'hover:bg-[var(--accent-hover)]/75 dark:hover:bg-slate-800/55'
            }`
          : `px-3 py-2.5 rounded-xl ${
              isActive
                ? 'bg-blue-50 dark:bg-blue-900/20'
                : 'hover:bg-[var(--accent-hover)]/80 dark:hover:bg-slate-800/60'
            }`
      }`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect?.();
        }
      }}
    >
      {!compact ? (
        <span className={`absolute left-0 top-2 bottom-2 w-1 rounded-r-full ${isActive ? 'bg-blue-500' : 'bg-transparent'}`} />
      ) : null}
      <div className={compact ? '' : 'pl-2'}>
        <div className="flex items-start justify-between gap-2">
          <p className={`font-medium text-[var(--text-primary)] line-clamp-1 ${compact ? 'text-[13px]' : 'text-sm'}`}>
            {conversation.title || 'New Conversation'}
          </p>
          <span className={`whitespace-nowrap text-[var(--text-muted)] ${compact ? 'text-[10px]' : 'text-[11px]'}`}>
            {formatTime(conversation.updated_at)}
          </span>
        </div>
        <p className={`text-[var(--text-muted)] line-clamp-1 mt-0.5 ${compact ? 'text-[11px]' : 'text-xs'}`}>
          {snippet.slice(0, 80)}
        </p>
        {isAiError ? (
          <span className="inline-flex mt-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
            AI error
          </span>
        ) : null}
      </div>

      <span className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          aria-label="Delete conversation"
          className="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-600"
          onClick={(event) => {
            event.stopPropagation();
            onDelete?.();
          }}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </span>
    </div>
  );
}

export default memo(ConversationListItem);
