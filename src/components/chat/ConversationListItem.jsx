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
      className={`w-full text-left group relative transition-colors duration-150 cursor-pointer ${
        compact
          ? `px-3 py-2 rounded-lg ${
              isActive
                ? 'bg-[var(--accent-active)]'
                : 'hover:bg-[var(--accent-hover)]'
            }`
          : `px-3 py-2.5 rounded-lg ${
              isActive
                ? 'bg-[var(--accent-active)]'
                : 'hover:bg-[var(--accent-hover)]'
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
        <span className={`absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full transition-colors ${isActive ? 'bg-[var(--brand-600)]' : 'bg-transparent'}`} />
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
          <span className="inline-flex mt-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-[var(--status-danger-bg)] text-[var(--status-danger-text)]">
            AI error
          </span>
        ) : null}
      </div>

      <span className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          aria-label="Delete conversation"
          className="p-1.5 rounded-lg hover:bg-[var(--status-danger-bg)] text-[var(--text-muted)] hover:text-[var(--status-danger)] transition-colors cursor-pointer"
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
