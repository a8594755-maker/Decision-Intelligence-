import React, { memo, useMemo } from 'react';
import { Bot, Plus, Search, MessageSquare, Trash2 } from 'lucide-react';
import ConversationListItem from './ConversationListItem';

function SidebarSkeleton({ collapsed }) {
  if (collapsed) {
    return (
      <div className="p-2 space-y-2 animate-pulse">
        {Array.from({ length: 7 }).map((_, idx) => (
          <div key={idx} className="h-9 w-9 rounded-lg bg-[var(--surface-subtle)] mx-auto" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-3 space-y-2 animate-pulse">
      {Array.from({ length: 7 }).map((_, idx) => (
        <div key={idx} className="rounded-xl bg-[var(--surface-subtle)] px-3 py-3">
          <div className="h-3 w-2/3 bg-[var(--surface-subtle)] rounded" />
          <div className="mt-2 h-2.5 w-full bg-[var(--surface-subtle)] rounded" />
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
      <div className="h-full w-full bg-[var(--surface-card)] border-r border-[var(--border-default)]/60 flex flex-col overflow-hidden">
        {/* Header icons */}
        <div className="px-2 py-3 border-b border-[var(--border-default)]/60 flex flex-col items-center gap-2">
          <button
            type="button"
            title={title}
            className="h-9 w-9 inline-flex items-center justify-center rounded-lg bg-[var(--brand-600)] text-white shadow-sm hover:bg-[var(--brand-700)] transition-all cursor-pointer"
            onClick={onExpandFromCollapsed}
          >
            <Bot className="w-4 h-4" />
          </button>
          <button
            type="button"
            title="New chat"
            className="h-9 w-9 inline-flex items-center justify-center rounded-lg bg-[var(--surface-subtle)] text-[var(--text-secondary)] hover:bg-[var(--accent-hover)] transition-colors"
            onClick={onNewConversation}
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            type="button"
            title="Search conversations"
            className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--accent-hover)] transition-colors"
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
            <div className="h-full flex flex-col items-center justify-center text-[var(--text-muted)]">
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
                      ? 'bg-[var(--brand-600)] text-white shadow-sm'
                      : 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--accent-hover)]'
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
    <div className="h-full w-full bg-[var(--surface-card)] border-r border-[var(--border-default)]/60 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-3 py-3 border-b border-[var(--border-default)]/60">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex p-1.5 rounded-lg bg-[var(--brand-600)] text-white shadow-sm">
              <Bot className="w-4 h-4" />
            </span>
            <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{title}</p>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[var(--surface-subtle)] hover:bg-[var(--accent-hover)] text-[var(--text-secondary)] text-xs font-medium transition-colors flex-shrink-0"
            onClick={onNewConversation}
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">New</span>
          </button>
        </div>

        {/* Search */}
        <div className="mt-3 relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange?.(event.target.value)}
            placeholder="Search conversations..."
            className="w-full pl-8 pr-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-base)] text-sm outline-none focus:ring-2 focus:ring-[var(--focus-ring)]/40 focus:border-[var(--focus-ring)] transition-all placeholder:text-[var(--text-muted)]"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {isLoading ? (
          <SidebarSkeleton />
        ) : filteredConversations.length === 0 ? (
          <div className="h-full px-4 py-10 text-center flex flex-col items-center justify-center text-[var(--text-muted)]">
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
