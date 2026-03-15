import React from 'react';
import { Menu, Plus, X } from 'lucide-react';

function HeaderActionButton({ label, icon, onClick, active = false, disabled = false }) {
  const Icon = icon;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm transition ${
        active
          ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
          : 'bg-white/90 text-slate-600 hover:bg-white dark:bg-[#1c1c1c] dark:text-slate-300 dark:hover:bg-[#232323]'
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      <Icon className="h-4 w-4" />
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

export default function AIEmployeeChatShell({
  title,
  subtitle,
  badge = null,
  sidebarOpen,
  onSidebarToggle,
  onDismissOverlays,
  onNewConversation,
  sidebar,
  thread,
  composer,
  secondaryPanel = null,
  actions = [],
}) {
  const showBackdrop = Boolean(secondaryPanel);

  return (
    <div className="relative h-full overflow-hidden rounded-[34px] border border-black/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(248,250,252,0.96))] shadow-[0_36px_120px_rgba(15,23,42,0.14)] dark:border-white/10 dark:bg-[linear-gradient(180deg,rgba(20,20,20,0.98),rgba(12,12,12,0.98))]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(15,23,42,0.05),transparent_42%)] dark:bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),transparent_36%)]" />

      {showBackdrop ? (
        <button
          type="button"
          aria-label="Dismiss overlay"
          className="absolute inset-0 z-20 bg-black/16 backdrop-blur-[2px]"
          onClick={onDismissOverlays}
        />
      ) : null}

      <aside
        data-testid="ai-employee-sidebar"
        className={`absolute inset-y-3 left-3 z-30 w-[320px] max-w-[calc(100%-1.5rem)] transform transition duration-200 ease-out ${
          sidebarOpen ? 'translate-x-0 opacity-100' : '-translate-x-[110%] opacity-0 pointer-events-none'
        }`}
      >
        {sidebar}
      </aside>

      {secondaryPanel ? (
        <section
          data-testid="ai-employee-secondary-panel"
          className="absolute inset-y-3 right-3 z-30 flex w-[420px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-[28px] border border-black/8 bg-[rgba(255,255,255,0.97)] shadow-[0_30px_80px_rgba(15,23,42,0.16)] backdrop-blur dark:border-white/10 dark:bg-[#141414]/96"
        >
          <div className="flex items-center justify-between border-b border-black/8 px-5 py-4 dark:border-white/10">
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{secondaryPanel.title}</div>
              {secondaryPanel.description ? (
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{secondaryPanel.description}</div>
              ) : null}
            </div>
            <button
              type="button"
              aria-label={`Close ${secondaryPanel.title}`}
              onClick={secondaryPanel.onClose}
              className="rounded-full p-2 text-slate-500 transition hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">{secondaryPanel.content}</div>
        </section>
      ) : null}

      <div className="relative z-10 flex h-full min-h-0 flex-col">
        <header className="border-b border-black/6 px-4 py-4 dark:border-white/8 sm:px-6">
          <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                aria-label="Toggle conversation history"
                onClick={onSidebarToggle}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-slate-700 shadow-sm transition hover:bg-white dark:bg-[#1c1c1c] dark:text-slate-300 dark:hover:bg-[#232323]"
              >
                <Menu className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={onNewConversation}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-slate-700 shadow-sm transition hover:bg-white dark:bg-[#1c1c1c] dark:text-slate-300 dark:hover:bg-[#232323] lg:hidden"
                aria-label="New chat"
              >
                <Plus className="h-4 w-4" />
              </button>

              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
                  {badge ? (
                    <span className="inline-flex rounded-full bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-white dark:bg-slate-100 dark:text-slate-900">
                      {badge}
                    </span>
                  ) : null}
                </div>
                {subtitle ? (
                  <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
                ) : null}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onNewConversation}
                className="hidden rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200 lg:inline-flex"
              >
                New chat
              </button>
              {actions.map((action) => (
                <HeaderActionButton
                  key={action.key}
                  label={action.label}
                  icon={action.icon}
                  onClick={action.onClick}
                  active={action.active}
                  disabled={action.disabled}
                />
              ))}
            </div>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          {thread}
          {composer}
        </div>
      </div>
    </div>
  );
}
