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
          <div className="mb-2 h-3 w-20 rounded bg-slate-200 dark:bg-slate-800" />
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((__, itemIdx) => (
              <div key={itemIdx} className="rounded-2xl bg-slate-100 px-3 py-3 dark:bg-slate-800">
                <div className="h-3 w-2/3 rounded bg-slate-200 dark:bg-slate-700" />
                <div className="mt-2 h-2.5 w-full rounded bg-slate-200 dark:bg-slate-700" />
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
    <div className="flex h-full flex-col overflow-hidden rounded-[26px] border border-black/8 bg-[rgba(250,250,249,0.96)] shadow-[0_28px_70px_rgba(15,23,42,0.10)] backdrop-blur dark:border-white/10 dark:bg-[#161616]/96">
      <div className="border-b border-black/8 px-4 py-4 dark:border-white/10">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-[18px] bg-slate-900 text-white shadow-sm dark:bg-slate-100 dark:text-slate-900">
                <Bot className="h-5 w-5" />
              </span>
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">Digital Worker workspace</p>
              </div>
            </div>
          </div>

          {onClose ? (
            <button
              type="button"
              aria-label="Close conversation history"
              className="rounded-full p-2 text-slate-500 transition hover:bg-slate-100 dark:hover:bg-slate-800"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>

        <button
          type="button"
          className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
          onClick={onNewConversation}
        >
          <Plus className="h-4 w-4" />
          New chat
        </button>

        <label className="mt-4 block">
          <span className="sr-only">Search conversations</span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange?.(event.target.value)}
              placeholder="Search chats"
              className="w-full rounded-full border border-black/8 bg-white/90 py-2.5 pl-9 pr-3 text-sm text-slate-800 outline-none transition focus:border-slate-300 focus:ring-2 focus:ring-slate-200 dark:border-white/10 dark:bg-[#202020] dark:text-slate-100 dark:focus:border-slate-600 dark:focus:ring-slate-800"
            />
          </div>
        </label>
      </div>

      <div className="flex-1 overflow-y-auto chat-scrollbar px-2 py-3">
        {isLoading ? (
          <SidebarSkeleton />
        ) : groupedConversations.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              No saved chats
            </div>
            <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
              Start a new chat and your worker will keep the thread here.
            </p>
          </div>
        ) : (
          groupedConversations.map((section) => (
            <section key={section.key} className="mb-5 last:mb-0">
              <div className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                {section.label}
              </div>
              <div className="space-y-1">
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
