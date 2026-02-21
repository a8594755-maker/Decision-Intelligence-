import React, { memo } from 'react';
import { Trash2 } from 'lucide-react';

function ConversationListItem({ conversation, isActive, onSelect, onDelete, formatTime }) {
  const lastMessage = conversation?.messages?.[conversation.messages.length - 1];
  const isAiError = lastMessage?.type === 'ai_error_card';
  const snippet = isAiError ? 'AI error' : String(lastMessage?.content || '[Card]');

  return (
    <div
      role="button"
      tabIndex={0}
      className={`w-full text-left group relative px-3 py-2.5 rounded-xl transition-colors duration-150 ${
        isActive
          ? 'bg-blue-50 dark:bg-blue-900/20'
          : 'hover:bg-slate-100/80 dark:hover:bg-slate-800/60'
      }`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect?.();
        }
      }}
    >
      <span className={`absolute left-0 top-2 bottom-2 w-1 rounded-r-full ${isActive ? 'bg-blue-500' : 'bg-transparent'}`} />
      <div className="pl-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100 line-clamp-1">
            {conversation.title || 'New Conversation'}
          </p>
          <span className="text-[11px] text-slate-400 whitespace-nowrap">
            {formatTime(conversation.updated_at)}
          </span>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-1 mt-0.5">
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
