import React, { memo, useMemo } from 'react';
import { Bot, Plus, Search, MessageSquare, Trash2 } from 'lucide-react';
import ConversationListItem from './ConversationListItem';

function SidebarSkeleton({ collapsed }) {
  if (collapsed) {
    return (
      <div className="p-2 space-y-2 animate-pulse">
        {Array.from({ length: 7 }).map((_, idx) => (
          <div key={idx} className="h-9 w-9 rounded-lg bg-slate-200 dark:bg-slate-800 mx-auto" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-3 space-y-2 animate-pulse">
      {Array.from({ length: 7 }).map((_, idx) => (
        <div key={idx} className="rounded-xl bg-slate-100 dark:bg-slate-800 px-3 py-3">
          <div className="h-3 w-2/3 bg-slate-200 dark:bg-slate-700 rounded" />
          <div className="mt-2 h-2.5 w-full bg-slate-200 dark:bg-slate-700 rounded" />
        </div>
      ))}
    </div>
  );
}

function ConversationSidebar({
  title,
  conversations,
  currentConversationId,
  onSelectConversation,
  onDeleteConversation,
  onNewConversation,
  formatTime,
  searchQuery,
  onSearchQueryChange,
  isLoading,
  collapsed = false,
  onExpandFromCollapsed
}) {
  const filteredConversations = useMemo(() => {
    const q = String(searchQuery || '').trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((conversation) => {
      const lastMessage = conversation?.messages?.[conversation.messages.length - 1]?.content || '';
      return String(conversation?.title || '').toLowerCase().includes(q)
        || String(lastMessage).toLowerCase().includes(q);
    });
  }, [conversations, searchQuery]);

  // Collapsed mode - icon rail only
  if (collapsed) {
    return (
      <div className="h-full w-full bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-700/60 flex flex-col overflow-hidden">
        {/* Header icons */}
        <div className="px-2 py-3 border-b border-slate-200 dark:border-slate-700/60 flex flex-col items-center gap-2">
          <button
            type="button"
            title={title}
            className="h-9 w-9 inline-flex items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 text-white shadow-sm hover:from-blue-600 hover:to-blue-700 transition-all"
            onClick={onExpandFromCollapsed}
          >
            <Bot className="w-4 h-4" />
          </button>
          <button
            type="button"
            title="New chat"
            className="h-9 w-9 inline-flex items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
            onClick={onNewConversation}
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            type="button"
            title="Search conversations"
            className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            onClick={onExpandFromCollapsed}
          >
            <Search className="w-4 h-4" />
          </button>
        </div>

        {/* Conversation icons */}
        <div className="flex-1 overflow-y-auto scrollbar-thin px-2 py-2 space-y-1">
          {isLoading ? (
            <SidebarSkeleton collapsed />
          ) : filteredConversations.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400">
              <MessageSquare className="w-5 h-5" />
            </div>
          ) : (
            filteredConversations.map((conversation) => {
              const active = currentConversationId === conversation.id;
              const lastMessage = conversation?.messages?.[conversation.messages.length - 1];
              const isError = lastMessage?.type === 'ai_error_card';
              const title = conversation.title || 'New Conversation';
              const initial = title.trim().charAt(0).toUpperCase() || 'C';

              return (
                <button
                  key={conversation.id}
                  type="button"
                  title={`${title}${isError ? ' (AI error)' : ''}`}
                  onClick={() => onSelectConversation?.(conversation.id)}
                  className={`w-full aspect-square rounded-lg flex items-center justify-center text-sm font-medium transition-all duration-150 ${
                    active
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-transparent text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  {initial}
                </button>
              );
            })
          )}
        </div>
      </div>
    );
  }

  // Expanded mode - full sidebar
  return (
    <div className="h-full w-full bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-700/60 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-3 py-3 border-b border-slate-200 dark:border-slate-700/60">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex p-1.5 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 text-white shadow-sm">
              <Bot className="w-4 h-4" />
            </span>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{title}</p>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-medium transition-colors flex-shrink-0"
            onClick={onNewConversation}
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">New</span>
          </button>
        </div>

        {/* Search */}
        <div className="mt-3 relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange?.(event.target.value)}
            placeholder="Search conversations..."
            className="w-full pl-8 pr-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/70 text-sm outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-400 transition-all placeholder:text-slate-400"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {isLoading ? (
          <SidebarSkeleton />
        ) : filteredConversations.length === 0 ? (
          <div className="h-full px-4 py-10 text-center flex flex-col items-center justify-center text-slate-400">
            <Bot className="w-10 h-10 mb-3 opacity-50" />
            <p className="text-sm">No conversations yet</p>
            <p className="text-xs mt-1 opacity-70">Start a new chat to begin</p>
          </div>
        ) : (
          <div className="p-1.5 space-y-0.5">
            {filteredConversations.map((conversation) => (
              <ConversationListItem
                key={conversation.id}
                conversation={conversation}
                isActive={currentConversationId === conversation.id}
                onSelect={() => onSelectConversation?.(conversation.id)}
                onDelete={() => onDeleteConversation?.(conversation.id)}
                formatTime={formatTime}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(ConversationSidebar);
