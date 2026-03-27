import React, { memo, useMemo } from 'react';
import { Bot, Plus, Search, X } from 'lucide-react';
import ConversationListItem from './ConversationListItem';

function startOfDay(date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function groupConversationsByDate(conversations = [], now = new Date()) {
  const todayStart = startOfDay(now);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const previousWeekStart = new Date(todayStart);
  previousWeekStart.setDate(previousWeekStart.getDate() - 7);

  const buckets = [
    { key: 'today', label: 'Today', items: [] },
    { key: 'yesterday', label: 'Yesterday', items: [] },
    { key: 'previous-7-days', label: 'Previous 7 Days', items: [] },
    { key: 'older', label: 'Older', items: [] },
  ];

  conversations.forEach((conversation) => {
    const updatedAt = conversation?.updated_at ? new Date(conversation.updated_at) : new Date(0);
    if (updatedAt >= todayStart) {
      buckets[0].items.push(conversation);
    } else if (updatedAt >= yesterdayStart) {
      buckets[1].items.push(conversation);
    } else if (updatedAt >= previousWeekStart) {
      buckets[2].items.push(conversation);
    } else {
      buckets[3].items.push(conversation);
    }
  });

  return buckets.filter((bucket) => bucket.items.length > 0);
}

function SidebarSkeleton() {
  return (
    <div className="space-y-5 px-3 py-4 animate-pulse">
      {Array.from({ length: 2 }).map((_, groupIdx) => (
        <div key={groupIdx}>
          <div className="mb-2 h-3 w-20 rounded bg-[var(--surface-subtle)]" />
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((__, itemIdx) => (
              <div key={itemIdx} className="rounded-lg bg-[var(--surface-subtle)] px-3 py-3">
                <div className="h-3 w-2/3 rounded bg-[var(--surface-base)]" />
                <div className="mt-2 h-2.5 w-full rounded bg-[var(--surface-base)]" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function AIEmployeeConversationSidebar({
  title = 'Digital Worker',
  conversations,
  currentConversationId,
  onSelectConversation,
  onDeleteConversation,
  onNewConversation,
  formatTime,
  searchQuery,
  onSearchQueryChange,
  isLoading,
  onClose,
}) {
  const filteredConversations = useMemo(() => {
    const normalizedQuery = String(searchQuery || '').trim().toLowerCase();
    if (!normalizedQuery) return conversations;

    return conversations.filter((conversation) => {
      const lastMessage = conversation?.messages?.[conversation.messages.length - 1]?.content || '';
      return String(conversation?.title || '').toLowerCase().includes(normalizedQuery)
        || String(lastMessage).toLowerCase().includes(normalizedQuery);
    });
  }, [conversations, searchQuery]);

  const groupedConversations = useMemo(
    () => groupConversationsByDate(filteredConversations),
    [filteredConversations]
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--surface-card)]">
      {/* Header */}
      <div className="border-b border-[var(--border-default)] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--brand-600)] text-white flex-shrink-0">
              <Bot className="h-4.5 w-4.5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{title}</p>
              <p className="text-[11px] text-[var(--text-muted)]">Workspace</p>
            </div>
          </div>

          {onClose ? (
            <button
              type="button"
              aria-label="Close conversation history"
              className="rounded-lg p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--accent-hover)] cursor-pointer"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>

        {/* New chat button */}
        <button
          type="button"
          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--brand-600)] px-4 py-2 text-sm font-medium text-white transition hover:bg-[var(--brand-700)] cursor-pointer"
          onClick={onNewConversation}
        >
          <Plus className="h-4 w-4" />
          New chat
        </button>

        {/* Search */}
        <label className="mt-3 block">
          <span className="sr-only">Search conversations</span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange?.(event.target.value)}
              placeholder="Search chats"
              className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-base)] py-2 pl-8 pr-3 text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--focus-ring)] focus:ring-2 focus:ring-[var(--focus-ring)]/30 placeholder:text-[var(--text-muted)]"
            />
          </div>
        </label>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 py-2">
        {isLoading ? (
          <SidebarSkeleton />
        ) : groupedConversations.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <div className="w-10 h-10 rounded-lg bg-[var(--surface-subtle)] flex items-center justify-center mb-3">
              <Bot className="w-5 h-5 text-[var(--text-muted)]" />
            </div>
            <p className="text-sm font-medium text-[var(--text-secondary)]">No saved chats</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Start a new chat to begin.
            </p>
          </div>
        ) : (
          groupedConversations.map((section) => (
            <section key={section.key} className="mb-4 last:mb-0">
              <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
                {section.label}
              </div>
              <div className="space-y-0.5">
                {section.items.map((conversation) => (
                  <ConversationListItem
                    key={conversation.id}
                    conversation={conversation}
                    isActive={currentConversationId === conversation.id}
                    onSelect={() => onSelectConversation?.(conversation.id)}
                    onDelete={() => onDeleteConversation?.(conversation.id)}
                    formatTime={formatTime}
                    variant="compact"
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

export default memo(AIEmployeeConversationSidebar);
